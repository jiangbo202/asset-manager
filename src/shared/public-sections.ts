/**
 * 「公开只读分享」的可分享区域
 *
 * 定成共享模块的原因：服务端要按它裁剪响应（**真正的边界**），前端要按它决定渲染与是否发请求，
 * 设置页要按它渲染勾选框 —— 三处必须用同一份定义，否则又会出现"界面藏着、接口还漏着"。
 *
 * 与总览页的对应关系：
 *   summary   开头：总资产、账户/持仓数、价格新鲜度、缺汇率与停更提示
 *   trend     走势：每日净值曲线
 *   breakdown 分布：环形图 + treemap + 筛选器
 *   holdings  持仓明细：数量、单价、成本、盈亏那张表
 */

export const PUBLIC_SECTIONS = ["summary", "trend", "breakdown", "holdings"] as const;

export type PublicSection = (typeof PUBLIC_SECTIONS)[number];

/** 默认全部分享（打开开关但不选区域时按这个来，最不容易让人意外） */
export const DEFAULT_PUBLIC_SECTIONS: readonly PublicSection[] = PUBLIC_SECTIONS;

export function isPublicSection(value: string): value is PublicSection {
	return (PUBLIC_SECTIONS as readonly string[]).includes(value);
}

/**
 * 解析存库的字符串（英文逗号分隔）。
 * 没存过 → 默认全部；存了但全是脏值 → 视为"没有可分享的区域"（不放行任何分区接口）。
 */
export function parsePublicSections(raw: string | null | undefined): PublicSection[] {
	if (raw === null || raw === undefined) return [...DEFAULT_PUBLIC_SECTIONS];
	const values = raw
		.split(",")
		.map((item) => item.trim())
		.filter(isPublicSection);
	// 去重且按 PUBLIC_SECTIONS 的顺序，比较和展示都稳定
	return PUBLIC_SECTIONS.filter((section) => values.includes(section));
}

export function serializePublicSections(sections: readonly PublicSection[]): string {
	return PUBLIC_SECTIONS.filter((section) => sections.includes(section)).join(",");
}
