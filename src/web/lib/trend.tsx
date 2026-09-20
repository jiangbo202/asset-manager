import { useEffect, useRef, useState } from "react";
import type { TrendPoint } from "../../shared/api-types";
import { classLabel } from "../../shared/labels";
import { money } from "./format";
import { useT } from "./i18n";

/**
 * 每日走势图：手写 SVG（面积 + 折线 + 悬浮提示）
 *
 * 保持"零图表库"的纪律（PRD D18）：整包体积只增加几 KB。
 * 支持两种模式：总额面积图 / 按类别堆叠面积图。
 */

function useElementWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(720);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => setWidth(element.clientWidth || 720);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return [ref, width] as const;
}

/** 1.2M / 850K 这样的紧凑数字 */
function compact(value: number, currency: string): string {
	const abs = Math.abs(value);
	const symbol = currency === "USD" ? "$" : currency === "HKD" ? "HK$" : currency === "CNY" ? "¥" : "";
	if (abs >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(0)}K`;
	return `${symbol}${value.toFixed(0)}`;
}

const shortDate = (date: string): string => `${date.slice(5, 7)}/${date.slice(8, 10)}`;

export function TrendChart({
	points,
	currency,
	height = 260,
	stacked = false,
	palette,
}: {
	points: TrendPoint[];
	currency: string;
	height?: number;
	stacked?: boolean;
	palette: string[];
}) {
	const t = useT();
	const [containerRef, width] = useElementWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);

	if (points.length === 0) {
		return <div className="empty">{t("dashboard.trendEmpty")}</div>;
	}

	const padding = { top: 16, right: 12, bottom: 26, left: 54 };
	const innerWidth = Math.max(80, width - padding.left - padding.right);
	const innerHeight = Math.max(60, height - padding.top - padding.bottom);

	// 堆叠模式：按类别分组（取出现过的全部类别，顺序固定，便于颜色稳定）
	const classes = stacked
		? [...new Set(points.flatMap((point) => Object.keys(point.byClass)))].sort()
		: [];
	const classColor = new Map(classes.map((key, index) => [key, palette[index % palette.length]]));

	// 计算每个点的分段值（堆叠时是累计边界）
	const values = points.map((point) => {
		if (!stacked) return { total: point.total, segments: [] as Array<{ key: string; from: number; to: number }> };
		const segments: Array<{ key: string; from: number; to: number }> = [];
		let cursor = 0;
		for (const key of classes) {
			const value = point.byClass[key] ?? 0;
			segments.push({ key, from: cursor, to: cursor + value });
			cursor += value;
		}
		return { total: cursor, segments };
	});

	const maxValue = Math.max(...values.map((item) => item.total), 1);
	const niceMax = maxValue * 1.08;

	const x = (index: number) =>
		padding.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
	const y = (value: number) => padding.top + innerHeight - (value / niceMax) * innerHeight;

	const linePath = values
		.map((item, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(item.total).toFixed(1)}`)
		.join(" ");
	const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${(
		padding.top + innerHeight
	).toFixed(1)} L${x(0).toFixed(1)},${(padding.top + innerHeight).toFixed(1)} Z`;

	// 堆叠面积：从下往上画每一层
	const stackedAreas = stacked
		? classes.map((key, classIndex) => {
				const upper = values
					.map((item, index) => {
						const segment = item.segments[classIndex];
						return `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(segment?.to ?? 0).toFixed(1)}`;
					})
					.join(" ");
				const lower = [...values]
					.reverse()
					.map((item, reversedIndex) => {
						const index = values.length - 1 - reversedIndex;
						const segment = item.segments[classIndex];
						return `L${x(index).toFixed(1)},${y(segment?.from ?? 0).toFixed(1)}`;
					})
					.join(" ");
				return { key, path: `${upper} ${lower} Z` };
			})
		: [];

	// 网格与刻度
	const gridCount = 4;
	const gridLines = Array.from({ length: gridCount + 1 }, (_, index) => {
		const value = (niceMax / gridCount) * index;
		return { value, y: y(value) };
	});

	// x 轴标签：最多 6 个
	const labelStep = Math.max(1, Math.ceil(points.length / 6));
	const xLabels = points.map((point, index) => ({ date: point.date, index })).filter((item) => item.index % labelStep === 0);

	const hoverPoint = hover !== null ? points[hover] : null;
	const hoverValue = hover !== null ? values[hover] : null;

	const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const relative = event.clientX - rect.left - padding.left;
		const ratio = innerWidth === 0 ? 0 : relative / innerWidth;
		const index = Math.round(ratio * (points.length - 1));
		setHover(Math.min(points.length - 1, Math.max(0, index)));
	};

	return (
		<div ref={containerRef} style={{ position: "relative" }}>
			<svg
				width="100%"
				height={height}
				viewBox={`0 0 ${Math.max(width, 240)} ${height}`}
				role="img"
				aria-label="资产走势图"
				onMouseMove={handleMove}
				onMouseLeave={() => setHover(null)}
			>
				<defs>
					<linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={palette[0]} stopOpacity="0.28" />
						<stop offset="100%" stopColor={palette[0]} stopOpacity="0.02" />
					</linearGradient>
				</defs>

				{gridLines.map((line) => (
					<g key={line.value}>
						<line
							x1={padding.left}
							x2={padding.left + innerWidth}
							y1={line.y}
							y2={line.y}
							stroke="var(--border)"
							strokeDasharray="2 4"
						/>
						<text
							x={padding.left - 8}
							y={line.y + 3.5}
							textAnchor="end"
							fontSize="10"
							fill="var(--muted)"
						>
							{compact(line.value, currency)}
						</text>
					</g>
				))}

				{stacked ? (
					stackedAreas.map((area) => (
						<path key={area.key} d={area.path} fill={classColor.get(area.key)} opacity="0.75" />
					))
				) : (
					<>
						<path d={areaPath} fill="url(#trend-fill)" />
						<path d={linePath} fill="none" stroke={palette[0]} strokeWidth="2" strokeLinejoin="round" />
					</>
				)}

				{xLabels.map((item) => (
					<text
						key={item.date}
						x={x(item.index)}
						y={height - 8}
						textAnchor="middle"
						fontSize="10"
						fill="var(--muted)"
					>
						{shortDate(item.date)}
					</text>
				))}

				{hover !== null && hoverValue && (
					<>
						<line
							x1={x(hover)}
							x2={x(hover)}
							y1={padding.top}
							y2={padding.top + innerHeight}
							stroke="var(--accent)"
							strokeDasharray="3 3"
						/>
						{(stacked
							? hoverValue.segments.map((segment) => (
									<circle
										key={segment.key}
										cx={x(hover)}
										cy={y(segment.to)}
										r="2.5"
										fill={classColor.get(segment.key)}
									/>
								))
							: [<circle key="dot" cx={x(hover)} cy={y(hoverValue.total)} r="3.5" fill={palette[0]} />]) as never}
					</>
				)}
			</svg>

			{hoverPoint && hoverValue && (
				<div
					className="chart-tooltip"
					style={{
						left: Math.min(Math.max(x(hover ?? 0) - 80, 0), Math.max(width - 180, 0)),
					}}
				>
					<div className="small muted">
						{hoverPoint.date}
						{hoverPoint.filled && t("dashboard.filledDay")}
					</div>
					<div style={{ fontWeight: 600 }}>{money(hoverValue.total, currency)}</div>
					{stacked &&
						hoverValue.segments
							.filter((segment) => segment.to - segment.from > 0)
							.sort((a, b) => b.to - b.from - (a.to - a.from))
							.map((segment) => (
								<div key={segment.key} className="small" style={{ display: "flex", gap: 6 }}>
									<span className="swatch" style={{ background: classColor.get(segment.key) }} />
									<span style={{ flex: 1 }}>{classLabel(t, segment.key)}</span>
									<span>{money(segment.to - segment.from, currency, 0)}</span>
								</div>
							))}
				</div>
			)}

			{stacked && classes.length > 0 && (
				<div className="treemap-legend" style={{ marginTop: 6 }}>
					{classes.map((key) => (
						<span key={key} className="legend-row" style={{ width: "auto", fontSize: 12 }}>
							<span className="swatch" style={{ background: classColor.get(key) }} />
							{classLabel(t, key)}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
