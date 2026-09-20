import { newId, nowIso } from "../core/utils";

/**
 * 汇率（v1 手动维护）
 *
 * 已知限制（PRD D9）：这里只存"当前值"，所以修改汇率会让所有折算数值整体变化。
 * 按日冻结汇率是 TODO 第 3 项。
 */

export interface FxRate {
	base: string;
	quote: string;
	rate: number;
	updated_at: string;
}

export async function listFxRates(db: D1Database): Promise<FxRate[]> {
	const { results } = await db
		.prepare(`SELECT base, quote, rate, updated_at FROM fx_rates ORDER BY base, quote`)
		.all<FxRate>();
	return results ?? [];
}

export async function upsertFxRate(db: D1Database, base: string, quote: string, rate: number): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO fx_rates (base, quote, rate, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (base, quote) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at`,
		)
		.bind(base, quote, rate, now)
		.run();
	await db
		.prepare(`INSERT INTO fx_rate_history (id, base, quote, rate, changed_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(newId(), base, quote, rate, now)
		.run();
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
