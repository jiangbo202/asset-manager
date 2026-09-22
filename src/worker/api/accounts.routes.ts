import { Hono } from "hono";
import { tOf } from "../core/i18n";
import type { AppEnv } from "../types";
import { ACCOUNT_KINDS, MARKETS } from "../../shared/labels";
import { badRequest, conflict, notFound, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import {
	countAccountHoldings,
	createAccount,
	deleteAccount,
	getAccount,
	listAccounts,
	updateAccount,
} from "../data/accounts.repo";
import { asRecord, optionalNumber, optionalString, requireId, requireOneOf, requireString, requireCurrency } from "./validate";

const accounts = new Hono<AppEnv>();

accounts.get("/", async (c) => {
	const includeArchived = c.req.query("includeArchived") === "true";
	const items = await listAccounts(c.env.DB, includeArchived);
	// 匿名访客（公开只读分享）：只给总览需要的账户名/图标，备注属于私人内容
	if (c.get("publicViewer")) return ok(c, { items: items.map((item) => ({ ...item, note: null })) });
	return ok(c, { items });
});

accounts.post("/", async (c) => {
		const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const input = {
		name: requireString(payload, "name", { labelKey: "field.accountName", max: 60 }, t),
		kind: requireOneOf(payload, "kind", ACCOUNT_KINDS, "field.kind", t),
		market: optionalString(payload, "market", { labelKey: "field.market", max: 16 }, t) ?? null,
		currency: requireCurrency(payload, "currency", t),
		icon_key: optionalString(payload, "iconKey", { labelKey: "field.icon", max: 40 }, t) ?? null,
		sort: optionalNumber(payload, "sort", { labelKey: "field.sort" }, t) ?? 0,
		note: optionalString(payload, "note", { labelKey: "field.note", max: 200 }, t) ?? null,
	};
	if (input.market && !MARKETS.includes(input.market as (typeof MARKETS)[number])) {
		throw badRequest(t("error.field_enum", { label: t("field.market"), allowed: MARKETS.join(" / ") }));
	}
	if (input.kind === "cash") input.market = null;

	const created = await createAccount(c.env.DB, input);
	await writeAudit(c.env.DB, { entity: "account", entityId: created.id, action: "create", after: created });
	return ok(c, created, 201);
});

accounts.patch("/:id", async (c) => {
		const t = tOf(c);
	const id = requireId(c.req.param("id"), t,  "账户 id");
	const before = await getAccount(c.env.DB, id);
	if (!before) throw notFound(t("error.not_found"));

	const payload = asRecord(await c.req.json(), t);
	const patch: Record<string, unknown> = {};
	if (payload.name !== undefined) patch.name = requireString(payload, "name", { labelKey: "field.accountName", max: 60 }, t);
	if (payload.kind !== undefined) patch.kind = requireOneOf(payload, "kind", ACCOUNT_KINDS, "field.kind", t);
	if (payload.currency !== undefined) patch.currency = requireCurrency(payload, "currency", t);
	if (payload.market !== undefined) patch.market = optionalString(payload, "market", { labelKey: "field.market", max: 16 }, t) ?? null;
	if (payload.iconKey !== undefined) patch.icon_key = optionalString(payload, "iconKey", { labelKey: "field.icon", max: 40 }, t) ?? null;
	if (payload.sort !== undefined) patch.sort = optionalNumber(payload, "sort", { labelKey: "field.sort" }, t) ?? 0;
	if (payload.note !== undefined) patch.note = optionalString(payload, "note", { labelKey: "field.note", max: 200 }, t) ?? null;
	if (payload.archived !== undefined) patch.archived = Boolean(payload.archived);

	const after = await updateAccount(c.env.DB, id, patch);
	await writeAudit(c.env.DB, { entity: "account", entityId: id, action: "update", before, after });
	return ok(c, after);
});

accounts.delete("/:id", async (c) => {
		const t = tOf(c);
	const id = requireId(c.req.param("id"), t,  "账户 id");
	const before = await getAccount(c.env.DB, id);
	if (!before) throw notFound(t("error.not_found"));

	const holdingCount = await countAccountHoldings(c.env.DB, id);
	const cascade = c.req.query("cascadeHoldings") === "true";
	if (holdingCount > 0 && !cascade) {
		throw conflict(t("error.hasHoldings"), "has_holdings");
	}

	await deleteAccount(c.env.DB, id);
	await writeAudit(c.env.DB, {
		entity: "account",
		entityId: id,
		action: "delete",
		before,
		note: cascade && holdingCount > 0 ? `一并删除 ${holdingCount} 条持仓` : null,
	});
	return ok(c, { deleted: true, holdings: holdingCount });
});

export default accounts;
