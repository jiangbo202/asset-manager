import app from "./app";
import type { Env } from "./types";

/**
 * Worker 入口
 *
 * fetch     → Hono 应用（/api/*）+ 静态资源（由 assets 层先处理）
 * scheduled → v1 不使用 Cron（走势图与每日快照在 TODO，见 PRD D3）；
 *             这里保留入口，v2 接入行情与快照时直接用
 */
export default {
	fetch: app.fetch,

	async scheduled(event, env, ctx) {
		void env;
		void ctx;
		console.log("[scheduled] v1 暂未启用定时任务", event.cron);
	},
} satisfies ExportedHandler<Env>;
