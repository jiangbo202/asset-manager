#!/usr/bin/env node
/**
 * 生成并写入 SETUP_TOKEN / SESSION_SECRET（Worker Secrets）
 *
 * 注意：
 *  - SETUP_TOKEN 只会在终端打印一次，请自己留存；首次打开网页完成初始化时要用。
 *  - 如果丢失：重跑本脚本会生成新的（同时需要把 D1 里的 auth 行删掉才能重新初始化）：
 *      npx wrangler d1 execute DB --remote --command "DELETE FROM auth;"
 *  - 在 CI（公开仓库）里不要运行本脚本的打印逻辑，请改用用户自备的 GitHub Secret。
 */
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();

function generate(bytes = 32) {
	return crypto.randomBytes(bytes).toString("hex");
}

function main() {
	const setupToken = process.env.SETUP_TOKEN && process.env.SETUP_TOKEN.length >= 16
		? process.env.SETUP_TOKEN
		: generate(32);
	const sessionSecret = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
		? process.env.SESSION_SECRET
		: generate(32);

	const payload = JSON.stringify({ SETUP_TOKEN: setupToken, SESSION_SECRET: sessionSecret });

	try {
		execFileSync("npx", ["wrangler", "secret", "bulk"], {
			cwd: ROOT,
			input: payload,
			encoding: "utf8",
			stdio: ["pipe", "inherit", "inherit"],
		});
	} catch (error) {
		console.error("[setup-secrets] 写入 Worker Secrets 失败，请确认已登录并已部署过一次。");
		console.error(String(error.message || error));
		process.exit(1);
	}

	console.log("");
	console.log("════════════════════════════════════════════════════════");
	console.log("  SETUP TOKEN（只显示这一次，请立刻保存）");
	console.log("  " + setupToken);
	console.log("════════════════════════════════════════════════════════");
	console.log("  下一步：打开部署后的网址，粘贴上面的 token 完成初始化。");
	console.log("  丢失 token 的恢复方式见 README「忘记密码 / 忘记 token」。");
	console.log("════════════════════════════════════════════════════════");
	console.log("");
}

main();
