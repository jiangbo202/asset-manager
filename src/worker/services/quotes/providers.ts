import { isRecord } from "../../core/utils";
import type { Translator } from "../../../shared/i18n";
import { translator as sharedTranslator } from "../../core/i18n";

/**
 * 行情数据源适配器（v0.10）
 *
 * 设计原则：
 *  1. **全部免费接口、默认零配置可用**（CoinGecko / Binance / Yahoo / 腾讯 / Frankfurter / open.er-api）
 *  2. **可插拔**：每个标的按 数据源优先级 依次尝试，前一个失败/覆盖不到就顺延
 *  3. **可自定义**：用户可以在设置页填一个 URL 模板 + JSON 路径，接任意自建/第三方服务
 *  4. **结果归一化**：所有适配器统一返回 { price, currency, source, symbol }
 *
 * 注意：免费接口都有频率限制且随时可能变；因此价格永远允许手动覆盖，
 * 抓取失败只会在界面上提示"数据陈旧"，不影响记账本身。
 */

export type QuoteKind = "crypto" | "stock" | "fx";

export type ProviderId =
	| "custom"
	| "coingecko"
	| "binance"
	| "yahoo"
	| "tencent"
	| "frankfurter"
	| "erapi";

export interface ProviderMeta {
	id: ProviderId;
	label: string;
	kinds: QuoteKind[];
	needsKey: boolean;
	keyHint?: string;
	docs?: string;
	note: string;
	defaultEnabled: boolean;
	/** 一次请求能否覆盖多个标的（省 subrequest） */
	batch: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
	{
		id: "coingecko",
		label: "CoinGecko（加密）",
		kinds: ["crypto"],
		needsKey: false,
		docs: "https://www.coingecko.com/en/api",
		note: "公开无 Key 接口，一次请求可查多个币；有频率限制。代码需用 coin id（如 bitcoin），BTC 等常见币已内置映射。",
		defaultEnabled: true,
		batch: true,
	},
	{
		id: "binance",
		label: "Binance（加密，备用）",
		kinds: ["crypto"],
		needsKey: false,
		note: "无 Key，一次可查多个 USDT 交易对；部分地区可能无法访问。",
		defaultEnabled: true,
		batch: true,
	},
	{
		id: "yahoo",
		label: "Yahoo Finance（股票 / 加密 / 汇率）",
		kinds: ["stock", "crypto", "fx"],
		needsKey: false,
		note: "免费但非官方接口，覆盖面最广（美股 / 港股 .HK / A 股 .SS .SZ / 加密 -USD / 汇率 =X）。每个标的 1 次请求。",
		defaultEnabled: true,
		batch: false,
	},
	{
		id: "tencent",
		label: "腾讯行情（港股 / A 股，备用）",
		kinds: ["stock"],
		needsKey: false,
		note: "一次请求可查多个港股/A 股代码（如 hk00700、sh600519），延时行情。",
		defaultEnabled: true,
		batch: true,
	},
	{
		id: "frankfurter",
		label: "Frankfurter / 欧洲央行（汇率）",
		kinds: ["fx"],
		needsKey: false,
		docs: "https://frankfurter.dev",
		note: "欧洲央行参考汇率，无 Key，工作日更新。",
		defaultEnabled: true,
		batch: true,
	},
	{
		id: "erapi",
		label: "open.er-api（汇率，备用）",
		kinds: ["fx"],
		needsKey: false,
		docs: "https://www.exchangerate-api.com/docs/free",
		note: "无 Key，覆盖币种比 ECB 多。",
		defaultEnabled: true,
		batch: true,
	},
	{
		id: "custom",
		label: "自定义数据源",
		kinds: ["stock", "crypto", "fx"],
		needsKey: false,
		note: "填一个 URL 模板 + JSON 路径，可对接任意自建或第三方行情服务；支持 {symbol} 与 {key} 占位符。",
		defaultEnabled: false,
		batch: false,
	},
];

export const PROVIDER_MAP = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** 各类型数据源的默认尝试顺序（自定义源若启用会被提到最前） */
export const DEFAULT_PRIORITY: Record<QuoteKind, ProviderId[]> = {
	crypto: ["coingecko", "binance", "yahoo"],
	stock: ["yahoo", "tencent"],
	fx: ["frankfurter", "erapi"],
};

