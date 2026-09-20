/**
 * 前后端共用的 API 数据结构
 *
 * 说明：accounts / holdings 直接返回数据库行的形状（snake_case），
 * 少一层映射代码；portfolio 是聚合结果，用 camelCase。
 */

export type AccountKind = "broker" | "exchange" | "cash";
export type AssetClass = "stock" | "etf" | "crypto" | "fund" | "cash";

export interface AccountDto {
	id: string;
	name: string;
	kind: AccountKind;
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

export interface HoldingDto {
	id: string;
	account_id: string;
	class: AssetClass;
	market: string | null;
	symbol: string | null;
	name: string;
	currency: string;
	qty: number;
	price: number;
	avg_cost: number | null;
	price_updated_at: string | null;
	archived: number;
	note: string | null;
	created_at: string;
	updated_at: string;
}

export interface HoldingListDto extends HoldingDto {
	account_name: string;
	account_kind: string;
	account_icon_key: string | null;
}

export interface BreakdownItem {
	key: string;
	label: string;
	value: number;
	share: number;
}

export interface PortfolioHolding {
	id: string;
	accountId: string;
	accountName: string;
	accountKind: string;
	accountIconKey: string | null;
	class: AssetClass;
	market: string | null;
	symbol: string | null;
	name: string;
	currency: string;
	qty: number;
	price: number;
	avgCost: number | null;
	marketValue: number;
	marketValueDisplay: number | null;
	cost: number | null;
	pnl: number | null;
	pnlPct: number | null;
	/** 折算成显示币种后的成本 / 盈亏（多币种汇总必须用这两个，否则会加错单位） */
	costDisplay: number | null;
	pnlDisplay: number | null;
	priceUpdatedAt: string | null;
	daysSincePriceUpdate: number | null;
	fxMissing: boolean;
	share: number;
	isCash: boolean;
}

export interface Portfolio {
	displayCurrency: string;
	total: number;
	counts: { accounts: number; holdings: number };
	byClass: BreakdownItem[];
	byAccount: BreakdownItem[];
	byCurrency: BreakdownItem[];
	holdings: PortfolioHolding[];
	missingFxCurrencies: string[];
	staleDays: number | null;
	generatedAt: string;
}

export interface FxRateDto {
	base: string;
	quote: string;
	rate: number;
	updated_at: string;
}

export interface SettingsDto {
	values: Record<string, string>;
	fx: FxRateDto[];
	builtInCurrencies: string[];
	currencies: string[];
}

export interface AuditItemDto {
	id: string;
	ts: string;
	actor: string;
	entity: string;
	entityId: string | null;
	action: string;
	source: string;
	note: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	diff: Array<{ field: string; from: unknown; to: unknown }>;
}

export interface AuthMeDto {
	initialized: boolean;
	authenticated: boolean;
	setupTokenRequired: boolean;
	mustChange: boolean;
	lastLoginAt: string | null;
}

export interface OverviewDto {
	rows: Record<string, number>;
	settings: Record<string, string>;
	limits: Record<string, number>;
}

export interface EntityDiff {
	create: number;
	update: number;
	unchanged: number;
	remove: number;
}

export interface ImportPreview {
	mode: "merge" | "replace";
	summary: Record<string, EntityDiff>;
	warnings: string[];
	statementCount: number;
	atomic: boolean;
}

export interface ImportResult {
	preview: ImportPreview;
	applied: { statements: number; atomic: boolean } | null;
}
