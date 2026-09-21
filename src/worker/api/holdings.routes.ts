import { Hono } from "hono";
import { tOf } from "../core/i18n";
import type { AppEnv } from "../types";
import { ASSET_CLASSES, MARKETS } from "../../shared/labels";
import type { Translator } from "../../shared/i18n";
import { badRequest, notFound, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import {
	createHolding,
	deleteHolding,
	getAccount,
	getHolding,
	listHoldings,
	updateHolding,
} from "../data/accounts.repo";
import { recordPrice, recordQty } from "../data/history.repo";
import { newId, nowIso } from "../core/utils";
import { dateIn } from "../../shared/time";
import { getTimeZone } from "../data/settings.repo";
import {
	asRecord,
	optionalNumber,
	optionalString,
	requireCurrency,
	requireId,
	requireNumber,
	requireOneOf,
	requireString,
} from "./validate";

const holdings = new Hono<AppEnv>();

/**
 * 市场与代码是否自相矛盾。
 *
 * 踩过的坑：把美股 MSTR 记成港股，于是刷新时请求的是 "MSTR.HK"，Yahoo 一直 404，
 * 界面上只看到"失败 1"，查了很久。港股 / A 股代码一定是数字（允许 .HK/.SS/.SZ/.SH 后缀），
 * 所以在保存时就拦下来，比事后从数据源报错里反推省事得多。
 */
function assertMarketSymbolShape(market: string, symbol: string | null | undefined, t: Translator): void {
	// 只有港股 / A 股有"代码必须是数字"这条约束
	if (market !== "hk" && market !== "cn") return;
	if (!symbol) return;
	const bare = symbol.trim().toUpperCase().replace(/\.(HK|SS|SZ|SH)$/, "");
	if (/^\d+$/.test(bare)) return;
	throw badRequest(
		t("error.marketSymbolMismatch", { market: t(`mkt.${market}`), symbol: symbol.trim() }),
	);
}

/** 支持 ?market=us,hk 的多选形式（FR-6.3） */
function parseMarkets(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const markets = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => MARKETS.includes(item as (typeof MARKETS)[number]));
	return markets.length > 0 ? markets : undefined;
}

holdings.get("/", async (c) => {
	const items = await listHoldings(c.env.DB, {
		accountId: c.req.query("accountId"),
		class: c.req.query("class"),
		markets: parseMarkets(c.req.query("market")),
		currency: c.req.query("currency"),
		includeArchived: c.req.query("includeArchived") === "true",
	});
	return ok(c, { items });
});

holdings.post("/", async (c) => {
		const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const accountId = requireString(payload, "accountId", { labelKey: "field.account", max: 64 }, t);
	const account = await getAccount(c.env.DB, accountId);
	if (!account) throw badRequest(t("error.not_found"));

	const assetClass = requireOneOf(payload, "class", ASSET_CLASSES, "field.class", t);
	const isCash = assetClass === "cash";
	const market = optionalString(payload, "market", { labelKey: "field.market", max: 16 }, t) ?? null;
	if (market && !MARKETS.includes(market as (typeof MARKETS)[number])) {
		throw badRequest(t("error.field_enum", { label: t("field.market"), allowed: MARKETS.join(" / ") }));
	}

	const symbol = isCash ? null : optionalString(payload, "symbol", { labelKey: "field.symbol", max: 32 }, t);
	if (!isCash && market) assertMarketSymbolShape(market, symbol, t);

	const input = {
		account_id: accountId,
		class: assetClass,
		market: isCash ? null : market,
		symbol,
		name: requireString(payload, "name", { labelKey: "field.name", max: 80 }, t),
		currency: requireCurrency(payload, "currency", t),
		qty: requireNumber(payload, "qty", { labelKey: isCash ? "field.balance" : "field.qty", min: -1e15, max: 1e15 }, t),
		price: isCash ? 1 : requireNumber(payload, "price", { labelKey: "field.price", min: 0, max: 1e15 }, t),
		avg_cost: isCash ? null : optionalNumber(payload, "avgCost", { labelKey: "field.avgCost", min: 0, max: 1e15 }, t) ?? null,
		quote_source: isCash ? null : optionalString(payload, "quoteSource", { labelKey: "field.quoteSource", max: 20 }, t) ?? null,
		quote_symbol: isCash ? null : optionalString(payload, "quoteSymbol", { labelKey: "field.quoteSymbol", max: 40 }, t) ?? null,
		note: optionalString(payload, "note", { labelKey: "field.note", max: 200 }, t) ?? null,
	};

	const created = await createHolding(c.env.DB, input);
	if (!isCash) {
		const effectiveDate = dateIn(await getTimeZone(c.env.DB));
		await recordPrice(c.env.DB, created.id, input.price, effectiveDate, "manual");
		await recordQty(c.env.DB, created.id, input.qty, effectiveDate, "manual");
	}
	await writeAudit(c.env.DB, { entity: "holding", entityId: created.id, action: "create", after: created });
	return ok(c, created, 201);
});

