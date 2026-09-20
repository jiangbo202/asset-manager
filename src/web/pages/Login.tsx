import { useState } from "react";
import { api } from "../lib/api";
import { deriveCredential } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";
import { useT } from "../lib/i18n";

export function LoginPage({ onDone }: { onDone: () => void }) {
	const t = useT();
	const [password, setPassword] = useState("");
	const { pending, error, run } = useSubmit();

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		await run(async () => {
			const params = await api.auth.params();
			if (!params.initialized || !params.kdfSalt) throw new Error(t("error.not_initialized"));
			const credential = await deriveCredential(password, params.kdfSalt, params.iterations);
			await api.auth.login({ credential });
			setPassword("");
			onDone();
		});
	};

	return (
		<div className="center-screen">
			<form className="card auth-card" onSubmit={submit}>
				<h1>{t("login.title")}</h1>
				<p className="sub">{t("login.subtitle")}</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>{t("login.password")}</span>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="current-password"
						autoFocus
						required
					/>
				</label>

				<button className="primary" type="submit" disabled={pending} style={{ width: "100%" }}>
					{pending ? t("login.submitting") : t("login.submit")}
				</button>
			</form>
		</div>
	);
}
