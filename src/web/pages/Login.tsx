import { useState } from "react";
import { api } from "../lib/api";
import { deriveCredential } from "../lib/crypto";
import { useSubmit } from "../lib/useAsync";

export function LoginPage({ onDone }: { onDone: () => void }) {
	const [password, setPassword] = useState("");
	const { pending, error, run } = useSubmit();

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		await run(async () => {
			const params = await api.auth.params();
			if (!params.initialized || !params.kdfSalt) throw new Error("尚未初始化");
			const credential = await deriveCredential(password, params.kdfSalt, params.iterations);
			await api.auth.login({ credential });
			setPassword("");
			onDone();
		});
	};

	return (
		<div className="center-screen">
			<form className="card auth-card" onSubmit={submit}>
				<h1>资产管理</h1>
				<p className="sub">请输入密码登录</p>

				{error && <div className="alert error">{error}</div>}

				<label className="field">
					<span>密码</span>
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
					{pending ? "登录中…" : "登录"}
				</button>
			</form>
		</div>
	);
}
