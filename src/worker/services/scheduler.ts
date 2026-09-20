import type { Env } from "../types";
import { getSettings, snapshotHourOf, timeZoneOf } from "../data/settings.repo";
import { dateIn, hourIn } from "../../shared/time";
import { refreshQuotes } from "./quotes";
import { takeSnapshot } from "./snapshots";

/**
 * Cron 调度（每小时触发一次，见 wrangler.jsonc 的 triggers）
 *
 * 为什么用"每小时 + 小时闸门"而不是"每天 22:00 精确触发"：
 *  - Worker 的 cron 表达式只能写 UTC，而"快照时间"是用户配置项；
 *    小时闸门让它可配置，且不用改代码/重新部署。
 *  - 顺便具备自愈能力：过了配置时间而当天的事没做完，后续每个小时会接着做。
 *
 * **一次调用只干一件重活**（线上实测后的结构调整）：
 *  正好是配置的小时 → 刷新行情（这一件事线上就要 10ms 左右）
 *  已过配置的小时且当天还没快照 → 拍快照
 * 免费版每次调用只有 10ms CPU，把两件事摍在一次调用里（原来就是这样）会稳定超限：
 * 虽然 Cloudflare 有 CPU 时间结转机制不会每次都报错，但那是借额度，随时会真的失败。
 * 拆开后两次调用各自都有余量，而快照用的是上一次刷新到的价格——它本来就是日级数据。
 */

/**
 * 一次定时运行最多刷新多少个持仓。
 *
 * 取值依据（线上实测，npm run watch:cpu）：
 *  - 行情刷新 8ms 时对应 2 个标的 + 1 个汇率，其中固定开销（设置/持仓/汇率读取、
 *    模块工作、子请求与 JSON 解析）约 3–4ms，每个标的约 2ms（三条写入语句）。
 *  - 免费版每次调用 10ms，所以留出余量后取 6。
 *
 * 超出上限的持仓按"最久没更新"排到下一次运行（公平轮转，不会永远饿死同一批），
 * 快照照常拍摄、用这些标的当前已知的价格。持仓很多时报价会跨天轮转——
 * 这是免费额度下的取舍；手动点「立即刷新行情」不受此限制。
 */
export const CRON_MAX_HOLDINGS = 6;

export interface CronResult {
	ran: boolean;
	reason: string;
	quotes?: {
		updated: number;
		fxUpdated: number;
		failed: number;
		requests: number;
		/** 因为分批而留到下一次运行的标的数 */
		deferred: number;
	};
	snapshot?: { date: string; total: number; currency: string; created: boolean };
}

export async function handleCron(env: Env, now = new Date()): Promise<CronResult> {
	// 一次读出全部设置（早先是两次 getSetting = 两次往返）
	const settings = await getSettings(env.DB);
	const snapshotHour = snapshotHourOf(settings);
	const timeZone = timeZoneOf(settings);
	const localHour = hourIn(timeZone, now);

	// 还没到配置的小时 → 什么都不做
	if (localHour < snapshotHour) {
		return {
			ran: false,
			reason: `当前 ${timeZone} 时间 ${localHour} 点，快照时间配置为 ${snapshotHour} 点`,
		};
	}

	// "今天"按用户时区的日历日计算（快照日期、去重判断都用它）
	const today = dateIn(timeZone, now);
	const latest = await env.DB.prepare(`SELECT date FROM snapshots ORDER BY date DESC LIMIT 1`).first<{
		date: string;
	}>();
	const hasSnapshotToday = latest?.date === today;

	/* ── 阶段一：刷新行情（只在配置的那个小时） ── */
	let quotes: CronResult["quotes"];
	const enabled = settings.market_data_enabled !== "0";

	if (enabled && localHour === snapshotHour) {
		try {
			const report = await refreshQuotes(env, { trigger: "cron", maxHoldings: CRON_MAX_HOLDINGS });
			quotes = {
				updated: report.updated,
				fxUpdated: report.fxUpdated,
				failed: report.failed.length,
				requests: report.requests,
				deferred: report.deferred.length,
			};
		} catch (error) {
			// 行情失败不能影响快照：价格陈旧的快照也远比没有快照好
			console.error("[cron] 行情刷新失败:", error instanceof Error ? error.message : error);
		}

		// 刷成功就把快照留给下一个整点：一次调用只干一件重活。
		// 刷新失败（quotes 为空）则直接往下走，否则行情长期失败会导致快照永远拍不了。
		if (quotes && !hasSnapshotToday) {
			return { ran: true, reason: "已刷新行情，快照留给下一个整点", quotes };
		}
	}

	if (hasSnapshotToday) {
		return { ran: false, reason: "今天已有快照", quotes };
	}

	/* ── 阶段二：拍当日快照（包含过了点没拍成的补拍） ── */
	const catchUp = localHour > snapshotHour;
	const snapshot = await takeSnapshot(env.DB, { date: today });
	return {
		ran: true,
		reason: catchUp ? "已补拍当日快照" : "已生成当日快照",
		quotes,
		snapshot: {
			date: snapshot.date,
			total: snapshot.total,
			currency: snapshot.currency,
			created: snapshot.created,
		},
	};
}
