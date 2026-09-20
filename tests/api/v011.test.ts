import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../../src/shared/api-types";
import { lookupSymbol, inferMarket } from "../../src/worker/services/quotes/lookup";
import { applyHealth, cooldownOf, parseHealth } from "../../src/worker/services/quotes/health";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { buildTrendSeries, takeSnapshot } from "../../src/worker/services/snapshots";
import { bootstrap, call, clearAll } from "../helpers";
import { fakeFetch } from "../services/providers.test";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

const jsonResponse = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("v0.11 代码查询", () => {
	beforeEach(async () => {
		await clearAll();
		await bootstrap();
	});

	it("inferMarket：从后缀/提示推断市场", () => {
		expect(inferMarket("0700.HK")).toBe("hk");
		expect(inferMarket("600519.SS")).toBe("cn");
		expect(inferMarket("000001.SZ")).toBe("cn");
		expect(inferMarket("BTC-USD")).toBe("crypto");
		expect(inferMarket("BTC", null, "crypto")).toBe("crypto");
		expect(inferMarket("AAPL")).toBe("us");
		expect(inferMarket("700", "hk")).toBe("hk");
	});

	it("股票查询：返回名称、价格、币种与交易所", async () => {
		const fetcher = fakeFetch([
			{
				match: (url) => url.includes("/v1/finance/search"),
				json: {
					quotes: [
						{ symbol: "AAPL", shortname: "Apple Inc.", longname: "Apple Inc.", exchDisp: "NASDAQ", quoteType: "EQUITY" },
						{ symbol: "AAPU", shortname: "Direxion Daily AAPL Bull 2X", exchDisp: "NASDAQ", quoteType: "ETF" },
					],
				},
			},
			{
				match: (url) => url.includes("/v8/finance/chart/AAPL"),
				json: { chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 336.13, longName: "Apple Inc." } }] } },
			},
		]);

		const result = await lookupSymbol(env, { symbol: "AAPL", market: "us", fetcher });
		expect(result.candidates[0]).toMatchObject({
			symbol: "AAPL",
			name: "Apple Inc.",
			price: 336.13,
			currency: "USD",
			market: "us",
			class: "stock",
			exchange: "NASDAQ",
		});
		expect(result.candidates[1]).toMatchObject({ symbol: "AAPU", class: "etf" });
		expect(result.cached).toBe(false);
	});

	it("港股查询：0700 会被规范化成 0700.HK", async () => {
		const fetcher = fakeFetch([
			{
				match: (url) => url.includes("/v1/finance/search"),
				json: { quotes: [{ symbol: "0700.HK", longname: "Tencent Holdings Limited", exchDisp: "Hong Kong", quoteType: "EQUITY" }] },
			},
			{
				match: (url) => url.includes("0700.HK"),
				json: { chart: { result: [{ meta: { currency: "HKD", regularMarketPrice: 419 } }] } },
			},
		]);

		const result = await lookupSymbol(env, { symbol: "0700", market: "hk", fetcher });
		expect(result.candidates[0]).toMatchObject({ symbol: "0700.HK", name: "Tencent Holdings Limited", price: 419, currency: "HKD" });
	});

	it("加密查询：内置映射直接命中；未知币走 CoinGecko 搜索", async () => {
		const builtin = await lookupSymbol(env, {
			symbol: "BTC",
			classHint: "crypto",
			fetcher: fakeFetch([
				{ match: (url) => url.includes("simple/price"), json: { bitcoin: { usd: 80500 } } },
			]),
		});
		expect(builtin.candidates[0]).toMatchObject({ symbol: "bitcoin", price: 80500, market: "crypto" });

		const searched = await lookupSymbol(env, {
			symbol: "pepe",
			classHint: "crypto",
			fetcher: fakeFetch([
				{
					match: (url) => url.includes("/search"),
					json: { coins: [{ id: "pepe", name: "Pepe", symbol: "PEPE", market_cap_rank: 30 }] },
				},
				{ match: (url) => url.includes("simple/price"), json: { pepe: { usd: 0.000012 } } },
			]),
		});
		expect(searched.candidates[0]).toMatchObject({ symbol: "pepe", name: "Pepe", price: 0.000012 });
	});

	it("查询结果会缓存 24 小时，第二次不再打网络", async () => {
		let calls = 0;
		const counting = ((input: RequestInfo | URL) => {
			calls += 1;
			return fakeFetch([
				{ match: () => true, json: { quotes: [{ symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY" }] } },
			])(input as RequestInfo);
		}) as unknown as typeof fetch;

		const first = await lookupSymbol(env, { symbol: "CACHEME", market: "us", fetcher: counting });
		const callsAfterFirst = calls;
		const second = await lookupSymbol(env, { symbol: "CACHEME", market: "us", fetcher: counting });

		expect(callsAfterFirst).toBeGreaterThan(0);
		expect(calls).toBe(callsAfterFirst);
		expect(second.cached).toBe(true);
		expect(second.candidates).toEqual(first.candidates);

		// force=true 会绕过缓存
		await lookupSymbol(env, { symbol: "CACHEME", market: "us", fetcher: counting, force: true });
		expect(calls).toBeGreaterThan(callsAfterFirst);
	});
});

describe("v0.11 数据源限流冷却", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	it("applyHealth：429 立刻冷却 10 分钟，成功会清掉冷却", () => {
		const now = new Date("2026-09-20T10:00:00.000Z");
		let health = applyHealth({}, "coingecko", { ok: false, status: 429, error: "HTTP 429（被限流）" }, now);
		const state = cooldownOf(health, "coingecko", now);
		expect(state.cooling).toBe(true);
		expect(state.minutesLeft).toBe(10);
		expect(state.reason).toContain("限流");

		// 连续失败 3 次（非限流）也会冷却 30 分钟
		health = {};
		for (let index = 0; index < 3; index += 1) {
			health = applyHealth(health, "tencent", { ok: false, error: "HTTP 500" }, now);
		}
		expect(cooldownOf(health, "tencent", now).minutesLeft).toBe(30);

		// 成功清零并解除冷却
		health = applyHealth(health, "tencent", { ok: true }, now);
		expect(cooldownOf(health, "tencent", now).cooling).toBe(false);
		expect(health.tencent.failures).toBe(0);
	});

	it("冷却期内的数据源会被跳过，并把原因写进报告", async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us" }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "crypto",
				market: "crypto",
				symbol: "BTC",
				name: "比特币",
				currency: "USD",
				qty: 1,
				price: 1,
			}),
		});

		let coingeckoCalls = 0;
		const fetcher = ((input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("coingecko.com")) {
				coingeckoCalls += 1;
				return Promise.resolve(jsonResponse({ error: "rate limited" }, 429));
			}
			if (url.includes("binance.com")) {
				return Promise.resolve(jsonResponse([{ symbol: "BTCUSDT", price: "80000" }]));
			}
			return Promise.resolve(jsonResponse({}, 404));
		}) as unknown as typeof fetch;

		// 第一次：coingecko 429 → 记冷却；binance 顶上
		const first = await refreshQuotes(env, { trigger: "manual", fetcher });
		expect(first.updated).toBe(1);
		expect(first.sources.binance).toBe(1);
		expect(coingeckoCalls).toBe(1);

		const stored = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'provider_health'`).first<{ value: string }>();
		const health = parseHealth(stored?.value);
		expect(cooldownOf(health, "coingecko").cooling).toBe(true);

		// 第二次：coingecko 直接被跳过，不再发请求
		const second = await refreshQuotes(env, { trigger: "manual", fetcher });
		expect(coingeckoCalls).toBe(1);
		expect(second.coolingDown.map((item) => item.provider).join(" ")).toContain("CoinGecko");
		expect(second.updated).toBe(1);
	});

	it("全部数据源都在冷却时给出明确提示，而不是静默失败", async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us" }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "crypto",
				market: "crypto",
				symbol: "BTC",
				name: "比特币",
				currency: "USD",
				qty: 1,
				price: 1,
			}),
		});

		// 手工把所有加密数据源都设成冷却中
		const until = new Date(Date.now() + 5 * 60_000).toISOString();
		await env.DB.prepare(
			`INSERT INTO settings (key, value) VALUES ('provider_health', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
			.bind(
				JSON.stringify({
					coingecko: { failures: 0, cooldownUntil: until, cooldownReason: "被限流" },
					binance: { failures: 0, cooldownUntil: until, cooldownReason: "被限流" },
					yahoo: { failures: 0, cooldownUntil: until, cooldownReason: "被限流" },
				}),
			)
			.run();

		const report = await refreshQuotes(env, {
			trigger: "manual",
			fetcher: (() => Promise.resolve(jsonResponse({}, 500))) as unknown as typeof fetch,
		});
		expect(report.updated).toBe(0);
		expect(report.failed[0].reason).toContain("冷却");
	});
});

