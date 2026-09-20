import { Hono } from "hono";
import type { AppEnv } from "../types";
import { ok } from "../core/errors";
import { listHoldings } from "../data/accounts.repo";
import { listFxRates } from "../data/fx.repo";
import { getDisplayCurrency } from "../data/settings.repo";
import { buildPortfolio } from "../services/portfolio";
import { MARKETS } from "../../shared/labels";

/** 支持 ?market=us,hk 的多选形式（FR-6.3） */
function parseMarkets(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const markets = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => MARKETS.includes(item as (typeof MARKETS)[number]));
	return markets.length > 0 ? markets : undefined;
}

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

export default portfolio;
