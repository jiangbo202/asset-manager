import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../../src/shared/api-types";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { handleCron } from "../../src/worker/services/scheduler";
import { buildTrendSeries, takeSnapshot } from "../../src/worker/services/snapshots";
import { bootstrap, call, clearAll, fakeFetch } from "../helpers";

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

const latestAudit = async (entity: string) =>
	await env.DB.prepare(`SELECT source, note FROM audit_log WHERE entity = ? ORDER BY ts DESC LIMIT 1`)
		.bind(entity)
		.first<{ source: string; note: string | null }>();

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

		// 手动刷新要留痕，且来源是 web（用户点的），不是 system
		const audit = await latestAudit("quotes");
		expect(audit?.source).toBe("web");
		expect(audit?.note ?? "").toContain("刷新行情");
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

	it("Cron：一次调用只干一件重活（先刷行情，快照留给下一个整点）", async () => {
		await seed();
		const now = new Date();
		const at = (hour: number) =>
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));

		const wrongHour = await handleCron(env, at(3), { fetcher: providerStubs });
		expect(wrongHour.ran).toBe(false);

		// 默认快照小时是 22（UTC）：到点先刷行情，并说明快照留给下一个整点
		const refreshed = await handleCron(env, at(22), { fetcher: providerStubs });
		expect(refreshed.ran).toBe(true);
		expect(refreshed.reason).toContain("快照");
		expect(refreshed.snapshot).toBeUndefined();

		// 定时刷新也要写操作历史 —— 之前只有手动刷新写，定时任务悄无声息，
		// 用户看到"凌晨 5 点没有记录"根本无从判断是没跑还是没记
		const refreshAudit = await latestAudit("quotes");
		expect(refreshAudit?.source).toBe("system");
		expect(refreshAudit?.note ?? "").toContain("刷新行情");

		// 下一个整点：行情当天已刷过 → 拍快照
		const snapshot = await handleCron(env, at(23), { fetcher: providerStubs });
		expect(snapshot.ran).toBe(true);
		expect(snapshot.snapshot?.date).toBe(now.toISOString().slice(0, 10));

		// 定时拍的快照同样留痕，来源是 system
		const snapshotAudit = await latestAudit("snapshot");
		expect(snapshotAudit?.source).toBe("system");
		expect(snapshotAudit?.note ?? "").toContain("快照");

		const second = await handleCron(env, at(23), { fetcher: providerStubs });
		expect(second.ran).toBe(false);
		expect(second.reason).toContain("已有快照");
	});

	it("Cron：错过配置时间后当天会自动补做，而不是只能等第二天", async () => {
		await seed();
		const now = new Date();
		const at = (hour: number) =>
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
		const today = now.toISOString().slice(0, 10);

		// 默认快照小时是 22（UTC）：21 点还没到 → 不执行
		expect((await handleCron(env, at(21), { fetcher: providerStubs })).ran).toBe(false);

		// 23 点：已经过了配置时间、当天还没快照 → 直接补拍
		// （注意：刷新行情只在配置的那个小时做，所以这时不会再刷一次）
		const catchUp = await handleCron(env, at(23), { fetcher: providerStubs });
		expect(catchUp.ran).toBe(true);
		expect(catchUp.reason).toContain("补");
		expect(catchUp.snapshot?.date).toBe(today);
		expect(catchUp.quotes).toBeUndefined();

		// 同一天再跑：已有快照 → 跳过
		const again = await handleCron(env, at(23), { fetcher: providerStubs });
		expect(again.ran).toBe(false);
		expect(again.reason).toContain("已有快照");
	});

	it("刷新：分批上限——最旧的优先，超出的留到下一次，下次自然轮到它", async () => {
		const { btcId, aaplId } = await seed();

		// 把 AAPL 标成"刚更新过"，于是它应该在分批时被留到下一次（BTC 更旧）
		await env.DB.prepare(`UPDATE holdings SET price_updated_at = ? WHERE id = ?`)
			.bind(new Date().toISOString(), aaplId)
			.run();

		const report = await refreshQuotes(env, { trigger: "cron", fetcher: providerStubs, maxHoldings: 1 });
		expect(report.updated).toBe(1);
		expect(report.deferred).toEqual(["AAPL"]);

		const prices = new Map(
			(await env.DB.prepare(`SELECT id, price FROM holdings`).all<{ id: string; price: number }>()).results?.map((row) => [
				row.id,
				row.price,
			]),
		);
		expect(prices.get(btcId)).toBe(80000); // 本轮刷到的
		expect(prices.get(aaplId)).toBe(100); // 留到下一次，价格没被动

		// 下一次运行：上一轮被留下的现在最旧 → 轮到它
		// （用显式的一小时前而不是"刚刚"，避免毫秒级时间戳打平导致测试不稳）
		const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
		await env.DB.prepare(`UPDATE holdings SET price_updated_at = ? WHERE id = ?`).bind(hourAgo(), aaplId).run();
		const second = await refreshQuotes(env, { trigger: "cron", fetcher: providerStubs, maxHoldings: 1 });
		expect(second.deferred).toEqual(["BTC"]);
		expect(second.updated).toBe(1);
		const aapl = await env.DB.prepare(`SELECT price FROM holdings WHERE id = ?`)
			.bind(aaplId)
			.first<{ price: number }>();
		expect(aapl?.price).toBe(210);

		// 再一轮：这次轮到另一个被留下 —— 说明分批是公平轮转，而不是永远饿死同一批
		await env.DB.prepare(`UPDATE holdings SET price_updated_at = ? WHERE id = ?`).bind(hourAgo(), btcId).run();
		const third = await refreshQuotes(env, { trigger: "cron", fetcher: providerStubs, maxHoldings: 1 });
		expect(third.deferred).toEqual(["AAPL"]);
		expect(third.updated).toBe(1);

		// 手动刷新不带上限：一次把所有持仓都刷掉
		await env.DB.prepare(`UPDATE holdings SET price_updated_at = NULL`).run();
		const manual = await refreshQuotes(env, { trigger: "manual", fetcher: providerStubs });
		expect(manual.deferred).toEqual([]);
		expect(manual.updated).toBe(2);
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

		// 行情状态接口同样不能泄露 Key
		const status = await call<{ ok: boolean; data: unknown }>("/api/quotes/status", { cookie });
		expect(JSON.stringify(status.body.data)).not.toContain("super-secret-key");
		expect(JSON.stringify(status.body.data)).not.toContain("custom-secret");

		// 审计日志里也只有标记，不是明文
		const audit = await call<{ ok: boolean; data: { items: Array<Record<string, unknown>> } }>("/api/history", {
			cookie,
		});
		const auditText = JSON.stringify(audit.body.data.items);
		expect(auditText).not.toContain("super-secret-key");
		expect(auditText).not.toContain("custom-secret");

		// 传空字符串可以删除 Key
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ providerKeys: { finnhub: "" } }) });
		const after = await call<Envelope<{ providerKeysSet: string[] }>>("/api/settings", { cookie });
		expect(after.body.data.providerKeysSet).not.toContain("finnhub");
	});
	it("获取最新汇率：只返回结果、绝不写库；取不到时说清试过谁", async () => {
		await seed();
		const count = async () =>
			(await env.DB.prepare(`SELECT COUNT(*) AS total FROM fx_rates`).first<{ total: number }>())?.total ?? 0;
		const before = await count();

		const response = await call<
			Envelope<{
				ok: boolean;
				base: string;
				quote: string;
				rate: number | null;
				source: string | null;
				tried: string[];
				errors: string[];
			}>
		>("/api/settings/fx/lookup", {
			method: "POST",
			cookie,
			body: JSON.stringify({ base: "USD", quote: "CNY" }),
		});

		expect(response.status).toBe(200);
		const data = response.body.data;
		if (data.ok) {
			// 测试环境能连外网时（CI 上就是如此）应当给出正数汇率与来源
			expect(data.rate).toBeGreaterThan(0);
			expect(data.source).not.toBeNull();
		} else {
			// 取不到时要告诉用户"试过哪些源、为什么没成"
			expect(data.rate).toBeNull();
			expect(data.tried.length).toBeGreaterThan(0);
			expect(data.errors.length).toBeGreaterThan(0);
		}
		// 关键不变量：这个接口只"查一下看看"，无论如何都不能写入手工汇率
		// （手工汇率会阻止之后的自动抓取，写进去就成了一个不易察觉的坑）
		expect(await count()).toBe(before);

		const same = await call("/api/settings/fx/lookup", {
			method: "POST",
			cookie,
			body: JSON.stringify({ base: "USD", quote: "USD" }),
		});
		expect(same.status).toBe(400);
	});
});

