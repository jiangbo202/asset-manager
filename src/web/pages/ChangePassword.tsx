import { useState } from "react";
import { api } from "../lib/api";
import { deriveCredential, ITERATIONS, randomSaltHex } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";
import { useT } from "../lib/i18n";

/** 强制修改初始密码（PRD FR-1.3）：must_change = 1 时其他接口都会 403 */
export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
	const t = useT();
	const [oldPassword, setOldPassword] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const { pending, error, setError, run } = useSubmit();

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (password.length < 12) {
			setError(t("changePwd.errorTooShort"));
			return;
		}
		if (password !== confirm) {
			setError(t("changePwd.errorMismatch"));
			return;
		}
		await run(async () => {
			const params = await api.auth.params();
			if (!params.kdfSalt) throw new Error(t("error.not_initialized"));
			const oldCredential = await deriveCredential(oldPassword, params.kdfSalt, params.iterations);
			const kdfSalt = randomSaltHex();
			const newCredential = await deriveCredential(password, kdfSalt, ITERATIONS);
			await api.auth.changePassword({ oldCredential, newCredential, kdfSalt, iterations: ITERATIONS });
			onDone();
		});
	};

	return (
		<div className="center-screen">
			<form className="card auth-card" onSubmit={submit}>
				<h1>{t("changePwd.title")}</h1>
				<p className="sub">{t("changePwd.subtitle")}</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>{t("changePwd.current")}</span>
					<input
						type="password"
						value={oldPassword}
						onChange={(e) => setOldPassword(e.target.value)}
						autoComplete="current-password"
						required
					/>
				</label>
				<label className="field">
					<span>{t("changePwd.new")}</span>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>
				<label className="field">
					<span>{t("changePwd.confirm")}</span>
					<input
						type="password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>

				<button className="primary" type="submit" disabled={pending} style={{ width: "100%" }}>
					{pending ? t("changePwd.submitting") : t("changePwd.submit")}
				</button>
			</form>
		</div>
	);
}
