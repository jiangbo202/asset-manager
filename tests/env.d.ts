import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/worker/types";

/**
 * 把 Worker 绑定类型注入到 `cloudflare:test` 的 `env`
 * （新版本用全局 `Cloudflare.Env` 命名空间，而不是旧的 ProvidedEnv）
 */
declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

export {};
