#!/usr/bin/env node
/**
 * 生成并写入 SETUP_TOKEN / SESSION_SECRET（Worker Secrets）
 *
 * **幂等**：已经存在的 Secret 不会被改动。这一点很关键 —— SESSION_SECRET 用来加密库里的
 * 行情 API Key，如果每次部署都换掉它，已保存的 Key 就会解不开，而且所有登录都会失效。
 * 需要轮换时显式执行：`npm run setup:secrets -- --rotate`
 *
 * 注意：
 *  - SETUP_TOKEN 只在终端打印一次，请自己留存；首次打开网页完成初始化时要用。
 *  - 如果丢失：重跑本脚本加 --rotate 会生成新的（同时需要把 D1 里的 auth 行删掉才能重新初始化）：
 *      npx wrangler d1 execute DB --remote --command "DELETE FROM auth;"
 *  - 也可以用环境变量显式指定：SETUP_TOKEN=... SESSION_SECRET=... npm run setup:secrets
 *  - 在 CI（公开仓库）里不要运行本脚本的打印逻辑，请改用用户自备的 GitHub Secret。
 */
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();

function generate(bytes = 32) {
	return crypto.randomBytes(bytes).toString("hex");
}

/** 读取线上已有的 Secret 名字；读不到（未登录 / Worker 还不存在）返回 null */
function listExistingSecrets() {
	try {
		const output = execFileSync("npx", ["wrangler", "secret", "list", "--format", "json"], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return new Set();
		// wrangler 输出 [{"name":"SETUP_TOKEN","type":"secret_text"}]，但也容忍纯字符串数组
		return new Set(
			parsed
				.map((item) => (typeof item === "string" ? item : item?.name))
				.filter((name) => typeof name === "string" && name.length > 0),
		);
	} catch {
		return null;
	}
}

function fromEnv(name) {
	const value = process.env[name];
	return value && value.length >= 16 ? value : null;
}

function main() {
	const rotate = process.argv.includes("--rotate");
	const existing = listExistingSecrets();

	if (existing === null) {
		console.warn("[setup-secrets] 读不到现有 Secrets 列表（未登录或 Worker 还没部署过），按首次配置处理。");
	}

	const envSetupToken = fromEnv("SETUP_TOKEN");
	const envSessionSecret = fromEnv("SESSION_SECRET");

	// 已经存在、且没有被显式指定、也没有要求轮换 → 保持不动
	const shouldWrite = (name, provided) => rotate || provided !== null || existing === null || !existing.has(name);

	const writeSetupToken = shouldWrite("SETUP_TOKEN", envSetupToken);
	const writeSessionSecret = shouldWrite("SESSION_SECRET", envSessionSecret);

	if (!writeSetupToken && !writeSessionSecret) {
		console.log("[setup-secrets] SETUP_TOKEN / SESSION_SECRET 已存在 → 保持不变（部署可以安全地重复执行）");
		console.log("  需要轮换：npm run setup:secrets -- --rotate");
		console.log("  ⚠️ 轮换 SESSION_SECRET 会让所有登录失效，并需要重新填写已保存的行情 API Key。");
		return;
	}

	const setupToken = writeSetupToken ? (envSetupToken ?? generate(32)) : null;
	const sessionSecret = writeSessionSecret ? (envSessionSecret ?? generate(32)) : null;

	const payload = {};
	if (setupToken) payload.SETUP_TOKEN = setupToken;
	if (sessionSecret) payload.SESSION_SECRET = sessionSecret;

	try {
		execFileSync("npx", ["wrangler", "secret", "bulk"], {
			cwd: ROOT,
			input: JSON.stringify(payload),
			encoding: "utf8",
			stdio: ["pipe", "inherit", "inherit"],
		});
	} catch (error) {
		console.error("[setup-secrets] 写入 Worker Secrets 失败，请确认已登录并已部署过一次。");
		console.error(String(error.message || error));
		process.exit(1);
	}

	console.log(`[setup-secrets] 已写入：${Object.keys(payload).join("、")}`);
	// 只有"覆盖了已有的 SESSION_SECRET"才需要提醒后果（首次部署时它本来就不存在）
	if (sessionSecret && existing?.has("SESSION_SECRET")) {
		console.log("  ⚠️ SESSION_SECRET 已更新：之前登录的设备需要重新登录，已保存的行情 API Key 需要重新填写。");
	}

	if (!setupToken) {
		console.log("  SETUP_TOKEN 未变动（沿用原有值）。");
		return;
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
