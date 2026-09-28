import { describe, expect, it } from "vitest";
import { isLocalHostname, migrationHint } from "../../src/web/lib/runtime";

/**
 * 迁移命令提示
 *
 * 这组测试的存在理由是一次真实踩坑：线上页面提示"数据库需要升级"，
 * 卡片却固定印着 `db:migrate:local`，用户照着跑，迁移应用到了本地 sqlite，
 * 线上 D1 一动没动，于是"点了重试没反应"。
 */
describe("迁移命令提示（跑错库是这张卡片最大的坑）", () => {
	it("本机开发服务器 → 本地迁移命令", () => {
		expect(migrationHint("localhost")).toMatchObject({
			local: true,
			command: "npm run db:migrate:local",
		});
		expect(migrationHint("127.0.0.1").command).toBe("npm run db:migrate:local");
	});

	it("线上域名 → 远端迁移命令（本地 sqlite 上的迁移对线上毫无影响）", () => {
		expect(migrationHint("asset-manager.example.workers.dev")).toMatchObject({
			local: false,
			command: "npm run db:migrate:remote",
		});
		expect(migrationHint("assets.example.com").local).toBe(false);
	});

	it("另一侧的命令也要给出来，避免用户又跑错一次", () => {
		expect(migrationHint("localhost").otherCommand).toBe("npm run db:migrate:remote");
		expect(migrationHint("example.com").otherCommand).toBe("npm run db:migrate:local");
	});

	it("大小写、IPv6 都算本地；内网域名不算", () => {
		expect(isLocalHostname("LOCALHOST")).toBe(true);
		expect(isLocalHostname(" 127.0.0.1 ")).toBe(true);
		expect(isLocalHostname("::1")).toBe(true);
		expect(isLocalHostname("[::1]")).toBe(true);
		expect(isLocalHostname("my.localhost.example.com")).toBe(false);
		expect(isLocalHostname("192.168.1.10")).toBe(false);
	});
});
