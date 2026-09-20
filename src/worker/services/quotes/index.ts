import { newId, nowIso } from "../../core/utils";
import { dateIn } from "../../../shared/time";
import { decryptSecret } from "../../core/secrets";
import {
	getSettings,
	settingStatement,
	settingsStatement,
	toSettingsMap,
	displayCurrencyOf,
	timeZoneOf,
} from "../../data/settings.repo";
import { listHoldings, type HoldingWithAccount } from "../../data/accounts.repo";
import { autoFxRateStatement, fxHistoryStatement, listFxRates, type FxRate } from "../../data/fx.repo";
import { applyHealth, cooldownOf, parseHealth, type ProviderHealth } from "./health";
import type { Translator } from "../../../shared/i18n";
import { translator as sharedTranslator } from "../../core/i18n";
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
	/** 分批刷新时留到下一次的标的（定时任务会分批；手动刷新不带上限，所以是空的） */
	deferred: string[];
	/** 因为限流/连续失败被暂时跳过的数据源 */
	coolingDown: Array<{ provider: string; minutesLeft: number; reason: string }>;
	startedAt: string;
	finishedAt: string;
}

/** 收集需要报价的持仓与汇率 */
export async function collectTargets(
	db: D1Database,
	options: { displayCurrency: string; holdings?: HoldingWithAccount[] },
): Promise<{
	holdingTargets: QuoteTarget[];
	fxTargets: QuoteTarget[];
	/** 库里已有的汇率（刷新前），用于判断币种汇率是否真的变了 */
	fxRates: FxRate[];
	displayCurrency: string;
}> {
	const holdings = options.holdings ?? (await listHoldings(db, {}));
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

	return { holdingTargets, fxTargets, fxRates: existing, displayCurrency: options.displayCurrency };
}

