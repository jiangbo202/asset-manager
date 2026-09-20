import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { getAuth, isInitialized } from "../data/auth.repo";
import { ApiError, unauthorized } from "../core/errors";

/**
 * 已初始化检查：在 setup 完成前，除 /api/auth/* 之外一律拒绝
 * （PRD FR-1.1 / FR-1.8：不存在"线上自助初始化"窗口，必须先有 setup token）
 */
export const requireInitialized = createMiddleware<AppEnv>(async (c, next) => {
	if (!(await isInitialized(c.env.DB))) {
		throw new ApiError(503, "not_initialized", "尚未初始化，请先打开网页完成初始化");
	}
	await next();
});

/** 登录检查（同时强制处理 must_change：未改密码前只能用改密码/登出接口） */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get("session")) throw unauthorized();

	const auth = await getAuth(c.env.DB);
	if (auth?.must_change === 1) {
		const path = new URL(c.req.url).pathname;
		const allowed = ["/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/logout-all"];
		if (!allowed.includes(path)) {
			throw new ApiError(403, "must_change_password", "请先修改初始密码");
		}
	}

	await next();
});
