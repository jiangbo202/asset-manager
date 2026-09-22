import type { PortfolioHolding } from "../../shared/api-types";
import type { Translator } from "../../shared/i18n";
import { money } from "./format";

/**
 * 输出结构（与 charts.tsx 的 TreemapNode 一致）。
 * 这里独立声明而不 import 图表模块：这个纯数据模块不该依赖 .tsx ——
 * 测试用的 tsconfig 没开 jsx，一旦把 React 文件拉进类型检查就会报 TS6142。
 * 两边结构不一致时，Dashboard 里传给 `<Treemap>` 的那一处会直接编译失败，所以不会悄悄漂移。
 */
export interface TreemapItem {
	key: string;
	name: string;
	value: number;
	children?: Array<{ key: string; name: string; value: number; title?: string }>;
}

/**
 * treemap 数据组装（纯函数，便于单测）
 *
 * 两种模式：
 *  分开（默认）：外层 = 账户、内层 = 标的。标签带上账户名，因为同一个标的
 *               （例如 RKLB）在多个券商时，光靠颜色分不清哪一块属于谁；
 *               但现金这类本身就叫"嘉信现金"的持仓不再叠一次前缀。
 *  合并：一个标的 = 一整块，金额是各账户相加；账户明细放进悬停提示（多行）。
 *
 * 放在这里而不是组件里，是因为这段逻辑反复改过：它是纯数据变换，
 * 用单测盯住比每次靠肉眼在页面上验证可靠得多。
 */

export type TreemapHolding = Pick<
	PortfolioHolding,
	"id" | "accountId" | "accountName" | "symbol" | "name" | "marketValueDisplay"
>;

/** 组内只有一个子块时，它正好铺满整组（squarify 的行为），于是"合并成一块"成立 */
function mergedChild(label: string, value: number, title: string, key: string): TreemapItem["children"] {
	return [{ key, name: label, value: Number(value.toFixed(2)), title }];
}

export function buildTreemapItems(
	options: { holdings: TreemapHolding[]; currency: string; mergeSymbols: boolean; zoom?: string },
	t: Translator,
): TreemapItem[] {
	const usable = options.holdings.filter(
		(holding) =>
			holding.marketValueDisplay !== null && (!options.zoom || holding.accountId === options.zoom),
	);

	if (options.mergeSymbols) {
		const bySymbol = new Map<
			string,
			{ label: string; value: number; parts: Array<{ accountName: string; value: number }> }
		>();
		let grandTotal = 0;
		for (const holding of usable) {
			const value = holding.marketValueDisplay as number;
			const label = holding.symbol ?? holding.name;
			const entry = bySymbol.get(label) ?? { label, value: 0, parts: [] };
			entry.value += value;
			entry.parts.push({ accountName: holding.accountName, value });
			bySymbol.set(label, entry);
			grandTotal += value;
		}

		const percentOf = (value: number) => (grandTotal > 0 ? ((value / grandTotal) * 100).toFixed(1) : "0.0");
		return [...bySymbol.values()]
			.map((entry) => {
				// 多行提示：总额一行，之后每个账户一行（按金额降序）
				const title = [
					t("dashboard.treemapTotalLine", {
						name: entry.label,
						value: money(entry.value, options.currency),
						percent: percentOf(entry.value),
					}),
					...[...entry.parts]
						.sort((a, b) => b.value - a.value)
						.map((part) =>
							t("dashboard.treemapAccountLine", {
								name: part.accountName,
								value: money(part.value, options.currency),
								percent: percentOf(part.value),
							}),
						),
				].join("\n");

				return {
					key: `symbol:${entry.label}`,
					name: entry.label,
					value: Number(entry.value.toFixed(2)),
					children: mergedChild(entry.label, entry.value, title, `merged:${entry.label}`),
				};
			})
			.sort((a, b) => b.value - a.value);
	}

	const groups = new Map<string, TreemapItem>();
	for (const holding of usable) {
		const value = holding.marketValueDisplay as number;
		const group = groups.get(holding.accountId) ?? {
			key: holding.accountId,
			name: holding.accountName,
			value: 0,
			children: [],
		};
		const label = holding.symbol ?? holding.name;
		// 只有"标的代码"才需要账户前缀；名字里已含账户名的（现金等）不再叠
		const needsPrefix = Boolean(holding.symbol) && !label.startsWith(holding.accountName);
		group.children?.push({
			key: holding.id,
			name: needsPrefix ? `${holding.accountName} ${label}` : label,
			title: `${holding.accountName} · ${label}`,
			value: Number(value.toFixed(2)),
		});
		group.value += value;
		groups.set(holding.accountId, group);
	}

	return [...groups.values()]
		.map((group) => ({
			...group,
			value: Number(group.value.toFixed(2)),
			children: (group.children ?? []).sort((a, b) => b.value - a.value),
		}))
		.sort((a, b) => b.value - a.value);
}

/* ── 单元格标签排版 ─────────────────────────────────────────── */

/** 字号下限：再小就没人看得清，不如不显示（悬停提示仍然有） */
export const TREEMAP_MIN_FONT = 8.5;
/** 字号上限：格子很大时也不要用大字，避免和页面其它文字脱节 */
export const TREEMAP_MAX_FONT = 12;

/**
 * 估算一段文字的宽度（单位 em）：中日韩字符约 1em，其余约 0.56em。
 * 只用来判断"放不放得下"，不需要精确。
 */
export function textWidthEm(text: string): number {
	let units = 0;
	for (const char of text) units += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? 1 : 0.56;
	return units;
}

/**
 * 格子里那行标签怎么排：字号随格子大小缩放，放不下就不显示。
 *
 * 原因：格子的尺寸是百分比（0–100），字号却是固定的 11px —— 小格子里的
 * "Neverless MSTR" 会溢出、被 overflow: hidden 裁掉半截。这里按格子实际像素
 * 大小算字号：高度够就允许折两行，算出来的字小于 TREEMAP_MIN_FONT 就整块不显示标签。
 */
export function treemapLabel(
	rect: { w: number; h: number },
	container: { width: number; height: number },
	name: string,
): { show: boolean; fontSize: number } {
	const width = (rect.w / 100) * container.width - 6;
	const height = (rect.h / 100) * container.height - 4;
	if (width <= 0 || height <= 0) return { show: false, fontSize: TREEMAP_MIN_FONT };

	// 高度够就允许折成两行，否则只排一行
	const lines = height >= 26 ? 2 : 1;
	const em = Math.max(textWidthEm(name), 1);
	const byWidth = width / (em / lines);
	const byHeight = height / (lines * 1.25);
	const fontSize = Math.min(TREEMAP_MAX_FONT, byWidth, byHeight);
	if (fontSize < TREEMAP_MIN_FONT) return { show: false, fontSize: TREEMAP_MIN_FONT };
	return { show: true, fontSize: Math.round(fontSize * 10) / 10 };
}
