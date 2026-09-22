import type { PublicSection } from "../../shared/public-sections";
import type { HoldingWithAccount } from "../data/accounts.repo";
import { buildFxLookup, type FxRate } from "../data/fx.repo";
import type { AssetClass } from "../../shared/labels";

/**
 * 组合视图聚合（当前时点，无时间序列 —— v1 不做走势图，见 PRD D3）
 *
 * 换算规则：查不到汇率时**不按 1:1 处理**，而是把该持仓标为 fxMissing 并排除在总计之外，
 * 前端会显示警告，避免出现"看起来很准实际是错的"数字。
 */

export interface PortfolioHolding {
	id: string;
	accountId: string;
	accountName: string;
	accountKind: string;
	accountIconKey: string | null;
	class: AssetClass;
	market: string | null;
	symbol: string | null;
	name: string;
	currency: string;
	qty: number;
	price: number;
	avgCost: number | null;
	/** 原币种市值 */
	marketValue: number;
	/** 折算成显示币种后的市值（查不到汇率为 null） */
	marketValueDisplay: number | null;
	cost: number | null;
	pnl: number | null;
	pnlPct: number | null;
	priceUpdatedAt: string | null;
	daysSincePriceUpdate: number | null;
	fxMissing: boolean;
	share: number;
	isCash: boolean;
}

export interface BreakdownItem {
	key: string;
	label: string;
	value: number;
	share: number;
}

export interface Portfolio {
	displayCurrency: string;
	total: number;
	counts: { accounts: number; holdings: number };
	byClass: BreakdownItem[];
	byAccount: BreakdownItem[];
	byCurrency: BreakdownItem[];
	holdings: PortfolioHolding[];
	missingFxCurrencies: string[];
	staleDays: number | null;
	/** 非现金持仓里，价格超过 1 天没更新的条数（新鲜度卡片用来说明"是哪些没更新"） */
	staleCount: number;
	generatedAt: string;
}

/**
 * 公开只读分享的裁剪（纯函数）
 *
 * 规则与区域一一对应：
 *   summary   总资产、账户/持仓数、价格新鲜度、缺汇率提示
 *   breakdown 三类分布（类别/账户/币种）
 *   holdings  持仓明细里真正敏感的部分：数量、单价、平均成本、成本与盈亏
 *   trend     走势接口，不在这里（由 middleware 的分区白名单直接拒绝）
 *
 * 一个容易踩的点：环形图与 treemap 是**从持仓列表**算出来的，所以"不分享明细"时
 * 不能把 holdings 整个清空 —— 只保留画图需要的字段（名称、市值、占比、账户名），
 * 把数量与成本抹掉。否则要么图缺一块、要么明细从网络面板里漏出去。
 */
export function projectPortfolio(board: Portfolio, sections: readonly PublicSection[]): Portfolio {
	const has = (section: PublicSection) => sections.includes(section);

	const holdings = has("holdings")
		? board.holdings
		: !has("breakdown")
			? // 既没分享明细、也没分享分布：连画图用的那份都不必发
				[]
			: board.holdings.map((item) => ({
				...item,
				qty: 0,
				price: 0,
				avgCost: null,
				cost: null,
				pnl: null,
				pnlPct: null,
				costDisplay: null,
				pnlDisplay: null,
					priceUpdatedAt: null,
				}));

	return {
		...board,
		holdings,
		byClass: has("breakdown") ? board.byClass : [],
		byAccount: has("breakdown") ? board.byAccount : [],
		byCurrency: has("breakdown") ? board.byCurrency : [],
		total: has("summary") ? board.total : 0,
		counts: has("summary") ? board.counts : { accounts: 0, holdings: 0 },
		staleDays: has("summary") ? board.staleDays : null,
		staleCount: has("summary") ? board.staleCount : 0,
		missingFxCurrencies: has("summary") ? board.missingFxCurrencies : [],
	};
}

const dayDiff = (iso: string | null): number | null => {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return null;
	return Math.floor((Date.now() - then) / 86_400_000);
};

