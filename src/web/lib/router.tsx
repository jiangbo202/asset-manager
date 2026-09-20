import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";

interface RouterValue {
	/** URL path（不含 query） */
	path: string;
	/** URL query，用于把筛选条件同步到地址栏（FR-6.2：刷新/分享都能还原） */
	query: URLSearchParams;
	navigate: (to: string, options?: { replace?: boolean }) => void;
	/** 增删 query 参数；默认 replace，避免把浏览器历史撑爆 */
	setQuery: (patch: Record<string, string | null | undefined>, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

const currentUrl = () => `${window.location.pathname}${window.location.search}`;

/** 极简路由：手写 pushState + query 同步，不引 react-router（保持依赖与体积最小） */
export function RouterProvider({ children }: { children: ReactNode }) {
	const [url, setUrl] = useState(currentUrl);

	useEffect(() => {
		const onPopState = () => setUrl(currentUrl());
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
		const next = to.startsWith("/") ? to : `/${to}`;
		if (next === currentUrl()) return;
		if (options.replace) window.history.replaceState({}, "", next);
		else window.history.pushState({}, "", next);
		setUrl(next);
		window.scrollTo({ top: 0 });
	}, []);

	const setQuery = useCallback(
		(patch: Record<string, string | null | undefined>, options: { replace?: boolean } = {}) => {
			const params = new URLSearchParams(window.location.search);
			for (const [key, value] of Object.entries(patch)) {
				if (value === null || value === undefined || value === "") params.delete(key);
				else params.set(key, value);
			}
			const search = params.toString();
			const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
			// 筛选变化用 replace：不产生一堆历史记录，但刷新/分享仍然可还原
			if (options.replace === false) window.history.pushState({}, "", next);
			else window.history.replaceState({}, "", next);
			setUrl(next);
		},
		[],
	);

	const value = useMemo<RouterValue>(() => {
		const [path, search = ""] = url.split("?");
		return { path: path || "/", query: new URLSearchParams(search), navigate, setQuery };
	}, [url, navigate, setQuery]);

	return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
	const value = useContext(RouterContext);
	if (!value) throw new Error("useRouter 必须在 RouterProvider 内使用");
	return value;
}

export function Link({
	to,
	children,
	className,
}: {
	to: string;
	children: ReactNode;
	className?: string;
}) {
	const { navigate } = useRouter();
	return (
		<a
			href={to}
			className={className}
			onClick={(event) => {
				event.preventDefault();
				navigate(to);
			}}
		>
			{children}
		</a>
	);
}
