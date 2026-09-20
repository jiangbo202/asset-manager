import { useMemo, useState } from "react";
import { api, type AccountDto, type HoldingListDto, type LookupCandidate } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { BrandIcon } from "../lib/icons";
import { money, number, relativeDays, stalenessClass } from "../lib/format";
import { MarketFilter, parseMarketParam } from "../components/MarketFilter";
import { useRouter } from "../lib/router";
import {
	ASSET_CLASSES,
	CLASS_LABELS,
	MARKET_LABELS,
	MARKETS,
	type AssetClass,
	type Market,
} from "../../shared/labels";

interface FormState {
	accountId: string;
	class: AssetClass;
	market: Market | "";
	symbol: string;
	name: string;
	currency: string;
	qty: string;
	price: string;
	avgCost: string;
	quoteSource: string;
	quoteSymbol: string;
	note: string;
}

type SortKey = "name" | "account" | "class" | "qty" | "price" | "value" | "stale";
type SortDir = "asc" | "desc";

const emptyForm = (accountId: string, currency: string): FormState => ({
	accountId,
	class: "stock",
	market: "us",
	symbol: "",
	name: "",
	currency,
	qty: "",
	price: "",
	avgCost: "",
	quoteSource: "",
	quoteSymbol: "",
	note: "",
});

function daysSince(iso: string | null): number | null {
	if (!iso) return null;
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return null;
	return Math.floor((Date.now() - parsed) / 86_400_000);
}

const SORT_COLUMNS: Array<{ key: SortKey; label: string; className?: string }> = [
	{ key: "name", label: "名称", className: "left" },
	{ key: "account", label: "账户", className: "left hide-sm" },
	{ key: "class", label: "类别", className: "left hide-sm" },
	{ key: "qty", label: "数量", className: "hide-sm" },
	{ key: "price", label: "价格" },
	{ key: "value", label: "市值（原币）" },
	{ key: "stale", label: "价格更新" },
];

