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

/* ── 备份文件加密（FR-8.3） ─────────────────────────────────
 * 在浏览器端用口令派生密钥并 AES-GCM 加密，Worker 全程看不到明文口令，
 * 也不消耗 Worker CPU。
 */

const ENCRYPTED_FORMAT = "asset-manager-backup";

interface EncryptedEnvelope {
	format: string;
	encrypted: true;
	kdf: { name: string; salt: string; iterations: number };
	cipher: { name: string; iv: string };
	ciphertext: string;
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function keyFromPassphrase(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** 用口令加密整个备份 JSON，返回新的 JSON 文本 */
export async function encryptBackup(plainJson: string, passphrase: string): Promise<string> {
	const salt = new Uint8Array(16);
	const iv = new Uint8Array(12);
	crypto.getRandomValues(salt);
	crypto.getRandomValues(iv);

	const iterations = 200_000;
	const key = await keyFromPassphrase(passphrase, salt, iterations);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		new TextEncoder().encode(plainJson),
	);

	const envelope: EncryptedEnvelope = {
		format: ENCRYPTED_FORMAT,
		encrypted: true,
		kdf: { name: "PBKDF2-SHA256", salt: toBase64Url(salt), iterations },
		cipher: { name: "AES-GCM", iv: toBase64Url(iv) },
		ciphertext: toBase64Url(new Uint8Array(ciphertext)),
	};
	return JSON.stringify(envelope, null, 2);
}

/** 判断一段文本是否是加密备份 */
export function isEncryptedBackup(text: string): boolean {
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return parsed?.encrypted === true && typeof parsed.ciphertext === "string";
	} catch {
		return false;
	}
}

/** 解密备份；口令错误时 WebCrypto 会抛错 */
export async function decryptBackup(text: string, passphrase: string): Promise<string> {
	const envelope = JSON.parse(text) as EncryptedEnvelope;
	if (envelope.encrypted !== true) throw new Error("不是加密备份文件");

	const salt = fromBase64Url(envelope.kdf.salt);
	const iv = fromBase64Url(envelope.cipher.iv);
	const key = await keyFromPassphrase(passphrase, salt, envelope.kdf.iterations);

	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as unknown as BufferSource },
			key,
			fromBase64Url(envelope.ciphertext) as unknown as BufferSource,
		);
		return new TextDecoder().decode(plain);
	} catch {
		throw new Error("口令不正确，或文件已损坏");
	}
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
