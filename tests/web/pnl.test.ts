import { describe, expect, it } from "vitest";
import { groupPnlPct, pnlPctOf } from "../../src/web/lib/stats";
import { PNL_COLOR_RANGE, PNL_NEUTRAL_COLOR, pnlColor } from "../../src/web/lib/pnl-color";

/**
 * 图表里的浮动盈亏比例（PRD FR-5.x）
 *
 * 两条口径必须钉死，否则图上的数字会骗人：
 *   1. 组级比例 = Σ盈亏 ÷ Σ成本（金额加权）。平均百分比会被小额持仓带偏。
 *   2. 现金 / 未填成本 / 缺汇率 / 不分享明细 → null，界面显示「—」。
 *      "0.0%" 的意思是"真的不赚不亏"，和"我们不知道"是两回事。
 */

const item = (costDisplay: number | null, pnlDisplay: number | null) => ({ costDisplay, pnlDisplay });

/** "rgb(r, g, b)" → [r, g, b] */
const rgb = (color: string): number[] => color.replace(/[^\d, ]/g, "").split(",").map((part) => Number(part.trim()));

describe("分组盈亏比例（口径）", () => {
	it("金额加权：Σ盈亏 ÷ Σ成本", () => {
		// 小额 +1% 与大额 +50%：加权是 5001/10100 ≈ 49.5%，平均会给出 25.5%
		expect(pnlPctOf([item(100, 1), item(10_000, 5_000)])).toBeCloseTo(49.5, 1);
	});

	it("现金与未填成本不进分母（costDisplay 为 null 直接跳过）", () => {
		expect(pnlPctOf([item(null, null), item(100, 20)])).toBeCloseTo(20, 5);
		// 整组都是现金 → 我们不知道盈亏，返回 null 而不是 0
		expect(pnlPctOf([item(null, null)])).toBeNull();
		expect(pnlPctOf([])).toBeNull();
	});

	it("缺汇率（折算后为 null）的持仓不参与，不会把比例算错", () => {
		expect(pnlPctOf([item(null, 999), item(200, -20)])).toBeCloseTo(-10, 5);
	});

	it("成本为 0 时返回 null（不能除以 0 得到 Infinity）", () => {
		expect(pnlPctOf([item(0, 5)])).toBeNull();
	});

	it("按维度分组：key 为 null 的持仓不参与该维度", () => {
		const holdings = [
			{ class: "stock", costDisplay: 100, pnlDisplay: 10 },
			{ class: "stock", costDisplay: 100, pnlDisplay: -30 },
			{ class: "cash", costDisplay: null, pnlDisplay: null },
		];
		const byClass = groupPnlPct(holdings, (row) => row.class);
		expect(byClass.get("stock")).toBeCloseTo(-10, 5); // (-30+10)/200
		expect(byClass.get("cash")).toBeNull(); // 现金组：不知道盈亏
		expect(groupPnlPct(holdings, () => null).size).toBe(0);
	});
});

describe("盈亏色阶", () => {
	it("红亏绿赚：正数的绿色通道占优，负数红色通道占优", () => {
		const up = rgb(pnlColor(10));
		const down = rgb(pnlColor(-10));
		expect(up[1]).toBeGreaterThan(up[0]);
		expect(down[0]).toBeGreaterThan(down[1]);
	});

	it("0% 与「不知道」（null）都是中性色，但都不等于赚钱的绿", () => {
		expect(pnlColor(0)).toBe(PNL_NEUTRAL_COLOR);
		expect(pnlColor(null)).toBe(PNL_NEUTRAL_COLOR);
		expect(pnlColor(undefined)).toBe(PNL_NEUTRAL_COLOR);
		expect(pnlColor(Number.NaN)).toBe(PNL_NEUTRAL_COLOR);
		expect(pnlColor(0)).not.toBe(pnlColor(30));
	});

	it("超出 ±30% 被钳住：+227% 不会比 +30% 更绿（否则一两个大赢家会把图刷成一片绿）", () => {
		expect(pnlColor(227)).toBe(pnlColor(PNL_COLOR_RANGE));
		expect(pnlColor(-80)).toBe(pnlColor(-PNL_COLOR_RANGE));
	});

	it("越赚越绿：颜色随比例单调变化", () => {
		const at5 = rgb(pnlColor(5));
		const at20 = rgb(pnlColor(20));
		expect(at20[1]).toBeGreaterThan(at5[1]);
		expect(at20[0]).toBeLessThan(at5[0]);
	});
});
