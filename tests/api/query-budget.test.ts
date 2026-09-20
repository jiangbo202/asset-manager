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

/** 语句数上限（当前实际值，加一条就失败） */
const STATEMENT_BUDGET: Record<string, number> = {
	"/api/auth/me": 4,
	"/api/accounts": 4,
	"/api/holdings": 4,
	"/api/portfolio": 7,
	"/api/portfolio/history?range=3M": 8,
	"/api/settings": 5,
	"/api/settings/overview": 6,
	"/api/quotes/status": 7,
	"/api/history": 5,
};

/** 往返次数上限：认证上下文 1 次 batch + 路由自己 1 次（个别路由多一次依赖查询） */
const ROUND_TRIP_BUDGET: Record<string, number> = {
	"/api/auth/me": 2,
	"/api/accounts": 2,
	"/api/holdings": 2,
	"/api/portfolio": 2,
	"/api/portfolio/history?range=3M": 3,
	"/api/settings": 3,
	"/api/settings/overview": 3,
	"/api/quotes/status": 3,
	"/api/history": 3,
};

interface Counted {
	statements: string[];
	batches: number;
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

async function countRequest(path: string, cookie: string): Promise<Counted> {
	const log: Counted = { statements: [], batches: 0 };
	const instrumented = { ...env, DB: countingDb(env.DB, log) } as Env;
	await app.fetch(
		new Request(`https://example.com${path}`, { headers: { Cookie: cookie } }),
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
				qty: 10,
				price: 100,
			}),
		});
		await call("/api/portfolio/snapshots", { method: "POST", cookie });
	});

	for (const [path, budget] of Object.entries(STATEMENT_BUDGET)) {
		it(`${path} ≤ ${budget} 条语句`, async () => {
			const { statements } = await countRequest(path, cookie);
			expect(
				statements.length,
				`${path} 用了 ${statements.length} 条语句（预算 ${budget}）：\n- ${statements.join("\n- ")}`,
			).toBeLessThanOrEqual(budget);
		});
	}

	for (const [path, budget] of Object.entries(ROUND_TRIP_BUDGET)) {
		it(`${path} ≤ ${budget} 次数据库往返`, async () => {
			const { batches, statements } = await countRequest(path, cookie);
			// 往返 = batch 次数 + 单独执行的语句数
			const roundTrips = batches + statements.length;
			expect(
				roundTrips,
				`${path} 跑了 ${roundTrips} 次往返（预算 ${budget}）：batch ${batches} 次 + 单条语句 ${statements.length} 条`,
			).toBeLessThanOrEqual(budget);
		});
	}
});
