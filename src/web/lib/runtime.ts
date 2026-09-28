/**
 * 运行环境判断
 *
 * 「数据库需要升级」这张卡片最容易帮倒忙的地方，是**让用户去跑一条作用在别的库上的命令**：
 * 本机 `wrangler dev` 连的是本地 sqlite，线上站点连的是远端 D1，迁移各跑各的。
 * 实际踩过一次：线上页面提示升级，用户照着卡片跑了 `db:migrate:local`，
 * 终端回「No migrations to apply!」（本地早就应用过了），线上库仍是 v5 —— 于是"点了没反应"。
 *
 * 所以命令要按**当前页面所在的位置**给，而不是固定印一条。
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** 页面是不是跑在本机开发服务器上 */
export function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES.has(hostname.trim().toLowerCase());
}

export interface MigrationHint {
	/** 当前页面连的是本地库吗 */
	local: boolean;
	/** 应该执行的命令 */
	command: string;
	/** 另一侧的命令：明确写出来，避免用户再跑错一次 */
	otherCommand: string;
}

/** 本机 → `db:migrate:local`；线上 → `db:migrate:remote`（仍在你本机终端执行，只是连的是线上库） */
export function migrationHint(hostname: string): MigrationHint {
	const local = isLocalHostname(hostname);
	return local
		? { local, command: "npm run db:migrate:local", otherCommand: "npm run db:migrate:remote" }
		: { local, command: "npm run db:migrate:remote", otherCommand: "npm run db:migrate:local" };
}
