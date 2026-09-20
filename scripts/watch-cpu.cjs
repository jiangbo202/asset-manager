#!/usr/bin/env node
/**
 * 实时看线上每次请求的 CPU 时间
 *
 * 为什么需要这个脚本：`wrangler tail` 默认的 pretty 输出只有「方法 / URL / 状态」，
 * **不显示 cpuTime** —— 而 CPU 时间是本项目"免费额度够不够用"的唯一硬指标（上限 10ms）。
 * 加上 `--format json` 后每个事件里有 cpuTime，这里把它流式读出来做统计。
 *
 * 用法：
 *   npm run watch:cpu              # 连线上，实时统计（Ctrl-C 结束并打印汇总）
 *   npm run watch:cpu -- --demo    # 用合成数据演示输出，不连 Cloudflare
 *
 * 判断标准：仪表盘与写操作 1–3ms 属正常；持续 >5ms 值得看一眼；≥10ms 会被 Cloudflare
 * 中断（tail 里 outcome 会变成 exceededCpu，请求返回 5xx）。
 */
const { spawn } = require("node:child_process");

const BUDGET_MS = 10; // 免费版硬上限
const WARN_MS = 5; // 超过一半预算就值得关注

const samples = [];

/** 从一行 tail JSON 里提取关心的字段；不是请求事件就返回 null */
function parseEvent(line) {
	let evt;
	try {
		evt = JSON.parse(line);
	} catch {
		return null;
	}
	if (evt.cpuTime === undefined || evt.cpuTime === null) return null;

	const request = evt.event?.request;
	let label = "scheduled (cron)";
	if (request?.url) {
		try {
			const url = new URL(request.url);
			label = `${request.method ?? "GET"} ${url.pathname}${url.search}`;
		} catch {
			label = `${request.method ?? "GET"} ${request.url}`;
		}
	}

	return {
		cpu: Number(evt.cpuTime),
		wall: evt.wallTime === undefined ? null : Number(evt.wallTime),
		label,
		status: evt.event?.response?.status ?? 0,
		outcome: evt.outcome ?? "?",
		when: evt.eventTimestamp ? new Date(evt.eventTimestamp).toLocaleTimeString() : "",
	};
}

function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

function reportLine(sample) {
	const cpu = `${sample.cpu.toFixed(1)}ms`.padStart(7);
	const wall = sample.wall === null ? "     -" : `${sample.wall}ms`.padStart(7);
	const flag =
		sample.outcome !== "ok" ? " ⚠️ " + sample.outcome : sample.cpu >= WARN_MS ? " ⚠️" : "";
	const status = sample.status ? ` ${sample.status}` : "";
	console.log(`  ${cpu} cpu / ${wall} wall  ${sample.label}${status}${flag}`);
}

function summary() {
	if (samples.length === 0) {
		console.log("\n[watch:cpu] 没有采集到请求事件");
		return;
	}
	const cpus = samples.map((sample) => sample.cpu);
	const overWarn = samples.filter((sample) => sample.cpu >= WARN_MS);
	const overBudget = samples.filter((sample) => sample.cpu >= BUDGET_MS);
	const failed = samples.filter((sample) => sample.outcome !== "ok");

	console.log(`\n[watch:cpu] 共 ${samples.length} 次请求`);
	console.log(`  p50 ${percentile(cpus, 50)}ms · p95 ${percentile(cpus, 95)}ms · max ${Math.max(...cpus)}ms`);
	console.log(`  ≥${WARN_MS}ms：${overWarn.length} 次 · ≥${BUDGET_MS}ms：${overBudget.length} 次 · 非 ok：${failed.length} 次`);

	if (overBudget.length > 0) {
		console.log(`  ✗ 有请求触到 ${BUDGET_MS}ms 上限，需要优化：`);
		for (const sample of overBudget.sort((a, b) => b.cpu - a.cpu).slice(0, 5)) reportLine(sample);
	} else if (percentile(cpus, 95) >= WARN_MS) {
		console.log("  ⚠️  p95 已超过一半预算，仍可用但建议优化");
	} else {
		console.log(`  ✅ 距免费版 ${BUDGET_MS}ms 上限有充裕余量`);
	}
}

function demo() {
	const fake = [
		["GET /api/portfolio", 3, "ok", 200], ["GET /api/accounts", 1, "ok", 200],
		["GET /api/holdings", 1, "ok", 200], ["GET /api/portfolio/history?range=3M", 2, "ok", 200],
		["POST /api/holdings", 2, "ok", 201], ["GET /api/quotes/status", 1, "ok", 200],
		["POST /api/quotes/refresh", 6, "ok", 200], ["POST /api/portfolio/snapshots", 4, "ok", 200],
		["GET /api/settings/overview", 1, "ok", 200], ["GET /api/auth/me", 1, "ok", 200],
	];
	for (const [label, cpu, outcome, status] of fake) {
		const sample = { cpu, wall: cpu * 4 + 20, label, status, outcome, when: "" };
		samples.push(sample);
		reportLine(sample);
	}
	console.log("\n  ↑ 以上是合成数据（--demo），用于确认输出格式");
	summary();
}

/* ── 主流程 ─────────────────────────────────────────────── */
if (process.argv.includes("--demo")) {
	demo();
	process.exit(0);
}

console.log(`[watch:cpu] 连接线上 Worker…（免费版 CPU 上限 ${BUDGET_MS}ms，Ctrl-C 结束）`);
const child = spawn("npx", ["wrangler", "tail", "--format", "json"], {
	stdio: ["ignore", "pipe", "inherit"],
	shell: process.platform === "win32",
});

let buffered = "";
child.stdout.on("data", (chunk) => {
	buffered += chunk.toString();
	const lines = buffered.split("\n");
	buffered = lines.pop() ?? "";
	for (const line of lines) {
		const sample = parseEvent(line);
		if (sample) {
			samples.push(sample);
			reportLine(sample);
		}
	}
});

const stop = () => {
	summary();
	child.kill("SIGINT");
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
	summary();
	process.exit(code ?? 0);
});
