import { describe, expect, it } from "vitest";
import { classifyQuotaError } from "../../src/worker/core/quota";

/**
 * 免费额度用尽时的报错识别
 *
 * 报错原文取自 Cloudflare 官方说明（2026-09 起 D1 免费版超额直接让查询失败）。
 * 识别出来之后接口会回 503 + 一句"UTC 零点恢复、数据没丢"，而不是让人去查日志的"服务异常"。
 */
describe("D1 额度报错识别", () => {
	it("读行数超限", () => {
		expect(
			classifyQuotaError(
				"Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
			),
		).toBe("d1_daily_read");
		expect(classifyQuotaError("The account has reached its daily row read limit.")).toBe("d1_daily_read");
	});

	it("写行数超限", () => {
		expect(
			classifyQuotaError("Your account has exceeded D1's free tier daily row write limit."),
		).toBe("d1_daily_write");
		expect(classifyQuotaError("The account has reached its daily row write limit.")).toBe("d1_daily_write");
	});

	it("存储写满", () => {
		expect(classifyQuotaError("D1_ERROR: Exceeded maximum DB size")).toBe("d1_storage");
		expect(classifyQuotaError("database is full")).toBe("d1_storage");
	});

	it("其它错误不误判（该走的还是原来的路径）", () => {
		for (const message of [
			"no such table: settings",
			"D1_ERROR: network connection lost",
			"UNIQUE constraint failed: holdings.id",
			"",
			null,
			undefined,
		]) {
			expect(classifyQuotaError(message), String(message)).toBeNull();
		}
	});
});
