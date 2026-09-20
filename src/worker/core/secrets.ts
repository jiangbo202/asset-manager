import { fromBase64, toBase64 } from "./utils";

/**
 * 用 SESSION_SECRET 作为主密钥，对"存在数据库里的第三方 API Key"做 AES-GCM 加密。
 *
 * 为什么不用 Worker Secret 直接存？
 *   因为需求是"用户可以在设置页自己填任意服务的 Key"，而 Secret 只能部署时写入。
 *   折中方案：Key 存 settings 表，但用主密钥加密——单看数据库泄露拿不到明文。
 */

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
