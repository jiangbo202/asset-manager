import type { Env } from "../types";
import { getSetting, getSnapshotHour, getTimeZone } from "../data/settings.repo";
import { dateIn, hourIn } from "../../shared/time";
import { refreshQuotes } from "./quotes";
import { takeSnapshot } from "./snapshots";

/**
 * Cron 调度（每小时触发一次，见 wrangler.jsonc 的 triggers）
 *
 * 为什么用"每小时 + 小时闸门"而不是"每天 22:00 精确触发"：
 *  - Worker 的 cron 表达式只能写 UTC，而"快照时间"是用户配置项；
 *    小时闸门让它可配置，且不用改代码/重新部署。
 *  - 顺便具备自愈能力：过了配置时间而当天还没有快照，后续每个小时都会再试一次。
 *
 * 顺序：**先刷新行情，再拍快照**，这样快照用的是当天较新的价格。
 *
 * 免费额度约束（免费版每次调用 10ms CPU）：真正的重活是"刷新行情 + 拍快照"这一趟，
 * 其余小时的闸门开销只是两次配置读取。所以重活做两件事控制开销：
 *  1. 持仓分批刷新（见 CRON_MAX_HOLDINGS）
 *  2. 一天只跑一次，其余小时直接返回
 */

/**
 * 一次定时运行最多刷新多少个持仓。
 *
 * CPU 开销大致随标的数量线性增长，而免费版每次调用只有 10ms CPU；
 * 重跑一趟（行情 + 快照）在几条持仓时已经用掉约 7ms，不能让持仓数量无限推高它。
 * 超出上限的持仓会被留到下一次运行（按"最久没更新"排序，所以会公平轮转），
 * 快照照常拍摄，用这些标的当前已知的价格。手动点「立即刷新行情」不受此限制。
 */
export const CRON_MAX_HOLDINGS = 12;

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
	const snapshotHour = await getSnapshotHour(env.DB);
	const timeZone = await getTimeZone(env.DB);
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
	if (latest?.date === today) {
		return { ran: false, reason: "今天已有快照" };
	}

	// 走到这里有两种情况：
	//  - 正好是配置的小时；
	//  - 已经过了配置的小时，但今天还没有快照 —— 那次没跑成（例如超出免费版 CPU 被中断），
	//    现在补跑。这让"自愈"能覆盖"到点那次失败"，而不是只能等第二天。
	const catchUp = localHour > snapshotHour;

	let quotes: CronResult["quotes"];
	const enabled = (await getSetting(env.DB, "market_data_enabled")) !== "0";
	if (enabled) {
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
	}

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
