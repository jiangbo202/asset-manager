import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface AsyncState<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	/** 服务端返回的错误码（如 migration_required），用于给出针对性的引导 */
	errorCode: string | null;
	reload: () => void;
	setData: (value: T | null) => void;
}

/** 极简数据请求 hook（不引 react-query） */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	useEffect(() => {
		let alive = true;
		setLoading(true);
		loaderRef
			.current()
			.then((result) => {
				if (!alive) return;
				setData(result);
				setError(null);
				setErrorCode(null);
			})
			.catch((err: unknown) => {
				if (!alive) return;
				setError(err instanceof ApiError ? err.message : "加载失败");
				setErrorCode(err instanceof ApiError ? err.code : null);
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, tick]);

	const reload = useCallback(() => setTick((value) => value + 1), []);
	return { data, loading, error, errorCode, reload, setData };
}

/** 表单提交状态 */
export function useSubmit() {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = useCallback(async (action: () => Promise<void>) => {
		setPending(true);
		setError(null);
		try {
			await action();
			return true;
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "操作失败");
			return false;
		} finally {
			setPending(false);
		}
	}, []);

	return { pending, error, setError, run };
}
