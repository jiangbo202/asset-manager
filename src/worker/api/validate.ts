import { ApiError, badRequest } from "../core/errors";
import { isRecord } from "../core/utils";
import type { Translator } from "../../shared/i18n";

/**
 * 极简校验工具：不引三方库，保持 Worker 体积与 CPU 开销最小。
 *
 * 所有提示文案都通过 i18n（labelKey → field.* 字典），
 * 语言由请求的 Accept-Language 决定，错误码统一为 invalid_field。
 */

const label = (t: Translator, key: string): string => t(key);

export function asRecord(value: unknown, t: Translator): Record<string, unknown> {
	if (!isRecord(value)) throw new ApiError(400, "invalid_field", t("error.jsonBody"));
	return value;
}

interface BaseOptions {
	/** 字段名对应的 i18n key，如 field.accountName */
	labelKey: string;
	max?: number;
}

export function requireString(
	obj: Record<string, unknown>,
	key: string,
	options: BaseOptions & { pattern?: RegExp },
	t: Translator,
): string {
	const value = obj[key];
	const name = label(t, options.labelKey);
	if (typeof value !== "string" || value.trim() === "") {
		throw new ApiError(400, "invalid_field", t("error.field_required", { label: name }));
	}
	const trimmed = value.trim();
	if (options.max && trimmed.length > options.max) {
		throw new ApiError(400, "invalid_field", t("error.field_tooLong", { label: name, max: options.max }));
	}
	if (options.pattern && !options.pattern.test(trimmed)) {
		throw new ApiError(400, "invalid_field", t("error.field_pattern", { label: name }));
	}
	return trimmed;
}

export function optionalString(
	obj: Record<string, unknown>,
	key: string,
	options: BaseOptions,
	t: Translator,
): string | null | undefined {
	const value = obj[key];
	const name = label(t, options.labelKey);
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	if (typeof value !== "string") throw new ApiError(400, "invalid_field", t("error.field_notString", { label: name }));
	const trimmed = value.trim();
	if (options.max && trimmed.length > options.max) {
		throw new ApiError(400, "invalid_field", t("error.field_tooLong", { label: name, max: options.max }));
	}
	return trimmed === "" ? null : trimmed;
}

export function requireNumber(
	obj: Record<string, unknown>,
	key: string,
	options: BaseOptions & { min?: number; max?: number },
	t: Translator,
): number {
	const value = obj[key];
	const name = label(t, options.labelKey);
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
	if (!Number.isFinite(parsed)) throw new ApiError(400, "invalid_field", t("error.field_notNumber", { label: name }));
	if (options.min !== undefined && parsed < options.min) {
		throw new ApiError(400, "invalid_field", t("error.field_min", { label: name, min: options.min }));
	}
	if (options.max !== undefined && parsed > options.max) {
		throw new ApiError(400, "invalid_field", t("error.field_max", { label: name, max: options.max }));
	}
	return parsed;
}

export function optionalNumber(
	obj: Record<string, unknown>,
	key: string,
	options: BaseOptions & { min?: number; max?: number },
	t: Translator,
): number | null | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	return requireNumber(obj, key, options, t);
}

export function requireOneOf<T extends readonly string[]>(
	obj: Record<string, unknown>,
	key: string,
	allowed: T,
	labelKey: string,
	t: Translator,
): T[number] {
	const value = obj[key];
	if (typeof value !== "string" || !allowed.includes(value)) {
		throw new ApiError(
			400,
			"invalid_field",
			t("error.field_enum", { label: label(t, labelKey), allowed: allowed.join(" / ") }),
		);
	}
	return value as T[number];
}

export function requireCurrency(obj: Record<string, unknown>, key: string, t: Translator, labelKey = "field.currency"): string {
	const text = requireString(obj, key, { labelKey, max: 5 }, t).toUpperCase();
	if (!/^[A-Z]{3,5}$/.test(text)) {
		throw new ApiError(400, "invalid_field", t("error.field_currency"));
	}
	return text;
}

export function requireId(value: string | undefined, t: Translator, labelKey = "field.name"): string {
	if (!value || value.length > 64) {
		throw new ApiError(400, "invalid_id", t("error.invalid_id", { label: label(t, labelKey) }));
	}
	return value;
}

export { badRequest };
