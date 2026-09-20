import { useMemo, useState } from "react";
import { api, type AccountDto, type HoldingListDto, type LookupCandidate } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { BrandIcon } from "../lib/icons";
import { useT } from "../lib/i18n";
import { money, number, relativeDays, stalenessClass } from "../lib/format";
import {
	ASSET_CLASSES,
	classLabel,
	marketLabel,
	matchesMarketFilter,
	MARKETS,
	type AssetClass,
	type Market,
} from "../../shared/labels";
import { useRouter } from "../lib/router";
import { MarketFilter, parseMarketParam } from "../components/MarketFilter";

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

export function HoldingsPage() {
	const t = useT();
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

	const sortColumns: Array<{ key: SortKey; label: string; className?: string }> = [
		{ key: "name", label: t("dashboard.colName"), className: "left" },
		{ key: "account", label: t("dashboard.colAccount"), className: "left hide-sm" },
		{ key: "class", label: t("dashboard.colClass"), className: "left hide-sm" },
		{ key: "qty", label: t("dashboard.colQty"), className: "hide-sm" },
		{ key: "price", label: t("dashboard.colPrice") },
		{ key: "value", label: t("holdings.colValue") },
		{ key: "stale", label: t("dashboard.colPriceUpdated") },
	];

	const items = useMemo(() => {
		const filtered = allItems.filter(
			(item) =>
				(!filterAccount || item.account_id === filterAccount) &&
				(!filterClass || item.class === filterClass) &&
				matchesMarketFilter(item, filterMarkets) &&
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
				return String(left).localeCompare(String(right)) * direction;
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
			setError(t("holdings.errorNeedAccount"));
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
	const runLookup = async (options: { fillPrice: boolean; force?: boolean }) => {
		if (!form) return;
		const symbol = form.symbol.trim();
		if (!symbol) {
			setLookup({ loading: false, message: null, error: t("holdings.lookupNeedSymbol"), candidates: [] });
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
						? t("holdings.lookupRateLimited")
						: (result.errors[0] ?? t("holdings.lookupNoResult")),
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

			setLookup({
				loading: false,
				message:
					(result.cached ? t("holdings.lookupCached") : "") +
					t("holdings.lookupMatched", {
						source: best.source,
						name: best.name,
						price:
							best.price !== null
								? t("holdings.lookupPrice", { price: best.price, currency: best.currency ?? "" })
								: "",
					}),
				error: null,
				candidates: result.candidates,
			});
		} catch (lookupError) {
			setLookup({
				loading: false,
				message: null,
				error: lookupError instanceof Error ? lookupError.message : t("error.requestFailed"),
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
			setError(t("holdings.errorNameRequired"));
			return;
		}
		if (form.qty === "" || Number.isNaN(Number(form.qty))) {
			setError(form.class === "cash" ? t("holdings.errorBalanceNumber") : t("holdings.errorQtyNumber"));
			return;
		}
		if (form.class !== "cash" && (form.price === "" || Number.isNaN(Number(form.price)))) {
			setError(t("holdings.errorPriceNumber"));
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
			setLookup({ loading: false, message: null, error: null, candidates: [] });
			holdings.reload();
		});
	};

	const remove = async (holding: HoldingListDto) => {
		if (!window.confirm(t("holdings.confirmDelete", { name: holding.name }))) return;
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
				<h2>{t("holdings.title")}</h2>
				<div className="spacer" />
				<label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
					<input
						type="checkbox"
						checked={showArchived}
						style={{ width: "auto" }}
						onChange={(e) => setQuery({ archived: e.target.checked ? "1" : null })}
					/>
					{t("accounts.showArchived")}
				</label>
				<select
					value={filterAccount}
					onChange={(e) => setQuery({ account: e.target.value || null })}
					style={{ width: 170 }}
				>
					<option value="">{t("dashboard.allAccounts")}</option>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.name}
						</option>
					))}
				</select>
				<select value={filterClass} onChange={(e) => setQuery({ class: e.target.value || null })} style={{ width: 130 }}>
					<option value="">{t("dashboard.allClasses")}</option>
					{ASSET_CLASSES.map((value) => (
						<option key={value} value={value}>
							{classLabel(t, value)}
						</option>
					))}
				</select>
				<div className="chips" style={{ marginLeft: 4 }}>
					<span className="small muted">{t("accounts.market")}:</span>
					<MarketFilter selected={filterMarkets} onChange={(next) => setQuery({ market: next.join(",") || null })} />
				</div>
				{hasFilter && (
					<button className="ghost" onClick={() => setQuery({ account: null, class: null, market: null })}>
						{t("dashboard.clearFilters")}
					</button>
				)}
				<button className="primary" onClick={startCreate}>
					{t("holdings.create")}
				</button>
			</div>

			{error && <div className="alert error">{error}</div>}
			{bulk.error && <div className="alert error">{bulk.error}</div>}

			{form && (
				<form className="card panel" onSubmit={submit} style={{ marginBottom: 16 }}>
					<div className="row">
						<label className="field">
							<span>{t("holdings.account")}</span>
							<select value={form.accountId} onChange={(e) => changeAccount(e.target.value)}>
								{accountList.map((account) => (
									<option key={account.id} value={account.id}>
										{account.name}（{account.currency}）
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>{t("holdings.class")}</span>
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
										{classLabel(t, value)}
									</option>
								))}
							</select>
						</label>
						{form.class !== "cash" && (
							<label className="field">
								<span>{t("holdings.market")}</span>
								<select
									value={form.market}
									onChange={(e) => setForm({ ...form, market: e.target.value as Market | "" })}
								>
									<option value="">{t("mkt.none")}</option>
									{MARKETS.map((market) => (
										<option key={market} value={market}>
											{marketLabel(t, market)}
										</option>
									))}
								</select>
							</label>
						)}
						<label className="field">
							<span>{t("holdings.currencyFollowAccount")}</span>
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
								<span>{t("holdings.symbolLabel")}</span>
								<div className="input-with-button">
									<input
										value={form.symbol}
										onChange={(e) => setForm({ ...form, symbol: e.target.value })}
										onBlur={() => {
											if (form.symbol.trim() && !form.name.trim()) void runLookup({ fillPrice: false });
										}}
										placeholder={t("holdings.symbolPlaceholder")}
									/>
									<button
										type="button"
										onClick={() => void runLookup({ fillPrice: false })}
										disabled={lookup.loading || !form.symbol.trim()}
									>
										{lookup.loading ? t("holdings.lookupLoading") : t("holdings.lookupName")}
									</button>
								</div>
							</label>
						)}
						<label className="field">
							<span>{t("holdings.name")}</span>
							<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
						</label>
					</div>

					<div className="row">
						<label className="field">
							<span>{form.class === "cash" ? t("holdings.balance") : t("holdings.qty")}</span>
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
									<span>{t("holdings.price")}</span>
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
										>
											{lookup.loading ? "…" : t("holdings.fetchPrice")}
										</button>
									</div>
								</label>
								<label className="field">
									<span>{t("holdings.avgCost")}</span>
									<input
										type="number"
										step="any"
										value={form.avgCost}
										onChange={(e) => setForm({ ...form, avgCost: e.target.value })}
										placeholder={t("holdings.avgCostPlaceholder")}
									/>
								</label>
							</>
						)}
					</div>

					{form.class === "cash" && <div className="small muted" style={{ marginBottom: 12 }}>{t("holdings.cashHint")}</div>}

					{lookup.error && <div className="alert error">{lookup.error}</div>}
					{lookup.message && (
						<div className="small" style={{ marginBottom: 12 }}>
							{lookup.message}
						</div>
					)}
					{lookup.candidates.length > 1 && (
						<div style={{ marginBottom: 12 }}>
							<div className="small muted">{t("holdings.candidatesHint")}</div>
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
								<span>{t("holdings.quoteSource")}</span>
								<select
									value={form.quoteSource}
									onChange={(e) => setForm({ ...form, quoteSource: e.target.value })}
								>
									<option value="">{t("holdings.quoteSourceAuto")}</option>
									<option value="coingecko">CoinGecko</option>
									<option value="binance">Binance</option>
									<option value="yahoo">Yahoo Finance</option>
									<option value="tencent">Tencent</option>
									<option value="custom">{t("provider.custom.label")}</option>
								</select>
							</label>
							<label className="field">
								<span>{t("holdings.quoteSymbol")}</span>
								<input
									value={form.quoteSymbol}
									onChange={(e) => setForm({ ...form, quoteSymbol: e.target.value })}
									placeholder={t("holdings.quoteSymbolPlaceholder")}
								/>
							</label>
						</div>
					)}

					<label className="field">
						<span>{t("holdings.note")}</span>
						<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
					</label>

					<div className="row">
						<button className="primary" type="submit" disabled={pending}>
							{pending ? t("common.saving") : editingId ? t("common.saveChanges") : t("holdings.createSubmit")}
						</button>
						<button
							type="button"
							onClick={() => {
								setForm(null);
								setEditingId(null);
								setLookup({ loading: false, message: null, error: null, candidates: [] });
							}}
						>
							{t("common.cancel")}
						</button>
					</div>
				</form>
			)}

			{!holdings.data ? (
				<div className="card panel">
					<div className="skeleton" style={{ height: 120 }} />
				</div>
			) : items.length === 0 ? (
				<div className="card empty">{allItems.length === 0 ? t("holdings.empty") : t("holdings.emptyFiltered")}</div>
			) : (
				<div className="card table-wrap">
					<table>
						<thead>
							<tr>
								{sortColumns.map((column) => (
									<th
										key={column.key}
										className={`sortable ${column.className ?? ""}`}
										onClick={() => toggleSort(column.key)}
									>
										{column.label}
										{sortKey === column.key && <span className="muted"> {sortDir === "asc" ? "▲" : "▼"}</span>}
									</th>
								))}
								<th>{t("holdings.colAvgCost")}</th>
								<th>{t("holdings.colActions")}</th>
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
											{holding.archived === 1 && <span className="badge"> {t("accounts.archivedBadge")}</span>}
										</td>
										<td className="left hide-sm">
											<div className="cell-account">
												<BrandIcon iconKey={holding.account_icon_key} name={holding.account_name} size="sm" />
												{holding.account_name}
											</div>
										</td>
										<td className="left hide-sm">
											{classLabel(t, holding.class)}
											{holding.market && (
												<span className="muted small"> · {marketLabel(t, holding.market as Market)}</span>
											)}
										</td>
										<td className="hide-sm">{number(holding.qty)}</td>
										<td>{holding.class === "cash" ? "1" : number(holding.price)}</td>
										<td>{money(holding.qty * holding.price, holding.currency)}</td>
										<td className={holding.class === "cash" ? "" : stalenessClass(days)}>
											{holding.class === "cash" ? t("common.none") : relativeDays(t, days)}
										</td>
										<td>{holding.avg_cost === null ? t("common.none") : number(holding.avg_cost)}</td>
										<td>
											<button className="ghost" onClick={() => startEdit(holding)}>
												{t("common.edit")}
											</button>
											<button className="ghost" onClick={() => toggleArchive(holding)}>
												{holding.archived === 1 ? t("accounts.restore") : t("accounts.archive")}
											</button>
											<button className="ghost danger" onClick={() => remove(holding)}>
												{t("common.delete")}
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
					<h2>{t("holdings.bulkTitle")}</h2>
					<span className="small muted hide-sm">{t("holdings.bulkHint")}</span>
					<div className="spacer" />
					<button className="primary" onClick={submitBulk} disabled={bulk.pending || changedCount === 0}>
						{bulk.pending
							? t("holdings.bulkSubmitting")
							: changedCount > 0
								? t("holdings.bulkSubmitCount", { count: changedCount })
								: t("holdings.bulkSubmit")}
					</button>
				</div>
				{pricedItems.length === 0 ? (
					<div className="card empty">{t("holdings.bulkEmpty")}</div>
				) : (
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">{t("dashboard.colName")}</th>
									<th className="left hide-sm">{t("dashboard.colAccount")}</th>
									<th>{t("holdings.bulkColCurrent")}</th>
									<th className="left">{t("holdings.bulkColNew")}</th>
									<th className="left hide-sm">{t("holdings.bulkColDelta")}</th>
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
													placeholder={t("holdings.bulkPlaceholder")}
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
													? t("common.none")
													: `${delta > 0 ? "+" : ""}${number(delta)} (${
															pct === null ? t("common.none") : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`
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
