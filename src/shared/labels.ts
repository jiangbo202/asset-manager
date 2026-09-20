/** 前后端共用的枚举与中文标签（避免两边各写一份导致不一致） */

export const ASSET_CLASSES = ["stock", "etf", "crypto", "fund", "cash"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const CLASS_LABELS: Record<AssetClass, string> = {
	stock: "股票",
	etf: "ETF",
	crypto: "加密货币",
	fund: "基金",
	cash: "现金",
};

export const ACCOUNT_KINDS = ["broker", "exchange", "cash"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const KIND_LABELS: Record<AccountKind, string> = {
	broker: "券商",
	exchange: "加密平台",
	cash: "现金账户",
};

export const MARKETS = ["us", "hk", "cn", "crypto", "other"] as const;
export type Market = (typeof MARKETS)[number];

export const MARKET_LABELS: Record<Market, string> = {
	us: "美股",
	hk: "港股",
	cn: "A股",
	crypto: "加密",
	other: "其他",
};

/** 汇率相关：常见币种符号，仅用于展示 */
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
