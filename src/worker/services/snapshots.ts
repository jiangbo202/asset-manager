import { newId, nowIso, todayUtc } from "../core/utils";
import { listHoldings } from "../data/accounts.repo";
import { buildFxLookup, listFxRates } from "../data/fx.repo";
import { getDisplayCurrency } from "../data/settings.repo";
import { buildPortfolio } from "./portfolio";

/**
 * 每日快照
 *
 * 一天一行（PRD §5 的设计要点）：明细塞 JSON，避免"每天 × 每持仓一行"的读放大。
 * detail 里按**原币种**记录每个持仓的市值，这样：
 *  - 切换显示币种时能用当前汇率重算整条历史曲线
 *  - 以后要做"单个持仓的历史走势"也不用重新采集
 */

export interface SnapshotRow {
	date: string;
	base_currency: string;
	total: number;
	by_currency_json: string;
	by_class_json: string;
	by_account_json: string;
	detail_json: string | null;
	created_at: string;
}

interface DetailEntry {
	/** holding id */
	i: string;
	/** account id */
	a: string;
	/** class */
	c: string;
	/** currency */
	u: string;
	/** market（用于按市场筛选历史曲线） */
	m: string | null;
	/** market value（原币种） */
	v: number;
}

export interface TakeSnapshotResult {
	date: string;
	total: number;
	currency: string;
	created: boolean;
	holdings: number;
}

