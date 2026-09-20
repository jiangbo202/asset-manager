import { useState } from "react";
import { api, type AccountDto, type HoldingListDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { money, number, relativeDays, stalenessClass } from "../lib/format";
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
	note: string;
}

const emptyForm = (accountId: string): FormState => ({
	accountId,
	class: "stock",
	market: "us",
	symbol: "",
	name: "",
	currency: "USD",
	qty: "",
	price: "",
	avgCost: "",
	note: "",
});

export function HoldingsPage() {
	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(), []);
	const holdings = useAsync<{ items: HoldingListDto[] }>(() => api.holdings.list(), []);
	const [filterAccount, setFilterAccount] = useState("");
	const [form, setForm] = useState<FormState | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [prices, setPrices] = useState<Record<string, string>>({});
	const { pending, error, setError, run } = useSubmit();
	const bulk = useSubmit();

	const items = (holdings.data?.items ?? []).filter((item) => !filterAccount || item.account_id === filterAccount);
	const accountList = accounts.data?.items ?? [];

	const startCreate = () => {
		if (accountList.length === 0) {
			setError("请先在「账户」页创建一个账户");
			return;
		}
		setEditingId(null);
		setForm(emptyForm(accountList[0].id));
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
			note: holding.note ?? "",
		});
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form) return;
		if (form.name.trim() === "") {
			setError("名称不能为空");
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
				qty: Number(form.qty || 0),
				price: isCash ? 1 : Number(form.price || 0),
				avgCost: isCash || form.avgCost === "" ? null : Number(form.avgCost),
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

	const submitBulk = async () => {
		const changes = Object.entries(prices)
			.map(([id, value]) => ({ id, price: Number(value) }))
			.filter((item) => item.price > 0 && Number.isFinite(item.price));
		if (changes.length === 0) return;
		await bulk.run(async () => {
			await api.holdings.bulkPrice(changes);
			setPrices({});
			holdings.reload();
		});
	};

	return (
		<>
			<div className="section-head">
				<h2>持仓</h2>
				<div className="spacer" />
				<select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ width: 180 }}>
					<option value="">全部账户</option>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.name}
						</option>
					))}
				</select>
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
							<select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
								{accountList.map((account) => (
									<option key={account.id} value={account.id}>
										{account.name}
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
								<select value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value as Market | "" })}>
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
							<span>币种</span>
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
								<span>代码（如 AAPL / BTC）</span>
								<input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
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
									<span>当前价格（手动录入）</span>
									<input
										type="number"
										step="any"
										value={form.price}
										onChange={(e) => setForm({ ...form, price: e.target.value })}
										required
									/>
								</label>
								<label className="field">
									<span>平均成本（可选，用于算盈亏）</span>
									<input
										type="number"
										step="any"
										value={form.avgCost}
										onChange={(e) => setForm({ ...form, avgCost: e.target.value })}
									/>
								</label>
							</>
						)}
					</div>

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
				<div className="empty">加载中…</div>
			) : items.length === 0 ? (
				<div className="card empty">还没有持仓。</div>
			) : (
				<div className="card table-wrap">
					<table>
						<thead>
							<tr>
								<th className="left">名称</th>
								<th className="left">账户</th>
								<th className="left">类别</th>
								<th>数量</th>
								<th>价格</th>
								<th>平均成本</th>
								<th>市值（原币）</th>
								<th>价格更新</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{items.map((holding) => (
								<tr key={holding.id}>
									<td className="left">
										{holding.symbol ? <strong>{holding.symbol}</strong> : holding.name}
										{holding.symbol && <span className="muted small"> {holding.name}</span>}
									</td>
									<td className="left">{holding.account_name}</td>
									<td className="left">{CLASS_LABELS[holding.class]}</td>
									<td>{number(holding.qty)}</td>
									<td>{number(holding.price)}</td>
									<td>{holding.avg_cost === null ? "—" : number(holding.avg_cost)}</td>
									<td>{money(holding.qty * holding.price, holding.currency)}</td>
									<td className={stalenessClass(null)}>
										{relativeDays(
											holding.price_updated_at
												? Math.floor((Date.now() - Date.parse(holding.price_updated_at)) / 86_400_000)
												: null,
										)}
									</td>
									<td>
										<button className="ghost" onClick={() => startEdit(holding)}>
											编辑
										</button>
										<button className="ghost danger" onClick={() => remove(holding)}>
											删除
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="section">
				<div className="section-head">
					<h2>批量更新价格</h2>
					<span className="small muted">v1 不接行情，价格需要手动维护；这里可以一屏改完一次提交</span>
					<div className="spacer" />
					<button className="primary" onClick={submitBulk} disabled={bulk.pending || Object.keys(prices).length === 0}>
						{bulk.pending ? "提交中…" : "提交价格"}
					</button>
				</div>
				{items.filter((item) => item.class !== "cash").length === 0 ? (
					<div className="card empty">没有需要更新价格的持仓。</div>
				) : (
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">名称</th>
									<th className="left">账户</th>
									<th>当前价格</th>
									<th className="left">新价格</th>
								</tr>
							</thead>
							<tbody>
								{items
									.filter((item) => item.class !== "cash")
									.map((holding) => (
										<tr key={holding.id}>
											<td className="left">{holding.symbol ?? holding.name}</td>
											<td className="left muted">{holding.account_name}</td>
											<td>{number(holding.price)}</td>
											<td className="left">
												<input
													type="number"
													step="any"
													placeholder="留空表示不修改"
													value={prices[holding.id] ?? ""}
													onChange={(e) => setPrices({ ...prices, [holding.id]: e.target.value })}
													style={{ maxWidth: 200 }}
												/>
											</td>
										</tr>
									))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</>
	);
}
