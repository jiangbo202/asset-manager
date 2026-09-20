import { Hono } from "hono";
import type { AppEnv } from "../types";
import { ApiError, badRequest, conflict, ok, unauthorized } from "../core/errors";
import { writeAudit } from "../core/audit";
import { getSetting, getSettings, setSetting, SETTING_DISPLAY_CURRENCY } from "../data/settings.repo";
import { SCHEMA_VERSION } from "../../shared/version";
import { normalizeTimeZone } from "../../shared/time";
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
import { tOf } from "../core/i18n";
import { checkDeploymentSecrets } from "../core/secrets";

const ALGO = "pbkdf2-sha256+sha256/v1";
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const KEY_FAILS = "login_fail_count";
const KEY_LOCK = "login_locked_until";

const auth = new Hono<AppEnv>();

async function body(
	c: { req: { json: () => Promise<unknown> } },
	t: ReturnType<typeof tOf>,
): Promise<Record<string, unknown>> {
	try {
		const parsed = await c.req.json();
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw badRequest(t("error.jsonBody"));
	}
}

/** 登录限流（PRD FR-1.7） */
async function assertNotLocked(db: D1Database, t: ReturnType<typeof tOf>): Promise<void> {
	const until = await getSetting(db, KEY_LOCK);
	if (until && Date.parse(until) > Date.now()) {
		const minutes = Math.ceil((Date.parse(until) - Date.now()) / 60_000);
		throw new ApiError(429, "locked", t("error.locked", { minutes }));
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
	// 初始化状态与会话都已在上下文里（app.ts 用一次 batch 读出），这里不再查库
	const initialized = Boolean(c.get("auth"));
	const session = c.get("session");
	let mustChange = false;
	let lastLoginAt: string | null = null;
	if (initialized && session) {
		// 只在已登录时回传这两个字段（未登录不应该看到上次登录时间）
		mustChange = c.get("auth")?.must_change === 1;
		lastLoginAt = c.get("auth")?.last_login_at ?? null;
	}

	// 结构版本、语言、时区：一次读完（原来是 3 次单独的 getSetting）
	const settings = await getSettings(c.env.DB);
	const schemaVersion = Number.parseInt(settings.schema_version ?? "0", 10) || 0;
	const migrationRequired = schemaVersion < SCHEMA_VERSION;
	const language = settings.language ?? "auto";
	const timezone = normalizeTimeZone(settings.timezone);

	return ok(c, {
		initialized,
		authenticated: Boolean(session) && initialized,
		setupTokenRequired: true,
		mustChange,
		lastLoginAt,
		schemaVersion,
		expectedSchemaVersion: SCHEMA_VERSION,
		migrationRequired,
		language,
		timezone,
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
	const t = tOf(c);
	if (await isInitialized(c.env.DB)) {
		throw conflict(t("error.already_initialized"), "already_initialized");
	}
	// 缺密钥 / 还是示例占位值 / 太短 → 直接拒绝，避免部署出一个"用公开默认口令就能初始化"的实例
	const secretCheck = checkDeploymentSecrets(c.env);
	if (!secretCheck.ok) {
		throw new ApiError(500, secretCheck.code, t(`error.${secretCheck.code}`, { key: secretCheck.key }));
	}
	const secret = c.env.SETUP_TOKEN as string;

	const payload = await body(c, t);
	const setupToken = asString(payload.setupToken);
	if (!setupToken || !timingSafeEqual(setupToken, secret)) {
		throw unauthorized(t("error.setup_token_invalid"));
	}

	const credential = parseCredential(payload.credential);
	const kdfSalt = parseSalt(payload.kdfSalt);
	const iterations = parseIterations(payload.iterations ?? DEFAULT_ITERATIONS);
	// verifier = SHA-256(credential || verifierSalt)，verifierSalt 只存在服务端
	const verifierSalt = smallSaltHex(16);
	const verifier = await computeVerifier(credential, verifierSalt);

	const inserted = await insertAuthIfAbsent(c.env.DB, { algo: ALGO, kdfSalt, iterations, verifier, verifierSalt });
	if (!inserted) throw conflict(t("error.already_initialized"), "already_initialized");

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
		note: t("audit.setupDone"),
	});

	return ok(c, { initialized: true });
});

auth.post("/login", async (c) => {
	const t = tOf(c);
	const row = await getAuth(c.env.DB);
	if (!row) throw conflict(t("error.not_initialized"), "not_initialized");
	await assertNotLocked(c.env.DB, t);

	const payload = await body(c, t);
	const credential = parseCredential(payload.credential);
	const valid = await verifyCredential(credential, row.verifier_salt, row.verifier);

	if (!valid) {
		await registerFailure(c.env.DB);
		throw unauthorized(t("error.password_incorrect"));
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
	const t = tOf(c);
	const count = await revokeAllSessions(c);
	clearSessionCookie(c);
	await writeAudit(c.env.DB, {
		entity: "auth",
		entityId: "1",
		action: "security",
		note: t("audit.logoutAll", { count }),
	});
	return ok(c, { revoked: count });
});

auth.post("/change-password", async (c) => {
	const t = tOf(c);
	const session = c.get("session");
	if (!session) throw unauthorized();

	const row = await getAuth(c.env.DB);
	if (!row) throw conflict(t("error.not_initialized"), "not_initialized");

	const payload = await body(c, t);
	const oldCredential = parseCredential(payload.oldCredential);
	if (!(await verifyCredential(oldCredential, row.verifier_salt, row.verifier))) {
		await registerFailure(c.env.DB);
		throw unauthorized(t("error.current_password_incorrect"));
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
		note: t("audit.changePassword"),
	});

	return ok(c, { changed: true });
});

export default auth;
