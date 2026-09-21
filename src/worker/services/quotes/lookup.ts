import { nowIso } from "../../core/utils";
import { COINGECKO_IDS, yahooSymbol, type FetchContext } from "./providers";

/**
 * 代码查询：输入代码 → 返回名称、当前价、币种、市场
 * 用于「持仓表单」里两个体验点：
 *   1. 输入代码后自动填充名称/币种/市场
 *   2. 点一下按钮就能把最新价填进价格框
 *
 * 查询会缓存 24 小时（lookup_cache），避免反复打第三方搜索接口被限流。
 */

export interface LookupCandidate {
	symbol: string;
	name: string;
	price: number | null;
	currency: string | null;
	source: string;
	market: string;
	class: "stock" | "etf" | "crypto" | "fund" | "cash";
	exchange?: string | null;
}

export interface LookupResult {
	symbol: string;
	candidates: LookupCandidate[];
	cached: boolean;
	stale?: boolean;
	rateLimited: boolean;
	errors: string[];
}

const CACHE_TTL_MS = 24 * 3600 * 1000;
const YAHOO_HEADERS = {
	accept: "application/json",
	"user-agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
};

/**
 * 查询缓存键。
 *
 * 前缀是缓存版本：解析规则（例如港股 5 位 → Yahoo 4 位、搜索词归一化）变了以后
 * 必须 +1，否则用户拿到的还是旧规则算出来的结果，一整天都不对。
 */
const LOOKUP_CACHE_VERSION = "v2";
const cacheKey = (symbol: string, market: string | null) =>
	`${LOOKUP_CACHE_VERSION}:${(market ?? "").toLowerCase()}:${symbol.trim().toUpperCase()}`;

/** 判断市场：优先用户选择，其次从代码后缀推断 */
export function inferMarket(symbol: string, marketHint?: string | null, classHint?: string | null): string {
	if (marketHint) return marketHint.toLowerCase();
	const upper = symbol.trim().toUpperCase();
	if (classHint === "crypto") return "crypto";
	if (upper.endsWith(".HK")) return "hk";
	if (upper.endsWith(".SS") || upper.endsWith(".SZ")) return "cn";
	if (upper.endsWith("-USD") || upper.endsWith("USDT")) return "crypto";
	return "us";
}

/** 从 Yahoo 的 quoteType 映射到本应用的资产类别 */
function mapQuoteType(quoteType: string | undefined, market: string): LookupCandidate["class"] {
	switch ((quoteType ?? "").toUpperCase()) {
		case "ETF":
			return "etf";
		case "MUTUALFUND":
			return "fund";
		case "CRYPTOCURRENCY":
			return "crypto";
		default:
			return market === "crypto" ? "crypto" : "stock";
	}
}

async function fetchJson(fetcher: FetchContext["fetcher"], url: string, timeoutMs = 8_000): Promise<unknown> {
	const response = await fetcher(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
		error.status = response.status;
		throw error;
	}
	return response.json();
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 加密：CoinGecko 搜索 → 候选列表 + 价格 */
async function lookupCrypto(
	symbol: string,
	fetcher: FetchContext["fetcher"],
	errors: string[],
): Promise<LookupCandidate[]> {
	const query = symbol.trim().toLowerCase();
	const candidates: LookupCandidate[] = [];

	// 内置映射给出"大概率正确的 id"，但仍然搜一次以拿到正式名称（结果会缓存 24h）
	const mappedId = COINGECKO_IDS[query.toUpperCase()];
	try {
		const search = await fetchJson(fetcher, `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
		const coins = isRecordLike(search) && Array.isArray(search.coins) ? search.coins : [];
		for (const raw of coins.slice(0, 5)) {
			if (!isRecordLike(raw)) continue;
			const id = typeof raw.id === "string" ? raw.id : null;
			const name = typeof raw.name === "string" ? raw.name : null;
			const ticker = typeof raw.symbol === "string" ? raw.symbol.toUpperCase() : null;
			if (!id || !name || !ticker) continue;
			candidates.push({
				symbol: id,
				name,
				price: null,
				currency: "USD",
				source: "coingecko",
				market: "crypto",
				class: "crypto",
			});
		}
	} catch (error) {
		errors.push(`CoinGecko 搜索失败：${error instanceof Error ? error.message : "网络错误"}`);
	}

	// 内置映射命中的排到最前（用户输入 BTC 时优先给 bitcoin，而不是搜索结果里的别的币）
	if (mappedId) {
		const index = candidates.findIndex((item) => item.symbol === mappedId);
		if (index > 0) {
			const [hit] = candidates.splice(index, 1);
			candidates.unshift(hit);
		} else if (index === -1) {
			candidates.unshift({
				symbol: mappedId,
				name: query.toUpperCase(),
				price: null,
				currency: "USD",
				source: "coingecko",
				market: "crypto",
				class: "crypto",
			});
		}
	}

	// 给前几个候选取价（一次批量请求）
	const ids = candidates.slice(0, 4).map((item) => item.symbol);
	if (ids.length > 0) {
		try {
			const prices = await fetchJson(
				fetcher,
				`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
			);
			if (isRecordLike(prices)) {
				for (const candidate of candidates) {
					const entry = prices[candidate.symbol];
					const price = isRecordLike(entry) ? Number(entry.usd) : Number.NaN;
					if (Number.isFinite(price) && price > 0) candidate.price = price;
				}
			}
		} catch (error) {
			errors.push(`CoinGecko 取价失败：${error instanceof Error ? error.message : "网络错误"}`);
		}
	}

	return candidates;
}

