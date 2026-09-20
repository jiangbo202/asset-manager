import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../../src/shared/api-types";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { handleCron } from "../../src/worker/services/scheduler";
import { buildTrendSeries, takeSnapshot } from "../../src/worker/services/snapshots";
import { bootstrap, call, clearAll } from "../helpers";
import { fakeFetch } from "../services/providers.test";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/** 覆盖所有内置数据源的假响应 */
const providerStubs = fakeFetch([
	{
		match: (url) => url.includes("api.coingecko.com"),
		json: { bitcoin: { usd: 80000 } },
	},
	{
		match: (url) => url.includes("query1.finance.yahoo.com") && url.includes("AAPL"),
		json: { chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 210 } }] } },
	},
	{
		match: (url) => url.includes("frankfurter"),
		json: { base: "HKD", rates: { USD: 0.128 } },
	},
	{
		match: (url) => url.includes("open.er-api.com"),
		json: { result: "success", rates: { USD: 0.128 } },
	},
	{
		match: (url) => url.includes("qt.gtimg.cn"),
		text: 'v_hk00700="100~x~00700~420.000~425.000~";',
	},
]);

describe("v0.10 行情刷新 / 快照 / 走势", () => {
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

		const btc = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "crypto",
				market: "crypto",
				symbol: "BTC",
				name: "比特币",
				currency: "USD",
				qty: 0.5,
				price: 100,
			}),
		});
		const aapl = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				qty: 10,
				price: 100,
			}),
		});
		const hkd = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "cash",
				name: "港币现金",
				currency: "HKD",
				qty: 10000,
				price: 1,
			}),
		});

		return { accountId, btcId: btc.body.data.id, aaplId: aapl.body.data.id, hkdId: hkd.body.data.id };
	};

	it("刷新行情：更新持仓价格、写价格历史与缓存、自动抓汇率", async () => {
		const { btcId, aaplId } = await seed();

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: providerStubs });
		expect(report.updated).toBe(2);
		expect(report.fxUpdated).toBe(1);
		expect(report.sources.coingecko).toBe(1);
		expect(report.sources.yahoo).toBe(1);

		const holdings = await call<Envelope<{ items: Array<{ id: string; price: number; price_updated_at: string | null }> }>>(
			"/api/holdings",
			{ cookie },
		);
		const byId = new Map(holdings.body.data.items.map((item) => [item.id, item]));
		expect(byId.get(btcId)?.price).toBe(80000);
		expect(byId.get(aaplId)?.price).toBe(210);
		expect(byId.get(aaplId)?.price_updated_at).not.toBeNull();

		// 抓取到的汇率入库，来源标记为 auto
		const fx = await env.DB.prepare(`SELECT source, rate FROM fx_rates WHERE base = 'HKD' AND quote = 'USD'`).first<{
			source: string;
			rate: number;
		}>();
		expect(fx?.source).toBe("auto");
		expect(fx?.rate).toBeCloseTo(0.128, 4);

		// 价格历史只记一次手动 + 一次 api
		const history = await env.DB.prepare(
			`SELECT source, price FROM price_history WHERE holding_id = ? ORDER BY created_at`,
		)
			.bind(aaplId)
			.all<{ source: string; price: number }>();
		expect(history.results?.map((row) => row.source)).toEqual(["manual", "api"]);
		expect(history.results?.[1].price).toBe(210);

		// 运行记录留档
		const runs = await call<Envelope<{ recentRuns: Array<{ trigger: string; updated: number }> }>>("/api/quotes/status", {
			cookie,
		});
		expect(runs.body.data.recentRuns[0]).toMatchObject({ trigger: "manual", updated: 2 });
	});

	it("关闭行情后不再发起任何请求", async () => {
		await seed();
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ marketDataEnabled: false }),
		});

		let calls = 0;
		const counting = ((input: RequestInfo | URL) => {
			calls += 1;
			return providerStubs(input as RequestInfo);
		}) as unknown as typeof fetch;

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: counting });
		expect(calls).toBe(0);
		expect(report.updated).toBe(0);
		expect(report.skipped.join(" ")).toContain("关闭");
	});

	it("手动维护的汇率不会被自动抓取覆盖", async () => {
		await seed();
		await call("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "HKD", quote: "USD", rate: 0.13 }),
		});

		await refreshQuotes(env, { trigger: "manual", fetcher: providerStubs });

		const fx = await env.DB.prepare(`SELECT source, rate FROM fx_rates WHERE base = 'HKD' AND quote = 'USD'`).first<{
			source: string;
			rate: number;
		}>();
		expect(fx?.source).toBe("manual");
		expect(fx?.rate).toBeCloseTo(0.13, 4);
	});

	it("快照与走势：写入快照、按日补齐、支持区间与筛选", async () => {
		await seed();
		await refreshQuotes(env, { trigger: "manual", fetcher: providerStubs });

		// 造三天历史：D-2 / D-1 / 今天
		const today = new Date();
		const days = [2, 1, 0].map((offset) => {
			const date = new Date(today.getTime() - offset * 86_400_000);
			return date.toISOString().slice(0, 10);
		});
		await takeSnapshot(env.DB, { date: days[0] });
		await takeSnapshot(env.DB, { date: days[2] });

		const series = await buildTrendSeries(env.DB, { range: "1M" });
		// D-2 与今天之间有 1 天缺失，应被 forward fill 补齐
		expect(series.points.map((point) => point.date)).toEqual(days);
		expect(series.points[1].filled).toBe(true);
		expect(series.snapshotCount).toBe(2);
		// 总资产 = 0.5×80000 + 10×210 + 10000×0.128 = 43380
		expect(series.points[2].total).toBeCloseTo(43380, 1);

		// 按类别筛选：只算加密
		const cryptoOnly = await buildTrendSeries(env.DB, { range: "1M", filters: { class: "crypto" } });
		expect(cryptoOnly.points[2].total).toBeCloseTo(40000, 1);

		// 按账户筛选
		const holdings = await call<Envelope<{ items: Array<{ account_id: string }> }>>("/api/holdings", { cookie });
		const accountId = holdings.body.data.items[0].account_id;
		const byAccount = await buildTrendSeries(env.DB, { range: "1M", filters: { accountId } });
		expect(byAccount.points[2].total).toBeCloseTo(43380, 1);

		// 通过 HTTP 拿走势
		const http = await call<Envelope<{ points: unknown[]; range: string }>>("/api/portfolio/history?range=1M", {
			cookie,
		});
		expect(http.status).toBe(200);
		expect(http.body.data.points).toHaveLength(3);
		expect(http.body.data.range).toBe("1M");
	});

	it("组合视图与快照口径一致（价格更新后总额同步变化）", async () => {
		await seed();
		const before = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(before.body.data.total).toBeCloseTo(50 + 1000, 1); // 0.5×100 + 10×100

		await refreshQuotes(env, { trigger: "manual", fetcher: providerStubs });
		const after = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		// 40000（BTC）+ 2100（AAPL）+ 1280（HKD 现金按 0.128 折算）
		expect(after.body.data.total).toBeCloseTo(43380, 1);
	});

	it("Cron：小时不匹配不执行，匹配时先刷新行情再拍快照，同一天不重复", async () => {
		await seed();
		const now = new Date();

		const wrongHour = await handleCron(env, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0)));
		expect(wrongHour.ran).toBe(false);

		// 默认快照小时是 22（UTC）
		const atSnapshotHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0));
		const first = await handleCron(env, atSnapshotHour);
		expect(first.ran).toBe(true);
		expect(first.snapshot?.date).toBe(atSnapshotHour.toISOString().slice(0, 10));

		const second = await handleCron(env, atSnapshotHour);
		expect(second.ran).toBe(false);
		expect(second.reason).toContain("已有快照");
	});

	it("设置页：API Key 加密存库、不回传明文、provider_config 里不出现 Key", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({
				providerConfig: {
					enabled: { yahoo: true, coingecko: false },
					custom: { urlTemplate: "https://my-api.test/{symbol}", pricePath: "data.price", key: "custom-secret" },
				},
				providerKeys: { finnhub: "super-secret-key" },
			}),
		});

		const raw = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('provider_keys','provider_config')`).all<{
			key: string;
			value: string;
		}>();
		for (const row of raw.results ?? []) {
			expect(row.value).not.toContain("super-secret-key");
			expect(row.value).not.toContain("custom-secret");
		}

		const settings = await call<Envelope<{ providerKeysSet: string[]; providerConfig: { enabled: Record<string, boolean>; custom: { urlTemplate: string } | null } }>>(
			"/api/settings",
			{ cookie },
		);
		expect(settings.body.data.providerKeysSet).toContain("finnhub");
		expect(settings.body.data.providerConfig.enabled.coingecko).toBe(false);
		expect(settings.body.data.providerConfig.custom?.urlTemplate).toBe("https://my-api.test/{symbol}");
		expect(JSON.stringify(settings.body.data)).not.toContain("super-secret-key");

		// 传空字符串可以删除 Key
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ providerKeys: { finnhub: "" } }) });
		const after = await call<Envelope<{ providerKeysSet: string[] }>>("/api/settings", { cookie });
		expect(after.body.data.providerKeysSet).not.toContain("finnhub");
	});
});
