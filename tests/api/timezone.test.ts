import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	dateIn,
	hourIn,
	isValidTimeZone,
	nextSnapshotInstant,
	normalizeTimeZone,
	offsetLabel,
	offsetMinutes,
	zonedDayRange,
} from "../../src/shared/time";
import { handleCron } from "../../src/worker/services/scheduler";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

const at = (iso: string) => new Date(iso);

describe("时区工具（纯函数）", () => {
	it("dateIn / hourIn 按目标时区计算日历与小时", () => {
		const moment = at("2026-09-20T23:30:00.000Z");
		expect(dateIn("UTC", moment)).toBe("2026-09-20");
		expect(hourIn("UTC", moment)).toBe(23);
		// 上海 UTC+8 → 次日 07:30
		expect(dateIn("Asia/Shanghai", moment)).toBe("2026-09-21");
		expect(hourIn("Asia/Shanghai", moment)).toBe(7);
		// 纽约 UTC-4（夏令时）→ 同日 19:30
		expect(dateIn("America/New_York", moment)).toBe("2026-09-20");
		expect(hourIn("America/New_York", moment)).toBe(19);
		// UTC+14
		expect(dateIn("Pacific/Kiritimati", moment)).toBe("2026-09-21");
		expect(hourIn("Pacific/Kiritimati", moment)).toBe(13);
	});

	it("offsetMinutes / offsetLabel 反映偏移（含夏令时）", () => {
		expect(offsetMinutes("Asia/Shanghai", at("2026-09-20T00:00:00Z"))).toBe(480);
		expect(offsetLabel("Asia/Shanghai", at("2026-09-20T00:00:00Z"))).toBe("UTC+8");
		// 纽约夏令时 -4，冬令时 -5
		expect(offsetLabel("America/New_York", at("2026-07-01T00:00:00Z"))).toBe("UTC-4");
		expect(offsetLabel("America/New_York", at("2026-01-15T00:00:00Z"))).toBe("UTC-5");
		expect(offsetLabel("UTC")).toBe("UTC+0");
	});

	it("isValidTimeZone / normalizeTimeZone 对非法值回退 UTC", () => {
		expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Mars/Olympus")).toBe(false);
		expect(isValidTimeZone("")).toBe(false);
		expect(isValidTimeZone(null)).toBe(false);
		expect(normalizeTimeZone("Mars/Olympus")).toBe("UTC");
		expect(normalizeTimeZone("Asia/Hong_Kong")).toBe("Asia/Hong_Kong");
	});

	it("zonedDayRange 把「某时区的一天」换算成 UTC 边界", () => {
		const shanghai = zonedDayRange("2026-09-20", "Asia/Shanghai");
		expect(shanghai.fromIso).toBe("2026-09-19T16:00:00.000Z"); // 当地 00:00 = UTC 前一天 16:00
		expect(shanghai.toIso).toBe("2026-09-20T15:59:59.999Z");

		const utc = zonedDayRange("2026-09-20", "UTC");
		expect(utc.fromIso).toBe("2026-09-20T00:00:00.000Z");
		expect(utc.toIso).toBe("2026-09-20T23:59:59.999Z");
	});
});

