import type { BreakdownItem } from "../../shared/api-types";
import { money } from "../lib/format";
import { useT } from "./i18n";

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
 * 点击扇区可下钻筛选（FR-6.1 联动）
 */
export function Donut({
	items,
	currency,
	size = 240,
	activeKey,
	onSelect,
}: {
	items: BreakdownItem[];
	currency: string;
	size?: number;
	activeKey?: string | null;
	onSelect?: (key: string) => void;
}) {
	const t = useT();
	const data = items.filter((item) => item.value > 0);
	const total = data.reduce((sum, item) => sum + item.value, 0);

	if (total <= 0) return <div className="empty">{t("dashboard.noData")}</div>;

	const radius = size / 2 - 14;
	const thickness = 26;
	const circumference = 2 * Math.PI * radius;
	let offset = 0;

	return (
		<div className="donut-layout">
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="资产分布环形图">
				<g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
					{data.map((item, index) => {
						const length = (item.value / total) * circumference;
						const dash = Math.max(length - 1.5, 0.5);
						const dimmed = activeKey != null && activeKey !== item.key;
						const element = (
							<circle
								key={item.key}
								cx={size / 2}
								cy={size / 2}
								r={radius}
								fill="none"
								stroke={colorAt(index)}
								strokeWidth={activeKey === item.key ? thickness + 6 : thickness}
								opacity={dimmed ? 0.35 : 1}
								strokeDasharray={`${dash} ${circumference - dash}`}
								strokeDashoffset={-offset}
								style={onSelect ? { cursor: "pointer" } : undefined}
								onClick={onSelect ? () => onSelect(item.key) : undefined}
							>
								<title>{`${item.label}：${money(item.value, currency)}（${item.share.toFixed(1)}%）`}</title>
							</circle>
						);
						offset += length;
						return element;
					})}
				</g>
				<text x="50%" y="46%" textAnchor="middle" fontSize="12" fill="currentColor" opacity="0.6">
					{t("common.total")}
				</text>
				<text x="50%" y="57%" textAnchor="middle" fontSize="16" fontWeight="600" fill="currentColor">
					{money(total, currency, 0)}
				</text>
			</svg>

			<ul className="legend">
				{data.map((item, index) => (
					<li key={item.key}>
						<button
							type="button"
							className={`legend-row ${activeKey === item.key ? "on" : ""}`}
							onClick={onSelect ? () => onSelect(item.key) : undefined}
							disabled={!onSelect}
						>
							<span className="swatch" style={{ background: colorAt(index) }} />
							<span className="legend-name">{item.label}</span>
							<span className="muted small">{item.share.toFixed(1)}%</span>
							<span className="legend-value">{money(item.value, currency, 0)}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

export interface TreemapNode {
	key: string;
	name: string;
	value: number;
	children?: Array<{
		key: string;
		name: string;
		value: number;
		/**
		 * 鼠标悬停时的完整说明（可以用 \n 换行）。
		 * 方块上写不下那么多字（小方块只显示 name），所以两者分开：
		 * name 是"能认出来这是哪一块"，title 是"完整信息"。
		 */
		title?: string;
	}>;
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

/**
 * Treemap：账户 → 标的 的层级占比，手写 div 布局（无图表库）
 * 点击方块可下钻到该账户（colorByChild 时按标的着色）
 */
export function Treemap({
	items,
	currency,
	height = 320,
	colorByChild = false,
	onSelect,
}: {
	items: TreemapNode[];
	currency: string;
	height?: number;
	colorByChild?: boolean;
	onSelect?: (groupKey: string) => void;
}) {
	const t = useT();
	const groups = items
		.filter((item) => item.value > 0)
		.map((item) => ({ ...item, children: (item.children ?? []).filter((child) => child.value > 0) }))
		.sort((a, b) => b.value - a.value);

	if (groups.length === 0) return <div className="empty">{t("dashboard.noData")}</div>;

	const total = groups.reduce((sum, item) => sum + item.value, 0);
	const groupRects = squarify(groups.map((item) => item.value));

	const leaves: Array<{
		rect: Rect;
		name: string;
		/** 自定义悬停说明（多行）；没给就用"名称：金额（占比）" */
		title?: string;
		value: number;
		color: string;
		groupKey: string;
	}> = [];
	groups.forEach((group, groupIndex) => {
		const box = groupRects[groupIndex];
		if (!box) return;
		const children = [...group.children].sort((a, b) => b.value - a.value);
		const inner = squarify(children.map((child) => child.value), box.w, box.h);
		children.forEach((child, childIndex) => {
			const innerRect = inner[childIndex];
			if (!innerRect) return;
			leaves.push({
				rect: { x: box.x + innerRect.x, y: box.y + innerRect.y, w: innerRect.w, h: innerRect.h },
				name: child.name,
				title: child.title,
				value: child.value,
				color: colorByChild ? colorAt(childIndex) : colorAt(groupIndex),
				groupKey: group.key,
			});
		});
	});

	return (
		<div>
			<div className="treemap" style={{ height }}>
				{leaves.map((leaf, index) => {
					const wide = leaf.rect.w > 9 && leaf.rect.h > 9;
					return (
						<div
							key={`${leaf.groupKey}-${leaf.name}-${index}`}
							className="treemap-cell"
							title={
								leaf.title ??
								`${leaf.name}：${money(leaf.value, currency)}（${((leaf.value / total) * 100).toFixed(1)}%）`
							}
							style={{
								left: `${leaf.rect.x}%`,
								top: `${leaf.rect.y}%`,
								width: `${leaf.rect.w}%`,
								height: `${leaf.rect.h}%`,
								background: leaf.color,
								cursor: onSelect ? "pointer" : undefined,
							}}
							onClick={onSelect ? () => onSelect(leaf.groupKey) : undefined}
						>
							{wide ? leaf.name : ""}
						</div>
					);
				})}
			</div>
			<div className="treemap-legend">
				{groups.map((group, index) => (
					<button
						key={group.key}
						type="button"
						className="legend-row"
						onClick={onSelect ? () => onSelect(group.key) : undefined}
						disabled={!onSelect}
					>
						<span className="swatch" style={{ background: colorByChild ? "var(--muted)" : colorAt(index) }} />
						<span className="legend-name">{group.name}</span>
						<span className="legend-value">{money(group.value, currency, 0)}</span>
					</button>
				))}
			</div>
		</div>
	);
}
