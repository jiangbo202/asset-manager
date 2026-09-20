/**
 * 字符串 / 编码 / ID 工具（不依赖任何三方库，保持 Worker 启动与 CPU 开销最小）
 */

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 时间有序的短 ID：<base36 毫秒>-<10 位随机>，便于审计与导入合并 */
export function newId(now = Date.now()): string {
	const time = now.toString(36).padStart(9, "0");
	const random = new Uint8Array(10);
	crypto.getRandomValues(random);
	let suffix = "";
	for (const byte of random) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
	return `${time}-${suffix}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** UTC 日期（YYYY-MM-DD） */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function randomBase64Url(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
	return toHex(new Uint8Array(digest));
}

/** 常数时间比较（长度不同直接返回 false，字符串比较本身不早退） */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

export function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
