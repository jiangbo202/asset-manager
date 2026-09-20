import { newId, nowIso } from "../core/utils";

/**
 * 汇率
 *
 * v0.10 起分两种来源：
 *  - `manual`：用户在设置页手工维护，**永远不会被自动抓取覆盖**
 *  - `auto`：行情刷新时抓到的，每次刷新都会更新
 *
 * 已知限制（PRD D9）：这里只存"当前值"，所以修改汇率会让所有折算数值整体变化。
 * 按日冻结汇率是 TODO。
 */

export interface FxRate {
	base: string;
	quote: string;
	rate: number;
	updated_at: string;
	source: string;
}

export async function listFxRates(db: D1Database): Promise<FxRate[]> {
	const { results } = await fxRatesStatement(db).all<FxRate>();
	return results ?? [];
}

/** 当前汇率查询语句（不执行）：便于和其他查询合并成一次 batch */
export function fxRatesStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(`SELECT base, quote, rate, updated_at, source FROM fx_rates ORDER BY base, quote`);
}

/** 手工维护（设置页调用） */
export async function upsertFxRate(db: D1Database, base: string, quote: string, rate: number): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO fx_rates (base, quote, rate, updated_at, source) VALUES (?, ?, ?, ?, 'manual')
			 ON CONFLICT (base, quote) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at, source = 'manual'`,
		)
		.bind(base, quote, rate, now)
		.run();
	await db
		.prepare(`INSERT INTO fx_rate_history (id, base, quote, rate, changed_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(newId(), base, quote, rate, now)
		.run();
}

/** 自动抓取：不覆盖手工维护的记录 */
export async function upsertAutoFxRate(db: D1Database, base: string, quote: string, rate: number): Promise<boolean> {
	const now = nowIso();
	const result = await db
		.prepare(
			`INSERT INTO fx_rates (base, quote, rate, updated_at, source) VALUES (?, ?, ?, ?, 'auto')
			 ON CONFLICT (base, quote) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
			 WHERE fx_rates.source = 'auto'`,
		)
		.bind(base, quote, rate, now)
		.run();
	if ((result.meta.changes ?? 0) === 0) return false;

	await db
		.prepare(`INSERT INTO fx_rate_history (id, base, quote, rate, changed_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(newId(), base, quote, rate, now)
		.run();
	return true;
}

export async function deleteFxRate(db: D1Database, base: string, quote: string): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM fx_rates WHERE base = ? AND quote = ?`).bind(base, quote).run();
	return (result.meta.changes ?? 0) > 0;
}

export async function listFxHistory(db: D1Database, limit = 200) {
	const { results } = await db
		.prepare(`SELECT * FROM fx_rate_history ORDER BY changed_at DESC LIMIT ?`)
		.bind(limit)
		.all<{ id: string; base: string; quote: string; rate: number; changed_at: string }>();
	return results ?? [];
}

export type FxLookup = (from: string, to: string) => number | null;

/**
 * 构造折算函数。支持正向、反向（1/x）；查不到返回 null，
 * 调用方必须把这类金额标为"未折算"而不是当成 1:1（PRD FR-3.4 的口径）。
 */
export function buildFxLookup(rates: FxRate[]): FxLookup {
	const direct = new Map<string, number>();
	for (const rate of rates) direct.set(`${rate.base}:${rate.quote}`, rate.rate);

	return (from, to) => {
		if (from === to) return 1;
		const forward = direct.get(`${from}:${to}`);
		if (forward !== undefined) return forward;
		const backward = direct.get(`${to}:${from}`);
		if (backward !== undefined && backward !== 0) return 1 / backward;
		return null;
	};
}
