import { lazy, Suspense, useCallback, useEffect } from "react";
import { api, type AuthMeDto } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { Link, RouterProvider, useRouter } from "./lib/router";
import { I18nProvider, useI18n, useT } from "./lib/i18n";
import type { LanguageSetting } from "../shared/i18n";
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
	const t = useT();
	return <div className="empty">{t("common.loadingPage")}</div>;
}

const NAV = [
	{ to: "/", key: "nav.overview" },
	{ to: "/accounts", key: "nav.accounts" },
	{ to: "/holdings", key: "nav.holdings" },
	{ to: "/history", key: "nav.history" },
	{ to: "/settings", key: "nav.settings" },
] as const;

function Shell({ onAuthChanged }: { onAuthChanged: () => void }) {
	const { path } = useRouter();
	const t = useT();

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
				<span className="brand">{t("app.name")}</span>
				<nav className="nav">
					{NAV.map((item) => (
						<Link key={item.to} to={item.to} className={path === item.to ? "active" : ""}>
							{t(item.key)}
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
					{t("nav.logout")}
				</button>
			</div>
			<Suspense fallback={<PageLoading />}>{page}</Suspense>
		</div>
	);
}

/**
 * 「公开只读分享」下匿名访客看到的外壳
 *
 * 只挂总览一个入口，右上角是登录按钮（必须输密码才会真的进来）。
 * 这里只是不渲染入口，真正的边界在服务端：middleware.ts 的 PUBLIC_READ_ROUTES 白名单，
 * 其余接口对匿名一律 401 —— 就算有人在地址栏手敲 /settings 也只会看到登录页。
 */
function PublicShell({ onAuthChanged }: { onAuthChanged: () => void }) {
	const { path, navigate } = useRouter();
	const t = useT();

	// 访客只有总览和登录两处可去：手敲 /settings 之类不会被"顺路"渲染出别的东西，
	// 直接按回总览（服务端那些接口对匿名本来也是 401）。
	useEffect(() => {
		if (path === "/" || path.startsWith("/login")) return;
		navigate("/", { replace: true });
	}, [path, navigate]);

	if (path.startsWith("/login")) {
		return (
			<LoginPage
				onDone={() => {
					onAuthChanged();
					// 登录成功后回到总览（此时已拿到完整权限）
					navigate("/", { replace: true });
				}}
			/>
		);
	}

	return (
		<div className="app-shell">
			<div className="topbar">
				<span className="brand">{t("app.name")}</span>
				<span className="badge-readonly">{t("public.readonly")}</span>
				<nav className="nav">
					<Link to="/">{t("nav.overview")}</Link>
				</nav>
				<div className="spacer" />
				<nav className="nav">
					<Link to="/login">{t("public.login")}</Link>
				</nav>
			</div>
			<DashboardPage readOnly />
		</div>
	);
}

function Gate() {
	const me = useAsync<AuthMeDto>(() => api.auth.me(), []);
	const t = useT();
	const { applySetting, applyTimeZone, ready } = useI18n();

	// 服务端保存的语言与时区偏好：进入页面即生效（localStorage 里也存语言，下次开屏不等网络）
	const serverLanguage = me.data?.language;
	useEffect(() => {
		if (serverLanguage) applySetting(serverLanguage as LanguageSetting);
	}, [serverLanguage, applySetting]);

	const serverTimeZone = me.data?.timezone;
	useEffect(() => {
		if (serverTimeZone) applyTimeZone(serverTimeZone);
	}, [serverTimeZone, applyTimeZone]);

	// 非默认语言的字典还在加载：等它就绪再渲染，避免先闪一下中文
	if (!ready) return <div className="center-screen muted">…</div>;

	const refresh = useCallback(() => {
		me.reload();
	}, [me]);

	if (me.data?.migrationRequired || me.errorCode === "migration_required") {
		return (
			<div className="center-screen">
				<div className="card auth-card">
					<h1>{t("gate.migrationTitle")}</h1>
					<p className="sub">
						{t("gate.migrationIntro")}
						<br />
						{t("gate.migrationIdempotent")}
					</p>
					{me.data?.migrationRequired && (
						<p className="small muted">
							{t("gate.migrationVersion", {
								current: me.data.schemaVersion,
								expected: me.data.expectedSchemaVersion,
							})}
						</p>
					)}
					<div className="token-box">
						<code>npm run db:migrate:local</code>
					</div>
					<p className="small muted">{t("gate.migrationRemote")}</p>
					<button onClick={() => me.reload()}>{t("gate.migrationRetry")}</button>
				</div>
			</div>
		);
	}

	if (me.loading && !me.data) {
		return <div className="center-screen muted">{t("common.loading")}</div>;
	}

	if (me.error || !me.data) {
		return (
			<div className="center-screen">
				<div className="card auth-card">
					<h1>{t("gate.cannotConnect")}</h1>
					<p className="sub">{me.error ?? t("common.unknownError")}</p>
					<button onClick={() => me.reload()}>{t("common.retry")}</button>
				</div>
			</div>
		);
	}

	if (!me.data.initialized) return <SetupPage onDone={refresh} />;
	// 未登录：开关开着就给只读总览（右上角可登录），关着就是原来的登录页
	if (!me.data.authenticated) {
		if (me.data.publicView) return <PublicShell onAuthChanged={refresh} />;
		return <LoginPage onDone={refresh} />;
	}
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
		<I18nProvider>
			<RouterProvider>
				<Gate />
			</RouterProvider>
		</I18nProvider>
	);
}
