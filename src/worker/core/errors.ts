import type { Context } from "hono";

/** 统一错误：抛出后由 app.onError 转成 { ok:false, error:{...} } */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;

	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export const badRequest = (message: string, code = "bad_request") => new ApiError(400, code, message);
export const unauthorized = (message = "请先登录") => new ApiError(401, "unauthorized", message);
export const conflict = (message: string, code = "conflict") => new ApiError(409, code, message);
export const notFound = (message = "资源不存在") => new ApiError(404, "not_found", message);

export function ok<T>(c: Context, data: T, status = 200): Response {
	return c.json({ ok: true, data }, status as 200);
}