export interface QuoteTarget {
	/** 调用方标识：持仓 id 或 `fx:USD:HKD` */
	key: string;
	kind: QuoteKind;
	symbol: string;
	currency: string;
	market?: string | null;
	/** 持仓级覆盖：指定数据源与代码 */
	sourceOverride?: string | null;
	symbolOverride?: string | null;
}

export interface Quote {
	key: string;
	price: number;
	currency: string;
	source: ProviderId;
	symbol: string;
	/** 上游顺带返回的名称（Yahoo 的 chart 接口会带），用于"输入代码自动填名称" */
	name?: string;
}

export interface CustomProviderConfig {
	urlTemplate: string;
	pricePath: string;
	currencyPath?: string;
	headers?: string;
	key?: string;
}

export interface ProviderSettings {
	enabled: Partial<Record<ProviderId, boolean>>;
	custom?: CustomProviderConfig | null;
}

export interface FetchContext {
	fetcher: typeof fetch;
	apiKeys: Partial<Record<ProviderId, string>>;
	timeoutMs?: number;
	/** 提示文案的语言（缺省中文），让"限流/代码错误"等诊断信息也跟随界面语言 */
	t?: Translator;
}

/** 取当前上下文的翻译函数（测试里可以不传） */
export const tr = (ctx: FetchContext): Translator => ctx.t ?? sharedTranslator("zh");

/**
 * 单个标的的取价失败原因。
 *
 * symbol 必须逐条带上：调用方按 symbol 归因，UI 才能说出"哪个代码失败了、为什么"。
 * 之前 errors 是裸字符串，调用方用 `error.split("：")[0]` 猜 symbol —— 猜错了
 * （拿到的是"CoinGecko"这类词），于是所有失败都退化成"所有数据源都没能取到价格"。
 */
export interface AdapterError {
	symbol: string;
	message: string;
}

/** 构造一条归因到具体标的的失败原因 */
const fail = (symbol: string, message: string): AdapterError => ({ symbol, message });

export interface AdapterResult {
	quotes: Quote[];
	errors: AdapterError[];
	/** 整次调用失败时的上游 HTTP 状态（用于限流判定） */
	status?: number;
}

/** 上游接口错误：保留状态码，便于区分"限流"与"代码写错了" */
export class UpstreamError extends Error {
	readonly status: number;

	constructor(status: number, message?: string) {
		super(message ?? `HTTP ${status}`);
		this.name = "UpstreamError";
		this.status = status;
	}
}

/* ── 通用工具 ─────────────────────────────────────────────── */

const CONCURRENCY = 6; // Workers 免费版：同时最多 6 个出站连接

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

const describeStatus = (status: number, t: Translator): string => {
	if (status === 429) return t("quote.rateLimited");
	if (status === 403) return t("quote.forbidden");
	if (status === 404) return t("quote.notFound");
	return `HTTP ${status}`;
};

async function requestJson(url: string, ctx: FetchContext, headers?: Record<string, string>): Promise<unknown> {
	const response = await ctx.fetcher(url, {
		headers,
		signal: AbortSignal.timeout(ctx.timeoutMs ?? 8_000),
	});
	if (!response.ok) throw new UpstreamError(response.status, describeStatus(response.status, tr(ctx)));
	return response.json();
}

async function requestText(url: string, ctx: FetchContext, headers?: Record<string, string>): Promise<string> {
	const response = await ctx.fetcher(url, {
		headers,
		signal: AbortSignal.timeout(ctx.timeoutMs ?? 8_000),
	});
	if (!response.ok) throw new UpstreamError(response.status, describeStatus(response.status, tr(ctx)));
	return response.text();
}

/** 从一堆 per-symbol 结果里挑出最值得上报的状态码（429 优先） */
function pickStatus(errors: Array<{ status?: number }>): number | undefined {
	const statuses = errors.map((item) => item.status).filter((value): value is number => typeof value === "number");
	if (statuses.includes(429)) return 429;
	if (statuses.includes(403)) return 403;
	return statuses[0];
}

