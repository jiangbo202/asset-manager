import type { Translator } from "../../shared/i18n";
import { currencySymbol } from "../../shared/labels";

/** 数字格式跟随界面语言（浏览器自带的 locale 映射） */
function locale(): string {
	if (typeof navigator === "undefined") return "zh-CN";
	return (navigator.language ?? "zh-CN").startsWith("zh") ? "zh-CN" : "en-US";
}

/** 金额：带币种符号，千分位，默认 2 位小数 */
export function money(value: number | null | undefined, currency: string, digits = 2): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const formatted = value.toLocaleString(locale(), {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
	return `${currencySymbol(currency)}${formatted}`;
}

export function number(value: number | null | undefined, digits = 4): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return value.toLocaleString(locale(), { maximumFractionDigits: digits });
}

export function percent(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)}%`;
}

export function signedMoney(value: number | null | undefined, currency: string, digits = 2): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const sign = value > 0 ? "+" : value < 0 ? "-" : "";
	return `${sign}${money(Math.abs(value), currency, digits)}`;
}

export function signedPercent(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(digits)}%`;
}

export function trendClass(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "muted";
	return value > 0 ? "positive" : "negative";
}

export function dateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(locale(), { hour12: false });
}

export function dateOnly(iso: string | null | undefined): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleDateString(locale());
}

/** 相对时间：用于"价格最后更新" */
export function relativeDays(t: Translator, days: number | null | undefined): string {
	if (days === null || days === undefined) return t("time.never");
	if (days <= 0) return t("time.today");
	if (days === 1) return t("time.yesterday");
	return t("time.daysAgo", { days });
}

export function stalenessClass(days: number | null | undefined): string {
	if (days === null || days === undefined) return "warn";
	return days > 7 ? "warn" : "";
}
