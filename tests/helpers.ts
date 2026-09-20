import { SELF, env } from "cloudflare:test";

/** 与浏览器端完全一致的派生方式（PBKDF2 → base64） */
export async function deriveCredential(
	password: string,
	saltHex: string,
	iterations: number,
): Promise<string> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const salt = new Uint8Array((saltHex.match(/.{2}/g) ?? []).map((pair) => Number.parseInt(pair, 16)));
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
		keyMaterial,
		256,
	);
	let binary = "";
	for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function randomSaltHex(bytes = 16): string {
	const salt = new Uint8Array(bytes);
	crypto.getRandomValues(salt);
	return Array.from(salt)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface TestResponse<T = unknown> {
	status: number;
	body: T;
	cookie: string | null;
}

export async function call<T = unknown>(
	path: string,
	init: RequestInit & { cookie?: string | null } = {},
): Promise<TestResponse<T>> {
	const headers = new Headers(init.headers);
	if (init.body) headers.set("Content-Type", "application/json");
	if (init.cookie) headers.set("Cookie", init.cookie);

	const response = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
	const setCookie = response.headers.get("set-cookie");
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return {
		status: response.status,
		body: body as T,
		cookie: setCookie ? setCookie.split(";")[0] : null,
	};
}

export const TEST_ITERATIONS = 100_000;

/** 完成初始化并返回登录 cookie */
export async function bootstrap(password = "test-password-123", setupToken = "test-setup-token") {
	const kdfSalt = randomSaltHex();
	const credential = await deriveCredential(password, kdfSalt, TEST_ITERATIONS);
	const response = await call<{ ok: boolean }>("/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ setupToken, credential, kdfSalt, iterations: TEST_ITERATIONS, displayCurrency: "USD" }),
	});
	if (response.status !== 200) throw new Error(`初始化失败：${JSON.stringify(response.body)}`);
	if (!response.cookie) throw new Error("初始化没有返回会话 cookie");
	return { cookie: response.cookie, credential, kdfSalt };
}

export async function clearAll(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM sessions"),
		env.DB.prepare("DELETE FROM auth"),
		env.DB.prepare("DELETE FROM holdings"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM audit_log"),
		env.DB.prepare("DELETE FROM price_history"),
		env.DB.prepare("DELETE FROM qty_history"),
		env.DB.prepare("DELETE FROM fx_rates"),
		env.DB.prepare("DELETE FROM settings WHERE key NOT IN ('schema_version')"),
	]);
}
