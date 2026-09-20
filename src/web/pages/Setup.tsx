import { useState } from "react";
import { api } from "../lib/api";
import { copyText, deriveCredential, ITERATIONS, passwordStrength, randomPassword, randomSaltHex } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";
import { useT } from "../lib/i18n";

const CURRENCIES = ["USD", "HKD", "CNY"];

export function SetupPage({ onDone }: { onDone: () => void }) {
	const t = useT();
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
			setError(t("setup.errorTooShort"));
			return;
		}
		if (password !== confirm) {
			setError(t("setup.errorMismatch"));
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
				<h1>{t("setup.title")}</h1>
				<p className="sub">
					{t("setup.intro")}
					<br />
					{t("setup.privacy")}
				</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>{t("setup.tokenLabel")}</span>
					<input
						type="password"
						value={setupToken}
						onChange={(e) => setSetupToken(e.target.value)}
						placeholder={t("setup.tokenPlaceholder")}
						autoComplete="off"
						required
					/>
				</label>

				<label className="field">
					<span>{t("setup.currencyLabel")}</span>
					<select value={displayCurrency} onChange={(e) => setDisplayCurrency(e.target.value)}>
						{CURRENCIES.map((currency) => (
							<option key={currency} value={currency}>
								{currency}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span>{t("setup.passwordLabel")}</span>
					<input
						type="text"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>

				<label className="field">
					<span>{t("setup.confirmLabel")}</span>
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
						{t("setup.generate")}
					</button>
					<div className="small muted" style={{ display: "grid", alignContent: "center" }}>
						{t("setup.strength")}
						{t(`pwd.strength${strength}`)}
					</div>
				</div>

				{suggestion && (
					<div className="token-box">
						<code>{suggestion}</code>
						<button
							type="button"
							onClick={async () => setCopied(await copyText(suggestion))}
							title={t("common.copy")}
						>
							{copied ? t("common.copied") : t("common.copy")}
						</button>
					</div>
				)}

				<button className="primary" type="submit" disabled={pending} style={{ width: "100%" }}>
					{pending ? t("setup.submitting") : t("setup.submit")}
				</button>

				<p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
					{t("setup.pbkdf2Note", { iterations: ITERATIONS.toLocaleString() })}
				</p>
			</form>
		</div>
	);
}
