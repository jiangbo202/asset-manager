import type {
	AccountDto,
	AuditItemDto,
	AuthMeDto,
	FxRateDto,
	HoldingDto,
	HoldingListDto,
	ImportResult,
	OverviewDto,
	Portfolio,
	ProviderId,
	QuoteStatusDto,
	RefreshReportDto,
	SettingsDto,
	SnapshotItemDto,
	TrendSeriesDto,
} from "../../shared/api-types";

/** 统一 API 客户端：自动带 cookie、统一错误信息 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

interface ApiEnvelope<T> {
	ok: boolean;
	data?: T;
	error?: { code: string; message: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		credentials: "same-origin",
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
		...init,
	});

	let payload: ApiEnvelope<T> | null = null;
	try {
		payload = (await response.json()) as ApiEnvelope<T>;
	} catch {
		payload = null;
	}

	if (!response.ok || !payload?.ok) {
		throw new ApiError(
			response.status,
			payload?.error?.code ?? "request_failed",
			payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
		);
	}
	return payload.data as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

export const api = {
	auth: {
		me: () => request<AuthMeDto>("/api/auth/me"),
		params: () => request<{ initialized: boolean; kdfSalt: string | null; iterations: number }>("/api/auth/params"),
		setup: (body: { setupToken: string; credential: string; kdfSalt: string; iterations: number; displayCurrency?: string }) =>
			request<{ initialized: boolean }>("/api/auth/setup", json(body)),
		login: (body: { credential: string }) => request<{ mustChange: boolean }>("/api/auth/login", json(body)),
		logout: () => request<{ loggedOut: boolean }>("/api/auth/logout", { method: "POST" }),
		logoutAll: () => request<{ revoked: number }>("/api/auth/logout-all", { method: "POST" }),
		changePassword: (body: { oldCredential: string; newCredential: string; kdfSalt: string; iterations: number }) =>
			request<{ changed: boolean }>("/api/auth/change-password", json(body)),
	},

	accounts: {
		list: (includeArchived = false) =>
			request<{ items: AccountDto[] }>(`/api/accounts${includeArchived ? "?includeArchived=true" : ""}`),
		create: (body: Record<string, unknown>) => request<AccountDto>("/api/accounts", json(body)),
		update: (id: string, body: Record<string, unknown>) => request<AccountDto>(`/api/accounts/${id}`, patch(body)),
		remove: (id: string, cascadeHoldings = false) =>
			request<{ deleted: boolean }>(
				`/api/accounts/${id}${cascadeHoldings ? "?cascadeHoldings=true" : ""}`,
				{ method: "DELETE" },
			),
	},

	holdings: {
		list: (filter: { accountId?: string; class?: string; market?: string; includeArchived?: boolean } = {}) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(filter)) {
				if (value === undefined || value === "" || value === false) continue;
				query.set(key, String(value));
			}
			const suffix = query.toString() ? `?${query}` : "";
			return request<{ items: HoldingListDto[] }>(`/api/holdings${suffix}`);
		},
		create: (body: Record<string, unknown>) => request<HoldingDto>("/api/holdings", json(body)),
		update: (id: string, body: Record<string, unknown>) => request<HoldingDto>(`/api/holdings/${id}`, patch(body)),
		remove: (id: string) => request<{ deleted: boolean }>(`/api/holdings/${id}`, { method: "DELETE" }),
		bulkPrice: (items: Array<{ id: string; price: number; effectiveDate?: string }>) =>
			request<{ updated: number }>("/api/holdings/bulk-price", json({ items })),
	},

	quotes: {
		status: () => request<QuoteStatusDto>("/api/quotes/status"),
		refresh: () => request<{ report: RefreshReportDto }>("/api/quotes/refresh", { method: "POST" }),
		test: (body: { provider: ProviderId | string; symbol: string; kind: string; currency: string; market?: string | null }) =>
			request<{ ok: boolean; quotes: unknown[]; errors: string[] }>("/api/quotes/test", json(body)),
	},

	snapshots: {
		list: (limit = 60) => request<{ items: SnapshotItemDto[] }>(`/api/portfolio/snapshots?limit=${limit}`),
		take: (date?: string) => request<{ date: string; total: number; currency: string }>(
			"/api/portfolio/snapshots",
			json(date ? { date } : {}),
		),
		remove: (date: string) => request<{ deleted: boolean }>(`/api/portfolio/snapshots/${date}`, { method: "DELETE" }),
	},

	portfolio: (
		filter: { currency?: string; class?: string; market?: string; accountId?: string; currencyFilter?: string } = {},
	) => {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(filter)) {
			if (value === undefined || value === "") continue;
			query.set(key, String(value));
		}
		const suffix = query.toString() ? `?${query}` : "";
		return request<Portfolio>(`/api/portfolio${suffix}`);
	},

	trend: (query: { range?: string; currency?: string; class?: string; accountId?: string; market?: string } = {}) => {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
		const suffix = search.toString() ? `?${search}` : "";
		return request<TrendSeriesDto>(`/api/portfolio/history${suffix}`);
	},

	settings: {
		get: () => request<SettingsDto>("/api/settings"),
		update: (body: Record<string, unknown>) => request<{ values: Record<string, string> }>("/api/settings", put(body)),
		fx: () => request<{ items: FxRateDto[]; history: Array<Record<string, unknown>> }>("/api/settings/fx"),
		putFx: (body: { base: string; quote: string; rate: number }) =>
			request<{ items: FxRateDto[] }>("/api/settings/fx", put(body)),
		deleteFx: (base: string, quote: string) =>
			request<{ deleted: boolean }>(`/api/settings/fx?base=${base}&quote=${quote}`, { method: "DELETE" }),
		overview: () => request<OverviewDto>("/api/settings/overview"),
	},

	history: (query: { entity?: string; action?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) => {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") search.set(key, String(value));
		const suffix = search.toString() ? `?${search}` : "";
		return request<{ items: AuditItemDto[]; total: number; page: number; pageSize: number }>(`/api/history${suffix}`);
	},

	backup: {
		/** 导出返回原始文本，便于在浏览器端选择是否加密（FR-8.3） */
		exportText: async (includeAudit = true): Promise<string> => {
			const response = await fetch(`/api/backup/export${includeAudit ? "" : "?includeAudit=false"}`, {
				credentials: "same-origin",
			});
			if (!response.ok) {
				let message = `导出失败（HTTP ${response.status}）`;
				try {
					const payload = (await response.json()) as { error?: { message?: string } };
					if (payload.error?.message) message = payload.error.message;
				} catch {
					/* 忽略 */
				}
				throw new ApiError(response.status, "export_failed", message);
			}
			return response.text();
		},
		import: (payload: unknown, mode: "merge" | "replace", dryRun: boolean) =>
			request<ImportResult>(`/api/backup/import?mode=${mode}&dryRun=${dryRun ? "true" : "false"}`, json(payload)),
	},
};

export type {
	AccountDto,
	AssetClass,
	AuditItemDto,
	AuthMeDto,
	EntityDiff,
	FxRateDto,
	HoldingDto,
	HoldingListDto,
	ImportPreview,
	ImportResult,
	Portfolio,
	ProviderId,
	QuoteStatusDto,
	RefreshReportDto,
	SettingsDto,
	SnapshotItemDto,
	TrendPoint,
	TrendSeriesDto,
} from "../../shared/api-types";
