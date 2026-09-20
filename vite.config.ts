import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		cloudflare({
			// 本地开发用 dev 配置（D1 id 固定，数据落在 .wrangler/state，不受 setup:d1 影响）
			// 构建/预览用生产配置
			configPath: mode === "development" ? "./wrangler.dev.jsonc" : "./wrangler.jsonc",
		}),
	],
	build: {
		// 前端产物预算：见 docs/PRD.md §15（目标 ≤150KB gzip）
		chunkSizeWarningLimit: 700,
	},
}));
