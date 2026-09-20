import { ApiError } from "./errors";
import { fromBase64, sha256Hex, timingSafeEqual } from "./utils";

/**
 * 认证凭据的验证方式（见 docs/PRD.md §9.1）
 *
 *  浏览器：credential = PBKDF2-SHA256(密码, kdfSalt, 300_000)  —— 重活全在浏览器
 *  Worker：verifier   = SHA-256(credential || verifierSalt)      —— 单次哈希，≈0.1ms CPU
 *
 * 这样在 Workers 免费版 10ms CPU 限制下也绰绰有余；数据库泄露也拿不到可登录凭据。
 */

export const DEFAULT_ITERATIONS = 300_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 1_000_000;
export const CREDENTIAL_BYTES = 32;

export const smallSaltHex = (bytes = 16): string => {
	const salt = new Uint8Array(bytes);
	crypto.getRandomValues(salt);
	return Array.from(salt)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

/** 校验来自浏览器的 credential（base64 编码的 32 字节） */
export function parseCredential(value: unknown): Uint8Array {
	if (typeof value !== "string" || value.length === 0) {
		throw new ApiError(400, "invalid_credential", "缺少密码凭据");
	}
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(value);
	} catch {
		throw new ApiError(400, "invalid_credential", "密码凭据格式不正确");
	}
	if (bytes.length !== CREDENTIAL_BYTES) {
		throw new ApiError(400, "invalid_credential", "密码凭据长度不正确");
	}
	return bytes;
}

export function parseIterations(value: unknown): number {
	const iterations = Number(value);
	if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
		throw new ApiError(400, "invalid_iterations", `PBKDF2 迭代次数必须在 ${MIN_ITERATIONS} ~ ${MAX_ITERATIONS} 之间`);
	}
	return iterations;
}

export function parseSalt(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{16,128}$/i.test(value)) {
		throw new ApiError(400, "invalid_salt", "PBKDF2 盐值格式不正确");
	}
	return value.toLowerCase();
}

export async function computeVerifier(credential: Uint8Array, verifierSaltHex: string): Promise<string> {
	const salt = new Uint8Array(
		(verifierSaltHex.match(/.{2}/g) ?? []).map((pair) => Number.parseInt(pair, 16)),
	);
	const combined = new Uint8Array(credential.length + salt.length);
	combined.set(credential, 0);
	combined.set(salt, credential.length);
	return sha256Hex(combined);
}

export async function verifyCredential(
	credential: Uint8Array,
	verifierSaltHex: string,
	expectedVerifier: string,
): Promise<boolean> {
	const actual = await computeVerifier(credential, verifierSaltHex);
	return timingSafeEqual(actual, expectedVerifier);
}
