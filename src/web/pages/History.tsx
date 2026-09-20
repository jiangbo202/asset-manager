import { useState } from "react";
import { api, type AuditItemDto } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { dateTime } from "../lib/format";

const ENTITY_LABELS: Record<string, string> = {
	account: "账户",
	holding: "持仓",
	settings: "设置",
	fx: "汇率",
	auth: "认证",
};

const ACTION_LABELS: Record<string, string> = {
	create: "创建",
	update: "修改",
	delete: "删除",
	import: "导入",
	replace: "覆盖导入",
	login: "登录",
	setup: "初始化",
	security: "安全操作",
};

const renderValue = (value: unknown): string => {
	if (value === null || value === undefined) return "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

function AuditRow({ item }: { item: AuditItemDto }) {
	return (
		<details className="audit">
			<summary>
				<span className="badge">{ENTITY_LABELS[item.entity] ?? item.entity}</span>
				<strong>{ACTION_LABELS[item.action] ?? item.action}</strong>
				<span className="muted small">{item.note ?? item.entityId ?? ""}</span>
				<span className="spacer" style={{ flex: 1 }} />
				<span className="muted small">
					{item.source} · {dateTime(item.ts)}
				</span>
			</summary>
			<div className="body">
				{item.diff.length === 0 ? (
					<div className="muted small">没有字段级变化（可能是整体新增/删除）。</div>
				) : (
					item.diff.map((change) => (
						<div className="diff-row" key={change.field}>
							<div className="k">{change.field}</div>
							<div>
								<span className="muted">{renderValue(change.from)}</span>
								<span className="muted"> → </span>
								<strong>{renderValue(change.to)}</strong>
							</div>
						</div>
					))
				)}
			</div>
		</details>
	);
}

export function HistoryPage() {
	const [entity, setEntity] = useState("");
	const [page, setPage] = useState(1);
	const history = useAsync(() => api.history({ entity: entity || undefined, page, pageSize: 50 }), [entity, page]);

	const data = history.data;
	const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

	return (
		<>
			<div className="section-head">
				<h2>操作历史</h2>
				<div className="spacer" />
				<select
					value={entity}
					onChange={(e) => {
						setEntity(e.target.value);
						setPage(1);
					}}
					style={{ width: 150 }}
				>
					<option value="">全部类型</option>
					{Object.entries(ENTITY_LABELS).map(([key, label]) => (
						<option key={key} value={key}>
							{label}
						</option>
					))}
				</select>
			</div>

			{!data ? (
				<div className="empty">加载中…</div>
			) : data.items.length === 0 ? (
				<div className="card empty">还没有操作记录。</div>
			) : (
				<>
					<div className="card">
						{data.items.map((item) => (
							<AuditRow key={item.id} item={item} />
						))}
					</div>
					<div className="section-head" style={{ marginTop: 12 }}>
						<span className="small muted">
							共 {data.total} 条 · 第 {data.page} / {totalPages} 页
						</span>
						<div className="spacer" />
						<button className="ghost" disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
							上一页
						</button>
						<button className="ghost" disabled={page >= totalPages} onClick={() => setPage((v) => v + 1)}>
							下一页
						</button>
					</div>
				</>
			)}
		</>
	);
}
