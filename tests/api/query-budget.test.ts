import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/worker/app";
import type { Env } from "../../src/worker/types";
import { bootstrap, call, clearAll } from "../helpers";

/**
 * 每个接口的 D1 语句预算（回归护栏）
 *
 * 为什么值得守护：免费版每次调用只有 10ms CPU，而实测下来最大的开销来源不是业务逻辑，
 * 而是 D1 语句的固定成本 —— 本地 workerd 里每条语句约 0.3ms（线上更高，观察值约 2ms），
 * 且一次 `db.batch` 里的多条语句只算一次往返（实测比串行快约 4 倍）。
 * 所以"每条路由发几条语句、分几次往返"直接决定 CPU 够不够用。
 *
 * 这里把当前值固化成上限：不小心加回去一次串行查询，CI 会拦住并告出是哪条 SQL。
 */

/**
 * 预算表：上限就是"改造后的实测值"，所以只要有人加回一条查询就会失败。
 *
 *   路由                              语句  往返   改造前往返
 *   /api/auth/me                       3     2       6
 *   /api/accounts                      3     2       4
 *   /api/holdings                      3     2       4
 *   /api/portfolio                     5     2       6
 *   /api/portfolio/history             6     3       8
 *   /api/settings                      4     3       5
 *   /api/settings/overview             4     2      12
 *   /api/quotes/status                 5     2       8
 *   /api/history                       4     3       5
 *
 * 改造前的"往返"= 认证 3 次 + 路由自己每次一条语句一次往返。
 */
const BUDGET: Record<string, { statements: number; roundTrips: number; method?: string }> = {
	// 拍快照（Cron 的第二阶段就是这个）：认证上下文 + 读设置/持仓/汇率 + 写快照与每日汇率 + 审计
	"/api/portfolio/snapshots": { statements: 7, roundTrips: 4, method: "POST" },
	// 获取最新汇率：认证上下文 + 读设置（外网请求不计入 CPU）
	"/api/settings/fx/lookup": { statements: 3, roundTrips: 2, method: "POST" },
	"/api/auth/me": { statements: 3, roundTrips: 2 },
	"/api/accounts": { statements: 3, roundTrips: 2 },
	"/api/holdings": { statements: 3, roundTrips: 2 },
	"/api/portfolio": { statements: 5, roundTrips: 2 },
	"/api/portfolio/history?range=3M": { statements: 6, roundTrips: 3 },
	"/api/settings": { statements: 4, roundTrips: 3 },
	"/api/settings/overview": { statements: 4, roundTrips: 2 },
	"/api/quotes/status": { statements: 5, roundTrips: 2 },
	"/api/history": { statements: 4, roundTrips: 3 },
};

interface Counted {
	statements: string[];
	batches: number;
	/** batch 内的语句数（也要算进语句总数） */
	batchedStatements: number;
}

/**
 * 包一层 DB 统计这次请求实际执行了什么。
 * 注意 `bind()` 会返回新的原生语句对象，所以也要在那个返回上继续包一层。
 */
function countingDb(db: D1Database, log: Counted): D1Database {
	const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...args: unknown[]) =>
						wrap((value as (...rest: unknown[]) => D1PreparedStatement).apply(target, args), sql);
				}
				if (["first", "all", "run", "raw"].includes(String(prop))) {
					return (...args: unknown[]) => {
						log.statements.push(sql.replace(/\s+/g, " ").trim());
						return (value as (...rest: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			},
		});

	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
			if (prop === "batch") {
				return (statements: D1PreparedStatement[]) => {
					log.batches += 1;
					log.batchedStatements += statements.length;
					for (let index = 0; index < statements.length; index += 1) {
						log.statements.push(`batch[${index}]`);
					}
					return target.batch(statements);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;
}

async function countRequest(path: string, cookie: string | null, method = "GET"): Promise<Counted> {
	const log: Counted = { statements: [], batches: 0, batchedStatements: 0 };
	const instrumented = { ...env, DB: countingDb(env.DB, log) } as Env;
	await app.fetch(
		new Request(`https://example.com${path}`, { method, headers: cookie ? { Cookie: cookie } : undefined }),
		instrumented,
		{} as ExecutionContext,
	);
	// 统计到的顺序是执行顺序，但 batch 内语句要先减去（它们是同一次往返）
	log.statements = log.statements.filter((item) => !item.startsWith("batch["));
	return log;
}

describe("D1 语句预算", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
		const account = await call<{ ok: boolean; data: { id: string } }>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us" }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				qty: 0,
				price: 0,
			}),
		});
		await call("/api/portfolio/snapshots", { method: "POST", cookie });
	});

	/**
	 * 匿名访客（公开只读分享）的预算
	 *
	 * 公开页可能被人反复刷新，而且**没有任何认证门槛**，所以它比登录后的同类请求
	 * 更不能超预算：多出来的只有"读 public_view 开关"这一条语句。
	 */
	it("匿名访客看总览（公开只读分享）", async () => {
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ publicView: true }) });
		const { statements, batches, batchedStatements } = await countRequest("/api/portfolio", null);

		const total = statements.length + batchedStatements;
		const roundTrips = batches + statements.length;
		const detail = `匿名 /api/portfolio：语句 ${total} 条 / 往返 ${roundTrips} 次\n  ${statements.join("\n  ")}`;
		// 登录后是 5 条 2 次往返；访客多一次"读开关"，但开关查询与上下文共用一次往返
		expect(total, detail).toBeLessThanOrEqual(6);
		expect(roundTrips, detail).toBeLessThanOrEqual(3);
	});

	for (const [path, budget] of Object.entries(BUDGET)) {
		it(`${path}`, async () => {
			const { statements, batches, batchedStatements } = await countRequest(path, cookie, budget.method);
			const total = statements.length + batchedStatements;
			const roundTrips = batches + statements.length;
			const detail = `${path}：语句 ${total} 条（预算 ${budget.statements}）/ 往返 ${roundTrips} 次（预算 ${budget.roundTrips}）\n  ${statements.join("\n  ")}`;

			expect(total, detail).toBeLessThanOrEqual(budget.statements);
			expect(roundTrips, detail).toBeLessThanOrEqual(budget.roundTrips);
		});
	}
});
