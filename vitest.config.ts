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
						// 用"像真的"长度，避免被测代码的占位值检查拦下来
						SETUP_TOKEN: "b7f1c0d9e4a25f38c6710b4e8d92a35c7f0e1b6d4a98c2e5f3107d6b8a4c9e2f",
						SESSION_SECRET: "3a91d5c7e0b84f26a1c93d7e5b08f4a6c2e1d9b7f3058a4c6e2d1b9f7a3c5e80",
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
