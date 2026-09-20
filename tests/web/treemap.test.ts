import { describe, expect, it } from "vitest";
import { buildTreemapItems } from "../../src/web/lib/treemap";
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
