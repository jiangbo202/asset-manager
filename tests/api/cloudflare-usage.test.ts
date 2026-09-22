import { describe, expect, it } from "vitest";
import {
	describeCloudflareError,
	fetchCloudflareUsage,
	pickDatabase,
	sumD1Rows,
	sumWorkerRequests,
	utcDayStart,
} from "../../src/worker/services/cloudflare-usage";

/**
 * Cloudflare 用量读取（外部 API，全部用假 fetch）
 *
 * 这段逻辑有几个容易错的地方，所以都钉住：
 *   1. 统计窗口必须是 **UTC 日**（免费额度按 UTC 零点重置，用本地时区会算错）
 *   2. Analytics 返回的行数不定，得逐行求和而不是只看第一行
 *   3. D1 库要先按名字找 id，找不到 id 就查不了用量（别静默返回 0）
 *   4. Token 无效要给出"缺哪两项权限"的提示，而不是抛一堆 JSON
 */
describe("Cloudflare 用量读取", () => {
	it("统计窗口是 UTC 当天零点（不是本地零点）", () => {
		const start = utcDayStart(new Date("2026-09-22T15:30:00+08:00"));
		expect(start.toISOString()).toBe("2026-09-22T00:00:00.000Z");
	});

	it("Analytics 行数不定：逐行求和，没有行时返回 null 而不是 0", () => {
		expect(sumWorkerRequests({ viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } })).toBeNull();
		expect(
			sumWorkerRequests({
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [
								{ sum: { requests: 300 } },
								{ sum: { requests: 200 } },
							],
						},
					],
				},
			}),
		).toBe(500);

		expect(sumD1Rows({ viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } })).toEqual({
			rowsRead: null,
			rowsWritten: null,
		});
		expect(
			sumD1Rows({
				viewer: {
					accounts: [
						{
							d1AnalyticsAdaptiveGroups: [
								{ sum: { rowsRead: 40_000, rowsWritten: 12 } },
								{ sum: { rowsRead: 1_000, rowsWritten: 3 } },
							],
						},
					],
				},
			}),
		).toEqual({ rowsRead: 41_000, rowsWritten: 15 });
	});

	it("D1 库：按名字匹配；只有一个库时直接用；多个又都没匹配上则不给（避免查错库）", () => {
		const rows = [
			{ uuid: "a", name: "asset-manager-db" },
			{ uuid: "b", name: "other-db" },
		];
		expect(pickDatabase(rows, "other-db")?.uuid).toBe("b");
		expect(pickDatabase(rows, "not-there")).toBeNull();
		expect(pickDatabase([{ uuid: "only", name: "whatever" }], "asset-manager-db")?.uuid).toBe("only");
		expect(pickDatabase([], "asset-manager-db")).toBeNull();
	});

	it("Token 权限不足的提示要点明缺哪两项权限", () => {
		expect(describeCloudflareError(403, "{}")).toContain("Account Analytics: Read");
		expect(describeCloudflareError(401, "{}")).toContain("D1: Read");
		expect(describeCloudflareError(500, '{"errors":[{"message":"boom"}]}')).toContain("boom");
	});

	it("完整抓取：3 次请求（库列表 → Workers 分析 + D1 分析 → 库大小），数字与窗口都对", async () => {
		const calls: Array<{ url: string; body?: string }> = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
			if (url.includes("/d1/database?") || url.endsWith("/d1/database")) {
				return Response.json({ result: [{ uuid: "db-1", name: "asset-manager-db" }] });
			}
			if (url.endsWith("/d1/database/db-1?fields=uuid,name,file_size")) {
				return Response.json({ result: { uuid: "db-1", name: "asset-manager-db", file_size: 12_345_678 } });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes("workersInvocationsAdaptive")) {
				return Response.json({
					data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 512 } }] }] } },
				});
			}
			return Response.json({
				data: {
					viewer: {
						accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 42_000, rowsWritten: 90 } }] }],
					},
				},
			});
		}) as unknown as typeof fetch;

		const usage = await fetchCloudflareUsage(
			{
				token: "test-token",
				accountId: "acct-1",
				scriptName: "asset-manager",
				databaseName: "asset-manager-db",
				fetcher,
			},
			new Date("2026-09-22T10:00:00.000Z"),
		);

		expect(usage.requests).toBe(512);
		expect(usage.rowsRead).toBe(42_000);
		expect(usage.rowsWritten).toBe(90);
		expect(usage.database).toEqual({ id: "db-1", name: "asset-manager-db", fileSize: 12_345_678 });
		expect(usage.windowStart).toBe("2026-09-22T00:00:00.000Z");
		expect(usage.windowEnd).toBe("2026-09-22T10:00:00.000Z");
		// Analytics 用的是日期（YYYY-MM-DD），Workers 用的是时间戳
		const analyticsBody = calls.find((call) => call.body?.includes("d1AnalyticsAdaptiveGroups"))?.body ?? "";
		expect(analyticsBody).toContain('"start":"2026-09-22"');
		expect(calls.every((call) => call.url.startsWith("https://api.cloudflare.com/client/v4/"))).toBe(true);
	});

	it("Token 无效：整次抓取失败并给出可操作的提示（不吞错误）", async () => {
		const fetcher = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
		await expect(
			fetchCloudflareUsage({
				token: "bad",
				accountId: "acct-1",
				scriptName: "asset-manager",
				databaseName: "asset-manager-db",
				fetcher,
			}),
		).rejects.toThrow(/Account Analytics: Read/);
	});

	it("库大小拿不到不影响其它数字（例如少了 D1: Read）", async () => {
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/d1/database")) {
				if (url.includes("?fields=")) return new Response("{}", { status: 403 });
				return Response.json({ result: [{ uuid: "db-1", name: "asset-manager-db" }] });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes("workersInvocationsAdaptive")) {
				return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
			}
			return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } });
		}) as unknown as typeof fetch;

		const usage = await fetchCloudflareUsage({
			token: "t",
			accountId: "a",
			scriptName: "asset-manager",
			databaseName: "asset-manager-db",
			fetcher,
		});
		expect(usage.database?.fileSize).toBeNull();
		expect(usage.database?.id).toBe("db-1");
		expect(usage.requests).toBeNull();
	});
});
