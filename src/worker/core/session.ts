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

export async function readSession(c: Context<AppEnv>): Promise<SessionRow | null> {
	const token = readCookie(c.req.header("cookie") ?? null, COOKIE_NAME);
	if (!token) return null;

	const hash = await tokenHash(token);
	const row = await c.env.DB.prepare(
		`SELECT id, created_at, expires_at, last_seen, ua, ip FROM sessions WHERE id = ?`,
	)
		.bind(hash)
		.first<SessionRow>();

	if (!row) return null;
	if (row.expires_at < nowIso()) {
		await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(hash).run();
		return null;
	}
	return row;
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

export async function listSessions(c: Context<AppEnv>): Promise<Array<Omit<SessionRow, "id"> & { id: string }>> {
	const { results } = await c.env.DB.prepare(
		`SELECT id, created_at, expires_at, last_seen, ua, ip FROM sessions ORDER BY created_at DESC LIMIT 50`,
	).all<SessionRow>();
	return results ?? [];
}

export const sessionTokenPreview = (value: string): string => toBase64(encoder.encode(value)).slice(0, 8);

/** 会话里不需要 id 之外的敏感信息，这里保留一个生成器方便将来加 sid 前缀 */
export const newSessionMarker = (): string => newId();
