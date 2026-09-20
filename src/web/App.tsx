import { lazy, Suspense, useCallback } from "react";
import { api, type AuthMeDto } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { Link, RouterProvider, useRouter } from "./lib/router";
// 首屏只需要 登录 / 初始化 / 总览；其余页面按需加载，避免把设置页和趋势图算进首包
import { SetupPage } from "./pages/Setup";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";

const ChangePasswordPage = lazy(() =>
	import("./pages/ChangePassword").then((module) => ({ default: module.ChangePasswordPage })),
);
const AccountsPage = lazy(() => import("./pages/Accounts").then((module) => ({ default: module.AccountsPage })));
const HoldingsPage = lazy(() => import("./pages/Holdings").then((module) => ({ default: module.HoldingsPage })));
const HistoryPage = lazy(() => import("./pages/History").then((module) => ({ default: module.HistoryPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((module) => ({ default: module.SettingsPage })));

function PageLoading() {
	return <div className="empty">页面加载中…</div>;
}

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
			<Suspense fallback={<PageLoading />}>{page}</Suspense>
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
	if (me.data.mustChange)
		return (
			<Suspense fallback={<PageLoading />}>
				<ChangePasswordPage onDone={refresh} />
			</Suspense>
		);
	return <Shell onAuthChanged={refresh} />;
}

export function App() {
	return (
		<RouterProvider>
			<Gate />
		</RouterProvider>
	);
}
