import { Hono } from "hono";
import { tOf } from "../core/i18n";
import type { AppEnv } from "../types";
import { badRequest, notFound, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import {
	BUILT_IN_CURRENCIES,
	getSettings,
	SETTING_DISPLAY_CURRENCY,
	SETTING_TIMEZONE,
	setSetting,
} from "../data/settings.repo";
import { deleteFxRate, listFxHistory, listFxRates, upsertFxRate } from "../data/fx.repo";
import { encryptSecret, decryptSecret } from "../core/secrets";
import { isValidTimeZone } from "../../shared/time";
import { parseProviderSettings, PROVIDERS, PROVIDER_MAP, type ProviderId } from "../services/quotes/providers";
import { isRecord } from "../core/utils";
import { asRecord, requireCurrency, requireNumber, requireString } from "./validate";

const settings = new Hono<AppEnv>();

/**
 * 写审计前对设置做脱敏。
 *
 * 审计日志会被导出、也会在界面上展示，所以不能把凭据写进去：
 *  - provider_keys：加密后的第三方 API Key，整块换成标记
 *  - provider_config：保留"哪些源启用"这类无害信息，但自定义源的请求头与 Key 换成标记
 *    （请求头里常见 `Authorization: Bearer ...`）
 */
function sanitizeSettingsForAudit(values: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = { ...values };
	if (out.provider_keys) out.provider_keys = "(set)";

	if (out.provider_config) {
		try {
			const parsed = JSON.parse(out.provider_config) as {
				enabled?: Record<string, boolean>;
				custom?: Record<string, unknown> | null;
			};
			const custom = parsed.custom
				? {
						urlTemplate: parsed.custom.urlTemplate ?? null,
						pricePath: parsed.custom.pricePath ?? null,
						currencyPath: parsed.custom.currencyPath ?? null,
						headers: parsed.custom.headers ? "(set)" : null,
						key: parsed.custom.key ? "(set)" : null,
					}
				: null;
			out.provider_config = JSON.stringify({ enabled: parsed.enabled ?? {}, custom });
		} catch {
			out.provider_config = "(unparseable)";
		}
	}

	return out;
}

settings.get("/", async (c) => {
	const values = await getSettings(c.env.DB);
	const fx = await listFxRates(c.env.DB);
	const currencies = new Set<string>(BUILT_IN_CURRENCIES);
	for (const rate of fx) {
		currencies.add(rate.base);
		currencies.add(rate.quote);
	}

	// 数据源配置：只返回“哪些 Key 已设置”，绝不回传 Key 本身
	const providerConfig = parseProviderSettings(values.provider_config);
	const providerKeysSet: string[] = [];
	if (values.provider_keys) {
		const plain = await decryptSecret(values.provider_keys, c.env.SESSION_SECRET);
		if (plain) {
			try {
				providerKeysSet.push(...Object.keys(JSON.parse(plain) as Record<string, string>));
			} catch {
				/* 坏数据忽略 */
			}
		}
	}

	return ok(c, {
		values: { ...values, provider_keys: undefined },
		fx,
		builtInCurrencies: [...BUILT_IN_CURRENCIES],
		currencies: [...currencies].sort(),
		providers: PROVIDERS,
		providerConfig: { enabled: providerConfig.enabled, custom: providerConfig.custom },
		providerKeysSet,
	});
});

settings.put("/", async (c) => {
		const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const before = await getSettings(c.env.DB);

	if (payload.displayCurrency !== undefined) {
		const currency = requireCurrency(payload, "displayCurrency", t);
		await setSetting(c.env.DB, SETTING_DISPLAY_CURRENCY, currency);
	}
	if (payload.snapshotHourUtc !== undefined) {
		const hour = requireNumber(payload, "snapshotHourUtc", { labelKey: "field.snapshotHour", min: 0, max: 23 }, t);
		await setSetting(c.env.DB, "snapshot_hour_utc", String(Math.round(hour)));
	}
	if (payload.language !== undefined) {
		const value = requireString(payload, "language", { labelKey: "field.language", max: 10 }, t);
		if (!["auto", "zh", "en"].includes(value)) {
			throw badRequest(t("error.field_enum", { label: t("field.language"), allowed: "auto / zh / en" }));
		}
		await setSetting(c.env.DB, "language", value);
	}
	if (payload.timezone !== undefined) {
		const value = requireString(payload, "timezone", { labelKey: "field.timezone", max: 64 }, t);
		if (!isValidTimeZone(value)) {
			throw badRequest(t("error.invalidTimezone", { value }));
		}
		await setSetting(c.env.DB, SETTING_TIMEZONE, value);
	}
	if (payload.marketDataEnabled !== undefined) {
		await setSetting(c.env.DB, "market_data_enabled", payload.marketDataEnabled ? "1" : "0");
	}

	// 数据源开关 + 自定义源配置
	if (payload.providerConfig !== undefined) {
		const config = asRecord(payload.providerConfig, t);
		const enabledRaw = isRecord(config.enabled) ? config.enabled : {};
		const enabled: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(enabledRaw)) {
			if (PROVIDER_MAP.has(key as ProviderId)) enabled[key] = Boolean(value);
		}
		const customRaw = isRecord(config.custom) ? config.custom : null;
		const custom = customRaw
			? {
					urlTemplate: String(customRaw.urlTemplate ?? "").slice(0, 500),
					pricePath: String(customRaw.pricePath ?? "").slice(0, 200),
					currencyPath: customRaw.currencyPath ? String(customRaw.currencyPath).slice(0, 200) : undefined,
					headers: customRaw.headers ? String(customRaw.headers).slice(0, 1000) : undefined,
					key: customRaw.key ? String(customRaw.key).slice(0, 500) : undefined,
				}
			: null;

		// custom.key 与 API Key 一样属于敏感信息：单独加密存储，不写进 provider_config
		await setSetting(c.env.DB, "provider_config", JSON.stringify({ enabled, custom: custom ? { ...custom, key: undefined } : null }));
		if (custom?.key !== undefined) {
			const plain = await decryptSecret(before.provider_keys ?? "", c.env.SESSION_SECRET);
			const merged: Record<string, string> = plain ? (JSON.parse(plain) as Record<string, string>) : {};
			if (custom.key) merged.custom = custom.key;
			else delete merged.custom;
			await setSetting(c.env.DB, "provider_keys", await encryptSecret(JSON.stringify(merged), c.env.SESSION_SECRET));
		}
	}

	// API Key：与已有 Key 合并后整体加密存储（传空字符串表示删除）
	if (payload.providerKeys !== undefined) {
		const incoming = asRecord(payload.providerKeys, t);
		const plain = await decryptSecret(before.provider_keys ?? "", c.env.SESSION_SECRET);
		const merged: Record<string, string> = plain ? (JSON.parse(plain) as Record<string, string>) : {};
		for (const [key, value] of Object.entries(incoming)) {
			// 允许内置源之外的自定义 id（未来新增数据源无需改这里），只校验格式与数量
			if (!/^[a-z0-9_-]{2,20}$/.test(key)) continue;
			const text = String(value ?? "").trim();
			if (text === "") delete merged[key];
			else merged[key] = text.slice(0, 500);
		}
		const trimmedKeys = Object.fromEntries(Object.entries(merged).slice(0, 20));
		await setSetting(c.env.DB, "provider_keys", await encryptSecret(JSON.stringify(trimmedKeys), c.env.SESSION_SECRET));
	}

	const after = await getSettings(c.env.DB);
	await writeAudit(c.env.DB, {
		entity: "settings",
		entityId: null,
		action: "update",
		before: sanitizeSettingsForAudit(before),
		after: sanitizeSettingsForAudit(after),
	});
	return ok(c, { values: { ...after, provider_keys: undefined } });
});

