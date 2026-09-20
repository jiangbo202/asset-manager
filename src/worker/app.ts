import { Hono } from "hono";
import type { AppEnv } from "./types";
import { readSession } from "./core/session";
import { ApiError } from "./core/errors";
import api from "./api";

const app = new Hono<AppEnv>();

/**
 * 会话解析：所有进入 Worker 的请求都先尝试解析登录态
 * （静态资源请求不会到 Worker，所以这里只覆盖 /api/*）
 */
app.use("*", async (c, next) => {
	c.set("session", await readSession(c));
	await next();
});

/** API 响应统一禁用缓存，并补上安全头 */
app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
});

app.route("/api", api);

app.notFound((c) => c.json({ ok: false, error: { code: "not_found", message: "接口不存在" } }, 404));

app.onError((err, c) => {
	if (err instanceof ApiError) {
		return c.json(
			{ ok: false, error: { code: err.code, message: err.message, details: err.details } },
			err.status as 400,
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
