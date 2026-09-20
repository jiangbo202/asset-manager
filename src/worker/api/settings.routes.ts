import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, notFound, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import {
	BUILT_IN_CURRENCIES,
	getSettings,
	SETTING_DISPLAY_CURRENCY,
	setSetting,
} from "../data/settings.repo";
import { deleteFxRate, listFxHistory, listFxRates, upsertFxRate } from "../data/fx.repo";
import { asRecord, requireCurrency, requireNumber, requireString } from "./validate";

const settings = new Hono<AppEnv>();

settings.get("/", async (c) => {
	const values = await getSettings(c.env.DB);
	const fx = await listFxRates(c.env.DB);
	const currencies = new Set<string>(BUILT_IN_CURRENCIES);
	for (const rate of fx) {
		currencies.add(rate.base);
		currencies.add(rate.quote);
	}
	return ok(c, {
		values,
		fx,
		builtInCurrencies: [...BUILT_IN_CURRENCIES],
		currencies: [...currencies].sort(),
	});
});

settings.put("/", async (c) => {
	const payload = asRecord(await c.req.json());
	const before = await getSettings(c.env.DB);

	if (payload.displayCurrency !== undefined) {
		const currency = requireCurrency(payload, "displayCurrency");
		await setSetting(c.env.DB, SETTING_DISPLAY_CURRENCY, currency);
	}
	if (payload.snapshotHourUtc !== undefined) {
		const hour = requireNumber(payload, "snapshotHourUtc", { label: "快照小时", min: 0, max: 23 });
		await setSetting(c.env.DB, "snapshot_hour_utc", String(Math.round(hour)));
	}

	const after = await getSettings(c.env.DB);
	await writeAudit(c.env.DB, { entity: "settings", entityId: null, action: "update", before, after });
	return ok(c, { values: after });
});

/** 汇率：v1 手动维护（PRD FR-7.2） */
settings.get("/fx", async (c) => {
	return ok(c, { items: await listFxRates(c.env.DB), history: await listFxHistory(c.env.DB, 50) });
});

settings.put("/fx", async (c) => {
	const payload = asRecord(await c.req.json());
	const base = requireCurrency(payload, "base");
	const quote = requireCurrency(payload, "quote");
	if (base === quote) throw badRequest("基准币种与目标币种不能相同");
	const rate = requireNumber(payload, "rate", { label: "汇率", min: 0.0000001, max: 1e9 });

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
	const base = requireString({ base: c.req.query("base") }, "base", { label: "基准币种", max: 5 }).toUpperCase();
	const quote = requireString({ quote: c.req.query("quote") }, "quote", { label: "目标币种", max: 5 }).toUpperCase();
	if (!(await deleteFxRate(c.env.DB, base, quote))) throw notFound("该汇率不存在");
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
	const [accounts, holdings, audit, priceRows, qtyRows, sessions] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS total FROM accounts`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM holdings`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM audit_log`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM price_history`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM qty_history`).first<{ total: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM sessions`).first<{ total: number }>(),
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
