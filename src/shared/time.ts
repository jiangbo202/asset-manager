/**
 * 时区工具（前后端共用）
 *
 * 约定：
 *  - **存储永远是 UTC ISO**（数据库里的 created_at / ts 等）
 *  - **"哪一天"与"几点"按用户配置的时区计算**（快照日期、价格历史生效日、Cron 小时闸门）
 *  - 展示时按配置时区格式化（而不是跟随看页面的那台机器的本地时区）
 *
 * 默认时区为 UTC（DNS/服务端惯例），用户可在设置页改成 Asia/Shanghai 等。
 */

export const DEFAULT_TIMEZONE = "UTC";

/** 时区选择器里预置的常用值（也允许手动输入任意 IANA 名称） */
export const COMMON_TIMEZONES = [
	"UTC",
	"Asia/Shanghai",
	"Asia/Hong_Kong",
	"Asia/Taipei",
	"Asia/Singapore",
	"Asia/Tokyo",
	"Asia/Seoul",
	"Asia/Bangkok",
	"Asia/Kolkata",
	"Asia/Dubai",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Europe/Moscow",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Sao_Paulo",
	"Australia/Sydney",
	"Pacific/Auckland",
] as const;

/** 时区是否合法（用 Intl 试一次，非法会抛 RangeError） */
export function isValidTimeZone(timeZone: string | null | undefined): boolean {
	if (!timeZone || typeof timeZone !== "string") return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
		return true;
	} catch {
		return false;
	}
}

export function normalizeTimeZone(timeZone: string | null | undefined): string {
	return isValidTimeZone(timeZone) ? (timeZone as string) : DEFAULT_TIMEZONE;
}

interface Parts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	const cached = partsCache.get(timeZone);
	if (cached) return cached;
	const created = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	partsCache.set(timeZone, created);
	return created;
}

function partsIn(timeZone: string, at: Date): Parts {
	const parts = formatter(timeZone).formatToParts(at);
	const get = (type: string) => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
	// Intl 在 24 小时制下会把午夜给成 24
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour") % 24,
		minute: get("minute"),
		second: get("second"),
	};
}

/** 该时刻在指定时区的日历日期（YYYY-MM-DD） */
export function dateIn(timeZone: string, at: Date = new Date()): string {
	const parts = partsIn(normalizeTimeZone(timeZone), at);
	return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** 该时刻在指定时区的小时（0–23） */
export function hourIn(timeZone: string, at: Date = new Date()): number {
	return partsIn(normalizeTimeZone(timeZone), at).hour;
}

/** 指定时区相对 UTC 的偏移（分钟）；例如 Asia/Shanghai 返回 480 */
export function offsetMinutes(timeZone: string, at: Date = new Date()): number {
	const parts = partsIn(normalizeTimeZone(timeZone), at);
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "UTC+8" / "UTC-4" 这样的偏移标签（用于设置页提示） */
export function offsetLabel(timeZone: string, at: Date = new Date()): string {
	const minutes = offsetMinutes(timeZone, at);
	const sign = minutes >= 0 ? "+" : "-";
	const abs = Math.abs(minutes);
	const hours = Math.floor(abs / 60);
	const rest = abs % 60;
	return `UTC${sign}${hours}${rest > 0 ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/**
 * 把"某时区的某一天"换算成 UTC 起止时刻。
 * 用于操作历史的日期区间筛选：用户选 2026-09-20，指的就是他配置时区的那一天。
 */
export function zonedDayRange(date: string, timeZone: string): { fromIso: string; toIso: string } {
	const [year, month, day] = date.split("-").map((value) => Number.parseInt(value, 10));
	// 先按 UTC 猜一个时刻，再用该时刻的偏移修正（跨夏令时也只需修正一次）
	const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
	const startOffset = offsetMinutes(timeZone, new Date(guess));
	const start = guess - startOffset * 60_000;
	const end = start + 24 * 3600 * 1000 - 1;
	return { fromIso: new Date(start).toISOString(), toIso: new Date(end).toISOString() };
}

/** 按指定时区格式化日期时间（用于界面展示） */
export function formatDateTime(
	iso: string | null | undefined,
	timeZone: string,
	locale = "zh-CN",
): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(locale, {
		timeZone: normalizeTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(date);
}

/** 按指定时区格式化日期（不含时间） */
export function formatDate(iso: string | null | undefined, timeZone: string, locale = "zh-CN"): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(locale, {
		timeZone: normalizeTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}
