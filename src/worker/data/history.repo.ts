import { newId, nowIso, todayUtc } from "../core/utils";

/**
 * price_history / qty_history
 *
 * v1 只写不读（PRD FR-3.2）：为 v2 的"每天走势"预埋数据，
 * 成本是每次编辑多写 1 行，在 D1 免费额度（10 万行写/天）下可忽略不计。
 */

export type HistorySource = "manual" | "import" | "api";

export async function recordPrice(
	db: D1Database,
	holdingId: string,
	price: number,
	effectiveDate = todayUtc(),
	source: HistorySource = "manual",
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO price_history (id, holding_id, effective_date, price, source, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(newId(), holdingId, effectiveDate, price, source, nowIso())
		.run();
}

export async function recordQty(
	db: D1Database,
	holdingId: string,
	qty: number,
	effectiveDate = todayUtc(),
	source: HistorySource = "manual",
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO qty_history (id, holding_id, effective_date, qty, source, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(newId(), holdingId, effectiveDate, qty, source, nowIso())
		.run();
}

export async function listPriceHistory(db: D1Database, holdingId: string, limit = 365) {
	const { results } = await db
		.prepare(`SELECT effective_date, price, source FROM price_history WHERE holding_id = ? ORDER BY effective_date DESC LIMIT ?`)
		.bind(holdingId, limit)
		.all<{ effective_date: string; price: number; source: string }>();
	return results ?? [];
}

/** 供测试与调试：历史表行数 */
export async function historyStats(db: D1Database): Promise<{ priceRows: number; qtyRows: number }> {
	const price = await db.prepare(`SELECT COUNT(*) AS total FROM price_history`).first<{ total: number }>();
	const qty = await db.prepare(`SELECT COUNT(*) AS total FROM qty_history`).first<{ total: number }>();
	return { priceRows: price?.total ?? 0, qtyRows: qty?.total ?? 0 };
}
