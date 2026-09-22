import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionItemDto } from "../../src/shared/api-types";
import { describeUserAgent } from "../../src/shared/device";
import { bootstrap, call, clearAll, login } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 会话列表与"踢出指定设备"
 *
 * 两件必须守住的事：
 *  1. **只有本人能看**：列表里有 IP 和真实设备信息，公开只读分享绝不能把它露出去
 *  2. 交给前端的 id 是 sha256(token)，不是 token —— 否则等于把登录凭证发给浏览器
 */
describe("会话列表与踢出设备", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap("test-password-123")).cookie;
	});

	/** 造一条"另一台设备"的会话（带自己的 UA/IP） */
	const otherDevice = async (userAgent: string, ip: string) => {
		const params = await call<{ ok: boolean; data: { kdfSalt: string; iterations: number } }>("/api/auth/params");
		const { deriveCredential, TEST_ITERATIONS } = await import("../helpers");
		const credential = await deriveCredential("test-password-123", params.body.data.kdfSalt, TEST_ITERATIONS);
		const response = await call<{ ok: boolean }>("/api/auth/login", {
			method: "POST",
			headers: { "User-Agent": userAgent, "CF-Connecting-IP": ip },
			body: JSON.stringify({ credential }),
		});
		if (!response.cookie) throw new Error("没有拿到会话 cookie");
		return response.cookie;
	};

	const list = async (sessionCookie = cookie) =>
		(await call<Envelope<{ items: SessionItemDto[] }>>("/api/settings/sessions", { cookie: sessionCookie })).body
			.data.items;

	it("列出设备、IP、登录时间，并标出哪条是本设备", async () => {
		const phone = await otherDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1", "203.0.113.7");

		const items = await list();
		expect(items).toHaveLength(2);

		// 本设备排最前
		expect(items[0]?.current).toBe(true);
		const other = items.find((item) => !item.current);
		expect(other?.ip).toBe("203.0.113.7");
		expect(other?.userAgent).toContain("iPhone");
		expect(other?.createdAt).toBeTruthy();
		expect(other?.expiresAt).toBeTruthy();

		// 只读到一条标记为 current
		expect(items.filter((item) => item.current)).toHaveLength(1);
		// 另一台设备的会话仍然有效
		expect((await list(phone)).length).toBe(2);
	});

	it("id 是 sha256(token)，不是 cookie 里的令牌", async () => {
		const items = await list();
		const token = cookie.split("=").slice(1).join("=");
		for (const item of items) {
			expect(item.id).toMatch(/^[0-9a-f]{64}$/);
			expect(item.id).not.toBe(token);
			expect(token).not.toContain(item.id);
		}
	});

	it("踢出指定设备：那台设备立刻失效，本人不受影响", async () => {
		const phone = await otherDevice(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1",
			"203.0.113.7",
		);
		const target = (await list()).find((item) => !item.current);
		expect(target).toBeTruthy();

		const response = await call<Envelope<{ revoked: boolean; current: boolean }>>(
			`/api/settings/sessions/${target!.id}`,
			{ method: "DELETE", cookie },
		);
		expect(response.status).toBe(200);
		expect(response.body.data.revoked).toBe(true);
		expect(response.body.data.current).toBe(false);

		// 被踢的设备：会话没了 → 401
		expect((await call("/api/settings", { cookie: phone })).status).toBe(401);
		// 本人照常
		expect((await call("/api/settings", { cookie })).status).toBe(200);
		expect(await list()).toHaveLength(1);
	});

	it("踢出后该设备的审计留痕（谁被踢了、从哪个 IP）", async () => {
		await otherDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", "198.51.100.9");
		const target = (await list()).find((item) => !item.current)!;
		await call(`/api/settings/sessions/${target.id}`, { method: "DELETE", cookie });

		const audit = await env.DB.prepare(
			`SELECT entity, action, before_json, note FROM audit_log
			 WHERE entity = 'auth' AND action = 'security' AND note IS NOT NULL
			 ORDER BY ts DESC LIMIT 1`,
		).first<{ entity: string; action: string; before_json: string; note: string }>();
		expect(audit?.action).toBe("security");
		expect(audit?.before_json).toContain("198.51.100.9");
		expect(audit?.note).toContain("踢出");
	});

	it("踢出自己 = 登出：返回 current=true 且会话立即失效", async () => {
		const me = (await list()).find((item) => item.current)!;
		const response = await call<Envelope<{ revoked: boolean; current: boolean }>>(
			`/api/settings/sessions/${me.id}`,
			{ method: "DELETE", cookie },
		);
		expect(response.body.data.current).toBe(true);
		expect((await call("/api/settings", { cookie })).status).toBe(401);
	});

	it("不存在的会话 / 格式不合法的 id：404 与 400", async () => {
		expect((await call(`/api/settings/sessions/${"f".repeat(64)}`, { method: "DELETE", cookie })).status).toBe(404);
		expect((await call("/api/settings/sessions/not-a-hash", { method: "DELETE", cookie })).status).toBe(400);
		// 400 不该被当成"已处理"而误删别的会话
		expect(await list()).toHaveLength(1);
	});

	it("未登录 / 公开只读分享下，都拿不到会话列表（IP 与设备属于私人信息）", async () => {
		await otherDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1", "203.0.113.55");
		expect((await call("/api/settings/sessions")).status).toBe(401);

		// 打开公开只读分享后，匿名访客能看总览，但会话列表依旧 401
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ publicView: true }) });
		expect((await call("/api/portfolio")).status).toBe(200);
		expect((await call("/api/settings/sessions")).status).toBe(401);
		expect((await call(`/api/settings/sessions/${"a".repeat(64)}`, { method: "DELETE" })).status).toBe(401);
	});

	it("过期的会话不出现在列表里", async () => {
		await otherDevice("Mozilla/5.0 (Linux; Android 14) Chrome/120.0", "203.0.113.99");
		await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE ip = ?`)
			.bind("2000-01-01T00:00:00.000Z", "203.0.113.99")
			.run();
		const items = await list();
		expect(items).toHaveLength(1);
		expect(items[0]?.ip).not.toBe("203.0.113.99");
	});

	it("登录历史里的密码校验照旧：换密码后其它设备会话被吊销", async () => {
		const phone = await otherDevice("Mozilla/5.0 (iPhone) Safari/605.1", "203.0.113.11");
		const params = await call<{ ok: boolean; data: { kdfSalt: string; iterations: number } }>("/api/auth/params");
		const { deriveCredential, TEST_ITERATIONS } = await import("../helpers");
		const oldCredential = await deriveCredential("test-password-123", params.body.data.kdfSalt, TEST_ITERATIONS);
		const newCredential = await deriveCredential("new-password-456", params.body.data.kdfSalt, TEST_ITERATIONS);

		const changed = await call("/api/auth/change-password", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				oldCredential,
				newCredential,
				kdfSalt: params.body.data.kdfSalt,
				iterations: TEST_ITERATIONS,
			}),
		});
		expect(changed.status).toBe(200);
		expect((await call("/api/settings", { cookie: phone })).status).toBe(401);
		// 新密码可登录
		const relogin = await login("new-password-456");
		expect(relogin.cookie).toBeTruthy();
	});
});

describe("UA 解析（纯函数）", () => {
	const cases: Array<[string, string | null, string | null]> = [
		["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1", "iPhone", "Safari"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1", "iPhone", "Chrome"],
		["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Safari/604.1", "iPad", "Safari"],
		["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36", "Android", "Chrome"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", "Mac", "Safari"],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0", "Windows", "Edge"],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0", "Windows", "Firefox"],
		["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 OPR/106.0", "Linux", "Opera"],
		["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", "ChromeOS", "Chrome"],
		["curl/8.4.0", null, null],
		["", null, null],
	];

	for (const [ua, os, browser] of cases) {
		it(`${ua.slice(0, 42) || "(空)"} → ${os ?? "?"} / ${browser ?? "?"}`, () => {
			expect(describeUserAgent(ua)).toEqual({ os, browser });
		});
	}

	it("null / undefined 也不炸（老会话可能没有 UA）", () => {
		expect(describeUserAgent(null)).toEqual({ os: null, browser: null });
		expect(describeUserAgent(undefined)).toEqual({ os: null, browser: null });
	});
});
