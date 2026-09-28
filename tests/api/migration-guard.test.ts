import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../src/shared/version";
import { bootstrap, call, clearAll } from "../helpers";

/**
 * 数据库结构落后于代码时（本地忘了 migrate、线上忘了跑迁移），
 * 不能只给一个 500 堆栈，而要返回可照做的提示。
 */
describe("数据库未迁移时的降级提示", () => {
	/** 测试用的迁移记录表（Wrangler 在生产/本地用的就是这张表） */
	const resetMigrationLog = async () => {
		await env.DB.prepare(
			`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, applied_at TEXT)`,
		).run();
		await env.DB.prepare(`DELETE FROM d1_migrations`).run();
	};

	it("/api/auth/me 会在真·旧库（迁移没跑过）时标记 migrationRequired", async () => {
		await clearAll();
		const cookie = (await bootstrap()).cookie;

		// 真·旧库 = 结构确实落后 + 迁移记录里也没有新版本（自愈救不了它，也不该救）
		await resetMigrationLog();
		await env.DB.prepare(`UPDATE settings SET value = '5' WHERE key = 'schema_version'`).run();
		const stale = await call<{
			data: { migrationRequired: boolean; schemaVersion: number; expectedSchemaVersion: number };
		}>("/api/auth/me", { cookie });
		expect(stale.status).toBe(200);
		expect(stale.body.data.migrationRequired).toBe(true);
		expect(stale.body.data.schemaVersion).toBe(5);
		expect(stale.body.data.expectedSchemaVersion).toBeGreaterThan(5);

		// 升级后恢复正常
		await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'schema_version'`)
			.bind(String(SCHEMA_VERSION))
			.run();
		const fresh = await call<{ data: { migrationRequired: boolean } }>("/api/auth/me", { cookie });
		expect(fresh.body.data.migrationRequired).toBe(false);
	});

	it("结构标记漏写时自愈：列已升级、库却仍自称 v5，不能把用户锁在门外", async () => {
		// 真实事故现场：0006 忘了写 settings.schema_version —— 迁移应用过了（Wrangler 记录了），
		// 所以再跑迁移只会得到「No migrations to apply!」，而界面一直说「库需要升级」。
		// 这种情况下重试多少次都不会变，必须由应用自己对照迁移记录把标记补上。
		await clearAll();
		const cookie = (await bootstrap()).cookie;

		await resetMigrationLog();
		await env.DB.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)`)
			.bind(`000${SCHEMA_VERSION}_latest.sql`, new Date().toISOString())
			.run();
		await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'schema_version'`)
			.bind(String(SCHEMA_VERSION - 1))
			.run();

		const healed = await call<{ data: { migrationRequired: boolean; schemaVersion: number } }>("/api/auth/me", {
			cookie,
		});
		expect(healed.body.data.migrationRequired).toBe(false);
		expect(healed.body.data.schemaVersion).toBe(SCHEMA_VERSION);

		// 自愈结果要真的写回库，而不是只在这一次响应里“装作”升级了
		const stored = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first<{
			value: string;
		}>();
		expect(stored?.value).toBe(String(SCHEMA_VERSION));
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
