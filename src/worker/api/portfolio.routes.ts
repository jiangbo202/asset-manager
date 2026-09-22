import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, ok } from "../core/errors";
import { tOf } from "../core/i18n";
import { writeAudit } from "../core/audit";
import { holdingsStatement } from "../data/accounts.repo";
import { fxRatesStatement } from "../data/fx.repo";
import { displayCurrencyOf, settingsStatement, timeZoneOf, toSettingsMap } from "../data/settings.repo";
import { buildPortfolio } from "../services/portfolio";
import {
	buildTrendSeries,
	deleteSnapshot,
	fxDailyStatement,
	listSnapshots,
	rangeToFromDate,
	snapshotsStatement,
	takeSnapshot,
	type SnapshotRow,
	type TrendRange,
} from "../services/snapshots";

const portfolio = new Hono<AppEnv>();

/**
 * 组合视图（当前时点）
 * 只此一个接口，前端所有图表与统计都从这里取，避免多接口导致请求数与 CPU 上升（PRD §8）
 */
portfolio.get("/", async (c) => {
	const requested = c.req.query("currency");
	const db = c.env.DB;
	const filter = {
		accountId: c.req.query("accountId"),
		class: c.req.query("class"),
		markets: parseMarkets(c.req.query("market")),
		currency: c.req.query("currencyFilter"),
	};
	// 设置 + 持仓 + 汇率一次读完：3 条语句、1 次往返
	const [settingsResult, holdingsResult, fxResult] = await db.batch([
		settingsStatement(db),
		holdingsStatement(db, filter),
		fxRatesStatement(db),
	]);
	const settings = toSettingsMap(settingsResult?.results as Array<{ key: string; value: string }> | undefined);
	const displayCurrency = (requested && requested.trim() !== "" ? requested : displayCurrencyOf(settings))
		.toUpperCase()
		.slice(0, 5);

	return ok(
		c,
		buildPortfolio(
			(holdingsResult?.results ?? []) as never,
			displayCurrency,
			(fxResult?.results ?? []) as never,
		),
	);
});

/** 每日走势（v0.10）：从快照读取，按日补齐，点过多时服务端先降采样 */
portfolio.get("/history", async (c) => {
	const rawRange = (c.req.query("range") ?? "3M").toUpperCase();
	const range: TrendRange = ["1M", "3M", "6M", "1Y", "ALL"].includes(rawRange)
		? (rawRange as TrendRange)
		: "3M";
	const requested = c.req.query("currency");
	const db = c.env.DB;
	const filters = {
		class: c.req.query("class") || undefined,
		accountId: c.req.query("accountId") || undefined,
		markets: parseMarkets(c.req.query("market")),
	};

	// 设置 + 当前汇率 + 每日冻结汇率一次 batch 读完（原来是 5 条串行语句，
	// 其中 `SELECT key, value FROM settings` 还被重复读了两次）
	const [settingsResult, fxResult, fxDailyResult] = await db.batch([
		settingsStatement(db),
		fxRatesStatement(db),
		fxDailyStatement(db),
	]);
	const settings = toSettingsMap(settingsResult?.results as Array<{ key: string; value: string }> | undefined);
	const timeZone = timeZoneOf(settings);
	const displayCurrency = (requested && requested.trim() !== "" ? requested : displayCurrencyOf(settings))
		.toUpperCase()
		.slice(0, 5);

	// 快照的起始日期取决于区间与时区，所以这条只能接在后面（共 2 次往返）
	const from = rangeToFromDate(range, dateIn(timeZone));
	const snapshots = ((await snapshotsStatement(db, from).all<SnapshotRow>()).results ?? []) as SnapshotRow[];

	const series = await buildTrendSeries(db, {
		range,
		displayCurrency,
		filters,
		preload: {
			timeZone,
			fxRates: (fxResult?.results ?? []) as never,
			fxDailyRows: (fxDailyResult?.results ?? []) as never,
			snapshots,
		},
	});
	return ok(c, { ...series, range });
});

/** 快照列表（设置页用于排查"哪几天没拍"） */
portfolio.get("/snapshots", async (c) => {
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "60", 10);
	const limit = Number.isFinite(rawLimit) ? Math.min(365, Math.max(1, rawLimit)) : 60;
	return ok(c, { items: await listSnapshots(c.env.DB, { limit }) });
});

/** 立即拍一张快照（不等 Cron） */
portfolio.post("/snapshots", async (c) => {
	const t = tOf(c);
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	const date = typeof body?.date === "string" ? body.date : undefined;
	if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest(t("error.dateFormat"));

	const result = await takeSnapshot(c.env.DB, { date, force: true });
	await writeAudit(c.env.DB, {
		entity: "snapshot",
		entityId: result.date,
		action: "create",
		after: { date: result.date, total: result.total, currency: result.currency, holdings: result.holdings },
		source: "web",
		note: t("audit.snapshot", { currency: result.currency, total: result.total }),
	});
	return ok(c, result);
});

portfolio.delete("/snapshots/:date", async (c) => {
	const t = tOf(c);
	const date = c.req.param("date");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest(t("error.dateFormat"));
	const deleted = await deleteSnapshot(c.env.DB, date);
	if (!deleted) throw badRequest(t("error.noSnapshot"));
	await writeAudit(c.env.DB, { entity: "snapshot", entityId: date, action: "delete", source: "web" });
	return ok(c, { deleted: true });
});

/** 支持 ?market=us,hk 的多选形式（FR-6.3） */
function parseMarkets(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const markets = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => MARKETS.includes(item as (typeof MARKETS)[number]));
	return markets.length > 0 ? markets : undefined;
}

import { MARKETS } from "../../shared/labels";
import { dateIn } from "../../shared/time";

export default portfolio;
