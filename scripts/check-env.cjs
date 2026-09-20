#!/usr/bin/env node
/**
 * 环境体检（predev / prebuild / pretest 自动执行）
 *
 * 针对两类真实踩过的坑：
 *
 * 1. **平台二进制不匹配**
 *    在 Apple Silicon 上，如果 node_modules 是用 x64 的 node（Rosetta/homebrew）装的，
 *    而运行时用的是 arm64 的 node，workerd 会抛出一大段 "You installed workerd on
 *    another platform" 的堆栈；esbuild / rolldown 也会以难懂的方式失败。
 * 2. **目录属主不对**
 *    如果有人用 sudo（或别的用户）跑过 install/build，dist/ 与 node_modules/ 里会留下
 *    不属于当前用户的文件，之后构建报 ENOTEMPTY / EACCES。
 *
 * 这个脚本只做检查与提示，不修改任何东西。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const errors = [];
const warnings = [];

/* ── 1. Node 版本 ───────────────────────────────────────── */
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
	errors.push(`Node ${process.version} 太旧，需要 20 / 22 / 24（推荐 24 LTS）`);
} else if (major % 2 === 1) {
	warnings.push(
		`Node ${process.version} 是奇数版本，Wrangler 与 Vitest 官方支持 ^20 || ^22 || >=24；建议 nvm use`,
	);
}
try {
	const nvmrc = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
	if (nvmrc && !process.versions.node.startsWith(`${nvmrc}.`)) {
		warnings.push(`仓库要求 Node ${nvmrc}（见 .nvmrc），当前 ${process.version}；建议 nvm use`);
	}
} catch {
	/* 没有 .nvmrc 就跳过 */
}

/* ── 2. 平台二进制是否匹配 ──────────────────────────────── */
// workerd 的包名把 x64 写成 64：darwin-arm64 / darwin-64
const workerdArch = process.arch === "arm64" ? "arm64" : "64";
const expectedWorkerd = `workerd-${process.platform}-${workerdArch}`;
const cloudflareDir = path.join(ROOT, "node_modules", "@cloudflare");
if (fs.existsSync(cloudflareDir)) {
	const installed = fs.readdirSync(cloudflareDir).filter((name) => name.startsWith("workerd-"));
	if (installed.length > 0 && !installed.includes(expectedWorkerd)) {
		errors.push(
			[
				`node_modules 里的 workerd 是 [${installed.join(", ")}]，但当前 node 需要 ${expectedWorkerd}`,
				`当前 node：${process.version}（${process.platform}-${process.arch}）→ ${process.execPath}`,
				"两种可能，按顺序排查：",
				"  1) 你换了另一个架构的 node（例如 Apple Silicon 上从 x64 的 node 切到 nvm 的 arm64 node）",
				"     → 先确认用的是哪个 node，建议 `nvm use`（版本见 .nvmrc）后重试，不要急着重装依赖",
				"  2) 依赖确实是用别的架构装的",
				"     → rm -rf node_modules && npm install",
			].join("\n    "),
		);
	}
}

/* ── 3. 目录属主（仅类 Unix） ───────────────────────────── */
if (process.platform !== "win32" && typeof process.getuid === "function") {
	const uid = process.getuid();
	const suspects = ["node_modules", "dist", ".wrangler"];
	const bad = [];
	for (const name of suspects) {
		const target = path.join(ROOT, name);
		if (!fs.existsSync(target)) continue;
		try {
			if (fs.statSync(target).uid !== uid) bad.push(name);
		} catch {
			/* 忽略 */
		}
	}
	// 仓库自己的文件也查一遍：多次出现"某个文件是用别的用户（sudo/root）写的，
	// 之后脚本改不动它、报 EACCES"的情况，根目录的 README 就踩过。
	const SKIP = new Set(["node_modules", ".git", "dist", ".wrangler", ".vite"]);
	const foreign = [];
	const walk = (dir, depth) => {
		if (depth > 4 || foreign.length > 5) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIP.has(entry.name)) continue;
			const target = path.join(dir, entry.name);
			try {
				if (fs.statSync(target).uid !== uid) {
					foreign.push(path.relative(ROOT, target));
					continue;
				}
			} catch {
				continue;
			}
			if (entry.isDirectory()) walk(target, depth + 1);
		}
	};
	try {
		if (fs.statSync(ROOT).uid === uid) walk(ROOT, 0);
	} catch {
		/* 忽略 */
	}

	if (foreign.length > 0) {
		errors.push(
			[
				`这些文件不属于当前用户（${process.env.USER ?? uid}）：${foreign.slice(0, 5).join("、")}${foreign.length > 5 ? " …" : ""}`,
				"常见原因：用 sudo 或别的用户跑过命令或写入过文件，之后脚本会报 EACCES。修法：",
				`  sudo chown -R $(whoami) ${foreign.length > 0 ? "..." : ""}`.replace(" ...", " ."),
			].join("\n    "),
		);
	}

	if (bad.length > 0) {
		errors.push(
			[
				`这些目录不属于当前用户（${process.env.USER ?? uid}）：${bad.join(", ")}`,
				"常见原因：用 sudo 或别的用户跑过 npm install / npm run build，之后会报 ENOTEMPTY 或 EACCES。修法：",
				`  sudo chown -R $(whoami) ${bad.join(" ")}`,
			].join("\n    "),
		);
	}
}

/* ── 输出 ───────────────────────────────────────────────── */
if (warnings.length > 0) {
	for (const warning of warnings) console.warn(`[env] ⚠️  ${warning}`);
}

if (errors.length > 0) {
	console.error("[env] 环境检查未通过：");
	for (const error of errors) console.error(`  ✗ ${error}`);
	process.exit(1);
}

console.log(`[env] 环境正常 ✅ node ${process.version} (${process.platform}-${process.arch})`);
