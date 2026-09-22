/**
 * 免费额度用尽时的 D1 报错识别（纯函数）
 *
 * 为什么要单独识别：超限时 D1 会把错误抛上来，如果只按"服务异常"处理，
 * 用户看到的就是一句没有信息量的 500 —— 而实际情况是"今天的免费额度用完了，
 * UTC 零点自动恢复，数据没丢"，完全不需要排查代码。
 *
 * 报错原文（Cloudflare 官方，2026-09 起 D1 免费版每天的超额会直接让查询失败）：
 *   Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan
 *   or wait until tomorrow (midnight UTC) to continue.
 *   Your account has exceeded D1's free tier daily row write limit. …
 *   The account has reached its daily row read limit. / … row write limit.
 */

export type QuotaIssue = "d1_daily_read" | "d1_daily_write" | "d1_storage" | null;

export function classifyQuotaError(raw: string | null | undefined): QuotaIssue {
	const message = String(raw ?? "");
	if (message === "") return null;

	if (/daily row read limit|daily read limit/i.test(message)) return "d1_daily_read";
	if (/daily row write limit|daily write limit/i.test(message)) return "d1_daily_write";
	// 存储写满：文案在不同版本里不一样，取几个保守特征
	if (/maximum db size|maximum database size|database is full|storage limit/i.test(message)) return "d1_storage";
	return null;
}