const num = (value: unknown): number | null => {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** 用户显式指定的代码优先，其次按市场规则推导 */
function baseSymbol(target: QuoteTarget): string {
	const raw = (target.symbolOverride ?? target.symbol ?? "").trim().toUpperCase();
	return raw;
}

/* ── 代码映射（纯函数，单测覆盖） ─────────────────────────── */

/** 常见币种的 CoinGecko id 映射（代码查询与取价共用） */
export const COINGECKO_IDS: Record<string, string> = {
	BTC: "bitcoin",
	XBT: "bitcoin",
	ETH: "ethereum",
	USDT: "tether",
	USDC: "usd-coin",
	BNB: "binancecoin",
	SOL: "solana",
	XRP: "ripple",
	ADA: "cardano",
	DOGE: "dogecoin",
	TRX: "tron",
	TON: "the-open-network",
	DOT: "polkadot",
	MATIC: "matic-network",
	POL: "polygon-ecosystem-token",
	LTC: "litecoin",
	BCH: "bitcoin-cash",
	AVAX: "avalanche-2",
	LINK: "chainlink",
	ATOM: "cosmos",
	UNI: "uniswap",
	ETC: "ethereum-classic",
	XLM: "stellar",
	NEAR: "near",
	APT: "aptos",
	ARB: "arbitrum",
	OP: "optimism",
	SUI: "sui",
	FIL: "filecoin",
	AAVE: "aave",
	MKR: "maker",
	INJ: "injective-protocol",
	SEI: "sei-network",
	RUNE: "thorchain",
	PEPE: "pepe",
	SHIB: "shiba-inu",
	WLD: "worldcoin-wld",
	STX: "blockstack",
	IMX: "immutable-x",
	GRT: "the-graph",
	ALGO: "algorand",
	VET: "vechain",
	FTM: "fantom",
	SAND: "the-sandbox",
	MANA: "decentraland",
	CRV: "curve-dao-token",
};

export function coingeckoId(target: QuoteTarget): string | null {
	if (target.symbolOverride) return target.symbolOverride.trim().toLowerCase();
	const raw = baseSymbol(target);
	if (!raw) return null;
	return COINGECKO_IDS[raw] ?? null;
}

export function binanceSymbol(target: QuoteTarget): string | null {
	const raw = target.symbolOverride ? target.symbolOverride.trim().toUpperCase() : baseSymbol(target);
	if (!raw) return null;
	// Binance 的计价币多数是 USDT，近似当美元处理
	if (target.currency && target.currency !== "USD" && target.currency !== "USDT") return null;
	// 代码查询给出的加密代码是 "BTC-USD" 这种（Yahoo/CoinGecko 习惯），
	// 直接拼会变成 "BTC-USDUSDT"（不存在的交易对），所以先把计价币后缀去掉
	const base = raw.replace(/[-/](USDT|USDC|FDUSD|TUSD|BUSD|BTC|ETH|USD)$/, "");
	if (!base || /^(USD|USDT)$/.test(base)) return null;
	return base.includes("USDT") ? base : `${base}USDT`;
}

export function yahooSymbol(target: QuoteTarget): string | null {
	if (target.symbolOverride) return target.symbolOverride.trim();
	const raw = baseSymbol(target);
	if (!raw) return null;
	// 已经带交易所后缀 / 币种对的，直接用它
	if (raw.includes(".") || raw.includes("=") || raw.includes("-")) return raw;

	const market = (target.market ?? "").toLowerCase();
	if (target.kind === "crypto") return `${raw}-USD`;
	if (market === "hk") return `${raw.padStart(4, "0")}.HK`;
	if (market === "cn") return /^(6|9)/.test(raw) ? `${raw}.SS` : `${raw}.SZ`;
	return raw;
}

export function tencentSymbol(target: QuoteTarget): string | null {
	if (target.kind === "fx" || target.kind === "crypto") return null;
	const raw = target.symbolOverride
		? target.symbolOverride.trim().toLowerCase()
		: (target.symbol ?? "").trim().toUpperCase();
	if (!raw) return null;
	if (/^(hk|sh|sz)/i.test(raw)) return raw.toLowerCase();

	const market = (target.market ?? "").toLowerCase();
	if (market === "hk") return `hk${raw.padStart(5, "0")}`;
	if (market === "cn") return /^(6|9)/.test(raw) ? `sh${raw}` : `sz${raw}`;
	return null;
}

export function frankfurterPair(target: QuoteTarget): { base: string; quote: string } | null {
	// fx 目标的 symbol 形如 "USD:HKD"
	const [base, quote] = target.symbol.split(":");
	if (!base || !quote) return null;
	return { base: base.toUpperCase(), quote: quote.toUpperCase() };
}

/* ── 各适配器实现 ─────────────────────────────────────────── */

async function coingeckoQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const pairs: Array<{ target: QuoteTarget; id: string }> = [];
	for (const target of targets) {
		const id = coingeckoId(target);
		if (id) pairs.push({ target, id });
		else errors.push(fail(target.symbol, tr(ctx)("quote.noCoingeckoId", { symbol: target.symbol })));
	}
	if (pairs.length === 0) return { quotes: [], errors };

	const vs = [...new Set(pairs.map((pair) => pair.target.currency.toLowerCase()))].filter(Boolean);
	const url = `https://api.coingecko.com/api/v3/simple/price?ids=${pairs
		.map((pair) => pair.id)
		.join(",")}&vs_currencies=${(vs.length > 0 ? vs : ["usd"]).join(",")}`;

	const data = await requestJson(url, ctx, { accept: "application/json" });
	if (!isRecord(data)) throw new Error("响应格式异常");

	const quotes: Quote[] = [];
	for (const pair of pairs) {
		const entry = data[pair.id];
		if (!isRecord(entry)) {
			errors.push(fail(pair.target.symbol, tr(ctx)("quote.coingeckoNoPrice", { symbol: pair.target.symbol })));
			continue;
		}
		const price = num(entry[pair.target.currency.toLowerCase()]) ?? num(entry.usd);
		if (price === null) {
			errors.push(
				fail(
					pair.target.symbol,
					tr(ctx)("quote.coingeckoNoQuoteCurrency", {
						symbol: pair.target.symbol,
						currency: pair.target.currency,
					}),
				),
			);
			continue;
		}
		quotes.push({
			key: pair.target.key,
			price,
			currency: pair.target.currency,
			source: "coingecko",
			symbol: pair.id,
		});
	}
	return { quotes, errors };
}

