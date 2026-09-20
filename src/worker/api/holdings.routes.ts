import { Hono } from "hono";
import type { AppEnv } from "../types";
import { ASSET_CLASSES, MARKETS } from "../../shared/labels";
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
import { newId, nowIso, todayUtc } from "../core/utils";
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
	const payload = asRecord(await c.req.json());
	const accountId = requireString(payload, "accountId", { label: "账户", max: 64 });
	const account = await getAccount(c.env.DB, accountId);
	if (!account) throw badRequest("指定的账户不存在");

	const assetClass = requireOneOf(payload, "class", ASSET_CLASSES, "资产类别");
	const isCash = assetClass === "cash";
	const market = optionalString(payload, "market", { label: "市场", max: 16 }) ?? null;
	if (market && !MARKETS.includes(market as (typeof MARKETS)[number])) {
		throw badRequest(`市场必须是以下之一：${MARKETS.join(" / ")}`);
	}

	const input = {
		account_id: accountId,
		class: assetClass,
		market: isCash ? null : market,
		symbol: isCash ? null : optionalString(payload, "symbol", { label: "代码", max: 32 }),
		name: requireString(payload, "name", { label: "名称", max: 80 }),
		currency: requireCurrency(payload),
		qty: requireNumber(payload, "qty", { label: isCash ? "余额" : "数量", min: -1e15, max: 1e15 }),
		price: isCash ? 1 : requireNumber(payload, "price", { label: "价格", min: 0, max: 1e15 }),
		avg_cost: isCash ? null : optionalNumber(payload, "avgCost", { label: "平均成本", min: 0, max: 1e15 }) ?? null,
		quote_source: isCash ? null : optionalString(payload, "quoteSource", { label: "行情数据源", max: 20 }) ?? null,
		quote_symbol: isCash ? null : optionalString(payload, "quoteSymbol", { label: "行情代码", max: 40 }) ?? null,
		note: optionalString(payload, "note", { label: "备注", max: 200 }) ?? null,
	};

	const created = await createHolding(c.env.DB, input);
	if (!isCash) {
		await recordPrice(c.env.DB, created.id, input.price, todayUtc(), "manual");
		await recordQty(c.env.DB, created.id, input.qty, todayUtc(), "manual");
	}
	await writeAudit(c.env.DB, { entity: "holding", entityId: created.id, action: "create", after: created });
	return ok(c, created, 201);
});

holdings.patch("/:id", async (c) => {
	const id = requireId(c.req.param("id"), "持仓 id");
	const before = await getHolding(c.env.DB, id);
	if (!before) throw notFound("持仓不存在");

	const payload = asRecord(await c.req.json());
	const patch: Record<string, unknown> = {};
	if (payload.accountId !== undefined) {
		const accountId = requireString(payload, "accountId", { label: "账户", max: 64 });
		if (!(await getAccount(c.env.DB, accountId))) throw badRequest("指定的账户不存在");
		patch.account_id = accountId;
	}
	if (payload.class !== undefined) patch.class = requireOneOf(payload, "class", ASSET_CLASSES, "资产类别");
	if (payload.name !== undefined) patch.name = requireString(payload, "name", { label: "名称", max: 80 });
	if (payload.currency !== undefined) patch.currency = requireCurrency(payload);
	if (payload.symbol !== undefined) patch.symbol = optionalString(payload, "symbol", { label: "代码", max: 32 }) ?? null;
	if (payload.market !== undefined) patch.market = optionalString(payload, "market", { label: "市场", max: 16 }) ?? null;
	if (payload.note !== undefined) patch.note = optionalString(payload, "note", { label: "备注", max: 200 }) ?? null;
	if (payload.archived !== undefined) patch.archived = Boolean(payload.archived);
	if (payload.qty !== undefined) patch.qty = requireNumber(payload, "qty", { label: "数量", min: -1e15, max: 1e15 });
	if (payload.price !== undefined) patch.price = requireNumber(payload, "price", { label: "价格", min: 0, max: 1e15 });
	if (payload.avgCost !== undefined) {
		patch.avg_cost = optionalNumber(payload, "avgCost", { label: "平均成本", min: 0, max: 1e15 }) ?? null;
	}
	if (payload.quoteSource !== undefined) {
		patch.quote_source = optionalString(payload, "quoteSource", { label: "行情数据源", max: 20 }) ?? null;
	}
	if (payload.quoteSymbol !== undefined) {
		patch.quote_symbol = optionalString(payload, "quoteSymbol", { label: "行情代码", max: 40 }) ?? null;
	}

	const nextClass = (patch.class as string | undefined) ?? before.class;
	const effectiveDate =
		optionalString(payload, "effectiveDate", { label: "生效日期", max: 10 }) ?? todayUtc();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw badRequest("生效日期格式应为 YYYY-MM-DD");

	const priceChanged = typeof patch.price === "number" && patch.price !== before.price;
	const qtyChanged = typeof patch.qty === "number" && patch.qty !== before.qty;
	const priceUpdatedAt = priceChanged ? nowIso() : undefined;

	const after = await updateHolding(c.env.DB, id, patch, priceUpdatedAt);
	if (!after) throw notFound("持仓不存在");

	// v1 只写不读：为 v2 走势图预埋历史（PRD FR-3.2）
	if (nextClass !== "cash") {
		if (priceChanged) await recordPrice(c.env.DB, id, after.price, effectiveDate, "manual");
		if (qtyChanged) await recordQty(c.env.DB, id, after.qty, effectiveDate, "manual");
	}

	await writeAudit(c.env.DB, { entity: "holding", entityId: id, action: "update", before, after });
	return ok(c, after);
});

holdings.delete("/:id", async (c) => {
	const id = requireId(c.req.param("id"), "持仓 id");
	const before = await getHolding(c.env.DB, id);
	if (!before) throw notFound("持仓不存在");
	await deleteHolding(c.env.DB, id);
	await writeAudit(c.env.DB, { entity: "holding", entityId: id, action: "delete", before });
	return ok(c, { deleted: true });
});

/** 批量更新价格：一屏填完一次提交（PRD FR-3.5） */
holdings.post("/bulk-price", async (c) => {
	const payload = asRecord(await c.req.json());
	const rawItems = payload.items;
	if (!Array.isArray(rawItems) || rawItems.length === 0) throw badRequest("items 必须是非空数组");
	if (rawItems.length > 500) throw badRequest("单次最多更新 500 条");

	const statements: D1PreparedStatement[] = [];
	const touched: Array<{ id: string; price: number; before: number }> = [];
	const now = nowIso();

	for (const raw of rawItems) {
		const item = asRecord(raw, "items[]");
		const id = requireString(item, "id", { label: "持仓 id", max: 64 });
		const price = requireNumber(item, "price", { label: "价格", min: 0, max: 1e15 });
		const holding = await getHolding(c.env.DB, id);
		if (!holding) throw notFound(`持仓 ${id} 不存在`);
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
			).bind(newId(), id, todayUtc(), price, now),
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
			note: `批量更新 ${touched.length} 条价格`,
		});
	}

	return ok(c, { updated: touched.length, items: touched });
});

export default holdings;
