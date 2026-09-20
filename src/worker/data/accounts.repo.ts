import type { AccountRow, HoldingRow } from "../types";
import { newId, nowIso } from "../core/utils";

/** ── 账户 ───────────────────────────────────────────────────── */

export interface AccountInput {
	name: string;
	kind: "broker" | "exchange" | "cash";
	market?: string | null;
	currency: string;
	icon_key?: string | null;
	icon_data?: string | null;
	sort?: number;
	note?: string | null;
}

export async function listAccounts(db: D1Database, includeArchived = false): Promise<AccountRow[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM accounts ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY sort ASC, created_at ASC`,
		)
		.all<AccountRow>();
	return results ?? [];
}

export async function getAccount(db: D1Database, id: string): Promise<AccountRow | null> {
	return db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
}

export async function createAccount(db: D1Database, input: AccountInput): Promise<AccountRow> {
	const now = nowIso();
	const id = newId();
	await db
		.prepare(
			`INSERT INTO accounts (id, name, kind, market, currency, icon_key, icon_data, sort, archived, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		)
		.bind(
			id,
			input.name,
			input.kind,
			input.market ?? null,
			input.currency,
			input.icon_key ?? null,
			input.icon_data ?? null,
			input.sort ?? 0,
			input.note ?? null,
			now,
			now,
		)
		.run();
	const created = await getAccount(db, id);
	if (!created) throw new Error("账户创建失败");
	return created;
}

