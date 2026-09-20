import { useState } from "react";
import { api, type ImportPreview, type ImportResult, type SettingsDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { dateTime } from "../lib/format";
import { decryptBackup, deriveCredential, encryptBackup, isEncryptedBackup, ITERATIONS, randomSaltHex } from "../lib/crypto";
import { downloadText, humanSize } from "../lib/download";
import { MarketDataSection } from "./MarketDataSection";

const ROW_LABELS: Record<string, string> = {
	accounts: "账户",
	holdings: "持仓",
	auditLog: "操作历史",
	priceHistory: "价格历史",
	qtyHistory: "数量历史",
	sessions: "会话",
	snapshots: "每日快照",
	quoteCache: "行情缓存",
};

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
	const settings = useAsync<SettingsDto>(() => api.settings.get(), []);
	const overview = useAsync(() => api.settings.overview(), []);
	const [base, setBase] = useState("USD");
	const [quote, setQuote] = useState("HKD");
	const [rate, setRate] = useState("");
	const fx = useSubmit();
	const display = useSubmit();
	const pwd = useSubmit();

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
		if (!window.confirm(`删除汇率 ${from} → ${to}？`)) return;
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
			if (!params.kdfSalt) throw new Error("尚未初始化");
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
				backupImport.setError("文件不是合法的 JSON");
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
			if (!data) throw new Error("请先选择备份文件");
			const response = await api.backup.import(data, mode, true);
			setPreview(response.preview);
		});
	};

	const runImport = async () => {
		if (!preview) return;
		if (mode === "replace" && !window.confirm("覆盖导入会清空现有账户/持仓/汇率/设置（操作历史保留），确定继续？")) return;
		await backupImport.run(async () => {
			const data = payload ?? (await preparePayload());
			if (!data) throw new Error("请先选择备份文件");
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
				<h2>设置</h2>
			</div>

			<div className="grid cols-2">
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>显示币种</h3>
					<p className="small muted">所有汇总、图表与表格都会按这个币种折算。</p>
					{(display.error || fx.error) && <div className="alert error">{display.error ?? fx.error}</div>}
					<select value={displayCurrency} onChange={(e) => changeDisplay(e.target.value)} disabled={display.pending}>
						{(settings.data?.currencies ?? ["USD", "HKD", "CNY"]).map((currency) => (
							<option key={currency} value={currency}>
								{currency}
							</option>
						))}
					</select>
					<p className="small muted" style={{ marginBottom: 0 }}>
						想加别的币种？在下面「汇率」里新增一条（如 1 EUR = 1.08 USD）即可，币种列表会自动出现。
					</p>
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>价格维护方式</h3>
					<p className="small muted">
						价格可以自动抓取（默认开启免费数据源），也可以随时手动改：
						任何一次手动改动都会立刻写入价格历史，自动抓取不会覆盖你改过的值——它只是把最新价写进价格字段。
					</p>
					<p className="small muted" style={{ marginBottom: 0 }}>
						抓取失败不会影响记账：界面会提示"数据陈旧"。详细的开关、Key 与自定义数据源见下方「行情与快照」。
					</p>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>汇率（手动维护）</h2>
					<span className="small muted hide-sm">
						修改汇率会让所有折算数值一起变化，这是 v1 的已知限制
					</span>
				</div>
				<div className="card">
					<form className="panel row" onSubmit={addFx}>
						<label className="field">
							<span>基准币种</span>
							<input value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} maxLength={5} />
						</label>
						<label className="field">
							<span>目标币种</span>
							<input value={quote} onChange={(e) => setQuote(e.target.value.toUpperCase())} maxLength={5} />
						</label>
						<label className="field">
							<span>
								1 {base.toUpperCase()} = ? {quote.toUpperCase()}
							</span>
							<input type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
						</label>
						<div className="field" style={{ display: "grid", alignContent: "end" }}>
							<button className="primary" type="submit" disabled={fx.pending}>
								保存汇率
							</button>
						</div>
					</form>

					{settings.data && settings.data.fx.length > 0 && (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">汇率</th>
										<th className="left hide-sm">更新时间</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{settings.data.fx.map((item) => (
										<tr key={`${item.base}:${item.quote}`}>
											<td className="left">
												1 {item.base} = {item.rate} {item.quote}
											</td>
											<td className="left muted hide-sm">{dateTime(item.updated_at)}</td>
											<td>
												<button className="ghost danger" onClick={() => removeFx(item.base, item.quote)}>
													删除
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
					<h2>备份与恢复</h2>
					<span className="small muted hide-sm">导出为 JSON；导入前会先做校验并展示差异预览</span>
				</div>

				<div className="grid cols-2">
					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>导出</h3>
						{backupExport.error && <div className="alert error">{backupExport.error}</div>}
						<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
							<input
								type="checkbox"
								checked={includeAudit}
								style={{ width: "auto" }}
								onChange={(e) => setIncludeAudit(e.target.checked)}
							/>
							包含操作历史（体积更大，但迁移后历史记录完整）
						</label>
						<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
							<input
								type="checkbox"
								checked={encryptExport}
								style={{ width: "auto" }}
								onChange={(e) => setEncryptExport(e.target.checked)}
							/>
							用口令加密（浏览器端 AES-GCM，口令不会发送到服务器）
						</label>
						{encryptExport && (
							<label className="field">
								<span>加密口令（请自己记住，丢了无法恢复）</span>
								<input
									type="password"
									value={exportPassphrase}
									onChange={(e) => setExportPassphrase(e.target.value)}
									placeholder="至少 8 位"
								/>
							</label>
						)}
						<button
							className="primary"
							onClick={runExport}
							disabled={backupExport.pending || (encryptExport && exportPassphrase.length < 8)}
						>
							{backupExport.pending ? "导出中…" : "导出 JSON"}
						</button>
						{lastExportSize !== null && (
							<p className="small muted" style={{ marginBottom: 0 }}>
								上次导出大小：{humanSize(lastExportSize)}
							</p>
						)}
						<p className="small muted" style={{ marginBottom: 0 }}>
							导出的文件**不含**登录密码，换环境后需要重新初始化。
						</p>
					</div>

					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>导入</h3>
						{backupImport.error && <div className="alert error">{backupImport.error}</div>}
						{result && (
							<div className="alert">
								导入完成：写入 {result.applied?.statements ?? 0} 条语句
								{result.applied?.atomic ? "（单事务，原子生效）" : "（分批写入）"}。
								<button className="ghost" onClick={() => window.location.reload()}>
									刷新页面
								</button>
							</div>
						)}

						<label className="field">
							<span>选择备份文件</span>
							<input type="file" accept="application/json,.json" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
						</label>
						{importFileName && (
							<p className="small muted" style={{ marginTop: -6 }}>
								已选择：{importFileName}
								{needPassphrase && "（加密文件，需要口令）"}
							</p>
						)}

						{needPassphrase && (
							<label className="field">
								<span>解密口令</span>
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
							<span>导入模式</span>
							<select
								value={mode}
								onChange={(e) => {
									setMode(e.target.value as "merge" | "replace");
									setPreview(null);
								}}
							>
								<option value="merge">合并（按 id 覆盖同名，保留其它）</option>
								<option value="replace">覆盖（先清空业务数据再导入）</option>
							</select>
						</label>

						<div className="row">
							<button onClick={runPreview} disabled={backupImport.pending || !importText}>
								{backupImport.pending ? "处理中…" : "预览差异"}
							</button>
							<button className="danger" onClick={runImport} disabled={backupImport.pending || !preview}>
								确认导入
							</button>
						</div>

						{preview && (
							<div style={{ marginTop: 12 }}>
								<div className="table-wrap">
									<table>
										<thead>
											<tr>
												<th className="left">实体</th>
												<th>新增</th>
												<th>覆盖</th>
												<th>删除</th>
											</tr>
										</thead>
										<tbody>
											{Object.entries(preview.summary)
												.filter(([, diff]) => diff.create + diff.update + diff.remove > 0)
												.map(([entity, diff]) => (
													<tr key={entity}>
														<td className="left">{ROW_LABELS[entity] ?? entity}</td>
														<td>{diff.create}</td>
														<td>{diff.update}</td>
														<td>{diff.remove || "—"}</td>
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
							覆盖模式会保留操作历史并追加上一条"覆盖导入"记录；建议先点左侧「导出 JSON」留一份。
						</p>
					</div>
				</div>
			</div>

			<MarketDataSection settings={settings.data} onSaved={() => {
				settings.reload();
				overview.reload();
				onChanged?.();
			}} />

			<div className="section">
				<div className="section-head">
					<h2>安全</h2>
				</div>
				<div className="grid cols-2">
					<form className="card panel" onSubmit={changePassword}>
						<h3 style={{ marginTop: 0, fontSize: 14 }}>修改密码</h3>
						{pwd.error && <div className="alert error">{pwd.error}</div>}
						<label className="field">
							<span>当前密码</span>
							<input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required />
						</label>
						<label className="field">
							<span>新密码（至少 12 位）</span>
							<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
						</label>
						<button className="primary" type="submit" disabled={pwd.pending}>
							{pwd.pending ? "提交中…" : "修改密码"}
						</button>
						<p className="small muted" style={{ marginBottom: 0 }}>
							修改后其他设备上的登录会全部失效。
						</p>
					</form>

					<div className="card panel">
						<h3 style={{ marginTop: 0, fontSize: 14 }}>会话</h3>
						<p className="small muted">当前有 {overview.data?.rows.sessions ?? 0} 个活跃会话（含本设备）。</p>
						<button
							className="danger"
							onClick={async () => {
								if (!window.confirm("确定登出所有设备？")) return;
								await api.auth.logoutAll();
								window.location.reload();
							}}
						>
							登出所有设备
						</button>
						<p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
							初始化时间：{dateTime(values.setup_done_at ?? null)}
						</p>
					</div>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>数据概览</h2>
					<span className="small muted hide-sm">用来判断是否接近 Cloudflare 免费额度</span>
				</div>
				<div className="card panel">
					<div className="grid cols-4">
						{rowEntries.map(([key, value]) => (
							<div key={key}>
								<div className="label small muted">{ROW_LABELS[key] ?? key}</div>
								<div style={{ fontWeight: 600 }}>{value.toLocaleString()} 行</div>
							</div>
						))}
					</div>
					<p className="small muted" style={{ marginBottom: 0 }}>
						免费额度：D1 每天 {Number(limits.d1RowsReadPerDay ?? 0).toLocaleString()} 行读 /{" "}
						{Number(limits.d1RowsWrittenPerDay ?? 0).toLocaleString()} 行写 · 单次请求 CPU{" "}
						{limits.workerCpuMsPerRequest ?? 10}ms
					</p>
				</div>
			</div>

			<p className="small muted" style={{ marginTop: 24 }}>
				个人记账工具，不提供投资建议。所有数据保存在你自己的 Cloudflare D1 数据库中，本应用不含任何遥测。
			</p>
		</>
	);
}
