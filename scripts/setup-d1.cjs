#!/usr/bin/env node
/**
 * 自动创建 / 复用 D1 数据库，并把 database_id 写回 wrangler.jsonc
 *
 * 设计参考：SubsTracker 的 scripts/setup-kv.cjs（同样的"查重 → 创建 → 注入 id"思路）
 * 与 KV 的差异：D1 还需要在部署前执行 migrations，这一步在 deploy:safe 里做。
 *
 * 幂等：重复执行不会重复建库，也不会重复改配置。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_ID";

function log(message) {
	console.log(`[setup-d1] ${message}`);
}

function fail(message) {
	console.error(`[setup-d1] 失败：${message}`);
	process.exit(1);
}

function wrangler(args, options = {}) {
	return execFileSync("npx", ["wrangler", ...args], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

function readConfig() {
	if (!fs.existsSync(CONFIG_PATH)) fail("找不到 wrangler.jsonc，请在项目根目录执行");
	return fs.readFileSync(CONFIG_PATH, "utf8");
}

function parseWorkerName(config) {
	const match = config.match(/"name"\s*:\s*"([^"]+)"/);
	return match ? match[1] : "asset-manager";
}

function parseDatabaseName(config) {
	const match = config.match(/"database_name"\s*:\s*"([^"]+)"/);
	return match ? match[1] : "asset-manager-db";
}

function listDatabases() {
	try {
		const output = wrangler(["d1", "list", "--json"]);
		const start = output.indexOf("[");
		const end = output.lastIndexOf("]");
		if (start === -1 || end === -1) return [];
		const parsed = JSON.parse(output.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		const message = String(error.stderr || error.message || error);
		if (
			message.includes("authenticated") ||
			message.includes("10000") ||
			message.includes("CLOUDFLARE_API_TOKEN") ||
			message.includes("non-interactive")
		) {
			fail(
				"未登录 Cloudflare。请先执行 `npx wrangler login`，或设置 CLOUDFLARE_API_TOKEN 环境变量\n" +
					"        （Token 需要 Workers 编辑 + D1 编辑 权限）",
			);
		}
		fail(`无法列出现有 D1 数据库：${message.trim()}`);
	}
}

/** 允许用户的库名带 worker 前缀（wrangler 有时会这样命名），只匹配当前项目，避免误用别人的库 */
function findDatabase(databases, databaseName, workerName) {
	const candidates = new Set([databaseName, `${workerName}-${databaseName}`, databaseName.replace(/-db$/, "")]);
	return databases.find((item) => candidates.has(item.name));
}

function createDatabase(databaseName) {
	log(`数据库 ${databaseName} 不存在，开始创建…`);
	const output = wrangler(["d1", "create", databaseName]);
	const match = output.match(/database_id\s*=\s*"([^"]+)"/) || output.match(/"database_id"\s*:\s*"([^"]+)"/);
	if (!match) {
		fail(`创建成功但没能从输出里解析出 database_id，请手动把 id 填进 wrangler.jsonc。原始输出：\n${output}`);
	}
	return match[1];
}

function writeDatabaseId(config, databaseId) {
	// 用正则替换而不是 JSON.parse，避免丢掉 jsonc 里的注释
	const pattern = /("database_id"\s*:\s*")[^"]*(")/;
	if (!pattern.test(config)) fail("wrangler.jsonc 里找不到 database_id 字段");
	const next = config.replace(pattern, `$1${databaseId}$2`);
	fs.writeFileSync(CONFIG_PATH, next, "utf8");
	log(`已把 database_id=${databaseId} 写入 wrangler.jsonc`);
}

function main() {
	const config = readConfig();
	const workerName = parseWorkerName(config);
	const databaseName = parseDatabaseName(config);
	const current = config.match(/"database_id"\s*:\s*"([^"]*)"/)?.[1];

	const databases = listDatabases();
	const existing = findDatabase(databases, databaseName, workerName);

	let databaseId;
	if (existing) {
		log(`复用已有数据库：${existing.name} (${existing.uuid})`);
		databaseId = existing.uuid;
	} else {
		databaseId = createDatabase(databaseName);
	}

	if (current === databaseId) {
		log("wranger.jsonc 已是最新，无需修改");
	} else {
		writeDatabaseId(config, databaseId);
	}

	log(`完成 ✅  数据库=${databaseName}  worker=${workerName}`);
	if (current === PLACEHOLDER) log("（首次运行已替换占位 id）");
}

main();
