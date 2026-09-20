import { useState } from "react";
import { api } from "../lib/api";
import { deriveCredential, ITERATIONS, randomSaltHex } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";

/** 强制修改初始密码（PRD FR-1.3）：must_change = 1 时其他接口都会 403 */
export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
	const [oldPassword, setOldPassword] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const { pending, error, setError, run } = useSubmit();

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (password.length < 12) {
			setError("新密码至少 12 位");
			return;
		}
		if (password !== confirm) {
			setError("两次输入的新密码不一致");
			return;
		}
		await run(async () => {
			const params = await api.auth.params();
			if (!params.kdfSalt) throw new Error("尚未初始化");
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
				<h1>修改初始密码</h1>
				<p className="sub">为了安全，请先把初始密码改成你自己的密码。</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>当前密码</span>
					<input
						type="password"
						value={oldPassword}
						onChange={(e) => setOldPassword(e.target.value)}
						autoComplete="current-password"
						required
					/>
				</label>
				<label className="field">
					<span>新密码（至少 12 位）</span>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>
				<label className="field">
					<span>再输一次新密码</span>
					<input
						type="password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</label>

				<button className="primary" type="submit" disabled={pending} style={{ width: "100%" }}>
					{pending ? "提交中…" : "修改并继续"}
				</button>
			</form>
		</div>
	);
}
