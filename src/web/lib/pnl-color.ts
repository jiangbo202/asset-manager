/**
 * 盈亏色阶（红 ↔ 中性灰 ↔ 绿）
 *
 * 独立成 .ts 而不是留在 charts.tsx 里：测试用的 tsconfig 没开 jsx，
 * 一旦把 React 文件拉进类型检查就会报 TS6142 —— 这段是纯函数，本来也不该依赖 React。
 */

/** 色阶上下限：±30% 就吃满颜色，再极端的部分钳住（+227% 不需要比 +30% 更绿） */
export const PNL_COLOR_RANGE = 30;

const NEUTRAL: [number, number, number] = [71, 85, 105]; // slate-600：中性
const GAIN: [number, number, number] = [21, 128, 61]; // green-700
const LOSS: [number, number, number] = [185, 28, 28]; // red-700

const mix = (from: [number, number, number], to: [number, number, number], ratio: number): string =>
	`rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * ratio)).join(", ")})`;

/** 中性色（图例里"不知道盈亏"时也用这个） */
export const PNL_NEUTRAL_COLOR = mix(NEUTRAL, NEUTRAL, 0);

/**
 * 盈亏 → 颜色。
 *
 * `null`（现金、未填成本、服务端把明细裁掉了）走中性色，**不当作 0%**：
 * 两者颜色相同，但悬停提示里一个写「—」、一个写「+0.0%」—— 后者才是真的不赚不亏。
 */
export function pnlColor(pct: number | null | undefined): string {
	if (pct === null || pct === undefined || !Number.isFinite(pct) || pct === 0) return PNL_NEUTRAL_COLOR;
	const ratio = Math.min(1, Math.abs(pct) / PNL_COLOR_RANGE);
	return mix(NEUTRAL, pct > 0 ? GAIN : LOSS, ratio);
}