describe("v0.11 汇率按日冻结", () => {
	it("快照会冻结当天汇率，事后改汇率不再平移历史曲线", async () => {
		await clearAll();
		const cookie = (await bootstrap()).cookie;
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "现金", kind: "cash", currency: "HKD", market: null }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "cash",
				name: "港币现金",
				currency: "HKD",
				qty: 10000,
				price: 1,
			}),
		});

		// 先设 0.128 并拍一张"昨天"的快照
		await call("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "HKD", quote: "USD", rate: 0.128 }),
		});
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await takeSnapshot(env.DB, { date: yesterday });

		// 事后把汇率改成 0.2
		await call("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "HKD", quote: "USD", rate: 0.2 }),
		});

		// 历史曲线仍用昨天冻结的 0.128：10000 × 0.128 = 1280
		const series = await buildTrendSeries(env.DB, { range: "1M" });
		expect(series.rateMode).toBe("frozen");
		expect(series.points[0].total).toBeCloseTo(1280, 1);

		// 而"当前值"用新汇率：10000 × 0.2 = 2000
		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(portfolio.body.data.total).toBeCloseTo(2000, 1);

		// 冻结表里确实落了那天的汇率
		const frozen = await env.DB.prepare(`SELECT rate FROM fx_daily WHERE date = ? AND base = 'HKD' AND quote = 'USD'`)
			.bind(yesterday)
			.first<{ rate: number }>();
		expect(frozen?.rate).toBeCloseTo(0.128, 6);
	});
});