export function buildPortfolio(
	rows: HoldingWithAccount[],
	displayCurrency: string,
	fxRates: FxRate[],
): Portfolio {
	const lookup = buildFxLookup(fxRates);
	const missing = new Set<string>();

	const items: PortfolioHolding[] = rows.map((row) => {
		const marketValue = (row.qty ?? 0) * (row.price ?? 0);
		const rate = lookup(row.currency, displayCurrency);
		if (rate === null) missing.add(row.currency);
		const marketValueDisplay = rate === null ? null : marketValue * rate;
		const cost = row.avg_cost === null || row.avg_cost === undefined ? null : row.avg_cost * row.qty;
		const pnl = row.avg_cost === null || row.avg_cost === undefined ? null : (row.price - row.avg_cost) * row.qty;
		const pnlPct =
			row.avg_cost === null || row.avg_cost === undefined || row.avg_cost === 0
				? null
				: (row.price / row.avg_cost - 1) * 100;

		return {
			id: row.id,
			accountId: row.account_id,
			accountName: row.account_name,
			accountKind: row.account_kind,
			accountIconKey: row.account_icon_key,
			class: row.class,
			market: row.market,
			symbol: row.symbol,
			name: row.name,
			currency: row.currency,
			qty: row.qty,
			price: row.price,
			avgCost: row.avg_cost,
			marketValue,
			marketValueDisplay,
			cost,
			pnl,
			pnlPct,
			costDisplay: cost === null || rate === null ? null : cost * rate,
			pnlDisplay: pnl === null || rate === null ? null : pnl * rate,
			priceUpdatedAt: row.price_updated_at,
			daysSincePriceUpdate: dayDiff(row.price_updated_at),
			fxMissing: rate === null,
			share: 0,
			isCash: row.class === "cash",
		};
	});

	const total = items.reduce((sum, item) => sum + (item.marketValueDisplay ?? 0), 0);
	for (const item of items) {
		item.share = total > 0 && item.marketValueDisplay !== null ? (item.marketValueDisplay / total) * 100 : 0;
	}

	const group = (keyOf: (item: PortfolioHolding) => string, labelOf: (key: string) => string): BreakdownItem[] => {
		const buckets = new Map<string, number>();
		for (const item of items) {
			if (item.marketValueDisplay === null) continue;
			const key = keyOf(item);
			buckets.set(key, (buckets.get(key) ?? 0) + item.marketValueDisplay);
		}
		return [...buckets.entries()]
			.map(([key, value]) => ({
				key,
				label: labelOf(key),
				value,
				share: total > 0 ? (value / total) * 100 : 0,
			}))
			.sort((a, b) => b.value - a.value);
	};

	// 现金没有行情可更新（价格恒为 1、也不在任何报价源里），
	// 把它算进来的话这张卡片只会随着时间越来越大 —— 用户刚点完「更新行情」却看到"1 天"。
	// 这里同时数一下"确实陈旧"的条数，界面才能给出可操作的信息。
	const stale = items
		.filter((item) => !item.isCash)
		.map((item) => item.daysSincePriceUpdate)
		.filter((value): value is number => value !== null);
	const staleCount = items.filter(
		(item) => !item.isCash && item.daysSincePriceUpdate !== null && item.daysSincePriceUpdate >= 1,
	).length;

	return {
		displayCurrency,
		total,
		counts: {
			accounts: new Set(items.map((item) => item.accountId)).size,
			holdings: items.length,
		},
		// label 直接给原始 key（class.stock → "stock"），由前端按语言翻译
		byClass: group(
			(item) => item.class,
			(key) => key,
		),
		byAccount: group(
			(item) => item.accountId,
			(key) => items.find((item) => item.accountId === key)?.accountName ?? key,
		),
		byCurrency: group(
			(item) => item.currency,
			(key) => key,
		),
		holdings: items.sort((a, b) => (b.marketValueDisplay ?? -1) - (a.marketValueDisplay ?? -1)),
		missingFxCurrencies: [...missing].sort(),
		staleDays: stale.length > 0 ? Math.max(...stale) : null,
		staleCount,
		generatedAt: new Date().toISOString(),
	};
}
