import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import { listHoldings } from "../data/accounts.repo";
import { listFxRates } from "../data/fx.repo";
import { getDisplayCurrency } from "../data/settings.repo";
import { buildPortfolio } from "../services/portfolio";
import {
	buildTrendSeries,
	deleteSnapshot,
	listSnapshots,
	rangeToFromDate,
	takeSnapshot,
	type TrendRange,
} from "../services/snapshots";

const portfolio = new Hono<AppEnv>();

/**
 * 组合视图（当前时点）
 * 只此一个接口，前端所有图表与统计都从这里取，避免多接口导致请求数与 CPU 上升（PRD §8）
 */
portfolio.get("/", async (c) => {
	const requested = c.req.query("currency");
	const displayCurrency = (requested && requested.trim() !== "" ? requested : await getDisplayCurrency(c.env.DB))
		.toUpperCase()
		.slice(0, 5);

	const rows = await listHoldings(c.env.DB, {
		accountId: c.req.query("accountId"),
		class: c.req.query("class"),
		markets: parseMarkets(c.req.query("market")),
		currency: c.req.query("currencyFilter"),
	});
	const fxRates = await listFxRates(c.env.DB);
	return ok(c, buildPortfolio(rows, displayCurrency, fxRates));
});

/** 每日走势（v0.10）：从快照读取，按日补齐，点过多时服务端先降采样 */
portfolio.get("/history", async (c) => {
	const rawRange = (c.req.query("range") ?? "3M").toUpperCase();
	const range: TrendRange = ["1M", "3M", "6M", "1Y", "ALL"].includes(rawRange)
		? (rawRange as TrendRange)
		: "3M";
	const requested = c.req.query("currency");
	const displayCurrency = (requested && requested.trim() !== "" ? requested : await getDisplayCurrency(c.env.DB))
		.toUpperCase()
		.slice(0, 5);

	const series = await buildTrendSeries(c.env.DB, {
		range,
		displayCurrency,
		filters: {
			class: c.req.query("class") || undefined,
			accountId: c.req.query("accountId") || undefined,
			markets: parseMarkets(c.req.query("market")),
		},
	});
	return ok(c, { ...series, range, from: rangeToFromDate(range) });
});

/** 快照列表（设置页用于排查"哪几天没拍"） */
portfolio.get("/snapshots", async (c) => {
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "60", 10);
	const limit = Number.isFinite(rawLimit) ? Math.min(365, Math.max(1, rawLimit)) : 60;
	return ok(c, { items: await listSnapshots(c.env.DB, { limit }) });
});

/** 立即拍一张快照（不等 Cron） */
portfolio.post("/snapshots", async (c) => {
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	const date = typeof body?.date === "string" ? body.date : undefined;
	if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date 格式应为 YYYY-MM-DD");

	const result = await takeSnapshot(c.env.DB, { date, force: true });
	await writeAudit(c.env.DB, {
		entity: "snapshot",
		entityId: result.date,
		action: "create",
		after: { date: result.date, total: result.total, currency: result.currency, holdings: result.holdings },
		source: "system",
		note: `手动生成快照（${result.currency} ${result.total}）`,
	});
	return ok(c, result);
});

portfolio.delete("/snapshots/:date", async (c) => {
	const date = c.req.param("date");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("日期格式应为 YYYY-MM-DD");
	const deleted = await deleteSnapshot(c.env.DB, date);
	if (!deleted) throw badRequest("该日期没有快照");
	await writeAudit(c.env.DB, { entity: "snapshot", entityId: date, action: "delete", source: "system" });
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

export default portfolio;
