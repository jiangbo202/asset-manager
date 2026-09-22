import type { Context } from "hono";
import type { AppEnv, SessionRow } from "../types";
import { newId, nowIso, randomBase64Url, sha256Hex, toBase64 } from "./utils";

/**
 * 会话：cookie 里放随机 token，数据库里只存 token 的 sha256。
 * 这样既能随时吊销（支持"登出所有设备"），也不用自签 JWT。
 */

const COOKIE_NAME = "am_session";
const SESSION_DAYS = 30;
const encoder = new TextEncoder();

const tokenHash = (token: string) => sha256Hex(encoder.encode(token));

export interface CreatedSession {
	token: string;
	expiresAt: string;
}

export async function createSession(c: Context<AppEnv>): Promise<CreatedSession> {
	const token = randomBase64Url(32);
	const hash = await tokenHash(token);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
	const ua = c.req.header("user-agent") ?? null;
	const ip = c.req.header("cf-connecting-ip") ?? null;

	await c.env.DB.prepare(
		`INSERT INTO sessions (id, created_at, expires_at, last_seen, ua, ip) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(hash, now.toISOString(), expiresAt, now.toISOString(), ua, ip)
		.run();

	// 顺手清理过期会话，避免表无限增长
	await c.env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso()).run();

	return { token, expiresAt };
}

function readCookie(cookieHeader: string | null, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

/**
 * 会话查询语句（不执行）。
 * 存在意义：app.ts 要把它与 auth 行的查询合并成一次 `db.batch`，
 * 每个请求少跑 2 次往返（实测每条 D1 语句约 310µs 本地开销，线上更高）。
 */
export async function sessionLookupStatement(c: Context<AppEnv>): Promise<D1PreparedStatement | null> {
	const token = readCookie(c.req.header("cookie") ?? null, COOKIE_NAME);
	if (!token) return null;

	const hash = await tokenHash(token);
	return c.env.DB.prepare(`SELECT id, created_at, expires_at, last_seen, ua, ip FROM sessions WHERE id = ?`).bind(hash);
}

/** 校验查出来的会话行：过期就删掉并当作未登录 */
export async function acceptSessionRow(c: Context<AppEnv>, row: SessionRow | null): Promise<SessionRow | null> {
	if (!row) return null;
	if (row.expires_at < nowIso()) {
		await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(row.id).run();
		return null;
	}
	return row;
}

export async function readSession(c: Context<AppEnv>): Promise<SessionRow | null> {
	const statement = await sessionLookupStatement(c);
	if (!statement) return null;
	return acceptSessionRow(c, await statement.first<SessionRow>());
}

export async function touchSession(c: Context<AppEnv>, sessionId: string): Promise<void> {
	await c.env.DB.prepare(`UPDATE sessions SET last_seen = ? WHERE id = ?`).bind(nowIso(), sessionId).run();
}

/** 本地 http 开发时不能带 Secure，否则浏览器不保存 cookie；线上永远是 https */
function appendCookieAttributes(c: Context<AppEnv>, maxAge: number): string {
	const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
	return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
	c.header("Set-Cookie", `${COOKIE_NAME}=${token}; ${appendCookieAttributes(c, SESSION_DAYS * 24 * 3600)}`);
}

export function clearSessionCookie(c: Context<AppEnv>): void {
	c.header("Set-Cookie", `${COOKIE_NAME}=; ${appendCookieAttributes(c, 0)}`);
}

export async function revokeCurrentSession(c: Context<AppEnv>): Promise<void> {
	const token = readCookie(c.req.header("cookie") ?? null, COOKIE_NAME);
	if (!token) return;
	await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await tokenHash(token)).run();
}

export async function revokeAllSessions(c: Context<AppEnv>): Promise<number> {
	const result = await c.env.DB.prepare(`DELETE FROM sessions`).run();
	return result.meta.changes ?? 0;
}

/** 活跃会话列表（不含已过期的；过期的留着没意义，前端也不该显示"还能用"的过程） */
export async function listSessions(c: Context<AppEnv>): Promise<SessionRow[]> {
	const statement = sessionsStatement(c.env.DB);
	const { results } = await statement.all<SessionRow>();
	return results ?? [];
}

/** 会话列表语句（不执行）：便于和别的查询合并成一次 batch */
export function sessionsStatement(db: D1Database, now = nowIso()): D1PreparedStatement {
	return db
		.prepare(
			`SELECT id, created_at, expires_at, last_seen, ua, ip FROM sessions
			 WHERE expires_at > ? ORDER BY last_seen DESC, created_at DESC LIMIT 50`,
		)
		.bind(now);
}

/**
 * 吊销指定会话（"踢出这台设备"）。
 * 注意：`id` 是 **sha256(cookie token)**，不是 token 本身，所以把它交给前端是安全的 ——
 * 拿到它也只能用来吊销，换不来登录态（token 是 32 字节随机值，反推不出来）。
 */
export async function revokeSession(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

/** 当前这个请求用的是哪条会话（用于在列表里标出"本设备"） */
export async function currentSessionId(c: Context<AppEnv>): Promise<string | null> {
	const token = readCookie(c.req.header("cookie") ?? null, COOKIE_NAME);
	if (!token) return null;
	return await tokenHash(token);
}

export const sessionTokenPreview = (value: string): string => toBase64(encoder.encode(value)).slice(0, 8);

/** 会话里不需要 id 之外的敏感信息，这里保留一个生成器方便将来加 sid 前缀 */
export const newSessionMarker = (): string => newId();
