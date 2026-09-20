import { beforeEach, describe, expect, it } from "vitest";
import { allKeys, createTranslator, resolveLanguage } from "../../src/shared/i18n";
import en from "../../src/shared/locales/en";
import zh from "../../src/shared/locales/zh";

const translate = createTranslator;
const dicts = { zh, en };
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

/** 带语言头的请求 */
async function callWithLang<T>(
	path: string,
	lang: string,
	init: RequestInit & { cookie?: string | null } = {},
) {
	const headers = new Headers(init.headers);
	headers.set("accept-language", lang);
	if (init.body) headers.set("Content-Type", "application/json");
	return call<T>(path, { ...init, headers });
}

describe("i18n 基础设施", () => {
	it("两种语言的 key 完全对齐（漏翻会立刻被这条测试抓出来）", () => {
		const missing = allKeys(zh, en).filter((item) => item.present.some((value) => !value));
		expect(
			missing,
			`缺失的翻译：${missing.map((item) => `${item.key}(zh=${item.present[0]},en=${item.present[1]})`).join(", ")}`,
		).toEqual([]);
	});

	it("同 key 的参数占位符一致（改文案时两边都要动）", () => {
		// 精简文案时很容易只顾着一侧：例如把“已获取 {{base}} = {{rate}}”改写成
		// 没带 {{rate}} 的句子，界面就会漏显示值（而且不会报错，只是少了内容）。
		const params = (text: string) =>
			[...text.matchAll(/\{\{(\w+)\}\}/g)]
				.map((match) => match[1])
				.sort()
				.join(",");

		const mismatched = (Object.keys(zh) as Array<keyof typeof zh>)
			.filter((key) => params(zh[key]) !== params(en[key]))
			.map((key) => `${key}：zh=[${params(zh[key])}] en=[${params(en[key])}]`);

		expect(mismatched, `占位符不一致：\n${mismatched.join("\n")}`).toEqual([]);
	});

	it("resolveLanguage：显式设置优先，auto 跟随 Accept-Language", () => {
		expect(resolveLanguage("zh", "en-US")).toBe("zh");
		expect(resolveLanguage("en", "zh-CN")).toBe("en");
		expect(resolveLanguage("auto", "zh-CN,zh;q=0.9")).toBe("zh");
		expect(resolveLanguage("auto", "en-US,en;q=0.9")).toBe("en");
		// 没有语言信息时回退到项目默认语言
		expect(resolveLanguage(null, null)).toBe("zh");
		expect(resolveLanguage("auto", "")).toBe("zh");
		expect(resolveLanguage("bogus", "en")).toBe("en");
	});

	it("translate：插值 + 缺失 key 回退", () => {
		expect(translate("zh", dicts)("error.field_required", { label: "名称" })).toBe("名称不能为空");
		expect(translate("en", dicts)("error.field_required", { label: "Name" })).toBe("Name is required");
		expect(translate("en", dicts)("does.not.exist")).toBe("does.not.exist");
		// 缺少插值参数时保留占位符，便于发现
		expect(translate("en", dicts)("error.field_required")).toContain("{{label}}");
	});
});

