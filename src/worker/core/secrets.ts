import { fromBase64, toBase64 } from "./utils";

/**
 * 用 SESSION_SECRET 作为主密钥，对"存在数据库里的第三方 API Key"做 AES-GCM 加密。
 *
 * 为什么不用 Worker Secret 直接存？
 *   因为需求是"用户可以在设置页自己填任意服务的 Key"，而 Secret 只能部署时写入。
 *   折中方案：Key 存 settings 表，但用主密钥加密——单看数据库泄露拿不到明文。
 */

/**
 * 仓库里公开出现过的示例/占位密钥。
 *
 * 背景：一键部署向导会让用户直接编辑 `.dev.vars.example` 里的值，
 * 而那个文件是公开的。如果直接把示例值当真实密钥用，任何知道这个仓库的人
 * 都可以用已知口令初始化你的部署 —— 所以这里直接拒绝，让问题在第一次
 * 初始化时就暴露，而不是悄悄留一个后门。
 */
const PLACEHOLDER_SECRETS = new Set([
	"dev-setup-token-please-change",
	"dev-session-secret-please-change",
	"dev-setup-token-local-only",
	"dev-session-secret-local-only",
	"test-setup-token",
	"test-session-secret",
	"change-me",
	"changeme",
	"please-change",
	"your-token",
	"your-secret",
	"secret",
	"password",
]);

export function isPlaceholderSecret(value: string | null | undefined): boolean {
	if (!value) return false;
	return PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}

export type SecretCheck =
	| { ok: true }
	| { ok: false; code: "setup_token_missing" | "setup_token_placeholder" | "session_secret_weak"; key: string };

/**
 * 部署密钥可用性检查（在初始化时执行）。
 * 抽成纯函数是为了能直接单测各种组合，而不是靠改测试环境的绑定。
 */
export function checkDeploymentSecrets(env: { SETUP_TOKEN?: string; SESSION_SECRET?: string }): SecretCheck {
	const token = env.SETUP_TOKEN;
	if (!token || token.trim().length < 8) {
		return { ok: false, code: "setup_token_missing", key: "SETUP_TOKEN" };
	}
	if (isPlaceholderSecret(token)) {
		return { ok: false, code: "setup_token_placeholder", key: "SETUP_TOKEN" };
	}

	const session = env.SESSION_SECRET;
	if (!session || session.trim().length < 16 || isPlaceholderSecret(session)) {
		return { ok: false, code: "session_secret_weak", key: "SESSION_SECRET" };
	}
	return { ok: true };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function masterKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: encoder.encode("asset-manager-secrets-v1") as unknown as BufferSource, iterations: 100_000, hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** 加密一段文本，返回 base64（iv 前置） */
export async function encryptSecret(plain: string, secret: string): Promise<string> {
	if (!secret) throw new Error("缺少 SESSION_SECRET，无法加密");
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const key = await masterKey(secret);
	const cipher = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		encoder.encode(plain),
	);
	const combined = new Uint8Array(iv.length + cipher.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(cipher), iv.length);
	return toBase64(combined);
}

/** 解密；失败返回 null（例如换了 SESSION_SECRET） */
export async function decryptSecret(payload: string, secret: string): Promise<string | null> {
	if (!payload || !secret) return null;
	try {
		const combined = fromBase64(payload);
		const iv = combined.slice(0, 12);
		const body = combined.slice(12);
		const key = await masterKey(secret);
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as unknown as BufferSource },
			key,
			body as unknown as BufferSource,
		);
		return decoder.decode(plain);
	} catch {
		return null;
	}
}