/** 从已读到的原始值构造数据源配置（避免为两个 key 多跑两次查询） */
async function providerSettingsFrom(
	configRaw: string | null,
	keysRaw: string | null,
	sessionSecret: string,
): Promise<ProviderSettings> {
	const settings = parseProviderSettings(configRaw);

	// API Key 是用 SESSION_SECRET 加密存库的（可以随时换 SESSION_SECRET，代价是要重填 Key）
	if (keysRaw) {
		const plain = await decryptSecret(keysRaw, sessionSecret);
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
	options: {
		trigger: "cron" | "manual";
		fetcher?: typeof fetch;
		t?: Translator;
		/**
		 * 单次最多刷新多少个持仓（不传 = 不限）。
		 * 定时任务传它来做分批：CPU 开销大致随标的数量线性增长，
		 * 而免费版每次调用只有 10ms，所以不能让一次运行去处理无限多的持仓。
		 */
		maxHoldings?: number;
	} = { trigger: "manual" },
): Promise<RefreshReport> {
	const t = options.t ?? sharedTranslator("zh");
	const startedAt = nowIso();
	const db = env.DB;
	// 一次读出全部设置：早先这里是 4–6 次单独的 getSetting()，每次都是一次数据库往返
	const settingsMap = await getSettings(db);
	const enabled = settingsMap.market_data_enabled !== "0";
	const report: RefreshReport = {
		trigger: options.trigger,
		updated: 0,
		fxUpdated: 0,
		requests: 0,
		sources: {},
		failed: [],
		skipped: [],
		deferred: [],
		coolingDown: [],
		startedAt,
		finishedAt: startedAt,
	};

	if (!enabled) {
		report.skipped.push(t("quote.disabled"));
		report.finishedAt = nowIso();
		return report;
	}

	const displayCurrency = displayCurrencyOf(settingsMap);
	const timeZone = timeZoneOf(settingsMap);
	const settings = await providerSettingsFrom(
		settingsMap.provider_config ?? null,
		settingsMap.provider_keys ?? null,
		env.SESSION_SECRET,
	);
	let health: ProviderHealth = parseHealth(settingsMap.provider_health ?? null);
	// 注意：Workers 里 fetch 必须绑定到全局作用域调用，直接当方法传递会报 "Illegal invocation"
	const ctx: FetchContext = {
		fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
		apiKeys: apiKeysOf(settings),
		t,
	};

	const holdings = await listHoldings(db, {});
	const { holdingTargets, fxTargets, fxRates: knownFxRates } = await collectTargets(db, { displayCurrency, holdings });

	// 最久没更新的排前面：既让有限的预算花在陈旧数据上，也让"分批"在多次运行之间公平轮转
	// （本次被留下的，下次就是最旧的，自然优先）
	const holdingsById = new Map(holdings.map((item) => [item.id, item]));
	const staleness = (key: string) => holdingsById.get(key)?.price_updated_at ?? "";
	const orderedHoldings = [...holdingTargets].sort((a, b) => staleness(a.key).localeCompare(staleness(b.key)));

	// 分批：超出上限的留到下一次运行。汇率不参与分批——折算总额依赖它，且币种数量天然有限。
	const refreshedHoldings =
		options.maxHoldings === undefined
			? orderedHoldings
			: orderedHoldings.slice(0, Math.max(0, options.maxHoldings));
	report.deferred = orderedHoldings.slice(refreshedHoldings.length).map((target) => target.symbol);
	const allTargets = [...refreshedHoldings, ...fxTargets];

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
				report.failed.push({ symbol: target.symbol, reason: t("quote.noProvider") });
			}
			continue;
		}

		// 全都在冷却里就别白跑了，直接说明原因
		const available = providers.filter((provider) => !cooldownOf(health, provider).cooling);
		if (available.length === 0 && providers.length > 0) {
			const soonest = providers
				.map((provider) => ({ provider, state: cooldownOf(health, provider) }))
				.sort((a, b) => a.state.minutesLeft - b.state.minutesLeft)[0];
			for (const target of remaining) {
				report.failed.push({
					symbol: target.symbol,
					reason: t("quote.allCooling", { minutes: soonest.state.minutesLeft }),
				});
			}
			continue;
		}

		for (const provider of providers) {
			remaining = remaining.filter((target) => !resolvedKeys.has(target.key));
			if (remaining.length === 0) break;

			const meta = PROVIDER_MAP.get(provider);
			if (!meta) continue;

			// 冷却期内跳过（但如果是唯一可用的源，仍然试一次，宁可慢也别完全没数据）
			const cooldown = cooldownOf(health, provider);
			if (cooldown.cooling && available.length > 0 && available.length < providers.length) {
				report.coolingDown.push({
					provider: meta.label,
					minutesLeft: cooldown.minutesLeft,
					reason: cooldown.reason ?? t("quote.rateLimited"),
				});
				continue;
			}

			// 预算检查
			const needed = meta.batch ? 1 : remaining.length;
			if (report.requests + needed > MAX_REQUESTS) {
				const accepted = meta.batch ? remaining : remaining.slice(0, Math.max(0, MAX_REQUESTS - report.requests));
				report.skipped.push(
					t("quote.budget", { provider: meta.label, rest: remaining.length - accepted.length }),
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

			// 更新数据源健康度：成功清零，限流/连续失败则进入冷却
			health = applyHealth(
				health,
				provider,
				{ ok: result.quotes.length > 0, status: result.status, error: result.errors[0] },
				new Date(),
				t,
			);

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
				reason: errorsByKey.get(target.symbol) ?? t("quote.allFailed"),
			});
		}
	}

	// 写入：持仓价格 + 价格历史 + 缓存
	const statements: D1PreparedStatement[] = [];
	const effectiveDate = dateIn(timeZone);
	const finishedAtProbe = nowIso();
	const knownFx = new Map(knownFxRates.map((rate) => [`${rate.base}:${rate.quote}`, rate.rate]));
	for (const quote of quotes) {
		if (quote.key.startsWith("fx:")) {
			const [base, target] = quote.key.slice(3).split(":");
			if (base && target) {
				// 汇率写入也放进同一个 batch（原来是每个币种两次串行往返）
				statements.push(autoFxRateStatement(db, base, target, quote.price, finishedAtProbe));
				// 只有汇率真的变了才记历史（原来是每次刷新都插一行）
				if (knownFx.get(`${base}:${target}`) !== quote.price) {
					statements.push(fxHistoryStatement(db, base, target, quote.price, finishedAtProbe));
				}
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
				.bind(newId(), quote.key, effectiveDate, quote.price, finishedAtProbe),
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

	report.finishedAt = nowIso();
	// 收尾的 3 次写和上面的价格写入合成一次 batch：
	// 实测一次往返约等于 5–6 条语句的固定开销，所以能合并就合并。
	// 代价：这个 batch 是事务性的，写入失败时运行记录也不会落库（日志里仍看得到异常）。
	await db.batch([
		...statements,
		settingStatement(db, "market_data_last_run", report.finishedAt),
		settingStatement(db, "provider_health", JSON.stringify(health)),
		db
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
			),
	]);

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
		/** 是否处于限流冷却中 */
		coolingDown: boolean;
		cooldownMinutesLeft: number;
		cooldownReason: string | null;
		lastError: string | null;
		lastSuccessAt: string | null;
	}>;
	cache: Array<{ key: string; source: string; symbol: string; price: number; currency: string; fetched_at: string }>;
	recentRuns: Array<{
		id: string;
		started_at: string;
		trigger: string;
		updated: number;
		failed: number;
		requests: number;
		/** 这次运行里因为分批而留到下一次的标的数量 */
		deferred: number;
	}>;
	custom: ProviderSettings["custom"];
}

