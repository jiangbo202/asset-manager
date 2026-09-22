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
export const TEST_SETUP_TOKEN =
	"b7f1c0d9e4a25f38c6710b4e8d92a35c7f0e1b6d4a98c2e5f3107d6b8a4c9e2f";

export async function bootstrap(password = "test-password-123", setupToken = TEST_SETUP_TOKEN) {
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

/**
 * 用密码换会话（默认与 bootstrap 相同的密码）。
 * 返回的是"这次登录请求本身"的响应，所以错误密码会得到 4xx 且没有 cookie ——
 * 测试里常要断言"密码错了就还是访客"。
 */
export async function login(password = "test-password-123") {
	const params = await call<{ ok: boolean; data: { kdfSalt: string; iterations: number } }>("/api/auth/params");
	const credential = await deriveCredential(password, params.body.data.kdfSalt, params.body.data.iterations);
	return await call<{ ok: boolean }>("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ credential }),
	});
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
		env.DB.prepare("DELETE FROM snapshots"),
		env.DB.prepare("DELETE FROM quote_cache"),
		env.DB.prepare("DELETE FROM quote_runs"),
		env.DB.prepare("DELETE FROM settings WHERE key NOT IN ('schema_version')"),
	]);
}

/**
 * 假的数据源响应：按 URL 前缀匹配，没有匹配到的一律 404。
 *
 * 放在这里而不是某个 *.test.ts 里：测试文件一旦被 import（例如别处要复用这个桩），
 * 里面的 describe/it 会**再注册一遍**，同一批用例会被重复执行好几次
 * （实测：22 个 providers 用例被 4 个文件各跑一次，总数从 161 虚涨到 223）。
 */
export function fakeFetch(
	handlers: Array<{ match: (url: string) => boolean; json?: unknown; text?: string; status?: number }>,
): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
		for (const handler of handlers) {
			if (!handler.match(url)) continue;
			const body = handler.text ?? JSON.stringify(handler.json ?? {});
			return new Response(body, {
				status: handler.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("no handler", { status: 404 });
	};
	return impl as unknown as typeof fetch;
}
