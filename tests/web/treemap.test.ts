import { describe, expect, it } from "vitest";
import { buildTreemapItems, pnlSummary, textWidthEm, treemapLabel } from "../../src/web/lib/treemap";
import { createTranslator } from "../../src/shared/i18n";
import zh from "../../src/shared/locales/zh";

/**
 * treemap 数据组装（纯函数）
 *
 * 这段逻辑反复改过几次（分开/合并、标签是否带账户名、合并后账户明细去哪），
 * 所以用单测把行为固定下来 —— 尤其是这次线上报的那个错：
 * 组件里的 memo 引用了在 early return 之后才声明的变量，导致合并模式一打开就崩。
 * 逻辑搬进纯函数后，这类问题在单测层就能发现。
 */
const t = createTranslator("zh", { zh });

const holding = (
	id: string,
	accountId: string,
	accountName: string,
	symbol: string | null,
	value: number | null,
	extra: { name?: string } = {},
) => ({
	id,
	accountId,
	accountName,
	symbol,
	name: extra.name ?? symbol ?? "现金",
	marketValueDisplay: value,
});

const holdings = [
	holding("h1", "a1", "嘉信", "RKLB", 4846),
	holding("h2", "a2", "FirstTrade", "RKLB", 4323),
	holding("h3", "a1", "嘉信", null, 4730, { name: "嘉信现金" }),
	holding("h4", "a1", "嘉信", "SPCX", 4581),
	holding("h5", "a3", "币安", "SPCXB-USD", null), // 缺汇率 → 不计入
];

describe("treemap 数据组装", () => {
	it("分开模式：按账户分组，标的标签带账户名（现金不重复叠）", () => {
		const items = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: false }, t);

		expect(items.map((item) => item.name)).toEqual(["嘉信", "FirstTrade"]); // 按金额降序
		expect(items[0].value).toBeCloseTo(4846 + 4730 + 4581, 2);

		const jiaxin = items[0].children ?? [];
		expect(jiaxin.map((child) => child.name)).toEqual(["嘉信 RKLB", "嘉信现金", "嘉信 SPCX"]);
		// 现金持仓本身已含账户名，不再拼成"嘉信 嘉信现金"
		expect(jiaxin.some((child) => child.name.includes("嘉信 嘉信"))).toBe(false);
		// 桌面端提示用完整信息
		expect(jiaxin[0].title).toBe("嘉信 · RKLB");
	});

	it("合并模式：一个标的只占一块，金额跨账户相加", () => {
		const items = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: true }, t);

		expect(items.map((item) => item.name)).toEqual(["RKLB", "嘉信现金", "SPCX"]);
		const rklb = items[0];
		expect(rklb.value).toBeCloseTo(4846 + 4323, 2);

		// 关键：整组只有一个子块 → 它会铺满整组，视觉上就是"一块"
		expect(rklb.children).toHaveLength(1);
		expect(rklb.children?.[0].name).toBe("RKLB");
		expect(rklb.children?.[0].value).toBeCloseTo(9169, 2);
	});

	it("合并模式：悬停提示是多行，总额在前、各账户在后（按金额降序）", () => {
		const items = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: true }, t);
		const title = items[0].children?.[0].title ?? "";
		const lines = title.split("\n");

		expect(lines).toHaveLength(3); // 总额 + 两个账户
		expect(lines[0]).toContain("RKLB 合计");
		expect(lines[0]).toContain("$9,169");
		expect(lines[0]).toContain("%");
		// 嘉信(4846) 比 FirstTrade(4323) 大，排前面
		expect(lines[1]).toContain("嘉信");
		expect(lines[2]).toContain("FirstTrade");

		// 单个账户持有的标的：提示里也只有一行明细
		const spcx = items.find((item) => item.name === "SPCX");
		expect((spcx?.children?.[0].title ?? "").split("\n")).toHaveLength(2);
	});

	it("缺少汇率折算的持仓不进图（不能把 null 当 0）", () => {
		const merged = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: true }, t);
		expect(merged.some((item) => item.name === "SPCXB-USD")).toBe(false);
	});

	it("下钻（zoom）只统计该账户，两种模式都成立", () => {
		const split = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: false, zoom: "a2" }, t);
		expect(split).toHaveLength(1);
		expect(split[0].name).toBe("FirstTrade");

		const merged = buildTreemapItems({ holdings, currency: "USD", mergeSymbols: true, zoom: "a2" }, t);
		expect(merged.map((item) => item.name)).toEqual(["RKLB"]);
		expect(merged[0].value).toBeCloseTo(4323, 2);
	});
});