/** 旧数据（分批功能之前）没有 deferred 字段，按 0 处理 */
function countDeferred(reportJson: string | null): number {
	if (!reportJson) return 0;
	try {
		const parsed = JSON.parse(reportJson) as { deferred?: unknown };
		return Array.isArray(parsed.deferred) ? parsed.deferred.length : 0;
	} catch {
		return 0;
	}
}

export async function getQuoteStatus(env: { DB: D1Database; SESSION_SECRET: string }): Promise<QuoteStatus> {
	const db = env.DB;
	// 设置、缓存、最近运行一次 batch 读完（原来是 3 条串行语句）
	const [settingsResult, cacheResult, runsResult] = await db.batch([
		settingsStatement(db),
		db.prepare(
			`SELECT key, source, symbol, price, currency, fetched_at FROM quote_cache ORDER BY fetched_at DESC LIMIT 100`,
		),
		db.prepare(
			`SELECT id, started_at, trigger, updated, failed, requests, report_json FROM quote_runs ORDER BY started_at DESC LIMIT 10`,
		),
	]);
	const settingsMap = toSettingsMap(settingsResult?.results as Array<{ key: string; value: string }> | undefined);
	const settings = await providerSettingsFrom(
		settingsMap.provider_config ?? null,
		settingsMap.provider_keys ?? null,
		env.SESSION_SECRET,
	);
	const keys = apiKeysOf(settings);
	const cache = (cacheResult?.results ?? []) as Array<{
		key: string;
		source: string;
		symbol: string;
		price: number;
		currency: string;
		fetched_at: string;
	}>;
	const runs = (runsResult?.results ?? []) as Array<{
		id: string;
		started_at: string;
		trigger: string;
		updated: number;
		failed: number;
		requests: number;
		report_json: string | null;
	}>;

	const KIND_LABEL: Record<string, string> = { crypto: "加密", stock: "股票", fx: "汇率" };
	const health = parseHealth(settingsMap.provider_health ?? null);

	return {
		enabled: settingsMap.market_data_enabled !== "0",
		lastRunAt: settingsMap.market_data_last_run ?? null,
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
			...(() => {
				const state = cooldownOf(health, meta.id);
				return {
					coolingDown: state.cooling,
					cooldownMinutesLeft: state.minutesLeft,
					cooldownReason: state.reason,
					lastError: health[meta.id]?.lastError ?? null,
					lastSuccessAt: health[meta.id]?.lastSuccessAt ?? null,
				};
			})(),
		})),
		cache: cache,
		recentRuns: runs.map((run) => ({
			id: run.id,
			started_at: run.started_at,
			trigger: run.trigger,
			updated: run.updated,
			failed: run.failed,
			requests: run.requests,
			deferred: countDeferred(run.report_json),
		})),
		custom: settings.custom ?? null,
	};
}
