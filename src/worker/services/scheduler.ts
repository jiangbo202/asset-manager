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
 *  - 顺便具备自愈能力：漏跑的当天只要还没拍快照，后续小时到达配置点时仍会补上。
 *
 * 顺序：**先刷新行情，再拍快照**，这样快照用的是当天较新的价格。
 */

export interface CronResult {
	ran: boolean;
	reason: string;
	quotes?: { updated: number; fxUpdated: number; failed: number; requests: number };
	snapshot?: { date: string; total: number; currency: string; created: boolean };
}

export async function handleCron(env: Env, now = new Date()): Promise<CronResult> {
	const snapshotHour = await getSnapshotHour(env.DB);
	const timeZone = await getTimeZone(env.DB);
	const localHour = hourIn(timeZone, now);

	if (localHour !== snapshotHour) {
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

	let quotes: CronResult["quotes"];
	const enabled = (await getSetting(env.DB, "market_data_enabled")) !== "0";
	if (enabled) {
		try {
			const report = await refreshQuotes(env, { trigger: "cron" });
			quotes = {
				updated: report.updated,
				fxUpdated: report.fxUpdated,
				failed: report.failed.length,
				requests: report.requests,
			};
		} catch (error) {
			// 行情失败不能影响快照：价格陈旧的快照也远比没有快照好
			console.error("[cron] 行情刷新失败:", error instanceof Error ? error.message : error);
		}
	}

	const snapshot = await takeSnapshot(env.DB, { date: today });
	return {
		ran: true,
		reason: "已生成当日快照",
		quotes,
		snapshot: {
			date: snapshot.date,
			total: snapshot.total,
			currency: snapshot.currency,
			created: snapshot.created,
		},
	};
}
