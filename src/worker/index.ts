import app from "./app";
import type { Env } from "./types";
import { handleCron } from "./services/scheduler";

/**
 * Worker 入口
 *
 * fetch     → Hono 应用（/api/*）+ 静态资源（由 assets 层先处理）
 * scheduled → 每小时一次（wrangler.jsonc 的 triggers.crons）：
 *             在配置的小时内"刷新行情 → 打每日快照"，其余小时直接返回
 */
export default {
	fetch: app.fetch,

	async scheduled(event, env, ctx) {
		ctx.waitUntil(
			handleCron(env)
				.then((result) => {
					console.log("[scheduled]", event.cron, JSON.stringify(result));
				})
				.catch((error: unknown) => {
					console.error("[scheduled] 失败:", error instanceof Error ? error.stack : error);
				}),
		);
	},
} satisfies ExportedHandler<Env>;
