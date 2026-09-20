import { useMemo, useState } from "react";
import { api, type AccountDto, type Portfolio, type TrendSeriesDto } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Donut, PALETTE, Treemap } from "../lib/charts";
import { TrendChart } from "../lib/trend";
import {
	money,
	number,
	percent,
	relativeDays,
	signedMoney,
	signedPercent,
	stalenessClass,
	trendClass,
} from "../lib/format";
import { BrandIcon } from "../lib/icons";
import { useT } from "../lib/i18n";
import { MarketFilter, parseMarketParam } from "../components/MarketFilter";
import { useRouter } from "../lib/router";
import { ASSET_CLASSES, classLabel, marketLabel, type Market } from "../../shared/labels";

type Dimension = "class" | "account" | "currency" | "instrument";
type SortKey = "value" | "share" | "pnl" | "name" | "stale";

function Skeleton() {
	return (
		<>
			<div className="grid cols-4">
				{Array.from({ length: 4 }).map((_, index) => (
					<div className="card stat" key={index}>
						<div className="skeleton" style={{ height: 12, width: "40%" }} />
						<div className="skeleton" style={{ height: 22, width: "70%", marginTop: 10 }} />
						<div className="skeleton" style={{ height: 10, width: "55%", marginTop: 10 }} />
					</div>
				))}
			</div>
			<div className="grid cols-2" style={{ marginTop: 20 }}>
				<div className="card panel">
					<div className="skeleton" style={{ height: 240 }} />
				</div>
				<div className="card panel">
					<div className="skeleton" style={{ height: 240 }} />
				</div>
			</div>
		</>
	);
}

