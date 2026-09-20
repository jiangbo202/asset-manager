import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { matchesMarketFilter } from "../../src/shared/labels";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 市场筛选：服务端在 SQL 里表达规则，前端（持仓页的本地筛选）用 shared/labels.ts 的
 * matchesMarketFilter，两处必须一致 —— 这个测试同时盯住行为和一致性。
 *
 * 起因：用户在「市场」行点「加密」得到"没有数据"，而他的加密持仓是代币化股票
 * （分类=加密货币、市场=us），于是被 `market = 'crypto'` 的纯市场筛选漏掉了。
 */
describe("市场筛选", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const seed = async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "币安", kind: "exchange", currency: "USD", market: "crypto" }),
		});
		const accountId = account.body.data.id;

		const add = async (body: Record<string, unknown>) =>
			await call<Envelope<{ id: string }>>("/api/holdings", {
				method: "POST",
				cookie,
				body: JSON.stringify({ accountId, currency: "USD", qty: 1, price: 100, ...body }),
			});

		// 代币化股票：分类是加密货币，市场却是 us
		await add({ class: "crypto", market: "us", symbol: "SPCXB-USD", name: "代币化股票" });
		// 普通加密资产：市场就是 crypto
		await add({ class: "crypto", market: "crypto", symbol: "BTC", name: "比特币" });
		// 美股
		await add({ class: "stock", market: "us", symbol: "AAPL", name: "苹果" });
	};

	const symbolsOf = async (query: string): Promise<string[]> => {
		const response = await call<Envelope<{ items: Array<{ symbol: string | null }> }>>(`/api/holdings${query}`, {
			cookie,
		});
		return (response.body.data.items ?? []).map((item) => item.symbol ?? "").sort();
	};

	it("market=crypto 同时匹配「市场为加密」与「类别为加密货币」的持仓", async () => {
		await seed();
		expect(await symbolsOf("?market=crypto")).toEqual(["BTC", "SPCXB-USD"]);
	});

	it("其它市场维度仍按市场字段筛选（代币化股票同时算在美股）", async () => {
		await seed();
		expect(await symbolsOf("?market=us")).toEqual(["AAPL", "SPCXB-USD"]);
		expect(await symbolsOf("?market=hk")).toEqual([]);
		expect(await symbolsOf("?market=crypto,us")).toEqual(["AAPL", "BTC", "SPCXB-USD"]);
	});

	it("组合接口（总览用的那个）行为一致", async () => {
		await seed();
		const response = await call<Envelope<{ holdings: Array<{ symbol: string | null }> }>>(
			"/api/portfolio?market=crypto",
			{ cookie },
		);
		expect((response.body.data.holdings ?? []).map((item) => item.symbol).sort()).toEqual(["BTC", "SPCXB-USD"]);
	});

	it("前端共享规则与服务端 SQL 完全一致", async () => {
		await seed();
		const rows = (
			await env.DB.prepare(`SELECT symbol, market, class FROM holdings`).all<{
				symbol: string;
				market: string | null;
				class: string;
			}>()
		).results ?? [];

		for (const market of ["us", "hk", "crypto", "other", "crypto,us"]) {
			const selected = market.split(",");
			const viaApi = await symbolsOf(`?market=${market}`);
			const viaHelper = rows
				.filter((row) => matchesMarketFilter(row, selected))
				.map((row) => row.symbol)
				.sort();
			expect(viaHelper, `市场筛选 ${market} 的前后端结果不一致`).toEqual(viaApi);
		}
	});
});
