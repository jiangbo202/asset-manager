import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION } from "../../src/shared/version";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

interface EntityDiff {
	create: number;
	update: number;
	unchanged: number;
	remove: number;
}

interface PreviewResponse {
	preview: {
		mode: string;
		summary: Record<string, EntityDiff>;
		warnings: string[];
		statementCount: number;
		atomic: boolean;
	};
	applied: { statements: number; atomic: boolean } | null;
}

const account = (id: string, name: string) => ({
	id,
	name,
	kind: "broker",
	market: "us",
	currency: "USD",
	icon_key: "ibkr",
	icon_data: null,
	sort: 0,
	archived: 0,
	note: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
});

const holding = (id: string, accountId: string, overrides: Record<string, unknown> = {}) => ({
	id,
	account_id: accountId,
	class: "stock",
	market: "us",
	symbol: "AAPL",
	name: "苹果",
	currency: "USD",
	qty: 10,
	price: 200,
	avg_cost: 150,
	price_updated_at: "2026-01-02T00:00:00.000Z",
	archived: 0,
	note: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-02T00:00:00.000Z",
	...overrides,
});

function makeBackup(overrides: Record<string, unknown> = {}) {
	return {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		appVersion: "test",
		exportedAt: "2026-09-01T00:00:00.000Z",
		data: {
			accounts: [account("acc-1", "备份券商")],
			holdings: [holding("h-1", "acc-1")],
			priceHistory: [
				{
					id: "ph-1",
					holding_id: "h-1",
					effective_date: "2026-01-02",
					price: 200,
					source: "manual",
					created_at: "2026-01-02T00:00:00.000Z",
				},
			],
			qtyHistory: [
				{
					id: "qh-1",
					holding_id: "h-1",
					effective_date: "2026-01-02",
					qty: 10,
					source: "manual",
					created_at: "2026-01-02T00:00:00.000Z",
				},
			],
			fxRates: [{ base: "USD", quote: "HKD", rate: 7.8, updated_at: "2026-01-01T00:00:00.000Z" }],
			fxRateHistory: [
				{ id: "fxh-1", base: "USD", quote: "HKD", rate: 7.8, changed_at: "2026-01-01T00:00:00.000Z" },
			],
			settings: { display_currency: "USD", schema_version: "1" },
			auditLog: [
				{
					id: "audit-1",
					ts: "2026-01-01T00:00:00.000Z",
					actor: "owner",
					entity: "account",
					entity_id: "acc-1",
					action: "create",
					before_json: null,
					after_json: "{}",
					source: "import",
					note: null,
				},
			],
			...overrides,
		},
	};
}

