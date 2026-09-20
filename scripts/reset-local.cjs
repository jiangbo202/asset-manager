#!/usr/bin/env node
/** 清空本地开发数据并重新应用迁移（不影响线上数据） */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, ".wrangler", "state");

if (fs.existsSync(STATE_DIR)) {
	fs.rmSync(STATE_DIR, { recursive: true, force: true });
	console.log("[db:reset:local] 已删除本地状态目录 .wrangler/state");
} else {
	console.log("[db:reset:local] 本地状态目录不存在，跳过删除");
}

execFileSync("npm", ["run", "db:migrate:local"], { cwd: ROOT, stdio: "inherit" });
console.log("[db:reset:local] 完成 ✅ 本地数据库已重建");
