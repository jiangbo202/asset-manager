import { peggedRate } from "../../shared/pegged";
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
	const at = nowIso();
	const result = await autoFxRateStatement(db, base, quote, rate, at).run();
	if ((result.meta.changes ?? 0) === 0) return false;

	await fxHistoryStatement(db, base, quote, rate, at).run();
	return true;
}

/**
 * 自动汇率的 upsert 语句（不执行）。
 * `WHERE fx_rates.source = 'auto'` 保证不覆盖手工维护的汇率。
 * 拆成语句是为了能和行情写入放进同一个 batch：
 * 原来每个币种都是两次串行往返，币种一多就吃掉免费版的 CPU 预算。
 */
export function autoFxRateStatement(
	db: D1Database,
	base: string,
	quote: string,
	rate: number,
	at: string = nowIso(),
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO fx_rates (base, quote, rate, updated_at, source) VALUES (?, ?, ?, ?, 'auto')
			 ON CONFLICT (base, quote) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
			 WHERE fx_rates.source = 'auto'`,
		)
		.bind(base, quote, rate, at);
}

/** 汇率变动历史语句（不执行） */
export function fxHistoryStatement(
	db: D1Database,
	base: string,
	quote: string,
	rate: number,
	at: string = nowIso(),
): D1PreparedStatement {
	return db
		.prepare(`INSERT INTO fx_rate_history (id, base, quote, rate, changed_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(newId(), base, quote, rate, at);
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
 * 唯一的例外是内置的稳定币平价（USDT/USDC ≈ 1 USD）：那是明确的已知汇率，不是"未知按 1:1 猜"。
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
		// 稳定币的平价兜底：USDT/USDC 等没有外汇数据源，按 1:1 折美元（见 shared/pegged.ts）
		return peggedRate(from, to);
	};
}
