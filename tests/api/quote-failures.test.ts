import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { peggedRate } from "../../src/shared/pegged";
import { buildFxLookup } from "../../src/worker/data/fx.repo";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { bootstrap, call, clearAll } from "../helpers";
import { fakeFetch } from "../services/providers.test";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 两个真实踩到的坑：
 *  1. 失败原因被错误归因（errors 是裸字符串，调用方用 split("：") 猜 symbol），
 *     导致界面只显示"失败 1"，说不出是哪个代码、为什么。
 *  2. USDT/USDC 这类稳定币没有任何外汇数据源支持，于是"每次刷新固定失败一条"，
 *     而且折算总额时被当作"缺汇率"排除。
 */
describe("行情失败归因与稳定币折算", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const accountOf = async (currency = "USD") => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "测试账户", kind: "broker", currency, market: "us" }),
		});
		return account.body.data.id;
	};

	const addHolding = async (accountId: string, body: Record<string, unknown>) => {
		const response = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({ accountId, currency: "USD", qty: 1, price: 100, ...body }),
		});
		return response.body.data.id;
	};

	it("所有数据源都失败时，报告里带具体代码与数据源的原因（不再是笼统一句）", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, {
			class: "crypto",
			market: "crypto",
			symbol: "SPCXB-USD",
			name: "代币化股票",
		});

		// 所有上游都 404：任何数据源都拿不到这个代码
		const fetcher = fakeFetch([]);
		const report = await refreshQuotes(env, { trigger: "manual", fetcher });

		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.symbol).toBe("SPCXB-USD");
		const reason = report.failed[0]?.reason ?? "";
		expect(reason).not.toContain("所有数据源都没能取到价格");
		expect(reason.toLowerCase()).toMatch(/404|未返回|没有/);
	});

	it("状态接口带出失败明细，界面才能显示「哪个代码、为什么」", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, { class: "crypto", market: "crypto", symbol: "SPCXB-USD", name: "代币化股票" });

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		expect(report.failed).toHaveLength(1);

		const status = await call<Envelope<{ recentRuns: Array<{ failed: number; failures: Array<{ symbol: string; reason: string }> }> }>>(
			"/api/quotes/status",
			{ cookie },
		);
		const latest = status.body.data.recentRuns[0];
		expect(latest?.failed).toBe(1);
		expect(latest?.failures).toHaveLength(1);
		expect(latest?.failures[0]?.symbol).toBe("SPCXB-USD");
		expect(latest?.failures[0]?.reason).not.toBe("");
	});

	it("稳定币按 1:1 折算：不再有注定失败的汇率请求，也不再把持仓排除在总额外", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, { class: "cash", name: "USDT 现金", currency: "USDT", qty: 5000, price: 1 });

		// 只有稳定币需要折算：不该产生任何汇率请求，也就不会有失败
		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		expect(report.failed).toEqual([]);

		const portfolio = await call<Envelope<{ total: number; holdings: Array<{ currency: string; fxMissing: boolean; marketValueDisplay: number | null }> }>>(
			"/api/portfolio",
			{ cookie },
		);
		const cash = portfolio.body.data.holdings.find((item) => item.currency === "USDT");
		expect(cash?.fxMissing).toBe(false);
		expect(cash?.marketValueDisplay).toBeCloseTo(5000, 6);
		expect(portfolio.body.data.total).toBeCloseTo(5000, 6);
	});

	it("手工汇率优先于内置平价", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, { class: "cash", name: "USDT 现金", currency: "USDT", qty: 1000, price: 1 });

		const saved = await call<Envelope<unknown>>("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "USDT", quote: "USD", rate: 0.98 }),
		});
		expect(saved.body.ok).toBe(true);

		const portfolio = await call<Envelope<{ total: number }>>("/api/portfolio", { cookie });
		expect(portfolio.body.data.total).toBeCloseTo(980, 6);
	});

	it("拼错/未知币种仍然标为「未折算」，不冒充 1:1", () => {
		expect(peggedRate("USDT", "USD")).toBe(1);
		expect(peggedRate("USD", "USDC")).toBe(1);
		expect(peggedRate("USDT", "USDC")).toBe(1);
		expect(peggedRate("XYZ", "USD")).toBeNull();
		expect(peggedRate("CNY", "USD")).toBeNull();

		const lookup = buildFxLookup([]);
		expect(lookup("USDT", "USD")).toBe(1);
		expect(lookup("XYZ", "USD")).toBeNull();
	});
});
