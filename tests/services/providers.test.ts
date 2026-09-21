import { describe, expect, it } from "vitest";
import {
	binanceSymbol,
	coingeckoId,
	frankfurterPair,
	parseProviderSettings,
	planProviders,
	readPath,
	runAdapter,
	tencentSymbol,
	yahooSymbol,
	type FetchContext,
	type QuoteTarget,
	type ProviderSettings,
} from "../../src/worker/services/quotes/providers";

/** 用假的 fetch 替身验证适配器的解析逻辑（不打真实网络） */
export function fakeFetch(
	handlers: Array<{ match: (url: string) => boolean; json?: unknown; text?: string; status?: number }>,
): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
		for (const handler of handlers) {
			if (!handler.match(url)) continue;
			const body = handler.text ?? JSON.stringify(handler.json ?? {});
			return new Response(body, {
				status: handler.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("no handler", { status: 404 });
	};
	return impl as unknown as typeof fetch;
}

const ctx = (handlers: Parameters<typeof fakeFetch>[0]): FetchContext => ({ fetcher: fakeFetch(handlers), apiKeys: {} });
const settings: ProviderSettings = { enabled: {} };

const stock = (overrides: Partial<QuoteTarget> = {}): QuoteTarget => ({
	key: "h1",
	kind: "stock",
	symbol: "AAPL",
	currency: "USD",
	market: "us",
	...overrides,
});

describe("代码映射（纯函数）", () => {
	it("Yahoo：美股原样、港股补 .HK、A 股按首位补 .SS/.SZ、加密用 -USD、汇率用 =X", () => {
		expect(yahooSymbol(stock())).toBe("AAPL");
		expect(yahooSymbol(stock({ symbol: "700", market: "hk" }))).toBe("0700.HK");
		expect(yahooSymbol(stock({ symbol: "0700.HK", market: "hk" }))).toBe("0700.HK");
		expect(yahooSymbol(stock({ symbol: "600519", market: "cn" }))).toBe("600519.SS");
		expect(yahooSymbol(stock({ symbol: "000001", market: "cn" }))).toBe("000001.SZ");
		expect(yahooSymbol(stock({ symbol: "BTC", kind: "crypto" }))).toBe("BTC-USD");
		expect(yahooSymbol(stock({ symbol: "HKD=X", kind: "fx" }))).toBe("HKD=X");
	});

	it("Yahoo：港股 5 位代码要去掉一个前导零（03121 → 3121.HK）", () => {
		// 实测：03121.HK / 00700.HK / 09988.HK 在 Yahoo 全是 404，
		// 而 3121.HK / 0700.HK / 9988.HK 才有数据（港交所 5 位 → Yahoo 4 位）
		expect(yahooSymbol(stock({ symbol: "03121", market: "hk" }))).toBe("3121.HK");
		expect(yahooSymbol(stock({ symbol: "00700", market: "hk" }))).toBe("0700.HK");
		expect(yahooSymbol(stock({ symbol: "09988", market: "hk" }))).toBe("9988.HK");
		expect(yahooSymbol(stock({ symbol: "00005", market: "hk" }))).toBe("0005.HK");
		expect(yahooSymbol(stock({ symbol: "03121.HK", market: "hk" }))).toBe("3121.HK");
		// 8 开头的 5 位代码（人民币柜台）Yahoo 也是 5 位，不能去零
		expect(yahooSymbol(stock({ symbol: "80737", market: "hk" }))).toBe("80737.HK");
	});

	it("腾讯：港股用港交所 5 位代码，带后缀的也要能转", () => {
		expect(tencentSymbol(stock({ symbol: "03121", market: "hk" }))).toBe("hk03121");
		expect(tencentSymbol(stock({ symbol: "3121", market: "hk" }))).toBe("hk03121");
		// 代码查询存下来的 "03121.HK" 原来会拼成 hk03121.HK（腾讯返回 v_pv_none_match）
		expect(tencentSymbol(stock({ symbol: "03121.HK", market: "hk" }))).toBe("hk03121");
		expect(tencentSymbol(stock({ symbol: "0700.HK", market: "hk" }))).toBe("hk00700");
		expect(tencentSymbol(stock({ symbol: "600519.SS", market: "cn" }))).toBe("sh600519");
		expect(tencentSymbol(stock({ symbol: "000001.SZ", market: "cn" }))).toBe("sz000001");
	});

	it("Yahoo：用户指定的代码覆盖优先", () => {
		expect(yahooSymbol(stock({ symbolOverride: "9988.HK", market: "us" }))).toBe("9988.HK");
	});

	it("腾讯：港股 hk00700、A 股 sh/sz 前缀；已带前缀的原样使用", () => {
		expect(tencentSymbol(stock({ symbol: "700", market: "hk" }))).toBe("hk00700");
		expect(tencentSymbol(stock({ symbol: "600519", market: "cn" }))).toBe("sh600519");
		expect(tencentSymbol(stock({ symbol: "000001", market: "cn" }))).toBe("sz000001");
		expect(tencentSymbol(stock({ symbol: "hk00700", market: "hk" }))).toBe("hk00700");
		expect(tencentSymbol(stock({ symbol: "AAPL", market: "us" }))).toBeNull();
	});

	it("Binance：补 USDT 后缀，非美元计价直接跳过", () => {
		expect(binanceSymbol(stock({ symbol: "BTC", kind: "crypto" }))).toBe("BTCUSDT");
		expect(binanceSymbol(stock({ symbol: "ETHUSDT", kind: "crypto" }))).toBe("ETHUSDT");
		expect(binanceSymbol(stock({ symbol: "BTC", kind: "crypto", currency: "HKD" }))).toBeNull();
		// 代码查询给出的加密代码带 -USD 后缀，必须剥掉再拼 USDT（否则是 "BTC-USDUSDT"）
		expect(binanceSymbol(stock({ symbol: "BTC-USD", kind: "crypto" }))).toBe("BTCUSDT");
		expect(binanceSymbol(stock({ symbol: "SPCXB-USD", kind: "crypto" }))).toBe("SPCXBUSDT");
		expect(binanceSymbol(stock({ symbol: "BTC/USDT", kind: "crypto" }))).toBe("BTCUSDT");
		expect(binanceSymbol(stock({ symbol: "USDT", kind: "crypto" }))).toBeNull();
		expect(binanceSymbol(stock({ symbol: "USD", kind: "crypto" }))).toBeNull();
	});

	it("CoinGecko：内置常见币映射，未知币返回 null（提示用户填代码覆盖）", () => {
		expect(coingeckoId(stock({ symbol: "BTC", kind: "crypto" }))).toBe("bitcoin");
		expect(coingeckoId(stock({ symbol: "eth", kind: "crypto" }))).toBe("ethereum");
		expect(coingeckoId(stock({ symbol: "UNKNOWNCOIN", kind: "crypto" }))).toBeNull();
		expect(coingeckoId(stock({ symbol: "BTC", kind: "crypto", symbolOverride: "my-token" }))).toBe("my-token");
	});

	it("汇率对解析", () => {
		expect(frankfurterPair(stock({ symbol: "usd:hkd", kind: "fx" }))).toEqual({ base: "USD", quote: "HKD" });
		expect(frankfurterPair(stock({ symbol: "bad", kind: "fx" }))).toBeNull();
	});
});

describe("readPath", () => {
	it("支持点号路径与数组下标", () => {
		const payload = { data: { price: 12.5, currency: "USD" }, quotes: [{ close: 7 }] };
		expect(readPath(payload, "data.price")).toBe(12.5);
		expect(readPath(payload, "quotes.0.close")).toBe(7);
		expect(readPath(payload, "data.missing.deeper")).toBeUndefined();
	});
});

describe("数据源选择", () => {
	it("默认开启内置免费源，并按推荐顺序回退", () => {
		expect(planProviders("crypto", { enabled: {} })).toEqual(["coingecko", "binance", "yahoo"]);
		expect(planProviders("stock", { enabled: {} })).toEqual(["yahoo", "tencent"]);
		expect(planProviders("fx", { enabled: {} })).toEqual(["frankfurter", "erapi"]);
	});

	it("关掉的源会被跳过；自定义源启用后提到最前", () => {
		expect(planProviders("crypto", { enabled: { coingecko: false } })).toEqual(["binance", "yahoo"]);
		expect(
			planProviders("stock", { enabled: { custom: true }, custom: { urlTemplate: "https://x/{symbol}", pricePath: "p" } }),
		).toEqual(["custom", "yahoo", "tencent"]);
	});

	it("持仓显式指定的数据源优先，且只走那一家", () => {
		expect(planProviders("stock", { enabled: {} }, "tencent")).toEqual(["tencent"]);
		// 指定的源没启用时退回默认顺序
		expect(planProviders("stock", { enabled: { tencent: false } }, "tencent")).toEqual(["yahoo"]);
	});

	it("parseProviderSettings 容错坏数据", () => {
		expect(parseProviderSettings(null)).toEqual({ enabled: {} });
		expect(parseProviderSettings("not json")).toEqual({ enabled: {} });
		expect(parseProviderSettings('{"enabled":{"yahoo":false,"bogus":true}}')).toEqual({
			enabled: { yahoo: false },
			custom: null,
		});
	});
});

describe("适配器解析", () => {
	it("CoinGecko：一次请求取多个币，按 vs_currencies 归一化", async () => {
		const result = await runAdapter(
			"coingecko",
			[
				{ key: "h1", kind: "crypto", symbol: "BTC", currency: "USD" },
				{ key: "h2", kind: "crypto", symbol: "ETH", currency: "USD" },
				{ key: "h3", kind: "crypto", symbol: "NOPE", currency: "USD" },
			],
			ctx([
				{
					match: (url) => url.includes("api.coingecko.com"),
					json: { bitcoin: { usd: 80000 }, ethereum: { usd: 2500 } },
				},
			]),
			settings,
		);

		expect(result.quotes.map((quote) => [quote.key, quote.price])).toEqual([
			["h1", 80000],
			["h2", 2500],
		]);
		expect(result.errors.map((item) => item.symbol)).toEqual(["NOPE"]);
		expect(result.errors[0]?.message).not.toBe("");
	});

	it("Binance：批量 symbols 参数 + 解析字符串价格", async () => {
		const result = await runAdapter(
			"binance",
			[{ key: "h1", kind: "crypto", symbol: "BTC", currency: "USD" }],
			ctx([
				{
					match: (url) => url.includes("api.binance.com"),
					json: [{ symbol: "BTCUSDT", price: "80123.45000000" }],
				},
			]),
			settings,
		);
		expect(result.quotes[0]).toMatchObject({ key: "h1", price: 80123.45, source: "binance" });
	});

	it("Yahoo：从 chart.result[0].meta 取价，并带回标的计价币种", async () => {
		const result = await runAdapter(
			"yahoo",
			[{ key: "h1", kind: "stock", symbol: "700", market: "hk", currency: "HKD" }],
			ctx([
				{
					match: (url) => url.includes("0700.HK"),
					json: { chart: { result: [{ meta: { currency: "HKD", regularMarketPrice: 419 } }] } },
				},
			]),
			settings,
		);
		expect(result.quotes[0]).toMatchObject({ price: 419, currency: "HKD", symbol: "0700.HK" });
	});

	it("Yahoo：单个标的失败不影响其它标的", async () => {
		const result = await runAdapter(
			"yahoo",
			[
				{ key: "h1", kind: "stock", symbol: "AAPL", currency: "USD", market: "us" },
				{ key: "h2", kind: "stock", symbol: "FAIL", currency: "USD", market: "us" },
			],
			ctx([
				{ match: (url) => url.includes("AAPL"), json: { chart: { result: [{ meta: { regularMarketPrice: 200 } }] } } },
				{ match: (url) => url.includes("FAIL"), status: 500, json: {} },
			]),
			settings,
		);
		expect(result.quotes).toHaveLength(1);
		// 失败必须归因到具体代码（之前调用方靠猜字符串，猜错了就退化成"所有数据源都没取到"）
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.symbol).toBe("FAIL");
		expect(result.errors[0]?.message).toContain("500");
	});

	it("腾讯：解析 ~ 分隔的多标的响应（GBK 但只取数字字段）", async () => {
		const text = 'v_hk00700="100~乱码名字~00700~419.000~426.000~";\nv_sh600519="1~乱码~600519~1257.12~1260.0~";';
		const result = await runAdapter(
			"tencent",
			[
				{ key: "h1", kind: "stock", symbol: "700", market: "hk", currency: "HKD" },
				{ key: "h2", kind: "stock", symbol: "600519", market: "cn", currency: "CNY" },
			],
			ctx([{ match: (url) => url.includes("qt.gtimg.cn"), text, json: {} }]),
			settings,
		);
		expect(result.quotes.map((quote) => [quote.key, quote.price, quote.currency])).toEqual([
			["h1", 419, "HKD"],
			["h2", 1257.12, "CNY"],
		]);
	});

	it("Frankfurter：按 base 分组，一次请求拿多个目标币种", async () => {
		const result = await runAdapter(
			"frankfurter",
			[
				{ key: "fx:USD:HKD", kind: "fx", symbol: "USD:HKD", currency: "HKD" },
				{ key: "fx:USD:CNY", kind: "fx", symbol: "USD:CNY", currency: "CNY" },
			],
			ctx([
				{ match: (url) => url.includes("frankfurter"), json: { base: "USD", rates: { HKD: 7.84, CNY: 6.7 } } },
			]),
			settings,
		);
		expect(result.quotes.map((quote) => [quote.key, quote.price])).toEqual([
			["fx:USD:HKD", 7.84],
			["fx:USD:CNY", 6.7],
		]);
	});

	it("自定义数据源：URL 模板替换 + JSON 路径取值", async () => {
		const result = await runAdapter(
			"custom",
			[{ key: "h1", kind: "stock", symbol: "AAPL", currency: "USD", market: "us" }],
			ctx([{ match: (url) => url.includes("my-api.test"), json: { data: { price: 222.5, currency: "usd" } } }]),
			{
				enabled: { custom: true },
				custom: { urlTemplate: "https://my-api.test/quote/{symbol}?k={key}", pricePath: "data.price", currencyPath: "data.currency", key: "secret" },
			},
		);
		expect(result.quotes[0]).toMatchObject({ price: 222.5, currency: "USD", source: "custom" });
	});

	it("自定义数据源：未配置时给出明确错误（不抛异常，走 errors 通道）", async () => {
		const result = await runAdapter("custom", [stock()], ctx([]), { enabled: {} });
		expect(result.quotes).toHaveLength(0);
		expect(result.errors.map((item) => item.message).join(" ")).toContain("未配置");
		expect(result.errors.map((item) => item.symbol)).toEqual(["AAPL"]);
	});
});
