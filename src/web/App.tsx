import { useCallback } from "react";
import { api, type AuthMeDto } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { Link, RouterProvider, useRouter } from "./lib/router";
import { SetupPage } from "./pages/Setup";
import { LoginPage } from "./pages/Login";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { DashboardPage } from "./pages/Dashboard";
import { AccountsPage } from "./pages/Accounts";
import { HoldingsPage } from "./pages/Holdings";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";

const NAV = [
	{ to: "/", label: "总览" },
	{ to: "/accounts", label: "账户" },
	{ to: "/holdings", label: "持仓" },
	{ to: "/history", label: "操作历史" },
	{ to: "/settings", label: "设置" },
];

function Shell({ onAuthChanged }: { onAuthChanged: () => void }) {
	const { path } = useRouter();

	const page = (() => {
		if (path.startsWith("/accounts")) return <AccountsPage />;
		if (path.startsWith("/holdings")) return <HoldingsPage />;
		if (path.startsWith("/history")) return <HistoryPage />;
		if (path.startsWith("/settings")) return <SettingsPage onChanged={onAuthChanged} />;
		return <DashboardPage />;
	})();

	return (
		<div className="app-shell">
			<div className="topbar">
				<span className="brand">资产管理</span>
				<nav className="nav">
					{NAV.map((item) => (
						<Link key={item.to} to={item.to} className={path === item.to ? "active" : ""}>
							{item.label}
						</Link>
					))}
				</nav>
				<div className="spacer" />
				<button
					className="ghost"
					onClick={async () => {
						await api.auth.logout();
						onAuthChanged();
					}}
				>
					登出
				</button>
			</div>
			{page}
		</div>
	);
}

function Gate() {
	const me = useAsync<AuthMeDto>(() => api.auth.me(), []);

	const refresh = useCallback(() => {
		me.reload();
	}, [me]);

	if (me.loading && !me.data) {
		return <div className="center-screen muted">加载中…</div>;
	}
	if (me.error || !me.data) {
		return (
			<div className="center-screen">
				<div className="card auth-card">
					<h1>无法连接</h1>
					<p className="sub">{me.error ?? "未知错误"}</p>
					<button onClick={() => me.reload()}>重试</button>
				</div>
			</div>
		);
	}

	if (!me.data.initialized) return <SetupPage onDone={refresh} />;
	if (!me.data.authenticated) return <LoginPage onDone={refresh} />;
	if (me.data.mustChange) return <ChangePasswordPage onDone={refresh} />;
	return <Shell onAuthChanged={refresh} />;
}

export function App() {
	return (
		<RouterProvider>
			<Gate />
		</RouterProvider>
	);
}
