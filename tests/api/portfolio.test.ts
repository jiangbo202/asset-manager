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
		expect(data.byClass[0].label).toBe("股票");
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
});
