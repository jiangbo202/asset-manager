/**
 * 从 Cloudflare 读取本账号的免费额度用量（设置页最底部那张卡）
 *
 * 为什么需要 API Token：**额度是按账号统计的，Worker 自己拿不到**。
 * Workers 请求数、D1 行读/行写、D1 库大小都只有 Cloudflare 侧知道：
 *   - Workers 请求：GraphQL Analytics `workersInvocationsAdaptive`
 *   - D1 行读/行写：GraphQL Analytics `d1AnalyticsAdaptiveGroups`
 *   - D1 库大小：REST `GET /accounts/{id}/d1/database/{db}` 的 `file_size`
 * 所以这是一个**可选**功能：不填 Token 就整张卡显示成"未配置"，其它功能完全不受影响。
 *
 * Token 权限只需要只读的两项：**Account Analytics: Read** + **D1: Read**。
 * 存库时和行情 API Key 一样加密（见 core/secrets.ts），任何接口都不会回传它。
 *
 * 不复用同一个 Token 做别的：这个模块只发 GET/POST 到 api.cloudflare.com 的只读查询。
 */

/** 免费版额度（写死在这里，界面上用来显示 x/y；数值来自 Cloudflare 定价页） */
export const FREE_LIMITS = {
	/** Workers 请求：100,000 / 天（UTC 零点重置） */
	requestsPerDay: 100_000,
	/** D1 行读：5,000,000 / 天 */
	rowsReadPerDay: 5_000_000,
	/** D1 行写：100,000 / 天 */
	rowsWrittenPerDay: 100_000,
	/** 单库大小上限：免费版 500 MB（账号总存储 5 GB） */
	databaseBytes: 500 * 1024 * 1024,
	accountStorageBytes: 5 * 1024 * 1024 * 1024,
} as const;

export interface CfUsage {
	/** 抓取时刻（UTC ISO） */
	fetchedAt: string;
	/** 统计窗口：今天（UTC 零点到现在）—— 免费额度就是按 UTC 日重置的 */
	windowStart: string;
	windowEnd: string;
	/** 今日 Worker 请求数（拿不到时为 null，例如脚本名写错） */
	requests: number | null;
	/** 今日 D1 行读 / 行写 */
	rowsRead: number | null;
	rowsWritten: number | null;
	/** 用到的 D1 库（名字 → id → 大小） */
	database: { id: string; name: string; fileSize: number | null } | null;
}

export interface UsageInput {
	token: string;
	accountId: string;
	/** Worker 脚本名（Analytics 按它过滤；留空则用 workers.dev 主机名的第一段） */
	scriptName: string;
	/** D1 库名（留空则取账号下唯一的库 / 名字匹配的那个） */
	databaseName: string;
	fetcher?: typeof fetch;
}

const API = "https://api.cloudflare.com/client/v4";

/** UTC 当天零点（免费额度按 UTC 日重置，所以窗口必须是 UTC 日） */
export function utcDayStart(now = new Date()): Date {
	const start = new Date(now.getTime());
	start.setUTCHours(0, 0, 0, 0);
	return start;
}

interface GraphQlResponse<T> {
	data?: T;
	errors?: Array<{ message?: string }>;
}

/** 把 Cloudflare 的报错整理成人能看懂的一句话 */
export function describeCloudflareError(status: number, body: string): string {
	const permission = "Token 无效或权限不足：需要 Account Analytics: Read 与 D1: Read 两项只读权限";
	if (status === 401 || status === 403) return permission;
	let detail = "";
	try {
		const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }> };
		detail = parsed.errors?.[0]?.message ?? "";
	} catch {
		detail = body.slice(0, 200);
	}
	return detail ? `Cloudflare 返回错误（HTTP ${status}）：${detail}` : `Cloudflare 返回错误（HTTP ${status}）`;
}

