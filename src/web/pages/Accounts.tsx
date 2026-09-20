import { useState } from "react";
import { api, type AccountDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { BrandIcon, defaultIconFor, IconPicker } from "../lib/icons";
import { useT } from "../lib/i18n";
import { money, percent } from "../lib/format";
import { ACCOUNT_KINDS, kindLabel, marketLabel, MARKETS, type AccountKind, type Market } from "../../shared/labels";

const CURRENCIES = ["USD", "HKD", "CNY"];

interface FormState {
	name: string;
	kind: AccountKind;
	currency: string;
	market: Market | "";
	iconKey: string | null;
	note: string;
}

const emptyForm = (): FormState => ({
	name: "",
	kind: "broker",
	currency: "USD",
	market: "us",
	iconKey: "broker",
	note: "",
});

export function AccountsPage() {
	const t = useT();
	const [showArchived, setShowArchived] = useState(false);
	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(showArchived), [showArchived]);
	const portfolio = useAsync(() => api.portfolio(), []);
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
			iconKey: account.icon_key,
			note: account.note ?? "",
		});
		setEditingId(account.id);
		setOpen(true);
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (form.name.trim() === "") {
			setError(t("accounts.errorNameRequired"));
			return;
		}
		await run(async () => {
			const payload = {
				name: form.name.trim(),
				kind: form.kind,
				currency: form.currency,
				market: form.kind === "cash" ? null : form.market || null,
				iconKey: form.iconKey,
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
		const confirmed = window.confirm(t("accounts.confirmDelete", { name: account.name }));
		if (!confirmed) return;
		await run(async () => {
			try {
				await api.accounts.remove(account.id);
			} catch {
				const cascade = window.confirm(t("accounts.confirmCascade"));
				if (!cascade) return;
				await api.accounts.remove(account.id, true);
			}
			accounts.reload();
			portfolio.reload();
		});
	};

	const toggleArchive = async (account: AccountDto) => {
		await run(async () => {
			await api.accounts.update(account.id, { archived: account.archived !== 1 });
			accounts.reload();
			portfolio.reload();
		});
	};

	const items = accounts.data?.items ?? [];
	// 每个账户的市值与占比（来自组合视图，已按显示币种折算）
	const shareByAccount = new Map((portfolio.data?.byAccount ?? []).map((entry) => [entry.key, entry]));
	const displayCurrency = portfolio.data?.displayCurrency ?? "USD";

	return (
		<>
			<div className="section-head">
				<h2>{t("accounts.title")}</h2>
				<div className="spacer" />
				<label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
					<input
						type="checkbox"
						checked={showArchived}
						style={{ width: "auto" }}
						onChange={(e) => setShowArchived(e.target.checked)}
					/>
					{t("accounts.showArchived")}
				</label>
				<button className="primary" onClick={startCreate}>
					{t("accounts.create")}
				</button>
			</div>

			{error && <div className="alert error">{error}</div>}

			{open && (
				<form className="card panel" onSubmit={submit} style={{ marginBottom: 16 }}>
					<div className="row">
						<label className="field">
							<span>{t("accounts.name")}</span>
							<input
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								placeholder={t("accounts.namePlaceholder")}
								required
							/>
						</label>
						<label className="field">
							<span>{t("accounts.kind")}</span>
							<select
								value={form.kind}
								onChange={(e) => {
									const kind = e.target.value as AccountKind;
									setForm({
										...form,
										kind,
										market: kind === "cash" ? "" : form.market,
										iconKey: form.iconKey ?? defaultIconFor(kind),
									});
								}}
							>
								{ACCOUNT_KINDS.map((kind) => (
									<option key={kind} value={kind}>
										{kindLabel(t, kind)}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>{t("accounts.currency")}</span>
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
								<span>{t("accounts.market")}</span>
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
					</div>

					<label className="field">
						<span>{t("accounts.note")}</span>
						<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
					</label>

					<label className="field">
						<span>{t("accounts.icon")}</span>
					</label>
					<IconPicker value={form.iconKey} onChange={(iconKey) => setForm({ ...form, iconKey })} />

					<div className="row" style={{ marginTop: 16 }}>
						<button className="primary" type="submit" disabled={pending}>
							{pending ? t("common.saving") : editingId ? t("common.saveChanges") : t("accounts.createSubmit")}
						</button>
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								setEditingId(null);
							}}
						>
							{t("common.cancel")}
						</button>
					</div>
				</form>
			)}

			{!accounts.data ? (
				<div className="empty">{t("common.loading")}</div>
			) : items.length === 0 ? (
				<div className="card empty">
					{showArchived ? t("accounts.emptyWithArchived") : t("accounts.empty")}
				</div>
			) : (
				<div className="card table-wrap">
					<table>
						<thead>
							<tr>
								<th className="left">{t("accounts.colAccount")}</th>
								<th className="left">{t("accounts.colKind")}</th>
								<th className="left">{t("accounts.colMarket")}</th>
								<th className="left">{t("accounts.colCurrency")}</th>
								<th className="left hide-sm">{t("accounts.colNote")}</th>
								<th>{t("accounts.colValue", { currency: displayCurrency })}</th>
								<th>{t("accounts.colShare")}</th>
								<th>{t("accounts.colActions")}</th>
							</tr>
						</thead>
						<tbody>
							{items.map((account) => (
								<tr key={account.id} style={account.archived === 1 ? { opacity: 0.55 } : undefined}>
									<td className="left">
										<div className="cell-account">
											<BrandIcon iconKey={account.icon_key} name={account.name} />
											{account.name}
											{account.archived === 1 && <span className="badge">{t("accounts.archivedBadge")}</span>}
										</div>
									</td>
									<td className="left">{kindLabel(t, account.kind)}</td>
									<td className="left">
										{account.market ? marketLabel(t, account.market as Market) : t("common.none")}
									</td>
									<td className="left">{account.currency}</td>
									<td className="left muted hide-sm">{account.note ?? t("common.none")}</td>
									<td>
										{account.archived === 1
											? t("common.none")
											: money(shareByAccount.get(account.id)?.value ?? 0, displayCurrency)}
									</td>
									<td>
										{account.archived === 1 ? t("common.none") : percent(shareByAccount.get(account.id)?.share ?? 0)}
									</td>
									<td>
										<button className="ghost" onClick={() => startEdit(account)}>
											{t("common.edit")}
										</button>
										<button className="ghost" onClick={() => toggleArchive(account)}>
											{account.archived === 1 ? t("accounts.restore") : t("accounts.archive")}
										</button>
										<button className="ghost danger" onClick={() => remove(account)}>
											{t("common.delete")}
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<p className="small muted" style={{ marginTop: 12 }}>
				{t("accounts.archiveHint")}
			</p>
		</>
	);
}
