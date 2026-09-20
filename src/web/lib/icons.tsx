import type { AccountKind } from "../../shared/labels";
import { useT } from "./i18n";

/** 分组名 → i18n key */
const GROUP_KEYS: Record<string, string> = {
	"券商 / 交易": "iconGroup.brokerTrade",
	加密平台: "iconGroup.exchange",
	"银行 / 现金": "iconGroup.bank",
	通用: "iconGroup.generic",
};

/**
 * 平台图标库（PRD FR-2.2 / D10）
 *
 * 说明：这里**不使用任何官方 logo**——避免商标风险，也避免"图标长得像但不是官方文件"的尴尬。
 * 做法是"品牌色 + 精选字母标"，视觉上整齐可辨；找不到匹配时再用账号名首字母 + 哈希色兜底。
 * 需要真实 logo 的用户可以自己在 v1.x 里上传（icon_data 字段已预留）。
 */

export interface BrandIcon {
	key: string;
	/** 显示名（只用于图标选择器） */
	label: string;
	/** 品牌色 */
	color: string;
	/** 1~3 个字符的字母标 */
	mark: string;
	group: "券商 / 交易" | "加密平台" | "银行 / 现金" | "通用";
}

export const BRAND_ICONS: BrandIcon[] = [
	// ── 券商 / 交易 ─────────────────────────────────────────────
	{ key: "ibkr", label: "盈透证券 IBKR", color: "#d81222", mark: "IB", group: "券商 / 交易" },
	{ key: "futu", label: "富途牛牛", color: "#ff7a00", mark: "富", group: "券商 / 交易" },
	{ key: "tiger", label: "老虎证券", color: "#ff6b00", mark: "虎", group: "券商 / 交易" },
	{ key: "longbridge", label: "长桥 Longbridge", color: "#2b6de5", mark: "长", group: "券商 / 交易" },
	{ key: "webull", label: "微牛 Webull", color: "#3b6ef6", mark: "WB", group: "券商 / 交易" },
	{ key: "schwab", label: "嘉信理财 Schwab", color: "#0b5fa5", mark: "CS", group: "券商 / 交易" },
	{ key: "fidelity", label: "富达 Fidelity", color: "#4a8f2c", mark: "FD", group: "券商 / 交易" },
	{ key: "vanguard", label: "先锋 Vanguard", color: "#96151d", mark: "VG", group: "券商 / 交易" },
	{ key: "etrade", label: "E*TRADE", color: "#6633cc", mark: "ETR", group: "券商 / 交易" },
	{ key: "etoro", label: "eToro", color: "#13c636", mark: "ET", group: "券商 / 交易" },
	{ key: "firstrade", label: "第一证券 Firstrade", color: "#1f6feb", mark: "F", group: "券商 / 交易" },
	{ key: "snowball", label: "雪盈证券", color: "#1e88e5", mark: "雪", group: "券商 / 交易" },
	{ key: "hstong", label: "华盛通", color: "#e53935", mark: "华", group: "券商 / 交易" },
	{ key: "citic", label: "中信证券", color: "#1d4ed8", mark: "信", group: "券商 / 交易" },
	{ key: "htsc", label: "华泰证券", color: "#e11d48", mark: "HT", group: "券商 / 交易" },
	{ key: "cms", label: "招商证券", color: "#c7000b", mark: "招", group: "券商 / 交易" },
	{ key: "gtja", label: "国泰君安", color: "#0f766e", mark: "君", group: "券商 / 交易" },
	{ key: "eastmoney", label: "东方财富", color: "#e60012", mark: "东", group: "券商 / 交易" },
	{ key: "ths", label: "同花顺", color: "#e2231a", mark: "同", group: "券商 / 交易" },
	{ key: "galaxy", label: "中国银河证券", color: "#1e40af", mark: "银", group: "券商 / 交易" },
	{ key: "gf", label: "广发证券", color: "#b91c1c", mark: "广", group: "券商 / 交易" },
	{ key: "pingan", label: "平安证券", color: "#f97316", mark: "平", group: "券商 / 交易" },

	// ── 加密平台 ───────────────────────────────────────────────
	{ key: "binance", label: "币安 Binance", color: "#f0b90b", mark: "BN", group: "加密平台" },
	{ key: "okx", label: "OKX", color: "#101418", mark: "OK", group: "加密平台" },
	{ key: "coinbase", label: "Coinbase", color: "#0052ff", mark: "CB", group: "加密平台" },
	{ key: "kraken", label: "Kraken", color: "#5741d9", mark: "KR", group: "加密平台" },
	{ key: "bybit", label: "Bybit", color: "#f7a600", mark: "BY", group: "加密平台" },
	{ key: "neverless", label: "Neverless", color: "#c6ff4f", mark: "NV", group: "加密平台" },
	{ key: "bitget", label: "Bitget", color: "#00c2a8", mark: "BG", group: "加密平台" },
	{ key: "gate", label: "Gate.io", color: "#17e6a1", mark: "G", group: "加密平台" },
	{ key: "kucoin", label: "KuCoin", color: "#24ae8f", mark: "KC", group: "加密平台" },
	{ key: "htx", label: "HTX / 火币", color: "#1e90ff", mark: "HTX", group: "加密平台" },
	{ key: "mexc", label: "MEXC", color: "#0aa5a0", mark: "MX", group: "加密平台" },
	{ key: "bitfinex", label: "Bitfinex", color: "#16b157", mark: "BF", group: "加密平台" },
	{ key: "gemini", label: "Gemini", color: "#00b0d8", mark: "GE", group: "加密平台" },
	{ key: "robinhood", label: "Robinhood", color: "#00c805", mark: "RH", group: "加密平台" },
	{ key: "metamask", label: "MetaMask 钱包", color: "#f6851b", mark: "MM", group: "加密平台" },
	{ key: "ledger", label: "Ledger 硬件钱包", color: "#2f3542", mark: "LG", group: "加密平台" },
	{ key: "wallet", label: "其他自托管钱包", color: "#7048e8", mark: "钱", group: "加密平台" },

	// ── 银行 / 现金 ────────────────────────────────────────────
	{ key: "hsbc", label: "汇丰银行", color: "#db0011", mark: "HS", group: "银行 / 现金" },
	{ key: "sc", label: "渣打银行", color: "#0072aa", mark: "SC", group: "银行 / 现金" },
	{ key: "bochk", label: "中银香港", color: "#af1e24", mark: "中银", group: "银行 / 现金" },
	{ key: "hangseng", label: "恒生银行", color: "#00a94f", mark: "恒", group: "银行 / 现金" },
	{ key: "cmb", label: "招商银行", color: "#c7000b", mark: "招行", group: "银行 / 现金" },
	{ key: "icbc", label: "工商银行", color: "#e60012", mark: "工行", group: "银行 / 现金" },
	{ key: "ccb", label: "建设银行", color: "#005bac", mark: "建行", group: "银行 / 现金" },
	{ key: "boc", label: "中国银行", color: "#af1e24", mark: "中行", group: "银行 / 现金" },
	{ key: "cash", label: "现金", color: "#2f9e44", mark: "¥", group: "银行 / 现金" },
	{ key: "cash-usd", label: "现金（USD）", color: "#2f9e44", mark: "$", group: "银行 / 现金" },
	{ key: "bank", label: "银行账户", color: "#4c6ef5", mark: "银", group: "银行 / 现金" },

	// ── 通用 ───────────────────────────────────────────────────
	{ key: "broker", label: "券商（通用）", color: "#0b7285", mark: "券", group: "通用" },
	{ key: "exchange", label: "交易所（通用）", color: "#845ef7", mark: "交", group: "通用" },
	{ key: "other", label: "其他", color: "#6b7280", mark: "·", group: "通用" },
];

