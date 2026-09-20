import { useState } from "react";
import { api, type SettingsDto } from "../lib/api";
import { useAsync, useSubmit } from "../lib/useAsync";
import { dateTime } from "../lib/format";
import { deriveCredential, ITERATIONS, randomSaltHex } from "../lib/crypto";

export function SettingsPage({ onChanged }: { onChanged?: () => void }) {
	const settings = useAsync<SettingsDto>(() => api.settings.get(), []);
	const overview = useAsync(() => api.settings.overview(), []);
	const [base, setBase] = useState("USD");
	const [quote, setQuote] = useState("HKD");
	const [rate, setRate] = useState("");
	const fx = useSubmit();
	const display = useSubmit();
	const pwd = useSubmit();

	const [marketDataEnabled, setMarketDataEnabled] = useState(false);
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");

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
					<select
						value={displayCurrency}
						onChange={(e) => changeDisplay(e.target.value)}
						disabled={display.pending}
					>
						{(settings.data?.currencies ?? ["USD", "HKD", "CNY"]).map((currency) => (
							<option key={currency} value={currency}>
								{currency}
							</option>
						))}
					</select>
				</div>

				<div className="card panel">
					<h3 style={{ marginTop: 0, fontSize: 14 }}>外部行情</h3>
					<p className="small muted">
						v1 不接外部行情，价格全部手动录入。开启入口先放在这里，下个版本支持。
					</p>
					<label style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<input
							type="checkbox"
							checked={marketDataEnabled}
							style={{ width: "auto" }}
							onChange={(e) => {
								if (e.target.checked) {
									window.alert("外部行情将在下个版本支持，敬请期待。");
									return;
								}
								setMarketDataEnabled(false);
							}}
						/>
						<span className="small">开启外部行情自动更新（下个版本支持）</span>
					</label>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>汇率（手动维护）</h2>
					<span className="small muted">修改汇率会让所有折算数值一起变化，这是 v1 的已知限制</span>
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
							<span>1 {base.toUpperCase()} = ? {quote.toUpperCase()}</span>
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
										<th>数值</th>
										<th className="left">更新时间</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{settings.data.fx.map((item) => (
										<tr key={`${item.base}:${item.quote}`}>
											<td className="left">
												1 {item.base} = {item.rate} {item.quote}
											</td>
											<td>{item.rate}</td>
											<td className="left muted">{dateTime(item.updated_at)}</td>
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
						<p className="small muted">
							上次登录：{dateTime(settings.data?.values.setup_done_at ?? null)}（初始化时间）
						</p>
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
					</div>
				</div>
			</div>

			<div className="section">
				<div className="section-head">
					<h2>数据概览</h2>
					<span className="small muted">用来判断是否接近 Cloudflare 免费额度</span>
				</div>
				<div className="card panel">
					<div className="grid cols-4">
						{rowEntries.map(([key, value]) => (
							<div key={key}>
								<div className="label small muted">{key}</div>
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