describe("备份导出 / 导入", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const exportBackup = async () => {
		// 导出接口返回的是 JSON 文本（带 Content-Disposition），测试里直接按对象读
		const response = await call<Record<string, unknown> & { data: Record<string, unknown[]> }>("/api/backup/export", {
			cookie,
		});
		expect(response.status).toBe(200);
		return response.body;
	};

	it("导出包含业务数据，且绝不含凭据与会话", async () => {
		await call("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "我的券商", kind: "broker", currency: "USD" }),
		});

		const file = await exportBackup();
		expect(file.format).toBe(BACKUP_FORMAT);
		expect(file.data.accounts).toHaveLength(1);

		const serialized = JSON.stringify(file);
		expect(serialized).not.toContain("verifier");
		expect(serialized).not.toContain("kdf_salt");
		expect(serialized).not.toContain("am_session");
		expect(file.data).not.toHaveProperty("auth");
		expect(file.data).not.toHaveProperty("sessions");
	});

	it("dryRun 只做校验与差异预览，不写库", async () => {
		const before = await env.DB.prepare("SELECT COUNT(*) AS total FROM accounts").first<{ total: number }>();

		const preview = await call<Envelope<PreviewResponse>>("/api/backup/import?mode=merge&dryRun=true", {
			method: "POST",
			cookie,
			body: JSON.stringify(makeBackup()),
		});

		expect(preview.status).toBe(200);
		expect(preview.body.data.applied).toBeNull();
		expect(preview.body.data.preview.summary.accounts.create).toBe(1);
		expect(preview.body.data.preview.atomic).toBe(true);

		const after = await env.DB.prepare("SELECT COUNT(*) AS total FROM accounts").first<{ total: number }>();
		expect(after?.total).toBe(before?.total);
	});

	it("merge 导入会新增数据，并在再次导入时识别为覆盖", async () => {
		const first = await call<Envelope<PreviewResponse>>("/api/backup/import?mode=merge", {
			method: "POST",
			cookie,
			body: JSON.stringify(makeBackup()),
		});
		expect(first.status).toBe(200);
		expect(first.body.data.applied?.statements).toBeGreaterThan(0);

		const accounts = await call<Envelope<{ items: Array<{ id: string; name: string }> }>>("/api/accounts", { cookie });
		expect(accounts.body.data.items.map((item) => item.id)).toContain("acc-1");

		const second = await call<Envelope<PreviewResponse>>("/api/backup/import?mode=merge&dryRun=true", {
			method: "POST",
			cookie,
			body: JSON.stringify(makeBackup()),
		});
		expect(second.body.data.preview.summary.accounts.create).toBe(0);
		expect(second.body.data.preview.summary.accounts.update).toBe(1);
	});

	it("重复导入不会产生重复的历史与审计记录（INSERT OR IGNORE）", async () => {
		for (let round = 0; round < 2; round += 1) {
			await call("/api/backup/import?mode=merge", {
				method: "POST",
				cookie,
				body: JSON.stringify(makeBackup()),
			});
		}

		const priceRows = await env.DB.prepare("SELECT COUNT(*) AS total FROM price_history WHERE id = 'ph-1'").first<{
			total: number;
		}>();
		const auditRows = await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE id = 'audit-1'").first<{
			total: number;
		}>();
		expect(priceRows?.total).toBe(1);
		expect(auditRows?.total).toBe(1);
	});

	it("replace 导入会清空旧业务数据，但保留操作历史并追加一条记录", async () => {
		// 先造一条"将被清掉"的数据
		await call("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "旧账户", kind: "cash", currency: "USD" }),
		});
		const auditBefore = await call<Envelope<{ total: number }>>("/api/history", { cookie });

		const replace = await call<Envelope<PreviewResponse>>("/api/backup/import?mode=replace", {
			method: "POST",
			cookie,
			body: JSON.stringify(makeBackup()),
		});
		expect(replace.status).toBe(200);

		const accounts = await call<Envelope<{ items: Array<{ id: string }> }>>("/api/accounts", { cookie });
		expect(accounts.body.data.items.map((item) => item.id)).toEqual(["acc-1"]);

		const auditAfter = await call<Envelope<{ total: number }>>("/api/history", { cookie });
		expect(auditAfter.body.data.total).toBeGreaterThan(auditBefore.body.data.total);

		const replaceEntry = await env.DB.prepare(
			"SELECT COUNT(*) AS total FROM audit_log WHERE entity = 'backup' AND action = 'replace'",
		).first<{ total: number }>();
		expect(replaceEntry?.total).toBeGreaterThan(0);
	});

	it("非法备份会被拒绝：格式、版本、引用完整性、枚举与数值", async () => {
		const cases: Array<[string, unknown]> = [
			["format 不对", { ...makeBackup(), format: "something-else" }],
			["schemaVersion 过高", { ...makeBackup(), schemaVersion: BACKUP_SCHEMA_VERSION + 1 }],
			[
				"持仓引用不存在的账户",
				makeBackup({ holdings: [holding("h-1", "not-exist")] }),
			],
			["账户 id 重复", makeBackup({ accounts: [account("acc-1", "A"), account("acc-1", "B")] })],
			["class 非法", makeBackup({ holdings: [holding("h-1", "acc-1", { class: "nft" })] })],
			["价格为负", makeBackup({ holdings: [holding("h-1", "acc-1", { price: -1 })] })],
			["币种非法", makeBackup({ accounts: [{ ...account("acc-1", "A"), currency: "US" }] })],
		];

		for (const [label, payload] of cases) {
			const response = await call("/api/backup/import?mode=merge&dryRun=true", {
				method: "POST",
				cookie,
				body: JSON.stringify(payload),
			});
			expect(response.status, label).toBe(400);
		}
	});

	it("缺少汇率时给出警告（而不是静默按 1:1 处理）", async () => {
		const preview = await call<Envelope<PreviewResponse>>("/api/backup/import?mode=merge&dryRun=true", {
			method: "POST",
			cookie,
			body: JSON.stringify(
				makeBackup({
					fxRates: [],
					holdings: [holding("h-1", "acc-1", { currency: "HKD" })],
				}),
			),
		});
		expect(preview.status).toBe(200);
		expect(preview.body.data.preview.warnings.join(" ")).toContain("HKD");
	});
});