describe("时区设置与业务口径", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	const save = (body: Record<string, unknown>, lang = "en") =>
		call<{ ok: boolean; error?: { message: string } }>("/api/settings", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json", "accept-language": lang },
			body: JSON.stringify(body),
		} as RequestInit & { cookie?: string });

	it("默认时区是 UTC，并由 /api/auth/me 下发给前端", async () => {
		const me = await call<Envelope<{ timezone: string }>>("/api/auth/me", { cookie });
		expect(me.body.data.timezone).toBe("UTC");

		const saved = await save({ timezone: "Asia/Shanghai" });
		expect(saved.status).toBe(200);

		const after = await call<Envelope<{ timezone: string }>>("/api/auth/me", { cookie });
		expect(after.body.data.timezone).toBe("Asia/Shanghai");
	});

	it("非法时区被拒绝，且错误文案跟随语言", async () => {
		const en = await save({ timezone: "Mars/Olympus" }, "en");
		expect(en.status).toBe(400);
		expect(en.body.error?.message).toContain("Invalid time zone");

		const zh = await save({ timezone: "Mars/Olympus" }, "zh");
		expect(zh.status).toBe(400);
		expect(zh.body.error?.message).toContain("时区名称无效");
	});

	it("新建持仓的价格历史生效日期使用配置时区的日历日", async () => {
		// 选一个 UTC+14 的时区：在 UTC 还是 9-20 的时候，当地已经是 9-21
		await save({ timezone: "Pacific/Kiritimati" });
		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "券商", kind: "broker", currency: "USD", market: "us" }),
		});
		const holding = await call<Envelope<{ id: string }>>("/api/holdings", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "stock",
				market: "us",
				symbol: "AAPL",
				name: "苹果",
				currency: "USD",
				qty: 1,
				price: 100,
			}),
		});
		const rows = await env.DB.prepare(
			`SELECT effective_date FROM price_history WHERE holding_id = ? ORDER BY created_at DESC LIMIT 1`,
		)
			.bind(holding.body.data.id)
			.first<{ effective_date: string }>();

		const expected = dateIn("Pacific/Kiritimati");
		expect(rows?.effective_date).toBe(expected);
		// UTC+14 的日历日与 UTC 日期最多相差一天（不可能差两天）
		const utcDate = dateIn("UTC");
		const nextUtcDate = new Date(Date.parse(`${utcDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
		expect([utcDate, nextUtcDate]).toContain(expected);
	});

	it("nextSnapshotInstant：算出下一次定时任务干活的时间", () => {
		// 同一天还没到点 → 就是今天那个整点
		expect(nextSnapshotInstant("UTC", 22, at("2026-09-21T10:00:00.000Z")).toISOString()).toBe("2026-09-21T22:00:00.000Z");
		// 恰好到点 → 算今天（闸门是 >=，不能推到明天）
		expect(nextSnapshotInstant("UTC", 22, at("2026-09-21T22:00:00.000Z")).toISOString()).toBe("2026-09-21T22:00:00.000Z");
		// 已过点 → 明天
		expect(nextSnapshotInstant("UTC", 22, at("2026-09-21T22:30:00.000Z")).toISOString()).toBe("2026-09-22T22:00:00.000Z");

		// 上海：UTC 00:00 = 当地 08:00，当天 22:00 对应 14:00Z
		expect(nextSnapshotInstant("Asia/Shanghai", 22, at("2026-09-21T00:00:00.000Z")).toISOString()).toBe(
			"2026-09-21T14:00:00.000Z",
		);
		// 上海：15:00Z = 当地 23:00，已过 22 点 → 明天 22:00 当地 = 次日 14:00Z
		expect(nextSnapshotInstant("Asia/Shanghai", 22, at("2026-09-21T15:00:00.000Z")).toISOString()).toBe(
			"2026-09-22T14:00:00.000Z",
		);

		// 夏令时：纽约 2026-03-08 当天切换到 EDT，当地 22:00 = 次日 02:00Z
		expect(nextSnapshotInstant("America/New_York", 22, at("2026-03-08T12:00:00.000Z")).toISOString()).toBe(
			"2026-03-09T02:00:00.000Z",
		);
		// 切换前一天还是 EST，当地 22:00 = 次日 03:00Z
		expect(nextSnapshotInstant("America/New_York", 22, at("2026-03-07T12:00:00.000Z")).toISOString()).toBe(
			"2026-03-08T03:00:00.000Z",
		);
	});

	it("Cron 的小时闸门按配置时区判断", async () => {
		await save({ timezone: "Asia/Shanghai" });
		await save({ snapshotHourUtc: 22 });

		const now = new Date();
		// 14:00 UTC = 上海 22:00
		const shanghai2200 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 0, 0));
		// 03:00 UTC = 上海 11:00 → 未到点，跳过，并说明"当前 时区 时间 N 点"
		const shanghai1100 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0));

		const skipped = await handleCron(env, shanghai1100);
		expect(skipped.ran).toBe(false);
		expect(skipped.reason).toContain("Asia/Shanghai");

		// 到点那次先刷行情（一次调用只干一件重活）
		const refreshed = await handleCron(env, shanghai2200);
		expect(refreshed.ran).toBe(true);
		expect(refreshed.snapshot).toBeUndefined();

		// 下一个整点（上海 23:00）拍快照，日期用上海日历日
		const shanghai2300 = new Date(shanghai2200.getTime() + 3600_000);
		const result = await handleCron(env, shanghai2300);
		expect(result.ran).toBe(true);
		expect(result.snapshot?.date).toBe(dateIn("Asia/Shanghai", shanghai2300));

		// 同一时刻如果时区是 UTC：14 点 ≠ 22 点 → 不执行
		await save({ timezone: "UTC" });
		await clearAll();
		await bootstrap();
		const utcResult = await handleCron(env, shanghai2200);
		expect(utcResult.ran).toBe(false);
		expect(utcResult.reason).toContain("UTC");
	});
});