/* ── 格子标签排版（用户反馈：小格子里文字溢出） ─────────────── */

describe("treemap 单元格标签", () => {
	const box = { width: 800, height: 320 };

	it("大格子用上限字号，小格子按尺寸缩字号", () => {
		const big = treemapLabel({ w: 40, h: 40 }, box, "嘉信 RKLB"); // 320×128
		expect(big.show).toBe(true);
		expect(big.fontSize).toBe(12);

		const small = treemapLabel({ w: 6, h: 8 }, box, "富途 SLDP"); // 48×25.6
		expect(small.show).toBe(true);
		expect(small.fontSize).toBeLessThan(12);
		expect(small.fontSize).toBeGreaterThanOrEqual(8.5);
	});

	it("字号随格子变小而单调不增（宽度受限与高度受限都要成立）", () => {
		const name = "第一信托 RKLB";
		let previous = Number.POSITIVE_INFINITY;
		for (const side of [60, 40, 30, 20, 14, 10]) {
			const label = treemapLabel({ w: side, h: side }, box, name);
			if (!label.show) break;
			expect(label.fontSize).toBeLessThanOrEqual(previous);
			previous = label.fontSize;
		}
	});

	it("放不下就整块不显示标签（而不是裁掉半截字）", () => {
		expect(treemapLabel({ w: 2, h: 3 }, box, "Neverless MSTR").show).toBe(false);
		expect(treemapLabel({ w: 1, h: 20 }, box, "众安银行 01810").show).toBe(false);
		expect(treemapLabel({ w: 20, h: 2 }, box, "长桥 SLDP").show).toBe(false);
		// 窄但够高的格子仍然可以显示（会折行）
		expect(treemapLabel({ w: 12, h: 24 }, box, "富途 SLDP").show).toBe(true);
	});

	it("同一个窄格子里：短名字放得下，长名字直接不显示（而不是裁掉半截）", () => {
		const narrow = { w: 6, h: 12 }; // 48 × 38.4
		expect(treemapLabel(narrow, box, "现金").show).toBe(true);
		expect(treemapLabel(narrow, box, "Neverless SPCXB-USD").show).toBe(false);
	});

	it("中文按 1em、西文按 0.56em 估宽", () => {
		expect(textWidthEm("现金")).toBe(2);
		expect(textWidthEm("SLDP")).toBeCloseTo(2.24, 2);
		expect(textWidthEm("嘉信 RKLB")).toBeCloseTo(2 + 0.56 + 2.24, 2);
	});
});

/* ── 浮动盈亏口径 ─────────────────────────────────────────── */

describe("浮动盈亏汇总", () => {
	const row = (
		extra: Partial<{ isCash: boolean; avgCost: number | null; costDisplay: number | null; pnlDisplay: number | null }>,
	) => ({ isCash: false, avgCost: 100, costDisplay: 1000, pnlDisplay: 100, ...extra });

	it("现金不算「未填成本」（用户看到「2 条未填成本」，点进去发现是两笔现金）", () => {
		const summary = pnlSummary([
			row({}),
			row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null }),
			row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null }),
		]);
		expect(summary.missingCostCount).toBe(0);
		// 现金也不参与盈亏比例（口径是"已投入成本"）
		expect(summary.costTotal).toBe(1000);
		expect(summary.pnlPct).toBeCloseTo(10, 6);
	});

	it("非现金没填成本才计数", () => {
		const summary = pnlSummary([row({}), row({ avgCost: null, costDisplay: null, pnlDisplay: null })]);
		expect(summary.missingCostCount).toBe(1);
	});

	it("没有成本时比例是 null（界面显示 —），不是 0% 或 Infinity", () => {
		const summary = pnlSummary([row({ isCash: true, avgCost: null, costDisplay: null, pnlDisplay: null })]);
		expect(summary.pnlPct).toBeNull();
		expect(summary.costTotal).toBe(0);
		expect(summary.pnlTotal).toBe(0);
	});
});
