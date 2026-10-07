import { useEffect, useRef, useState } from "react";
import type { BreakdownItem } from "../../shared/api-types";
import { money, signedPercent } from "../lib/format";
import { pnlColor } from "./pnl-color";
import { treemapLabel } from "./treemap";
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
	pnlOf,
	pnlPct,
}: {
	items: BreakdownItem[];
	currency: string;
	size?: number;
	activeKey?: string | null;
	onSelect?: (key: string) => void;
	/** 每个分组（class/account/currency/instrument）的盈亏%；null = 拿不到（现金、缺汇率、不分享明细） */
	pnlOf?: (key: string) => number | null;
	/** 整体盈亏%，显示在圆环中心总额下面 */
	pnlPct?: number | null;
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
						const itemPnl = pnlOf?.(item.key) ?? null;
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
								<title>
									{`${item.label}：${money(item.value, currency)}（${item.share.toFixed(1)}%）`}
									{itemPnl === null ? "" : ` · ${signedPercent(itemPnl)}`}
								</title>
							</circle>
						);
						offset += length;
						return element;
					})}
				</g>
				<text x="50%" y="44%" textAnchor="middle" fontSize="12" fill="currentColor" opacity="0.6">
					{t("common.total")}
				</text>
				<text x="50%" y="55%" textAnchor="middle" fontSize="16" fontWeight="600" fill="currentColor">
					{money(total, currency, 0)}
				</text>
				{pnlPct !== null && pnlPct !== undefined && (
					<text x="50%" y="66%" textAnchor="middle" fontSize="12" fill="currentColor" opacity="0.85">
						{signedPercent(pnlPct)}
					</text>
				)}
			</svg>

			<ul className="legend">
				{data.map((item, index) => {
					const itemPnl = pnlOf?.(item.key) ?? null;
					return (
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
								{itemPnl !== null && (
									<span className={`small ${itemPnl > 0 ? "positive" : itemPnl < 0 ? "negative" : "muted"}`}>
										{signedPercent(itemPnl)}
									</span>
								)}
								<span className="legend-value">{money(item.value, currency, 0)}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export interface TreemapNode {
	key: string;
	name: string;
	value: number;
	/** 该组的盈亏%（Σ盈亏÷Σ成本）；null = 拿不到（现金、缺汇率、不分享明细） */
	pnlPct?: number | null;
	children?: Array<{
		key: string;
		name: string;
		value: number;
		/** 该块的盈亏%（单条持仓，或合并后的整个标的） */
		pnlPct?: number | null;
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
	showPnl = false,
	onSelect,
}: {
	items: TreemapNode[];
	currency: string;
	height?: number;
	colorByChild?: boolean;
	/**
	 * 显示盈亏：色块按盈亏色阶着色（红亏绿赚），图例与悬停带上比例。
	 * 关闭时与加这个功能之前完全一样（按账户/标的配色，不出现任何盈亏数字）——
	 * 图例与悬停提示也必须跟着关，否则会出现「图例里有 %、色块却没按盈亏着色」的错位。
	 */
	showPnl?: boolean;
	onSelect?: (groupKey: string) => void;
}) {
	const t = useT();
	// 格子尺寸是百分比，要算字号就得知道容器实际有多大（宽度随窗口变化）
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [box, setBox] = useState({ width: 640, height });
	useEffect(() => {
		const node = containerRef.current;
		if (!node) return;
		const update = () => setBox({ width: node.clientWidth, height: node.clientHeight });
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(node);
		return () => observer.disconnect();
	}, [height]);

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
		pnlPct: number | null;
	}> = [];
	groups.forEach((group, groupIndex) => {
		const box = groupRects[groupIndex];
		if (!box) return;
		const children = [...group.children].sort((a, b) => b.value - a.value);
		const inner = squarify(children.map((child) => child.value), box.w, box.h);
		children.forEach((child, childIndex) => {
			const innerRect = inner[childIndex];
			if (!innerRect) return;
			// 盈亏色阶优先用块自己的比例（同一账户里也分赚和亏），拿不到才退回组级
			const leafPnl = child.pnlPct ?? group.pnlPct ?? null;
			leaves.push({
				rect: { x: box.x + innerRect.x, y: box.y + innerRect.y, w: innerRect.w, h: innerRect.h },
				name: child.name,
				title: child.title,
				value: child.value,
				color: showPnl ? pnlColor(leafPnl) : colorByChild ? colorAt(childIndex) : colorAt(groupIndex),
				groupKey: group.key,
				pnlPct: leafPnl,
			});
		});
	});

	return (
		<div>
			<div className="treemap" style={{ height }} ref={containerRef}>
				{leaves.map((leaf, index) => {
					// 字号随格子大小缩放；小到放不下就不显示（悬停提示里信息是全的）
					const label = treemapLabel(leaf.rect, box, leaf.name);
					return (
						<div
							key={`${leaf.groupKey}-${leaf.name}-${index}`}
							className="treemap-cell"
							title={
								(leaf.title ??
									`${leaf.name}：${money(leaf.value, currency)}（${((leaf.value / total) * 100).toFixed(1)}%）`) +
								(showPnl && leaf.pnlPct !== null ? ` · ${signedPercent(leaf.pnlPct)}` : "")
							}
							style={{
								left: `${leaf.rect.x}%`,
								top: `${leaf.rect.y}%`,
								width: `${leaf.rect.w}%`,
								height: `${leaf.rect.h}%`,
								background: leaf.color,
								fontSize: `${label.fontSize}px`,
								cursor: onSelect ? "pointer" : undefined,
							}}
							onClick={onSelect ? () => onSelect(leaf.groupKey) : undefined}
						>
							{label.show ? leaf.name : ""}
						</div>
					);
				})}
			</div>
			<div className="treemap-legend">
				{groups.map((group, index) => {
					const groupPnl = group.pnlPct ?? null;
					return (
						<button
							key={group.key}
							type="button"
							className="legend-row"
							onClick={onSelect ? () => onSelect(group.key) : undefined}
							disabled={!onSelect}
						>
							<span
								className="swatch"
								style={{
									background: showPnl ? pnlColor(groupPnl) : colorByChild ? "var(--muted)" : colorAt(index),
								}}
							/>
							<span className="legend-name">{group.name}</span>
							{showPnl && groupPnl !== null && (
								<span className={`small ${groupPnl > 0 ? "positive" : groupPnl < 0 ? "negative" : "muted"}`}>
									{signedPercent(groupPnl)}
								</span>
							)}
							<span className="legend-value">{money(group.value, currency, 0)}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
