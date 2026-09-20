#!/usr/bin/env node
/**
 * 脚本接线检查（静态，不执行任何部署）
 *
 * 起因：deploy:safe 里曾把 `wrangler whoami` 写成 `npm wrangler whoami`
 * （wrangler 是本地依赖，不是 npm 命令），用户跑到第一步就报
 * "Unknown command: wrangler"。这种错在本地无法通过类型检查发现，
 * 所以这里做静态校验：
 *   1. scripts/*.cjs 里引用的 npm script 必须存在
 *   2. deploy:safe 的每一步都必须走 `npm run`（不能把本地二进制当 npm 命令）
 *   3. 文档里写的 `npm run xxx` 必须存在（防止文档与实现漂移）
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const scripts = new Set(Object.keys(pkg.scripts ?? {}));

const problems = [];
const note = (message) => problems.push(message);

/** 扫描前去掉注释，避免"文档式注释里的示例命令"被误判 */
const stripComments = (text) =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* 1. scripts/*.cjs 里的引用 */
const scriptFiles = fs.readdirSync(path.join(ROOT, "scripts")).filter((file) => file.endsWith(".cjs"));
for (const file of scriptFiles) {
	const content = stripComments(fs.readFileSync(path.join(ROOT, "scripts", file), "utf8"));
	for (const match of content.matchAll(/\[\s*"run"\s*,\s*"([^"]+)"/g)) {
		if (!scripts.has(match[1])) note(`${file} → npm run ${match[1]}（脚本不存在）`);
	}
	for (const match of content.matchAll(/npm run ([\w:.-]+)/g)) {
		if (!scripts.has(match[1])) note(`${file} → npm run ${match[1]}（脚本不存在）`);
	}
}

/* 2. 部署流程的每一步 */
const deploySafe = fs.readFileSync(path.join(ROOT, "scripts", "deploy-safe.cjs"), "utf8");
const steps = [...deploySafe.matchAll(/\["([^"]+)",\s*\[([^\]]+)\]/g)];
if (steps.length < 6) note(`deploy-safe.cjs 的步骤数异常（${steps.length}），预期至少 6 步`);
for (const [, label, args] of steps) {
	if (!args.includes('"run"')) {
		note(`deploy-safe.cjs 步骤「${label}」没有通过 npm run 执行：[${args}]`);
		continue;
	}
	const script = args.match(/"run",\s*"([^"]+)"/)?.[1];
	if (!script || !scripts.has(script)) note(`deploy-safe.cjs 步骤「${label}」引用了不存在的脚本 ${script}`);
}
// 脚本文件里不能出现 ["wrangler", ...] 这种"把本地二进制当 npm 命令"的写法
for (const file of scriptFiles) {
	if (file === "setup-d1.cjs" || file === "setup-secrets.cjs") continue; // 这两个用 npx，是允许的
	const content = stripComments(fs.readFileSync(path.join(ROOT, "scripts", file), "utf8"));
	if (/\[\s*"wrangler"\s*,/.test(content)) {
		note(`${file} 把 wrangler 当 npm 命令传递了（应改用 npm run 或 npx）`);
	}
}

/* 3. 文档里的命令 */
const docs = [
	"README.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	...fs
		.readdirSync(path.join(ROOT, "docs"))
		.filter((file) => file.endsWith(".md"))
		.map((file) => `docs/${file}`),
];
for (const file of docs) {
	const content = fs.readFileSync(path.join(ROOT, file), "utf8");
	for (const match of content.matchAll(/npm run ([\w:.-]+)/g)) {
		if (!scripts.has(match[1])) note(`${file} → npm run ${match[1]}（脚本不存在）`);
	}
}

/* 4. 关键脚本齐备 */
const required = [
	"dev", "build", "preview", "lint", "test", "verify", "check:bundle", "check:scripts",
	"check:auth", "setup:d1", "setup:secrets", "setup:repo",
	"deploy", "deploy:worker", "deploy:safe",
	"db:migrate:local", "db:migrate:remote", "db:reset:local", "db:seed:local",
];
for (const name of required) {
	if (!scripts.has(name)) note(`package.json 缺少脚本 ${name}`);
}

if (problems.length > 0) {
	console.error("[scripts] 发现问题：");
	for (const problem of problems) console.error(`  ✗ ${problem}`);
	process.exit(1);
}
console.log(`[scripts] 接线检查通过 ✅（${scriptFiles.length} 个脚本文件、${steps.length} 个部署步骤、${docs.length} 个文档）`);
