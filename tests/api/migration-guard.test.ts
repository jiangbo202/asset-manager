import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../src/shared/version";
import { bootstrap, call, clearAll } from "../helpers";

/**
 * 数据库结构落后于代码时（本地忘了 migrate、线上忘了跑迁移），
 * 不能只给一个 500 堆栈，而要返回可照做的提示。
 */
describe("数据库未迁移时的降级提示", () => {
	it("/api/auth/me 会在结构版本落后时直接标记 migrationRequired", async () => {
		await clearAll();
		const cookie = (await bootstrap()).cookie;

		// 把结构版本改回旧值，模拟"库没升级"
		await env.DB.prepare(`UPDATE settings SET value = '1' WHERE key = 'schema_version'`).run();
		const stale = await call<{ data: { migrationRequired: boolean; schemaVersion: number; expectedSchemaVersion: number } }>(
			"/api/auth/me",
			{ cookie },
		);
		expect(stale.status).toBe(200);
		expect(stale.body.data.migrationRequired).toBe(true);
		expect(stale.body.data.schemaVersion).toBe(1);
		expect(stale.body.data.expectedSchemaVersion).toBeGreaterThan(1);

		// 升级后恢复正常
		await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'schema_version'`)
			.bind(String(SCHEMA_VERSION))
			.run();
		const fresh = await call<{ data: { migrationRequired: boolean } }>("/api/auth/me", { cookie });
		expect(fresh.body.data.migrationRequired).toBe(false);
	});

	it("缺表时返回 503 migration_required，并给出要执行的命令", async () => {
		await clearAll();
		const cookie = (await bootstrap()).cookie;

		// 模拟"旧库"：把 v0.11 新增的表删掉
		await env.DB.prepare("DROP TABLE IF EXISTS fx_daily").run();

		const response = await call<{ ok: boolean; error: { code: string; message: string } }>(
			"/api/portfolio/history?range=1M",
			{ cookie },
		);

		expect(response.status).toBe(503);
		expect(response.body.error.code).toBe("migration_required");
		expect(response.body.error.message).toContain("db:migrate:local");
		expect(response.body.error.message).toContain("db:migrate:remote");
	});
});
