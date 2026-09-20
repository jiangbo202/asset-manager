import { useState } from "react";
import { api, type AccountDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { brandColor, initialOf, isColorDark } from "../lib/brands";
import { ACCOUNT_KINDS, KIND_LABELS, MARKET_LABELS, MARKETS, type AccountKind, type Market } from "../../shared/labels";

const CURRENCIES = ["USD", "HKD", "CNY"];

interface FormState {
	name: string;
	kind: AccountKind;
	currency: string;
	market: Market | "";
	note: string;
}

const emptyForm = (): FormState => ({ name: "", kind: "broker", currency: "USD", market: "us", note: "" });

export function AccountsPage() {
	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(), []);
	const [form, setForm] = useState<FormState>(emptyForm());
	const [editingId, setEditingId] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const { pending, error, setError, run } = useSubmit();

	const startCreate = () => {
		setForm(emptyForm());
		setEditingId(null);
		setOpen(true);
	};

	const startEdit = (account: AccountDto) => {
		setForm({
			name: account.name,
			kind: account.kind,
			currency: account.currency,
			market: (account.market as Market | null) ?? "",
			note: account.note ?? "",
		});
		setEditingId(account.id);
		setOpen(true);
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (form.name.trim() === "") {
			setError("账户名称不能为空");
			return;
		}
		await run(async () => {
			const payload = {
				name: form.name.trim(),
				kind: form.kind,
				currency: form.currency,
				market: form.market || null,
				note: form.note.trim() || null,
			};
			if (editingId) await api.accounts.update(editingId, payload);
			else await api.accounts.create(payload);
			setOpen(false);
			setEditingId(null);
			accounts.reload();
		});
	};

	const remove = async (account: AccountDto) => {
		const confirmed = window.confirm(`确定删除账户「${account.name}」？该操作会记录在操作历史中。`);
		if (!confirmed) return;
		await run(async () => {
			try {
				await api.accounts.remove(account.id);
			} catch {
				const cascade = window.confirm("该账户下还有持仓，是否连同持仓一起删除？");
				if (!cascade) return;
				await api.accounts.remove(account.id, true);
			}
			accounts.reload();
		});
	};

	return (
		<>
			<div className="section-head">
				<h2>账户</h2>
				<div className="spacer" />
				<button className="primary" onClick={startCreate}>
					新建账户
				</button>
			</div>

			{error && <div className="alert error">{error}</div>}

			{open && (
				<form className="card panel" onSubmit={submit} style={{ marginBottom: 16 }}>
					<div className="row">
						<label className="field">
							<span>名称</span>
							<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
						</label>
						<label className="field">
							<span>类型</span>
							<select
								value={form.kind}
								onChange={(e) => {
									const kind = e.target.value as AccountKind;
									setForm({ ...form, kind, market: kind === "cash" ? "" : form.market });
								}}
							>
								{ACCOUNT_KINDS.map((kind) => (
									<option key={kind} value={kind}>
										{KIND_LABELS[kind]}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>币种</span>
							<select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
								{CURRENCIES.map((currency) => (
									<option key={currency} value={currency}>
										{currency}
									</option>
								))}
							</select>
						</label>
						{form.kind !== "cash" && (
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
					</div>
					<label className="field">
						<span>备注（可选）</span>
						<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
					</label>
					<div className="row">
						<button className="primary" type="submit" disabled={pending}>
							{pending ? "保存中…" : editingId ? "保存修改" : "创建账户"}
						</button>
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								setEditingId(null);
							}}
						>
							取消
						</button>
					</div>
				</form>
			)}

			{!accounts.data ? (
				<div className="empty">加载中…</div>
			) : accounts.data.items.length === 0 ? (
				<div className="card empty">还没有账户。点击右上角「新建账户」开始。</div>
			) : (
				<div className="card table-wrap">
					<table>
						<thead>
							<tr>
								<th className="left">账户</th>
								<th className="left">类型</th>
								<th className="left">市场</th>
								<th className="left">币种</th>
								<th className="left">备注</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{accounts.data.items.map((account) => {
								const color = brandColor(account.icon_key, account.name);
								return (
									<tr key={account.id}>
										<td className="left">
											<div className="cell-account">
												<span
													className="avatar"
													style={{ background: color, color: isColorDark(color) ? "#fff" : "#101418" }}
												>
													{initialOf(account.name)}
												</span>
												{account.name}
											</div>
										</td>
										<td className="left">{KIND_LABELS[account.kind]}</td>
										<td className="left">
											{account.market ? (MARKET_LABELS[account.market as Market] ?? account.market) : "—"}
										</td>
										<td className="left">{account.currency}</td>
										<td className="left muted">{account.note ?? "—"}</td>
										<td>
											<button className="ghost" onClick={() => startEdit(account)}>
												编辑
											</button>
											<button className="ghost danger" onClick={() => remove(account)}>
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
		</>
	);
}
