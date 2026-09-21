import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { peggedRate } from "../../src/shared/pegged";
import { buildFxLookup } from "../../src/worker/data/fx.repo";
import { refreshQuotes } from "../../src/worker/services/quotes";
import { isPlaceholderName, lookupSymbol } from "../../src/worker/services/quotes/lookup";
import { bootstrap, call, clearAll, fakeFetch } from "../helpers";

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

	it("失败原因带出「哪家数据源」与「真正请求的代码」", async () => {
		const accountId = await accountOf();
		// 覆盖代码写错了：请求的是 MSTR.HK，Yahoo 只会 404。
		// 原来的提示是 "MSTR：HTTP 404"，看起来像"数据源没有 MSTR"（其实有），看不出是我们请求错了。
		await addHolding(accountId, {
			class: "stock",
			market: "us",
			symbol: "MSTR",
			name: "MicroStrategy",
			quoteSymbol: "MSTR.HK",
		});

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		const reason = report.failed[0]?.reason ?? "";
		expect(report.failed[0]?.symbol).toBe("MSTR");
		expect(reason).toContain("Yahoo");
		expect(reason).toContain("MSTR.HK");
		// 同时带上"我们把它当成什么去查的"，用户才知道是哪一项记错了
		expect(report.failed[0]?.kind).toBe("stock");
		expect(report.failed[0]?.quoteSymbol).toBe("MSTR.HK");
	});

	it("历史遗留的「市场记错」数据同样能被诊断出来", async () => {
		const accountId = await accountOf();
		// 市场与代码对不上的行现在会在保存时被拦下，但库里可能还留着以前存进去的，
		// 这些行的失败原因也必须能说清"请求的是 MSTR.HK"
		await env.DB.prepare(
			`INSERT INTO holdings (id, account_id, class, market, symbol, name, currency, qty, price, created_at, updated_at)
			 VALUES ('legacy-1', ?, 'stock', 'hk', 'MSTR', 'MicroStrategy', 'USD', 1, 100, ?, ?)`,
		)
			.bind(accountId, new Date().toISOString(), new Date().toISOString())
			.run();

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		const failure = report.failed.find((item) => item.symbol === "MSTR");
		expect(failure?.reason).toContain("MSTR.HK");
		expect(failure?.market).toBe("hk");
	});

	it("港股 5 位代码（03121 南方KOSPI）请求的是 3121.HK，并且能取到价格", async () => {
		const accountId = await accountOf();
		const holdingId = await addHolding(accountId, {
			class: "stock",
			market: "hk",
			symbol: "03121",
			name: "南方KOSPI",
			qty: 1000,
		});

		const urls: string[] = [];
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("3121.HK")) {
				return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 6.73 } }] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("no handler", { status: 404 });
		}) as unknown as typeof fetch;

		const report = await refreshQuotes(env, { trigger: "manual", fetcher });
		expect(report.failed).toEqual([]);
		// 关键：发出去的是 Yahoo 认的 4 位形式，而不是原样的 03121.HK
		expect(urls.some((url) => url.includes("3121.HK"))).toBe(true);
		expect(urls.some((url) => url.includes("03121.HK"))).toBe(false);

		const holdings = await call<Envelope<{ items: Array<{ id: string; price: number }> }>>("/api/holdings", { cookie });
		expect(holdings.body.data.items.find((item) => item.id === holdingId)?.price).toBe(6.73);
	});

	it("代码查询（查名称）也按 Yahoo 的 4 位形式去问，港股才能带出价格", async () => {
		const urls: string[] = [];
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("v1/finance/search")) {
				return new Response(
					JSON.stringify({
						quotes: [{ symbol: "3121.HK", quoteType: "ETF", shortname: "CSOP KOSPI", exchDisp: "HKSE" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("3121.HK")) {
				return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "HKD", regularMarketPrice: 6.73 } }] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("no handler", { status: 404 });
		}) as unknown as typeof fetch;

		const result = await lookupSymbol(env, { symbol: "03121", market: "hk", fetcher, force: true });
		expect(urls.some((url) => url.includes("3121.HK"))).toBe(true);
		expect(urls.some((url) => url.includes("03121.HK"))).toBe(false);
		// 搜索也要用去零后的 4 位：q=03121 在 Yahoo 只会搜到 031210.KS / 03121T.TW 之类的噪音，
		// 搜不到 3121.HK，于是候选里就只剩"名字是代码"的占位项
		const searchUrl = urls.find((url) => url.includes("v1/finance/search"));
		expect(searchUrl).toContain("q=3121");
		expect(searchUrl).not.toContain("q=03121");

		const candidate = result.candidates.find((item) => item.symbol === "3121.HK");
		expect(candidate?.price).toBe(6.73);
		// 候选里的名称必须是搜到的正式名称，而不是 "03121" 这种占位值
		expect(result.candidates[0]?.symbol).toBe("3121.HK");
		expect(result.candidates[0]?.name).toBe("CSOP KOSPI");
	});

	it("搜索没结果时不会把代码当成名称塞进候选", async () => {
		// 真实情况：q=03121 会返回 031210.KS / 03121T.TW，被市场过滤后一个都不剩
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("v1/finance/search")) {
				return new Response(JSON.stringify({ quotes: [{ symbol: "031210.KS", quoteType: "EQUITY" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("no handler", { status: 404 });
		}) as unknown as typeof fetch;

		const result = await lookupSymbol(env, { symbol: "03121", market: "hk", fetcher, force: true });
		const candidate = result.candidates.find((item) => item.symbol === "3121.HK");
		// 名称仍是占位值（代码）—— 表单侧靠 isPlaceholderName 判断，不会把它当名字填进去
		expect(isPlaceholderName(candidate?.name ?? "", "03121", "3121.HK")).toBe(true);
	});

	it("带 .HK 后缀的港股代码（代码查询存下来的那种）两家数据源都能认", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, { class: "stock", market: "hk", symbol: "03121.HK", name: "南方KOSPI" });

		const urls: string[] = [];
		// Yahoo 故意全 404，看腾讯兜底请求的是什么代码
		const fetcher = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response("no handler", { status: 404 });
		}) as unknown as typeof fetch;

		await refreshQuotes(env, { trigger: "manual", fetcher });
		expect(urls.some((url) => url.includes("query1.finance.yahoo.com") && url.includes("3121.HK"))).toBe(true);
		// 原来会拼成 hk03121.HK（腾讯返回 v_pv_none_match），正确写法是 hk03121
		expect(urls.some((url) => url.includes("hk03121"))).toBe(true);
		expect(urls.some((url) => url.includes("hk03121.HK"))).toBe(false);
	});

	it("多家数据源都失败时，每家怎么说都列出来", async () => {
		const accountId = await accountOf();
		// 加密类别的美股代码：CoinGecko 没 id、Binance 没这个交易对、Yahoo 请求的是 MSTR-USD
		await addHolding(accountId, { class: "crypto", market: "crypto", symbol: "MSTR", name: "MicroStrategy" });

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		const reason = report.failed[0]?.reason ?? "";
		expect(reason).toContain("CoinGecko");
		expect(reason).toContain("Yahoo");
		expect(reason).toContain("MSTR-USD");
		expect(reason.split("；").length).toBeGreaterThanOrEqual(2);
	});

	it("状态接口带出失败明细，界面才能显示「哪个代码、为什么」", async () => {
		const accountId = await accountOf();
		await addHolding(accountId, { class: "crypto", market: "crypto", symbol: "SPCXB-USD", name: "代币化股票" });

		const report = await refreshQuotes(env, { trigger: "manual", fetcher: fakeFetch([]) });
		expect(report.failed).toHaveLength(1);

		type RunDto = {
			failed: number;
			failures: Array<{ symbol: string; reason: string; kind?: string; market?: string | null }>;
		};
		const status = await call<Envelope<{ recentRuns: RunDto[] }>>(
			"/api/quotes/status",
			{ cookie },
		);
		const latest = status.body.data.recentRuns[0];
		expect(latest?.failed).toBe(1);
		expect(latest?.failures).toHaveLength(1);
		expect(latest?.failures[0]?.symbol).toBe("SPCXB-USD");
		expect(latest?.failures[0]?.reason).not.toBe("");
		// 界面要能显示"类别 · 市场"，所以这两个字段也得跟着出来
		expect(latest?.failures[0]?.kind).toBe("crypto");
		expect(latest?.failures[0]?.market).toBe("crypto");
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
