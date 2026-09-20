import type { BreakdownItem } from "../../shared/api-types";
import { money } from "../lib/format";

export const PALETTE = [
	"#2f6feb",
	"#128a52",
	"#e8590c",
	"#7048e8",
	"#0b7285",
	"#c0392b",
	"#a15c00",
	"#5c7cfa",
	"#37b24d",
	"#f76707",
	"#12b886",
	"#845ef7",
];

export function colorAt(index: number): string {
	return PALETTE[index % PALETTE.length];
}

/**
 * 环形图：手写 SVG（stroke-dasharray 画弧），不引图表库
 * 体积代价 ≈ 0，且天然跟随 CSS 变量与深浅色
 */
export function Donut({ items, currency, size = 260 }: { items: BreakdownItem[]; currency: string; size?: number }) {
	const data = items.filter((item) => item.value > 0);
	const total = data.reduce((sum, item) => sum + item.value, 0);

	if (total <= 0) return <div className="empty">暂无可展示的数据</div>;

	const radius = size / 2 - 14;
	const thickness = 26;
	const circumference = 2 * Math.PI * radius;
	let offset = 0;

	return (
		<div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="资产分布环形图">
				<g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
					{data.map((item, index) => {
						const length = (item.value / total) * circumference;
						const element = (
							<circle
								key={item.key}
								cx={size / 2}
								cy={size / 2}
								r={radius}
								fill="none"
								stroke={colorAt(index)}
								strokeWidth={thickness}
								strokeDasharray={`${Math.max(length - 1.5, 0.5)} ${circumference - Math.max(length - 1.5, 0.5)}`}
								strokeDashoffset={-offset}
							>
								<title>{`${item.label}：${money(item.value, currency)}（${item.share.toFixed(1)}%）`}</title>
							</circle>
						);
						offset += length;
						return element;
					})}
				</g>
				<text
					x="50%"
					y="47%"
					textAnchor="middle"
					fontSize="12"
					fill="currentColor"
					opacity="0.6"
				>
					总额
				</text>
				<text x="50%" y="58%" textAnchor="middle" fontSize="16" fontWeight="600" fill="currentColor">
					{money(total, currency, 0)}
				</text>
			</svg>

			<ul style={{ listStyle: "none", margin: 0, padding: 0, flex: 1, minWidth: 180 }}>
				{data.map((item, index) => (
					<li
						key={item.key}
						style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13 }}
					>
						<span
							style={{
								width: 10,
								height: 10,
								borderRadius: 3,
								background: colorAt(index),
								flex: "none",
							}}
						/>
						<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
							{item.label}
						</span>
						<span className="muted small">{item.share.toFixed(1)}%</span>
						<span style={{ fontVariantNumeric: "tabular-nums" }}>{money(item.value, currency, 0)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

interface TreemapNode {
	name: string;
	value: number;
	children?: Array<{ name: string; value: number }>;
}

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** squarified treemap：尽量让每块接近正方形。坐标用 0~100 百分比，便于响应式 */
function worstRatio(row: number[], sum: number, short: number): number {
	const max = Math.max(...row);
	const min = Math.min(...row);
	return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
}

function squarify(values: number[], width = 100, height = 100): Rect[] {
	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return [];
	const area = width * height;
	const scaled = values.map((value) => (value / total) * area);

	const rects: Rect[] = [];
	let x = 0;
	let y = 0;
	let w = width;
	let h = height;
	let index = 0;

	while (index < scaled.length) {
		const vertical = w >= h;
		const short = vertical ? h : w;
		let row: number[] = [];
		let sum = 0;
		let best = Number.POSITIVE_INFINITY;
		let next = index;

		while (next < scaled.length) {
			const candidate = row.concat(scaled[next]);
			const candidateSum = sum + scaled[next];
			const worst = worstRatio(candidate, candidateSum, short);
			if (worst > best && row.length > 0) break;
			best = worst;
			row = candidate;
			sum = candidateSum;
			next += 1;
		}

		const thickness = sum / short;
		if (vertical) {
			let oy = y;
			for (const value of row) {
				const size = value / thickness;
				rects.push({ x, y: oy, w: thickness, h: size });
				oy += size;
			}
			x += thickness;
			w -= thickness;
		} else {
			let ox = x;
			for (const value of row) {
				const size = value / thickness;
				rects.push({ x: ox, y, w: size, h: thickness });
				ox += size;
			}
			y += thickness;
			h -= thickness;
		}
		index = next;
	}

	return rects;
}

/** Treemap：账户 → 标的 的层级占比，手写 div 布局（无图表库） */
export function Treemap({ items, currency }: { items: TreemapNode[]; currency: string }) {
	const groups = items
		.filter((item) => item.value > 0)
		.map((item) => ({ ...item, children: (item.children ?? []).filter((child) => child.value > 0) }))
		.sort((a, b) => b.value - a.value);

	if (groups.length === 0) return <div className="empty">暂无数据</div>;

	const total = groups.reduce((sum, item) => sum + item.value, 0);
	const groupRects = squarify(groups.map((item) => item.value));

	const leaves: Array<{ rect: Rect; name: string; value: number; color: string }> = [];
	groups.forEach((group, groupIndex) => {
		const box = groupRects[groupIndex];
		if (!box) return;
		const children = [...group.children].sort((a, b) => b.value - a.value);
		const inner = squarify(children.map((child) => child.value), box.w, box.h);
		children.forEach((child, childIndex) => {
			const innerRect = inner[childIndex];
			if (!innerRect) return;
			leaves.push({
				rect: {
					x: box.x + innerRect.x,
					y: box.y + innerRect.y,
					w: innerRect.w,
					h: innerRect.h,
				},
				name: child.name,
				value: child.value,
				color: colorAt(groupIndex),
			});
		});
	});

	return (
		<div>
			<div
				style={{
					position: "relative",
					width: "100%",
					height: 340,
					borderRadius: 8,
					overflow: "hidden",
					background: "var(--surface-2)",
				}}
			>
				{leaves.map((leaf, index) => {
					const wide = leaf.rect.w > 9 && leaf.rect.h > 9;
					return (
						<div
							key={`${leaf.name}-${index}`}
							title={`${leaf.name}：${money(leaf.value, currency)}（${((leaf.value / total) * 100).toFixed(1)}%）`}
							style={{
								position: "absolute",
								left: `${leaf.rect.x}%`,
								top: `${leaf.rect.y}%`,
								width: `${leaf.rect.w}%`,
								height: `${leaf.rect.h}%`,
								background: leaf.color,
								opacity: 0.86,
								border: "1px solid var(--surface)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								overflow: "hidden",
								color: "#fff",
								fontSize: 11,
								padding: 2,
								textAlign: "center",
							}}
						>
							{wide ? leaf.name : ""}
						</div>
					);
				})}
			</div>
			<div className="row small muted" style={{ marginTop: 10 }}>
				{groups.map((group, index) => (
					<span key={group.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
						<span style={{ width: 10, height: 10, borderRadius: 3, background: colorAt(index) }} />
						{group.name} · {money(group.value, currency, 0)}
					</span>
				))}
			</div>
		</div>
	);
}
