#!/usr/bin/env node
/**
 * 把文档与 issue 模板里的仓库地址替换成你自己的 GitHub 账号。
 *
 * 用法：
 *   npm run setup:repo -- your-github-name
 *   npm run setup:repo -- your-github-name my-fork-name   # 改仓库名时
 *   npm run setup:repo                                    # 不给名字时，从 git remote 推断
 *
 * 会替换两种写法：
 *   github.com/USERNAME/asset-manager   —— 上游还没被替换过的占位符
 *   github.com/jiangbo202/asset-manager —— 上游已经替换过的真实地址（fork 场景）
 * 早先只认第一种，而本仓库早就替换成真实地址了，导致 fork 用户跑这个命令等于没跑。
 *
 * 只改文档里的仓库地址引用，不动代码。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const TARGETS = [
	"README.md",
	"README.en.md",
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

/** 正则里要用到的转义（owner 里可能有连字符，虽然安全，但保持通用） */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 git remote 猜测当前仓库的 owner/repo（fork 用户会得到自己的账号） */
function detectRemote() {
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
		const match = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
		return match ? { owner: match[1], repo: match[2] } : null;
	} catch {
		return null;
	}
}

function main() {
	const detected = detectRemote();
	const owner = (process.argv[2] ?? detected?.owner ?? "").trim();
	const repo = (process.argv[3] ?? detected?.repo ?? "asset-manager").trim();
	const previousOwner = process.env.PREVIOUS_REPO_OWNER ?? "jiangbo202";
	const previousRepo = process.env.PREVIOUS_REPO_NAME ?? "asset-manager";

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
		// 只改 github.com/<owner>/<repo> 形式的引用，避免误伤其它链接
		// （文档里还有别的 github.com 链接，例如 cloudflare/workers-sdk）。
		// 旧 owner 既可能是没替换过的占位符，也可能是上游的真实账号。
		const pattern = new RegExp(
			`github\\.com/(?:USERNAME|${escapeRegExp(previousOwner)})/(?:${escapeRegExp(previousRepo)})(?=$|[^\\w-])`,
			"g",
		);
		const after = before.replace(pattern, `github.com/${owner}/${repo}`);
		if (after !== before) {
			const count = (before.match(pattern) ?? []).length;
			try {
				fs.writeFileSync(file, after, "utf8");
			} catch (error) {
				console.error(`\n无法写入 ${relative}：${error.code ?? error.message}`);
				console.error("常见原因：这个文件由别的用户（sudo/root）创建，当前用户没有写权限。");
				console.error(`修法：sudo chown -R $(whoami) .   # 或先跑 npm run check:env 看完整清单`);
				process.exit(1);
			}
			touched += 1;
			replaced += count;
			console.log(`  已更新 ${relative}（${count} 处）`);
		}
	}

	if (touched === 0) {
		console.log(`没有需要替换的仓库地址（文档里已经是 ${owner}/${repo}）`);
		return;
	}
	console.log(`\n完成：${touched} 个文件、${replaced} 处占位符 → ${owner}/${repo}`);
	console.log("接下来：");
	console.log("  git add -A && git commit -m \"chore: 指向自己的仓库地址\"");
	console.log(`  git remote add origin git@github.com:${owner}/${repo}.git`);
	console.log("  git push -u origin main");
}

main();
