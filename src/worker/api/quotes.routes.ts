import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, ok } from "../core/errors";
import { getQuoteStatus, refreshQuotes } from "../services/quotes";
import { parseProviderSettings, runAdapter, type ProviderId, type QuoteKind, type QuoteTarget } from "../services/quotes/providers";
import { lookupSymbol } from "../services/quotes/lookup";
import { getSetting } from "../data/settings.repo";
import { decryptSecret } from "../core/secrets";
import { asRecord, requireString } from "./validate";
import { tOf } from "../core/i18n";

const quotes = new Hono<AppEnv>();

/** 手动刷新行情（设置页按钮 / 总览页按钮） */
quotes.post("/refresh", async (c) => {
	const t = tOf(c);
	// 审计由 refreshQuotes 自己写（source 按 trigger 区分 web / system），
	// 这样手动与定时两条路径不会漏记、也不会各写一份
	const report = await refreshQuotes(c.env, { trigger: "manual", t });
	return ok(c, { report });
});

/** 数据源与最近运行情况 */
quotes.get("/status", async (c) => {
	return ok(c, await getQuoteStatus(c.env));
});

/**
 * 代码查询：输入代码 → 名称 / 当前价 / 币种 / 市场
 * 持仓表单用它做"输入代码自动填名称"与"一键取最新价"
 */
quotes.get("/lookup", async (c) => {
	const t = tOf(c);
	const symbol = (c.req.query("symbol") ?? "").trim();
	if (!symbol) throw badRequest(t("error.lookupSymbolRequired"));
	if (symbol.length > 40) throw badRequest(t("error.lookupSymbolTooLong"));

	const result = await lookupSymbol(c.env, {
		symbol,
		market: c.req.query("market") ?? null,
		classHint: c.req.query("class") ?? null,
		force: c.req.query("force") === "true",
	});
	return ok(c, result);
});

/** 单点测试：设置页里验证某个数据源对某个代码能不能取到价 */
quotes.post("/test", async (c) => {
	const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const provider = requireString(payload, "provider", { labelKey: "field.provider", max: 20 }, t) as ProviderId;
	const symbol = requireString(payload, "symbol", { labelKey: "field.symbol", max: 40 }, t);
	const kind = (requireString(payload, "kind", { labelKey: "field.type", max: 10 }, t) || "stock") as QuoteKind;
	const currency = requireString(payload, "currency", { labelKey: "field.currency", max: 5 }, t).toUpperCase();
	const market = typeof payload.market === "string" ? payload.market : null;

	if (!["crypto", "stock", "fx"].includes(kind)) throw badRequest(t("error.kindInvalid"));

	const raw = await getSetting(c.env.DB, "provider_config");
	const settings = parseProviderSettings(raw);
	const encryptedKeys = await getSetting(c.env.DB, "provider_keys");
	let apiKeys: Record<string, string> = {};
	if (encryptedKeys) {
		const plain = await decryptSecret(encryptedKeys, c.env.SESSION_SECRET);
		if (plain) {
			try {
				apiKeys = JSON.parse(plain) as Record<string, string>;
			} catch {
				apiKeys = {};
			}
		}
	}

	const target: QuoteTarget = { key: "test", kind, symbol, currency, market, symbolOverride: null };
	// fetch 必须绑定全局作用域，否则 Workers 会抛 "Illegal invocation"
	const result = await runAdapter(provider, [target], { fetcher: (input, init) => fetch(input, init), apiKeys }, settings);

	return ok(c, {
		quotes: result.quotes,
		errors: result.errors.map((error) => `${error.symbol}：${error.message}`),
		ok: result.quotes.length > 0,
	});
});

/** 快照相关（每日走势图的数据源） */
export interface SnapshotInfo {
	date: string;
	total: number;
	base_currency: string;
	created_at: string;
}

export default quotes;
