#!/usr/bin/env node
/**
 * 前端首包体积护栏（CI 里跑）
 *
 * 背景：这是个人自用应用，静态资源虽然不消耗 Cloudflare CPU 与请求额度，
 * 但首包越大 → 移动端打开越慢。历史上曾出现 ECharts 把首包从 80KB 推到 244KB 的情况，
 * 所以这里做一条硬线：主 chunk 超过预算就让 CI 失败。
 *
 * 预算：
 *   主 chunk（首屏必须加载的 JS）≤ 110 KB gzip
 *   全部 JS 合计               ≤ 160 KB gzip（含按需加载的分包）
 * 调整预算时请同时更新 README 与 docs/ARCHITECTURE.md 里的数字。
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const CLIENT_DIR = path.join(process.cwd(), "dist", "client");
const MAIN_BUDGET_KB = 110;
const TOTAL_BUDGET_KB = 160;

function walk(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
	});
}

function gzipKb(file) {
	return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length / 1024;
}

const files = walk(CLIENT_DIR);
if (files.length === 0) {
	console.error(`[bundle] 找不到构建产物（${CLIENT_DIR}），请先执行 npm run build`);
	process.exit(1);
}

const measured = files
	.map((file) => ({ file: path.relative(CLIENT_DIR, file), kb: gzipKb(file) }))
	.sort((a, b) => b.kb - a.kb);

// 入口 chunk 的特征：文件名形如 assets/index-<hash>.js
const main = measured.find((item) => /(^|\/)index-.*\.js$/.test(item.file)) ?? measured[0];
const total = measured.reduce((sum, item) => sum + item.kb, 0);

console.log("[bundle] 前端产物（gzip）");
for (const item of measured) console.log(`  ${item.kb.toFixed(2).padStart(7)} KB  ${item.file}`);
console.log(`  首包 ${main.kb.toFixed(2)} KB / 预算 ${MAIN_BUDGET_KB} KB（${main.file}）`);
console.log(`  合计 ${total.toFixed(2)} KB / 预算 ${TOTAL_BUDGET_KB} KB`);

const failures = [];
if (main.kb > MAIN_BUDGET_KB) failures.push(`首包 ${main.kb.toFixed(2)} KB 超过预算 ${MAIN_BUDGET_KB} KB`);
if (total > TOTAL_BUDGET_KB) failures.push(`合计 ${total.toFixed(2)} KB 超过预算 ${TOTAL_BUDGET_KB} KB`);

if (failures.length > 0) {
	console.error("\n[bundle] 未通过：");
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	console.error("\n可选做法：把大依赖改成动态 import（参考 src/web/App.tsx 里页面懒加载的写法），");
	console.error("或确认确实需要后，在 scripts/check-bundle.cjs 与文档里同步上调预算。");
	process.exit(1);
}

console.log("[bundle] 通过 ✅");
