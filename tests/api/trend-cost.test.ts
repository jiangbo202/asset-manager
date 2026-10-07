import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrendPoint } from "../../src/shared/api-types";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/**
 * 走势图里的浮动盈亏
 *
 * 悬停提示要显示"那一天赚了多少"，而浮动盈亏 = 当日总额 − 当日成本，
 * 所以快照必须把成本一起记下来。三个要钉住的点：
 *   1. 成本按**当日冻结汇率**折算 —— 与总额同口径，否则盈亏里会混进汇率变动
 *   2. 历史快照没记成本（字段是后加的）→ 按“成本 = 总额”填充，即盈亏 0（用户要求显示 0 而不是「—」）
 *   3. 公开分享未包含持仓明细时，成本被抹成 null（裁剪发生在填充之后，所以访客不会看到那个 0）
 */

/** 快照 + 一只 10 股 @120、成本 100 的股票：市值 1200、成本 1000、浮动盈亏 +200 */
const seed = async (cookie: string) => {
	const account = await call<Envelope<{ id: string }>>("/api/accounts", {
		method: "POST",
		cookie,
		body: JSON.stringify({ name: "测试券商", kind: "broker", currency: "USD", market: "us" }),
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
			price: 120,
			avgCost: 100,
		}),
	});
	await call("/api/portfolio/snapshots", { method: "POST", cookie, body: JSON.stringify({}) });
};

const trend = async (cookie?: string) =>
	await call<Envelope<{ points: TrendPoint[] }>>("/api/portfolio/history?range=1M", cookie ? { cookie } : {});

describe("走势图的浮动盈亏（当日总额 − 当日成本）", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	it("快照记下当日成本，走势接口据此能算出浮动盈亏", async () => {
		await seed(cookie);
		const series = await trend(cookie);
		const point = series.body.data.points.at(-1);

		expect(point?.total).toBe(1200);
		expect(point?.cost).toBe(1000);
		// 悬停里要显示的就是这两个数之差，与统计卡的「浮动盈亏」是同一个口径
		expect((point?.total ?? 0) - (point?.cost ?? 0)).toBe(200);
	});

	it("公开分享未包含持仓明细时抹掉成本（成本与明细同级敏感）", async () => {
		await seed(cookie);
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ publicView: true, publicSections: ["summary", "trend"] }),
		});

		const anon = await trend();
		const point = anon.body.data.points.at(-1);
		// 总额仍然给（走势本来就是分享的区域），成本不给：
		// 注意这个裁剪发生在“历史填充”之后，所以访客不会看到被填成 0 的盈亏
		expect(point?.total).toBe(1200);
		expect(anon.body.data.points.every((row) => row.cost === null)).toBe(true);

		// 分享明细时才带上成本
		await call("/api/settings", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ publicView: true, publicSections: ["summary", "trend", "holdings"] }),
		});
		const shared = await trend();
		expect(shared.body.data.points.at(-1)?.cost).toBe(1000);
	});

	it("历史快照没有成本字段 → 按「成本 = 总额」填充，即盈亏 0（不显示「—」）", async () => {
		await seed(cookie);
		// 模拟旧版本写入的明细：只有 v，没有 cost
		await env.DB.prepare(`UPDATE snapshots SET detail_json = ?`)
			.bind(JSON.stringify([{ i: "h1", a: "acc-1", c: "stock", u: "USD", m: "us", v: 1200 }]))
			.run();

		const series = await trend(cookie);
		const point = series.body.data.points.at(-1);
		expect(point?.total).toBe(1200);
		// 填充口径：成本 = 总额，所以悬停里显示 0 而不是「—」
		expect(point?.cost).toBe(1200);
		expect((point?.total ?? 0) - (point?.cost ?? 0)).toBe(0);
	});

	it("没填成本的持仓不进成本合计（否则等于宣称成本为零）", async () => {
		await seed(cookie);
		// 再来一条没有平均成本的持仓（现金就是这种情况）
		const holdings = await call<Envelope<{ items: Array<{ id: string; account_id: string }> }>>("/api/holdings", {
			cookie,
		});
		const accountId = holdings.body.data.items[0].account_id;
		await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId,
				class: "cash",
				name: "美元现金",
				currency: "USD",
				qty: 500,
				price: 1,
			}),
		});
		await call("/api/portfolio/snapshots", { method: "POST", cookie, body: JSON.stringify({}) });

		const series = await trend(cookie);
		const point = series.body.data.points.at(-1);
		expect(point?.total).toBe(1700); // 1200 + 500 现金
		expect(point?.cost).toBe(1000); // 现金不贡献成本
	});
});
