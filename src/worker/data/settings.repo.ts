/** 配置读写（settings 表：key/value 纯文本） */

export const SETTING_DISPLAY_CURRENCY = "display_currency";
export const SETTING_SNAPSHOT_HOUR = "snapshot_hour_utc";
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
	await db
		.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(key, value)
		.run();
}

export async function getDisplayCurrency(db: D1Database): Promise<string> {
	return (await getSetting(db, SETTING_DISPLAY_CURRENCY)) ?? "USD";
}
