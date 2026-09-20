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
	createTranslator,
	LANGUAGES,
	resolveLanguage,
	type Dict,
	type LanguageSetting,
	type ResolvedLanguage,
	type Translator,
} from "../../shared/i18n";
import { DEFAULT_TIMEZONE, normalizeTimeZone } from "../../shared/time";
// 默认语言静态引入（纯数据、首屏无异步）；其它语言按需动态 import，避免双语字典都进首包
import zh from "../../shared/locales/zh";

const STORAGE_KEY = "am_language";

type Dicts = Partial<Record<ResolvedLanguage, Dict>>;

const dicts: Dicts = { zh };

const loaders: Record<ResolvedLanguage, () => Promise<Dict>> = {
	zh: () => Promise.resolve(zh),
	en: () => import("../../shared/locales/en").then((module) => module.default),
};

async function ensureDict(lang: ResolvedLanguage): Promise<void> {
	if (dicts[lang]) return;
	dicts[lang] = await loaders[lang]();
}

interface I18nValue {
	/** 用户设置：auto / zh / en */
	setting: LanguageSetting;
	/** 实际生效的语言 */
	lang: ResolvedLanguage;
	t: Translator;
	/** 字典是否已就绪（切到英文时会有极短的空档） */
	ready: boolean;
	/** 时区（IANA 名称）：影响时间展示与"哪一天"的换算 */
	timeZone: string;
	/** 只改前端（用于初始化时同步服务端偏好） */
	applySetting: (value: LanguageSetting) => void;
	applyTimeZone: (value: string) => void;
	/** 用户主动切换（同时写 localStorage） */
	setSetting: (value: LanguageSetting) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function browserLanguage(): string {
	return typeof navigator !== "undefined" ? (navigator.language ?? "zh") : "zh";
}

const readStored = (): LanguageSetting => {
	if (typeof localStorage === "undefined") return "auto";
	const value = localStorage.getItem(STORAGE_KEY);
	return (LANGUAGES as readonly string[]).includes(value ?? "") ? (value as LanguageSetting) : "auto";
};

export function I18nProvider({ children }: { children: ReactNode }) {
	const [setting, setSettingState] = useState<LanguageSetting>(readStored);
	const [timeZone, setTimeZoneState] = useState<string>(DEFAULT_TIMEZONE);
	const [ready, setReady] = useState(() => Boolean(dicts[resolveLanguage(readStored(), browserLanguage())]));

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
		return resolveLanguage(setting, browserLanguage());
	}, [setting, tick]);

	// 目标语言的字典没加载时按需拉取，加载完再重新渲染
	useEffect(() => {
		if (dicts[lang]) {
			setReady(true);
			return;
		}
		let alive = true;
		void ensureDict(lang).then(() => {
			if (alive) setReady(true);
		});
		return () => {
			alive = false;
		};
	}, [lang]);

	// ready 参与依赖：字典加载完成后重建翻译函数
	const t = useMemo(() => createTranslator(lang, dicts), [lang, ready]);

	const applySetting = useCallback((value: LanguageSetting) => {
		setSettingState((current) => (current === value ? current : value));
	}, []);

	const applyTimeZone = useCallback((value: string) => {
		setTimeZoneState((current) => (current === value ? current : normalizeTimeZone(value)));
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
		() => ({ setting, lang, t, ready, timeZone, applySetting, applyTimeZone, setSetting }),
		[setting, lang, t, ready, timeZone, applySetting, applyTimeZone, setSetting],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n 必须在 I18nProvider 内使用");
	return value;
}

/** 页面里最常用的入口：可当函数调用，也带上下文 */
export function useT(): Translator & {
	lang: ResolvedLanguage;
	setting: LanguageSetting;
	setSetting: (v: LanguageSetting) => void;
	ready: boolean;
} {
	const { t, lang, setting, setSetting, ready } = useI18n();
	const bound = useCallback<Translator>((key, params) => t(key, params), [t]);
	return Object.assign(bound, { lang, setting, setSetting, ready });
}

export function useLanguage(): { lang: ResolvedLanguage; setting: LanguageSetting; setSetting: (v: LanguageSetting) => void } {
	const { lang, setting, setSetting } = useI18n();
	return { lang, setting, setSetting };
}

/** 当前配置的时区（时间展示与日期换算都用它） */
export function useTimeZone(): string {
	return useI18n().timeZone;
}
