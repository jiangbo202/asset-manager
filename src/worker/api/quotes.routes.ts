import { Hono } from "hono";
import type { AppEnv } from "../types";
import { badRequest, ok } from "../core/errors";
import { writeAudit } from "../core/audit";
import { getQuoteStatus, refreshQuotes } from "../services/quotes";
import { parseProviderSettings, runAdapter, type ProviderId, type QuoteKind, type QuoteTarget } from "../services/quotes/providers";
import { getSetting } from "../data/settings.repo";
import { decryptSecret } from "../core/secrets";
import { asRecord, requireString } from "./validate";

const quotes = new Hono<AppEnv>();

/** 手动刷新行情（设置页按钮 / 总览页按钮） */
quotes.post("/refresh", async (c) => {
	const report = await refreshQuotes(c.env, { trigger: "manual" });

	await writeAudit(c.env.DB, {
		entity: "quotes",
		entityId: null,
		action: "update",
		after: {
			updated: report.updated,
			fxUpdated: report.fxUpdated,
			requests: report.requests,
			failed: report.failed.length,
		},
		source: "system",
		note: `手动刷新行情：更新 ${report.updated} 条价格、${report.fxUpdated} 条汇率，失败 ${report.failed.length} 条`,
	});

	return ok(c, { report });
});

/** 数据源与最近运行情况 */
quotes.get("/status", async (c) => {
	return ok(c, await getQuoteStatus(c.env));
});

/** 单点测试：设置页里验证某个数据源对某个代码能不能取到价 */
quotes.post("/test", async (c) => {
	const payload = asRecord(await c.req.json());
	const provider = requireString(payload, "provider", { label: "数据源", max: 20 }) as ProviderId;
	const symbol = requireString(payload, "symbol", { label: "代码", max: 40 });
	const kind = (requireString(payload, "kind", { label: "类型", max: 10 }) || "stock") as QuoteKind;
	const currency = requireString(payload, "currency", { label: "币种", max: 5 }).toUpperCase();
	const market = typeof payload.market === "string" ? payload.market : null;

	if (!["crypto", "stock", "fx"].includes(kind)) throw badRequest("kind 只能是 crypto / stock / fx");

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
		errors: result.errors,
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
