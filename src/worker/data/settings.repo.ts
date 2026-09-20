/** 配置读写（settings 表：key/value 纯文本） */
import { normalizeTimeZone } from "../../shared/time";

export const SETTING_DISPLAY_CURRENCY = "display_currency";
export const SETTING_SNAPSHOT_HOUR = "snapshot_hour_utc";
export const SETTING_MARKET_DATA = "market_data_enabled";
export const SETTING_TIMEZONE = "timezone";
export const SETTING_SETUP_DONE = "setup_done_at";

/** 内置币种（PRD D13：内置三种，用户可自行添加其他） */
export const BUILT_IN_CURRENCIES = ["USD", "HKD", "CNY"] as const;

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
	const { results } = await db.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
	const out: Record<string, string> = {};
	for (const row of results ?? []) out[row.key] = row.value;
	return out;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await settingStatement(db, key, value).run();
}

/**
 * 设置项的 upsert 语句（不执行）。
 * 存在意义：需要把好几项设置和其他写操作合并成一次 db.batch，省掉多次往返。
 */
export function settingStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
	return db
		.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(key, value);
}

/* ── 下面三个“取值”函数从一次性读出的设置快照里取值 ──
 * 存在意义：每个 getSetting 都是一次数据库往返（D1 的 CPU 开销也在这里）。
 * 热路径（比如行情刷新）需要好几项设置，用 getSettings 读一次再取值，
 * 可以把 6 次往返压成 1 次。
 */

/** 用户配置的时区（IANA 名称）；非法或缺失时回退 UTC */
export function timeZoneOf(settings: Record<string, string>): string {
	return normalizeTimeZone(settings[SETTING_TIMEZONE]);
}

/** 每日快照小时（按用户时区解释）；缺失或非法时回退 22 点 */
export function snapshotHourOf(settings: Record<string, string>): number {
	const parsed = Number.parseInt(settings[SETTING_SNAPSHOT_HOUR] ?? "", 10);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 22;
}

/** 显示币种；缺失时回退 USD */
export function displayCurrencyOf(settings: Record<string, string>): string {
	return settings[SETTING_DISPLAY_CURRENCY] ?? "USD";
}

/** 用户配置的时区（IANA 名称）；非法或缺失时回退 UTC */
export async function getTimeZone(db: D1Database): Promise<string> {
	return timeZoneOf(await getSettings(db));
}

/** 每日快照小时（按用户时区解释）；缺失或非法时回退到 22 点 */
export async function getSnapshotHour(db: D1Database): Promise<number> {
	return snapshotHourOf(await getSettings(db));
}

export async function getDisplayCurrency(db: D1Database): Promise<string> {
	return displayCurrencyOf(await getSettings(db));
}
