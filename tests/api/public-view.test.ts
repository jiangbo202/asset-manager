import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthMeDto, Portfolio } from "../../src/shared/api-types";
import { bootstrap, call, clearAll, login } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 「公开只读分享」的安全边界
 *
 * 这是全项目**唯一**一个让数据在没有密码的情况下可见的开关，所以测试的重点不是
 * "能看总览"，而是"除此之外什么都拿不到"：
 *   - 默认关闭（迁移/新库/脏数据都当关闭）
 *   - 只有 GET 白名单三条端点对匿名开放，其余一律 401（含设置、历史、备份、行情刷新）
 *   - 关掉之后立即恢复 401
 *   - 匿名访客拿不到账户备注、拿不到上次登录时间
 * 这里逐个端点断言，白名单一旦被谁放宽，CI 会直接拦下来。
 */
describe("公开只读分享", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const me = async (options: { cookie?: string } = {}) =>
		(await call<Envelope<AuthMeDto>>("/api/auth/me", { cookie: options.cookie })).body.data;

	const setPublicView = async (on: boolean) =>
		await call<Envelope<unknown>>("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ publicView: on }),
		});

	/** 建一笔持仓，这样总览有东西可看 */
	const seedHolding = async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "测试券商", kind: "broker", currency: "USD", market: "us", note: "私人备注" }),
		});
		const accountId = account.body.data.id;
		const holding = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				qty: 10,
				price: 200,
				avgCost: 150,
				note: "成本价是猜的",
			}),
		});
		return { accountId, holdingId: holding.body.data.id };
	};

	it("默认关闭：没登录看不了总览，/api/auth/me 也不会说可以看", async () => {
		await seedHolding();
		const anonymous = await call<Envelope<Portfolio>>("/api/portfolio");
		expect(anonymous.status).toBe(401);

		const data = await me();
		expect(data.authenticated).toBe(false);
		expect(data.publicView).toBe(false);
		// 未登录不该看到上次登录时间
		expect(data.lastLoginAt).toBeNull();
	});

	it("开启后：匿名能看总览（总览页需要的三个端点），数据与登录后一致", async () => {
		await seedHolding();
		await setPublicView(true);

		const anonymous = await call<Envelope<Portfolio>>("/api/portfolio");
		expect(anonymous.status).toBe(200);
		expect(anonymous.body.data.total).toBeCloseTo(2000, 6);

		expect((await call("/api/portfolio/history?range=3M")).status).toBe(200);
		expect((await call("/api/accounts")).status).toBe(200);

		// 与登录后看到的一致（只读视图不是"另一份数据"）
		const authed = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(anonymous.body.data.total).toBeCloseTo(authed.body.data.total, 6);

		const data = await me();
		expect(data.authenticated).toBe(false);
		expect(data.publicView).toBe(true);
	});

	it("开启后：除白名单外一律 401（含写操作、设置、历史、备份、行情刷新）", async () => {
		const { accountId, holdingId } = await seedHolding();
		await setPublicView(true);

		// 方法 + 路径 + 预期；凡是"能改东西 / 能看到私人内容"的都必须拒绝
		const blocked: Array<[string, string, unknown?]> = [
			["POST", "/api/quotes/refresh"],
			["GET", "/api/quotes/status"],
			["GET", "/api/settings"],
			["PUT", "/api/settings", { displayCurrency: "USD" }],
			["GET", "/api/settings/overview"],
			["GET", "/api/settings/fx"],
			["POST", "/api/settings/fx/lookup", { base: "USD", quote: "HKD" }],
			["GET", "/api/history"],
			["GET", "/api/backup"],
			["POST", "/api/backup/export", {}],
			["GET", "/api/holdings"],
			["POST", "/api/holdings", {}],
			["PATCH", `/api/holdings/${holdingId}`, { price: 1 }],
			["DELETE", `/api/holdings/${holdingId}`],
			["POST", "/api/holdings/bulk-price", { items: [] }],
			["GET", "/api/portfolio/snapshots"],
			["POST", "/api/portfolio/snapshots", {}],
			["POST", "/api/accounts", { name: "x", kind: "broker", currency: "USD" }],
			["PATCH", `/api/accounts/${accountId}`, { name: "x" }],
			["DELETE", `/api/accounts/${accountId}`],
			["POST", "/api/auth/change-password", {}],
			// 吊销全部会话必须已登录：否则任何知道地址的人都能把本人反复踢下线
			["POST", "/api/auth/logout-all"],
		];

		for (const [method, path, body] of blocked) {
			const response = await call(path, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			expect([method, path, response.status]).toEqual([method, path, 401]);
		}
	});

	it("匿名登出是无害空操作（只清自己的 cookie），不影响本人会话", async () => {
		await seedHolding();
		await setPublicView(true);

		const anonymous = await call("/api/auth/logout", { method: "POST" });
		expect(anonymous.status).toBe(200);
		// 本人的会话没被牵连
		expect((await call("/api/portfolio", { cookie })).status).toBe(200);
	});

	it("匿名访客看不到账户备注（总览用不到，属于私人内容）", async () => {
		await seedHolding();
		await setPublicView(true);

		const anonymous = await call<Envelope<{ items: Array<{ name: string; note: string | null }> }>>(
			"/api/accounts",
		);
		expect(anonymous.body.data.items[0]?.name).toBe("测试券商");
		expect(anonymous.body.data.items[0]?.note).toBeNull();
		// 本人登录后照旧能看到备注
		const authed = await call<Envelope<{ items: Array<{ note: string | null }> }>>("/api/accounts", { cookie });
		expect(authed.body.data.items[0]?.note).toBe("私人备注");
	});

	it("关掉开关立即恢复 401，已登录的本人不受影响", async () => {
		await seedHolding();
		await setPublicView(true);
		expect((await call("/api/portfolio")).status).toBe(200);

		await setPublicView(false);
		expect((await call("/api/portfolio")).status).toBe(401);
		// 开关只管匿名：本人照常
		expect((await call<Envelope<Portfolio>>("/api/portfolio", { cookie })).status).toBe(200);
	});

	it("匿名无法开启这个开关（只有本人登录后能改）", async () => {
		await seedHolding();
		const response = await call<Envelope<unknown>>("/api/settings", {
			method: "PUT",
			body: JSON.stringify({ publicView: true }),
		});
		expect(response.status).toBe(401);
		expect((await me()).publicView).toBe(false);
	});

	it("登录照旧要密码：错误密码拿不到完整权限", async () => {
		await seedHolding();
		await setPublicView(true);

		const wrong = await login("wrong-password");
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		// 拿不到会话 cookie，就还是访客
		expect((await call("/api/settings")).status).toBe(401);

		const right = await login();
		expect(right.cookie).toBeTruthy();
		expect((await call("/api/settings", { cookie: right.cookie })).status).toBe(200);
	});

	it("未初始化时不因为'公开分享'就放行（初始化窗口不能出现）", async () => {
		await clearAll();
		// 没初始化：portfolio 应该是"未初始化"而不是"可以匿名看"
		const response = await call<Envelope<Portfolio>>("/api/portfolio");
		expect(response.status).toBeGreaterThanOrEqual(401);
		expect(response.status).not.toBe(200);
	});

	it("脏数据当作关闭：settings 里写了别的值也不放行", async () => {
		await seedHolding();
		await env.DB.prepare(
			`INSERT INTO settings (key, value) VALUES ('public_view', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`,
		).run();
		expect((await call("/api/portfolio")).status).toBe(401);
		expect((await me()).publicView).toBe(false);
	});
});
