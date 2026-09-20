import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import {
	LANGUAGES,
	makeTranslator,
	resolveLanguage,
	type LanguageSetting,
	type ResolvedLanguage,
	type Translator,
} from "../../shared/i18n";

const STORAGE_KEY = "am_language";

interface I18nValue {
	/** 用户设置：auto / zh / en */
	setting: LanguageSetting;
	/** 实际生效的语言 */
	lang: ResolvedLanguage;
	t: Translator;
	/** 只改前端（用于初始化时同步服务端偏好） */
	applySetting: (value: LanguageSetting) => void;
	/** 用户主动切换（同时写 localStorage） */
	setSetting: (value: LanguageSetting) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

const readStored = (): LanguageSetting => {
	if (typeof localStorage === "undefined") return "auto";
	const value = localStorage.getItem(STORAGE_KEY);
	return (LANGUAGES as readonly string[]).includes(value ?? "") ? (value as LanguageSetting) : "auto";
};

export function I18nProvider({ children }: { children: ReactNode }) {
	const [setting, setSettingState] = useState<LanguageSetting>(readStored);

	// 浏览器语言变化时（auto 模式）跟着变
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (setting !== "auto" || typeof window === "undefined") return;
		const onChange = () => setTick((value) => value + 1);
		window.addEventListener("languagechange", onChange);
		return () => window.removeEventListener("languagechange", onChange);
	}, [setting]);

	const lang = useMemo<ResolvedLanguage>(() => {
		void tick;
		return resolveLanguage(setting, typeof navigator !== "undefined" ? navigator.language : "zh");
	}, [setting, tick]);

	const t = useMemo(() => makeTranslator(lang), [lang]);

	const applySetting = useCallback((value: LanguageSetting) => {
		setSettingState((current) => (current === value ? current : value));
	}, []);

	const setSetting = useCallback((value: LanguageSetting) => {
		setSettingState(value);
		try {
			localStorage.setItem(STORAGE_KEY, value);
		} catch {
			// 隐私模式下 localStorage 可能不可用，忽略即可
		}
	}, []);

	const value = useMemo<I18nValue>(
		() => ({ setting, lang, t, applySetting, setSetting }),
		[setting, lang, t, applySetting, setSetting],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n 必须在 I18nProvider 内使用");
	return value;
}

/** 页面里最常用的入口 */
export function useT(): Translator & { lang: ResolvedLanguage; setting: LanguageSetting; setSetting: (v: LanguageSetting) => void } {
	const { t, lang, setting, setSetting } = useI18n();
	// 让 t 同时可当函数调用，又能带上下文（避免每个页面都写两次 hook）
	const bound = useCallback<Translator>((key, params) => t(key, params), [t]);
	return Object.assign(bound, { lang, setting, setSetting });
}

export function useLanguage(): { lang: ResolvedLanguage; setting: LanguageSetting; setSetting: (v: LanguageSetting) => void } {
	const { lang, setting, setSetting } = useI18n();
	return { lang, setting, setSetting };
}
