import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import { applyBackup, exportBackup, parseBackup, previewBackup, type ImportMode } from "../services/backup";
import { APP_VERSION, BACKUP_SCHEMA_VERSION } from "../../shared/version";

const backup = new Hono<AppEnv>();

const parseMode = (value: string | undefined): ImportMode => {
	if (value === "replace") return "replace";
	if (value === "merge" || value === undefined || value === "") return "merge";
	throw badRequest("mode 只能是 merge 或 replace");
};

/** 导出：返回可下载的 JSON（FR-8.1 / FR-8.2：不含凭据） */
backup.get("/export", async (c) => {
	const includeAudit = c.req.query("includeAudit") !== "false";
	const file = await exportBackup(c.env.DB, { includeAudit });

	await writeAudit(c.env.DB, {
		entity: "backup",
		entityId: null,
		action: "create",
		note: `导出备份（${file.data.accounts.length} 账户 / ${file.data.holdings.length} 持仓${includeAudit ? " / 含操作历史" : ""}）`,
	});

	const filename = `asset-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
	c.header("Content-Disposition", `attachment; filename="${filename}"`);
	c.header("Cache-Control", "no-store");
	return c.body(JSON.stringify(file, null, 2), 200, { "Content-Type": "application/json; charset=utf-8" });
});

/** 导入：dryRun=true 只做校验与差异预览，不写库 */
backup.post("/import", async (c) => {
	const mode = parseMode(c.req.query("mode") ?? undefined);
	const dryRun = c.req.query("dryRun") === "true";

	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		throw badRequest("请求体不是合法 JSON");
	}

	const { file, warnings } = parseBackup(payload);
	const preview = await previewBackup(c.env.DB, file, mode, warnings);

	if (dryRun) {
		return ok(c, { preview, applied: null });
	}

	const result = await applyBackup(c.env.DB, file, mode);

	await writeAudit(c.env.DB, {
		entity: "backup",
		entityId: null,
		action: mode === "replace" ? "replace" : "import",
		before: { mode },
		after: {
			accounts: file.data.accounts.length,
			holdings: file.data.holdings.length,
			priceHistory: file.data.priceHistory.length,
			qtyHistory: file.data.qtyHistory.length,
			fxRates: file.data.fxRates.length,
			auditLog: file.data.auditLog.length,
			statements: result.statements,
			atomic: result.atomic,
		},
		source: "import",
		note: `${mode === "replace" ? "覆盖导入" : "合并导入"}备份（来自 ${file.appVersion}，导出于 ${file.exportedAt}）`,
	});

	return ok(c, { preview, applied: result });
});

/** 备份元信息：格式版本，供前端显示 */
backup.get("/info", async (c) => {
	return ok(c, {
		appVersion: APP_VERSION,
		schemaVersion: BACKUP_SCHEMA_VERSION,
	});
});

export default backup;
