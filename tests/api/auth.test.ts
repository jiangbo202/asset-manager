import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, call, clearAll, deriveCredential, randomSaltHex, TEST_ITERATIONS } from "../helpers";

describe("认证流程（setup / login / 限流 / 改密码）", () => {
	beforeEach(async () => {
		await clearAll();
	});

	it("未初始化时拒绝业务接口，并可通过 setup token 完成初始化", async () => {
		const me = await call<{ data: { initialized: boolean } }>("/api/auth/me");
		expect(me.status).toBe(200);
		expect(me.body.data.initialized).toBe(false);

		const guarded = await call("/api/accounts");
		expect(guarded.status).toBe(503);

		const wrongToken = await call("/api/auth/setup", {
			method: "POST",
			body: JSON.stringify({
				setupToken: "wrong-token",
				credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
				kdfSalt: randomSaltHex(),
				iterations: TEST_ITERATIONS,
			}),
		});
		expect(wrongToken.status).toBe(401);

		const { cookie } = await bootstrap();
		expect(cookie).toContain("am_session=");

		const after = await call<{ data: { initialized: boolean; authenticated: boolean } }>("/api/auth/me", { cookie });
		expect(after.body.data.initialized).toBe(true);
		expect(after.body.data.authenticated).toBe(true);
	});

	it("初始化只能成功一次（第二次 409）", async () => {
		await bootstrap();
		const again = await call("/api/auth/setup", {
			method: "POST",
			body: JSON.stringify({
				setupToken: "test-setup-token",
				credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
				kdfSalt: randomSaltHex(),
				iterations: TEST_ITERATIONS,
			}),
		});
		expect(again.status).toBe(409);
	});

	it("密码错误会累计失败次数，达到 5 次后锁定", async () => {
		await bootstrap("correct-password-123");

		const params = await call<{ data: { kdfSalt: string; iterations: number } }>("/api/auth/params");
		const salt = params.body.data.kdfSalt;
		const badCredential = await deriveCredential("wrong-password-123", salt, params.body.data.iterations);

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const response = await call("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ credential: badCredential }),
			});
			expect(response.status).toBe(401);
		}

		const locked = await call("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ credential: badCredential }),
		});
		expect(locked.status).toBe(429);
	});

	it("改密码后旧密码失效、新密码可用，且吊销其他会话", async () => {
		const { cookie, kdfSalt } = await bootstrap("old-password-1234");

		const newSalt = randomSaltHex();
		const oldCredential = await deriveCredential("old-password-1234", kdfSalt, TEST_ITERATIONS);
		const newCredential = await deriveCredential("new-password-1234", newSalt, TEST_ITERATIONS);

		const changed = await call("/api/auth/change-password", {
			method: "POST",
			cookie,
			body: JSON.stringify({ oldCredential, newCredential, kdfSalt: newSalt, iterations: TEST_ITERATIONS }),
		});
		expect(changed.status).toBe(200);

		// 旧 cookie 已被吊销
		const stale = await call("/api/accounts", { cookie });
		expect(stale.status).toBe(401);

		// 旧密码登录失败，新密码成功
		const params = await call<{ data: { kdfSalt: string; iterations: number } }>("/api/auth/params");
		const oldLogin = await call("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({
				credential: await deriveCredential("old-password-1234", params.body.data.kdfSalt, params.body.data.iterations),
			}),
		});
		expect(oldLogin.status).toBe(401);

		const newLogin = await call("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({
				credential: await deriveCredential("new-password-1234", params.body.data.kdfSalt, params.body.data.iterations),
			}),
		});
		expect(newLogin.status).toBe(200);
	});
});