async function binanceQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const pairs: Array<{ target: QuoteTarget; symbol: string }> = [];
	for (const target of targets) {
		const symbol = binanceSymbol(target);
		if (symbol) pairs.push({ target, symbol });
		else errors.push(fail(target.symbol, tr(ctx)("quote.binanceUsdOnly", { symbol: target.symbol })));
	}
	if (pairs.length === 0) return { quotes: [], errors };

	const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(
		JSON.stringify(pairs.map((pair) => pair.symbol)),
	)}`;
	const data = await requestJson(url, ctx, { accept: "application/json" });
	if (!Array.isArray(data)) throw new Error("响应格式异常");

	const bySymbol = new Map<string, number>();
	for (const item of data) {
		if (!isRecord(item)) continue;
		const symbol = typeof item.symbol === "string" ? item.symbol : null;
		const price = num(item.price);
		if (symbol && price !== null) bySymbol.set(symbol, price);
	}

	const quotes: Quote[] = [];
	for (const pair of pairs) {
		const price = bySymbol.get(pair.symbol);
		if (price === undefined) {
			errors.push(
				fail(pair.target.symbol, tr(ctx)("quote.binanceNoPair", { symbol: pair.target.symbol, pair: pair.symbol })),
			);
			continue;
		}
		quotes.push({
			key: pair.target.key,
			price,
			currency: pair.target.currency || "USD",
			source: "binance",
			symbol: pair.symbol,
		});
	}
	return { quotes, errors };
}

const YAHOO_HEADERS = {
	accept: "application/json",
	"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
};

async function yahooQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const statuses: Array<{ status?: number }> = [];
	const results = await mapLimit(targets, CONCURRENCY, async (target) => {
		const symbol = yahooSymbol(target);
		if (!symbol) return { target, error: tr(ctx)("quote.noYahooSymbol") };
		try {
			const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
				symbol,
			)}?range=1d&interval=1d`;
			const data = await requestJson(url, ctx, YAHOO_HEADERS);
			const meta = isRecord(data) && isRecord(data.chart) && Array.isArray(data.chart.result)
				? (data.chart.result[0] as Record<string, unknown> | undefined)
				: undefined;
			const info = meta && isRecord(meta.meta) ? meta.meta : undefined;
			const price = info ? (num(info.regularMarketPrice) ?? num(info.previousClose)) : null;
			if (price === null) return { target, error: tr(ctx)("quote.yahooNoPrice") };
			return {
				quote: {
					key: target.key,
					// Yahoo 返回的是该标的的计价币种
					price,
					currency: typeof info?.currency === "string" ? info.currency : target.currency,
					source: "yahoo" as ProviderId,
					symbol,
					name: typeof info?.longName === "string" ? info.longName : typeof info?.shortName === "string" ? info.shortName : undefined,
				},
				actualSymbol: symbol,
			};
		} catch (error) {
			statuses.push({ status: error instanceof UpstreamError ? error.status : undefined });
			return { target, error: error instanceof Error ? error.message : "请求失败" };
		}
	});

	const quotes: Quote[] = [];
	for (const result of results) {
		if ("quote" in result && result.quote) quotes.push(result.quote);
		else
			errors.push(
				fail(result.target.symbol, "error" in result ? result.error : tr(ctx)("quote.requestFailed")),
			);
	}
	return { quotes, errors, status: pickStatus(statuses) };
}

