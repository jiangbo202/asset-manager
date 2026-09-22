import type { PortfolioHolding } from "../../shared/api-types";

/**
 * 组合统计口径（纯函数）
 *
 * 现金（class = "cash"）在这里需要被特殊对待，而且**已经踩过三次坑**：
 *   1. 「浮动盈亏」下方写着"2 条未填成本"，点进去发现是两笔现金
 *   2. 「价格新鲜度」刷新完行情仍显示"1 天"—— 现金的价格恒为 1，永远不会被刷新
 *   3. 停更告警把现金也算成"停更"（这条早就修了，但同样属于这里的规则）
 * 所以规则集中写在这个模块，并由 tests/api/cash-rules.test.ts 集中钉住：
 *   **排除现金**：报价目标、价格新鲜度、未填成本计数、停更告警
 *   **包含现金**：总资产、各类分布、缺汇率清单
 */

export interface PnlSummary {
	costTotal: number;
	pnlTotal: number;
	pnlPct: number | null;
	/** 没填平均成本的**非现金**持仓条数（现金本来就没有成本，不算"漏填"） */
	missingCostCount: number;
}

/**
 * 浮动盈亏汇总。
 *
 * 现金按定义没有平均成本：既不该进"未填成本"的计数（用户看到"2 条未填成本"，
 * 点进去发现是两笔现金），也不参与盈亏比例 —— 盈亏比例的口径是"已投入成本"。
 */
export function pnlSummary(
	holdings: Array<{ isCash: boolean; avgCost: number | null; costDisplay: number | null; pnlDisplay: number | null }>,
): PnlSummary {
	const costTotal = holdings.reduce((sum, item) => sum + (item.costDisplay ?? 0), 0);
	const pnlTotal = holdings.reduce((sum, item) => sum + (item.pnlDisplay ?? 0), 0);
	const missingCostCount = holdings.filter((item) => !item.isCash && item.avgCost === null).length;
	return {
		costTotal,
		pnlTotal,
		pnlPct: costTotal > 0 ? (pnlTotal / costTotal) * 100 : null,
		missingCostCount,
	};
}

/**
 * 停更告警：价格超过 {{days}} 天没更新的**非现金**持仓。
 *
 * 现金没有行情可更新，"停更"对它没有意义 —— 混进来只会常年亮着一条无用的告警。
 */
export function staleHoldings(holdings: PortfolioHolding[], days = 7): PortfolioHolding[] {
	return holdings.filter(
		(item) => !item.isCash && item.daysSincePriceUpdate !== null && item.daysSincePriceUpdate > days,
	);
}
