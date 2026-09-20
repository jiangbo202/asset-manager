import { useEffect, useState } from "react";
import {
	api,
	type QuoteStatusDto,
	type RefreshReportDto,
	type SettingsDto,
} from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
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

	const providers = settings?.providers ?? [];
	const keysSet = new Set(settings?.providerKeysSet ?? []);

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
			setMessage("已保存");
			status.reload();
			onSaved?.();
		});
	};

	const refreshNow = async () => {
		await action.run(async () => {
			const response = await api.quotes.refresh();
			setLastReport(response.report);
			setMessage(
				`刷新完成：更新 ${response.report.updated} 条价格、${response.report.fxUpdated} 条汇率，失败 ${response.report.failed.length} 条`,
			);
			status.reload();
			onSaved?.();
		});
	};

	const takeSnapshot = async () => {
		await action.run(async () => {
			const result = await api.snapshots.take();
			setMessage(`已生成 ${result.date} 的快照：${result.currency} ${result.total.toFixed(2)}`);
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
				setTestResult(`✓ ${quote.symbol} = ${quote.price} ${quote.currency}（来自 ${quote.source}）`);
			} else {
				setTestResult(`✗ ${response.errors.join("；") || "没有取到价格"}`);
			}
		});
	};

	return (
		<div className="section">
			<div className="section-head">
				<h2>行情与快照</h2>
				<span className="small muted hide-sm">
					默认使用免费公开接口，无需 API Key；失败会自动回退到下一个数据源
				</span>
				<div className="spacer" />
				<button onClick={refreshNow} disabled={action.pending}>
					立即刷新行情
				</button>
				<button onClick={takeSnapshot} disabled={action.pending}>
					立即拍快照
				</button>
			</div>

			{(save.error || action.error) && <div className="alert error">{save.error ?? action.error}</div>}
			{message && <div className="alert">{message}</div>}

			<div className="grid cols-2">
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>开关与时间</h3>
					<label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
						<input
							type="checkbox"
							checked={marketEnabled}
							style={{ width: "auto" }}
							onChange={(e) => setMarketEnabled(e.target.checked)}
						/>
						启用行情自动更新与每日快照
					</label>
					<label className="field">
						<span>每日快照时间（UTC 小时，0–23）</span>
						<input
							type="number"
							min={0}
							max={23}
							value={snapshotHour}
							onChange={(e) => setSnapshotHour(e.target.value)}
						/>
					</label>
					<p className="small muted" style={{ marginBottom: 0 }}>
						Worker 的 Cron 每小时跑一次，只在这个小时里真正干活：先刷新行情、再拍快照。
						默认 22 点（UTC）≈ 美股收盘后。上次运行：
						{status.data?.lastRunAt ? dateTime(status.data.lastRunAt) : "尚未运行"}
					</p>
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>测试数据源</h3>
					<div className="row">
						<label className="field">
							<span>数据源</span>
							<select value={testProvider} onChange={(e) => setTestProvider(e.target.value)}>
								{providers.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.label}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>类型</span>
							<select value={testKind} onChange={(e) => setTestKind(e.target.value)}>
								<option value="stock">股票</option>
								<option value="crypto">加密</option>
								<option value="fx">汇率</option>
							</select>
						</label>
					</div>
					<div className="row">
						<label className="field">
							<span>代码</span>
							<input
								value={testSymbol}
								onChange={(e) => setTestSymbol(e.target.value)}
								placeholder={testKind === "fx" ? "USD:HKD" : "AAPL / 0700 / BTC"}
							/>
						</label>
						<label className="field">
							<span>币种</span>
							<input value={testCurrency} onChange={(e) => setTestCurrency(e.target.value.toUpperCase())} />
						</label>
						<label className="field">
							<span>市场</span>
							<select value={testMarket} onChange={(e) => setTestMarket(e.target.value)}>
								<option value="us">美股</option>
								<option value="hk">港股</option>
								<option value="cn">A 股</option>
								<option value="crypto">加密</option>
								<option value="">未指定</option>
							</select>
						</label>
					</div>
					<button onClick={runTest} disabled={action.pending}>
						测试
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
							<th className="left">数据源</th>
							<th className="left hide-sm">覆盖范围</th>
							<th className="left">启用</th>
							<th className="left">API Key</th>
							<th className="left hide-sm">说明</th>
						</tr>
					</thead>
					<tbody>
						{providers.map((provider) => {
							const on = enabled[provider.id] ?? provider.defaultEnabled;
							return (
								<tr key={provider.id}>
									<td className="left">
										{provider.docs ? (
											<a href={provider.docs} target="_blank" rel="noreferrer">
												{provider.label}
											</a>
										) : (
											provider.label
										)}
										{provider.batch && <span className="badge" style={{ marginLeft: 6 }}>批量</span>}
									</td>
									<td className="left hide-sm">{provider.kinds.join(" / ")}</td>
									<td className="left">
										<input
											type="checkbox"
											checked={on}
											style={{ width: "auto" }}
											onChange={(e) => setEnabled({ ...enabled, [provider.id]: e.target.checked })}
										/>
									</td>
									<td className="left">
										{provider.id === "custom" ? (
											<span className="muted small">见下方自定义配置</span>
										) : provider.needsKey ? (
											<input
												type="password"
												placeholder={keysSet.has(provider.id) ? "已设置（留空不修改）" : "填写 Key"}
												value={keys[provider.id] ?? ""}
												onChange={(e) => setKeys({ ...keys, [provider.id]: e.target.value })}
												style={{ minWidth: 180 }}
											/>
										) : (
											<span className="muted small">无需</span>
										)}
									</td>
									<td className="left hide-sm muted small">{provider.note}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<div className="card panel" style={{ marginTop: 12 }}>
				<h3 style={{ marginTop: 0, fontSize: 14 }}>自定义数据源（可对接任意 HTTP 行情服务）</h3>
				<p className="small muted">
					URL 模板里用 <code>{"{symbol}"}</code> 占位代码、<code>{"{key}"}</code> 占位下面填的 Key；
					价格路径用点号表示层级（如 <code>data.price</code> 或 <code>quotes.0.close</code>）。
					启用后它会**优先于内置源**被尝试。
				</p>
				<label className="field">
					<span>URL 模板</span>
					<input
						value={custom.urlTemplate}
						onChange={(e) => setCustom({ ...custom, urlTemplate: e.target.value })}
						placeholder="https://api.example.com/quote?symbol={symbol}&token={key}"
					/>
				</label>
				<div className="row">
					<label className="field">
						<span>价格路径</span>
						<input
							value={custom.pricePath}
							onChange={(e) => setCustom({ ...custom, pricePath: e.target.value })}
							placeholder="data.price"
						/>
					</label>
					<label className="field">
						<span>币种路径（可选）</span>
						<input
							value={custom.currencyPath}
							onChange={(e) => setCustom({ ...custom, currencyPath: e.target.value })}
							placeholder="data.currency"
						/>
					</label>
				</div>
				<div className="row">
					<label className="field">
						<span>额外请求头（JSON，可选）</span>
						<input
							value={custom.headers}
							onChange={(e) => setCustom({ ...custom, headers: e.target.value })}
							placeholder='{"X-API-Version":"1"}'
						/>
					</label>
					<label className="field">
						<span>Key（可选，会加密存储）</span>
						<input
							type="password"
							value={custom.key}
							onChange={(e) => setCustom({ ...custom, key: e.target.value })}
							placeholder={keysSet.has("custom") ? "已设置（留空不修改）" : ""}
						/>
					</label>
				</div>
				<button className="primary" onClick={saveAll} disabled={save.pending}>
					{save.pending ? "保存中…" : "保存设置"}
				</button>
				{!custom.urlTemplate && (
					<p className="small muted" style={{ marginBottom: 0 }}>
						留空表示不使用自定义数据源。保存后点上方「立即刷新行情」即可生效。
					</p>
				)}
			</div>

			{lastReport && lastReport.failed.length > 0 && (
				<div className="alert error" style={{ marginTop: 12 }}>
					上次刷新有 {lastReport.failed.length} 条失败：
					{lastReport.failed.slice(0, 6).map((item) => `${item.symbol}（${item.reason}）`).join("；")}
				</div>
			)}

			<div className="grid cols-2" style={{ marginTop: 16 }}>
				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>最近运行</h3>
					{(status.data?.recentRuns ?? []).length === 0 ? (
						<div className="muted small">还没有运行记录。</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">时间</th>
										<th className="left">触发</th>
										<th>更新</th>
										<th>失败</th>
										<th className="hide-sm">请求</th>
									</tr>
								</thead>
								<tbody>
									{(status.data?.recentRuns ?? []).map((run) => (
										<tr key={run.id}>
											<td className="left">{dateTime(run.started_at)}</td>
											<td className="left">{run.trigger === "cron" ? "定时" : "手动"}</td>
											<td>{run.updated}</td>
											<td className={run.failed > 0 ? "negative" : ""}>{run.failed}</td>
											<td className="hide-sm">{run.requests}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>已缓存的最新价格</h3>
					{(status.data?.cache ?? []).length === 0 ? (
						<div className="muted small">还没有缓存。点「立即刷新行情」试试。</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th className="left">代码</th>
										<th className="left hide-sm">数据源</th>
										<th>价格</th>
										<th className="left hide-sm">时间</th>
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
											<td className="left hide-sm muted">{dateTime(row.fetched_at)}</td>
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
					{save.pending ? "保存中…" : "保存设置"}
				</button>
			</div>
		</div>
	);
}
