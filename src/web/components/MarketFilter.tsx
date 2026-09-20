import { MARKET_LABELS, MARKETS } from "../../shared/labels";

/**
 * 市场筛选（可多选，FR-6.3）
 * URL 里用逗号分隔：?market=us,hk
 */
export function MarketFilter({
	selected,
	onChange,
}: {
	selected: string[];
	onChange: (next: string[]) => void;
}) {
	return (
		<div className="chips" role="group" aria-label="按市场筛选">
			{MARKETS.map((market) => {
				const on = selected.includes(market);
				return (
					<button
						key={market}
						type="button"
						className={on ? "on" : ""}
						aria-pressed={on}
						onClick={() => onChange(on ? selected.filter((item) => item !== market) : [...selected, market])}
					>
						{MARKET_LABELS[market]}
					</button>
				);
			})}
			{selected.length > 0 && (
				<button type="button" className="ghost" onClick={() => onChange([])}>
					清除
				</button>
			)}
		</div>
	);
}

/** 把逗号分隔的 URL 参数解析成市场数组 */
export function parseMarketParam(value: string | null): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => (MARKETS as readonly string[]).includes(item));
}
