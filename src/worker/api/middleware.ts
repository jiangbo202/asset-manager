import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { ApiError, unauthorized } from "../core/errors";
import { getSettings, publicSectionsOf, publicViewOf } from "../data/settings.repo";
import type { PublicSection } from "../../shared/public-sections";

/**
 * 已初始化检查：在 setup 完成前，除 /api/auth/* 之外一律拒绝
 * （PRD FR-1.1 / FR-1.8：不存在"线上自助初始化"窗口，必须先有 setup token）
 *
 * auth 行由 app.ts 的上下文中间件与会话一起读出（一次 batch），这里不再查库：
 * "auth 行存在"就是"已初始化"。
 */
export const requireInitialized = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get("auth")) {
		throw new ApiError(503, "not_initialized", "尚未初始化，请先打开网页完成初始化");
	}
	await next();
});

/**
 * 公开只读分享**允许匿名访问的端点**（白名单）
 *
 * 为什么用白名单而不是黑名单：这个开关让数据在没有密码的情况下可见，
 * 一旦写错方向，泄露的可能是备份、设置里的数据源 Key、操作历史里的一切。
 * 白名单只有三行、且都在这里，评审时一眼能看完；漏写一个端点 = 匿名拿不到，
 * 而不是匿名全拿得到。
 *
 * 这三条正好覆盖「总览」页的全部请求：
 *   - /api/portfolio         总资产、分布、持仓明细
 *   - /api/portfolio/history 走势图
 *   - /api/accounts          分布图与筛选器里的账户名
 * 注意：都是 GET。写操作、设置、历史、备份、行情刷新**永远**需要登录。
 */
export const PUBLIC_READ_ROUTES: Readonly<Record<string, readonly PublicSection[]>> = {
	// 这个接口同时供开头 / 分布 / 明细三个区域使用，命中任意一个即放行，
	// 具体返回哪些内容由路由按分区裁剪（见 publicProjection）
	"GET /api/portfolio": ["summary", "breakdown", "holdings"],
	"GET /api/portfolio/history": ["trend"],
	"GET /api/accounts": ["breakdown"],
};

/** must_change 未完成时只放行改密码/登出（未改密码前进不了设置页，所以也就开不了公开分享） */
function enforceMustChange(c: { get: (key: "auth") => { must_change: number } | null }, path: string): void {
	if (c.get("auth")?.must_change !== 1) return;
	const allowed = ["/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/logout-all"];
	if (!allowed.includes(path)) throw new ApiError(403, "must_change_password", "请先修改初始密码");
}

/** 登录检查（同时强制处理 must_change：未改密码前只能用改密码/登出接口） */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get("session")) throw unauthorized();
	// auth 行已在上下文里读好（见上），不必再查一次
	enforceMustChange(c, new URL(c.req.url).pathname);
	await next();
});

/**
 * 登录检查 + 公开只读放行（只用在挂了公开端点的路由上）
 *
 * 开启「公开只读分享」后，未登录的访客可以读总览；其余一律 401。
 * 判定顺序刻意如此：
 *   1. 有会话 → 等同 requireAuth（本人权限，不受开关影响）
 *   2. 没会话 → 必须在白名单里、且开关是开的（多读一次设置，只有匿名请求才付这个成本）
 *   3. 其余 → 401
 * 被放行的访客会带上下文的 publicViewer 标记，路由据此做脱敏（例如不返回账户备注）。
 */
export const requireAuthOrPublicRead = createMiddleware<AppEnv>(async (c, next) => {
	const path = new URL(c.req.url).pathname;

	if (c.get("session")) {
		enforceMustChange(c, path);
		await next();
		return;
	}

	const required = PUBLIC_READ_ROUTES[`${c.req.method.toUpperCase()} ${path}`];
	// 只有"白名单端点"才值得去读设置：非白名单直接 401，省掉这次查询
	if (!required) throw unauthorized();

	const settings = await getSettings(c.env.DB);
	const sections = publicSectionsOf(settings);
	// 开关关着 → 全部 401；开关开着但没勾这个区域 → 也 401（白名单 + 分区两道门）
	if (!publicViewOf(settings) || !required.some((section) => sections.includes(section))) throw unauthorized();

	c.set("publicViewer", true);
	c.set("publicSections", sections);
	await next();
});
