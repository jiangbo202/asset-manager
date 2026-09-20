import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, APP_VERSION } from "../../shared/version";
import { ApiError } from "../core/errors";
import { isRecord } from "../core/utils";

/**
 * 备份导出 / 导入（PRD FR-8）
 *
 * 设计要点：
 *  - 导出**不包含**凭据（auth）与会话（sessions）：换环境后需要重新初始化，但数据不丢
 *  - 审计日志永不删除：replace 模式也只覆盖业务数据，历史记录持续追加（否则等于销毁证据）
 *  - 导入前必须能通过"全量校验 + 差异预览"，再让用户确认（FR-8.4）
 *  - 所有写入放进 D1 batch（单次批量提交即一个事务），保证原子性
 */

export interface AccountRecord {
	id: string;
	name: string;
	kind: string;
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

export interface HoldingRecord {
	id: string;
	account_id: string;
	class: string;
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

export interface PriceHistoryRecord {
	id: string;
	holding_id: string;
	effective_date: string;
	price: number;
	source: string;
	created_at: string;
}

export interface QtyHistoryRecord {
	id: string;
	holding_id: string;
	effective_date: string;
	qty: number;
	source: string;
	created_at: string;
}

export interface FxRateRecord {
	base: string;
	quote: string;
	rate: number;
	updated_at: string;
}

export interface FxRateHistoryRecord {
	id: string;
	base: string;
	quote: string;
	rate: number;
	changed_at: string;
}

export interface AuditRecord {
	id: string;
	ts: string;
	actor: string;
	entity: string;
	entity_id: string | null;
	action: string;
	before_json: string | null;
	after_json: string | null;
	source: string;
	note: string | null;
}

export interface BackupData {
	accounts: AccountRecord[];
	holdings: HoldingRecord[];
	priceHistory: PriceHistoryRecord[];
	qtyHistory: QtyHistoryRecord[];
	fxRates: FxRateRecord[];
	fxRateHistory: FxRateHistoryRecord[];
	settings: Record<string, string>;
	auditLog: AuditRecord[];
}

export interface BackupFile {
	format: typeof BACKUP_FORMAT;
	schemaVersion: number;
	appVersion: string;
	exportedAt: string;
	data: BackupData;
}

const LIMITS = {
	accounts: 2_000,
	holdings: 20_000,
	priceHistory: 100_000,
	qtyHistory: 100_000,
	fxRates: 500,
	fxRateHistory: 20_000,
	auditLog: 100_000,
} as const;

/** 单次 batch 的语句上限（超过则分批；分批之间不再是同一个事务） */
const SINGLE_BATCH_MAX = 1_000;
const CHUNK_SIZE = 500;

export type ImportMode = "replace" | "merge";

export interface EntityDiff {
	create: number;
	update: number;
	unchanged: number;
	remove: number;
}

export interface ImportPreview {
	mode: ImportMode;
	summary: Record<string, EntityDiff>;
	warnings: string[];
	statementCount: number;
	atomic: boolean;
}

const CLASSES = new Set(["stock", "etf", "crypto", "fund", "cash"]);
const KINDS = new Set(["broker", "exchange", "cash"]);
const CURRENCY = /^[A-Za-z]{3,5}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string) => new ApiError(400, "invalid_backup", message);

const asArray = (value: unknown, label: string, limit: number): unknown[] => {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw bad(`${label} 必须是数组`);
	if (value.length > limit) throw bad(`${label} 条数超过上限 ${limit}，请改用 wrangler d1 execute 导入`);
	return value;
};

const str = (value: unknown, label: string, max = 500): string => {
	if (typeof value !== "string" || value.trim() === "") throw bad(`${label} 必须是非空字符串`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw bad(`${label} 过长（>${max}）`);
	return trimmed;
};

const strOrNull = (value: unknown, max = 500): string | null => {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") throw bad("期望字符串或 null");
	return value.length > max ? value.slice(0, max) : value;
};

const num = (value: unknown, label: string, options: { min?: number; max?: number } = {}): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw bad(`${label} 必须是数字`);
	if (options.min !== undefined && parsed < options.min) throw bad(`${label} 不能小于 ${options.min}`);
	if (options.max !== undefined && parsed > options.max) throw bad(`${label} 不能大于 ${options.max}`);
	return parsed;
};

const numOrNull = (value: unknown, label: string): number | null => {
	if (value === undefined || value === null || value === "") return null;
	return num(value, label);
};

const flag = (value: unknown): number => (value === true || value === 1 || value === "1" ? 1 : 0);

const iso = (value: unknown, label: string): string => {
	const text = str(value, label, 40);
	if (Number.isNaN(Date.parse(text))) throw bad(`${label} 不是合法时间`);
	return text;
};

const isoOrNull = (value: unknown, label: string): string | null => {
	if (value === undefined || value === null || value === "") return null;
	return iso(value, label);
};

const currency = (value: unknown, label: string): string => {
	const text = str(value, label, 5).toUpperCase();
	if (!CURRENCY.test(text)) throw bad(`${label} 必须是 3~5 个字母`);
	return text;
};

/** 导出：只导出业务数据，不含凭据与会话 */
export async function exportBackup(db: D1Database, options: { includeAudit: boolean }): Promise<BackupFile> {
	const [accounts, holdings, priceHistory, qtyHistory, fxRates, fxRateHistory, settings, auditLog] = await Promise.all([
		db.prepare("SELECT * FROM accounts ORDER BY sort, created_at").all<AccountRecord>(),
		db.prepare("SELECT * FROM holdings ORDER BY created_at").all<HoldingRecord>(),
		db.prepare("SELECT * FROM price_history ORDER BY effective_date").all<PriceHistoryRecord>(),
		db.prepare("SELECT * FROM qty_history ORDER BY effective_date").all<QtyHistoryRecord>(),
		db.prepare("SELECT * FROM fx_rates ORDER BY base, quote").all<FxRateRecord>(),
		db.prepare("SELECT * FROM fx_rate_history ORDER BY changed_at").all<FxRateHistoryRecord>(),
		db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>(),
		options.includeAudit
			? db.prepare("SELECT * FROM audit_log ORDER BY ts").all<AuditRecord>()
			: Promise.resolve({ results: [] as AuditRecord[] }),
	]);

	const settingsMap: Record<string, string> = {};
	for (const row of settings.results ?? []) settingsMap[row.key] = row.value;

	return {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		appVersion: APP_VERSION,
		exportedAt: new Date().toISOString(),
		data: {
			accounts: accounts.results ?? [],
			holdings: holdings.results ?? [],
			priceHistory: priceHistory.results ?? [],
			qtyHistory: qtyHistory.results ?? [],
			fxRates: fxRates.results ?? [],
			fxRateHistory: fxRateHistory.results ?? [],
			settings: settingsMap,
			auditLog: auditLog.results ?? [],
		},
	};
}

/** 全量校验 + 规范化：任何结构问题都直接报错，不做"猜" */
export function parseBackup(input: unknown): { file: BackupFile; warnings: string[] } {
	if (!isRecord(input)) throw bad("备份文件内容必须是 JSON 对象");
	if (input.format !== BACKUP_FORMAT) throw bad(`备份文件格式不匹配（期望 format=${BACKUP_FORMAT}）`);

	const schemaVersion = num(input.schemaVersion, "schemaVersion", { min: 1, max: 1000 });
	if (schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw bad(`备份来自更高版本（schemaVersion=${schemaVersion}），请先升级本应用`);
	}

	const data = input.data;
	if (!isRecord(data)) throw bad("备份文件缺少 data 字段");

	const warnings: string[] = [];

	const accountIds = new Set<string>();
	const accounts = asArray(data.accounts, "accounts", LIMITS.accounts).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		const record: AccountRecord = {
			id: str(row.id, `accounts[${index}].id`, 64),
			name: str(row.name, `accounts[${index}].name`, 60),
			kind: str(row.kind, `accounts[${index}].kind`, 16),
			market: strOrNull(row.market, 16),
			currency: currency(row.currency, `accounts[${index}].currency`),
			icon_key: strOrNull(row.icon_key, 40),
			icon_data: strOrNull(row.icon_data, 200_000),
			sort: numOrNull(row.sort, `accounts[${index}].sort`) ?? 0,
			archived: flag(row.archived),
			note: strOrNull(row.note, 200),
			created_at: iso(row.created_at, `accounts[${index}].created_at`),
			updated_at: iso(row.updated_at, `accounts[${index}].updated_at`),
		};
		if (!KINDS.has(record.kind)) throw bad(`accounts[${index}].kind 取值非法：${record.kind}`);
		if (accountIds.has(record.id)) throw bad(`accounts 存在重复 id：${record.id}`);
		accountIds.add(record.id);
		return record;
	});

	const holdings = asArray(data.holdings, "holdings", LIMITS.holdings).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		const record: HoldingRecord = {
			id: str(row.id, `holdings[${index}].id`, 64),
			account_id: str(row.account_id, `holdings[${index}].account_id`, 64),
			class: str(row.class, `holdings[${index}].class`, 16),
			market: strOrNull(row.market, 16),
			symbol: strOrNull(row.symbol, 32),
			name: str(row.name, `holdings[${index}].name`, 80),
			currency: currency(row.currency, `holdings[${index}].currency`),
			qty: num(row.qty, `holdings[${index}].qty`, { min: -1e15, max: 1e15 }),
			price: num(row.price, `holdings[${index}].price`, { min: 0, max: 1e15 }),
			avg_cost: numOrNull(row.avg_cost, `holdings[${index}].avg_cost`),
			price_updated_at: isoOrNull(row.price_updated_at, `holdings[${index}].price_updated_at`),
			archived: flag(row.archived),
			note: strOrNull(row.note, 200),
			created_at: iso(row.created_at, `holdings[${index}].created_at`),
			updated_at: iso(row.updated_at, `holdings[${index}].updated_at`),
		};
		if (!CLASSES.has(record.class)) throw bad(`holdings[${index}].class 取值非法：${record.class}`);
		if (record.avg_cost !== null && record.avg_cost < 0) throw bad(`holdings[${index}].avg_cost 不能为负`);
		return record;
	});

	const holdingIds = new Set(holdings.map((item) => item.id));
	const priceHistory = asArray(data.priceHistory, "priceHistory", LIMITS.priceHistory).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		const record: PriceHistoryRecord = {
			id: str(row.id, `priceHistory[${index}].id`, 64),
			holding_id: str(row.holding_id, `priceHistory[${index}].holding_id`, 64),
			effective_date: str(row.effective_date, `priceHistory[${index}].effective_date`, 10),
			price: num(row.price, `priceHistory[${index}].price`),
			source: strOrNull(row.source, 16) ?? "import",
			created_at: iso(row.created_at, `priceHistory[${index}].created_at`),
		};
		if (!ISO_DATE.test(record.effective_date)) throw bad(`priceHistory[${index}].effective_date 应为 YYYY-MM-DD`);
		return record;
	});

	const qtyHistory = asArray(data.qtyHistory, "qtyHistory", LIMITS.qtyHistory).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		const record: QtyHistoryRecord = {
			id: str(row.id, `qtyHistory[${index}].id`, 64),
			holding_id: str(row.holding_id, `qtyHistory[${index}].holding_id`, 64),
			effective_date: str(row.effective_date, `qtyHistory[${index}].effective_date`, 10),
			qty: num(row.qty, `qtyHistory[${index}].qty`),
			source: strOrNull(row.source, 16) ?? "import",
			created_at: iso(row.created_at, `qtyHistory[${index}].created_at`),
		};
		if (!ISO_DATE.test(record.effective_date)) throw bad(`qtyHistory[${index}].effective_date 应为 YYYY-MM-DD`);
		return record;
	});

	const fxRates = asArray(data.fxRates, "fxRates", LIMITS.fxRates).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		return {
			base: currency(row.base, `fxRates[${index}].base`),
			quote: currency(row.quote, `fxRates[${index}].quote`),
			rate: num(row.rate, `fxRates[${index}].rate`, { min: 0.0000001, max: 1e9 }),
			updated_at: iso(row.updated_at, `fxRates[${index}].updated_at`),
		} satisfies FxRateRecord;
	});

	const fxRateHistory = asArray(data.fxRateHistory, "fxRateHistory", LIMITS.fxRateHistory).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		return {
			id: str(row.id, `fxRateHistory[${index}].id`, 64),
			base: currency(row.base, `fxRateHistory[${index}].base`),
			quote: currency(row.quote, `fxRateHistory[${index}].quote`),
			rate: num(row.rate, `fxRateHistory[${index}].rate`),
			changed_at: iso(row.changed_at, `fxRateHistory[${index}].changed_at`),
		} satisfies FxRateHistoryRecord;
	});

	const settingsRaw = isRecord(data.settings) ? data.settings : {};
	const settings: Record<string, string> = {};
	for (const [key, value] of Object.entries(settingsRaw)) {
		if (typeof value !== "string") throw bad(`settings.${key} 必须是字符串`);
		if (key.length > 60 || value.length > 500) throw bad(`settings.${key} 过长`);
		settings[key] = value;
	}

	const auditLog = asArray(data.auditLog, "auditLog", LIMITS.auditLog).map((raw, index) => {
		const row = isRecord(raw) ? raw : {};
		return {
			id: str(row.id, `auditLog[${index}].id`, 64),
			ts: iso(row.ts, `auditLog[${index}].ts`),
			actor: strOrNull(row.actor, 60) ?? "owner",
			entity: str(row.entity, `auditLog[${index}].entity`, 40),
			entity_id: strOrNull(row.entity_id, 64),
			action: str(row.action, `auditLog[${index}].action`, 40),
			before_json: strOrNull(row.before_json, 200_000),
			after_json: strOrNull(row.after_json, 200_000),
			source: strOrNull(row.source, 16) ?? "import",
			note: strOrNull(row.note, 200),
		} satisfies AuditRecord;
	});

	// 引用完整性：持仓必须能指向存在的账户；历史必须能指向存在的持仓
	const orphanHoldings = holdings.filter((item) => !accountIds.has(item.account_id));
	if (orphanHoldings.length > 0) {
		throw bad(`有 ${orphanHoldings.length} 条持仓引用了不存在的账户（例：${orphanHoldings[0].id}）`);
	}
	const missingHoldingHistory =
		priceHistory.filter((item) => !holdingIds.has(item.holding_id)).length +
		qtyHistory.filter((item) => !holdingIds.has(item.holding_id)).length;
	if (missingHoldingHistory > 0) {
		warnings.push(`有 ${missingHoldingHistory} 条价格/数量历史引用不到持仓，导入时会被忽略`);
	}

	const file: BackupFile = {
		format: BACKUP_FORMAT,
		schemaVersion,
		appVersion: typeof input.appVersion === "string" ? input.appVersion : "unknown",
		exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString(),
		data: {
			accounts,
			holdings,
			priceHistory: priceHistory.filter((item) => holdingIds.has(item.holding_id)),
			qtyHistory: qtyHistory.filter((item) => holdingIds.has(item.holding_id)),
			fxRates,
			fxRateHistory,
			settings,
			auditLog,
		},
	};

	if (schemaVersion < BACKUP_SCHEMA_VERSION) {
		warnings.push(`备份由较旧版本（schemaVersion=${schemaVersion}）导出，已按当前格式读取`);
	}

	return { file, warnings };
}

