import { badRequest, ApiError } from "../core/errors";
import { isRecord } from "../core/utils";

/** 极简校验工具：不引三方库，保持 Worker 体积与 CPU 开销最小 */

export function asRecord(value: unknown, label = "请求体"): Record<string, unknown> {
	if (!isRecord(value)) throw badRequest(`${label}必须是 JSON 对象`);
	return value;
}

export function requireString(
	obj: Record<string, unknown>,
	key: string,
	options: { label?: string; max?: number; pattern?: RegExp; patternHint?: string } = {},
): string {
	const value = obj[key];
	const label = options.label ?? key;
	if (typeof value !== "string" || value.trim() === "") throw badRequest(`${label}不能为空`);
	const trimmed = value.trim();
	if (options.max && trimmed.length > options.max) throw badRequest(`${label}最长 ${options.max} 个字符`);
	if (options.pattern && !options.pattern.test(trimmed)) {
		throw badRequest(`${label}格式不正确${options.patternHint ? `（${options.patternHint}）` : ""}`);
	}
	return trimmed;
}

export function optionalString(
	obj: Record<string, unknown>,
	key: string,
	options: { label?: string; max?: number } = {},
): string | null | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	if (typeof value !== "string") throw badRequest(`${options.label ?? key}必须是字符串`);
	const trimmed = value.trim();
	if (options.max && trimmed.length > options.max) throw badRequest(`${options.label ?? key}最长 ${options.max} 个字符`);
	return trimmed === "" ? null : trimmed;
}

export function requireNumber(
	obj: Record<string, unknown>,
	key: string,
	options: { label?: string; min?: number; max?: number } = {},
): number {
	const value = obj[key];
	const label = options.label ?? key;
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
	if (!Number.isFinite(parsed)) throw badRequest(`${label}必须是数字`);
	if (options.min !== undefined && parsed < options.min) throw badRequest(`${label}不能小于 ${options.min}`);
	if (options.max !== undefined && parsed > options.max) throw badRequest(`${label}不能大于 ${options.max}`);
	return parsed;
}

export function optionalNumber(
	obj: Record<string, unknown>,
	key: string,
	options: { label?: string; min?: number; max?: number } = {},
): number | null | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	return requireNumber(obj, key, options);
}

export function requireOneOf<T extends readonly string[]>(
	obj: Record<string, unknown>,
	key: string,
	allowed: T,
	label?: string,
): T[number] {
	const value = obj[key];
	if (typeof value !== "string" || !allowed.includes(value)) {
		throw badRequest(`${label ?? key}必须是以下之一：${allowed.join(" / ")}`);
	}
	return value as T[number];
}

export function requireCurrency(obj: Record<string, unknown>, key = "currency"): string {
	return requireString(obj, key, {
		label: "币种",
		max: 5,
		pattern: /^[A-Za-z]{3,5}$/,
		patternHint: "3~5 个字母，如 USD / HKD / CNY",
	}).toUpperCase();
}

export function requireId(value: string | undefined, label = "id"): string {
	if (!value || value.length > 64) throw new ApiError(400, "invalid_id", `${label} 不合法`);
	return value;
}
