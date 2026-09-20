import { useState } from "react";
import { api, type ImportPreview, type ImportResult, type SettingsDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { useT, useI18n } from "../lib/i18n";
import { dateTime } from "../lib/format";
import { decryptBackup, deriveCredential, encryptBackup, isEncryptedBackup, ITERATIONS, randomSaltHex } from "../lib/crypto";
import { downloadText, humanSize } from "../lib/download";
import { MarketDataSection } from "./MarketDataSection";
import { LANGUAGES, LANGUAGE_LABELS, type LanguageSetting } from "../../shared/i18n";

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
	const t = useT();
	const i18n = useI18n();
	const settings = useAsync<SettingsDto>(() => api.settings.get(), []);
	const overview = useAsync(() => api.settings.overview(), []);
	const [base, setBase] = useState("USD");
	const [quote, setQuote] = useState("HKD");
	const [rate, setRate] = useState("");
	const fx = useSubmit();
	const display = useSubmit();
	const pwd = useSubmit();
	const language = useSubmit();

	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");

	// 备份导出
	const [includeAudit, setIncludeAudit] = useState(true);
	const [encryptExport, setEncryptExport] = useState(false);
	const [exportPassphrase, setExportPassphrase] = useState("");
	const [lastExportSize, setLastExportSize] = useState<number | null>(null);
	const backupExport = useSubmit();

	// 备份导入
	const [importFileName, setImportFileName] = useState("");
	const [importText, setImportText] = useState<string | null>(null);
	const [needPassphrase, setNeedPassphrase] = useState(false);
	const [importPassphrase, setImportPassphrase] = useState("");
	const [payload, setPayload] = useState<unknown>(null);
	const [mode, setMode] = useState<"merge" | "replace">("merge");
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const backupImport = useSubmit();

	const values = settings.data?.values ?? {};
	const displayCurrency = values.display_currency ?? "USD";
	const rowEntries = Object.entries(overview.data?.rows ?? {});
	const limits = overview.data?.limits ?? {};

	const changeDisplay = async (currency: string) => {
		await display.run(async () => {
			await api.settings.update({ displayCurrency: currency });
			settings.reload();
			onChanged?.();
		});
	};

	const changeLanguage = async (value: LanguageSetting) => {
		// 先切界面（立即生效），再落库
		i18n.setSetting(value);
		await language.run(async () => {
			await api.settings.update({ language: value });
			settings.reload();
		});
	};

	const addFx = async (event: React.FormEvent) => {
		event.preventDefault();
		const parsed = Number(rate);
		if (!Number.isFinite(parsed) || parsed <= 0) return;
		await fx.run(async () => {
			await api.settings.putFx({ base: base.toUpperCase(), quote: quote.toUpperCase(), rate: parsed });
			setRate("");
			settings.reload();
			onChanged?.();
		});
	};

	const removeFx = async (from: string, to: string) => {
		if (!window.confirm(t("settings.fxConfirmDelete", { from, to }))) return;
		await fx.run(async () => {
			await api.settings.deleteFx(from, to);
			settings.reload();
			onChanged?.();
		});
	};

	const changePassword = async (event: React.FormEvent) => {
		event.preventDefault();
		if (newPassword.length < 12) return;
		await pwd.run(async () => {
			const params = await api.auth.params();
			if (!params.kdfSalt) throw new Error(t("error.not_initialized"));
			const oldCredential = await deriveCredential(oldPassword, params.kdfSalt, params.iterations);
			const kdfSalt = randomSaltHex();
			const newCredential = await deriveCredential(newPassword, kdfSalt, ITERATIONS);
			await api.auth.changePassword({ oldCredential, newCredential, kdfSalt, iterations: ITERATIONS });
			setOldPassword("");
			setNewPassword("");
		});
	};

	const runExport = async () => {
		await backupExport.run(async () => {
			const plain = await api.backup.exportText(includeAudit);
			const text = encryptExport ? await encryptBackup(plain, exportPassphrase) : plain;
			const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
			downloadText(`asset-manager-backup-${stamp}${encryptExport ? "-encrypted" : ""}.json`, text);
			setLastExportSize(text.length);
		});
	};

	const onPickFile = async (file: File | null) => {
		setPreview(null);
		setResult(null);
		setPayload(null);
		if (!file) {
			setImportFileName("");
			setImportText(null);
			setNeedPassphrase(false);
			return;
		}
		const text = await file.text();
		setImportFileName(file.name);
		setImportText(text);
		setNeedPassphrase(isEncryptedBackup(text));
		if (!isEncryptedBackup(text)) {
			try {
				setPayload(JSON.parse(text));
			} catch {
				backupImport.setError(t("error.invalid_backup"));
			}
		}
	};

	const preparePayload = async (): Promise<unknown | null> => {
		if (payload) return payload;
		if (!importText) return null;
		if (needPassphrase) {
			const plain = await decryptBackup(importText, importPassphrase);
			const parsed = JSON.parse(plain) as unknown;
			setPayload(parsed);
			return parsed;
		}
		const parsed = JSON.parse(importText) as unknown;
		setPayload(parsed);
		return parsed;
	};

	const runPreview = async () => {
		await backupImport.run(async () => {
			const data = await preparePayload();
			if (!data) throw new Error(t("settings.needFile"));
			const response = await api.backup.import(data, mode, true);
			setPreview(response.preview);
		});
	};

	const runImport = async () => {
		if (!preview) return;
		if (mode === "replace" && !window.confirm(t("settings.importConfirmReplace"))) return;
		await backupImport.run(async () => {
			const data = payload ?? (await preparePayload());
			if (!data) throw new Error(t("settings.needFile"));
			const response = await api.backup.import(data, mode, false);
			setResult(response);
			setPreview(null);
			settings.reload();
			overview.reload();
			onChanged?.();
		});
	};

	return (
		<>
			<div className="section-head">
				<h2>{t("settings.title")}</h2>
			</div>

			<div className="grid cols-2">
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.displayCurrency")}</h3>
					<p className="small muted">{t("settings.displayCurrencyHint")}</p>
					{(display.error || fx.error) && <div className="alert error">{display.error ?? fx.error}</div>}
					<select value={displayCurrency} onChange={(e) => changeDisplay(e.target.value)} disabled={display.pending}>
						{(settings.data?.currencies ?? ["USD", "HKD", "CNY"]).map((currency) => (
							<option key={currency} value={currency}>
								{currency}
							</option>
						))}
					</select>
					<p className="small muted" style={{ marginBottom: 0 }}>
						{t("settings.addCurrencyHint")}
					</p>
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.language")}</h3>
					<p className="small muted">{t("settings.languageHint")}</p>
					{language.error && <div className="alert error">{language.error}</div>}
					<select
						value={i18n.setting}
						onChange={(e) => void changeLanguage(e.target.value as LanguageSetting)}
						disabled={language.pending}
					>
						{LANGUAGES.map((value) => (
							<option key={value} value={value}>
								{LANGUAGE_LABELS[value]}
							</option>
						))}
					</select>
					<p className="small muted" style={{ marginBottom: 0 }}>
						{t("settings.priceSource")}
					</p>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>{t("settings.fx")}</h2>
					<span className="small muted hide-sm">{t("settings.fxHint")}</span>
				</div>
				<div className="card">
					<form className="panel row" onSubmit={addFx}>
						<label className="field">
							<span>{t("settings.fxBase")}</span>
							<input value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} maxLength={5} />
						</label>
						<label className="field">
							<span>{t("settings.fxQuote")}</span>
							<input value={quote} onChange={(e) => setQuote(e.target.value.toUpperCase())} maxLength={5} />
						</label>
						<label className="field">
							<span>{t("settings.fxPair", { base: base.toUpperCase(), quote: quote.toUpperCase() })}</span>
							<input type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
						</label>
						<div className="field" style={{ display: "grid", alignContent: "end" }}>
							<button className="primary" type="submit" disabled={fx.pending}>
								{t("settings.fxSave")}
							</button>
						</div>
					</form>

					{settings.data && settings.data.fx.length > 0 && (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">{t("settings.fxRate")}</th>
										<th className="left">{t("market.colProvider")}</th>
										<th className="left hide-sm">{t("settings.fxUpdatedAt")}</th>
										<th>{t("accounts.colActions")}</th>
									</tr>
								</thead>
								<tbody>
									{settings.data.fx.map((item) => (
										<tr key={`${item.base}:${item.quote}`}>
											<td className="left">
												1 {item.base} = {item.rate} {item.quote}
											</td>
											<td className="left muted small">
												{item.source === "auto" ? t("settings.fxSourceAuto") : t("settings.fxSourceManual")}
											</td>
											<td className="left muted hide-sm">{dateTime(item.updated_at)}</td>
											<td>
												<button className="ghost danger" onClick={() => removeFx(item.base, item.quote)}>
													{t("common.delete")}
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>{t("settings.backup")}</h2>
					<span className="small muted hide-sm">{t("settings.backupHint")}</span>
				</div>

				<div className="grid cols-2">
					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.export")}</h3>
						{backupExport.error && <div className="alert error">{backupExport.error}</div>}
						<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
							<input
								type="checkbox"
								checked={includeAudit}
								style={{ width: "auto" }}
								onChange={(e) => setIncludeAudit(e.target.checked)}
							/>
							{t("settings.exportIncludeAudit")}
						</label>
						<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
							<input
								type="checkbox"
								checked={encryptExport}
								style={{ width: "auto" }}
								onChange={(e) => setEncryptExport(e.target.checked)}
							/>
							{t("settings.exportEncrypt")}
						</label>
						{encryptExport && (
							<label className="field">
								<span>{t("settings.exportPassphrase")}</span>
								<input
									type="password"
									value={exportPassphrase}
									onChange={(e) => setExportPassphrase(e.target.value)}
									placeholder={t("settings.exportPassphrasePlaceholder")}
								/>
							</label>
						)}
						<button
							className="primary"
							onClick={runExport}
							disabled={backupExport.pending || (encryptExport && exportPassphrase.length < 8)}
						>
							{backupExport.pending ? t("settings.exporting") : t("settings.exportButton")}
						</button>
						{lastExportSize !== null && (
							<p className="small muted" style={{ marginBottom: 0 }}>
								{t("settings.lastExportSize", { size: humanSize(lastExportSize) })}
							</p>
						)}
						<p className="small muted" style={{ marginBottom: 0 }}>
							{t("settings.exportNoSecret")}
						</p>
					</div>

					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.import")}</h3>
						{backupImport.error && <div className="alert error">{backupImport.error}</div>}
						{result && (
							<div className="alert">
								{t("settings.importDone", {
									statements: result.applied?.statements ?? 0,
									mode: result.applied?.atomic ? t("settings.importAtomic") : t("settings.importChunked"),
								})}
								<button className="ghost" onClick={() => window.location.reload()}>
									{t("settings.reloadPage")}
								</button>
							</div>
						)}

						<label className="field">
							<span>{t("settings.pickFile")}</span>
							<input
								type="file"
								accept="application/json,.json"
								onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
							/>
						</label>
						{importFileName && (
							<p className="small muted" style={{ marginTop: -6 }}>
								{t("settings.pickedFile", { name: importFileName })}
								{needPassphrase && t("settings.pickedFileEncrypted")}
							</p>
						)}

						{needPassphrase && (
							<label className="field">
								<span>{t("settings.decryptPassphrase")}</span>
								<input
									type="password"
									value={importPassphrase}
									onChange={(e) => {
										setImportPassphrase(e.target.value);
										setPayload(null);
										setPreview(null);
									}}
								/>
							</label>
						)}

						<label className="field">
							<span>{t("settings.importMode")}</span>
							<select
								value={mode}
								onChange={(e) => {
									setMode(e.target.value as "merge" | "replace");
									setPreview(null);
								}}
							>
								<option value="merge">{t("settings.importModeMerge")}</option>
								<option value="replace">{t("settings.importModeReplace")}</option>
							</select>
						</label>

						<div className="row">
							<button onClick={runPreview} disabled={backupImport.pending || !importText}>
								{backupImport.pending ? t("settings.previewing") : t("settings.previewDiff")}
							</button>
							<button className="danger" onClick={runImport} disabled={backupImport.pending || !preview}>
								{t("settings.confirmImport")}
							</button>
						</div>

						{preview && (
							<div style={{ marginTop: 12 }}>
								<div className="table-wrap">
									<table>
										<thead>
											<tr>
												<th className="left">{t("settings.colEntity")}</th>
												<th>{t("settings.colCreate")}</th>
												<th>{t("settings.colUpdate")}</th>
												<th>{t("settings.colRemove")}</th>
											</tr>
										</thead>
										<tbody>
											{Object.entries(preview.summary)
												.filter(([, diff]) => diff.create + diff.update + diff.remove > 0)
												.map(([entity, diff]) => (
													<tr key={entity}>
														<td className="left">{t(`settings.row.${entity}`)}</td>
														<td>{diff.create}</td>
														<td>{diff.update}</td>
														<td>{diff.remove || t("common.none")}</td>
													</tr>
												))}
										</tbody>
									</table>
								</div>
								{preview.warnings.length > 0 && (
									<div className="alert" style={{ marginTop: 10 }}>
										{preview.warnings.map((warning) => (
											<div key={warning}>· {warning}</div>
										))}
									</div>
								)}
							</div>
						)}

						<p className="small muted" style={{ marginBottom: 0 }}>
							{t("settings.importHint")}
						</p>
					</div>
				</div>
			</div>

			<MarketDataSection
				settings={settings.data}
				onSaved={() => {
					settings.reload();
					overview.reload();
					onChanged?.();
				}}
			/>

			<div className="section">
				<div className="section-head">
					<h2>{t("settings.security")}</h2>
				</div>
				<div className="grid cols-2">
					<form className="card panel" onSubmit={changePassword}>
						<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.changePassword")}</h3>
						{pwd.error && <div className="alert error">{pwd.error}</div>}
						<label className="field">
							<span>{t("changePwd.current")}</span>
							<input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required />
						</label>
						<label className="field">
							<span>{t("changePwd.new")}</span>
							<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
						</label>
						<button className="primary" type="submit" disabled={pwd.pending}>
							{pwd.pending ? t("changePwd.submitting") : t("settings.changePassword")}
						</button>
						<p className="small muted" style={{ marginBottom: 0 }}>
							{t("settings.pwdHint")}
						</p>
					</form>

					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.sessions")}</h3>
						<p className="small muted">
							{t("settings.sessionsActive", { count: overview.data?.rows.sessions ?? 0 })}
						</p>
						<button
							className="danger"
							onClick={async () => {
								if (!window.confirm(t("settings.logoutAllConfirm"))) return;
								await api.auth.logoutAll();
								window.location.reload();
							}}
						>
							{t("settings.logoutAll")}
						</button>
						<p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
							{t("settings.setupAt", { time: dateTime(values.setup_done_at ?? null) })}
						</p>
					</div>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>{t("settings.overview")}</h2>
					<span className="small muted hide-sm">{t("settings.overviewHint")}</span>
				</div>
				<div className="card panel">
					<div className="grid cols-4">
						{rowEntries.map(([key, value]) => (
							<div key={key}>
								<div className="label small muted">{t(`settings.row.${key}`)}</div>
								<div style={{ fontWeight: 600 }}>{t("settings.rows", { value: value.toLocaleString() })}</div>
							</div>
						))}
					</div>
					<p className="small muted" style={{ marginBottom: 0 }}>
						{t("settings.limits", {
							reads: Number(limits.d1RowsReadPerDay ?? 0).toLocaleString(),
							writes: Number(limits.d1RowsWrittenPerDay ?? 0).toLocaleString(),
							cpu: limits.workerCpuMsPerRequest ?? 10,
						})}
					</p>
				</div>
			</div>

			<p className="small muted" style={{ marginTop: 24 }}>
				{t("settings.disclaimer")}
			</p>
		</>
	);
}
