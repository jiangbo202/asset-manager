import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../../src/shared/api-types";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { bootstrap, call, clearAll, fakeFetch } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 报价时间（asOf）落地
 *
 * 要证明的核心事实：**抓取时间是"我们什么时候抓的"，报价时间是"这个价格是什么时候的"**。
 * 两者在休市时能差好几天 —— 周末刷新一次，抓取时间是今天，报价时间还是上周五收盘。
 * 这一组测试钉住：上游给时间就存上游的、不给就退回抓取时刻、手工改价要清空，
 * 以及备份round-trip 之后它还在。
 */

/** 2023-11-14T22:13:20Z：明显"旧"的时间，方便断言它没被"今天"覆盖 */
const OLD_QUOTE_TIME = 1_700_000_000;
const OLD_QUOTE_ISO = "2023-11-14T22:13:20.000Z";

const stubs = (regularMarketTime: number | null) =>
	fakeFetch([
		{
			match: (url) => url.includes("query1.finance.yahoo.com"),
			json: {
				chart: {
					result: [
						{
							meta: {
								currency: "USD",
								regularMarketPrice: 210,
								...(regularMarketTime ? { regularMarketTime } : {}),
							},
						},
					],
				},
			},
		},
		{
			match: (url) => url.includes("frankfurter"),
			json: { base: "HKD", date: "2026-09-25", rates: { USD: 0.128 } },
		},
		{ match: (url) => url.includes("api.coingecko.com"), json: { bitcoin: { usd: 80000 } } },
	]);

describe("报价时间（asOf）", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const seed = async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "测试券商", kind: "broker", currency: "USD", market: "us" }),
		});
		const accountId = account.body.data.id;

		const create = async (body: Record<string, unknown>) => {
			const response = await call<Envelope<{ id: string }>>("/api/holdings", {
				method: "POST",
				cookie,
				body: JSON.stringify({ accountId, ...body }),
			});
			return response.body.data.id;
		};

		// 股票：上游会给报价时间；加密：上游不给（走兜底）；HKD 现金：造出汇率目标
		const aaplId = await create({
			class: "stock",
			market: "us",
			symbol: "AAPL",
			name: "苹果",
			currency: "USD",
			qty: 10,
			price: 100,
		});
		const btcId = await create({
			class: "crypto",
			market: "crypto",
			symbol: "BTC",
			name: "比特币",
			currency: "USD",
			qty: 0.5,
			price: 100,
		});
		await create({ class: "cash", name: "港币现金", currency: "HKD", qty: 10000, price: 1 });

		return { accountId, aaplId, btcId };
	};

	it("上游给了时间：持仓、行情缓存、汇率三处都存上游的报价时间", async () => {
		const { aaplId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		const holdings = await call<
			Envelope<{ items: Array<{ id: string; price_as_of: string | null; price_updated_at: string | null }> }>
		>("/api/holdings", { cookie });
		const aapl = holdings.body.data.items.find((item) => item.id === aaplId);
		expect(aapl?.price_as_of).toBe(OLD_QUOTE_ISO);
		// 关键是这两个不相等：抓取是"刚刚"，报价是 2023 年
		expect(aapl?.price_updated_at).not.toBe(OLD_QUOTE_ISO);
		expect(Date.parse(aapl?.price_updated_at ?? "")).toBeGreaterThan(Date.parse(OLD_QUOTE_ISO));

		const cache = await env.DB.prepare(`SELECT as_of FROM quote_cache WHERE symbol = ?`)
			.bind("AAPL")
			.first<{ as_of: string | null }>();
		expect(cache?.as_of).toBe(OLD_QUOTE_ISO);

		// ECB 只给日期：存日期，不做时区换算（否则会被挪到前一天）
		const fx = await env.DB.prepare(`SELECT as_of, source FROM fx_rates WHERE base = 'HKD' AND quote = 'USD'`).first<{
			as_of: string | null;
			source: string;
		}>();
		expect(fx?.source).toBe("auto");
		expect(fx?.as_of).toBe("2026-09-25");
	});

	it("上游不给时间：退回抓取时刻（加密 24/7，两者等价），绝不是 null", async () => {
		const { btcId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		const holdings = await call<Envelope<{ items: Array<{ id: string; price_as_of: string | null }> }>>("/api/holdings", {
			cookie,
		});
		const btc = holdings.body.data.items.find((item) => item.id === btcId);
		expect(btc?.price_as_of).not.toBeNull();
		expect(Date.now() - Date.parse(btc?.price_as_of ?? "")).toBeLessThan(60_000);
	});

	it("组合接口同时给出两个时间，且各自的天数不同（不会互相顶替）", async () => {
		const { aaplId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		const aapl = portfolio.body.data.holdings.find((item) => item.id === aaplId);
		expect(aapl?.priceAsOf).toBe(OLD_QUOTE_ISO);
		expect(aapl?.daysSincePriceAsOf).toBeGreaterThan(300);
		// 抓取是刚刚：新鲜度仍然是 0 天 —— 告警按抓取新鲜度判断，所以周末不会全屏告警
		expect(aapl?.daysSincePriceUpdate).toBe(0);
	});

	it("手工改价会清空报价时间：手工价没有上游时间，不能继续贴旧标签", async () => {
		const { aaplId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		await call(`/api/holdings/${aaplId}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ price: 333 }),
		});

		const holdings = await call<Envelope<{ items: Array<{ id: string; price_as_of: string | null }> }>>("/api/holdings", {
			cookie,
		});
		expect(holdings.body.data.items.find((item) => item.id === aaplId)?.price_as_of).toBeNull();
	});

	it("公开分享不分享明细时，报价时间一并抹平（不因为“只是个时间”就漏出去）", async () => {
		const { aaplId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ publicView: true, publicSections: ["summary", "breakdown"] }),
		});

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", {});
		const aapl = portfolio.body.data.holdings.find((item) => item.id === aaplId);
		expect(aapl?.qty).toBe(0);
		expect(aapl?.priceAsOf).toBeNull();
		expect(aapl?.daysSincePriceAsOf).toBeNull();
	});

	it("备份导出/导入后报价时间还在（否则恢复一次就全丢了）", async () => {
		const { aaplId } = await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: stubs(OLD_QUOTE_TIME) });

		const exported = await call<{ data: { holdings: Array<{ id: string; price_as_of: string | null }> } }>(
			"/api/backup/export",
			{ cookie },
		);
		expect(exported.body.data.holdings.find((row) => row.id === aaplId)?.price_as_of).toBe(OLD_QUOTE_ISO);

		// 清空持仓，再用同一份备份恢复（replace 模式）
		await env.DB.prepare(`UPDATE holdings SET price_as_of = NULL`).run();
		await call("/api/backup/import?mode=replace", {
			method: "POST",
			cookie,
			body: JSON.stringify(exported.body),
		});

		const restored = await env.DB.prepare(`SELECT price_as_of FROM holdings WHERE id = ?`)
			.bind(aaplId)
			.first<{ price_as_of: string | null }>();
		expect(restored?.price_as_of).toBe(OLD_QUOTE_ISO);
	});
});
