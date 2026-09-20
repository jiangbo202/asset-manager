import { applyD1Migrations, env } from "cloudflare:test";

// 每个测试文件运行前，把 migrations/ 下的 SQL 应用到测试用 D1
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