/**
 * 判断一个代码是否属于目标市场。
 * 起因：搜 "700" 时 Yahoo 会返回加拿大基金 MFSTX 之类的噪音，
 * 如果不按市场过滤，用户就会看到完全错误的标的。
 */
export function matchesMarket(ticker: string, market: string): boolean {
	const upper = ticker.toUpperCase();
	if (market === "hk") return upper.endsWith(".HK");
	if (market === "cn") return upper.endsWith(".SS") || upper.endsWith(".SZ");
	if (market === "crypto") return upper.endsWith("-USD") || upper.endsWith("USDT");
	// 美股：排除其它交易所后缀
	return !/\.(HK|SS|SZ|TO|V|L|T|DE|PA|AS|AX|SI|KS|KQ|TW|TWO|BK|MX|SA|JO|IS|ST|CO|HE|LS|VI|IR|F|SW)$/i.test(upper);
}

/**
 * 这个"名称"其实只是代码本身吗（占位值）？
 *
 * 推导出的候选先占个位，名字暂时填查询词；搜索到同代码的正式名称后要替换掉它。
 * 判等要覆盖 "03121"、"3121.HK"、"3121" 这几种写法，否则占位名会被当成真名字
 * 填进表单的「名称」框，而且填过一次之后就不再更新了。
 */
export function isPlaceholderName(name: string, query: string, symbol: string): boolean {
	const value = name.trim().toUpperCase();
	if (!value) return true;
	return [query, symbol, symbol.replace(/\.[A-Z]+$/i, "")].some(
		(candidate) => candidate.trim().toUpperCase() === value,
	);
}