/** 汇率：v1 手动维护（PRD FR-7.2） */
settings.get("/fx", async (c) => {
	return ok(c, { items: await listFxRates(c.env.DB), history: await listFxHistory(c.env.DB, 50) });
});

settings.put("/fx", async (c) => {
		const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const base = requireCurrency(payload, "base", t);
	const quote = requireCurrency(payload, "quote", t);
	if (base === quote) throw badRequest(t("error.invalid_field"));
	const rate = requireNumber(payload, "rate", { labelKey: "field.rate", min: 0.0000001, max: 1e9 }, t);

	await upsertFxRate(c.env.DB, base, quote, rate);
	await writeAudit(c.env.DB, {
		entity: "fx",
		entityId: `${base}:${quote}`,
		action: "update",
		after: { base, quote, rate },
	});
	return ok(c, { items: await listFxRates(c.env.DB) });
});

settings.delete("/fx", async (c) => {
		const t = tOf(c);
	const base = requireString({ base: c.req.query("base") }, "base", { labelKey: "field.base", max: 5 }, t).toUpperCase();
	const quote = requireString({ quote: c.req.query("quote") }, "quote", { labelKey: "field.quote", max: 5 }, t).toUpperCase();
	if (!(await deleteFxRate(c.env.DB, base, quote))) throw notFound(t("error.not_found"));
	await writeAudit(c.env.DB, {
		entity: "fx",
		entityId: `${base}:${quote}`,
		action: "delete",
		before: { base, quote },
	});
	return ok(c, { deleted: true });
});

/** 数据概览：判断是否接近免费额度（PRD FR-7.6） */
settings.get("/overview", async (c) => {
	const db = c.env.DB;
	const [accounts, holdings, audit, priceRows, qtyRows, sessions, snapshots, quotesCached] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS total FROM accounts`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM holdings`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM audit_log`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM price_history`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM qty_history`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM sessions`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM snapshots`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM quote_cache`).first<{ total: number }>(),
	]);
	const values = await getSettings(c.env.DB);
	return ok(c, {
		rows: {
			accounts: accounts?.total ?? 0,
			holdings: holdings?.total ?? 0,
			auditLog: audit?.total ?? 0,
			priceHistory: priceRows?.total ?? 0,
			qtyHistory: qtyRows?.total ?? 0,
			sessions: sessions?.total ?? 0,
			snapshots: snapshots?.total ?? 0,
			quoteCache: quotesCached?.total ?? 0,
		},
		settings: values,
		limits: {
			d1RowsReadPerDay: 5_000_000,
			d1RowsWrittenPerDay: 100_000,
			d1StorageBytes: 5 * 1024 * 1024 * 1024,
			workerCpuMsPerRequest: 10,
		},
	});
});

export default settings;
