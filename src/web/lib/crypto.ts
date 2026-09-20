/**
 * 浏览器端加密工具
 *
 * 关键点（PRD §9.1）：PBKDF2 在**浏览器**里跑，Worker 只做一次 SHA-256。
 * 这样在 Workers 免费版 10ms CPU 限制下也毫无压力。
 */

export const ITERATIONS = 300_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+";

export function randomSaltHex(bytes = SALT_BYTES): string {
	const salt = new Uint8Array(bytes);
	crypto.getRandomValues(salt);
	return Array.from(salt)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** 生成强随机密码（默认 20 字符 ≈ 120 bits） */
export function randomPassword(length = 20): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
	return out;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromHex(hex: string): Uint8Array {
	const pairs = hex.match(/.{2}/g) ?? [];
	return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

/** credential = base64(PBKDF2-SHA256(password, salt, iterations)) */
export async function deriveCredential(
	password: string,
	saltHex: string,
	iterations = ITERATIONS,
): Promise<string> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: fromHex(saltHex) as unknown as BufferSource, iterations, hash: "SHA-256" },
		keyMaterial,
		KEY_BYTES * 8,
	);
	return toBase64(new Uint8Array(bits));
}

/** 密码强度提示（不阻塞提交，只做提醒） */
export function passwordStrength(password: string): { score: number; hint: string } {
	let score = 0;
	if (password.length >= 12) score += 1;
	if (password.length >= 16) score += 1;
	if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
	if (/\d/.test(password)) score += 1;
	if (/[^a-zA-Z0-9]/.test(password)) score += 1;

	const hints = ["太弱，建议至少 12 位", "偏弱，建议加长或混合大小写", "一般，建议 16 位以上", "不错", "很好", "很强"];
	return { score: Math.min(score, 5), hint: hints[Math.min(score, 5)] };
}

export function isDesktop(): boolean {
	return typeof navigator !== "undefined" && navigator.clipboard !== undefined;
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