/** 股票 / ETF / 基金：先按市场规则推导代码，再用 Yahoo 搜索补充候选与正式名称 */
async function lookupStock(
	symbol: string,
	market: string,
	fetcher: FetchContext["fetcher"],
	errors: string[],
): Promise<LookupCandidate[]> {
	const candidates: LookupCandidate[] = [];

	// ① 规则推导的代码永远排第一（"700" + hk → 0700.HK），避免被搜索结果带偏
	const derived = yahooSymbol({
		key: "lookup",
		kind: market === "crypto" ? "crypto" : "stock",
		symbol,
		currency: "USD",
		market,
	});
	/** symbol -> 候选；搜索结果若与推导结果同码则合并信息（名称、交易所）而不是覆盖 */
	const bySymbol = new Map<string, LookupCandidate>();
	if (derived && matchesMarket(derived, market)) {
		bySymbol.set(derived, {
			symbol: derived,
			name: symbol.toUpperCase(),
			price: null,
			currency: null,
			source: "yahoo",
			market,
			class: market === "crypto" ? "crypto" : "stock",
		});
	}

	// Yahoo 搜索对港股 5 位代码只会返回别的市场的噪音（q=03121 → 031210.KS / 03121T.TW；
	// q=00005 → 000050.KS / 000050.SZ），要去零成 4 位才搜得到 3121.HK / 0005.HK。
	// 所以搜索词用规则推导出的代码（去掉交易所后缀），而不是用户原样输入的那串。
	const searchTerm = (derived ?? symbol).replace(/\.(HK|SS|SZ|SH)$/i, "");

	try {
		const search = await fetchJson(
			fetcher,
			`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchTerm)}&quotesCount=8&newsCount=0`,
		);
		const quotes = isRecordLike(search) && Array.isArray(search.quotes) ? search.quotes : [];
		for (const raw of quotes) {
			if (!isRecordLike(raw)) continue;
			const ticker = typeof raw.symbol === "string" ? raw.symbol : null;
			const quoteType = typeof raw.quoteType === "string" ? raw.quoteType : undefined;
			if (!ticker) continue;
			if (quoteType && !["EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY"].includes(quoteType.toUpperCase())) continue;
			if (!matchesMarket(ticker, market)) continue;
			const name =
				(typeof raw.longname === "string" && raw.longname) ||
				(typeof raw.shortname === "string" && raw.shortname) ||
				ticker;
			const exchange = typeof raw.exchDisp === "string" ? raw.exchDisp : null;

			const existing = bySymbol.get(ticker);
			if (existing) {
				// 合并：用搜索到的正式名称替换占位名，并补上交易所。
				// 占位名 = 查询词本身或推导出的代码（"03121" / "3121.HK"），
				// 判等要宽松一点，否则占位名会被当成正式名称留在结果里
				if (isPlaceholderName(existing.name, symbol, existing.symbol) && name) existing.name = name;
				if (exchange) existing.exchange = exchange;
				existing.class = mapQuoteType(quoteType, market);
				continue;
			}

			bySymbol.set(ticker, {
				symbol: ticker,
				name,
				price: null,
				currency: null,
				source: "yahoo",
				market: inferMarket(ticker, ticker.endsWith(".HK") ? "hk" : ticker.match(/\.(SS|SZ)$/) ? "cn" : market),
				class: mapQuoteType(quoteType, market),
				exchange,
			});
		}
	} catch (error) {
		errors.push(`Yahoo 搜索失败：${error instanceof Error ? error.message : "网络错误"}`);
	}

	candidates.push(...bySymbol.values());

	// 取价 + 顺便拿官方名称
	const top = candidates.slice(0, 3);
	await Promise.all(
		top.map(async (candidate) => {
			try {
				const chart = await fetchJson(
					fetcher,
					`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(candidate.symbol)}?range=1d&interval=1d`,
				);
				const result =
					isRecordLike(chart) && isRecordLike(chart.chart) && Array.isArray(chart.chart.result)
						? (chart.chart.result[0] as unknown)
						: null;
				const meta = isRecordLike(result) && isRecordLike(result.meta) ? result.meta : null;
				if (!meta) return;
				const price = Number(meta.regularMarketPrice ?? meta.previousClose);
				if (Number.isFinite(price) && price > 0) candidate.price = price;
				if (typeof meta.currency === "string") candidate.currency = meta.currency;
				const officialName =
					(typeof meta.longName === "string" && meta.longName) ||
					(typeof meta.shortName === "string" && meta.shortName);
				if (officialName) candidate.name = officialName;
			} catch (error) {
				errors.push(`${candidate.symbol} 取价失败：${error instanceof Error ? error.message : "网络错误"}`);
			}
		}),
	);

	return candidates;
}

export async function lookupSymbol(
	env: { DB: D1Database; SESSION_SECRET: string },
	input: { symbol: string; market?: string | null; classHint?: string | null; fetcher?: FetchContext["fetcher"]; force?: boolean },
): Promise<LookupResult> {
	const symbol = input.symbol.trim();
	const market = inferMarket(symbol, input.market, input.classHint);
	const errors: string[] = [];
	const key = cacheKey(symbol, market);

	if (!input.force) {
		const cached = await env.DB.prepare(`SELECT payload_json, fetched_at FROM lookup_cache WHERE key = ?`)
			.bind(key)
			.first<{ payload_json: string; fetched_at: string }>();
		if (cached) {
			const age = Date.now() - Date.parse(cached.fetched_at);
			if (Number.isFinite(age) && age < CACHE_TTL_MS) {
				try {
					const candidates = JSON.parse(cached.payload_json) as LookupCandidate[];
					return { symbol, candidates, cached: true, rateLimited: false, errors: [] };
				} catch {
					/* 坏缓存当没有 */
				}
			}
		}
	}

	const fetcher: FetchContext["fetcher"] = input.fetcher ?? ((request, init) => fetch(request, init));
	let candidates: LookupCandidate[] = [];
	let rateLimited = false;

	try {
		candidates = market === "crypto" ? await lookupCrypto(symbol, fetcher, errors) : await lookupStock(symbol, market, fetcher, errors);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : "查询失败");
	}

	rateLimited = errors.some((message) => /429|403|限流/.test(message));

	if (candidates.length === 0 && errors.length === 0) errors.push("没有找到匹配的代码");

	if (candidates.length > 0) {
		await env.DB.prepare(
			`INSERT INTO lookup_cache (key, symbol, market, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
		)
			.bind(key, symbol, market, JSON.stringify(candidates), nowIso())
			.run();
	}

	return { symbol, candidates, cached: false, rateLimited, errors };
}

/** 清理过期缓存（设置页可手动触发；也顺手在拍快照时调用） */
export async function pruneLookupCache(db: D1Database, olderThanMs = CACHE_TTL_MS * 7): Promise<number> {
	const cutoff = new Date(Date.now() - olderThanMs).toISOString();
	const result = await db.prepare(`DELETE FROM lookup_cache WHERE fetched_at < ?`).bind(cutoff).run();
	return result.meta.changes ?? 0;
}

