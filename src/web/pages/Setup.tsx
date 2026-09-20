import { useState } from "react";
import { api } from "../lib/api";
import { copyText, deriveCredential, ITERATIONS, passwordStrength, randomPassword, randomSaltHex } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";

const CURRENCIES = ["USD", "HKD", "CNY"];

export function SetupPage({ onDone }: { onDone: () => void }) {
	const [setupToken, setSetupToken] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [displayCurrency, setDisplayCurrency] = useState("USD");
	const [suggestion, setSuggestion] = useState("");
	const [copied, setCopied] = useState(false);
	const { pending, error, setError, run } = useSubmit();

	const strength = passwordStrength(password);

	const generate = () => {
		const value = randomPassword(20);
		setSuggestion(value);
		setPassword(value);
		setConfirm(value);
		setCopied(false);
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (password.length < 12) {
			setError("密码至少 12 位");
			return;
		}
		if (password !== confirm) {
			setError("两次输入的密码不一致");
			return;
		}
		await run(async () => {
			const kdfSalt = randomSaltHex();
			const credential = await deriveCredential(password, kdfSalt, ITERATIONS);
			await api.auth.setup({ setupToken, credential, kdfSalt, iterations: ITERATIONS, displayCurrency });
			onDone();
		});
	};

	return (
		<div className="center-screen">
			<form className="card auth-card" onSubmit={submit}>
				<h1>初始化资产管理</h1>
				<p className="sub">
					首次使用需要两步：填入部署时生成的 setup token，然后设置你自己的密码。
					<br />
					数据只保存在你自己的 Cloudflare D1 里。
				</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>Setup Token（部署终端打印的那个值）</span>
					<input
						type="password"
						value={setupToken}
						onChange={(e) => setSetupToken(e.target.value)}
						placeholder="openssl rand -hex 32 生成的值"
						autoComplete="off"
						required
					/>
				</label>

				<label className="field">
					<span>显示币种（之后可在设置里修改）</span>
					<select value={displayCurrency} onChange={(e) => setDisplayCurrency(e.target.value)}>
						{CURRENCIES.map((currency) => (
							<option key={currency} value={currency}>
								{currency}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span>登录密码（至少 12 位）</span>
					<input
						type="text"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>

				<label className="field">
					<span>再输一次</span>
					<input
						type="text"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>

				<div className="row" style={{ marginBottom: 12 }}>
					<button type="button" onClick={generate}>
						生成随机密码
					</button>
					<div className="small muted" style={{ display: "grid", alignContent: "center" }}>
						强度：{strength.hint}
					</div>
				</div>

				{suggestion && (
					<div className="token-box">
						<code>{suggestion}</code>
						<button
							type="button"
							onClick={async () => setCopied(await copyText(suggestion))}
							title="复制"
						>
							{copied ? "已复制" : "复制"}
						</button>
					</div>
				)}

				<button className="primary" type="submit" disabled={pending} style={{ width: "100%" }}>
					{pending ? "初始化中…" : "完成初始化"}
				</button>

				<p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
					密码用 PBKDF2（{ITERATIONS.toLocaleString()} 次迭代）在浏览器里派生，服务器只保存不可逆的校验值。
				</p>
			</form>
		</div>
	);
}
