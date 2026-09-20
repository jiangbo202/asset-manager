import { useMemo } from "react";
import { api, type AccountDto, type Portfolio } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Donut, Treemap } from "../lib/charts";
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
import { MarketFilter, parseMarketParam } from "../components/MarketFilter";
import { useRouter } from "../lib/router";
import { ASSET_CLASSES, CLASS_LABELS, MARKET_LABELS, type Market } from "../../shared/labels";

type Dimension = "class" | "account" | "currency" | "instrument";
type SortKey = "value" | "share" | "pnl" | "name" | "stale";

const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
	{ key: "class", label: "资产类别" },
	{ key: "account", label: "账户" },
	{ key: "currency", label: "币种" },
	{ key: "instrument", label: "标的" },
];

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
	const { query, setQuery, navigate } = useRouter();

	const dimension = (query.get("dim") as Dimension | null) ?? "class";
	const assetClass = query.get("class") ?? "";
	const markets = parseMarketParam(query.get("market"));
	const accountId = query.get("account") ?? "";
	const currencyFilter = query.get("ccy") ?? "";
	const sortKey = (query.get("sort") as SortKey | null) ?? "value";
	const zoom = query.get("zoom") ?? "";

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

	const data = portfolio.data;
	const hasFilter = Boolean(assetClass || markets.length > 0 || accountId || currencyFilter);

	const donutItems = useMemo(() => {
		if (!data) return [];
		if (dimension === "class") return data.byClass;
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
	}, [data, dimension]);

	const treemapItems = useMemo(() => {
		if (!data) return [];
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
				name: holding.symbol ?? holding.name,
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
	}, [data, zoom]);

	const rows = useMemo(() => {
		if (!data) return [];
		const sorted = [...data.holdings];
		if (sortKey === "value") sorted.sort((a, b) => (b.marketValueDisplay ?? -1) - (a.marketValueDisplay ?? -1));
		if (sortKey === "pnl") sorted.sort((a, b) => (b.pnlDisplay ?? Number.NEGATIVE_INFINITY) - (a.pnlDisplay ?? Number.NEGATIVE_INFINITY));
		if (sortKey === "share") sorted.sort((a, b) => b.share - a.share);
		if (sortKey === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
		if (sortKey === "stale")
			sorted.sort((a, b) => (b.daysSincePriceUpdate ?? -1) - (a.daysSincePriceUpdate ?? -1));
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
				<div className="alert error">加载组合数据失败：{portfolio.error}</div>
				<button onClick={() => portfolio.reload()}>重试</button>
			</div>
		);
	}

	if (!data) return <Skeleton />;

	const currency = data.displayCurrency;
	const accountOptions = accounts.data?.items ?? [];
	const zoomName = treemapItems[0]?.name ?? "";
	// 多币种汇总必须用折算后的值（costDisplay / pnlDisplay），否则会把不同币种的数字相加
	const costTotal = data.holdings.reduce((sum, item) => sum + (item.costDisplay ?? 0), 0);
	const pnlTotal = data.holdings.reduce((sum, item) => sum + (item.pnlDisplay ?? 0), 0);
	const pnlMissingCount = data.holdings.filter((item) => item.avgCost === null).length;

	return (
		<>
			{data.missingFxCurrencies.length > 0 && (
				<div className="alert">
					以下币种缺少汇率，相关持仓未计入总额：{data.missingFxCurrencies.join("、")}。
					<button className="ghost" onClick={() => navigate("/settings")}>
						去设置汇率
					</button>
				</div>
			)}

			{staleHoldings.length > 0 && (
				<div className="alert">
					有 {staleHoldings.length} 条持仓价格已超过 7 天未更新：
					{staleHoldings
						.slice(0, 5)
						.map((item) => `${item.symbol ?? item.name}（${relativeDays(item.daysSincePriceUpdate)}）`)
						.join("、")}
					{staleHoldings.length > 5 && " 等"}
					<button className="ghost" onClick={() => navigate("/holdings")}>
						去批量更新
					</button>
				</div>
			)}

			<div className="grid cols-4">
				<div className="card stat">
					<div className="label">总资产（{currency}）</div>
					<div className="value">{money(data.total, currency)}</div>
					<div className="hint">
						{data.counts.accounts} 个账户 · {data.counts.holdings} 条持仓
						{hasFilter && " · 已筛选"}
					</div>
				</div>
				<div className="card stat">
					<div className="label">持仓成本合计</div>
					<div className="value">{money(costTotal, currency)}</div>
					<div className="hint">按平均成本法，已折算到 {currency}</div>
				</div>
				<div className="card stat">
					<div className="label">浮动盈亏</div>
					<div className={`value ${trendClass(pnlTotal)}`}>{signedMoney(pnlTotal, currency)}</div>
					<div className="hint">
						{costTotal > 0 ? signedPercent((pnlTotal / costTotal) * 100) : "—"}
						{pnlMissingCount > 0 && ` · ${pnlMissingCount} 条未填成本`}
					</div>
				</div>
				<div className="card stat">
					<div className="label">价格新鲜度</div>
					<div className={`value ${data.staleDays !== null && data.staleDays > 7 ? "negative" : ""}`}>
						{data.staleDays === null ? "—" : `${data.staleDays} 天`}
					</div>
					<div className="hint">最久未更新的价格（v1 手动录入）</div>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>分布</h2>
					<div className="seg">
						{DIMENSIONS.map((item) => (
							<button
								key={item.key}
								className={dimension === item.key ? "on" : ""}
								onClick={() => setQuery({ dim: item.key === "class" ? null : item.key })}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="spacer" />
					<select
						value={assetClass}
						onChange={(e) => setQuery({ class: e.target.value || null })}
						style={{ width: 130 }}
					>
						<option value="">全部类别</option>
						{ASSET_CLASSES.map((value) => (
							<option key={value} value={value}>
								{CLASS_LABELS[value]}
							</option>
						))}
					</select>
					<select value={accountId} onChange={(e) => setQuery({ account: e.target.value || null })} style={{ width: 160 }}>
						<option value="">全部账户</option>
						{accountOptions.map((account) => (
							<option key={account.id} value={account.id}>
								{account.name}
							</option>
						))}
					</select>
				</div>
				<div className="section-head" style={{ marginTop: -4 }}>
					<span className="small muted">市场：</span>
					<MarketFilter selected={markets} onChange={(next) => setQuery({ market: next.join(",") || null })} />
					{hasFilter && (
						<button
							className="ghost"
							onClick={() => setQuery({ class: null, market: null, account: null, ccy: null, zoom: null })}
						>
							清除筛选
						</button>
					)}
				</div>

				{donutItems.length === 0 ? (
					<div className="card empty">
						还没有数据。先到「账户」创建一个账户，再到「持仓」录入资产。
					</div>
				) : (
					<div className="grid cols-2">
						<div className="card panel">
							<div className="small muted" style={{ marginBottom: 6 }}>
								点击扇区或图例可下钻筛选（dimension：{DIMENSIONS.find((d) => d.key === dimension)?.label}）
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
												← 全部账户
											</button>
											/ {zoomName}
										</>
									) : (
										"点击方块或图例可下钻到单个账户"
									)}
								</span>
							</div>
							<Treemap
								items={treemapItems}
								currency={currency}
								colorByChild={Boolean(zoom)}
								onSelect={(key) => setQuery({ zoom: key })}
							/>
						</div>
					</div>
				)}
			</div>

			{rows.length > 0 && (
				<div className="section">
					<div className="section-head">
						<h2>持仓明细</h2>
						<div className="spacer" />
						<select value={sortKey} onChange={(e) => setQuery({ sort: e.target.value === "value" ? null : e.target.value })} style={{ width: 160 }}>
							<option value="value">按市值排序</option>
							<option value="share">按占比排序</option>
							<option value="pnl">按盈亏排序</option>
							<option value="stale">按价格陈旧排序</option>
							<option value="name">按名称排序</option>
						</select>
					</div>
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">名称</th>
									<th className="left hide-sm">账户</th>
									<th className="left hide-sm">类别</th>
									<th className="hide-sm">数量</th>
									<th>价格</th>
									<th>市值（{currency}）</th>
									<th className="hide-sm">占比</th>
									<th className="hide-sm">成本</th>
									<th>盈亏</th>
									<th className="hide-sm">价格更新</th>
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
											{CLASS_LABELS[item.class]}
											{item.market && (
												<span className="muted small">
													{" "}
													· {MARKET_LABELS[item.market as Market] ?? item.market}
												</span>
											)}
										</td>
										<td className="hide-sm">{number(item.qty)}</td>
										<td>{number(item.price)}</td>
										<td>
											{item.marketValueDisplay === null ? (
												<span className="badge warn">缺汇率</span>
											) : (
												money(item.marketValueDisplay, currency)
											)}
										</td>
										<td className="hide-sm">{percent(item.share)}</td>
										<td className="hide-sm">{item.avgCost === null ? "—" : money(item.avgCost, item.currency)}</td>
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
											{relativeDays(item.daysSincePriceUpdate)}
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