async function tencentQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const pairs: Array<{ target: QuoteTarget; symbol: string }> = [];
	for (const target of targets) {
		const symbol = tencentSymbol(target);
		if (symbol) pairs.push({ target, symbol });
		else errors.push(fail(target.symbol, tr(ctx)("quote.tencentOnlyCn", { symbol: target.symbol })));
	}
	if (pairs.length === 0) return { quotes: [], errors };

	const url = `https://qt.gtimg.cn/q=${pairs.map((pair) => pair.symbol).join(",")}`;
	// 响应是 GBK；价格字段是 ASCII，这里只按分隔符取数字，不解码中文名
	const text = await requestText(url, ctx, { referer: "https://finance.qq.com" });

	const quotes: Quote[] = [];
	for (const pair of pairs) {
		const match = text.match(new RegExp(`v_${pair.symbol}="([^"]*)"`, "i"));
		if (!match) {
			errors.push(
				fail(pair.target.symbol, tr(ctx)("quote.tencentNoSymbol", { symbol: pair.target.symbol, ticker: pair.symbol })),
			);
			continue;
		}
		const fields = match[1].split("~");
		const price = num(fields[3]);
		if (price === null) {
			errors.push(fail(pair.target.symbol, tr(ctx)("quote.tencentBadField", { symbol: pair.target.symbol })));
			continue;
		}
		quotes.push({
			key: pair.target.key,
			price,
			currency: pair.symbol.startsWith("hk") ? "HKD" : "CNY",
			source: "tencent",
			symbol: pair.symbol,
		});
	}
	return { quotes, errors };
}

async function frankfurterQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const byBase = new Map<string, Array<{ target: QuoteTarget; quote: string }>>();
	for (const target of targets) {
		const pair = frankfurterPair(target);
		if (!pair) {
			errors.push(fail(target.symbol, tr(ctx)("quote.fxFormat", { symbol: target.symbol })));
			continue;
		}
		byBase.set(pair.base, [...(byBase.get(pair.base) ?? []), { target, quote: pair.quote }]);
	}

	const quotes: Quote[] = [];
	for (const [base, entries] of byBase) {
		const symbols = [...new Set(entries.map((entry) => entry.quote))];
		try {
			const url = `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${symbols.join(",")}`;
			const data = await requestJson(url, ctx, { accept: "application/json" });
			const rates = isRecord(data) && isRecord(data.rates) ? data.rates : null;
			if (!rates) throw new Error("响应缺少 rates");
			for (const entry of entries) {
				const price = num(rates[entry.quote]);
				if (price === null) {
					errors.push(
						fail(entry.target.symbol, tr(ctx)("quote.fxUnsupported", { symbol: entry.target.symbol, provider: "Frankfurter" })),
					);
					continue;
				}
				quotes.push({
					key: entry.target.key,
					price,
					currency: entry.quote,
					source: "frankfurter",
					symbol: `${base}:${entry.quote}`,
				});
			}
		} catch (error) {
			// 整组失败（网络/限流）要归因到组里每一个货币对，否则用户不知道是哪个币种没汇率
			const message = error instanceof Error ? error.message : tr(ctx)("quote.requestFailed");
			for (const entry of entries) errors.push(fail(entry.target.symbol, message));
		}
	}
	return { quotes, errors };
}

