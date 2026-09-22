#!/usr/bin/env node
/**
 * 从上游模板仓库更新你自己的副本（一键部署出来的那些人用这个）
 *
 * 背景：`Deploy to Cloudflare` 按钮是**在你点击那一刻复制一份仓库**给你，
 * 之后上游的修复（bug、新功能、迁移）不会自动流过去 —— 这是所有"模板/脚手架"的固有行为。
 * 想跟进就得显式把上游合并进来。
 *
 * 用法：
 *   npm run update:upstream                       # 上游地址取自 package.json 的 repository
 *   npm run update:upstream -- https://github.com/xxx/yyy.git
 *   npm run update:upstream -- --yes              # 历史不相关时自动对齐（不询问）
 *
 * 它做的事：检查工作区干净 → 加/更新 upstream remote → fetch → 列出将要合并的提交 →
 * 合并 upstream/main。若只冲突在 wrangler.jsonc（你填了真实 D1 id，上游是占位值），
 * 自动保留你的版本；其它冲突原样停下，交给你处理。
 *
 * 不会碰你的数据库数据：迁移只是建表/改表结构，且由部署流程执行。
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const PLACEHOLDER_D1_ID = "REPLACE_WITH_YOUR_D1_ID";

const git = (args, options = {}) =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "pipe" });

const tryGit = (args) => {
	try {
		return { ok: true, output: git(args, { quiet: true }) };
	} catch (error) {
		const stderr = error.stderr ? String(error.stderr) : String(error.message ?? "");
		return { ok: false, output: stderr };
	}
};

const log = (message) => console.log(`[update] ${message}`);
const fail = (message, hint) => {
	console.error(`\n[update] ✗ ${message}`);
	if (hint) console.error(hint.split("\n").map((line) => `  ${line}`).join("\n"));
	process.exit(1);
};

/** 读取工作区 wrangler.jsonc 里的 database_id（对齐后要把它写回去） */
function readDatabaseId() {
	try {
		const config = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
		return config.match(/"database_id"\s*:\s*"([^"]*)"/)?.[1] ?? "";
	} catch {
		return "";
	}
}

function writeDatabaseId(id) {
	const file = path.join(ROOT, "wrangler.jsonc");
	const config = fs.readFileSync(file, "utf8");
	const next = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
	if (next === config) return false;
	fs.writeFileSync(file, next, "utf8");
	return true;
}

/** 交互确认（--yes 直接同意；只在真终端里问；管道 / CI 里给命令让用户自己跑） */
function ask(question) {
	if (process.argv.includes("--yes") || process.argv.includes("-y")) return Promise.resolve("y");
	if (!process.stdin.isTTY) return Promise.resolve("");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => {
		rl.close();
		resolve(answer.trim().toLowerCase());
	}));
}

/**
 * 两边历史不相关时的一次性对齐
 *
 * 一键部署用的是「模板复制」（新仓库 + 初始提交），不是 fork，所以两边**没有共同祖先**，
 * `git merge` 会直接以 `fatal: refusing to merge unrelated histories` 拒绝。
 * 对齐一次之后就有了共同祖先，以后 `npm run update:upstream` 就是普通合并了。
 *
 * 用 `-X theirs`：新旧代码有重叠的文件以上游为准（这正是"更新到上游"的本意），
 * **你独有的改动不受影响**（上游没碰过的文件保持原样）；之后再把 database_id 写回。
 */
