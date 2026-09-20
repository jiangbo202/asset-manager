import type { AuthRow } from "../types";
import { nowIso } from "../core/utils";

/** 单用户凭据（auth 表只有一行，id = 1） */

export async function getAuth(db: D1Database): Promise<AuthRow | null> {
	return db.prepare(`SELECT * FROM auth WHERE id = 1`).first<AuthRow>();
}

export async function isInitialized(db: D1Database): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS ok FROM auth WHERE id = 1`).first<{ ok: number }>();
	return Boolean(row);
}

export interface AuthInsert {
	algo: string;
	kdfSalt: string;
	iterations: number;
	verifier: string;
	verifierSalt: string;
	mustChange?: boolean;
}

/**
 * 原子初始化：只有 auth 表为空时才会写入成功。
 * 并发两次 setup 时，其中一次会拿到 changes = 0 → 返回 false（HTTP 409）。
 */
export async function insertAuthIfAbsent(db: D1Database, input: AuthInsert): Promise<boolean> {
	const now = nowIso();
	const result = await db
		.prepare(
			`INSERT INTO auth (id, algo, kdf_salt, iterations, verifier, verifier_salt, must_change, created_at, updated_at)
			 SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM auth WHERE id = 1)`,
		)
		.bind(
			input.algo,
			input.kdfSalt,
			input.iterations,
			input.verifier,
			input.verifierSalt,
			input.mustChange ? 1 : 0,
			now,
			now,
		)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function updateCredential(
	db: D1Database,
	input: { kdfSalt: string; iterations: number; verifier: string; verifierSalt: string },
): Promise<void> {
	await db
		.prepare(
			`UPDATE auth SET kdf_salt = ?, iterations = ?, verifier = ?, verifier_salt = ?, must_change = 0, updated_at = ?
			 WHERE id = 1`,
		)
		.bind(input.kdfSalt, input.iterations, input.verifier, input.verifierSalt, nowIso())
		.run();
}

export async function setMustChange(db: D1Database, mustChange: boolean): Promise<void> {
	await db.prepare(`UPDATE auth SET must_change = ?, updated_at = ? WHERE id = 1`).bind(mustChange ? 1 : 0, nowIso()).run();
}

export async function touchLastLogin(db: D1Database): Promise<void> {
	await db.prepare(`UPDATE auth SET last_login_at = ? WHERE id = 1`).bind(nowIso()).run();
}
