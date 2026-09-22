import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthMeDto, Portfolio } from "../../src/shared/api-types";
import { bootstrap, call, clearAll, login, TEST_ITERATIONS } from "../helpers";

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
			// 会话列表里有 IP 与真实设备，绝不能公开
			["GET", "/api/settings/sessions"],
			["DELETE", `/api/settings/sessions/${"a".repeat(64)}`],
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

/**
 * 首次部署的顺序（提问："是不是先输密码登录，之后才是公开只读"）
 *
 * 必须是这个顺序，而且要在两个层面都成立：
 *   界面：未初始化 → 初始化页；已初始化未登录 → 开关开着才给只读总览，否则登录页
 *   服务端：未初始化一律 503（requireInitialized 在公开放行**之前**），
 *          所以就算数据库里被人预先塞了 public_view=1 也开不了门
 */
describe("首次部署：公开只读不会抢在初始化/登录之前", () => {
	beforeEach(async () => {
		await clearAll();
	});

	const me = async (cookie?: string) =>
		(await call<Envelope<AuthMeDto>>("/api/auth/me", { cookie })).body.data;

	it("全新数据库：界面停在初始化页，开关视为关闭", async () => {
		const data = await me();
		expect(data.initialized).toBe(false);
		expect(data.authenticated).toBe(false);
		expect(data.publicView).toBe(false);
	});

	it("初始化之前：接口一律 503，拿不到任何数据（也不能提前打开开关）", async () => {
		// 未初始化时 /api/portfolio 是 503（not_initialized），不是 401、更不是 200
		const portfolio = await call("/api/portfolio");
		expect(portfolio.status).toBe(503);

		// 匿名尝试提前打开开关：同样被 requireInitialized 拦下
		const attempt = await call("/api/settings", {
			method: "PUT",
			body: JSON.stringify({ publicView: true }),
		});
		expect(attempt.status).toBe(503);
	});

	it("即使数据库里被预先塞了 public_view=1，未初始化也打不开", async () => {
		await env.DB.prepare(
			`INSERT INTO settings (key, value) VALUES ('public_view', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`,
		).run();

		// 开关是"开"的，但没有初始化 → 依然 503，也不会进只读总览
		expect((await call("/api/portfolio")).status).toBe(503);
		const data = await me();
		expect(data.initialized).toBe(false);
	});

	it("初始化：token 不对直接 401", async () => {
		const response = await call("/api/auth/setup", {
			method: "POST",
			body: JSON.stringify({
				setupToken: "wrong-token",
				credential: "x".repeat(64),
				kdfSalt: "a".repeat(32),
				iterations: TEST_ITERATIONS,
			}),
		});
		expect(response.status).toBe(401);
		expect((await me()).initialized).toBe(false);
	});

	it("初始化成功后就是已登录状态：不用再输一次密码，也没有 must_change 拦路", async () => {
		const { cookie } = await bootstrap();
		const data = await me(cookie);
		expect(data.initialized).toBe(true);
		expect(data.authenticated).toBe(true);
		expect(data.mustChange).toBe(false);
		// 刚初始化完就是本人权限：设置能读、总览能看、公开开关默认还是关的
		expect(data.publicView).toBe(false);
		expect((await call("/api/settings", { cookie })).status).toBe(200);
		expect((await call("/api/portfolio", { cookie })).status).toBe(200);
	});

	it("初始化后未登录：看到的是登录页（开关默认关），不是只读总览", async () => {
		await bootstrap();
		// 清掉 cookie 模拟新访客
		const data = await me();
		expect(data.authenticated).toBe(false);
		expect(data.publicView).toBe(false);
		expect((await call("/api/portfolio")).status).toBe(401);
	});

	it("完整顺序走一遍：初始化 → 本人登录 → 打开开关 → 访客可看 → 关掉即恢复", async () => {
		// ① 初始化（此时已登录）
		const { cookie } = await bootstrap();
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us", note: "私人" }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				qty: 10,
				price: 100,
			}),
		});

		// ② 未开开关：访客必须登录
		expect((await call("/api/portfolio")).status).toBe(401);

		// ③ 本人打开开关
		expect(
			(
				await call("/api/settings", {
					method: "PUT",
					cookie,
					body: JSON.stringify({ publicView: true }),
				})
			).status,
		).toBe(200);

		// ④ 访客能看总览，但看不到备注、也刷不了行情
		const anonymous = await call<Envelope<Portfolio>>("/api/portfolio");
		expect(anonymous.status).toBe(200);
		expect(anonymous.body.data.total).toBeCloseTo(1000, 6);
		expect((await call("/api/quotes/refresh", { method: "POST" })).status).toBe(401);

		// ⑤ 关掉开关：立刻回到必须登录
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ publicView: false }) });
		expect((await call("/api/portfolio")).status).toBe(401);
	});});

