import { newId, nowIso, todayUtc } from "../../core/utils";
import { decryptSecret } from "../../core/secrets";
import { getSetting, setSetting, SETTING_DISPLAY_CURRENCY } from "../../data/settings.repo";
import { listHoldings } from "../../data/accounts.repo";
import { listFxRates, upsertAutoFxRate } from "../../data/fx.repo";
import {
	DEFAULT_PRIORITY,
	planProviders,
	parseProviderSettings,
	PROVIDER_MAP,
	runAdapter,
	type FetchContext,
	type ProviderId,
	type ProviderSettings,
	type Quote,
	type QuoteKind,
	type QuoteTarget,
} from "./providers";

/**
 * 行情刷新编排
 *
 * 关键约束（免费版）：subrequest 每次调用 50 个上限、同时 6 个出站连接。
 * 所以：优先用"一次请求拿多个标的"的接口（CoinGecko / Binance / 腾讯），
 * 每个标的单独请求的接口（Yahoo / 自定义）用 6 并发并设总预算上限。
 */

/** 单次刷新的请求预算（留出余量给其他潜在请求） */
const MAX_REQUESTS = 40;

export interface RefreshReport {
	trigger: "cron" | "manual";
	updated: number;
	fxUpdated: number;
	requests: number;
	sources: Record<string, number>;
	failed: Array<{ symbol: string; reason: string }>;
	skipped: string[];
	startedAt: string;
	finishedAt: string;
}

/** 收集需要报价的持仓与汇率 */
export async function collectTargets(
	db: D1Database,
	options: { displayCurrency: string },
): Promise<{ holdingTargets: QuoteTarget[]; fxTargets: QuoteTarget[]; displayCurrency: string }> {
	const holdings = await listHoldings(db, {});
	const holdingTargets: QuoteTarget[] = [];
	for (const holding of holdings) {
		if (holding.class === "cash") continue;
		const symbol = holding.symbol ?? null;
		if (!symbol && !holding.quote_symbol) continue;
		holdingTargets.push({
			key: holding.id,
			kind: holding.class === "crypto" ? "crypto" : "stock",
			symbol: symbol ?? holding.quote_symbol ?? "",
			currency: holding.currency,
			market: holding.market,
			sourceOverride: holding.quote_source ?? null,
			symbolOverride: holding.quote_symbol ?? null,
		});
	}

	// 汇率：只要"组合里出现过的币种"，折算到显示币种
	const currencies = new Set<string>();
	for (const holding of holdings) currencies.add(holding.currency);
	currencies.add(options.displayCurrency);

	const existing = await listFxRates(db);
	const manualPairs = new Set(
		existing.filter((rate) => rate.source !== "auto").map((rate) => `${rate.base}:${rate.quote}`),
	);

	const fxTargets: QuoteTarget[] = [];
	for (const currency of currencies) {
		if (currency === options.displayCurrency) continue;
		const direct = `${currency}:${options.displayCurrency}`;
		const reverse = `${options.displayCurrency}:${currency}`;
		// 手工维护的汇率优先级最高，不覆盖
		if (manualPairs.has(direct) || manualPairs.has(reverse)) continue;
		fxTargets.push({
			key: `fx:${direct}`,
			kind: "fx",
			symbol: direct,
			currency: options.displayCurrency,
		});
	}

	return { holdingTargets, fxTargets, displayCurrency: options.displayCurrency };
}

async function loadProviderSettings(db: D1Database, sessionSecret: string): Promise<ProviderSettings> {
	const raw = await getSetting(db, "provider_config");
	const settings = parseProviderSettings(raw);

	// API Key 是用 SESSION_SECRET 加密存库的（可以随时换 SESSION_SECRET，代价是要重填 Key）
	const encryptedKeys = await getSetting(db, "provider_keys");
	if (encryptedKeys) {
		const plain = await decryptSecret(encryptedKeys, sessionSecret);
		if (plain) {
			try {
				const parsed = JSON.parse(plain) as Record<string, string>;
				(settings as ProviderSettings & { apiKeys?: Record<string, string> }).apiKeys = parsed;
			} catch {
				/* 坏数据忽略 */
			}
		}
	}
	return settings;
}

export function apiKeysOf(settings: ProviderSettings): Partial<Record<ProviderId, string>> {
	return (settings as ProviderSettings & { apiKeys?: Partial<Record<ProviderId, string>> }).apiKeys ?? {};
}

