import { useEffect, useState } from "react";
import { api, type QuoteStatusDto, type RefreshReportDto, type SettingsDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { useT, useTimeZone } from "../lib/i18n";
import { dateTime } from "../lib/format";

/**
 * 行情与快照设置（v0.10）
 *
 * 默认启用全部免费数据源、开箱即用；用户也可以：
 *  - 关掉不想要的源（按顺序回退）
 *  - 填自己的 API Key（加密存库）
 *  - 配一个自定义 HTTP 数据源（URL 模板 + JSON 路径）
 *  - 改快照时间、手动拍快照、查看最近运行与缓存
 */
export function MarketDataSection({ settings, onSaved }: { settings: SettingsDto | null; onSaved?: () => void }) {
	const t = useT();
	const timeZone = useTimeZone();
	const status = useAsync<QuoteStatusDto>(() => api.quotes.status(), []);
	const save = useSubmit();
	const action = useSubmit();

	const [marketEnabled, setMarketEnabled] = useState(true);
	const [snapshotHour, setSnapshotHour] = useState("22");
	const [enabled, setEnabled] = useState<Record<string, boolean>>({});
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [custom, setCustom] = useState({
		urlTemplate: "",
		pricePath: "",
		currencyPath: "",
		headers: "",
		key: "",
	});
	const [message, setMessage] = useState<string | null>(null);
	const [lastReport, setLastReport] = useState<RefreshReportDto | null>(null);

	const [testProvider, setTestProvider] = useState<string>("yahoo");
	const [testSymbol, setTestSymbol] = useState("AAPL");
	const [testKind, setTestKind] = useState("stock");
	const [testCurrency, setTestCurrency] = useState("USD");
	const [testMarket, setTestMarket] = useState("us");
	const [testResult, setTestResult] = useState<string | null>(null);

	useEffect(() => {
		if (!settings) return;
		setMarketEnabled(settings.values.market_data_enabled !== "0");
		setSnapshotHour(settings.values.snapshot_hour_utc ?? "22");
		setEnabled(settings.providerConfig?.enabled ?? {});
		setCustom({
			urlTemplate: settings.providerConfig?.custom?.urlTemplate ?? "",
			pricePath: settings.providerConfig?.custom?.pricePath ?? "",
			currencyPath: settings.providerConfig?.custom?.currencyPath ?? "",
			headers: settings.providerConfig?.custom?.headers ?? "",
			key: "",
		});
	}, [settings]);

	const keysSet = new Set(settings?.providerKeysSet ?? []);

	/**
	 * 数据源列表有两个来源：
	 *  - settings.providers：静态元信息（id、覆盖范围）
	 *  - status.providers：运行时状态（是否在限流冷却、上次错误）
	 * 展示名与说明走 i18n（provider.<id>.label / .note）
	 */
	const providers = (settings?.providers ?? []).map((meta) => {
		const runtime = status.data?.providers.find((item) => item.id === meta.id);
		return {
			...meta,
			label: t(`provider.${meta.id}.label`),
			note: t(`provider.${meta.id}.note`),
			enabled: enabled[meta.id] ?? runtime?.enabled ?? meta.defaultEnabled,
			coolingDown: runtime?.coolingDown ?? false,
			cooldownMinutesLeft: runtime?.cooldownMinutesLeft ?? 0,
			cooldownReason: runtime?.cooldownReason ?? null,
			lastError: runtime?.lastError ?? null,
			hasKey: runtime?.hasKey ?? keysSet.has(meta.id),
		};
	});

	const saveAll = async () => {
		await save.run(async () => {
			await api.settings.update({
				marketDataEnabled: marketEnabled,
				snapshotHourUtc: Number(snapshotHour),
				providerConfig: {
					enabled,
					custom: custom.urlTemplate
						? {
								urlTemplate: custom.urlTemplate,
								pricePath: custom.pricePath,
								currencyPath: custom.currencyPath || undefined,
								headers: custom.headers || undefined,
								key: custom.key || undefined,
							}
						: null,
				},
				...(Object.keys(keys).length > 0 ? { providerKeys: keys } : {}),
			});
			setKeys({});
			setMessage(t("market.saved"));
			status.reload();
			onSaved?.();
		});
	};

	const refreshNow = async () => {
		await action.run(async () => {
			const response = await api.quotes.refresh();
			setLastReport(response.report);
			setMessage(
				t("market.refreshDone", {
					updated: response.report.updated,
					fxUpdated: response.report.fxUpdated,
					failed: response.report.failed.length,
				}),
			);
			status.reload();
			onSaved?.();
		});
	};

	const takeSnapshot = async () => {
		await action.run(async () => {
			const result = await api.snapshots.take();
			setMessage(
				t("market.snapshotDone", {
					date: result.date,
					currency: result.currency,
					total: result.total.toFixed(2),
				}),
			);
			status.reload();
			onSaved?.();
		});
	};

	const runTest = async () => {
		setTestResult(null);
		await action.run(async () => {
			const response = await api.quotes.test({
				provider: testProvider,
				symbol: testSymbol,
				kind: testKind,
				currency: testCurrency,
				market: testMarket || null,
			});
			if (response.ok) {
				const quote = response.quotes[0] as { price: number; currency: string; symbol: string; source: string };
				setTestResult(`✓ ${quote.symbol} = ${quote.price} ${quote.currency} (${quote.source})`);
			} else {
				setTestResult(`✗ ${response.errors.join("; ") || t("quote.allFailed")}`);
			}
		});
	};

	// 最近一次运行里因为分批而留到下一次的标的（只有定时任务会分批）
	const deferredCount = status.data?.recentRuns?.[0]?.deferred ?? 0;

	return (
		<div className="section">
			<div className="section-head">
				<h2>{t("market.title")}</h2>
				<span className="small muted hide-sm">{t("market.hint")}</span>
				<div className="spacer" />
				<button onClick={refreshNow} disabled={action.pending}>
					{t("market.refreshNow")}
				</button>
				<button onClick={takeSnapshot} disabled={action.pending}>
					{t("market.snapshotNow")}
				</button>
			</div>

			{(save.error || action.error) && <div className="alert error">{save.error ?? action.error}</div>}
			{message && <div className="alert">{message}</div>}

			<div className="grid cols-2">
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("market.switches")}</h3>
					<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
						<input
							type="checkbox"
							checked={marketEnabled}
							style={{ width: "auto" }}
							onChange={(e) => setMarketEnabled(e.target.checked)}
						/>
						{t("market.enable")}
					</label>
					<label className="field">
						<span>{t("market.snapshotHourTz", { timezone: timeZone })}</span>
						<input
							type="number"
							min={0}
							max={23}
							value={snapshotHour}
							onChange={(e) => setSnapshotHour(e.target.value)}
						/>
					</label>
					<p className="small muted" style={{ marginBottom: 0 }}>
						{t("market.snapshotHintTz", {
							timezone: timeZone,
							time: status.data?.lastRunAt ? dateTime(status.data.lastRunAt, timeZone) : t("market.never"),
						})}
					</p>
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("market.testTitle")}</h3>
					<div className="row">
						<label className="field">
							<span>{t("market.provider")}</span>
							<select value={testProvider} onChange={(e) => setTestProvider(e.target.value)}>
								{providers.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.label}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>{t("market.kind")}</span>
							<select value={testKind} onChange={(e) => setTestKind(e.target.value)}>
								<option value="stock">{t("market.kind.stock")}</option>
								<option value="crypto">{t("market.kind.crypto")}</option>
								<option value="fx">{t("market.kind.fx")}</option>
							</select>
						</label>
					</div>
					<div className="row">
						<label className="field">
							<span>{t("market.symbol")}</span>
							<input
								value={testSymbol}
								onChange={(e) => setTestSymbol(e.target.value)}
								placeholder={testKind === "fx" ? "USD:HKD" : "AAPL / 0700 / BTC"}
							/>
						</label>
						<label className="field">
							<span>{t("market.currency")}</span>
							<input value={testCurrency} onChange={(e) => setTestCurrency(e.target.value.toUpperCase())} />
						</label>
						<label className="field">
							<span>{t("market.market")}</span>
							<select value={testMarket} onChange={(e) => setTestMarket(e.target.value)}>
								<option value="us">{t("market.market.us")}</option>
								<option value="hk">{t("market.market.hk")}</option>
								<option value="cn">{t("market.market.cn")}</option>
								<option value="crypto">{t("market.market.crypto")}</option>
								<option value="">{t("market.market.none")}</option>
							</select>
						</label>
					</div>
					<button onClick={runTest} disabled={action.pending}>
						{t("market.test")}
					</button>
					{testResult && (
						<p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
							{testResult}
						</p>
					)}
				</div>
			</div>

			<div className="card table-wrap" style={{ marginTop: 16 }}>
				<table>
					<thead>
						<tr>
							<th className="left">{t("market.colProvider")}</th>
							<th className="left hide-sm">{t("market.colKinds")}</th>
							<th className="left">{t("market.colEnabled")}</th>
							<th className="left">{t("market.colKey")}</th>
							<th className="left hide-sm">{t("market.colNote")}</th>
						</tr>
					</thead>
					<tbody>
						{providers.map((provider) => (
							<tr key={provider.id}>
								<td className="left">
									{provider.docs ? (
										<a href={provider.docs} target="_blank" rel="noreferrer">
											{provider.label}
										</a>
									) : (
										provider.label
									)}
									{provider.batch && <span className="badge" style={{ marginLeft: 6 }}>{t("market.batchBadge")}</span>}
									{provider.coolingDown && (
										<span className="badge warn" style={{ marginLeft: 6 }} title={provider.cooldownReason ?? ""}>
											{t("market.coolingBadge", { minutes: provider.cooldownMinutesLeft })}
										</span>
									)}
								</td>
								<td className="left hide-sm">{provider.kinds.map((kind) => t(`market.kind.${kind}`)).join(" / ")}</td>
								<td className="left">
									<input
										type="checkbox"
										checked={provider.enabled}
										style={{ width: "auto" }}
										onChange={(e) => setEnabled({ ...enabled, [provider.id]: e.target.checked })}
									/>
								</td>
								<td className="left">
									{provider.id === "custom" ? (
										<span className="muted small">{t("market.keySeeCustom")}</span>
									) : provider.needsKey ? (
										<input
											type="password"
											placeholder={provider.hasKey ? t("market.keyPlaceholderSet") : t("market.keyPlaceholder")}
											value={keys[provider.id] ?? ""}
											onChange={(e) => setKeys({ ...keys, [provider.id]: e.target.value })}
											style={{ minWidth: 180 }}
										/>
									) : (
										<span className="muted small">{t("market.noKeyNeeded")}</span>
									)}
									{provider.lastError && !provider.coolingDown && (
										<div className="small muted">{t("market.lastError", { message: provider.lastError })}</div>
									)}
								</td>
								<td className="left hide-sm muted small">{provider.note}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="card panel" style={{ marginTop: 12 }}>
				<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("market.customTitle")}</h3>
				<p className="small muted">{t("market.customHint")}</p>
				<label className="field">
					<span>{t("market.customUrl")}</span>
					<input
						value={custom.urlTemplate}
						onChange={(e) => setCustom({ ...custom, urlTemplate: e.target.value })}
						placeholder="https://api.example.com/quote?symbol={symbol}&token={key}"
					/>
				</label>
				<div className="row">
					<label className="field">
						<span>{t("market.customPricePath")}</span>
						<input
							value={custom.pricePath}
							onChange={(e) => setCustom({ ...custom, pricePath: e.target.value })}
							placeholder="data.price"
						/>
					</label>
					<label className="field">
						<span>{t("market.customCurrencyPath")}</span>
						<input
							value={custom.currencyPath}
							onChange={(e) => setCustom({ ...custom, currencyPath: e.target.value })}
							placeholder="data.currency"
						/>
					</label>
				</div>
				<div className="row">
					<label className="field">
						<span>{t("market.customHeaders")}</span>
						<input
							value={custom.headers}
							onChange={(e) => setCustom({ ...custom, headers: e.target.value })}
							placeholder='{"X-API-Version":"1"}'
						/>
					</label>
					<label className="field">
						<span>{t("market.customKey")}</span>
						<input
							type="password"
							value={custom.key}
							onChange={(e) => setCustom({ ...custom, key: e.target.value })}
							placeholder={keysSet.has("custom") ? t("market.keyPlaceholderSet") : ""}
						/>
					</label>
				</div>
				<button className="primary" onClick={saveAll} disabled={save.pending}>
					{save.pending ? t("common.saving") : t("market.saveSettings")}
				</button>
				{!custom.urlTemplate && (
					<p className="small muted" style={{ marginBottom: 0 }}>
						{t("market.customEmptyHint")}
					</p>
				)}
			</div>

			{lastReport && lastReport.coolingDown.length > 0 && (
				<div className="alert" style={{ marginTop: 12 }}>
					{t("market.coolingAlert", {
						list: lastReport.coolingDown
							.map((item) => `${item.provider} (${item.reason}, ~${item.minutesLeft} min)`)
							.join("; "),
					})}
				</div>
			)}

			{lastReport && lastReport.failed.length > 0 && (
				<div className="alert error" style={{ marginTop: 12 }}>
					{t("market.failedAlert", {
						count: lastReport.failed.length,
						list: lastReport.failed
							.slice(0, 6)
							.map((item) => `${item.symbol} (${item.reason})`)
							.join("; "),
					})}
				</div>
			)}

			<div className="grid cols-2" style={{ marginTop: 16 }}>
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("market.recentRuns")}</h3>
					{(status.data?.recentRuns ?? []).length === 0 ? (
						<div className="muted small">{t("market.noRuns")}</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">{t("market.colTime")}</th>
										<th className="left">{t("market.colTrigger")}</th>
										<th>{t("market.colUpdated")}</th>
										<th>{t("market.colFailed")}</th>
										<th className="hide-sm">{t("market.colRequests")}</th>
									</tr>
								</thead>
								<tbody>
									{(status.data?.recentRuns ?? []).map((run) => (
										<tr key={run.id}>
											<td className="left">{dateTime(run.started_at, timeZone)}</td>
											<td className="left">
												{run.trigger === "cron" ? t("market.triggerCron") : t("market.triggerManual")}
											</td>
											<td>{run.updated}</td>
											<td className={run.failed > 0 ? "negative" : ""}>{run.failed}</td>
											<td className="hide-sm">{run.requests}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{deferredCount > 0 && (
						<div className="muted small" style={{ marginTop: 8 }}>
							{t("market.deferredHint", { count: deferredCount })}
						</div>
					)}
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>{t("market.cache")}</h3>
					{(status.data?.cache ?? []).length === 0 ? (
						<div className="muted small">{t("market.noCache")}</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">{t("market.colSymbol")}</th>
										<th className="left hide-sm">{t("market.colProvider")}</th>
										<th>{t("market.colPrice")}</th>
										<th className="left hide-sm">{t("market.colTime")}</th>
									</tr>
								</thead>
								<tbody>
									{(status.data?.cache ?? []).slice(0, 20).map((row) => (
										<tr key={row.key}>
											<td className="left">{row.symbol}</td>
											<td className="left hide-sm">{row.source}</td>
											<td>
												{row.price} {row.currency}
											</td>
											<td className="left hide-sm muted">{dateTime(row.fetched_at, timeZone)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			</div>

			<div style={{ marginTop: 12 }}>
				<button className="primary" onClick={saveAll} disabled={save.pending}>
					{save.pending ? t("common.saving") : t("market.saveSettings")}
				</button>
			</div>
		</div>
	);
}