export function DashboardPage() {
	const t = useT();
	const { query, setQuery, navigate } = useRouter();

	const dimension = (query.get("dim") as Dimension | null) ?? "class";
	const assetClass = query.get("class") ?? "";
	const markets = parseMarketParam(query.get("market"));
	const accountId = query.get("account") ?? "";
	const currencyFilter = query.get("ccy") ?? "";
	const sortKey = (query.get("sort") as SortKey | null) ?? "value";
	const zoom = query.get("zoom") ?? "";
	const range = query.get("range") ?? "3M";
	const stacked = query.get("stack") === "1";
	// treemap：同一标的跨账户合并统计（默认分开，按账户分组）
	const mergeSymbols = query.get("merge") === "1";
	const [refreshing, setRefreshing] = useState(false);
	const [refreshNote, setRefreshNote] = useState<string | null>(null);

	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(), []);
	const portfolio = useAsync<Portfolio>(
		() =>
			api.portfolio({
				class: assetClass || undefined,
				market: markets.length > 0 ? markets.join(",") : undefined,
				accountId: accountId || undefined,
				currencyFilter: currencyFilter || undefined,
			}),
		[assetClass, markets.join(","), accountId, currencyFilter],
	);

	const trend = useAsync<TrendSeriesDto>(
		() =>
			api.trend({
				range,
				class: assetClass || undefined,
				accountId: accountId || undefined,
				market: markets.length > 0 ? markets.join(",") : undefined,
			}),
		[range, assetClass, accountId, markets.join(",")],
	);

	const data = portfolio.data;
	const hasFilter = Boolean(assetClass || markets.length > 0 || accountId || currencyFilter);

	/** 手动刷新行情（走 Worker 的 /api/quotes/refresh，日常由每天的快照任务完成） */
	const refreshQuotes = async () => {
		setRefreshing(true);
		setRefreshNote(null);
		try {
			const response = await api.quotes.refresh();
			const report = response.report;
			setRefreshNote(
				t("market.refreshDone", {
					updated: report.updated,
					fxUpdated: report.fxUpdated,
					failed: report.failed.length,
				}),
			);
			portfolio.reload();
			trend.reload();
		} catch (error) {
			setRefreshNote(error instanceof Error ? error.message : t("error.requestFailed"));
		} finally {
			setRefreshing(false);
		}
	};

	const dimensionLabel = (key: Dimension): string =>
		key === "class"
			? t("dashboard.dimClass")
			: key === "account"
				? t("dashboard.dimAccount")
				: key === "currency"
					? t("dashboard.dimCurrency")
					: t("dashboard.dimInstrument");

	const donutItems = useMemo(() => {
		if (!data) return [];
		if (dimension === "class") return data.byClass.map((item) => ({ ...item, label: classLabel(t, item.key) }));
		if (dimension === "account") return data.byAccount;
		if (dimension === "currency") return data.byCurrency;
		const buckets = new Map<string, number>();
		for (const holding of data.holdings) {
			if (holding.marketValueDisplay === null) continue;
			const key = holding.symbol ? `${holding.symbol} ${holding.name}` : holding.name;
			buckets.set(key, (buckets.get(key) ?? 0) + holding.marketValueDisplay);
		}
		return [...buckets.entries()]
			.map(([key, value]) => ({
				key,
				label: key,
				value,
				share: data.total > 0 ? (value / data.total) * 100 : 0,
			}))
			.sort((a, b) => b.value - a.value);
		// t 变化时需要重算标签
	}, [data, dimension, t]);

	const treemapItems = useMemo(() => {
		if (!data) return [];

		// 合并模式：同一标的跨账户合并（外层是标的，内层是各账户的份额）
		// 分开模式（默认）：外层是账户，内层是标的，并且标签带上账户名——
		// 同一个标的在多个券商时，光靠颜色分不清哪一个属于谁。
		if (mergeSymbols) {
			const bySymbol = new Map<
				string,
				{
					key: string;
					name: string;
					value: number;
					children: Array<{ key: string; name: string; value: number; selectKey: string }>;
				}
			>();
			for (const holding of data.holdings) {
				if (holding.marketValueDisplay === null) continue;
				if (zoom && holding.accountId !== zoom) continue;
				const label = holding.symbol ?? holding.name;
				const group = bySymbol.get(label) ?? { key: `symbol:${label}`, name: label, value: 0, children: [] };
				group.children.push({
					key: holding.id,
					name: holding.accountName,
					value: Number(holding.marketValueDisplay.toFixed(2)),
					selectKey: holding.accountId,
				});
				group.value += holding.marketValueDisplay;
				bySymbol.set(label, group);
			}
			return [...bySymbol.values()]
				.map((group) => ({
					...group,
					value: Number(group.value.toFixed(2)),
					children: group.children.sort((a, b) => b.value - a.value),
				}))
				.sort((a, b) => b.value - a.value);
		}

		const groups = new Map<
			string,
			{ key: string; name: string; value: number; children: Array<{ key: string; name: string; value: number }> }
		>();
		for (const holding of data.holdings) {
			if (holding.marketValueDisplay === null) continue;
			if (zoom && holding.accountId !== zoom) continue;
			const group =
				groups.get(holding.accountId) ??
				{ key: holding.accountId, name: holding.accountName, value: 0, children: [] };
			group.children.push({
				key: holding.id,
				name: `${holding.accountName} ${holding.symbol ?? holding.name}`,
				value: Number(holding.marketValueDisplay.toFixed(2)),
			});
			group.value += holding.marketValueDisplay;
			groups.set(holding.accountId, group);
		}
		return [...groups.values()]
			.map((group) => ({
				...group,
				value: Number(group.value.toFixed(2)),
				children: group.children.sort((a, b) => b.value - a.value),
			}))
			.sort((a, b) => b.value - a.value);
	}, [data, zoom, mergeSymbols]);

	const rows = useMemo(() => {
		if (!data) return [];
		const sorted = [...data.holdings];
		if (sortKey === "value") sorted.sort((a, b) => (b.marketValueDisplay ?? -1) - (a.marketValueDisplay ?? -1));
		if (sortKey === "pnl")
			sorted.sort((a, b) => (b.pnlDisplay ?? Number.NEGATIVE_INFINITY) - (a.pnlDisplay ?? Number.NEGATIVE_INFINITY));
		if (sortKey === "share") sorted.sort((a, b) => b.share - a.share);
		if (sortKey === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
		if (sortKey === "stale") sorted.sort((a, b) => (b.daysSincePriceUpdate ?? -1) - (a.daysSincePriceUpdate ?? -1));
		return sorted;
	}, [data, sortKey]);

	const staleHoldings = useMemo(() => {
		if (!data) return [];
		return data.holdings
			.filter((item) => !item.isCash && item.daysSincePriceUpdate !== null && item.daysSincePriceUpdate > 7)
			.sort((a, b) => (b.daysSincePriceUpdate ?? 0) - (a.daysSincePriceUpdate ?? 0));
	}, [data]);

	/** 点击环形图 → 联动筛选（同一维度再次点击则取消） */
	const handleDonutSelect = (key: string) => {
		if (dimension === "class") setQuery({ class: key === assetClass ? null : key });
		else if (dimension === "account") setQuery({ account: key === accountId ? null : key });
		else if (dimension === "currency") setQuery({ ccy: key === currencyFilter ? null : key });
	};

	const activeDonutKey = dimension === "class" ? assetClass : dimension === "account" ? accountId : currencyFilter;

	if (portfolio.error) {
		return (
			<div className="card panel">
				<div className="alert error">{t("dashboard.loadFailed", { message: portfolio.error })}</div>
				<button onClick={() => portfolio.reload()}>{t("common.retry")}</button>
			</div>
		);
	}

	if (!data) return <Skeleton />;

	const currency = data.displayCurrency;
	const accountOptions = accounts.data?.items ?? [];
	// 下钻时显示的是账户名（不能从 treemapItems 取：合并模式下外层是标的）
	const zoomName = accounts.data?.items.find((item) => item.id === zoom)?.name ?? "";
	// 多币种汇总必须用折算后的值（costDisplay / pnlDisplay），否则会把不同币种的数字相加
	const costTotal = data.holdings.reduce((sum, item) => sum + (item.costDisplay ?? 0), 0);
	const pnlTotal = data.holdings.reduce((sum, item) => sum + (item.pnlDisplay ?? 0), 0);
	const pnlMissingCount = data.holdings.filter((item) => item.avgCost === null).length;

	return (
		<>
			{data.missingFxCurrencies.length > 0 && (
				<div className="alert">
					{t("dashboard.missingFxAlert", { currencies: data.missingFxCurrencies.join(", ") })}
					<button className="ghost" onClick={() => navigate("/settings")}>
						{t("dashboard.goSettings")}
					</button>
				</div>
			)}

			{staleHoldings.length > 0 && (
				<div className="alert">
					{t("dashboard.staleAlert", {
						count: staleHoldings.length,
						list: staleHoldings
							.slice(0, 5)
							.map((item) => `${item.symbol ?? item.name} (${relativeDays(t, item.daysSincePriceUpdate)})`)
							.join(", "),
						more: staleHoldings.length > 5 ? t("dashboard.staleMore") : "",
					})}
					<button className="ghost" onClick={() => navigate("/holdings")}>
						{t("dashboard.goBulkUpdate")}
					</button>
				</div>
			)}

			<div className="grid cols-4">
				<div className="card stat">
					<div className="label">{t("dashboard.totalAssets", { currency })}</div>
					<div className="value">{money(data.total, currency)}</div>
					<div className="hint">
						{t("dashboard.counts", { accounts: data.counts.accounts, holdings: data.counts.holdings })}
						{hasFilter && t("dashboard.filtered")}
					</div>
				</div>
				<div className="card stat">
					<div className="label">{t("dashboard.costTotal")}</div>
					<div className="value">{money(costTotal, currency)}</div>
					<div className="hint">{t("dashboard.avgCostHint", { currency })}</div>
				</div>
				<div className="card stat">
					<div className="label">{t("dashboard.pnlTotal")}</div>
					<div className={`value ${trendClass(pnlTotal)}`}>{signedMoney(pnlTotal, currency)}</div>
					<div className="hint">
						{costTotal > 0 ? signedPercent((pnlTotal / costTotal) * 100) : "—"}
						{pnlMissingCount > 0 && t("dashboard.pnlMissing", { count: pnlMissingCount })}
					</div>
				</div>
				<div className="card stat">
					<div className="label">{t("dashboard.priceFreshness")}</div>
					<div className={`value ${data.staleDays !== null && data.staleDays > 7 ? "negative" : ""}`}>
						{data.staleDays === null ? "—" : t("dashboard.freshnessDays", { days: data.staleDays })}
					</div>
					<div className="hint">{t("dashboard.staleHint")}</div>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>{t("dashboard.trend")}</h2>
					<div className="seg">
						{["1M", "3M", "6M", "1Y", "ALL"].map((value) => (
							<button
								key={value}
								className={range === value ? "on" : ""}
								onClick={() => setQuery({ range: value === "3M" ? null : value })}
							>
								{value}
							</button>
						))}
					</div>
					<div className="seg">
						<button className={!stacked ? "on" : ""} onClick={() => setQuery({ stack: null })}>
							{t("dashboard.trendTotal")}
						</button>
						<button className={stacked ? "on" : ""} onClick={() => setQuery({ stack: "1" })}>
							{t("dashboard.trendByClass")}
						</button>
					</div>
					<div className="spacer" />
					{refreshNote && <span className="small muted hide-sm">{refreshNote}</span>}
					<button onClick={refreshQuotes} disabled={refreshing}>
						{refreshing ? t("dashboard.refreshing") : t("dashboard.refreshQuotes")}
					</button>
				</div>
				<div className="card panel">
					{trend.error ? (
						<div className="alert error">{t("dashboard.trendLoadFailed", { message: trend.error })}</div>
					) : !trend.data ? (
						<div className="skeleton" style={{ height: 260 }} />
					) : (
						<>
							<TrendChart
								points={trend.data.points}
								currency={trend.data.displayCurrency}
								stacked={stacked}
								palette={PALETTE}
							/>
							<div className="small muted" style={{ marginTop: 4 }}>
								{t("dashboard.trendSummary", { count: trend.data.snapshotCount })}
								{trend.data.firstDate &&
									` · ${t("dashboard.trendRange", { from: trend.data.firstDate, to: trend.data.lastDate ?? "" })}`}
								{trend.data.bucketDays > 1 &&
									` · ${t("dashboard.trendBucketed", {
										unit:
											trend.data.bucketDays === 7 ? t("dashboard.bucketWeek") : t("dashboard.bucketMonth"),
									})}`}
								{` · ${
									trend.data.rateMode === "frozen"
										? t("dashboard.rateFrozen")
										: trend.data.rateMode === "mixed"
											? t("dashboard.rateMixed")
											: t("dashboard.rateCurrent")
								}`}
								{trend.data.missingFxCurrencies.length > 0 &&
									` · ${t("dashboard.trendMissingFx", { currencies: trend.data.missingFxCurrencies.join(", ") })}`}
							</div>
						</>
					)}
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>{t("dashboard.distribution")}</h2>
					<div className="seg">
						{(["class", "account", "currency", "instrument"] as Dimension[]).map((item) => (
							<button
								key={item}
								className={dimension === item ? "on" : ""}
								onClick={() => setQuery({ dim: item === "class" ? null : item })}
							>
								{dimensionLabel(item)}
							</button>
						))}
					</div>
					<div className="spacer" />
					<select
						value={assetClass}
						onChange={(e) => setQuery({ class: e.target.value || null })}
						style={{ width: 140 }}
					>
						<option value="">{t("dashboard.allClasses")}</option>
						{ASSET_CLASSES.map((value) => (
							<option key={value} value={value}>
								{classLabel(t, value)}
							</option>
						))}
					</select>
					<select value={accountId} onChange={(e) => setQuery({ account: e.target.value || null })} style={{ width: 160 }}>
						<option value="">{t("dashboard.allAccounts")}</option>
						{accountOptions.map((account) => (
							<option key={account.id} value={account.id}>
								{account.name}
							</option>
						))}
					</select>
				</div>
				<div className="section-head" style={{ marginTop: -4 }}>
					<span className="small muted">{t("accounts.market")}:</span>
					<MarketFilter selected={markets} onChange={(next) => setQuery({ market: next.join(",") || null })} />
					{hasFilter && (
						<button
							className="ghost"
							onClick={() => setQuery({ class: null, market: null, account: null, ccy: null, zoom: null })}
						>
							{t("dashboard.clearFilters")}
						</button>
					)}
				</div>

				{donutItems.length === 0 ? (
					<div className="card empty">{t("dashboard.emptyCta")}</div>
				) : (
					<div className="grid cols-2">
						<div className="card panel">
							<div className="small muted" style={{ marginBottom: 6 }}>
								{t("dashboard.donutHint", { dimension: dimensionLabel(dimension) })}
							</div>
							<Donut
								items={donutItems}
								currency={currency}
								activeKey={activeDonutKey || null}
								onSelect={dimension === "instrument" ? undefined : handleDonutSelect}
							/>
						</div>
						<div className="card panel">
							<div className="section-head" style={{ marginBottom: 8 }}>
								<span className="small muted">
									{zoom ? (
										<>
											<button className="ghost" onClick={() => setQuery({ zoom: null })}>
												{t("dashboard.backToAllAccounts")}
											</button>
											/ {zoomName}
										</>
									) : mergeSymbols ? (
										t("dashboard.treemapHintMerged")
									) : (
										t("dashboard.treemapHint")
									)}
								</span>
								<span className="spacer" style={{ flex: 1 }} />
								<label className="small" style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
									<input
										type="checkbox"
										checked={mergeSymbols}
										style={{ width: "auto" }}
										onChange={(e) => setQuery({ merge: e.target.checked ? "1" : null })}
									/>
									{t("dashboard.mergeSymbols")}
								</label>
							</div>
							<Treemap
								items={treemapItems}
								currency={currency}
								colorByChild={Boolean(zoom)}
								onSelect={mergeSymbols ? undefined : (key) => setQuery({ zoom: key })}
								onSelectLeaf={mergeSymbols ? (key) => setQuery({ zoom: key }) : undefined}
							/>
						</div>
					</div>
				)}
			</div>

			{rows.length > 0 && (
				<div className="section">
					<div className="section-head">
						<h2>{t("dashboard.holdingsDetail")}</h2>
						<div className="spacer" />
						<select
							value={sortKey}
							onChange={(e) => setQuery({ sort: e.target.value === "value" ? null : e.target.value })}
							style={{ width: 170 }}
						>
							<option value="value">{t("dashboard.sortValue")}</option>
							<option value="share">{t("dashboard.sortShare")}</option>
							<option value="pnl">{t("dashboard.sortPnl")}</option>
							<option value="stale">{t("dashboard.sortStale")}</option>
							<option value="name">{t("dashboard.sortName")}</option>
						</select>
					</div>
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">{t("dashboard.colName")}</th>
									<th className="left hide-sm">{t("dashboard.colAccount")}</th>
									<th className="left hide-sm">{t("dashboard.colClass")}</th>
									<th className="hide-sm">{t("dashboard.colQty")}</th>
									<th>{t("dashboard.colPrice")}</th>
									<th>{t("dashboard.colValue", { currency })}</th>
									<th className="hide-sm">{t("dashboard.colShare")}</th>
									<th className="hide-sm">{t("dashboard.colCost")}</th>
									<th>{t("dashboard.colPnl")}</th>
									<th className="hide-sm">{t("dashboard.colPriceUpdated")}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((item) => (
									<tr key={item.id}>
										<td className="left">
											{item.symbol ? <strong>{item.symbol}</strong> : item.name}
											{item.symbol && <span className="muted small"> {item.name}</span>}
										</td>
										<td className="left hide-sm">
											<div className="cell-account">
												<BrandIcon iconKey={item.accountIconKey} name={item.accountName} size="sm" />
												{item.accountName}
											</div>
										</td>
										<td className="left hide-sm">
											{classLabel(t, item.class)}
											{item.market && (
												<span className="muted small"> · {marketLabel(t, item.market as Market)}</span>
											)}
										</td>
										<td className="hide-sm">{number(item.qty)}</td>
										<td>{number(item.price)}</td>
										<td>
											{item.marketValueDisplay === null ? (
												<span className="badge warn">{t("dashboard.missingFxBadge")}</span>
											) : (
												money(item.marketValueDisplay, currency)
											)}
										</td>
										<td className="hide-sm">{percent(item.share)}</td>
										<td className="hide-sm">
											{item.avgCost === null ? "—" : money(item.avgCost, item.currency)}
										</td>
										<td className={trendClass(item.pnl)}>
											{item.pnl === null ? (
												"—"
											) : (
												<>
													{signedMoney(item.pnl, item.currency)}
													<span className="small"> / {signedPercent(item.pnlPct)}</span>
												</>
											)}
										</td>
										<td className={`hide-sm ${stalenessClass(item.daysSincePriceUpdate)}`}>
											{relativeDays(t, item.daysSincePriceUpdate)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}
		</>
	);
}