export function HoldingsPage() {
	const { query, setQuery } = useRouter();
	const showArchived = query.get("archived") === "1";
	const filterAccount = query.get("account") ?? "";
	const filterClass = query.get("class") ?? "";
	const filterMarkets = parseMarketParam(query.get("market"));
	const sortKey = (query.get("sort") as SortKey | null) ?? "value";
	const sortDir = (query.get("dir") as SortDir | null) ?? "desc";

	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(), []);
	const holdings = useAsync<{ items: HoldingListDto[] }>(
		() => api.holdings.list({ includeArchived: showArchived }),
		[showArchived],
	);
	const [form, setForm] = useState<FormState | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [prices, setPrices] = useState<Record<string, string>>({});
	const [lookup, setLookup] = useState<{
		loading: boolean;
		message: string | null;
		error: string | null;
		candidates: LookupCandidate[];
	}>({ loading: false, message: null, error: null, candidates: [] });
	const { pending, error, setError, run } = useSubmit();
	const bulk = useSubmit();

	const accountList = accounts.data?.items ?? [];
	const allItems = holdings.data?.items ?? [];
	const hasFilter = Boolean(filterAccount || filterClass || filterMarkets.length > 0);

	const items = useMemo(() => {
		const filtered = allItems.filter(
			(item) =>
				(!filterAccount || item.account_id === filterAccount) &&
				(!filterClass || item.class === filterClass) &&
				(filterMarkets.length === 0 || (item.market !== null && filterMarkets.includes(item.market))) &&
				(showArchived || item.archived !== 1),
		);

		const direction = sortDir === "asc" ? 1 : -1;
		const valueOf = (item: HoldingListDto): number | string => {
			switch (sortKey) {
				case "name":
					return item.symbol ?? item.name;
				case "account":
					return item.account_name;
				case "class":
					return item.class;
				case "qty":
					return item.qty;
				case "price":
					return item.price;
				case "stale":
					return daysSince(item.price_updated_at) ?? -1;
				default:
					return item.qty * item.price;
			}
		};

		return [...filtered].sort((a, b) => {
			const left = valueOf(a);
			const right = valueOf(b);
			if (typeof left === "string" || typeof right === "string") {
				return String(left).localeCompare(String(right), "zh-CN") * direction;
			}
			return (left - right) * direction;
		});
	}, [allItems, filterAccount, filterClass, filterMarkets.join(","), showArchived, sortKey, sortDir]);

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) setQuery({ dir: sortDir === "asc" ? "desc" : "asc" });
		else setQuery({ sort: key, dir: key === "name" || key === "account" || key === "class" ? "asc" : "desc" });
	};

	const changedCount = useMemo(() => {
		return Object.entries(prices).filter(([id, value]) => {
			const holding = allItems.find((item) => item.id === id);
			const parsed = Number(value);
			return holding && value !== "" && Number.isFinite(parsed) && parsed !== holding.price;
		}).length;
	}, [prices, allItems]);

	const startCreate = () => {
		if (accountList.length === 0) {
			setError("请先在「账户」页创建一个账户");
			return;
		}
		const first = accountList[0];
		setEditingId(null);
		setForm(emptyForm(first.id, first.currency));
	};

	const startEdit = (holding: HoldingListDto) => {
		setEditingId(holding.id);
		setForm({
			accountId: holding.account_id,
			class: holding.class,
			market: (holding.market as Market | null) ?? "",
			symbol: holding.symbol ?? "",
			name: holding.name,
			currency: holding.currency,
			qty: String(holding.qty),
			price: String(holding.price),
			avgCost: holding.avg_cost === null ? "" : String(holding.avg_cost),
			quoteSource: holding.quote_source ?? "",
			quoteSymbol: holding.quote_symbol ?? "",
			note: holding.note ?? "",
		});
	};

	/**
	 * 代码查询：填名称/币种/市场，也可以顺便把最新价填进价格框
	 * 走 /api/quotes/lookup（服务端缓存 24h，避免反复打第三方接口被限流）
	 */
	const runLookup = async (options: { fillPrice: boolean; force?: boolean; symbolOverride?: string }) => {
		if (!form) return;
		const symbol = (options.symbolOverride ?? form.symbol).trim();
		if (!symbol) {
			setLookup({ loading: false, message: null, error: "请先填写代码", candidates: [] });
			return;
		}
		setLookup({ loading: true, message: null, error: null, candidates: [] });
		try {
			const result = await api.quotes.lookup({
				symbol,
				market: form.market || null,
				class: form.class,
				force: options.force,
			});
			if (result.candidates.length === 0) {
				setLookup({
					loading: false,
					message: null,
					error: result.rateLimited
						? "行情接口暂时被限流，稍后再试（或到设置页换一个数据源）"
						: result.errors[0] ?? "没有找到这个代码",
					candidates: [],
				});
				return;
			}

			const best = result.candidates[0];
			const patch: Partial<FormState> = {};
			// 名称只在为空时自动填，避免覆盖用户自己起的名字
			if (!form.name.trim() && best.name) patch.name = best.name;
			if (best.currency) patch.currency = best.currency;
			if (best.market) patch.market = best.market as Market;
			if (best.class && best.class !== "crypto" && best.class !== "cash") patch.class = best.class as AssetClass;
			if (options.fillPrice && best.price !== null) patch.price = String(best.price);
			if (best.symbol && (!form.symbol.trim() || options.fillPrice)) patch.symbol = best.symbol;
			setForm((current) => (current ? { ...current, ...patch } : current));

			const priceNote = best.price !== null ? `，最新价 ${best.price} ${best.currency ?? ""}` : "";
			setLookup({
				loading: false,
				message: `${result.cached ? "（缓存）" : ""}已从 ${best.source} 匹配：${best.name}${priceNote}`,
				error: null,
				candidates: result.candidates,
			});
		} catch (lookupError) {
			setLookup({
				loading: false,
				message: null,
				error: lookupError instanceof Error ? lookupError.message : "查询失败",
				candidates: [],
			});
		}
	};

	const changeAccount = (accountId: string) => {
		if (!form) return;
		const account = accountList.find((item) => item.id === accountId);
		setForm({
			...form,
			accountId,
			currency: account?.currency ?? form.currency,
			market: (account?.market as Market | null) ?? form.market,
		});
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form) return;
		if (form.name.trim() === "") {
			setError("名称不能为空");
			return;
		}
		if (form.qty === "" || Number.isNaN(Number(form.qty))) {
			setError(form.class === "cash" ? "余额必须是数字" : "数量必须是数字");
			return;
		}
		if (form.class !== "cash" && (form.price === "" || Number.isNaN(Number(form.price)))) {
			setError("价格必须是数字");
			return;
		}

		const isCash = form.class === "cash";
		await run(async () => {
			const payload: Record<string, unknown> = {
				accountId: form.accountId,
				class: form.class,
				market: isCash ? null : form.market || null,
				symbol: isCash ? null : form.symbol.trim() || null,
				name: form.name.trim(),
				currency: form.currency,
				qty: Number(form.qty),
				price: isCash ? 1 : Number(form.price),
				avgCost: isCash || form.avgCost === "" ? null : Number(form.avgCost),
				quoteSource: isCash ? null : form.quoteSource || null,
				quoteSymbol: isCash ? null : form.quoteSymbol.trim() || null,
				note: form.note.trim() || null,
			};
			if (editingId) await api.holdings.update(editingId, payload);
			else await api.holdings.create(payload);
			setForm(null);
			setEditingId(null);
			holdings.reload();
		});
	};

	const remove = async (holding: HoldingListDto) => {
		if (!window.confirm(`确定删除「${holding.name}」？`)) return;
		await run(async () => {
			await api.holdings.remove(holding.id);
			holdings.reload();
		});
	};

	const toggleArchive = async (holding: HoldingListDto) => {
		await run(async () => {
			await api.holdings.update(holding.id, { archived: holding.archived !== 1 });
			holdings.reload();
		});
	};

	const submitBulk = async () => {
		const changes = Object.entries(prices)
			.map(([id, value]) => ({ id, price: Number(value) }))
			.filter((item) => {
				const holding = allItems.find((entry) => entry.id === item.id);
				return Number.isFinite(item.price) && item.price > 0 && holding && holding.price !== item.price;
			});
		if (changes.length === 0) return;
		await bulk.run(async () => {
			await api.holdings.bulkPrice(changes);
			setPrices({});
			holdings.reload();
		});
	};

	const pricedItems = items.filter((item) => item.class !== "cash" && item.archived !== 1);

	return (
		<>
			<div className="section-head">
				<h2>持仓</h2>
				<div className="spacer" />
				<label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
					<input
						type="checkbox"
						checked={showArchived}
						style={{ width: "auto" }}
						onChange={(e) => setQuery({ archived: e.target.checked ? "1" : null })}
					/>
					显示已归档
				</label>
				<select
					value={filterAccount}
					onChange={(e) => setQuery({ account: e.target.value || null })}
					style={{ width: 170 }}
				>
					<option value="">全部账户</option>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.name}
						</option>
					))}
				</select>
				<select
					value={filterClass}
					onChange={(e) => setQuery({ class: e.target.value || null })}
					style={{ width: 120 }}
				>
					<option value="">全部类别</option>
					{ASSET_CLASSES.map((value) => (
						<option key={value} value={value}>
							{CLASS_LABELS[value]}
						</option>
					))}
				</select>
				<div className="chips" style={{ marginLeft: 4 }}>
					<span className="small muted">市场：</span>
					<MarketFilter selected={filterMarkets} onChange={(next) => setQuery({ market: next.join(",") || null })} />
				</div>
				{hasFilter && (
					<button className="ghost" onClick={() => setQuery({ account: null, class: null, market: null })}>
						清除筛选
					</button>
				)}
				<button className="primary" onClick={startCreate}>
					新建持仓
				</button>
			</div>

			{error && <div className="alert error">{error}</div>}
			{bulk.error && <div className="alert error">{bulk.error}</div>}

			{form && (
				<form className="card panel" onSubmit={submit} style={{ marginBottom: 16 }}>
					<div className="row">
						<label className="field">
							<span>账户</span>
							<select value={form.accountId} onChange={(e) => changeAccount(e.target.value)}>
								{accountList.map((account) => (
									<option key={account.id} value={account.id}>
										{account.name}（{account.currency}）
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>类别</span>
							<select
								value={form.class}
								onChange={(e) => {
									const assetClass = e.target.value as AssetClass;
									setForm({
										...form,
										class: assetClass,
										market: assetClass === "cash" ? "" : form.market,
										price: assetClass === "cash" ? "1" : form.price,
									});
								}}
							>
								{ASSET_CLASSES.map((value) => (
									<option key={value} value={value}>
										{CLASS_LABELS[value]}
									</option>
								))}
							</select>
						</label>
						{form.class !== "cash" && (
							<label className="field">
								<span>市场</span>
								<select
									value={form.market}
									onChange={(e) => setForm({ ...form, market: e.target.value as Market | "" })}
								>
									<option value="">未指定</option>
									{MARKETS.map((market) => (
										<option key={market} value={market}>
											{MARKET_LABELS[market]}
										</option>
									))}
								</select>
							</label>
						)}
						<label className="field">
							<span>币种（默认跟随账户）</span>
							<select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
								{["USD", "HKD", "CNY"].map((currency) => (
									<option key={currency} value={currency}>
										{currency}
									</option>
								))}
							</select>
						</label>
					</div>

					<div className="row">
						{form.class !== "cash" && (
							<label className="field">
								<span>代码（如 AAPL / 0700.HK / BTC）——填完自动查名称</span>
								<div className="input-with-button">
									<input
										value={form.symbol}
										onChange={(e) => setForm({ ...form, symbol: e.target.value })}
										onBlur={() => {
											if (form.symbol.trim() && !form.name.trim()) void runLookup({ fillPrice: false });
										}}
										placeholder="输入代码后点右侧按钮查询"
									/>
									<button
										type="button"
										onClick={() => void runLookup({ fillPrice: false })}
										disabled={lookup.loading || !form.symbol.trim()}
									>
										{lookup.loading ? "查询中…" : "查名称"}
									</button>
								</div>
							</label>
						)}
						<label className="field">
							<span>名称</span>
							<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
						</label>
					</div>

					<div className="row">
						<label className="field">
							<span>{form.class === "cash" ? "余额" : "数量"}</span>
							<input
								type="number"
								step="any"
								value={form.qty}
								onChange={(e) => setForm({ ...form, qty: e.target.value })}
								required
							/>
						</label>
						{form.class !== "cash" && (
							<>
								<label className="field">
									<span>当前价格（可手动填，也可点按钮取最新价）</span>
									<div className="input-with-button">
										<input
											type="number"
											step="any"
											value={form.price}
											onChange={(e) => setForm({ ...form, price: e.target.value })}
											required
										/>
										<button
											type="button"
											onClick={() => void runLookup({ fillPrice: true, force: true })}
											disabled={lookup.loading || !form.symbol.trim()}
											title="立即联网取一次最新价（不走缓存）"
										>
											{lookup.loading ? "…" : "取最新价"}
										</button>
									</div>
								</label>
								<label className="field">
									<span>平均成本（可选，用于算盈亏）</span>
									<input
										type="number"
										step="any"
										value={form.avgCost}
										onChange={(e) => setForm({ ...form, avgCost: e.target.value })}
										placeholder="留空则不计盈亏"
									/>
								</label>
							</>
						)}
					</div>

					{form.class === "cash" && (
						<div className="small muted" style={{ marginBottom: 12 }}>
							现金只需填余额，价格恒为 1
						</div>
					)}

					{lookup.error && <div className="alert error">{lookup.error}</div>}
					{lookup.message && (
						<div className="small" style={{ marginBottom: 12 }}>
							{lookup.message}
						</div>
					)}
					{lookup.candidates.length > 1 && (
						<div style={{ marginBottom: 12 }}>
							<div className="small muted">其它匹配结果（点一下替换）：</div>
							<div className="chips">
								{lookup.candidates.slice(1, 6).map((candidate) => (
									<button
										key={candidate.symbol}
										type="button"
										onClick={() => {
											setForm((current) =>
												current
													? {
															...current,
															symbol: candidate.symbol,
															name: candidate.name,
															currency: candidate.currency ?? current.currency,
															market: (candidate.market as Market) ?? current.market,
															price: candidate.price !== null ? String(candidate.price) : current.price,
														}
													: current,
											);
											setLookup({ loading: false, message: null, error: null, candidates: [] });
										}}
									>
										{candidate.symbol}
										{candidate.exchange ? ` · ${candidate.exchange}` : ""}
									</button>
								))}
							</div>
						</div>
					)}

					{form.class !== "cash" && (
						<div className="row">
							<label className="field">
								<span>行情数据源（可选，留空自动选择）</span>
								<select
									value={form.quoteSource}
									onChange={(e) => setForm({ ...form, quoteSource: e.target.value })}
								>
									<option value="">自动（按推荐顺序回退）</option>
									<option value="coingecko">CoinGecko</option>
									<option value="binance">Binance</option>
									<option value="yahoo">Yahoo Finance</option>
									<option value="tencent">腾讯行情</option>
									<option value="custom">自定义数据源</option>
								</select>
							</label>
							<label className="field">
								<span>行情代码覆盖（可选）</span>
								<input
									value={form.quoteSymbol}
									onChange={(e) => setForm({ ...form, quoteSymbol: e.target.value })}
									placeholder="如 bitcoin / 0700.HK / 600519.SS"
								/>
							</label>
						</div>
					)}

					<label className="field">
						<span>备注（可选）</span>
						<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
					</label>

					<div className="row">
						<button className="primary" type="submit" disabled={pending}>
							{pending ? "保存中…" : editingId ? "保存修改" : "创建持仓"}
						</button>
						<button
							type="button"
							onClick={() => {
								setForm(null);
								setEditingId(null);
							}}
						>
							取消
						</button>
					</div>
				</form>
			)}

			{!holdings.data ? (
				<div className="card panel">
					<div className="skeleton" style={{ height: 120 }} />
				</div>
			) : items.length === 0 ? (
				<div className="card empty">
					{allItems.length === 0
						? "还没有持仓。点击右上角「新建持仓」。"
						: "当前筛选条件下没有持仓，试试右上角「清除筛选」。"}
				</div>
			) : (
				<div className="card table-wrap">
					<table>
						<thead>
							<tr>
								{SORT_COLUMNS.map((column) => (
									<th
										key={column.key}
										className={`sortable ${column.className ?? ""}`}
										onClick={() => toggleSort(column.key)}
										title="点击切换排序"
									>
										{column.label}
										{sortKey === column.key && <span className="muted"> {sortDir === "asc" ? "▲" : "▼"}</span>}
									</th>
								))}
								<th>平均成本</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{items.map((holding) => {
								const days = daysSince(holding.price_updated_at);
								return (
									<tr key={holding.id} style={holding.archived === 1 ? { opacity: 0.55 } : undefined}>
										<td className="left">
											{holding.symbol ? <strong>{holding.symbol}</strong> : holding.name}
											{holding.symbol && <span className="muted small"> {holding.name}</span>}
											{holding.archived === 1 && <span className="badge"> 已归档</span>}
										</td>
										<td className="left hide-sm">
											<div className="cell-account">
												<BrandIcon iconKey={holding.account_icon_key} name={holding.account_name} size="sm" />
												{holding.account_name}
											</div>
										</td>
										<td className="left hide-sm">
											{CLASS_LABELS[holding.class]}
											{holding.market && (
												<span className="muted small">
													{" "}
													· {MARKET_LABELS[holding.market as Market] ?? holding.market}
												</span>
											)}
										</td>
										<td className="hide-sm">{number(holding.qty)}</td>
										<td>{holding.class === "cash" ? "1" : number(holding.price)}</td>
										<td>{money(holding.qty * holding.price, holding.currency)}</td>
										<td className={holding.class === "cash" ? "" : stalenessClass(days)}>
											{holding.class === "cash" ? "—" : relativeDays(days)}
										</td>
										<td>{holding.avg_cost === null ? "—" : number(holding.avg_cost)}</td>
										<td>
											<button className="ghost" onClick={() => startEdit(holding)}>
												编辑
											</button>
											<button className="ghost" onClick={() => toggleArchive(holding)}>
												{holding.archived === 1 ? "恢复" : "归档"}
											</button>
											<button className="ghost danger" onClick={() => remove(holding)}>
												删除
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			<div className="section">
				<div className="section-head">
					<h2>批量更新价格</h2>
					<span className="small muted hide-sm">
						v1 不接行情，价格需要手动维护；这里可以一屏改完一次提交
					</span>
					<div className="spacer" />
					<button className="primary" onClick={submitBulk} disabled={bulk.pending || changedCount === 0}>
						{bulk.pending ? "提交中…" : changedCount > 0 ? `提交 ${changedCount} 条` : "提交价格"}
					</button>
				</div>
				{pricedItems.length === 0 ? (
					<div className="card empty">没有需要更新价格的持仓。</div>
				) : (
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">名称</th>
									<th className="left hide-sm">账户</th>
									<th>当前价格</th>
									<th className="left">新价格</th>
									<th className="left hide-sm">变化</th>
								</tr>
							</thead>
							<tbody>
								{pricedItems.map((holding) => {
									const raw = prices[holding.id] ?? "";
									const parsed = Number(raw);
									const valid = raw !== "" && Number.isFinite(parsed);
									const delta = valid ? parsed - holding.price : null;
									const pct = valid && holding.price > 0 ? ((parsed - holding.price) / holding.price) * 100 : null;
									return (
										<tr key={holding.id}>
											<td className="left">{holding.symbol ?? holding.name}</td>
											<td className="left muted hide-sm">{holding.account_name}</td>
											<td>{number(holding.price)}</td>
											<td className="left">
												<input
													type="number"
													step="any"
													placeholder="留空表示不修改"
													value={raw}
													onChange={(e) => setPrices({ ...prices, [holding.id]: e.target.value })}
													style={{ maxWidth: 180 }}
												/>
											</td>
											<td
												className={`left hide-sm ${
													delta === null || delta === 0 ? "muted" : delta > 0 ? "positive" : "negative"
												}`}
											>
												{delta === null || delta === 0
													? "—"
													: `${delta > 0 ? "+" : ""}${number(delta)} (${
															pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`
														})`}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</>
	);
}
