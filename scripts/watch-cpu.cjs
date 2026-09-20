#!/usr/bin/env node
/**
 * 实时看线上每次请求的 CPU 时间
 *
 * 为什么需要这个脚本：`wrangler tail` 默认的 pretty 输出只有「方法 / URL / 状态」，
 * **不显示 cpuTime** —— 而 CPU 时间是本项目"免费额度够不够用"的唯一硬指标（上限 10ms）。
 * 加上 `--format json` 后每个事件里有 cpuTime。
 *
 * ⚠️ wrangler 的 json 格式是 `JSON.stringify(data, null, 4)`：**一个事件占多行**，
 * 所以不能按行解析（早先的版本就是这么错的，结果什么都读不出来）。这里改成按括号配平
 * 从流式文本里切出完整的 JSON 对象。
 *
 * 用法：
 *   npm run watch:cpu              # 连线上，实时统计（Ctrl-C 结束并打印汇总）
 *   npm run watch:cpu -- --demo    # 用合成数据跑通同一套解析逻辑，不连 Cloudflare
 *
 * 判断标准：仪表盘与写操作 1–3ms 属正常；持续 >5ms 值得看一眼；≥10ms 会被 Cloudflare
 * 中断（tail 里 outcome 会变成 exceededCpu，请求返回 5xx）。
 */
const { spawn } = require("node:child_process");

const BUDGET_MS = 10; // 免费版硬上限
const WARN_MS = 5; // 超过一半预算就值得关注

const samples = [];
let ignoredEvents = 0; // 收到了事件但没有 CPU 字段（wrangler 版本差异时用它提示）

/**
 * 从流式文本里切出完整的顶层 JSON 对象。
 * 每次都对累积缓冲重新扫描，所以不用跨块维护字符串/转义状态（缓冲里最多只有一两个事件）。
 */
function extractJsonObjects(text) {
	const objects = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}") {
			if (depth > 0) depth -= 1;
			if (depth === 0 && start >= 0) {
				objects.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}

	// 还没闭合的部分留到下一次（从最后一个未闭合对象开始；夹杂的 banner 文本直接丢掉）
	return { objects, rest: depth > 0 && start >= 0 ? text.slice(start) : "" };
}

/** 从单个 tail 事件里提取关心的字段；不是请求/定时事件就返回 null */
function parseEvent(text) {
	let evt;
	try {
		evt = JSON.parse(text);
	} catch {
		return null;
	}

	const cpu = evt.cpuTime ?? evt.cpu_time_ms ?? evt.cpuTimeMs;
	if (cpu === undefined || cpu === null) return null;

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
		cpu: Number(cpu),
		wall: evt.wallTime === undefined || evt.wallTime === null ? null : Number(evt.wallTime),
		label,
		status: evt.event?.response?.status ?? 0,
		outcome: evt.outcome ?? "?",
	};
}

/** 把一段 wrangler 风格的输出喂给解析器（--demo 与线上走的是同一条路径） */
function feed(chunk, bufferRef) {
	const { objects, rest } = extractJsonObjects(bufferRef.value + chunk);
	bufferRef.value = rest;
	for (const text of objects) {
		const sample = parseEvent(text);
		if (sample) {
			samples.push(sample);
			reportLine(sample);
		} else {
			ignoredEvents += 1;
		}
	}
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
	const flag = sample.outcome !== "ok" ? ` ⚠️ ${sample.outcome}` : sample.cpu >= WARN_MS ? " ⚠️" : "";
	const status = sample.status ? ` ${sample.status}` : "";
	console.log(`  ${cpu} cpu / ${wall} wall  ${sample.label}${status}${flag}`);
}

function summary() {
	if (samples.length === 0) {
		console.log("\n[watch:cpu] 没有采集到请求事件");
		if (ignoredEvents > 0) {
			console.log(`  收到了 ${ignoredEvents} 个事件，但里面没有 cpuTime 字段（wrangler 版本差异？）`);
		}
		return;
	}
	const cpus = samples.map((sample) => sample.cpu);
	const overWarn = samples.filter((sample) => sample.cpu >= WARN_MS);
	const overBudget = samples.filter((sample) => sample.cpu >= BUDGET_MS);
	const failed = samples.filter((sample) => sample.outcome !== "ok");

	console.log(`\n[watch:cpu] 共 ${samples.length} 次调用`);
	console.log(`  p50 ${percentile(cpus, 50)}ms · p95 ${percentile(cpus, 95)}ms · max ${Math.max(...cpus)}ms`);
	console.log(`  ≥${WARN_MS}ms：${overWarn.length} 次 · ≥${BUDGET_MS}ms：${overBudget.length} 次 · 非 ok：${failed.length} 次`);

	if (overBudget.length > 0) {
		console.log(`  ✗ 有调用触到 ${BUDGET_MS}ms 上限，需要优化：`);
		for (const sample of [...overBudget].sort((a, b) => b.cpu - a.cpu).slice(0, 5)) reportLine(sample);
	} else if (percentile(cpus, 95) >= WARN_MS) {
		console.log("  ⚠️  p95 已超过一半预算，仍可用但建议优化");
	} else {
		console.log(`  ✅ 距免费版 ${BUDGET_MS}ms 上限有充裕余量`);
	}
}

/** 合成一段"长得像 wrangler 输出"的流：banner + 多行缩进 JSON，并在事件中间切断 */
function demo() {
	const events = [
		{
			outcome: "ok",
			scriptName: "asset-manager",
			eventTimestamp: Date.now(),
			event: { request: { url: "https://asset-manager.example.workers.dev/api/portfolio", method: "GET" }, response: { status: 200 } },
			cpuTime: 3,
			wallTime: 42,
		},
		{
			outcome: "ok",
			eventTimestamp: Date.now(),
			event: { request: { url: "https://asset-manager.example.workers.dev/api/quotes/refresh", method: "POST" }, response: { status: 200 } },
			cpuTime: 6,
			wallTime: 910,
		},
		{
			outcome: "ok",
			eventTimestamp: Date.now(),
			event: { cron: "0 * * * *", scheduledTime: Date.now() },
			cpuTime: 4,
			wallTime: 1200,
		},
	];
	const stream =
		"Connected to asset-manager, waiting for logs...\n" +
		events.map((event) => JSON.stringify(event, null, 4) + "\n").join("");

	// 故意切成若干块，包括在 JSON 中间切开，验证缓冲拼接
	const bufferRef = { value: "" };
	const chunks = [stream.slice(0, 30), stream.slice(30, 400), stream.slice(400)];
	for (const chunk of chunks) feed(chunk, bufferRef);
	console.log("\n  ↑ 以上是合成数据（--demo）；banner 文本与多行 JSON 都走同一个解析器");
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

const bufferRef = { value: "" };
child.stdout.on("data", (chunk) => feed(chunk.toString(), bufferRef));

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
