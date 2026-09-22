import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../../src/shared/api-types";
import { pnlSummary, staleHoldings } from "../../src/web/lib/stats";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 现金口径的**集中**护栏
 *
 * 现金在这套数据模型里很特殊：价格恒为 1、没有任何行情源、没有平均成本、
 * 也不能被"更新价格"。因此已经反复踩坑：
 *   1. 「浮动盈亏」下方写"2 条未填成本"，点进去发现是两笔现金
 *   2. 「价格新鲜度」刚刷新完行情仍显示"1 天"（现金创建时也写了 price_updated_at）
 *   3. 「停更」告警把现金算成停更（早期就修了，但属于同一族问题）
 * 这三处各自散在别的测试里，新增统计项时很容易再忘一次。
 *
 * 所以把规则集中写在这里，新增"用到持仓的统计"时先来这个文件看一眼：
 *
 *   必须**排除**现金 —— 报价目标 / 价格新鲜度 / 未填成本计数 / 停更告警
 *   必须**包含**现金 —— 总资产 / 类别·账户·币种分布 / 缺汇率清单
 */
describe("现金口径（集中护栏）", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const account = async () => {
		const response = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "测试券商", kind: "broker", currency: "USD", market: "us" }),
		});
		return response.body.data.id;
	};

	const holding = async (accountId: string, body: Record<string, unknown>) => {
		const response = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({ accountId, currency: "USD", qty: 1, price: 100, ...body }),
		});
		return response.body.data.id;
	};

	/** 把价格更新时间往前挪，模拟"很久没更新" */
	const backdate = async (id: string, days: number) =>
		await env.DB.prepare(`UPDATE holdings SET price_updated_at = ? WHERE id = ?`)
			.bind(new Date(Date.now() - days * 86_400_000).toISOString(), id)
			.run();

	/** 建一套"一个股票 + 一笔现金"的组合，并把两条都退回到 10 天前 */
	const seed = async () => {
		const accountId = await account();
		const stock = await holding(accountId, {
			class: "stock",
			market: "us",
			symbol: "AAPL",
			name: "苹果",
			qty: 10,
			price: 200,
			avgCost: null, // 故意不填成本
		});
		const cash = await holding(accountId, { class: "cash", name: "现金", qty: 500, price: 1, avgCost: null });
		await backdate(stock, 10);
		await backdate(cash, 10);
		return { accountId, stock, cash };
	};

	const portfolio = async () => (await call<Envelope<Portfolio>>("/api/portfolio", { cookie })).body.data;

	it("① 报价目标：现金不进任何数据源请求", async () => {
		const accountId = await account();
		await holding(accountId, { class: "cash", name: "现金", qty: 500, price: 1 });

		const urls: string[] = [];
		const report = await refreshQuotes(env, {
			trigger: "manual",
			fetcher: (async (input: RequestInfo | URL) => {
				urls.push(String(input));
				return new Response("no handler", { status: 404 });
			}) as unknown as typeof fetch,
		});

		expect(urls).toEqual([]);
		expect(report.requests).toBe(0);
		expect(report.failed).toEqual([]);
		expect(report.updated).toBe(0);
	});

	it("② 价格新鲜度：只算非现金，全是现金时为 null", async () => {
		await seed();
		const data = await portfolio();
		// 股票退了 10 天 → 10；现金虽然也退了 10 天，但不算数
		expect(data.staleDays).toBe(10);
		expect(data.staleCount).toBe(1);

		// 把股票更新到今天：卡片归零，现金再旧也不拖住
		const only = await portfolio();
		const stockItem = only.holdings.find((item) => !item.isCash);
		await backdate(stockItem!.id, 0);
		const fresh = await portfolio();
		expect(fresh.staleDays).toBe(0);
		expect(fresh.staleCount).toBe(0);
	});

	it("③ 未填成本计数：现金不算漏填，也不进盈亏分母", async () => {
		await seed();
		const data = await portfolio();
		const summary = pnlSummary(data.holdings);
		// 组合里只有股票没填成本 → 计 1 条（现金不算）
		expect(summary.missingCostCount).toBe(1);
		// 现金没有成本，因此不参与"已投入成本"这个分母
		expect(summary.costTotal).toBe(0);
		expect(summary.pnlPct).toBeNull();

		// 现金单独存在时同样为 0 条
		await clearAll();
		cookie = (await bootstrap()).cookie;
		const accountId = await account();
		await holding(accountId, { class: "cash", name: "现金", qty: 100, price: 1, avgCost: null });
		expect(pnlSummary((await portfolio()).holdings).missingCostCount).toBe(0);
	});

	it("④ 停更告警：现金不会常年亮着一条无用告警", async () => {
		await seed();
		const data = await portfolio();
		const stale = staleHoldings(data.holdings);
		// 只有 AAPL 算停更，现金不算
		expect(stale.map((item) => item.symbol)).toEqual(["AAPL"]);

		// 阈值可调：涨到 20 天就都不算停更了
		expect(staleHoldings(data.holdings, 20)).toEqual([]);
	});

	it("⑤ 正向规则：现金照样进总资产与各类分布", async () => {
		await seed();
		const data = await portfolio();
		// 股票 10 × 200 = 2000，现金 500
		expect(data.total).toBeCloseTo(2500, 6);
		expect(data.holdings.filter((item) => item.isCash)).toHaveLength(1);
		const cashClass = data.byClass.find((item) => item.label === "cash");
		expect(cashClass?.value).toBeCloseTo(500, 6);
		expect(data.counts.holdings).toBe(2);
	});

	it("⑥ 正向规则：外币现金同样需要汇率（缺汇率时进清单）", async () => {
		const accountId = await account();
		await holding(accountId, { class: "cash", name: "港币现金", currency: "HKD", qty: 1000, price: 1 });

		const data = await portfolio();
		expect(data.missingFxCurrencies).toContain("HKD");
		// 缺汇率的现金被排除在总额外，但明确标出来而不是按 1:1 蒙
		expect(data.total).toBe(0);
		const cash = data.holdings.find((item) => item.currency === "HKD");
		expect(cash?.fxMissing).toBe(true);
		expect(cash?.marketValueDisplay).toBeNull();
	});
});

/* ── 浮动盈亏口径 ─────────────────────────────────────────── */

describe("浮动盈亏汇总", () => {
	const row = (
		extra: Partial<{ isCash: boolean; avgCost: number | null; costDisplay: number | null; pnlDisplay: number | null }>,
	) => ({ isCash: false, avgCost: 100, costDisplay: 1000, pnlDisplay: 100, ...extra });

	it("现金不算「未填成本」（用户看到「2 条未填成本」，点进去发现是两笔现金）", () => {
		const summary = pnlSummary([
			row({}),
			row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null }),
			row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null }),
		]);
		expect(summary.missingCostCount).toBe(0);
		// 现金也不参与盈亏比例（口径是"已投入成本"）
		expect(summary.costTotal).toBe(1000);
		expect(summary.pnlPct).toBeCloseTo(10, 6);
	});

	it("非现金没填成本才计数", () => {
		const summary = pnlSummary([row({}), row({ avgCost: null, costDisplay: null, pnlDisplay: null })]);
		expect(summary.missingCostCount).toBe(1);
	});

	it("没有成本时比例是 null（界面显示 —），不是 0% 或 Infinity", () => {
		const summary = pnlSummary([row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null })]);
		expect(summary.pnlPct).toBeNull();
		expect(summary.costTotal).toBe(0);
		expect(summary.pnlTotal).toBe(0);
	});
});
