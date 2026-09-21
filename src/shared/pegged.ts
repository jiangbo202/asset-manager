/**
 * 与美元 1:1 挂钩的稳定币。
 *
 * 为什么要内置：免费的外汇数据源只有法币（Frankfurter 是欧洲央行牌价，open.er-api 是 166 种法币），
 * 都不含 USDT/USDC —— 于是"USDT 计价"的持仓永远拿不到汇率：每次刷新都固定失败一条，
 * 折算总额时被当成"缺汇率"排除掉。对个人记账来说，稳定币按 1:1 折美元是通行口径，
 * 比"没有数据"更接近事实，也不会悄悄把金额算错（页面与文档都写明了这条口径）。
 *
 * 汇率页里手工添加同名币种即可覆盖这里的值（手工汇率优先级最高）。
 */
export const USD_PEGGED: Record<string, number> = {
	USDT: 1,
	USDC: 1,
	DAI: 1,
	FDUSD: 1,
	TUSD: 1,
	USDP: 1,
	PYUSD: 1,
	BUSD: 1,
	USDE: 1,
};

/** 内置平价汇率：base → quote。查不到返回 null（调用方继续走"未折算"的口径）。 */
export function peggedRate(base: string, quote: string): number | null {
	const from = (base ?? "").trim().toUpperCase();
	const to = (quote ?? "").trim().toUpperCase();
	if (!from || !to) return null;
	if (from === to) return 1;

	const pegFrom = USD_PEGGED[from];
	const pegTo = USD_PEGGED[to];
	// 稳定币之间也是 1:1（USDT → USDC）
	if (pegFrom !== undefined && pegTo !== undefined && pegTo !== 0) return pegFrom / pegTo;
	if (pegFrom !== undefined && to === "USD") return pegFrom;
	if (pegTo !== undefined && from === "USD" && pegTo !== 0) return 1 / pegTo;
	return null;
}

/** 库里/数据源里都没有的情况下，这个货币对是否有内置平价可用（用于避免注定失败的请求） */
export function hasPeggedRate(base: string, quote: string): boolean {
	return peggedRate(base, quote) !== null;
}