holdings.patch("/:id", async (c) => {
		const t = tOf(c);
	const id = requireId(c.req.param("id"), t,  "持仓 id");
	const before = await getHolding(c.env.DB, id);
	if (!before) throw notFound(t("error.not_found"));

	const payload = asRecord(await c.req.json(), t);
	const patch: Record<string, unknown> = {};
	if (payload.accountId !== undefined) {
		const accountId = requireString(payload, "accountId", { labelKey: "field.account", max: 64 }, t);
		if (!(await getAccount(c.env.DB, accountId))) throw badRequest(t("error.not_found"));
		patch.account_id = accountId;
	}
	if (payload.class !== undefined) patch.class = requireOneOf(payload, "class", ASSET_CLASSES, "field.class", t);
	if (payload.name !== undefined) patch.name = requireString(payload, "name", { labelKey: "field.name", max: 80 }, t);
	if (payload.currency !== undefined) patch.currency = requireCurrency(payload, "currency", t);
	if (payload.symbol !== undefined) patch.symbol = optionalString(payload, "symbol", { labelKey: "field.symbol", max: 32 }, t) ?? null;
	if (payload.market !== undefined) patch.market = optionalString(payload, "market", { labelKey: "field.market", max: 16 }, t) ?? null;
	if (payload.note !== undefined) patch.note = optionalString(payload, "note", { labelKey: "field.note", max: 200 }, t) ?? null;
	if (payload.archived !== undefined) patch.archived = Boolean(payload.archived);
	// 类别/市场/代码三者要自洽：改了市场或代码就重新校验一次（未改的一侧用库里的现值）
	{
		const nextClass = (patch.class as string | undefined) ?? before.class;
		const nextMarket = (patch.market as string | null | undefined) ?? before.market;
		const nextSymbol = (patch.symbol as string | null | undefined) ?? before.symbol;
		if (nextClass !== "cash") assertMarketSymbolShape(nextMarket ?? "", nextSymbol, t);
	}
	if (payload.qty !== undefined) patch.qty = requireNumber(payload, "qty", { labelKey: "field.qty", min: -1e15, max: 1e15 }, t);
	if (payload.price !== undefined) patch.price = requireNumber(payload, "price", { labelKey: "field.price", min: 0, max: 1e15 }, t);
	if (payload.avgCost !== undefined) {
		patch.avg_cost = optionalNumber(payload, "avgCost", { labelKey: "field.avgCost", min: 0, max: 1e15 }, t) ?? null;
	}
	if (payload.quoteSource !== undefined) {
		patch.quote_source = optionalString(payload, "quoteSource", { labelKey: "field.quoteSource", max: 20 }, t) ?? null;
	}
	if (payload.quoteSymbol !== undefined) {
		patch.quote_symbol = optionalString(payload, "quoteSymbol", { labelKey: "field.quoteSymbol", max: 40 }, t) ?? null;
	}

	const nextClass = (patch.class as string | undefined) ?? before.class;
	const effectiveDate =
		optionalString(payload, "effectiveDate", { labelKey: "field.effectiveDate", max: 10 }, t) ??
		dateIn(await getTimeZone(c.env.DB));
	if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw badRequest(t("error.dateFormat"));

	const priceChanged = typeof patch.price === "number" && patch.price !== before.price;
	const qtyChanged = typeof patch.qty === "number" && patch.qty !== before.qty;
	const priceUpdatedAt = priceChanged ? nowIso() : undefined;

	const after = await updateHolding(c.env.DB, id, patch, priceUpdatedAt);
	if (!after) throw notFound(t("error.not_found"));

	// v1 只写不读：为 v2 走势图预埋历史（PRD FR-3.2）
	if (nextClass !== "cash") {
		if (priceChanged) await recordPrice(c.env.DB, id, after.price, effectiveDate, "manual");
		if (qtyChanged) await recordQty(c.env.DB, id, after.qty, effectiveDate, "manual");
	}

	await writeAudit(c.env.DB, { entity: "holding", entityId: id, action: "update", before, after });
	return ok(c, after);
});

holdings.delete("/:id", async (c) => {
		const t = tOf(c);
	const id = requireId(c.req.param("id"), t,  "持仓 id");
	const before = await getHolding(c.env.DB, id);
	if (!before) throw notFound(t("error.not_found"));
	await deleteHolding(c.env.DB, id);
	await writeAudit(c.env.DB, { entity: "holding", entityId: id, action: "delete", before });
	return ok(c, { deleted: true });
});

/** 批量更新价格：一屏填完一次提交（PRD FR-3.5） */
holdings.post("/bulk-price", async (c) => {
		const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const rawItems = payload.items;
	if (!Array.isArray(rawItems) || rawItems.length === 0) throw badRequest(t("error.invalid_field"));
	if (rawItems.length > 500) throw badRequest(t("error.invalid_field"));

	const statements: D1PreparedStatement[] = [];
	const touched: Array<{ id: string; price: number; before: number }> = [];
	const now = nowIso();
	const effectiveDate = dateIn(await getTimeZone(c.env.DB));

	for (const raw of rawItems) {
		const item = asRecord(raw, t);
		const id = requireString(item, "id", { labelKey: "field.name", max: 64 }, t);
		const price = requireNumber(item, "price", { labelKey: "field.price", min: 0, max: 1e15 }, t);
		const holding = await getHolding(c.env.DB, id);
		if (!holding) throw notFound(t("error.not_found"));
		if (holding.price === price) continue;

		statements.push(
			c.env.DB.prepare(`UPDATE holdings SET price = ?, price_updated_at = ?, updated_at = ? WHERE id = ?`).bind(
				price,
				now,
				now,
				id,
			),
		);
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO price_history (id, holding_id, effective_date, price, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)`,
			).bind(newId(), id, effectiveDate, price, now),
		);
		touched.push({ id, price, before: holding.price });
	}

	if (statements.length > 0) await c.env.DB.batch(statements);
	if (touched.length > 0) {
		await writeAudit(c.env.DB, {
			entity: "holding",
			entityId: null,
			action: "update",
			after: { bulkPrice: touched.length },
			note: t("audit.bulkPrice", { count: touched.length }),
		});
	}

	return ok(c, { updated: touched.length, items: touched });
});

export default holdings;
