import { useMemo, useState } from "react";
import { api, type AccountDto, type Portfolio } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Donut, Treemap } from "../lib/charts";
import { money, number, percent, relativeDays, signedMoney, signedPercent, stalenessClass, trendClass } from "../lib/format";
import { ASSET_CLASSES, CLASS_LABELS, MARKET_LABELS, MARKETS, type AssetClass, type Market } from "../../shared/labels";

type Dimension = "class" | "account" | "currency" | "instrument";

const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
	{ key: "class", label: "资产类别" },
	{ key: "account", label: "账户" },
	{ key: "currency", label: "币种" },
	{ key: "instrument", label: "标的" },
];

export function DashboardPage() {
	const [dimension, setDimension] = useState<Dimension>("class");
	const [assetClass, setAssetClass] = useState<AssetClass | "">("");
	const [market, setMarket] = useState<Market | "">("");
	const [accountId, setAccountId] = useState("");
	const [sortKey, setSortKey] = useState<"value" | "pnl" | "share" | "name">("value");

	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(), []);
	const portfolio = useAsync<Portfolio>(
		() =>
			api.portfolio({
				class: assetClass || undefined,
				market: market || undefined,
				accountId: accountId || undefined,
			}),
		[assetClass, market, accountId],
	);

	const data = portfolio.data;

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
		const groups = new Map<string, { name: string; value: number; children: Array<{ name: string; value: number }> }>();
		for (const holding of data.holdings) {
			if (holding.marketValueDisplay === null) continue;
			const group = groups.get(holding.accountId) ?? { name: holding.accountName, value: 0, children: [] };
			const label = holding.symbol ? `${holding.symbol}` : holding.name;
			group.children.push({ name: label, value: Number(holding.marketValueDisplay.toFixed(2)) });
			group.value += holding.marketValueDisplay;
			groups.set(holding.accountId, group);
		}
		return [...groups.values()].map((group) => ({
			...group,
			value: Number(group.value.toFixed(2)),
			children: group.children.sort((a, b) => b.value - a.value),
		}));
	}, [data]);

	const rows = useMemo(() => {
		if (!data) return [];
		const sorted = [...data.holdings];
		if (sortKey === "value") sorted.sort((a, b) => (b.marketValueDisplay ?? -1) - (a.marketValueDisplay ?? -1));
		if (sortKey === "pnl") sorted.sort((a, b) => (b.pnl ?? Number.NEGATIVE_INFINITY) - (a.pnl ?? Number.NEGATIVE_INFINITY));
		if (sortKey === "share") sorted.sort((a, b) => b.share - a.share);
		if (sortKey === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
		return sorted;
	}, [data, sortKey]);

	if (portfolio.error) return <div className="alert error">{portfolio.error}</div>;
	if (!data) return <div className="empty">加载中…</div>;

	const currency = data.displayCurrency;
	const accountOptions = accounts.data?.items ?? [];

	return (
		<>
			{data.missingFxCurrencies.length > 0 && (
				<div className="alert">
					以下币种缺少汇率，相关持仓未计入总额：{data.missingFxCurrencies.join("、")}。请到「设置 → 汇率」添加。
				</div>
			)}

			<div className="grid cols-4">
				<div className="card stat">
					<div className="label">总资产（{currency}）</div>
					<div className="value">{money(data.total, currency)}</div>
					<div className="hint">
						{data.counts.accounts} 个账户 · {data.counts.holdings} 条持仓
					</div>
				</div>
				<div className="card stat">
					<div className="label">持仓成本合计</div>
					<div className="value">
						{money(
							data.holdings.reduce((sum, item) => sum + (item.cost ?? 0), 0),
							currency,
						)}
					</div>
					<div className="hint">按平均成本法</div>
				</div>
				<div className="card stat">
					<div className="label">浮动盈亏</div>
					<div
						className={`value ${
							trendClass(
								data.holdings.reduce((sum, item) => sum + (item.pnl ?? 0), 0),
							)
						}`}
					>
						{signedMoney(
							data.holdings.reduce((sum, item) => sum + (item.pnl ?? 0), 0),
							currency,
						)}
					</div>
					<div className="hint">仅统计已填平均成本的持仓</div>
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
								onClick={() => setDimension(item.key)}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="spacer" />
					<select value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass | "")} style={{ width: 130 }}>
						<option value="">全部类别</option>
						{ASSET_CLASSES.map((value) => (
							<option key={value} value={value}>
								{CLASS_LABELS[value]}
							</option>
						))}
					</select>
					<select value={market} onChange={(e) => setMarket(e.target.value as Market | "")} style={{ width: 120 }}>
						<option value="">全部市场</option>
						{MARKETS.map((value) => (
							<option key={value} value={value}>
								{MARKET_LABELS[value]}
							</option>
						))}
					</select>
					<select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ width: 160 }}>
						<option value="">全部账户</option>
						{accountOptions.map((account) => (
							<option key={account.id} value={account.id}>
								{account.name}
							</option>
						))}
					</select>
				</div>

				{donutItems.length === 0 ? (
					<div className="card empty">还没有数据。先到「账户」创建一个账户，再到「持仓」录入资产。</div>
				) : (
					<div className="grid cols-2">
						<div className="card panel">
							<Donut items={donutItems} currency={currency} />
						</div>
						<div className="card panel">
							<Treemap items={treemapItems} currency={currency} />
						</div>
					</div>
				)}
			</div>

			{rows.length > 0 && (
				<div className="section">
					<div className="section-head">
						<h2>持仓明细</h2>
						<div className="spacer" />
						<select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)} style={{ width: 150 }}>
							<option value="value">按市值排序</option>
							<option value="share">按占比排序</option>
							<option value="pnl">按盈亏排序</option>
							<option value="name">按名称排序</option>
						</select>
					</div>
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">名称</th>
									<th className="left">账户</th>
									<th className="left">类别</th>
									<th>数量</th>
									<th>价格</th>
									<th>市值（{currency}）</th>
									<th>占比</th>
									<th>成本</th>
									<th>盈亏</th>
									<th>价格更新</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((item) => (
									<tr key={item.id}>
										<td className="left">
											{item.symbol ? <strong>{item.symbol}</strong> : item.name}
											{item.symbol && <span className="muted small"> {item.name}</span>}
										</td>
										<td className="left">{item.accountName}</td>
										<td className="left">
											{CLASS_LABELS[item.class]}
											{item.market && <span className="muted small"> · {MARKET_LABELS[item.market as Market] ?? item.market}</span>}
										</td>
										<td>{number(item.qty)}</td>
										<td>{number(item.price)}</td>
										<td>
											{item.marketValueDisplay === null ? (
												<span className="badge warn">缺汇率</span>
											) : (
												money(item.marketValueDisplay, currency)
											)}
										</td>
										<td>{percent(item.share)}</td>
										<td>{item.avgCost === null ? "—" : money(item.avgCost, item.currency)}</td>
										<td className={trendClass(item.pnl)}>
											{item.pnl === null ? "—" : `${signedMoney(item.pnl, item.currency)} / ${signedPercent(item.pnlPct)}`}
										</td>
										<td className={stalenessClass(item.daysSincePriceUpdate)}>
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
