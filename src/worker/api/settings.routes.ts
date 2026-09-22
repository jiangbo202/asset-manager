import { Hono } from "hono";
import { tOf } from "../core/i18n";
import type { AppEnv } from "../types";
import { badRequest, notFound, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import {
	BUILT_IN_CURRENCIES,
	getSettings,
	SETTING_DISPLAY_CURRENCY,
	SETTING_PUBLIC_SECTIONS,
	SETTING_PUBLIC_VIEW,
	SETTING_TIMEZONE,
	setSetting,
	settingsStatement,
	toSettingsMap,
} from "../data/settings.repo";
import { deleteFxRate, listFxHistory, listFxRates, upsertFxRate } from "../data/fx.repo";
import { encryptSecret, decryptSecret } from "../core/secrets";
import { isValidTimeZone } from "../../shared/time";
import {
	isPublicSection,
	parsePublicSections,
	PUBLIC_SECTIONS,
	serializePublicSections,
} from "../../shared/public-sections";
import { lookupFxRate } from "../services/quotes";
import { parseProviderSettings, PROVIDERS, PROVIDER_MAP, type ProviderId } from "../services/quotes/providers";
import { isRecord } from "../core/utils";
import { clearSessionCookie, currentSessionId, listSessions, revokeSession } from "../core/session";
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
	// 公开只读分享：只能由已登录的本人开关（本路由整体在 requireAuthOrPublicRead 之后，
	// 且 PUT 不在白名单里，所以匿名请求到不了这里）
	if (payload.publicView !== undefined) {
		await setSetting(c.env.DB, SETTING_PUBLIC_VIEW, payload.publicView ? "1" : "0");
	}
	// 分享哪些区域：只接受已知分区名，未知值直接报错（不静默丢弃，否则用户以为勾上了）
	if (payload.publicSections !== undefined) {
		if (!Array.isArray(payload.publicSections)) throw badRequest(t("error.bad_request"));
		const values = payload.publicSections.map((item) => String(item));
		const unknown = values.filter((item) => !isPublicSection(item));
		if (unknown.length > 0) {
			throw badRequest(t("error.field_enum", { label: t("settings.publicSections"), allowed: PUBLIC_SECTIONS.join(" / ") }));
		}
		const sections = parsePublicSections(values.join(","));
		if (sections.length === 0) throw badRequest(t("settings.publicSectionsEmpty"));
		await setSetting(c.env.DB, SETTING_PUBLIC_SECTIONS, serializePublicSections(sections));
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

/**
 * 查当前汇率（**不写库**）：设置页的「获取最新汇率」。
 * 结果只填进输入框，由用户确认后再走 PUT /fx —— 因为手工汇率会阻止之后的自动抓取。
 */
settings.post("/fx/lookup", async (c) => {
	const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const base = requireCurrency(payload, "base", t, "field.fxBase");
	const quote = requireCurrency(payload, "quote", t, "field.fxQuote");
	if (base === quote) throw badRequest(t("error.invalid_field"));

	return ok(c, await lookupFxRate(c.env, { base, quote }, { t }));
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

/**
 * 会话列表（设置页的"会话"卡片）
 *
 * 放在 /api/settings 下而不是 /api/auth 下，是为了自动落进 requireAuthOrPublicRead 的
 * 保护范围：公开只读分享的白名单里没有它，所以匿名访客拿不到本人登录过的 IP 与设备
 * （auth 路由挂在该中间件之外，历史遗留，新接口不往那边放）。
 */
settings.get("/sessions", async (c) => {
	const [sessions, currentId] = await Promise.all([listSessions(c), currentSessionId(c)]);
	const rows = sessions.map((row) => ({
		id: row.id,
		current: row.id === currentId,
		userAgent: row.ua,
		ip: row.ip,
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		expiresAt: row.expires_at,
	}));
	// 当前设备排最前（列表按最近活跃排序，但"本设备"最好一眼可见）
	rows.sort((a, b) => Number(b.current) - Number(a.current));
	return ok(c, { items: rows });
});

/** 踢出指定会话（"登出这台设备"）。踢自己等于登出：清 cookie，前端回登录页 */
settings.delete("/sessions/:id", async (c) => {
	const t = tOf(c);
	const id = c.req.param("id");
	if (!/^[0-9a-f]{64}$/.test(id)) throw badRequest(t("error.bad_request"));

	const currentId = await currentSessionId(c);
	const before = await c.env.DB.prepare(`SELECT ua, ip, created_at FROM sessions WHERE id = ?`)
		.bind(id)
		.first<{ ua: string | null; ip: string | null; created_at: string }>();
	if (!before) throw notFound(t("error.not_found"));

	await revokeSession(c.env.DB, id);
	if (id === currentId) clearSessionCookie(c);

	await writeAudit(c.env.DB, {
		entity: "auth",
		entityId: id.slice(0, 8),
		action: "security",
		source: "web",
		before: { ip: before.ip, ua: before.ua, createdAt: before.created_at },
		note: t("audit.sessionRevoked"),
	});
	return ok(c, { revoked: true, current: id === currentId });
});

/** 数据概览：判断是否接近免费额度（PRD FR-7.6） */
settings.get("/overview", async (c) => {
	const db = c.env.DB;
	// 8 个 COUNT 合成一条语句（8 个子查询），再与设置读取一起走一次 batch：
	// 原来是 8 次串行 COUNT + 1 次设置读取 = 9 条语句、9 次往返
	const [countsResult, settingsResult] = await db.batch([
		db.prepare(
			`SELECT
				(SELECT COUNT(*) FROM accounts) AS accounts,
				(SELECT COUNT(*) FROM holdings) AS holdings,
				(SELECT COUNT(*) FROM audit_log) AS audit_log,
				(SELECT COUNT(*) FROM price_history) AS price_history,
				(SELECT COUNT(*) FROM qty_history) AS qty_history,
				(SELECT COUNT(*) FROM sessions) AS sessions,
				(SELECT COUNT(*) FROM snapshots) AS snapshots,
				(SELECT COUNT(*) FROM quote_cache) AS quote_cache`,
		),
		settingsStatement(db),
	]);
	const counts = countsResult?.results?.[0] as Record<string, number> | undefined;
	const settingsMap = toSettingsMap(settingsResult?.results as Array<{ key: string; value: string }> | undefined);
	return ok(c, {
		rows: {
			accounts: counts?.accounts ?? 0,
			holdings: counts?.holdings ?? 0,
			auditLog: counts?.audit_log ?? 0,
			priceHistory: counts?.price_history ?? 0,
			qtyHistory: counts?.qty_history ?? 0,
			sessions: counts?.sessions ?? 0,
			snapshots: counts?.snapshots ?? 0,
			quoteCache: counts?.quote_cache ?? 0,
		},
		settings: settingsMap,
		limits: {
			d1RowsReadPerDay: 5_000_000,
			d1RowsWrittenPerDay: 100_000,
			d1StorageBytes: 5 * 1024 * 1024 * 1024,
			workerCpuMsPerRequest: 10,
		},
	});
});

export default settings;
