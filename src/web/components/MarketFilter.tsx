import { MARKETS, marketLabel } from "../../shared/labels";
import { useT } from "../lib/i18n";

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
	const t = useT();
	return (
		<div className="chips" role="group" aria-label={t("accounts.market")}>
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
						{marketLabel(t, market)}
					</button>
				);
			})}
			{selected.length > 0 && (
				<button type="button" className="ghost" onClick={() => onChange([])}>
					{t("dashboard.clearFilters")}
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