export async function takeSnapshot(
	db: D1Database,
	options: { date?: string; force?: boolean } = {},
): Promise<TakeSnapshotResult> {
	const date = options.date ?? todayUtc();
	const displayCurrency = await getDisplayCurrency(db);
	const holdings = await listHoldings(db, {});
	const fxRates = await listFxRates(db);
	const portfolio = buildPortfolio(holdings, displayCurrency, fxRates);

	const byCurrency: Record<string, number> = {};
	const byClass: Record<string, number> = {};
	const byAccount: Record<string, number> = {};
	const detail: DetailEntry[] = [];

	for (const item of portfolio.holdings) {
		byCurrency[item.currency] = (byCurrency[item.currency] ?? 0) + item.marketValue;
		if (item.marketValueDisplay !== null) {
			byClass[item.class] = (byClass[item.class] ?? 0) + item.marketValueDisplay;
			byAccount[item.accountId] = (byAccount[item.accountId] ?? 0) + item.marketValueDisplay;
		}
		detail.push({
			i: item.id,
			a: item.accountId,
			c: item.class,
			u: item.currency,
			m: item.market,
			v: Number(item.marketValue.toFixed(6)),
		});
	}

	const record: SnapshotRow = {
		date,
		base_currency: displayCurrency,
		total: Number(portfolio.total.toFixed(6)),
		by_currency_json: JSON.stringify(byCurrency),
		by_class_json: JSON.stringify(byClass),
		by_account_json: JSON.stringify(byAccount),
		detail_json: JSON.stringify(detail),
		created_at: nowIso(),
	};

	const existing = await db.prepare(`SELECT date FROM snapshots WHERE date = ?`).bind(date).first<{ date: string }>();

	if (existing && !options.force) {
		return { date, total: record.total, currency: displayCurrency, created: false, holdings: detail.length };
	}

	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO snapshots (date, base_currency, total, by_currency_json, by_class_json, by_account_json, detail_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(date) DO UPDATE SET base_currency = excluded.base_currency, total = excluded.total,
				   by_currency_json = excluded.by_currency_json, by_class_json = excluded.by_class_json,
				   by_account_json = excluded.by_account_json, detail_json = excluded.detail_json,
				   created_at = excluded.created_at`,
			)
			.bind(
				record.date,
				record.base_currency,
				record.total,
				record.by_currency_json,
				record.by_class_json,
				record.by_account_json,
				record.detail_json,
				record.created_at,
			),
	];

	// 把"当天生效的汇率"冻结下来（v0.11）：以后改汇率不会再平移历史曲线
	for (const rate of fxRates) {
		statements.push(
			db
				.prepare(
					`INSERT INTO fx_daily (date, base, quote, rate, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(date, base, quote) DO UPDATE SET rate = excluded.rate, source = excluded.source,
					   created_at = excluded.created_at`,
				)
				.bind(record.date, rate.base, rate.quote, rate.rate, rate.source, record.created_at),
		);
	}

	await db.batch(statements);

	return { date, total: record.total, currency: displayCurrency, created: true, holdings: detail.length };
}

export interface TrendPoint {
	date: string;
	total: number;
	byClass: Record<string, number>;
	byAccount: Record<string, number>;
	/** 这一天没有快照，用前一日填充 */
	filled: boolean;
}

export interface TrendSeries {
	displayCurrency: string;
	points: TrendPoint[];
	snapshotCount: number;
	firstDate: string | null;
	lastDate: string | null;
	missingFxCurrencies: string[];
	/** 采样间隔（1=日，7=周，30=月） */
	bucketDays: number;
	/** 历史点用的是"当天冻结汇率"还是"当前汇率" */
	rateMode: "frozen" | "current" | "mixed";
}

export type TrendRange = "1M" | "3M" | "6M" | "1Y" | "ALL";

const RANGE_DAYS: Record<Exclude<TrendRange, "ALL">, number> = {
	"1M": 31,
	"3M": 92,
	"6M": 183,
	"1Y": 366,
};

const MAX_POINTS = 400;

/** 按日冻结的汇率表（date -> "BASE:QUOTE" -> rate） */
async function loadDailyRates(db: D1Database): Promise<Map<string, Map<string, number>>> {
	const { results } = await db
		.prepare(`SELECT date, base, quote, rate FROM fx_daily ORDER BY date`)
		.all<{ date: string; base: string; quote: string; rate: number }>();
	const byDate = new Map<string, Map<string, number>>();
	for (const row of results ?? []) {
		const bucket = byDate.get(row.date) ?? new Map<string, number>();
		bucket.set(`${row.base}:${row.quote}`, row.rate);
		byDate.set(row.date, bucket);
	}
	return byDate;
}

export function rangeToFromDate(range: TrendRange, today = todayUtc()): string | null {
	if (range === "ALL") return null;
	const days = RANGE_DAYS[range] ?? 92;
	const date = new Date(`${today}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

/** 用当前汇率把快照里的原币种明细折算成显示币种，并按日补齐空缺 */
export interface TrendFilters {
	class?: string;
	accountId?: string;
	markets?: string[];
}

export async function buildTrendSeries(
	db: D1Database,
	options: { range: TrendRange; displayCurrency?: string; filters?: TrendFilters },
): Promise<TrendSeries> {
	const filters = options.filters ?? {};
	const displayCurrency = options.displayCurrency ?? (await getDisplayCurrency(db));
	const fxRates = await listFxRates(db);
	const lookup = buildFxLookup(fxRates);
	const missingFx = new Set<string>();

	// 按日冻结的汇率：优先使用，缺失时回退到当前汇率
	const dailyRates = await loadDailyRates(db);
	const dailyDates = [...dailyRates.keys()].sort();
	const rateFor = (date: string, from: string, to: string): { rate: number | null; frozen: boolean } => {
		if (from === to) return { rate: 1, frozen: true };
		// 取"不晚于该快照日期"的最近一批冻结汇率（forward fill）
		let bucket: Map<string, number> | undefined;
		for (let index = dailyDates.length - 1; index >= 0; index -= 1) {
			if (dailyDates[index] <= date) {
				bucket = dailyRates.get(dailyDates[index]);
				break;
			}
		}
		if (bucket) {
			const direct = bucket.get(`${from}:${to}`);
			if (direct !== undefined) return { rate: direct, frozen: true };
			const reverse = bucket.get(`${to}:${from}`);
			if (reverse !== undefined && reverse !== 0) return { rate: 1 / reverse, frozen: true };
		}
		return { rate: lookup(from, to), frozen: false };
	};
	let frozenHits = 0;
	let currentHits = 0;

	const from = rangeToFromDate(options.range);
	const { results } = from
		? await db
				.prepare(`SELECT * FROM snapshots WHERE date >= ? ORDER BY date ASC`)
				.bind(from)
				.all<SnapshotRow>()
		: await db.prepare(`SELECT * FROM snapshots ORDER BY date ASC`).all<SnapshotRow>();

	const rows = results ?? [];
	if (rows.length === 0) {
		return {
			displayCurrency,
			points: [],
			snapshotCount: 0,
			firstDate: null,
			lastDate: null,
			missingFxCurrencies: [],
			bucketDays: 1,
			rateMode: "current",
		};
	}

	// 先算出每个快照日的真实值
	const raw: Array<{ date: string; total: number; byClass: Record<string, number>; byAccount: Record<string, number> }> = [];
	for (const row of rows) {
		let total = 0;
		const byClass: Record<string, number> = {};
		const byAccount: Record<string, number> = {};

		let detail: DetailEntry[] | null = null;
		if (row.detail_json) {
			try {
				detail = JSON.parse(row.detail_json) as DetailEntry[];
			} catch {
				detail = null;
			}
		}

		if (detail && Array.isArray(detail) && detail.length > 0) {
			for (const entry of detail) {
				// 与总览保持一致的筛选口径
				if (filters.class && entry.c !== filters.class) continue;
				if (filters.accountId && entry.a !== filters.accountId) continue;
				if (filters.markets && filters.markets.length > 0 && (!entry.m || !filters.markets.includes(entry.m))) continue;
				const resolved = rateFor(row.date, entry.u, displayCurrency);
				if (resolved.frozen) frozenHits += 1;
				else if (resolved.rate !== null) currentHits += 1;
				const rate = resolved.rate;
				if (rate === null) {
					missingFx.add(entry.u);
					continue;
				}
				const value = entry.v * rate;
				total += value;
				byClass[entry.c] = (byClass[entry.c] ?? 0) + value;
				byAccount[entry.a] = (byAccount[entry.a] ?? 0) + value;
			}
		} else {
			// 兼容早期没有 detail 的快照：只能按币种小计折算
			try {
				const byCurrency = JSON.parse(row.by_currency_json) as Record<string, number>;
				for (const [currency, value] of Object.entries(byCurrency)) {
					const resolved = rateFor(row.date, currency, displayCurrency);
					if (resolved.frozen) frozenHits += 1;
					else if (resolved.rate !== null) currentHits += 1;
					const rate = resolved.rate;
					if (rate === null) {
						missingFx.add(currency);
						continue;
					}
					total += value * rate;
				}
			} catch {
				total = row.total;
			}
		}

		raw.push({
			date: row.date,
			total: Number(total.toFixed(2)),
			byClass: Object.fromEntries(Object.entries(byClass).map(([key, value]) => [key, Number(value.toFixed(2))])),
			byAccount: Object.fromEntries(Object.entries(byAccount).map(([key, value]) => [key, Number(value.toFixed(2))])),
		});
	}

	// 按日补齐（forward fill），保证折线不断
	const firstDate = raw[0].date;
	const lastDate = raw[raw.length - 1].date;
	const daily: TrendPoint[] = [];
	const byDate = new Map(raw.map((point) => [point.date, point]));
	let cursor = new Date(`${firstDate}T00:00:00.000Z`);
	const end = new Date(`${lastDate}T00:00:00.000Z`);
	let previous: (typeof raw)[number] | null = null;

	while (cursor <= end) {
		const date = cursor.toISOString().slice(0, 10);
		const exact = byDate.get(date);
		if (exact) {
			daily.push({ ...exact, filled: false });
			previous = exact;
		} else if (previous) {
			daily.push({ ...previous, date, filled: true });
		}
		cursor = new Date(cursor.getTime() + 86_400_000);
	}

	// 点太多就按周/月采样（服务端先降采样，前端与 CPU 都省）
	const bucketDays = daily.length > MAX_POINTS ? (daily.length > MAX_POINTS * 3 ? 30 : 7) : 1;
	const points: TrendPoint[] = [];
	if (bucketDays === 1) {
		points.push(...daily);
	} else {
		for (let index = 0; index < daily.length; index += bucketDays) {
			const slice = daily.slice(index, index + bucketDays);
			const last = slice[slice.length - 1];
			const base = slice.find((point) => !point.filled) ?? last;
			points.push({ ...base, date: last.date, filled: false });
		}
	}

	const rateMode: TrendSeries["rateMode"] =
		frozenHits > 0 && currentHits > 0 ? "mixed" : frozenHits > 0 ? "frozen" : "current";

	return {
		displayCurrency,
		points,
		snapshotCount: raw.length,
		firstDate,
		lastDate,
		missingFxCurrencies: [...missingFx],
		bucketDays,
		rateMode,
	};
}

export async function listSnapshots(
	db: D1Database,
	options: { limit?: number } = {},
): Promise<Array<Omit<SnapshotRow, "detail_json"> & { holdings: number }>> {
	const { results } = await db
		.prepare(
			`SELECT date, base_currency, total, by_currency_json, by_class_json, by_account_json, created_at,
			        COALESCE(LENGTH(detail_json), 0) AS detail_bytes
			 FROM snapshots ORDER BY date DESC LIMIT ?`,
		)
		.bind(options.limit ?? 60)
		.all<Omit<SnapshotRow, "detail_json"> & { detail_bytes: number }>();
	return (results ?? []).map((row) => ({ ...row, holdings: 0 }));
}

export async function deleteSnapshot(db: D1Database, date: string): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM snapshots WHERE date = ?`).bind(date).run();
	return (result.meta.changes ?? 0) > 0;
}

export async function snapshotCount(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS total FROM snapshots`).first<{ total: number }>();
	return row?.total ?? 0;
}

export const newSnapshotId = (): string => newId();
