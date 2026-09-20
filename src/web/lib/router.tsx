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
	path: string;
	navigate: (to: string, replace?: boolean) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** 极简路由：只用手写 pushState，不引 react-router（保持依赖与体积最小） */
export function RouterProvider({ children }: { children: ReactNode }) {
	const [path, setPath] = useState(() => window.location.pathname);

	useEffect(() => {
		const onPopState = () => setPath(window.location.pathname);
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	const navigate = useCallback((to: string, replace = false) => {
		if (to === window.location.pathname) return;
		if (replace) window.history.replaceState({}, "", to);
		else window.history.pushState({}, "", to);
		setPath(to);
		window.scrollTo({ top: 0 });
	}, []);

	const value = useMemo(() => ({ path, navigate }), [path, navigate]);
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