async function existingIds(db: D1Database, table: string): Promise<Set<string>> {
	const { results } = await db.prepare(`SELECT id FROM ${table}`).all<{ id: string }>();
	return new Set((results ?? []).map((row) => row.id));
}

/** 差异预览：导入前让用户看到会发生什么（FR-8.4） */
export async function previewBackup(
	db: D1Database,
	file: BackupFile,
	mode: ImportMode,
	parseWarnings: string[] = [],
): Promise<ImportPreview> {
	const [accountIds, holdingIds, priceIds, qtyIds, fxHistoryIds, auditIds, currentSettings] = await Promise.all([
		existingIds(db, "accounts"),
		existingIds(db, "holdings"),
		existingIds(db, "price_history"),
		existingIds(db, "qty_history"),
		existingIds(db, "fx_rate_history"),
		existingIds(db, "audit_log"),
		db.prepare("SELECT key FROM settings").all<{ key: string }>(),
	]);

	const count = (incomingIds: string[], existing: Set<string>, replaceLike: boolean): EntityDiff => {
		const create = incomingIds.filter((id) => !existing.has(id)).length;
		const update = incomingIds.length - create;
		return {
			create,
			update,
			unchanged: 0,
			remove: replaceLike ? Math.max(0, existing.size - update) : 0,
		};
	};

	const settingsKeys = Object.keys(file.data.settings);
	const currentKeys = new Set((currentSettings.results ?? []).map((row) => row.key));
	const settingsCreate = settingsKeys.filter((key) => !currentKeys.has(key)).length;

	const summary: Record<string, EntityDiff> = {
		accounts: count(
			file.data.accounts.map((item) => item.id),
			accountIds,
			mode === "replace",
		),
		holdings: count(
			file.data.holdings.map((item) => item.id),
			holdingIds,
			mode === "replace",
		),
		priceHistory: count(
			file.data.priceHistory.map((item) => item.id),
			priceIds,
			mode === "replace",
		),
		qtyHistory: count(
			file.data.qtyHistory.map((item) => item.id),
			qtyIds,
			mode === "replace",
		),
		fxRateHistory: count(
			file.data.fxRateHistory.map((item) => item.id),
			fxHistoryIds,
			false,
		),
		auditLog: count(
			file.data.auditLog.map((item) => item.id),
			auditIds,
			false,
		),
		settings: { create: settingsCreate, update: settingsKeys.length - settingsCreate, unchanged: 0, remove: 0 },
	};

	const statementCount = countStatements(file, mode);
	const warnings = [...parseWarnings];

	const missingFx = new Set<string>();
	const displayCurrency = file.data.settings.display_currency ?? "USD";
	const hasRate = (from: string, to: string) =>
		file.data.fxRates.some(
			(item) => (item.base === from && item.quote === to) || (item.base === to && item.quote === from),
		);
	for (const holding of file.data.holdings) {
		if (holding.currency !== displayCurrency && !hasRate(holding.currency, displayCurrency)) {
			missingFx.add(holding.currency);
		}
	}
	if (missingFx.size > 0) {
		warnings.push(`缺少汇率：${[...missingFx].join("、")}（导入后这些持仓会显示为"未折算"，补上汇率即可）`);
	}
	if (mode === "replace") {
		warnings.push("replace 模式会先清空现有账户/持仓/汇率/设置，再写入备份内容；操作历史会保留并追加。");
	}
	if (statementCount > SINGLE_BATCH_MAX) {
		warnings.push(
			`数据量较大（${statementCount} 条语句），将分批写入；如中途失败可能只写入了一部分，建议先导出当前数据。`,
		);
	}

	return {
		mode,
		summary,
		warnings,
		statementCount,
		atomic: statementCount <= SINGLE_BATCH_MAX,
	};
}