async function erapiQuotes(targets: QuoteTarget[], ctx: FetchContext): Promise<AdapterResult> {
	const errors: AdapterError[] = [];
	const byBase = new Map<string, Array<{ target: QuoteTarget; quote: string }>>();
	for (const target of targets) {
		const pair = frankfurterPair(target);
		if (!pair) {
			errors.push(fail(target.symbol, tr(ctx)("quote.fxFormat", { symbol: target.symbol })));
			continue;
		}
		byBase.set(pair.base, [...(byBase.get(pair.base) ?? []), { target, quote: pair.quote }]);
	}

	const quotes: Quote[] = [];
	for (const [base, entries] of byBase) {
		try {
			const data = await requestJson(`https://open.er-api.com/v6/latest/${base}`, ctx, {
				accept: "application/json",
			});
			const rates = isRecord(data) && isRecord(data.rates) ? data.rates : null;
			if (!rates) throw new Error("响应缺少 rates");
			for (const entry of entries) {
				const price = num(rates[entry.quote]);
				if (price === null) {
					errors.push(
						fail(entry.target.symbol, tr(ctx)("quote.fxUnsupported", { symbol: entry.target.symbol, provider: "open.er-api" })),
					);
					continue;
				}
				quotes.push({
					key: entry.target.key,
					price,
					currency: entry.quote,
					source: "erapi",
					symbol: `${base}:${entry.quote}`,
				});
			}
		} catch (error) {
			// 整组失败（网络/限流）要归因到组里每一个货币对，否则用户不知道是哪个币种没汇率
			const message = error instanceof Error ? error.message : tr(ctx)("quote.requestFailed");
			for (const entry of entries) errors.push(fail(entry.target.symbol, message));
		}
	}
	return { quotes, errors };
}

/** 按点号路径取值：data.price / quotes.0.close */
export function readPath(payload: unknown, path: string): unknown {
	if (!path) return undefined;
	let cursor: unknown = payload;
	for (const part of path.split(".")) {
		if (cursor === null || cursor === undefined) return undefined;
		if (Array.isArray(cursor)) {
			const index = Number.parseInt(part, 10);
			cursor = Number.isNaN(index) ? undefined : cursor[index];
			continue;
		}
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[part];
	}
	return cursor;
}

async function customQuotes(
	targets: QuoteTarget[],
	ctx: FetchContext,
	config: CustomProviderConfig | null | undefined,
): Promise<AdapterResult> {
	if (!config?.urlTemplate || !config.pricePath) {
		throw new Error(tr(ctx)("quote.customNotConfigured"));
	}
	let extraHeaders: Record<string, string> = {};
	if (config.headers) {
		try {
			const parsed = JSON.parse(config.headers) as unknown;
			if (isRecord(parsed)) {
				extraHeaders = Object.fromEntries(
					Object.entries(parsed).map(([key, value]) => [key, String(value)]),
				);
			}
		} catch {
			throw new Error(tr(ctx)("quote.customBadHeaders"));
		}
	}

	const errors: AdapterError[] = [];
	const statuses: Array<{ status?: number }> = [];
	const results = await mapLimit(targets, CONCURRENCY, async (target) => {
		const symbol = target.symbolOverride ?? target.symbol;
		const url = config.urlTemplate
			.replaceAll("{symbol}", encodeURIComponent(symbol))
			.replaceAll("{key}", encodeURIComponent(config.key ?? ""));
		try {
			const payload = await requestJson(url, ctx, { accept: "application/json", ...extraHeaders });
			const price = num(readPath(payload, config.pricePath));
			if (price === null) return { target, error: tr(ctx)("quote.customNoPrice", { path: config.pricePath }) };
			const currency =
				(config.currencyPath ? readPath(payload, config.currencyPath) : null) ?? target.currency;
			return {
				quote: {
					key: target.key,
					price,
					currency: typeof currency === "string" ? currency.toUpperCase() : target.currency,
					source: "custom" as ProviderId,
					symbol,
				},
			};
		} catch (error) {
			statuses.push({ status: error instanceof UpstreamError ? error.status : undefined });
			return { target, error: error instanceof Error ? error.message : "请求失败" };
		}
	});

	const quotes: Quote[] = [];
	for (const result of results) {
		if ("quote" in result && result.quote) quotes.push(result.quote);
		else
			errors.push(
				fail(result.target.symbol, "error" in result ? result.error : tr(ctx)("quote.requestFailed")),
			);
	}
	return { quotes, errors, status: pickStatus(statuses) };
}

