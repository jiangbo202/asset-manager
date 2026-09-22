import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CfUsageStateDto } from "../../src/shared/api-types";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 用量的配置与缓存读取（不触碰外部网络）
 *
 * 走网络的那部分在 tests/api/cloudflare-usage.test.ts 里用假 fetch 测；
 * 这里测接口层：未配置时的行为、Token 只写不读、缓存读取、以及"刷新前必须先配置"。
 */
describe("Cloudflare 用量接口", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const get = async () => (await call<Envelope<CfUsageStateDto>>("/api/settings/usage", { cookie })).body.data;

	it("未配置：configured=false，带上默认的 Worker 名与库名，且**不发任何外部请求**", async () => {
		const data = await get();
		expect(data.configured).toBe(false);
		expect(data.tokenSet).toBe(false);
		expect(data.scriptName).toBe("asset-manager");
		expect(data.databaseName).toBe("asset-manager-db");
		expect(data.snapshot).toBeNull();
		// 免费额度写死给界面用
		expect(data.limits.requestsPerDay).toBe(100_000);
		expect(data.limits.rowsReadPerDay).toBe(5_000_000);
		expect(data.limits.databaseBytes).toBe(500 * 1024 * 1024);
	});

	it("未配置就点刷新：400 + 可操作的提示（不去打 Cloudflare）", async () => {
		const response = await call<Envelope<unknown>>("/api/settings/usage/refresh", { method: "POST", cookie });
		expect(response.status).toBe(400);
	});

	it("保存配置后：configured=true，但 Token **绝不回传**", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({
				cfApiToken: "super-secret-token",
				cfAccountId: "acct-123",
				cfScriptName: "asset-manager",
				cfDatabaseName: "asset-manager-db",
			}),
		});

		const data = await get();
		expect(data.configured).toBe(true);
		expect(data.tokenSet).toBe(true);
		expect(data.accountId).toBe("acct-123");

		// 原始响应里不能出现 Token；GET /api/settings 也不能带出来
		const raw = await SELF.fetch("https://example.com/api/settings/usage", { headers: { Cookie: cookie } });
		expect(await raw.text()).not.toContain("super-secret-token");
		const settings = await call<Envelope<{ values: Record<string, string> }>>("/api/settings", { cookie });
		expect(JSON.stringify(settings.body)).not.toContain("super-secret-token");
		expect(settings.body.data.values.cf_api_token).toBeUndefined();

		// 数据库里存的是密文，不是明文
		const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'cf_api_token'`).first<{
			value: string;
		}>();
		expect(row?.value).toBeTruthy();
		expect(row?.value).not.toContain("super-secret-token");
	});

	it("缓存：有快照时直接返回，不去打 Cloudflare（离线也能看上次的数字）", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "t", cfAccountId: "acct-1" }),
		});
		const snapshot = {
			fetchedAt: "2026-09-22T10:00:00.000Z",
			windowStart: "2026-09-22T00:00:00.000Z",
			windowEnd: "2026-09-22T10:00:00.000Z",
			requests: 512,
			rowsRead: 42_000,
			rowsWritten: 90,
			database: { id: "db-1", name: "asset-manager-db", fileSize: 12_345_678 },
		};
		await env.DB.prepare(
			`INSERT INTO settings (key, value) VALUES ('cf_usage', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		)
			.bind(JSON.stringify(snapshot))
			.run();

		const data = await get();
		expect(data.snapshot?.requests).toBe(512);
		expect(data.snapshot?.database?.fileSize).toBe(12_345_678);
	});

	it("换 Token 会丢掉旧快照（免得显示上一个账号的数字）", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "first", cfAccountId: "acct-1" }),
		});
		await env.DB.prepare(`UPDATE settings SET value = '{"requests":999}' WHERE key = 'cf_usage'`).run();
		expect((await get()).snapshot?.requests).toBe(999);

		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "second" }),
		});
		expect((await get()).snapshot).toBeNull();
	});

	it("清除配置：Token 与账号一起删掉，回到未配置状态", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "t", cfAccountId: "acct-1" }),
		});
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "", cfAccountId: "" }),
		});
		const data = await get();
		expect(data.configured).toBe(false);
		expect(data.tokenSet).toBe(false);
	});

	it("审计日志里不写 Token 原文（只留标记）", async () => {
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ cfApiToken: "super-secret-token", cfAccountId: "acct-1" }),
		});
		const rows = await env.DB.prepare(`SELECT before_json, after_json FROM audit_log ORDER BY ts DESC LIMIT 5`).all<{
			before_json: string | null;
			after_json: string | null;
		}>();
		const dump = JSON.stringify(rows.results ?? []);
		expect(dump).not.toContain("super-secret-token");
	});
});
