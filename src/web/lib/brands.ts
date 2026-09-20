/**
 * 平台图标：v1 用"内置品牌色 + 首字母"兜底（PRD FR-2.2）
 * 精选 SVG 图标库放在 M1 做，接口保持不变：icon_key 命中则用图标，否则用字母块。
 */

const BRAND_COLORS: Record<string, string> = {
	// 券商 / 银行
	ibkr: "#d81222",
	futu: "#0a84ff",
	tiger: "#ff7a00",
	schwab: "#0b5fa5",
	fidelity: "#4a8f2c",
	hsbc: "#db0011",
	cmb: "#c7000b",
	boc: "#b01f24",
	// 加密平台
	binance: "#f0b90b",
	coinbase: "#0052ff",
	okx: "#111111",
	kraken: "#5741d9",
	bitget: "#00f0ff",
	gate: "#17e6a1",
	bybit: "#f7a600",
	metamask: "#f6851b",
	// 现金 / 其他
	cash: "#2f9e44",
	bank: "#4c6ef5",
};

const FALLBACK_COLORS = [
	"#2f6feb",
	"#128a52",
	"#a15c00",
	"#c0392b",
	"#7048e8",
	"#0b7285",
	"#e8590c",
	"#5c7cfa",
];

function hash(value: string): number {
	let out = 0;
	for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) % 100_000;
	return out;
}

export function brandColor(key: string | null | undefined, name = ""): string {
	const normalized = (key ?? "").toLowerCase();
	if (BRAND_COLORS[normalized]) return BRAND_COLORS[normalized];
	return FALLBACK_COLORS[hash(normalized || name) % FALLBACK_COLORS.length];
}

/** 取首字母：中文取第一个字，英文取首个大写/单词首字母 */
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

export function isColorDark(hex: string): boolean {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return (r * 299 + g * 587 + b * 114) / 1000 < 150;
}
