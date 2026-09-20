import path from "node:path";import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * 单元 / 集成测试跑在真实 workerd 运行时（不是 jsdom / node 模拟）。
 * 使用 wrangler.dev.jsonc 的绑定；本地 D1 的 migrations 由 setup 文件应用。
 */
export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
			return {
				wrangler: { configPath: "./wrangler.dev.jsonc" },
				miniflare: {
					// 测试环境使用固定 secret，避免依赖 .dev.vars
					bindings: {
						SETUP_TOKEN: "test-setup-token",
						SESSION_SECRET: "test-session-secret",
						TEST_MIGRATIONS: migrations,
					},
				},
			};
		}),
	],
	test: {
		include: ["tests/**/*.test.ts"],
		setupFiles: ["./tests/setup/apply-migrations.ts"],
	},
});
