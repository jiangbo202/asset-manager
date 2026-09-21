import type { Translator } from "../shared/i18n";

/** 前后端共用的枚举与标签（标签通过 i18n 取，语言由调用方决定） */

export const ASSET_CLASSES = ["stock", "etf", "crypto", "fund", "cash"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ACCOUNT_KINDS = ["broker", "exchange", "cash"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const MARKETS = ["us", "hk", "cn", "crypto", "other"] as const;
export type Market = (typeof MARKETS)[number];

/**
 * 市场筛选是否命中一条持仓。
 *
 * 特别处：「加密」这个选项**同时**匹配资产类别为加密货币的持仓。
 * 因为代币化股票（如 SPCXB-USD）的市场字段是 `us`（它的标的在美股），
 * 但用户在「市场」行点「加密」时想看的是自己的加密资产——否则会得到"没有数据"。
 * 服务端在 SQL 里表达了同一条规则（data/accounts.repo.ts 的 holdingsStatement），
 * 两者的一致性由 tests/api/market-filter.test.ts 盯住。
 */
export function matchesMarketFilter(
	holding: { market: string | null; class: string },
	markets: readonly string[],
): boolean {
	if (markets.length === 0) return true;
	if (holding.market !== null && markets.includes(holding.market)) return true;
	return markets.includes("crypto") && holding.class === "crypto";
}

/**
 * 港股代码统一为港交所的 5 位写法（含前导零）。
 *
 * `700` / `0700` / `3121` → `00700` / `00700` / `03121`，带 `.HK` 后缀的先剥掉后缀。
 * 港交所公布的一律是 5 位，券商对账单、港股通、腾讯行情也都是 5 位；
 * 4 位是 Yahoo 的内部格式，只在请求它时临时转换（worker 的 hkYahooCode）。
 * 已经是 5 位（含 8 开头的人民币柜台 80737）或非纯数字的，保持原样。
 */
export function normalizeHkSymbol(value: string): string {
	const bare = (value ?? "").trim().replace(/\.HK$/i, "");
	return /^\d{1,4}$/.test(bare) ? bare.padStart(5, "0") : bare;
}

/** 资产类别标签：class.stock / class.etf … */
export function classLabel(t: Translator, value: string): string {
	return t(`class.${value}`);
}

/** 账户类型标签：kind.broker / kind.exchange / kind.cash */
export function kindLabel(t: Translator, value: string): string {
	return t(`kind.${value}`);
}

/** 市场标签：mkt.us / mkt.hk … */
export function marketLabel(t: Translator, value: string): string {
	return t(`mkt.${value}`);
}

/** 汇率相关：常见币种符号（与语言无关） */
export const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: "$",
	HKD: "HK$",
	CNY: "¥",
	EUR: "€",
	JPY: "¥",
	GBP: "£",
	SGD: "S$",
};

export function currencySymbol(currency: string): string {
	return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}
