import { useState } from "react";
import { api, type AccountDto, type AuditItemDto } from "../lib/api";
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

/** 带"字段感知"的渲染：account_id 这类外键要显示成人看得懂的名字 */
const renderField = (field: string, value: unknown, accountNames: Map<string, string>): string => {
	if (field === "account_id" && typeof value === "string") {
		return accountNames.get(value) ?? "（已删除的账户）";
	}
	return renderValue(value);
};

/** 行内摘要用的短值（展开后能看完整值） */
const shortValue = (value: unknown, max = 18): string => {
	const text = renderValue(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * 字段名 → 文案键。
 * 目的：历史列表里不能再出现 0mua0h76f-3zlw76inb3 这种原始 id，
 * 也不能让人对着 qty / price_updated_at 猜意思。
 */
const FIELD_KEYS: Record<string, string> = {
	name: "history.field.name",
	symbol: "history.field.symbol",
	qty: "history.field.qty",
	price: "history.field.price",
	currency: "history.field.currency",
	market: "history.field.market",
	class: "history.field.class",
	account_id: "history.field.account",
	kind: "history.field.kind",
	icon_key: "history.field.icon",
	sort: "history.field.sort",
	archived: "history.field.archived",
	note: "history.field.note",
	quote_source: "history.field.quoteSource",
	quote_symbol: "history.field.quoteSymbol",
	price_updated_at: "history.field.priceUpdatedAt",
	timezone: "history.field.timezone",
	language: "history.field.language",
	display_currency: "history.field.displayCurrency",
	snapshot_hour_utc: "history.field.snapshotHour",
	market_data_enabled: "history.field.marketDataEnabled",
	provider_config: "history.field.providerConfig",
	provider_keys: "history.field.providerKeys",
	provider_health: "history.field.providerHealth",
	schema_version: "history.field.schemaVersion",
	base: "history.field.base",
	quote: "history.field.quote",
	rate: "history.field.rate",
};

const fieldLabel = (t: Translator, field: string): string => {
	const key = FIELD_KEYS[field];
	return key ? t(key) : field;
};

/** 时间戳类字段不进行内摘要（展开后才看） */
const NOISY_FIELDS = new Set(["id", "created_at", "updated_at", "price_updated_at"]);

/**
 * 这条记录说的是"谁"：从审计快照里取标的/名称/日期/设置键。
 * 持仓与账户的记录里都带着这些字段，所以不需要额外查库，也不要再用 id。
 */
function subjectOf(item: AuditItemDto): string {
	const row = { ...(item.before ?? {}), ...(item.after ?? {}) } as Record<string, unknown>;
	const pick = (key: string): string | null =>
		typeof row[key] === "string" && (row[key] as string).trim() !== "" ? (row[key] as string) : null;

	const parts: string[] = [];
	const symbol = pick("symbol");
	const name = pick("name");
	if (symbol) parts.push(symbol);
	if (name && name !== symbol) parts.push(name);

	for (const key of ["date", "key", "base", "currency"]) {
		if (parts.length > 0) break;
		const value = pick(key);
		if (value) parts.push(value);
	}

	return parts.length > 0 ? parts.join(" · ") : (item.note ?? "");
}

/** 行内显示前几项变化，不用展开就能看出改了什么 */
function diffSummary(t: Translator, item: AuditItemDto): string | null {
	const changes = item.diff.filter((change) => !NOISY_FIELDS.has(change.field));
	if (changes.length === 0) return null;

	const shown = changes
		.slice(0, 2)
		.map((change) => `${fieldLabel(t, change.field)} ${shortValue(change.from)} → ${shortValue(change.to)}`);
	const rest = changes.length - shown.length;
	return shown.join("；") + (rest > 0 ? `；${t("history.moreFields", { count: rest })}` : "");
}

function AuditRow({ item, accountNames }: { item: AuditItemDto; accountNames: Map<string, string> }) {
	const t = useT();
	const timeZone = useTimeZone();
	const subject = subjectOf(item);
	const summary = diffSummary(t, item);

	return (
		<details className="audit">
			<summary>
				<span className="badge">{entityLabel(t, item.entity)}</span>
				<strong>{actionLabel(t, item.action)}</strong>
				{subject && <span className="audit-subject">{subject}</span>}
				{summary && <span className="muted small audit-summary">{summary}</span>}
				<span className="spacer" style={{ flex: 1 }} />
				<span className="muted small">
					{item.source} · {dateTime(item.ts, timeZone)}
				</span>
			</summary>
			<div className="body">
				{item.note && <div className="muted small">{item.note}</div>}
				{item.diff.length === 0 ? (
					<div className="muted small">{t("history.noFieldChange")}</div>
				) : (
					item.diff.map((change) => (
						<div className="diff-row" key={change.field}>
							<div className="k">{fieldLabel(t, change.field)}</div>
							<div>
								<span className="muted">{renderField(change.field, change.from, accountNames)}</span>
								<span className="muted"> → </span>
								<strong>{renderField(change.field, change.to, accountNames)}</strong>
							</div>
						</div>
					))
				)}
				<span className="muted small">
					{t("history.entityId", { id: item.entityId ?? "—" })}
				</span>
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

	// 历史里的 account_id 要显示成账户名（含归档账户：老记录可能指向它们）
	const accounts = useAsync<{ items: AccountDto[] }>(() => api.accounts.list(true), []);
	const accountNames = new Map((accounts.data?.items ?? []).map((item) => [item.id, item.name]));

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
							<AuditRow key={item.id} item={item} accountNames={accountNames} />
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
