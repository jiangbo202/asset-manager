import { newId, nowIso } from "./utils";

export type AuditAction = "create" | "update" | "delete" | "import" | "replace" | "login" | "setup" | "security";
export type AuditSource = "web" | "import" | "system";

export interface AuditEntry {
	entity: string;
	entityId?: string | null;
	action: AuditAction;
	before?: unknown;
	after?: unknown;
	source?: AuditSource;
	note?: string | null;
	actor?: string;
}

const stringify = (value: unknown): string | null =>
	value === undefined || value === null ? null : JSON.stringify(value);

/** 写审计日志：所有写操作都必须调用（PRD FR-4.1） */
export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
	await db
		.prepare(
			`INSERT INTO audit_log (id, ts, actor, entity, entity_id, action, before_json, after_json, source, note)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId(),
			nowIso(),
			entry.actor ?? "owner",
			entry.entity,
			entry.entityId ?? null,
			entry.action,
			stringify(entry.before),
			stringify(entry.after),
			entry.source ?? "web",
			entry.note ?? null,
		)
		.run();
}

export interface AuditRow {
	id: string;
	ts: string;
	actor: string;
	entity: string;
	entity_id: string | null;
	action: string;
	before_json: string | null;
	after_json: string | null;
	source: string;
	note: string | null;
}

export interface AuditQuery {
	entity?: string;
	action?: string;
	from?: string;
	to?: string;
	page?: number;
	pageSize?: number;
}

export async function listAudit(db: D1Database, query: AuditQuery): Promise<{ items: AuditRow[]; total: number }> {
	const where: string[] = [];
	const params: unknown[] = [];
	if (query.entity) {
		where.push("entity = ?");
		params.push(query.entity);
	}
	if (query.action) {
		where.push("action = ?");
		params.push(query.action);
	}
	if (query.from) {
		where.push("ts >= ?");
		params.push(query.from);
	}
	if (query.to) {
		where.push("ts <= ?");
		params.push(query.to);
	}
	const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const page = Math.max(1, query.page ?? 1);
	const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

	const countRow = await db
		.prepare(`SELECT COUNT(*) AS total FROM audit_log ${clause}`)
		.bind(...params)
		.first<{ total: number }>();
	const { results } = await db
		.prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
		.bind(...params, pageSize, (page - 1) * pageSize)
		.all<AuditRow>();

	return { items: results ?? [], total: countRow?.total ?? 0 };
}

/** 字段级 diff：给前端"操作历史"页展开查看（PRD FR-4.3） */
export function fieldDiff(
	before: Record<string, unknown> | null,
	after: Record<string, unknown> | null,
): Array<{ field: string; from: unknown; to: unknown }> {
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	const out: Array<{ field: string; from: unknown; to: unknown }> = [];
	for (const key of keys) {
		const from = before?.[key];
		const to = after?.[key];
		if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field: key, from, to });
	}
	return out;
}