const ICON_MAP = new Map(BRAND_ICONS.map((icon) => [icon.key, icon]));

const FALLBACK_COLORS = [
	"#2f6feb",
	"#128a52",
	"#e8590c",
	"#7048e8",
	"#0b7285",
	"#c0392b",
	"#a15c00",
	"#5c7cfa",
];

function hashOf(value: string): number {
	let out = 0;
	for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) % 100_000;
	return out;
}

export interface ResolvedIcon {
	color: string;
	mark: string;
	label: string;
}

/** 图标解析：命中内置库用内置，否则用"首字母 + 哈希色"兜底 */
export function resolveIcon(iconKey: string | null | undefined, accountName = ""): ResolvedIcon {
	const key = (iconKey ?? "").trim().toLowerCase();
	const hit = ICON_MAP.get(key);
	if (hit) return { color: hit.color, mark: hit.mark, label: hit.label };
	return {
		color: FALLBACK_COLORS[hashOf(key || accountName) % FALLBACK_COLORS.length],
		mark: initialOf(accountName),
		label: accountName || "未指定",
	};
}

/** 中文取首字；英文取前两个单词首字母 */
export function initialOf(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") return "?";
	const first = [...trimmed][0];
	if (/[a-zA-Z]/.test(first)) {
		const words = trimmed.split(/[\s_-]+/).filter(Boolean);
		if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
		return first.toUpperCase();
	}
	return first;
}

function isDark(hex: string): boolean {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return (r * 299 + g * 587 + b * 114) / 1000 < 150;
}

/** 账号/平台的方形字母图标 */
export function BrandIcon({
	iconKey,
	name,
	size = "md",
}: {
	iconKey: string | null | undefined;
	name: string;
	size?: "sm" | "md" | "lg";
}) {
	const icon = resolveIcon(iconKey, name);
	const className = size === "lg" ? "avatar lg" : size === "sm" ? "avatar sm" : "avatar";
	return (
		<span
			className={className}
			style={{ background: icon.color, color: isDark(icon.color) ? "#fff" : "#101418" }}
			title={icon.label}
		>
			{icon.mark}
		</span>
	);
}

/** 图标选择器：按分组展示，支持关键字过滤 */
export function IconPicker({
	value,
	onChange,
}: {
	value: string | null;
	onChange: (key: string | null) => void;
}) {
	const t = useT();
	const groups = [...new Set(BRAND_ICONS.map((icon) => icon.group))];

	return (
		<div className="icon-picker">
			{groups.map((group) => (
				<div key={group}>
					<div className="small muted" style={{ margin: "8px 0 6px" }}>
						{GROUP_KEYS[group] ? t(GROUP_KEYS[group]) : group}
					</div>
					<div className="icon-grid">
						{BRAND_ICONS.filter((icon) => icon.group === group).map((icon) => (
							<button
								key={icon.key}
								type="button"
								title={icon.label}
								className={`icon-option ${value === icon.key ? "on" : ""}`}
								onClick={() => onChange(value === icon.key ? null : icon.key)}
							>
								<span
									className="avatar sm"
									style={{ background: icon.color, color: isDark(icon.color) ? "#fff" : "#101418" }}
								>
									{icon.mark}
								</span>
							</button>
						))}
					</div>
				</div>
			))}
			<div className="small muted" style={{ marginTop: 8 }}>
				{value
					? t("iconPicker.selected", { label: resolveIcon(value).label })
					: t("iconPicker.none")}
			</div>
		</div>
	);
}

/** 按账户类型给一个默认图标 */
export function defaultIconFor(kind: AccountKind | string): string {
	if (kind === "exchange") return "binance";
	if (kind === "cash") return "cash";
	return "broker";
}