async function alignUnrelatedHistories(upstream) {
	const localId = readDatabaseId();
	const diff = tryGit(["diff", "--name-only", "HEAD", "upstream/main"]);
	const files = diff.ok ? diff.output.trim().split("\n").filter(Boolean) : [];

	log("检测到两边历史不相关 —— 一键部署是「模板复制」（新仓库 + 初始提交），不是 fork，");
	log("所以没有共同祖先，git 默认拒绝合并。这需要**一次性对齐**，之后就正常了。");
	if (files.length > 0) {
		log(`两边有 ${files.length} 个文件不同，下面这些会以上游版本为准（前 20 个）：`);
		for (const file of files.slice(0, 20)) console.log(`         ${file}`);
		if (files.length > 20) console.log(`         …还有 ${files.length - 20} 个`);
	}
	console.log(`
[update] 对齐命令（会保留你的 database_id${localId ? ` = ${localId.slice(0, 8)}…` : ""}）：
    git merge --allow-unrelated-histories -X theirs upstream/main
    # 上面的合并会把 database_id 变成上游的占位值，写回自己的：
    #   （手动改 wrangler.jsonc，或用脚本：npm run update:upstream 会问你）
    git push
[update] 如果你**改过代码**，别用 -X theirs：先跑普通的
    git merge --allow-unrelated-histories upstream/main
  然后逐个文件看冲突再决定（git status 会列出冲突文件）。`);

	const answer = await ask("[update] 现在自动对齐吗？（会用上游版本覆盖同名文件的改动，database_id 会保住）[y/N] ");
	if (answer !== "y" && answer !== "yes") {
		log("已跳过。想自己处理就按上面的命令来。");
		return;
	}

	const merged = tryGit(["merge", "--allow-unrelated-histories", "-X", "theirs", "upstream/main"]);
	if (!merged.ok) {
		fail("对齐合并失败", `${merged.output}\n想放弃：git merge --abort`);
	}
	log("历史已对齐 ✅");

	if (localId && localId !== PLACEHOLDER_D1_ID) {
		if (writeDatabaseId(localId)) {
			git(["add", "--", "wrangler.jsonc"]);
			git(["commit", "-m", "chore: 写回自己的 database_id"]);
			log(`已把你的 database_id（${localId.slice(0, 8)}…）写回并提交`);
		}
	} else {
		log("注意：这次合并后 database_id 是上游的占位值，记得改成你自己的再 push");
	}
}

/** 上游地址：命令行参数优先，否则用 package.json 的 repository */
function resolveUpstream() {
	const explicit = (process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "").trim();
	if (explicit) return explicit;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
		const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
		if (url) return String(url).replace(/^git\+/, "");
	} catch {
		/* 忽略 */
	}
	return "";
}

