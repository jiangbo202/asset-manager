import { useState } from "react";
import { api, type AuditItemDto } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useT, useTimeZone } from "../lib/i18n";
import { dateTime } from "../lib/format";
import { zonedDayRange } from "../../shared/time";
import type { Translator } from "../../shared/i18n";

const ENTITY_KEYS = ["account", "holding", "settings", "fx", "auth", "backup", "quotes", "snapshot"] as const;
const ACTION_KEYS = ["create", "update", "delete", "import", "replace", "login", "setup", "security"] as const;

const entityLabel = (t: Translator, entity: string): string =>
	(ENTITY_KEYS as readonly string[]).includes(entity) ? t(`history.entity.${entity}`) : entity;
const actionLabel = (t: Translator, action: string): string =>
	(ACTION_KEYS as readonly string[]).includes(action) ? t(`history.action.${action}`) : action;

const renderValue = (value: unknown): string => {
	if (value === null || value === undefined) return "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

function AuditRow({ item }: { item: AuditItemDto }) {
	const t = useT();
	const timeZone = useTimeZone();
	return (
		<details className="audit">
			<summary>
				<span className="badge">{entityLabel(t, item.entity)}</span>
				<strong>{actionLabel(t, item.action)}</strong>
				<span className="muted small">{item.note ?? item.entityId ?? ""}</span>
				<span className="spacer" style={{ flex: 1 }} />
				<span className="muted small">
					{item.source} · {dateTime(item.ts, timeZone)}
				</span>
			</summary>
			<div className="body">
				{item.diff.length === 0 ? (
					<div className="muted small">{t("history.noFieldChange")}</div>
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
	const t = useT();
	const timeZone = useTimeZone();
	const [entity, setEntity] = useState("");
	const [action, setAction] = useState("");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [page, setPage] = useState(1);

	// 日期选择器给的是"配置时区里的那一天"，换算成 UTC 边界去查（审计时间戳存 UTC）
	const fromIso = from ? zonedDayRange(from, timeZone).fromIso : undefined;
	const toIso = to ? zonedDayRange(to, timeZone).toIso : undefined;

	const history = useAsync(
		() =>
			api.history({
				entity: entity || undefined,
				action: action || undefined,
				from: fromIso,
				to: toIso,
				page,
				pageSize: 50,
			}),
		[entity, action, fromIso, toIso, page],
	);

	const data = history.data;
	const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
	const resetPage = () => setPage(1);

	return (
		<>
			<div className="section-head">
				<h2>{t("history.title")}</h2>
				<div className="spacer" />
				<select
					value={entity}
					onChange={(e) => {
						setEntity(e.target.value);
						resetPage();
					}}
					style={{ width: 140 }}
				>
					<option value="">{t("history.allEntities")}</option>
					{ENTITY_KEYS.map((key) => (
						<option key={key} value={key}>
							{entityLabel(t, key)}
						</option>
					))}
				</select>
				<select
					value={action}
					onChange={(e) => {
						setAction(e.target.value);
						resetPage();
					}}
					style={{ width: 140 }}
				>
					<option value="">{t("history.allActions")}</option>
					{ACTION_KEYS.map((key) => (
						<option key={key} value={key}>
							{actionLabel(t, key)}
						</option>
					))}
				</select>
				<input
					type="date"
					value={from}
					onChange={(e) => {
						setFrom(e.target.value);
						resetPage();
					}}
					style={{ width: 150 }}
					title={t("history.dateFrom")}
				/>
				<input
					type="date"
					value={to}
					onChange={(e) => {
						setTo(e.target.value);
						resetPage();
					}}
					style={{ width: 150 }}
					title={t("history.dateTo")}
				/>
				{(entity || action || from || to) && (
					<button
						className="ghost"
						onClick={() => {
							setEntity("");
							setAction("");
							setFrom("");
							setTo("");
							resetPage();
						}}
					>
						{t("history.clearFilters")}
					</button>
				)}
			</div>

			{!data ? (
				<div className="empty">{t("common.loading")}</div>
			) : data.items.length === 0 ? (
				<div className="card empty">{t("history.empty")}</div>
			) : (
				<>
					<div className="card">
						{data.items.map((item) => (
							<AuditRow key={item.id} item={item} />
						))}
					</div>
					<div className="section-head" style={{ marginTop: 12 }}>
						<span className="small muted">
							{t("history.summary", { total: data.total, page: data.page, pages: totalPages })}
						</span>
						<div className="spacer" />
						<button className="ghost" disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
							{t("history.prev")}
						</button>
						<button className="ghost" disabled={page >= totalPages} onClick={() => setPage((v) => v + 1)}>
							{t("history.next")}
						</button>
					</div>
				</>
			)}
		</>
	);
}
