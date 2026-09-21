import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeHkSymbol } from "../../src/shared/labels";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

type Migration = { name: string; queries: string[] };

/**
 * 港股代码统一成港交所的 5 位写法。
 *
 * 起因：库里同时存在 3121 / 03121 / 03121.HK 三种写法，而 Yahoo 只认 4 位、腾讯只认 5 位，
 * 于是"同一个代码有的能取到价、有的取不到"。现在库里一律存 5 位（00700 / 03121），
 * 请求数据源时再临时转换。
 */
describe("港股代码统一为 5 位", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const account = async () => {
		const response = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "蚂蚁(澳门)", kind: "broker", currency: "HKD", market: "hk" }),
		});
		return response.body.data.id;
	};

	const add = async (accountId: string, symbol: string) =>
		await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "etf",
				market: "hk",
				symbol,
				name: "南方KOSPI",
				currency: "HKD",
				qty: 1000,
				price: 6.73,
			}),
		});

	it("纯函数：补足 5 位、剥掉 .HK 后缀、5 位与非数字保持原样", () => {
		expect(normalizeHkSymbol("3121")).toBe("03121");
		expect(normalizeHkSymbol("700")).toBe("00700");
		expect(normalizeHkSymbol("0700")).toBe("00700");
		expect(normalizeHkSymbol("03121")).toBe("03121");
		expect(normalizeHkSymbol("03121.HK")).toBe("03121");
		expect(normalizeHkSymbol("0700.HK")).toBe("00700");
		// 8 开头的人民币柜台本来就是 5 位
		expect(normalizeHkSymbol("80737")).toBe("80737");
		// 非数字不动
		expect(normalizeHkSymbol("")).toBe("");
		expect(normalizeHkSymbol("ABC")).toBe("ABC");
	});

	it("新增持仓时写入的是 5 位", async () => {
		const accountId = await account();
		for (const [input, expected] of [
			["3121", "03121"],
			["700", "00700"],
			["0700.HK", "00700"],
			["03121", "03121"],
		] as const) {
			const response = await add(accountId, input);
			const id = response.body.data.id;
			const row = await env.DB.prepare(`SELECT symbol FROM holdings WHERE id = ?`).bind(id).first<{ symbol: string }>();
			expect(row?.symbol, `输入 ${input}`).toBe(expected);
		}
	});

	it("修改持仓时也会归一化（改市场或改代码都算）", async () => {
		const accountId = await account();
		const created = await add(accountId, "00700");
		const id = created.body.data.id;

		await call(`/api/holdings/${id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ symbol: "3121" }),
		});
		const row = await env.DB.prepare(`SELECT symbol FROM holdings WHERE id = ?`).bind(id).first<{ symbol: string }>();
		expect(row?.symbol).toBe("03121");
	});

	it("历史数据由 0005 迁移统一（3121 / 0700.HK → 5 位）", async () => {
		const accountId = await account();
		// 手工写入"迁移前"的写法（新代码已经拦得住了）
		const insert = async (id: string, symbol: string) =>
			await env.DB.prepare(
				`INSERT INTO holdings (id, account_id, class, market, symbol, name, currency, qty, price, created_at, updated_at)
				 VALUES (?, ?, 'etf', 'hk', ?, '南方KOSPI', 'HKD', 1, 1, ?, ?)`,
			)
				.bind(id, accountId, symbol, new Date().toISOString(), new Date().toISOString())
				.run();
		await insert("legacy-1", "3121");
		await insert("legacy-2", "0700.HK");
		await insert("legacy-3", "80737");
		await insert("legacy-4", "NOPE");

		const migrations = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
		const migration = migrations.find((item) => item.name.includes("0005"));
		expect(migration, "找不到 0005 迁移").toBeTruthy();
		await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)));

		const rows =
			(await env.DB.prepare(`SELECT id, symbol FROM holdings ORDER BY id`).all<{ id: string; symbol: string }>())
				.results ?? [];
		const byId = new Map(rows.map((row) => [row.id, row.symbol]));
		expect(byId.get("legacy-1")).toBe("03121");
		expect(byId.get("legacy-2")).toBe("00700");
		expect(byId.get("legacy-3")).toBe("80737");
		expect(byId.get("legacy-4")).toBe("NOPE");
	});
});
