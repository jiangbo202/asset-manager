#!/usr/bin/env node
/**
 * 把文档与 issue 模板里的 USERNAME 占位符替换成你自己的 GitHub 账号。
 *
 * 用法：
 *   npm run setup:repo -- your-github-name
 *   npm run setup:repo -- your-github-name my-fork-name   # 改仓库名时
 *
 * 只改文本里的 github.com/USERNAME/asset-manager 这类引用，不动代码。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const TARGETS = [
	"README.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	".github/ISSUE_TEMPLATE/bug_report.yml",
	".github/ISSUE_TEMPLATE/feature_request.yml",
	".github/ISSUE_TEMPLATE/config.yml",
	".github/pull_request_template.md",
	"docs/PRD.md",
	"docs/ARCHITECTURE.md",
	"docs/DEPLOYMENT.md",
];

function main() {
	const owner = (process.argv[2] ?? "").trim();
	const repo = (process.argv[3] ?? "asset-manager").trim();

	if (!owner) {
		console.error("用法：npm run setup:repo -- <github 用户名> [仓库名]");
		console.error("例如：npm run setup:repo -- jiangbo asset-manager");
		process.exit(1);
	}
	if (!/^[A-Za-z0-9-]+$/.test(owner)) {
		console.error(`用户名不合法：${owner}（只允许字母、数字、连字符）`);
		process.exit(1);
	}

	let touched = 0;
	let replaced = 0;
	for (const relative of TARGETS) {
		const file = path.join(ROOT, relative);
		if (!fs.existsSync(file)) continue;
		const before = fs.readFileSync(file, "utf8");
		// 只替换 URL / 路径中的占位符，避免误伤其它文本
		const after = before
			.replaceAll("USERNAME/asset-manager", `${owner}/${repo}`)
			.replaceAll("github.com/USERNAME", `github.com/${owner}`);
		if (after !== before) {
			const count = (before.match(/USERNAME/g) ?? []).length;
			fs.writeFileSync(file, after, "utf8");
			touched += 1;
			replaced += count;
			console.log(`  已更新 ${relative}（${count} 处）`);
		}
	}

	if (touched === 0) {
		console.log("没有找到 USERNAME 占位符（可能已经替换过了）");
		return;
	}
	console.log(`\n完成：${touched} 个文件、${replaced} 处占位符 → ${owner}/${repo}`);
	console.log("接下来：");
	console.log("  git add -A && git commit -m \"chore: 指向自己的仓库地址\"");
	console.log(`  git remote add origin git@github.com:${owner}/${repo}.git`);
	console.log("  git push -u origin main");
}

main();
