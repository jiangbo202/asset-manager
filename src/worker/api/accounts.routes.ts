import { Hono } from "hono";
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
	return ok(c, { items: await listAccounts(c.env.DB, includeArchived) });
});

accounts.post("/", async (c) => {
	const payload = asRecord(await c.req.json());
	const input = {
		name: requireString(payload, "name", { label: "账户名称", max: 60 }),
		kind: requireOneOf(payload, "kind", ACCOUNT_KINDS, "账户类型"),
		market: optionalString(payload, "market", { label: "市场", max: 16 }) ?? null,
		currency: requireCurrency(payload),
		icon_key: optionalString(payload, "iconKey", { label: "图标", max: 40 }) ?? null,
		sort: optionalNumber(payload, "sort", { label: "排序" }) ?? 0,
		note: optionalString(payload, "note", { label: "备注", max: 200 }) ?? null,
	};
	if (input.market && !MARKETS.includes(input.market as (typeof MARKETS)[number])) {
		throw badRequest(`市场必须是以下之一：${MARKETS.join(" / ")}`);
	}
	if (input.kind === "cash") input.market = null;

	const created = await createAccount(c.env.DB, input);
	await writeAudit(c.env.DB, { entity: "account", entityId: created.id, action: "create", after: created });
	return ok(c, created, 201);
});

accounts.patch("/:id", async (c) => {
	const id = requireId(c.req.param("id"), "账户 id");
	const before = await getAccount(c.env.DB, id);
	if (!before) throw notFound("账户不存在");

	const payload = asRecord(await c.req.json());
	const patch: Record<string, unknown> = {};
	if (payload.name !== undefined) patch.name = requireString(payload, "name", { label: "账户名称", max: 60 });
	if (payload.kind !== undefined) patch.kind = requireOneOf(payload, "kind", ACCOUNT_KINDS, "账户类型");
	if (payload.currency !== undefined) patch.currency = requireCurrency(payload);
	if (payload.market !== undefined) patch.market = optionalString(payload, "market", { label: "市场", max: 16 }) ?? null;
	if (payload.iconKey !== undefined) patch.icon_key = optionalString(payload, "iconKey", { label: "图标", max: 40 }) ?? null;
	if (payload.sort !== undefined) patch.sort = optionalNumber(payload, "sort", { label: "排序" }) ?? 0;
	if (payload.note !== undefined) patch.note = optionalString(payload, "note", { label: "备注", max: 200 }) ?? null;
	if (payload.archived !== undefined) patch.archived = Boolean(payload.archived);

	const after = await updateAccount(c.env.DB, id, patch);
	await writeAudit(c.env.DB, { entity: "account", entityId: id, action: "update", before, after });
	return ok(c, after);
});

accounts.delete("/:id", async (c) => {
	const id = requireId(c.req.param("id"), "账户 id");
	const before = await getAccount(c.env.DB, id);
	if (!before) throw notFound("账户不存在");

	const holdingCount = await countAccountHoldings(c.env.DB, id);
	const cascade = c.req.query("cascadeHoldings") === "true";
	if (holdingCount > 0 && !cascade) {
		throw conflict(`该账户下还有 ${holdingCount} 条持仓，请先清空或选择一并删除`, "has_holdings");
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
