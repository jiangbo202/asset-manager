import { useState } from "react";
import {
	api,
	type CfUsageStateDto,
	type ImportPreview,
	type ImportResult,
	type SessionItemDto,
	type SettingsDto,
} from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { useT, useI18n, useTimeZone } from "../lib/i18n";
import { dateTime, relativeTime } from "../lib/format";
import { decryptBackup, deriveCredential, encryptBackup, isEncryptedBackup, ITERATIONS, randomSaltHex } from "../lib/crypto";
import { downloadText, humanSize } from "../lib/download";
import { MarketDataSection } from "./MarketDataSection";
import { LANGUAGES, LANGUAGE_LABELS, type LanguageSetting } from "../../shared/i18n";
import { COMMON_TIMEZONES, isValidTimeZone, offsetLabel } from "../../shared/time";
import { describeUserAgent } from "../../shared/device";
import { parsePublicSections, PUBLIC_SECTIONS, type PublicSection } from "../../shared/public-sections";

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
	const t = useT();
	const i18n = useI18n();
	const timeZone = useTimeZone();
	const settings = useAsync<SettingsDto>(() => api.settings.get(), []);
	const overview = useAsync(() => api.settings.overview(), []);
	const [base, setBase] = useState("USD");
	const [quote, setQuote] = useState("HKD");
	const [rate, setRate] = useState("");
	const [fxNotice, setFxNotice] = useState<string | null>(null);
	const fx = useSubmit();
	const fxFetch = useSubmit();
	const display = useSubmit();
	const pwd = useSubmit();
	const language = useSubmit();

	const publicView = useSubmit();
	const publicSections = useSubmit();
	const [copied, setCopied] = useState(false);

	const usage = useAsync<CfUsageStateDto>(() => api.settings.usage(), []);
	const usageRefresh = useSubmit();
	const [usageToken, setUsageToken] = useState("");
	const [usageAccount, setUsageAccount] = useState("");
	const [usageScript, setUsageScript] = useState("");
	const [usageDatabase, setUsageDatabase] = useState("");
	// 服务端已有值时，输入框留空表示"不修改"（Token 只写不读）
	const usageAccountValue = usageAccount || usage.data?.accountId || "";
	const usageScriptValue = usageScript || usage.data?.scriptName || "";
	const usageDatabaseValue = usageDatabase || usage.data?.databaseName || "";

	const sessions = useAsync<{ items: SessionItemDto[] }>(() => api.auth.sessions(), []);
	const revokeSession = useSubmit();

	const [timeZoneInput, setTimeZoneInput] = useState("");
	const timezoneSave = useSubmit();
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
	const savedTimeZone = values.timezone ?? "UTC";
	// 输入框未编辑时跟随服务端值
	const timeZoneValue = timeZoneInput === "" ? savedTimeZone : timeZoneInput;
	const timeZoneValid = isValidTimeZone(timeZoneValue);
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

	const shareUrl = typeof location === "undefined" ? "" : location.origin;

	// 已分享的区域：读服务端设置（缺省=全部），勾选即时保存
	const sharedSections = parsePublicSections(values.public_sections);
	const saveSections = async (next: PublicSection[]) => {
		if (next.length === 0) return; // 至少留一块，否则访客看到空白页
		await publicSections.run(async () => {
			await api.settings.update({ publicSections: next });
			settings.reload();
		});
	};

	const togglePublicView = async (next: boolean) => {
		await publicView.run(async () => {
			await api.settings.update({ publicView: next });
			settings.reload();
		});
	};

	const saveUsageConfig = async (patch: Record<string, unknown>) => {
		await usageRefresh.run(async () => {
			await api.settings.update(patch);
			setUsageToken("");
			usage.reload();
		});
	};

	const fetchUsage = async () => {
		await usageRefresh.run(async () => {
			await api.settings.refreshUsage();
			usage.reload();
		});
	};

	const copyShareUrl = async () => {
		try {
			await navigator.clipboard.writeText(shareUrl);
		} catch {
			// 非 https 或未授权剪贴板：至少把链接显示出来让用户手抄
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 1800);
	};

	const changeTimeZone = async () => {
		await timezoneSave.run(async () => {
			await api.settings.update({ timezone: timeZoneValue });
			i18n.applyTimeZone(timeZoneValue);
			setTimeZoneInput("");
			settings.reload();
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

	/** 取最新汇率：只回填到输入框，由用户确认后再保存（手工汇率会阻止后续自动抓取） */
	const fetchFxRate = async () => {
		const from = base.trim().toUpperCase();
		const to = quote.trim().toUpperCase();
		if (from === "" || to === "" || from === to) {
			setFxNotice(t("settings.fxFetchNeedPair"));
			return;
		}
		setFxNotice(null);
		await fxFetch.run(async () => {
			const result = await api.settings.lookupFx({ base: from, quote: to });
			if (result.ok && result.rate !== null) {
				setRate(String(result.rate));
				setFxNotice(
					t("settings.fxFetched", {
						base: result.base,
						quote: result.quote,
						rate: result.rate,
						source: result.source ?? "",
					}),
				);
				return;
			}
			setFxNotice(
				t("settings.fxFetchFailed", {
					list: result.errors.length > 0 ? result.errors.join("；") : result.tried.join("、"),
				}),
			);
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
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.timezone")}</h3>
					<p className="small muted">{t("settings.timezoneHint")}</p>
					{timezoneSave.error && <div className="alert error">{timezoneSave.error}</div>}
					<select
						value={COMMON_TIMEZONES.includes(timeZoneValue as (typeof COMMON_TIMEZONES)[number]) ? timeZoneValue : ""}
						onChange={(e) => setTimeZoneInput(e.target.value)}
					>
						{COMMON_TIMEZONES.map((zone) => (
							<option key={zone} value={zone}>
								{zone} ({offsetLabel(zone)})
							</option>
						))}
						<option value="">{t("settings.timezoneCustom")}</option>
					</select>
					{(!COMMON_TIMEZONES.includes(timeZoneValue as (typeof COMMON_TIMEZONES)[number]) || !timeZoneValid) && (
						<label className="field" style={{ marginTop: 8 }}>
							<span>{t("settings.timezoneCustom")}</span>
							<input
								value={timeZoneValue}
								onChange={(e) => setTimeZoneInput(e.target.value)}
								placeholder="Asia/Shanghai"
								list="tz-list"
							/>
							<datalist id="tz-list">
								{COMMON_TIMEZONES.map((zone) => (
									<option key={zone} value={zone} />
								))}
							</datalist>
						</label>
					)}
					{!timeZoneValid && <div className="alert error">{t("settings.timezoneInvalid")}</div>}
					{timeZoneValid && (
						<p className="small muted">
							{t("settings.timezoneNow", {
								offset: offsetLabel(timeZoneValue),
								time: dateTime(new Date().toISOString(), timeZoneValue),
							})}
						</p>
					)}
					<button
						className="primary"
						onClick={changeTimeZone}
						disabled={timezoneSave.pending || !timeZoneValid || timeZoneValue === savedTimeZone}
					>
						{timezoneSave.pending ? t("common.saving") : t("common.save")}
					</button>
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

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("settings.publicView")}</h3>
					<p className="small muted">{t("settings.publicViewHint")}</p>
					{publicView.error && <div className="alert error">{publicView.error}</div>}

					<label className="switch-row">
						<input
							type="checkbox"
							checked={values.public_view === "1"}
							disabled={publicView.pending}
							onChange={(e) => void togglePublicView(e.target.checked)}
						/>
						<span className="switch-state">
							{values.public_view === "1" ? t("settings.publicViewOn") : t("settings.publicViewOff")}
						</span>
					</label>

					{values.public_view === "1" && (
						<>
							<div className="field-label">{t("settings.publicSections")}</div>
							<div className="option-grid">
								{PUBLIC_SECTIONS.map((section) => {
									const checked = sharedSections.includes(section);
									return (
										<label key={section} className={`option-card${checked ? " on" : ""}`}>
											<input
												type="checkbox"
												checked={checked}
												disabled={publicSections.pending || (checked && sharedSections.length === 1)}
												onChange={(e) =>
													void saveSections(
														e.target.checked
															? [...sharedSections, section]
															: sharedSections.filter((item) => item !== section),
													)
												}
											/>
											<span className="option-text">
												<span className="option-title">{t(`settings.section.${section}`)}</span>
												<span className="option-desc">{t(`settings.sectionHint.${section}`)}</span>
											</span>
										</label>
									);
								})}
							</div>
							{publicSections.error && <div className="alert error">{publicSections.error}</div>}

							<div className="share-url">
								<code title={shareUrl}>{shareUrl}</code>
								<button className="ghost" onClick={() => void copyShareUrl()}>
									{copied ? t("settings.copied") : t("settings.copyLink")}
								</button>
							</div>
							<p className="small muted" style={{ marginBottom: 0 }}>
								{t("settings.publicViewWarn")}
							</p>
						</>
					)}
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
						<div className="field" style={{ display: "grid", alignContent: "end", gap: 8 }}>
							<button
								type="button"
								onClick={fetchFxRate}
								disabled={fxFetch.pending}
								title={t("settings.fxFetchHint")}
							>
								{fxFetch.pending ? t("settings.fxFetching") : t("settings.fxFetch")}
							</button>
							<button className="primary" type="submit" disabled={fx.pending}>
								{t("settings.fxSave")}
							</button>
						</div>
					</form>
					{fx.error && <div className="alert error">{fx.error}</div>}
					{fxFetch.error && <div className="alert error">{fxFetch.error}</div>}
					{fxNotice && <div className="alert">{fxNotice}</div>}

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
											<td className="left muted hide-sm">{dateTime(item.updated_at, timeZone)}</td>
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
						{revokeSession.error && <div className="alert error">{revokeSession.error}</div>}

						<div className="session-list">
							{(sessions.data?.items ?? []).map((item) => {
								const device = describeUserAgent(item.userAgent);
								const label = [device.os, device.browser].filter(Boolean).join(" · ");
								return (
									<div key={item.id} className={`session-row${item.current ? " current" : ""}`}>
										<div className="session-main">
											<span className="session-device" title={item.userAgent ?? ""}>
												{label || t("settings.deviceUnknown")}
											</span>
											{item.current && <span className="chip">{t("settings.thisDevice")}</span>}
										</div>
										<div
											className="small muted session-meta"
											title={[
												item.ip ?? t("settings.ipUnknown"),
												t("settings.sessionLoginAt", { time: dateTime(item.createdAt, timeZone) }),
												item.lastSeen ? t("settings.sessionActiveAt", { time: relativeTime(t, item.lastSeen) }) : "",
											]
												.filter(Boolean)
												.join(" · ")}
										>
											<span className="mono">{item.ip ?? t("settings.ipUnknown")}</span>
											{" · "}
											{t("settings.sessionLoginAt", { time: dateTime(item.createdAt, timeZone) })}
											{/* 本设备不用显示"最近活跃"（就是此刻），省下的宽度留给 IP 与登录时间 */}
											{!item.current && item.lastSeen && (
												<>
													{" · "}
													{t("settings.sessionActiveAt", { time: relativeTime(t, item.lastSeen) })}
												</>
											)}
										</div>
										{!item.current && (
											<button
												className="ghost"
												disabled={revokeSession.pending}
												onClick={async () => {
													if (!window.confirm(t("settings.revokeConfirm", { device: label || t("settings.deviceUnknown") }))) return;
													await revokeSession.run(async () => {
														const result = await api.auth.revokeSession(item.id);
														// 踢的是自己（理论上按钮不显示，防御一下）：直接回登录页
														if (result.current) {
															window.location.reload();
															return;
														}
														sessions.reload();
														overview.reload();
													});
												}}
											>
												{t("settings.revokeSession")}
											</button>
										)}
									</div>
								);
							})}
							{sessions.loading && !sessions.data && <div className="small muted">{t("common.loading")}</div>}
							{sessions.error && <div className="alert error">{sessions.error}</div>}
						</div>

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
							{t("settings.setupAt", { time: dateTime(values.setup_done_at ?? null, timeZone) })}
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

			<div className="section">
				<div className="section-head">
					<h2>{t("settings.usage")}</h2>
					<span className="small muted hide-sm">{t("settings.usageHint")}</span>
				</div>
				<div className="card panel">
					{usage.loading && !usage.data ? (
						<div className="small muted">{t("common.loading")}</div>
					) : usage.data?.configured ? (
						<>
							{usageRefresh.error && <div className="alert error">{usageRefresh.error}</div>}
							{usage.data.snapshot ? (
								<>
									<div className="usage-list">
										<UsageRow
											label={t("settings.usageRequests")}
											used={usage.data.snapshot.requests}
											limit={usage.data.limits.requestsPerDay}
										/>
										<UsageRow
											label={t("settings.usageRowsRead")}
											used={usage.data.snapshot.rowsRead}
											limit={usage.data.limits.rowsReadPerDay}
										/>
										<UsageRow
											label={t("settings.usageRowsWritten")}
											used={usage.data.snapshot.rowsWritten}
											limit={usage.data.limits.rowsWrittenPerDay}
										/>
										<UsageRow
											label={t("settings.usageDbSize", {
												name: usage.data.snapshot.database?.name ?? "",
											})}
											used={usage.data.snapshot.database?.fileSize ?? null}
											limit={usage.data.limits.databaseBytes}
											format="size"
										/>
									</div>
									<p className="small muted" style={{ marginBottom: 0 }}>
										{t("settings.usageUpdatedAt", {
											time: dateTime(usage.data.snapshot.fetchedAt, timeZone),
										})}
										{" · "}
										{t("settings.usageResetHint")}
									</p>
								</>
							) : (
								<p className="small muted">{t("settings.usageNoSnapshot")}</p>
							)}
							{/* 不用 .row：那条全局样式（.row > * { flex: 1 }）会把按钮拉成整行宽 */}
							<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
								<button className="primary" onClick={() => void fetchUsage()} disabled={usageRefresh.pending}>
									{usageRefresh.pending ? t("settings.usageRefreshing") : t("settings.usageRefresh")}
								</button>
								<button
									className="ghost"
									onClick={() => {
										if (!window.confirm(t("settings.usageClearConfirm"))) return;
										void saveUsageConfig({ cfApiToken: "", cfAccountId: "" });
									}}
									disabled={usageRefresh.pending}
								>
									{t("settings.usageClear")}
								</button>
							</div>
							<details style={{ marginTop: 12 }}>
								<summary className="small muted">{t("settings.usageConfig")}</summary>
								<div className="grid cols-2" style={{ marginTop: 10 }}>
									<label className="field">
										<span>{t("settings.usageToken")}</span>
										<input
											type="password"
											value={usageToken}
											onChange={(e) => setUsageToken(e.target.value)}
											placeholder={t("settings.usageTokenKept")}
											autoComplete="off"
										/>
									</label>
									<label className="field">
										<span>{t("settings.usageAccount")}</span>
										<input value={usageAccountValue} onChange={(e) => setUsageAccount(e.target.value)} />
									</label>
									<label className="field">
										<span>{t("settings.usageScript")}</span>
										<input value={usageScriptValue} onChange={(e) => setUsageScript(e.target.value)} />
									</label>
									<label className="field">
										<span>{t("settings.usageDatabase")}</span>
										<input value={usageDatabaseValue} onChange={(e) => setUsageDatabase(e.target.value)} />
									</label>
								</div>
								<button
									onClick={() =>
										void saveUsageConfig({
											...(usageToken ? { cfApiToken: usageToken } : {}),
											cfAccountId: usageAccountValue,
											cfScriptName: usageScriptValue,
											cfDatabaseName: usageDatabaseValue,
										})
									}
									disabled={usageRefresh.pending}
								>
									{t("common.save")}
								</button>
							</details>
						</>
					) : (
						<>
							<p className="small muted">{t("settings.usageIntro")}</p>
							<div className="grid cols-2">
								<label className="field">
									<span>{t("settings.usageToken")}</span>
									<input
										type="password"
										value={usageToken}
										onChange={(e) => setUsageToken(e.target.value)}
										autoComplete="off"
									/>
								</label>
								<label className="field">
									<span>{t("settings.usageAccount")}</span>
									<input value={usageAccountValue} onChange={(e) => setUsageAccount(e.target.value)} />
								</label>
								<label className="field">
									<span>{t("settings.usageScript")}</span>
									<input value={usageScriptValue} onChange={(e) => setUsageScript(e.target.value)} />
								</label>
								<label className="field">
									<span>{t("settings.usageDatabase")}</span>
									<input value={usageDatabaseValue} onChange={(e) => setUsageDatabase(e.target.value)} />
								</label>
							</div>
							{usageRefresh.error && <div className="alert error">{usageRefresh.error}</div>}
							<button
								className="primary"
								onClick={() =>
									void saveUsageConfig({
										...(usageToken ? { cfApiToken: usageToken } : {}),
										cfAccountId: usageAccountValue,
										cfScriptName: usageScriptValue,
										cfDatabaseName: usageDatabaseValue,
									})
								}
								disabled={usageRefresh.pending || !usageToken || !usageAccountValue}
							>
								{usageRefresh.pending ? t("common.saving") : t("common.save")}
							</button>
							<p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
								{t("settings.usageHowTo")}
							</p>
						</>
					)}
				</div>
			</div>

			<p className="small muted" style={{ marginTop: 24 }}>
				{t("settings.disclaimer")}
			</p>
		</>
	);
}

/**
 * 一行用量：标签 + "已用 / 上限" + 进度条。
 * 数字拿不到时（Token 权限不足、库名写错）显示 —，而不是显示 0 让人误以为没用。
 */
function UsageRow({
	label,
	used,
	limit,
	format = "count",
}: {
	label: string;
	used: number | null;
	limit: number;
	format?: "count" | "size";
}) {
	const t = useT();
	const render = (value: number) => (format === "size" ? humanSize(value) : value.toLocaleString());
	const pct = used === null || limit <= 0 ? null : Math.min(100, (used / limit) * 100);
	const tone = pct === null ? "" : pct >= 90 ? " danger" : pct >= 70 ? " warn" : "";

	return (
		<div className="usage-row">
			<div className="usage-head">
				<span>{label}</span>
				<span className="small muted">
					{used === null ? t("settings.usageUnknown") : `${render(used)} / ${render(limit)}`}
				</span>
			</div>
			<div className="usage-bar">
				<div className={`usage-fill${tone}`} style={{ width: `${pct ?? 0}%` }} />
			</div>
		</div>
	);
}