export async function refreshQuotes(
	env: { DB: D1Database; SESSION_SECRET: string },
	options: { trigger: "cron" | "manual"; fetcher?: typeof fetch } = { trigger: "manual" },
): Promise<RefreshReport> {
	const startedAt = nowIso();
	const db = env.DB;
	const enabled = (await getSetting(db, "market_data_enabled")) !== "0";
	const report: RefreshReport = {
		trigger: options.trigger,
		updated: 0,
		fxUpdated: 0,
		requests: 0,
		sources: {},
		failed: [],
		skipped: [],
		startedAt,
		finishedAt: startedAt,
	};

	if (!enabled) {
		report.skipped.push("行情功能已关闭");
		report.finishedAt = nowIso();
		return report;
	}

	const displayCurrency = (await getSetting(db, SETTING_DISPLAY_CURRENCY)) ?? "USD";
	const settings = await loadProviderSettings(db, env.SESSION_SECRET);
	// 注意：Workers 里 fetch 必须绑定到全局作用域调用，直接当方法传递会报 "Illegal invocation"
	const ctx: FetchContext = {
		fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
		apiKeys: apiKeysOf(settings),
	};

	const { holdingTargets, fxTargets } = await collectTargets(db, { displayCurrency });

	// 预算不够时优先刷新最久没更新的标的
	const allTargets = [...holdingTargets, ...fxTargets];
	const holdingsById = new Map((await listHoldings(db, {})).map((item) => [item.id, item]));
	allTargets.sort((a, b) => {
		const left = holdingsById.get(a.key)?.price_updated_at ?? "";
		const right = holdingsById.get(b.key)?.price_updated_at ?? "";
		return left.localeCompare(right);
	});

	const resolvedKeys = new Set<string>();
	const quotes: Quote[] = [];
	/** key -> 最近一次失败原因（用户看到的应该是"最后一家怎么说的"） */
	const errorsByKey = new Map<string, string>();

	// 按类型依次尝试数据源（前一个拿不到的顺延到下一个）
	const byKind: Record<QuoteKind, QuoteTarget[]> = { crypto: [], stock: [], fx: [] };
	for (const target of allTargets) byKind[target.kind].push(target);

	for (const kind of ["crypto", "stock", "fx"] as QuoteKind[]) {
		let remaining = byKind[kind].filter((target) => !resolvedKeys.has(target.key));
		if (remaining.length === 0) continue;

		const providers = planProviders(kind, settings);
		if (providers.length === 0) {
			for (const target of remaining) {
				report.failed.push({ symbol: target.symbol, reason: "没有可用的数据源（请在设置里启用）" });
			}
			continue;
		}

		for (const provider of providers) {
			remaining = remaining.filter((target) => !resolvedKeys.has(target.key));
			if (remaining.length === 0) break;

			const meta = PROVIDER_MAP.get(provider);
			if (!meta) continue;

			// 预算检查
			const needed = meta.batch ? 1 : remaining.length;
			if (report.requests + needed > MAX_REQUESTS) {
				const accepted = meta.batch ? remaining : remaining.slice(0, Math.max(0, MAX_REQUESTS - report.requests));
				report.skipped.push(
					`${meta.label}：本次请求预算用尽，剩余 ${remaining.length - accepted.length} 个标的顺延到下次`,
				);
				remaining = accepted;
				if (remaining.length === 0) break;
			}

			// 显式指定了数据源的标的只走指定的那一家
			const applicable = remaining.filter(
				(target) => !target.sourceOverride || target.sourceOverride === provider,
			);
			if (applicable.length === 0) continue;

			const result = await runAdapter(provider, applicable, ctx, settings);
			report.requests += meta.batch ? 1 : applicable.length;

			for (const quote of result.quotes) {
				resolvedKeys.add(quote.key);
				quotes.push(quote);
				report.sources[quote.source] = (report.sources[quote.source] ?? 0) + 1;
			}
			// 记住失败原因：可能后面还有别的数据源能救回来，所以先不报给用户
			for (const error of result.errors) {
				const symbol = error.split("：")[0];
				if (symbol) errorsByKey.set(symbol, error);
			}
		}

		for (const target of remaining) {
			if (resolvedKeys.has(target.key)) continue;
			report.failed.push({
				symbol: target.symbol,
				reason: errorsByKey.get(target.symbol) ?? "所有数据源都没能取到价格",
			});
		}
	}

	// 写入：持仓价格 + 价格历史 + 缓存
	const statements: D1PreparedStatement[] = [];
	const finishedAtProbe = nowIso();
	for (const quote of quotes) {
		if (quote.key.startsWith("fx:")) {
			const [base, target] = quote.key.slice(3).split(":");
			if (base && target) {
				await upsertAutoFxRate(db, base, target, quote.price);
				report.fxUpdated += 1;
			}
			continue;
		}

		statements.push(
			db
				.prepare(`UPDATE holdings SET price = ?, price_updated_at = ?, updated_at = ? WHERE id = ?`)
				.bind(quote.price, finishedAtProbe, finishedAtProbe, quote.key),
		);
		statements.push(
			db
				.prepare(
					`INSERT INTO price_history (id, holding_id, effective_date, price, source, created_at)
					 VALUES (?, ?, ?, ?, 'api', ?)`,
				)
				.bind(newId(), quote.key, todayUtc(), quote.price, finishedAtProbe),
		);
		report.updated += 1;
	}

	for (const quote of quotes) {
		statements.push(
			db
				.prepare(
					`INSERT INTO quote_cache (key, source, symbol, currency, price, fetched_at, error)
					 VALUES (?, ?, ?, ?, ?, ?, NULL)
					 ON CONFLICT(key) DO UPDATE SET source = excluded.source, symbol = excluded.symbol,
					   currency = excluded.currency, price = excluded.price, fetched_at = excluded.fetched_at, error = NULL`,
				)
				.bind(`${quote.source}:${quote.symbol}:${quote.currency}`, quote.source, quote.symbol, quote.currency, quote.price, finishedAtProbe),
		);
	}

	if (statements.length > 0) {
		for (let index = 0; index < statements.length; index += 500) {
			await db.batch(statements.slice(index, index + 500));
		}
	}

	report.finishedAt = nowIso();
	await setSetting(db, "market_data_last_run", report.finishedAt);
	await db
		.prepare(
			`INSERT INTO quote_runs (id, started_at, finished_at, trigger, updated, failed, requests, report_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId(),
			report.startedAt,
			report.finishedAt,
			report.trigger,
			report.updated,
			report.failed.length,
			report.requests,
			JSON.stringify(report),
		)
		.run();

	return report;
}

export interface QuoteStatus {
	enabled: boolean;
	lastRunAt: string | null;
	providers: Array<{
		id: ProviderId;
		label: string;
		enabled: boolean;
		needsKey: boolean;
		note: string;
		docs?: string;
		kindLabel: string;
		priority: number;
		hasKey: boolean;
	}>;
	cache: Array<{ key: string; source: string; symbol: string; price: number; currency: string; fetched_at: string }>;
	recentRuns: Array<{ id: string; started_at: string; trigger: string; updated: number; failed: number; requests: number }>;
	custom: ProviderSettings["custom"];
}

export async function getQuoteStatus(env: { DB: D1Database; SESSION_SECRET: string }): Promise<QuoteStatus> {
	const db = env.DB;
	const settings = await loadProviderSettings(db, env.SESSION_SECRET);
	const keys = apiKeysOf(settings);
	const cache = await db
		.prepare(`SELECT key, source, symbol, price, currency, fetched_at FROM quote_cache ORDER BY fetched_at DESC LIMIT 100`)
		.all<{ key: string; source: string; symbol: string; price: number; currency: string; fetched_at: string }>();
	const runs = await db
		.prepare(
			`SELECT id, started_at, trigger, updated, failed, requests FROM quote_runs ORDER BY started_at DESC LIMIT 10`,
		)
		.all<{ id: string; started_at: string; trigger: string; updated: number; failed: number; requests: number }>();

	const KIND_LABEL: Record<string, string> = { crypto: "加密", stock: "股票", fx: "汇率" };

	return {
		enabled: (await getSetting(db, "market_data_enabled")) !== "0",
		lastRunAt: await getSetting(db, "market_data_last_run"),
		providers: [...PROVIDER_MAP.values()].map((meta) => ({
			id: meta.id,
			label: meta.label,
			enabled: settings.enabled[meta.id] ?? meta.defaultEnabled,
			needsKey: meta.needsKey,
			note: meta.note,
			docs: meta.docs,
			kindLabel: meta.kinds.map((kind) => KIND_LABEL[kind] ?? kind).join(" / "),
			priority: DEFAULT_PRIORITY[meta.kinds[0]].indexOf(meta.id) + 1,
			hasKey: Boolean(keys[meta.id]),
		})),
		cache: cache.results ?? [],
		recentRuns: runs.results ?? [],
		custom: settings.custom ?? null,
	};
}
