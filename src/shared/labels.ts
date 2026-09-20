import type { Translator } from "../shared/i18n";

/** 前后端共用的枚举与标签（标签通过 i18n 取，语言由调用方决定） */

export const ASSET_CLASSES = ["stock", "etf", "crypto", "fund", "cash"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ACCOUNT_KINDS = ["broker", "exchange", "cash"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const MARKETS = ["us", "hk", "cn", "crypto", "other"] as const;
export type Market = (typeof MARKETS)[number];

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
