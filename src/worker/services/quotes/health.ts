import { isRecord } from "../../core/utils";

/**
 * 数据源健康度与限流冷却
 *
 * 免费接口偶发 429 是常态，所以：
 *  - 命中限流（429/403）→ 冷却 10 分钟
 *  - 连续失败 3 次 → 冷却 30 分钟
 *  - 冷却期内该源直接跳过（并告知用户原因），把机会留给其它源
 *
 * 状态存在 settings.provider_health（JSON），旧数据损坏时按"无记录"处理。
 */

export const COOLDOWN_RATE_LIMIT_MS = 10 * 60_000;
export const COOLDOWN_FAILURE_MS = 30 * 60_000;
export const FAILURES_BEFORE_COOLDOWN = 3;

export interface ProviderHealthEntry {
	failures: number;
	lastError?: string;
	lastErrorAt?: string;
	lastSuccessAt?: string;
	cooldownUntil?: string;
	cooldownReason?: string;
}

export type ProviderHealth = Record<string, ProviderHealthEntry>;

export function parseHealth(raw: string | null | undefined): ProviderHealth {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return {};
		const out: ProviderHealth = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!isRecord(value)) continue;
			out[key] = {
				failures: Number(value.failures ?? 0) || 0,
				lastError: typeof value.lastError === "string" ? value.lastError : undefined,
				lastErrorAt: typeof value.lastErrorAt === "string" ? value.lastErrorAt : undefined,
				lastSuccessAt: typeof value.lastSuccessAt === "string" ? value.lastSuccessAt : undefined,
				cooldownUntil: typeof value.cooldownUntil === "string" ? value.cooldownUntil : undefined,
				cooldownReason: typeof value.cooldownReason === "string" ? value.cooldownReason : undefined,
			};
		}
		return out;
	} catch {
		return {};
	}
}

export interface CooldownState {
	cooling: boolean;
	until: string | null;
	reason: string | null;
	minutesLeft: number;
}

export function cooldownOf(health: ProviderHealth, providerId: string, now = new Date()): CooldownState {
	const entry = health[providerId];
	if (!entry?.cooldownUntil) return { cooling: false, until: null, reason: null, minutesLeft: 0 };
	const until = Date.parse(entry.cooldownUntil);
	if (!Number.isFinite(until) || until <= now.getTime()) {
		return { cooling: false, until: entry.cooldownUntil, reason: entry.cooldownReason ?? null, minutesLeft: 0 };
	}
	return {
		cooling: true,
		until: entry.cooldownUntil,
		reason: entry.cooldownReason ?? null,
		minutesLeft: Math.max(1, Math.ceil((until - now.getTime()) / 60_000)),
	};
}

const isRateLimit = (status?: number, message?: string): boolean => {
	if (status === 429 || status === 403) return true;
	if (!message) return false;
	return /429|rate limit|too many|限流|频繁/i.test(message);
};

/** 根据一次调用的结果更新健康度（返回新对象，由调用方决定何时落库） */
export function applyHealth(
	health: ProviderHealth,
	providerId: string,
	result: { ok: boolean; status?: number; error?: string },
	now = new Date(),
): ProviderHealth {
	const current = health[providerId] ?? { failures: 0 };
	const next: ProviderHealth = { ...health };

	if (result.ok) {
		next[providerId] = {
			failures: 0,
			lastSuccessAt: now.toISOString(),
			// 成功后清掉冷却，避免"恢复健康了还在被跳过"
			cooldownUntil: undefined,
			cooldownReason: undefined,
			lastError: current.lastError,
			lastErrorAt: current.lastErrorAt,
		};
		return next;
	}

	const failures = current.failures + 1;
	const rateLimited = isRateLimit(result.status, result.error);
	const shouldCooldown = rateLimited || failures >= FAILURES_BEFORE_COOLDOWN;
	const cooldownMs = rateLimited ? COOLDOWN_RATE_LIMIT_MS : COOLDOWN_FAILURE_MS;

	next[providerId] = {
		failures: shouldCooldown ? 0 : failures,
		lastError: result.error,
		lastErrorAt: now.toISOString(),
		lastSuccessAt: current.lastSuccessAt,
		cooldownUntil: shouldCooldown ? new Date(now.getTime() + cooldownMs).toISOString() : undefined,
		cooldownReason: shouldCooldown
			? rateLimited
				? `被限流（${result.error ?? "HTTP 429"}），暂停 ${Math.round(cooldownMs / 60_000)} 分钟`
				: `连续失败 ${failures} 次，暂停 ${Math.round(cooldownMs / 60_000)} 分钟`
			: undefined,
	};
	return next;
}