export async function updateAccount(
	db: D1Database,
	id: string,
	patch: Partial<AccountInput> & { archived?: boolean },
): Promise<AccountRow | null> {
	const current = await getAccount(db, id);
	if (!current) return null;

	const next = {
		name: patch.name ?? current.name,
		kind: patch.kind ?? current.kind,
		market: patch.market === undefined ? current.market : patch.market,
		currency: patch.currency ?? current.currency,
		icon_key: patch.icon_key === undefined ? current.icon_key : patch.icon_key,
		icon_data: patch.icon_data === undefined ? current.icon_data : patch.icon_data,
		sort: patch.sort ?? current.sort,
		archived: patch.archived === undefined ? current.archived : patch.archived ? 1 : 0,
		note: patch.note === undefined ? current.note : patch.note,
	};

	await db
		.prepare(
			`UPDATE accounts SET name = ?, kind = ?, market = ?, currency = ?, icon_key = ?, icon_data = ?,
			        sort = ?, archived = ?, note = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			next.name,
			next.kind,
			next.market,
			next.currency,
			next.icon_key,
			next.icon_data,
			next.sort,
			next.archived,
			next.note,
			nowIso(),
			id,
		)
		.run();

	return getAccount(db, id);
}

export async function deleteAccount(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

export async function countAccountHoldings(db: D1Database, id: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS total FROM holdings WHERE account_id = ?`)
		.bind(id)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

/** ── 持仓 ───────────────────────────────────────────────────── */

export interface HoldingInput {
	account_id: string;
	class: HoldingRow["class"];
	market?: string | null;
	symbol?: string | null;
	name: string;
	currency: string;
	qty: number;
	price: number;
	avg_cost?: number | null;
	/** 行情覆盖：指定数据源（如 coingecko / yahoo） */
	quote_source?: string | null;
	/** 行情覆盖：指定查询代码（如 bitcoin、0700.HK） */
	quote_symbol?: string | null;
	note?: string | null;
}

export interface HoldingWithAccount extends HoldingRow {
	account_name: string;
	account_kind: string;
	account_icon_key: string | null;
	account_archived: number;
}

export interface HoldingFilter {
	accountId?: string;
	class?: string;
	/** 市场筛选支持多选（FR-6.3），空数组等于不筛选 */
	markets?: string[];
	currency?: string;
	includeArchived?: boolean;
}

export async function listHoldings(db: D1Database, filter: HoldingFilter = {}): Promise<HoldingWithAccount[]> {
	const where: string[] = [];
	const params: unknown[] = [];
	if (!filter.includeArchived) {
		where.push("h.archived = 0", "a.archived = 0");
	}
	if (filter.accountId) {
		where.push("h.account_id = ?");
		params.push(filter.accountId);
	}
	if (filter.class) {
		where.push("h.class = ?");
		params.push(filter.class);
	}
	if (filter.markets && filter.markets.length > 0) {
		where.push(`h.market IN (${filter.markets.map(() => "?").join(", ")})`);
		params.push(...filter.markets);
	}
	if (filter.currency) {
		where.push("h.currency = ?");
		params.push(filter.currency);
	}
	const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const { results } = await db
		.prepare(
			`SELECT h.*, a.name AS account_name, a.kind AS account_kind, a.icon_key AS account_icon_key,
			        a.archived AS account_archived
			 FROM holdings h JOIN accounts a ON a.id = h.account_id
			 ${clause}
			 ORDER BY a.sort ASC, h.class ASC, h.symbol ASC, h.created_at ASC`,
		)
		.bind(...params)
		.all<HoldingWithAccount>();
	return results ?? [];
}

export async function getHolding(db: D1Database, id: string): Promise<HoldingRow | null> {
	return db.prepare(`SELECT * FROM holdings WHERE id = ?`).bind(id).first<HoldingRow>();
}

export async function createHolding(db: D1Database, input: HoldingInput): Promise<HoldingRow> {
	const now = nowIso();
	const id = newId();
	await db
		.prepare(
			`INSERT INTO holdings (id, account_id, class, market, symbol, name, currency, qty, price, avg_cost,
			                       price_updated_at, quote_source, quote_symbol, archived, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		)
		.bind(
			id,
			input.account_id,
			input.class,
			input.market ?? null,
			input.symbol ?? null,
			input.name,
			input.currency,
			input.qty,
			input.price,
			input.avg_cost ?? null,
			now,
			input.quote_source ?? null,
			input.quote_symbol ?? null,
			input.note ?? null,
			now,
			now,
		)
		.run();
	const created = await getHolding(db, id);
	if (!created) throw new Error("持仓创建失败");
	return created;
}

export async function updateHolding(
	db: D1Database,
	id: string,
	patch: Partial<HoldingInput> & { archived?: boolean },
	priceUpdatedAt?: string | null,
): Promise<HoldingRow | null> {
	const current = await getHolding(db, id);
	if (!current) return null;

	const next = {
		account_id: patch.account_id ?? current.account_id,
		class: patch.class ?? current.class,
		market: patch.market === undefined ? current.market : patch.market,
		symbol: patch.symbol === undefined ? current.symbol : patch.symbol,
		name: patch.name ?? current.name,
		currency: patch.currency ?? current.currency,
		qty: patch.qty ?? current.qty,
		price: patch.price ?? current.price,
		avg_cost: patch.avg_cost === undefined ? current.avg_cost : patch.avg_cost,
		quote_source: patch.quote_source === undefined ? current.quote_source : patch.quote_source,
		quote_symbol: patch.quote_symbol === undefined ? current.quote_symbol : patch.quote_symbol,
		archived: patch.archived === undefined ? current.archived : patch.archived ? 1 : 0,
		note: patch.note === undefined ? current.note : patch.note,
	};

	await db
		.prepare(
			`UPDATE holdings SET account_id = ?, class = ?, market = ?, symbol = ?, name = ?, currency = ?,
			        qty = ?, price = ?, avg_cost = ?, price_updated_at = ?, quote_source = ?, quote_symbol = ?,
			        archived = ?, note = ?, updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			next.account_id,
			next.class,
			next.market,
			next.symbol,
			next.name,
			next.currency,
			next.qty,
			next.price,
			next.avg_cost,
			priceUpdatedAt === undefined ? current.price_updated_at : priceUpdatedAt,
			next.quote_source,
			next.quote_symbol,
			next.archived,
			next.note,
			nowIso(),
			id,
		)
		.run();

	return getHolding(db, id);
}

export async function deleteHolding(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM holdings WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

export async function sumQtyBySymbol(db: D1Database, symbol: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COALESCE(SUM(qty), 0) AS total FROM holdings WHERE symbol = ? AND archived = 0`)
		.bind(symbol.toUpperCase())
		.first<{ total: number }>();
	return row?.total ?? 0;
}
