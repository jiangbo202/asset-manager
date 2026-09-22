import { Hono } from "hono";
import type { AppEnv, AuthRow, SessionRow } from "./types";
import { acceptSessionRow, sessionLookupStatement, touchSession } from "./core/session";
import { ApiError } from "./core/errors";
import api from "./api";
import { detectLang, translator } from "./core/i18n";

const app = new Hono<AppEnv>();

/** 会话活跃时间的写入节流：小于这个间隔的请求不重复写 */
const SESSION_TOUCH_MS = 10 * 60 * 1000;

/**
 * 请求上下文：所有进入 Worker 的请求都先解析登录态与初始化状态
 * （静态资源请求不会到 Worker，所以这里只覆盖 /api/*）
 *
 * 为什么把两件事放在一次 `db.batch` 里：
 *  - 原来这里是三次查询三步走：readSession + isInitialized + getAuth，
 *    而 isInitialized 与 getAuth 查的是同一张表（auth id = 1），纯属重复。
 *  - D1 每条语句都有固定开销（本地实测约 0.3ms、线上更高），且 batch 内多条语句
 *    只算一次往返（实测比串行快约 4 倍）。
 * 现在：一次 batch（1–2 条语句）同时拿到 session 与 auth 行，其余中间件直接复用在
 * 上下文里，所以每个请求的认证开销就是这一次往返。
 */
app.use("*", async (c, next) => {
	c.set("lang", detectLang(c.req.header("accept-language")));

	const sessionStatement = await sessionLookupStatement(c);
	const statements: D1PreparedStatement[] = [];
	if (sessionStatement) statements.push(sessionStatement);
	statements.push(c.env.DB.prepare(`SELECT * FROM auth WHERE id = 1`));

	const results = await c.env.DB.batch(statements);
	const sessionIndex = sessionStatement ? 0 : -1;
	const sessionRow = sessionIndex >= 0 ? ((results[0]?.results?.[0] as SessionRow | undefined) ?? null) : null;
	const authRow = (results[sessionIndex + 1]?.results?.[0] as AuthRow | undefined) ?? null;

	const session = await acceptSessionRow(c, sessionRow);
	c.set("session", session);
	c.set("auth", authRow);

	/**
	 * 记录"最近活跃"，供设置页的会话列表使用。
	 *
	 * 为什么不是每个请求都写：D1 的写也是一次往返 + 计入每日写额度，
	 * 而这里只需要"让用户认出哪台设备是自己"，10 分钟粒度完全够。
	 * 为什么放 waitUntil：响应不必等它，热路径往返次数不变。
	 * 注意 last_seen 在创建时就有值，所以这里用的是上下文中已读出的行，不额外查库。
	 */
	const lastSeen = session?.last_seen ?? null;
	if (session && (!lastSeen || Date.now() - Date.parse(lastSeen) > SESSION_TOUCH_MS)) {
		const executionCtx = c.executionCtx as ExecutionContext | undefined;
		if (typeof executionCtx?.waitUntil === "function") {
			executionCtx.waitUntil(touchSession(c, session.id));
		}
	}

	await next();
});

/** API 响应统一禁用缓存，并补上安全头 */
app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
});

app.route("/api", api);

app.notFound((c) =>
	c.json({ ok: false, error: { code: "not_found", message: translator(c.get("lang"))("http.apiNotFound") } }, 404),
);

app.onError((err, c) => {
	if (err instanceof ApiError) {
		return c.json(
			{ ok: false, error: { code: err.code, message: err.message, details: err.details } },
			err.status as 400,
		);
	}
	// 数据库结构没升级（本地忘了 migrate、线上忘了跑迁移）：给出可直接照做的提示
	const rawMessage = err instanceof Error ? err.message : String(err);
	if (/no such table|no such column|has no column named/i.test(rawMessage)) {
		console.error("[app] 数据库结构未升级:", rawMessage);
		return c.json(
			{
				ok: false,
				error: {
					code: "migration_required",
					message:
						"数据库结构未升级：本地请运行 `npm run db:migrate:local`，线上请重新部署（部署脚本会自动应用迁移）或运行 `npm run db:migrate:remote`",
					details: { hint: rawMessage },
				},
			},
			503,
		);
	}

	// 请求体不是合法 JSON 等解析错误
	if (err instanceof SyntaxError) {
		return c.json({ ok: false, error: { code: "bad_request", message: "请求体不是合法的 JSON" } }, 400);
	}
	console.error("[app] 未捕获异常:", err instanceof Error ? err.stack : err);
	return c.json({ ok: false, error: { code: "internal_error", message: "服务异常，请查看 wrangler tail 日志" } }, 500);
});

export default app;