async function graphql<T>(input: UsageInput, query: string, variables: Record<string, unknown>): Promise<T> {
	const fetcher = input.fetcher ?? fetch;
	const response = await fetcher(`${API}/graphql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(describeCloudflareError(response.status, text));
	const parsed = JSON.parse(text) as GraphQlResponse<T>;
	if (parsed.errors?.length) {
		const message = parsed.errors.map((item) => item.message ?? "").join("; ");
		throw new Error(`GraphQL 查询失败：${message}（检查 Account ID 是否正确）`);
	}
	if (!parsed.data) throw new Error("GraphQL 没有返回数据");
	return parsed.data;
}

interface WorkersAnalytics {
	viewer?: {
		accounts?: Array<{
			workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
		}>;
	};
}

/** 从 workersInvocationsAdaptive 的返回里求和（行数不定，逐行相加） */
export function sumWorkerRequests(data: WorkersAnalytics): number | null {
	const rows = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
	if (rows.length === 0) return null;
	return rows.reduce((total, row) => total + (row.sum?.requests ?? 0), 0);
}

interface D1Analytics {
	viewer?: {
		accounts?: Array<{
			d1AnalyticsAdaptiveGroups?: Array<{ sum?: { rowsRead?: number; rowsWritten?: number } }>;
		}>;
	};
}

export function sumD1Rows(data: D1Analytics): { rowsRead: number | null; rowsWritten: number | null } {
	const rows = data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
	if (rows.length === 0) return { rowsRead: null, rowsWritten: null };
	return {
		rowsRead: rows.reduce((total, row) => total + (row.sum?.rowsRead ?? 0), 0),
		rowsWritten: rows.reduce((total, row) => total + (row.sum?.rowsWritten ?? 0), 0),
	};
}

interface D1DatabaseRow {
	uuid?: string;
	name?: string;
	file_size?: number;
}

/** 找出目标 D1 库：先按名字匹配，只有一个库时直接用那个 */
export function pickDatabase(rows: D1DatabaseRow[], wanted: string): D1DatabaseRow | null {
	if (rows.length === 0) return null;
	const name = wanted.trim();
	if (name) {
		const matched = rows.find((row) => row.name === name);
		if (matched) return matched;
	}
	return rows.length === 1 ? rows[0] : null;
}

async function rest<T>(input: UsageInput, path: string): Promise<T> {
	const fetcher = input.fetcher ?? fetch;
	const response = await fetcher(`${API}${path}`, {
		headers: { Authorization: `Bearer ${input.token}` },
	});
	const text = await response.text();
	if (!response.ok) throw new Error(describeCloudflareError(response.status, text));
	const parsed = JSON.parse(text) as { result?: T };
	return parsed.result as T;
}

/** 一次抓取：Workers 请求 + D1 行读行写 + 库大小（共 3~4 个子请求） */
export async function fetchCloudflareUsage(input: UsageInput, now = new Date()): Promise<CfUsage> {
	const start = utcDayStart(now);
	const windowStart = start.toISOString();
	const windowEnd = now.toISOString();

	const workersQuery = `
		query ($account: String!, $start: Time!, $end: Time!, $script: String!) {
			viewer {
				accounts(filter: { accountTag: $account }) {
					workersInvocationsAdaptive(
						limit: 100
						filter: { datetime_gt: $start, datetime_lt: $end, scriptName: $script }
					) {
						sum { requests }
					}
				}
			}
		}`;

	// 先解析数据库（拿到 id 才能按库查 D1 用量与大小）
	const databases = await rest<D1DatabaseRow[]>(input, `/accounts/${input.accountId}/d1/database`);
	const database = pickDatabase(databases ?? [], input.databaseName);
	const databaseId = database?.uuid ?? "";

	const scriptName = input.scriptName.trim() || "asset-manager";

	const [workersData, d1Data] = await Promise.all([
		graphql<WorkersAnalytics>(input, workersQuery, {
			account: input.accountId,
			start: windowStart,
			end: windowEnd,
			script: scriptName,
		}),
		databaseId
			? graphql<D1Analytics>(
					input,
					`query ($account: String!, $start: Date!, $end: Date!, $db: String!) {
						viewer {
							accounts(filter: { accountTag: $account }) {
								d1AnalyticsAdaptiveGroups(
									limit: 100
									filter: { date_geq: $start, date_leq: $end, databaseId: $db }
								) {
									dimensions { date }
									sum { rowsRead rowsWritten }
								}
							}
						}
					}`,
					{
						account: input.accountId,
						start: windowStart.slice(0, 10),
						end: windowEnd.slice(0, 10),
						db: databaseId,
					},
				)
			: Promise.resolve({} as D1Analytics),
	]);

	const d1Rows = databaseId ? sumD1Rows(d1Data) : { rowsRead: null, rowsWritten: null };

	// 库大小：REST 的 file_size（列表接口不返回，需要单查）
	let fileSize: number | null = null;
	if (databaseId) {
		try {
			const detail = await rest<D1DatabaseRow>(
				input,
				`/accounts/${input.accountId}/d1/database/${databaseId}?fields=uuid,name,file_size`,
			);
			fileSize = typeof detail?.file_size === "number" ? detail.file_size : null;
		} catch {
			// 大小拿不到不影响其它数字（例如 Token 少了 D1 Read 但能读分析数据）
			fileSize = null;
		}
	}

	return {
		fetchedAt: windowEnd,
		windowStart,
		windowEnd,
		requests: sumWorkerRequests(workersData),
		rowsRead: d1Rows.rowsRead,
		rowsWritten: d1Rows.rowsWritten,
		database: databaseId
			? { id: databaseId, name: database?.name ?? input.databaseName, fileSize }
			: null,
	};
}