/* ── 统一入口 ─────────────────────────────────────────────── */

export async function runAdapter(
	providerId: ProviderId,
	targets: QuoteTarget[],
	ctx: FetchContext,
	settings: ProviderSettings,
): Promise<AdapterResult> {
	const meta = PROVIDER_MAP.get(providerId);
	if (!meta) return { quotes: [], errors: [fail(providerId, tr(ctx)("quote.unknownProvider"))] };
	const applicable = targets.filter((target) => meta.kinds.includes(target.kind));
	if (applicable.length === 0) return { quotes: [], errors: [] };

	try {
		switch (providerId) {
			case "coingecko":
				return await coingeckoQuotes(applicable, ctx);
			case "binance":
				return await binanceQuotes(applicable, ctx);
			case "yahoo":
				return await yahooQuotes(applicable, ctx);
			case "tencent":
				return await tencentQuotes(applicable, ctx);
			case "frankfurter":
				return await frankfurterQuotes(applicable, ctx);
			case "erapi":
				return await erapiQuotes(applicable, ctx);
			case "custom":
				return await customQuotes(applicable, ctx, settings.custom);
			default:
				return { quotes: [], errors: [fail(providerId, tr(ctx)("quote.unknownProvider"))] };
		}
	} catch (error) {
		// 整个适配器抛异常（网络层/解析层）：归因到本次要取的每一个标的
		const message = error instanceof Error ? error.message : tr(ctx)("quote.requestFailed");
		return {
			quotes: [],
			errors: applicable.map((target) => fail(target.symbol, message)),
			status: error instanceof UpstreamError ? error.status : undefined,
		};
	}
}

/** 按类型给出要尝试的数据源顺序（用户显式指定 source 的优先） */
export function planProviders(
	kind: QuoteKind,
	settings: ProviderSettings,
	explicitSource?: string | null,
): ProviderId[] {
	const enabled = (id: ProviderId): boolean => {
		const meta = PROVIDER_MAP.get(id);
		if (!meta) return false;
		if (id === "custom") return Boolean(settings.custom?.urlTemplate && settings.enabled.custom);
		return settings.enabled[id] ?? meta.defaultEnabled;
	};

	if (explicitSource && PROVIDER_MAP.has(explicitSource as ProviderId)) {
		const id = explicitSource as ProviderId;
		if (enabled(id) && PROVIDER_MAP.get(id)?.kinds.includes(kind)) return [id];
	}

	const order = DEFAULT_PRIORITY[kind].filter(enabled);
	return settings.enabled.custom ? (["custom", ...order] as ProviderId[]) : order;
}

/** 解析设置里的 provider_config（容错：坏数据退回默认） */
export function parseProviderSettings(raw: string | null | undefined): ProviderSettings {
	if (!raw) return { enabled: {} };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return { enabled: {} };
		const enabledRaw = isRecord(parsed.enabled) ? parsed.enabled : {};
		const enabled: Partial<Record<ProviderId, boolean>> = {};
		for (const [key, value] of Object.entries(enabledRaw)) {
			if (PROVIDER_MAP.has(key as ProviderId)) enabled[key as ProviderId] = Boolean(value);
		}
		const customRaw = isRecord(parsed.custom) ? parsed.custom : null;
		return {
			enabled,
			custom: customRaw
				? {
						urlTemplate: String(customRaw.urlTemplate ?? ""),
						pricePath: String(customRaw.pricePath ?? ""),
						currencyPath: customRaw.currencyPath ? String(customRaw.currencyPath) : undefined,
						headers: customRaw.headers ? String(customRaw.headers) : undefined,
						key: customRaw.key ? String(customRaw.key) : undefined,
					}
				: null,
		};
	} catch {
		return { enabled: {} };
	}
}
