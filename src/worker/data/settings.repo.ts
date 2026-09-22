/** 配置读写（settings 表：key/value 纯文本） */
import { normalizeTimeZone } from "../../shared/time";
import { parsePublicSections, type PublicSection } from "../../shared/public-sections";

export const SETTING_DISPLAY_CURRENCY = "display_currency";
export const SETTING_SNAPSHOT_HOUR = "snapshot_hour_utc";
export const SETTING_MARKET_DATA = "market_data_enabled";
export const SETTING_TIMEZONE = "timezone";
export const SETTING_SETUP_DONE = "setup_done_at";
/* ── Cloudflare 用量（设置页最底部那张卡）──
 * 额度是按账号统计的，Worker 自己拿不到，所以需要用户提供一个**只读** API Token：
 *   cf_api_token      加密存储的 Token（Account Analytics: Read + D1: Read）
 *   cf_account_id     账号 ID（纯标识，不敏感）
 *   cf_script_name    Worker 脚本名（默认 asset-manager）
 *   cf_database_name  D1 库名（默认 asset-manager-db）
 *   cf_usage          最近一次抓取结果的缓存（JSON），避免每次打开设置页都去打 Cloudflare
 */
export const SETTING_CF_API_TOKEN = "cf_api_token";
export const SETTING_CF_ACCOUNT_ID = "cf_account_id";
export const SETTING_CF_SCRIPT_NAME = "cf_script_name";
export const SETTING_CF_DATABASE_NAME = "cf_database_name";
export const SETTING_CF_USAGE = "cf_usage";

/** 公开只读分享开关（"1" 开启）：开启后未登录也能看总览，见 api/middleware.ts */
export const SETTING_PUBLIC_VIEW = "public_view";
/** 公开只读分享的区域（逗号分隔的 PublicSection） */
export const SETTING_PUBLIC_SECTIONS = "public_sections";

/** 内置币种（PRD D13：内置三种，用户可自行添加其他） */
export const BUILT_IN_CURRENCIES = ["USD", "HKD", "CNY"] as const;

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
	const { results } = await settingsStatement(db).all<{ key: string; value: string }>();
	return toSettingsMap(results);
}

/** 读取全部设置的语句（不执行）：需要和别的查询合并成一次 batch 时用 */
export function settingsStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(`SELECT key, value FROM settings`);
}

/** {key, value} 行 → 普通对象 */
export function toSettingsMap(rows: Array<{ key: string; value: string }> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows ?? []) out[row.key] = row.value;
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

/**
 * 公开只读分享是否开启。
 *
 * 默认**必须**是关闭：这是唯一一个让数据在没有密码的情况下可见的开关，
 * 缺值、脏值、读不到设置时都当关闭处理（fail-closed）。
 */
export function publicViewOf(settings: Record<string, string>): boolean {
	return settings[SETTING_PUBLIC_VIEW] === "1";
}

/**
 * 公开只读分享的**区域**（summary / trend / breakdown / holdings）。
 * 没存过就是全部；解析规则见 shared/public-sections.ts（脏值一律丢弃）。
 */
export function publicSectionsOf(settings: Record<string, string>): PublicSection[] {
	return parsePublicSections(settings[SETTING_PUBLIC_SECTIONS]);
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