function countStatements(file: BackupFile, mode: ImportMode): number {
	const data = file.data;
	let count =
		data.accounts.length +
		data.holdings.length +
		data.priceHistory.length +
		data.qtyHistory.length +
		data.fxRates.length +
		data.fxRateHistory.length +
		Object.keys(data.settings).length +
		data.auditLog.length;
	if (mode === "replace") count += 7; // 各表的 DELETE
	return count;
}

const ACCOUNT_COLUMNS =
	"id, name, kind, market, currency, icon_key, icon_data, sort, archived, note, created_at, updated_at";
const HOLDING_COLUMNS =
	"id, account_id, class, market, symbol, name, currency, qty, price, avg_cost, price_updated_at, archived, note, created_at, updated_at";

/** 应用导入：单次 batch 内完成（原子）。数据量超过单批上限时自动分批 */
export async function applyBackup(
	db: D1Database,
	file: BackupFile,
	mode: ImportMode,
): Promise<{ statements: number; atomic: boolean }> {
	const data = file.data;
	const statements: D1PreparedStatement[] = [];

	if (mode === "replace") {
		for (const table of [
			"price_history",
			"qty_history",
			"holdings",
			"accounts",
			"fx_rate_history",
			"fx_rates",
			"settings",
		]) {
			statements.push(db.prepare(`DELETE FROM ${table}`));
		}
	}

	const accountConflict =
		mode === "replace"
			? ""
			: ` ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, market=excluded.market,
			    currency=excluded.currency, icon_key=excluded.icon_key, icon_data=excluded.icon_data,
			    sort=excluded.sort, archived=excluded.archived, note=excluded.note, updated_at=excluded.updated_at`;
	for (const row of data.accounts) {
		statements.push(
			db
				.prepare(`INSERT INTO accounts (${ACCOUNT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)${accountConflict}`)
				.bind(
					row.id,
					row.name,
					row.kind,
					row.market,
					row.currency,
					row.icon_key,
					row.icon_data,
					row.sort,
					row.archived,
					row.note,
					row.created_at,
					row.updated_at,
				),
		);
	}

	const holdingConflict =
		mode === "replace"
			? ""
			: ` ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, class=excluded.class, market=excluded.market,
			    symbol=excluded.symbol, name=excluded.name, currency=excluded.currency, qty=excluded.qty,
			    price=excluded.price, avg_cost=excluded.avg_cost, price_updated_at=excluded.price_updated_at,
			    archived=excluded.archived, note=excluded.note, updated_at=excluded.updated_at`;
	for (const row of data.holdings) {
		statements.push(
			db
				.prepare(
					`INSERT INTO holdings (${HOLDING_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)${holdingConflict}`,
				)
				.bind(
					row.id,
					row.account_id,
					row.class,
					row.market,
					row.symbol,
					row.name,
					row.currency,
					row.qty,
					row.price,
					row.avg_cost,
					row.price_updated_at,
					row.archived,
					row.note,
					row.created_at,
					row.updated_at,
				),
		);
	}

	// 历史与审计都是追加型：用 OR IGNORE 保证重复导入不产生重复行
	for (const row of data.priceHistory) {
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO price_history (id, holding_id, effective_date, price, source, created_at) VALUES (?,?,?,?,?,?)`,
				)
				.bind(row.id, row.holding_id, row.effective_date, row.price, row.source, row.created_at),
		);
	}
	for (const row of data.qtyHistory) {
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO qty_history (id, holding_id, effective_date, qty, source, created_at) VALUES (?,?,?,?,?,?)`,
				)
				.bind(row.id, row.holding_id, row.effective_date, row.qty, row.source, row.created_at),
		);
	}
	for (const row of data.fxRates) {
		statements.push(
			db
				.prepare(
					`INSERT INTO fx_rates (base, quote, rate, updated_at) VALUES (?,?,?,?)
					 ON CONFLICT(base, quote) DO UPDATE SET rate=excluded.rate, updated_at=excluded.updated_at`,
				)
				.bind(row.base, row.quote, row.rate, row.updated_at),
		);
	}
	for (const row of data.fxRateHistory) {
		statements.push(
			db
				.prepare(`INSERT OR IGNORE INTO fx_rate_history (id, base, quote, rate, changed_at) VALUES (?,?,?,?,?)`)
				.bind(row.id, row.base, row.quote, row.rate, row.changed_at),
		);
	}
	for (const [key, value] of Object.entries(data.settings)) {
		// schema_version 属于"这个库自己"的结构标记，不能被备份内容覆盖
		if (key === "schema_version") continue;
		statements.push(
			db
				.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
				.bind(key, value),
		);
	}
	for (const row of data.auditLog) {
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO audit_log (id, ts, actor, entity, entity_id, action, before_json, after_json, source, note)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`,
				)
				.bind(
					row.id,
					row.ts,
					row.actor,
					row.entity,
					row.entity_id,
					row.action,
					row.before_json,
					row.after_json,
					row.source,
					row.note,
				),
		);
	}

	if (statements.length === 0) return { statements: 0, atomic: true };

	if (statements.length <= SINGLE_BATCH_MAX) {
		await db.batch(statements);
		return { statements: statements.length, atomic: true };
	}

	for (let index = 0; index < statements.length; index += CHUNK_SIZE) {
		await db.batch(statements.slice(index, index + CHUNK_SIZE));
	}
	return { statements: statements.length, atomic: false };
}