describe("服务端提示跟随请求语言", () => {
	let cookie: string;

	beforeEach(async () => {
		await clearAll();
		cookie = (await bootstrap()).cookie;
	});

	it("表单校验错误会按 Accept-Language 返回中文或英文", async () => {
		const zh = await callWithLang<{ error: { code: string; message: string } }>(
			"/api/accounts",
			"zh-CN",
			{ method: "POST", cookie, body: JSON.stringify({ name: "", kind: "broker", currency: "USD" }) },
		);
		expect(zh.status).toBe(400);
		expect(zh.body.error.code).toBe("invalid_field");
		expect(zh.body.error.message).toBe("账户名称不能为空");

		const en = await callWithLang<{ error: { code: string; message: string } }>(
			"/api/accounts",
			"en-US",
			{ method: "POST", cookie, body: JSON.stringify({ name: "", kind: "broker", currency: "USD" }) },
		);
		expect(en.status).toBe(400);
		expect(en.body.error.message).toBe("Account name is required");
	});

	it("枚举、币种与数字范围错误也会本地化", async () => {
		const en = await callWithLang<{ error: { message: string } }>("/api/accounts", "en", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "x", kind: "nope", currency: "USD" }),
		});
		expect(en.body.error.message).toContain("Account type must be one of");

		const currency = await callWithLang<{ error: { message: string } }>("/api/accounts", "en", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "x", kind: "broker", currency: "US" }),
		});
		expect(currency.body.error.message).toBe("Currency must be 3–5 letters");

		const account = await call<Envelope<{ id: string }>>("/api/accounts", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "Test", kind: "broker", currency: "USD", market: "us" }),
		});
		const num = await callWithLang<{ error: { message: string } }>("/api/holdings", "en", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				accountId: account.body.data.id,
				class: "stock",
				name: "x",
				currency: "USD",
				qty: 1,
				price: -1,
			}),
		});
		expect(num.body.error.message).toContain("Price must be at least 0");
	});

	it("语言偏好写进设置，并由 /api/auth/me 返回给前端", async () => {
		const updated = await callWithLang<Envelope<{ values: Record<string, string> }>>("/api/settings", "en", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ language: "en" }),
		});
		expect(updated.status).toBe(200);

		const me = await callWithLang<Envelope<{ language: string }>>("/api/auth/me", "en", { cookie });
		expect(me.body.data.language).toBe("en");

		// 非法语言被拒绝，且错误文案跟随语言
		const bad = await callWithLang<{ error: { message: string } }>("/api/settings", "en", {
			method: "PUT",
			cookie,
			body: JSON.stringify({ language: "fr" }),
		});
		expect(bad.status).toBe(400);
		expect(bad.body.error.message).toContain("must be one of");
	});

	it("备份导入警告跟随语言", async () => {
		const backup = {
			format: "asset-manager-backup",
			schemaVersion: 1,
			appVersion: "test",
			exportedAt: "2026-09-01T00:00:00.000Z",
			data: {
				accounts: [
					{
						id: "acc-1",
						name: "A",
						kind: "broker",
						market: "us",
						currency: "USD",
						icon_key: null,
						icon_data: null,
						sort: 0,
						archived: 0,
						note: null,
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
					},
				],
				holdings: [
					{
						id: "h-1",
						account_id: "acc-1",
						class: "cash",
						market: null,
						symbol: null,
						name: "现金",
						currency: "HKD",
						qty: 100,
						price: 1,
						avg_cost: null,
						price_updated_at: null,
						archived: 0,
						note: null,
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
					},
				],
				priceHistory: [],
				qtyHistory: [],
				fxRates: [],
				fxRateHistory: [],
				settings: {},
				auditLog: [],
			},
		};

		const zh = await callWithLang<Envelope<{ preview: { warnings: string[] } }>>(
			"/api/backup/import?mode=merge&dryRun=true",
			"zh-CN",
			{ method: "POST", cookie, body: JSON.stringify(backup) },
		);
		expect(zh.body.data.preview.warnings.join(" ")).toContain("缺少汇率");

		const en = await callWithLang<Envelope<{ preview: { warnings: string[] } }>>(
			"/api/backup/import?mode=merge&dryRun=true",
			"en-US",
			{ method: "POST", cookie, body: JSON.stringify(backup) },
		);
		expect(en.body.data.preview.warnings.join(" ")).toContain("Missing FX rates");
	});

	it("登录错误的语言也跟随请求头", async () => {
		const params = await call<{ data: { kdfSalt: string } }>("/api/auth/params");
		expect(params.body.data.kdfSalt).toBeTruthy();

		const en = await callWithLang<{ error: { message: string } }>("/api/auth/login", "en", {
			method: "POST",
			body: JSON.stringify({ credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
		});
		expect(en.body.error.message).toBe("Incorrect password");
	});
});