/**
 * 分区分享：可以只公开总览的一部分（开头 / 走势 / 分布 / 持仓明细）
 *
 * 这里的重点同样是"边界"：前端隐藏区域只是界面礼貌，接口裁剪才是真的。
 * 所以断言直接搜**原始响应文本** —— 不分享明细时，数量与成本不能出现在字节里。
 */
describe("分区分享", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	/** 一笔数量与成本都很特别的持仓：便于在原始响应里搜它有没有泄露 */
	const seed = async () => {
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us" }),
		});
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				// 指纹用"6 位数量 + 小数点成本"：不会和 ISO 时间戳里的数字撞车，
				// 这样可以放心地直接搜原始响应文本
				qty: 987654,
				price: 1.23,
				avgCost: 333333.21,
			}),
		});
	};

	const setSections = async (sections: string[], publicView = true) =>
		await call<Envelope<unknown>>("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ publicView, publicSections: sections }),
		});

	/** 匿名请求的原始响应文本（用于确认"字节里没有"） */
	const rawAnonymous = async (path: string) => {
		const response = await SELF.fetch(`https://example.com${path}`);
		return { status: response.status, text: await response.text() };
	};

	const anonymousPortfolio = async () => {
		const response = await call<Envelope<Portfolio>>("/api/portfolio");
		expect(response.status).toBe(200);
		return response.body.data;
	};

	it("打开开关但没指定区域：默认全部分享（最不容易让人意外）", async () => {
		await seed();
		await call("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ publicView: true }) });

		const me = (await call<Envelope<AuthMeDto>>("/api/auth/me")).body.data;
		expect(me.publicSections).toEqual(["summary", "trend", "breakdown", "holdings"]);

		const data = await anonymousPortfolio();
		expect(data.total).toBeCloseTo(1_214_814.42, 2);
		expect(data.byClass.length).toBeGreaterThan(0);
		expect(data.holdings[0]?.qty).toBe(987654);
		expect((await call("/api/portfolio/history")).status).toBe(200);
	});

	it("只分享开头：分布与明细都不返回，走势与账户接口 401", async () => {
		await seed();
		await setSections(["summary"]);

		const data = await anonymousPortfolio();
		expect(data.total).toBeCloseTo(1_214_814.42, 2);
		expect(data.counts.holdings).toBe(1);
		expect(data.byClass).toEqual([]);
		expect(data.byAccount).toEqual([]);
		expect(data.byCurrency).toEqual([]);
		expect(data.holdings).toEqual([]);

		expect((await call("/api/portfolio/history")).status).toBe(401);
		expect((await call("/api/accounts")).status).toBe(401);
	});

	it("只分享分布：接口保留画图字段，但数量与成本不出现在响应字节里", async () => {
		await seed();
		await setSections(["breakdown"]);

		const displayed = await anonymousPortfolio();
		// 总资产被裁掉了（没分享开头）
		expect(displayed.total).toBe(0);
		expect(displayed.staleDays).toBeNull();
		expect(displayed.byClass.length).toBeGreaterThan(0);

		// 但画图要用的字段还在：否则环形图与 treemap 会缺一块
		const item = displayed.holdings[0];
		expect(item?.symbol).toBe("AAPL");
		expect(item?.accountName).toBe("券商");
		expect(item?.marketValueDisplay).toBeCloseTo(1_214_814.42, 2);
		expect(item?.share).toBeCloseTo(100, 1);

		// 明细字段一律抹平
		expect(item?.qty).toBe(0);
		expect(item?.avgCost).toBeNull();
		expect(item?.cost).toBeNull();
		expect(item?.pnl).toBeNull();
		expect(item?.costDisplay).toBeNull();

		// 最硬的一条：原始响应里不该出现数量与成本这几个数字
		const raw = await rawAnonymous("/api/portfolio");
		expect(raw.text).not.toContain("987654"); // 数量
		expect(raw.text).not.toContain("333333"); // 平均成本

		// 走势没分享 → 401；账户名用于分布 → 放行
		expect((await call("/api/portfolio/history")).status).toBe(401);
		expect((await call("/api/accounts")).status).toBe(200);
	});

	it("只分享持仓明细：分布为空，但明细数字齐全", async () => {
		await seed();
		await setSections(["holdings"]);

		const data = await anonymousPortfolio();
		expect(data.byClass).toEqual([]);
		expect(data.holdings[0]?.qty).toBe(987654);
		expect(data.holdings[0]?.avgCost).toBe(333333.21);
		expect(data.total).toBe(0); // 开头没分享
		// 明细表要显示"占市值多少"，所以 share 仍由服务端算好给出
		expect(data.holdings[0]?.share).toBeCloseTo(100, 1);
	});

	it("只分享走势：总览接口整体 401，走势 200", async () => {
		await seed();
		await setSections(["trend"]);

		expect((await call("/api/portfolio")).status).toBe(401);
		expect((await call("/api/accounts")).status).toBe(401);
		expect((await call("/api/portfolio/history")).status).toBe(200);
	});

	it("多个区域可以叠加，且只有勾选的生效", async () => {
		await seed();
		await setSections(["trend", "holdings"]);

		const data = await anonymousPortfolio();
		expect(data.byClass).toEqual([]); // 未勾选分布
		expect(data.holdings[0]?.qty).toBe(987654); // 勾了明细
		expect(data.total).toBe(0); // 未勾选开头
		expect((await call("/api/portfolio/history")).status).toBe(200);
	});

	it("关掉开关后与分区无关：一律 401", async () => {
		await seed();
		await setSections(["summary", "trend"], false);
		expect((await call("/api/portfolio")).status).toBe(401);
		expect((await call("/api/portfolio/history")).status).toBe(401);
		expect((await call("/api/accounts")).status).toBe(401);
	});

	it("非法或空的分区被拒绝（不静默存进去，否则用户以为勾上了）", async () => {
		await seed();
		expect((await setSections(["summary", "nope"])).status).toBe(400);
		expect((await setSections([])).status).toBe(400);
		// 拒绝之后设置没被改动：默认仍是全部
		const me = (await call<Envelope<AuthMeDto>>("/api/auth/me", { cookie })).body.data;
		expect(me.publicSections).toEqual(["summary", "trend", "breakdown", "holdings"]);
	});

	it("存了脏值：解析成空集合 → 分区接口一律 401（不放宽）", async () => {
		await seed();
		await setSections(["summary"]);
		await env.DB.prepare(`UPDATE settings SET value = 'bogus' WHERE key = 'public_sections'`).run();

		expect((await call("/api/portfolio")).status).toBe(401);
		expect((await call("/api/portfolio/history")).status).toBe(401);
	});

	it("本人登录后永远看全（分区只影响匿名访客）", async () => {
		await seed();
		await setSections(["summary"]);

		const authed = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(authed.body.data.total).toBeCloseTo(1_214_814.42, 2);
		expect(authed.body.data.byClass.length).toBeGreaterThan(0);
		expect(authed.body.data.holdings[0]?.qty).toBe(987654);
		expect((await call("/api/portfolio/history", { cookie })).status).toBe(200);
	});
});