async function main() {
	if (!fs.existsSync(path.join(ROOT, ".git"))) {
		fail("当前目录不是 git 仓库", "请在你自己的仓库目录里运行（一键部署出来的那份）。");
	}

	const upstream = resolveUpstream();
	if (!upstream) {
		fail(
			"找不到上游地址",
			"用法：npm run update:upstream -- https://github.com/<上游作者>/asset-manager.git",
		);
	}

	// 1. 工作区必须干净：合并前先把未提交的改动处理掉，否则冲突会混在一起
	const dirty = git(["status", "--porcelain"]).trim();
	if (dirty) {
		fail(
			"工作区有未提交的改动",
			[
				"先处理它们再更新（更新会做一次合并，脏工作区很难回退）：",
				"  git add -A && git commit -m 'wip'      # 提交",
				"  git stash                              # 或临时收起",
			].join("\n"),
		);
	}

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	if (branch !== "main" && branch !== "master") {
		log(`当前分支是 ${branch}（不是 main / master），继续按它来`);
	}

	// 2. 加/更新 upstream remote。本地路径也算合法上游（测试与内网镜像会用到）
	const existing = tryGit(["remote", "get-url", "upstream"]);
	if (existing.ok && existing.output.trim() === upstream) {
		log(`upstream 已指向 ${upstream}`);
	} else if (existing.ok) {
		log(`upstream 原为 ${existing.output.trim()}，改为 ${upstream}`);
		git(["remote", "set-url", "upstream", upstream]);
	} else {
		log(`添加 upstream → ${upstream}`);
		git(["remote", "add", "upstream", upstream]);
	}

	// 在模板仓库本身跑这个命令时，upstream 就是 origin：合并是空操作，但用户可能困惑
	const origin = tryGit(["remote", "get-url", "origin"]);
	if (origin.ok && origin.output.trim().replace(/\.git$/, "") === upstream.trim().replace(/\.git$/, "")) {
		log("提示：upstream 与 origin 是同一个仓库 —— 你大概在模板仓库本身里跑这条命令；");
		log("      它会正常结束，但不会有任何合并。要更新自己的副本，请在那个副本目录里运行。");
	}

	log("拉取上游…");
	const fetched = tryGit(["fetch", "upstream", "--prune"]);
	if (!fetched.ok) {
		fail("拉取上游失败", `${fetched.output}\n检查网络、仓库地址是否可访问（私有仓库需要相应权限）。`);
	}

	// 3. 先告诉用户"这次会更新什么"，避免闷头合并
	const incoming = tryGit(["log", "--oneline", "HEAD..upstream/main"]);
	const count = incoming.ok ? incoming.output.trim().split("\n").filter(Boolean).length : 0;
	if (count === 0) {
		log("已经是最新的，没有需要合并的提交 ✅");
		return;
	}
	log(`将要合并 ${count} 个提交：`);
	for (const line of incoming.output.trim().split("\n").slice(0, 20)) console.log(`         ${line}`);
	if (count > 20) console.log(`         …还有 ${count - 20} 个`);

	// 4. 先看两边是否有共同祖先；没有就先一次性对齐（模板复制就是这个情况）
	const sharedBase = tryGit(["merge-base", "HEAD", "upstream/main"]);
	if (!sharedBase.ok || sharedBase.output.trim() === "") {
		await alignUnrelatedHistories(upstream);
		return;
	}

	// 5. 合并
	log("合并 upstream/main…");
	const merged = tryGit(["merge", "--no-edit", "upstream/main"]);
	if (merged.ok) {
		log("合并完成 ✅");
	} else {
		const conflicted = git(["diff", "--name-only", "--diff-filter=U"]).trim().split("\n").filter(Boolean);
		if (conflicted.length === 0) {
			fail(
				"合并失败",
				[
					merged.output,
					"如果是因为本地有未跟踪文件挡路，处理掉再重试；想放弃这次合并：git merge --abort",
				].join("\n"),
			);
		}

		const wranglerConflicted = conflicted.includes("wrangler.jsonc");
		if (wranglerConflicted) {
			// 上游那边是占位值，你这边是自己的真实 D1 id —— 永远保留你的
			log("wrangler.jsonc 冲突：保留你的 database_id（上游只是占位值）");
			git(["checkout", "--ours", "--", "wrangler.jsonc"]);
			git(["add", "--", "wrangler.jsonc"]);
		}

		const remaining = git(["diff", "--name-only", "--diff-filter=U"]).trim().split("\n").filter(Boolean);
		if (remaining.length > 0) {
			fail(
				`还有 ${remaining.length} 个文件冲突`,
				[
					`冲突文件：${remaining.join("、")}`,
					"逐个打开改掉冲突标记（<<<<<<< / ======= / >>>>>>>），然后：",
					"  git add <文件>",
					"  git commit --no-edit",
					"想放弃这次合并：git merge --abort",
				].join("\n"),
			);
		}

		// wrangler.jsonc 处理完就没有别的冲突了：收尾提交
		git(["commit", "--no-edit"]);
		log("合并完成（wrangler.jsonc 保留了你的 database_id）✅");
	}

	// 6. 下一步
	const localId = (() => {
		try {
			const config = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
			return config.match(/"database_id"\s*:\s*"([^"]*)"/)?.[1] ?? "";
		} catch {
			return "";
		}
	})();

	console.log(`
[update] 下一步：
  1. 先导出一份备份（设置 → 备份），更新一般不动数据，但备份永远不亏
  2. 推上去，Workers Builds 会自动重新构建部署：
       git push
     （如果没用 Workers Builds：本地跑 npm run deploy:safe）
  3. 这次更新若带数据库迁移：
       - Builds 的 Deploy command 是 npm run deploy → 自动跑，无需操作
       - 否则本地跑一次 npm run db:migrate:remote
  4. 打开网址确认正常（首屏报"数据库需要升级"就是第 3 步没做）
${localId && localId !== PLACEHOLDER_D1_ID ? `\n[update] 你的 D1 id 仍然是 ${localId.slice(0, 8)}…（未被上游占位值覆盖）` : ""}`);
}

main().catch((error) => {
	console.error(`\n[update] ✗ 未预期的错误：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
