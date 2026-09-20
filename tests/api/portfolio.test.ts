import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccountDto, HoldingDto, Portfolio } from "../../src/shared/api-types";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

describe("账户 / 持仓 / 组合视图", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const createAccount = async (body: Record<string, unknown> = {}) => {
		const response = await call<Envelope<AccountDto>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "测试券商", kind: "broker", currency: "USD", market: "us", ...body }),
		});
		expect(response.status).toBe(201);
		return response.body.data;
	};

	const createHolding = async (accountId: string, body: Record<string, unknown> = {}) => {
		const response = await call<Envelope<HoldingDto>>("/api/holdings", {
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
				...body,
			}),
		});
		expect(response.status).toBe(201);
		return response.body.data;
	};

	it("创建账户与持仓后，组合视图能算出市值、成本与盈亏", async () => {
		const account = await createAccount();
		await createHolding(account.id);

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(portfolio.status).toBe(200);
		const data = portfolio.body.data;

		expect(data.displayCurrency).toBe("USD");
		expect(data.total).toBeCloseTo(2000, 2);
		expect(data.counts.holdings).toBe(1);
		expect(data.holdings[0].pnl).toBeCloseTo(500, 2);
		// v0.12 起 byClass 只返回原始 key，具体文案由前端按语言翻译
		expect(data.byClass[0].key).toBe("stock");
		expect(data.byClass[0].label).toBe("stock");
	});

	it("缺少汇率时不按 1:1 处理，而是标记未折算并从总额中排除", async () => {
		const account = await createAccount({ currency: "HKD" });
		await createHolding(account.id, { currency: "HKD", qty: 1000, price: 1, class: "cash", symbol: null });

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		const data = portfolio.body.data;

		expect(data.total).toBe(0);
		expect(data.missingFxCurrencies).toContain("HKD");
		expect(data.holdings[0].fxMissing).toBe(true);
	});

	it("汇率存在时按汇率折算", async () => {
		await call("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "USD", quote: "HKD", rate: 7.8 }),
		});
		const account = await createAccount({ currency: "HKD" });
		await createHolding(account.id, { currency: "HKD", class: "cash", symbol: null, qty: 7800, price: 1, avgCost: null });

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(portfolio.body.data.total).toBeCloseTo(1000, 2);
	});

	it("修改价格会写入 price_history 与审计日志", async () => {
		const account = await createAccount();
		const holding = await createHolding(account.id);

		const updated = await call<Envelope<HoldingDto>>(`/api/holdings/${holding.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ price: 250 }),
		});
		expect(updated.status).toBe(200);
		expect(updated.body.data.price).toBe(250);
		expect(updated.body.data.price_updated_at).not.toBeNull();

		const priceRows = await env.DB.prepare(`SELECT price FROM price_history WHERE holding_id = ? ORDER BY created_at`)
			.bind(holding.id)
			.all<{ price: number }>();
		expect(priceRows.results?.map((row) => row.price)).toEqual([200, 250]);

		const audit = await call<Envelope<{ total: number; items: Array<{ entity: string; diff: unknown[] }> }>>(
			"/api/history",
			{ cookie },
		);
		expect(audit.body.data.total).toBeGreaterThanOrEqual(2);
		const holdingUpdate = audit.body.data.items.find((item) => item.entity === "holding");
		expect(holdingUpdate?.diff.length).toBeGreaterThan(0);
	});

	it("删除仍有持仓的账户会被拒绝，除非显式级联", async () => {
		const account = await createAccount();
		await createHolding(account.id);

		const blocked = await call(`/api/accounts/${account.id}`, { method: "DELETE", cookie });
		expect(blocked.status).toBe(409);

		const cascade = await call(`/api/accounts/${account.id}?cascadeHoldings=true`, { method: "DELETE", cookie });
		expect(cascade.status).toBe(200);

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(portfolio.body.data.counts.holdings).toBe(0);
	});

	it("批量更新价格只写变化的记录", async () => {
		const account = await createAccount();
		const first = await createHolding(account.id, { symbol: "AAPL" });
		const second = await createHolding(account.id, { symbol: "VOO", name: "标普500 ETF" });

		const result = await call<Envelope<{ updated: number }>>("/api/holdings/bulk-price", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				items: [
					{ id: first.id, price: 210 },
					{ id: second.id, price: 200 },
				],
			}),
		});
		expect(result.status).toBe(200);
		expect(result.body.data.updated).toBe(1);
	});

	it("非法输入被拒绝（负数价格、不存在的账户）", async () => {
		const account = await createAccount();
		const badPrice = await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.id,
				class: "stock",
				name: "x",
				currency: "USD",
				qty: 1,
				price: -5,
			}),
		});
		expect(badPrice.status).toBe(400);

		const badAccount = await call("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: "not-exist",
				class: "stock",
				name: "x",
				currency: "USD",
				qty: 1,
				price: 5,
			}),
		});
		expect(badAccount.status).toBe(400);
	});

	it("归档账户后其持仓不再计入总额，恢复后重新计入", async () => {
		const account = await createAccount();
		await createHolding(account.id);

		const before = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(before.body.data.total).toBeCloseTo(2000, 2);

		await call(`/api/accounts/${account.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ archived: true }),
		});
		const archived = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(archived.body.data.total).toBe(0);
		expect(archived.body.data.counts.holdings).toBe(0);

		// 归档数据仍在库里，可在「显示已归档」里找回
		const listed = await call<Envelope<{ items: unknown[] }>>("/api/holdings?includeArchived=true", { cookie });
		expect(listed.body.data.items.length).toBe(1);

		await call(`/api/accounts/${account.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ archived: false }),
		});
		const restored = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		expect(restored.body.data.total).toBeCloseTo(2000, 2);
	});

	it("多币种的成本与盈亏按汇率折算后再汇总（不能直接相加）", async () => {
		await call("/api/settings/fx", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ base: "USD", quote: "HKD", rate: 7.8 }),
		});

		const usdAccount = await createAccount();
		await createHolding(usdAccount.id, { qty: 10, price: 200, avgCost: 150 });

		const hkdAccount = await createAccount({ name: "港股券商", currency: "HKD" });
		await createHolding(hkdAccount.id, {
			symbol: "0700.HK",
			name: "腾讯控股",
			currency: "HKD",
			qty: 100,
			price: 600,
			avgCost: 500,
		});

		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio", { cookie });
		const data = portfolio.body.data;

		const costTotal = data.holdings.reduce((sum, item) => sum + (item.costDisplay ?? 0), 0);
		const pnlTotal = data.holdings.reduce((sum, item) => sum + (item.pnlDisplay ?? 0), 0);

		expect(data.total).toBeCloseTo(2000 + 60000 / 7.8, 2);
		expect(costTotal).toBeCloseTo(1500 + 50000 / 7.8, 2);
		expect(pnlTotal).toBeCloseTo(500 + 10000 / 7.8, 2);
	});

	it("市场筛选支持多选（FR-6.3）", async () => {
		const usAccount = await createAccount();
		await createHolding(usAccount.id, { symbol: "AAPL", market: "us" });

		const hkAccount = await createAccount({ name: "港股券商", currency: "HKD", market: "hk" });
		await createHolding(hkAccount.id, { symbol: "0700.HK", name: "腾讯", currency: "HKD", market: "hk" });

		const both = await call<Envelope<{ items: unknown[] }>>("/api/holdings?market=us,hk", { cookie });
		expect(both.body.data.items.length).toBe(2);

		const onlyUs = await call<Envelope<{ items: unknown[] }>>("/api/holdings?market=us", { cookie });
		expect(onlyUs.body.data.items.length).toBe(1);

		const onlyCn = await call<Envelope<{ items: unknown[] }>>("/api/holdings?market=cn", { cookie });
		expect(onlyCn.body.data.items.length).toBe(0);

		// 非法值被忽略（等同于不筛选）
		const invalid = await call<Envelope<{ items: unknown[] }>>("/api/holdings?market=nope", { cookie });
		expect(invalid.body.data.items.length).toBe(2);

		// 组合视图同样支持
		const portfolio = await call<Envelope<Portfolio>>("/api/portfolio?market=us", { cookie });
		expect(portfolio.body.data.counts.holdings).toBe(1);
	});

	it("操作历史支持按日期区间筛选", async () => {
		await createAccount();

		const all = await call<Envelope<{ total: number }>>("/api/history", { cookie });
		expect(all.body.data.total).toBeGreaterThan(0);

		const future = await call<Envelope<{ total: number }>>(
			"/api/history?from=2099-01-01T00:00:00.000Z",
			{ cookie },
		);
		expect(future.body.data.total).toBe(0);

		const past = await call<Envelope<{ total: number }>>("/api/history?to=2000-01-01T00:00:00.000Z", { cookie });
		expect(past.body.data.total).toBe(0);

		const today = await call<Envelope<{ total: number }>>(
			`/api/history?from=${new Date(Date.now() - 86_400_000).toISOString()}`,
			{ cookie },
		);
		expect(today.body.data.total).toBeGreaterThan(0);
	});
});
