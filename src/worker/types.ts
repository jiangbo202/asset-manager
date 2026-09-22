/**
 * Worker 绑定与环境类型
 */
export interface Env {
	DB: D1Database;
	/** 首次初始化用的一次性口令（部署时写入 Secret） */
	SETUP_TOKEN: string;
	/** 会话签名/派生用的密钥 */
	SESSION_SECRET: string;
}

export interface SessionRow {
	id: string;
	created_at: string;
	expires_at: string;
	last_seen: string | null;
	ua: string | null;
	ip: string | null;
}

export interface AuthRow {
	id: number;
	algo: string;
	kdf_salt: string;
	iterations: number;
	verifier: string;
	verifier_salt: string;
	must_change: number;
	created_at: string;
	updated_at: string;
	last_login_at: string | null;
}

export interface AccountRow {
	id: string;
	name: string;
	kind: "broker" | "exchange" | "cash";
	market: string | null;
	currency: string;
	icon_key: string | null;
	icon_data: string | null;
	sort: number;
	archived: number;
	note: string | null;
	created_at: string;
	updated_at: string;
}

export interface HoldingRow {
	id: string;
	account_id: string;
	class: "stock" | "etf" | "crypto" | "fund" | "cash";
	market: string | null;
	symbol: string | null;
	name: string;
	currency: string;
	qty: number;
	price: number;
	avg_cost: number | null;
	price_updated_at: string | null;
	quote_source: string | null;
	quote_symbol: string | null;
	archived: number;
	note: string | null;
	created_at: string;
	updated_at: string;
}

/** Hono 环境类型 */
export interface AppEnv {
	Bindings: Env;
	Variables: {
		session: SessionRow | null;
		/**
		 * auth 行（单用户凭据）。由 app.ts 的上下文中间件与会话一起读出（1 次 batch），
		 * 所以 requireInitialized / requireAuth / 路由不用再查一次：
		 * auth 行存在 = 已初始化。
		 */
		auth: AuthRow | null;
		/** 请求语言（由 Accept-Language 判定），用于把提示文案本地化 */
		lang: "zh" | "en";
		/**
		 * 匿名访客（「公开只读分享」开启时被放行）。路由用它做脱敏，
		 * 例如账户备注不该出现在公开视图里。
		 */
		publicViewer?: boolean;
	};
}
