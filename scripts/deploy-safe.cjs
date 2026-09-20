#!/usr/bin/env node
/**
 * 一条命令部署：创建 D1 → 应用迁移 → 构建 → 部署 → 写入 secrets → 打印下一步
 *
 * 顺序说明：
 *   1. setup:d1 先跑，因为后面的迁移与构建都要用真实的 database_id
 *   2. build 必须在上一步之后，Vite 插件会把配置一起输出到 dist
 *   3. secret put 必须在 deploy 之后（Worker 需要已存在）
 */
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const steps = [
	["检查登录状态", ["wrangler", "whoami"]],
	["创建 / 复用 D1 数据库", ["run", "setup:d1"]],
	["构建前端与 Worker", ["run", "build"]],
	["应用 D1 迁移（远程）", ["run", "db:migrate:remote"]],
	["部署 Worker", ["wrangler", "deploy"]],
	["写入 SETUP_TOKEN / SESSION_SECRET", ["run", "setup:secrets"]],
];

function run(label, args) {
	console.log(`\n▶ ${label}`);
	try {
		execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
	} catch (error) {
		console.error(`\n✗ 「${label}」失败，已中止。`);
		console.error("  常见原因：未登录（npx wrangler login）、API Token 权限不足、网络问题。");
		process.exit(1);
	}
}

console.log("部署到 Cloudflare Workers");
for (const [label, args] of steps) run(label, args);

console.log(`
✅ 部署完成

下一步：
  1. 打开终端上方打印的 workers.dev 网址（或你的自定义域名）
  2. 粘贴上面显示的 SETUP TOKEN
  3. 设置你自己的登录密码 → 开始记账

常用命令：
  npm run dev              本地开发（数据存在 .wrangler/state，不消耗线上额度）
  npm run db:migrate:local 给本地数据库应用迁移
  npm run db:seed:local    插入一批示例数据方便调试
  npm run db:reset:local   清空本地数据并重新迁移
`);
