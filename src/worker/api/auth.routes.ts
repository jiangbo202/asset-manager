import { Hono } from "hono";
import type { AppEnv } from "../types";
import { ApiError, badRequest, conflict, ok, unauthorized } from "../core/errors";
import { writeAudit } from "../core/audit";
import { getSetting, setSetting, SETTING_DISPLAY_CURRENCY } from "../data/settings.repo";
import { getAuth, insertAuthIfAbsent, isInitialized, touchLastLogin, updateCredential } from "../data/auth.repo";
import {
	computeVerifier,
	DEFAULT_ITERATIONS,
	parseCredential,
	parseIterations,
	parseSalt,
	smallSaltHex,
	verifyCredential,
} from "../core/credentials";
import {
	clearSessionCookie,
	createSession,
	revokeAllSessions,
	revokeCurrentSession,
	setSessionCookie,
} from "../core/session";
import { asString, isRecord, timingSafeEqual } from "../core/utils";

const ALGO = "pbkdf2-sha256+sha256/v1";
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const KEY_FAILS = "login_fail_count";
const KEY_LOCK = "login_locked_until";

const auth = new Hono<AppEnv>();

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
	try {
		const parsed = await c.req.json();
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw badRequest("请求体必须是 JSON 对象");
	}
}

/** 登录限流（PRD FR-1.7） */
async function assertNotLocked(db: D1Database): Promise<void> {
	const until = await getSetting(db, KEY_LOCK);
	if (until && Date.parse(until) > Date.now()) {
		const minutes = Math.ceil((Date.parse(until) - Date.now()) / 60_000);
		throw new ApiError(429, "locked", `登录失败次数过多，请 ${minutes} 分钟后再试`);
	}
}

async function registerFailure(db: D1Database): Promise<void> {
	const count = Number((await getSetting(db, KEY_FAILS)) ?? "0") + 1;
	if (count >= MAX_FAILS) {
		await setSetting(db, KEY_FAILS, "0");
		await setSetting(db, KEY_LOCK, new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString());
		return;
	}
	await setSetting(db, KEY_FAILS, String(count));
}

async function resetFailures(db: D1Database): Promise<void> {
	await setSetting(db, KEY_FAILS, "0");
	await setSetting(db, KEY_LOCK, "");
}

auth.get("/me", async (c) => {
	const initialized = await isInitialized(c.env.DB);
	const session = c.get("session");
	let mustChange = false;
	let lastLoginAt: string | null = null;
	if (initialized && session) {
		const row = await getAuth(c.env.DB);
		mustChange = row?.must_change === 1;
		lastLoginAt = row?.last_login_at ?? null;
	}
	return ok(c, {
		initialized,
		authenticated: Boolean(session) && initialized,
		setupTokenRequired: true,
		mustChange,
		lastLoginAt,
	});
});

/** 登录/初始化前取 KDF 参数（浏览器用它做 PBKDF2） */
auth.get("/params", async (c) => {
	const row = await getAuth(c.env.DB);
	if (!row) {
		return ok(c, { initialized: false, kdfSalt: null, iterations: DEFAULT_ITERATIONS });
	}
	return ok(c, { initialized: true, kdfSalt: row.kdf_salt, iterations: row.iterations });
});

/** 首次初始化：必须携带部署时生成的一次性 setup token（PRD FR-1.9） */
auth.post("/setup", async (c) => {
	if (await isInitialized(c.env.DB)) {
		throw conflict("已经初始化过了", "already_initialized");
	}
	const secret = c.env.SETUP_TOKEN;
	if (!secret || secret.length < 8) {
		throw new ApiError(500, "setup_token_missing", "服务端未配置 SETUP_TOKEN，请重新部署并写入该 Secret");
	}

	const payload = await body(c);
	const setupToken = asString(payload.setupToken);
	if (!setupToken || !timingSafeEqual(setupToken, secret)) {
		throw unauthorized("setup token 不正确");
	}

	const credential = parseCredential(payload.credential);
	const kdfSalt = parseSalt(payload.kdfSalt);
	const iterations = parseIterations(payload.iterations ?? DEFAULT_ITERATIONS);
	// verifier = SHA-256(credential || verifierSalt)，verifierSalt 只存在服务端
	const verifierSalt = smallSaltHex(16);
	const verifier = await computeVerifier(credential, verifierSalt);

	const inserted = await insertAuthIfAbsent(c.env.DB, { algo: ALGO, kdfSalt, iterations, verifier, verifierSalt });
	if (!inserted) throw conflict("已经初始化过了", "already_initialized");

	const displayCurrency = asString(payload.displayCurrency);
	if (displayCurrency && /^[A-Za-z]{3,5}$/.test(displayCurrency)) {
		await setSetting(c.env.DB, SETTING_DISPLAY_CURRENCY, displayCurrency.toUpperCase());
	}
	await setSetting(c.env.DB, "setup_done_at", new Date().toISOString());

	const { token } = await createSession(c);
	setSessionCookie(c, token);
	await writeAudit(c.env.DB, {
		entity: "auth",
		entityId: "1",
		action: "setup",
		source: "system",
		note: "首次初始化完成",
	});

	return ok(c, { initialized: true });
});

auth.post("/login", async (c) => {
	const row = await getAuth(c.env.DB);
	if (!row) throw conflict("尚未初始化，请先完成初始化", "not_initialized");
	await assertNotLocked(c.env.DB);

	const payload = await body(c);
	const credential = parseCredential(payload.credential);
	const valid = await verifyCredential(credential, row.verifier_salt, row.verifier);

	if (!valid) {
		await registerFailure(c.env.DB);
		throw unauthorized("密码不正确");
	}

	await resetFailures(c.env.DB);
	await touchLastLogin(c.env.DB);
	const { token } = await createSession(c);
	setSessionCookie(c, token);

	return ok(c, { mustChange: row.must_change === 1 });
});

auth.post("/logout", async (c) => {
	await revokeCurrentSession(c);
	clearSessionCookie(c);
	return ok(c, { loggedOut: true });
});

auth.post("/logout-all", async (c) => {
	const count = await revokeAllSessions(c);
	clearSessionCookie(c);
	await writeAudit(c.env.DB, {
		entity: "auth",
		entityId: "1",
		action: "security",
		note: `登出所有设备（${count} 个会话）`,
	});
	return ok(c, { revoked: count });
});

auth.post("/change-password", async (c) => {
	const session = c.get("session");
	if (!session) throw unauthorized();

	const row = await getAuth(c.env.DB);
	if (!row) throw conflict("尚未初始化", "not_initialized");

	const payload = await body(c);
	const oldCredential = parseCredential(payload.oldCredential);
	if (!(await verifyCredential(oldCredential, row.verifier_salt, row.verifier))) {
		await registerFailure(c.env.DB);
		throw unauthorized("当前密码不正确");
	}

	const newCredential = parseCredential(payload.newCredential);
	const kdfSalt = parseSalt(payload.kdfSalt);
	const iterations = parseIterations(payload.iterations ?? DEFAULT_ITERATIONS);
	const verifierSalt = smallSaltHex(16);
	const verifier = await computeVerifier(newCredential, verifierSalt);

	await updateCredential(c.env.DB, { kdfSalt, iterations, verifier, verifierSalt });
	await revokeAllSessions(c);
	const { token } = await createSession(c);
	setSessionCookie(c, token);
	await resetFailures(c.env.DB);
	await writeAudit(c.env.DB, {
		entity: "auth",
		entityId: "1",
		action: "security",
		note: "修改密码，并吊销其他所有会话",
	});

	return ok(c, { changed: true });
});

export default auth;
