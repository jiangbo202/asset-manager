import { Hono } from "hono";
import type { AppEnv } from "../types";
import { ok } from "../core/errors";
import { fieldDiff, listAudit } from "../core/audit";
import { clampNumber } from "../core/utils";

const history = new Hono<AppEnv>();

const parseJson = (value: string | null): Record<string, unknown> | null => {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

/** 操作历史（PRD FR-4.2 / FR-4.3：字段级 diff 在服务端算好，前端直接渲染） */
history.get("/", async (c) => {
	const page = clampNumber(c.req.query("page"), 1, 100_000, 1);
	const pageSize = clampNumber(c.req.query("pageSize"), 1, 200, 50);

	const { items, total } = await listAudit(c.env.DB, {
		entity: c.req.query("entity") || undefined,
		action: c.req.query("action") || undefined,
		from: c.req.query("from") || undefined,
		to: c.req.query("to") || undefined,
		page,
		pageSize,
	});

	return ok(c, {
		total,
		page,
		pageSize,
		items: items.map((row) => {
			const before = parseJson(row.before_json);
			const after = parseJson(row.after_json);
			return {
				id: row.id,
				ts: row.ts,
				actor: row.actor,
				entity: row.entity,
				entityId: row.entity_id,
				action: row.action,
				source: row.source,
				note: row.note,
				before,
				after,
				diff: fieldDiff(before, after),
			};
		}),
	});
});

export default history;
