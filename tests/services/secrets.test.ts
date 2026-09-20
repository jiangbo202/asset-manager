import { describe, expect, it } from "vitest";
import { checkDeploymentSecrets, isPlaceholderSecret } from "../../src/worker/core/secrets";

/**
 * 一键部署向导会让用户直接编辑 `.dev.vars.example` 里的值，而那个文件是公开的。
 * 如果有人直接沿用示例占位值，任何知道这个仓库的人都能初始化他的部署 ——
 * 所以这里把各种"看起来像密钥但其实是公开值"的情况都钉住。
 */
describe("部署密钥检查", () => {
	it("识别仓库里公开出现过的占位值", () => {
		expect(isPlaceholderSecret("dev-setup-token-please-change")).toBe(true);
		expect(isPlaceholderSecret("dev-session-secret-please-change")).toBe(true);
		expect(isPlaceholderSecret("dev-setup-token-local-only")).toBe(true);
		expect(isPlaceholderSecret("test-setup-token")).toBe(true);
		expect(isPlaceholderSecret("changeme")).toBe(true);
		expect(isPlaceholderSecret("  CHANGE-ME  ")).toBe(true);
		expect(isPlaceholderSecret("")).toBe(false);
		expect(isPlaceholderSecret(null)).toBe(false);
		// 真随机值不应被误判
		expect(isPlaceholderSecret("b7f1c0d9e4a25f38c6710b4e8d92a35c7f0e1b6d4a98c2e5f3107d6b8a4c9e2f")).toBe(false);
	});

	const strong = {
		SETUP_TOKEN: "b7f1c0d9e4a25f38c6710b4e8d92a35c7f0e1b6d4a98c2e5f3107d6b8a4c9e2f",
		SESSION_SECRET: "3a91d5c7e0b84f26a1c93d7e5b08f4a6c2e1d9b7f3058a4c6e2d1b9f7a3c5e80",
	};

	it("两个强随机密钥通过", () => {
		expect(checkDeploymentSecrets(strong)).toEqual({ ok: true });
	});

	it("缺 SETUP_TOKEN 或太短 → setup_token_missing", () => {
		expect(checkDeploymentSecrets({ SESSION_SECRET: strong.SESSION_SECRET })).toMatchObject({
			ok: false,
			code: "setup_token_missing",
		});
		expect(checkDeploymentSecrets({ ...strong, SETUP_TOKEN: "short" })).toMatchObject({
			ok: false,
			code: "setup_token_missing",
		});
	});

	it("沿用示例占位 SETUP_TOKEN → setup_token_placeholder", () => {
		for (const value of [
			"dev-setup-token-please-change",
			"dev-setup-token-local-only",
			"test-setup-token",
			"changeme",
		]) {
			expect(checkDeploymentSecrets({ ...strong, SETUP_TOKEN: value }), value).toMatchObject({
				ok: false,
				code: "setup_token_placeholder",
			});
		}
	});

	it("SESSION_SECRET 太短或占位 → session_secret_weak", () => {
		expect(checkDeploymentSecrets({ ...strong, SESSION_SECRET: "short" })).toMatchObject({
			ok: false,
			code: "session_secret_weak",
		});
		expect(
			checkDeploymentSecrets({ ...strong, SESSION_SECRET: "dev-session-secret-please-change" }),
		).toMatchObject({ ok: false, code: "session_secret_weak" });
	});
});
