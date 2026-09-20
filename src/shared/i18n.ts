/**
 * 国际化字典（中文 / English）
 *
 * 设计要点：
 *  - 纯数据、零依赖，前后端共用（Worker 也用同一份，避免两边文案不一致）
 *  - 语言设置存在 settings.language，取值为 auto / zh / en；auto 时跟随浏览器
 *  - 服务端通过 Accept-Language 判断语言（浏览器会自动带上，无需额外配置）
 *  - 插值语法：{{name}}
 */

export const LANGUAGES = ["auto", "zh", "en"] as const;
export type LanguageSetting = (typeof LANGUAGES)[number];

export type ResolvedLanguage = "zh" | "en";

/** 语言显示名（在语言选择器里永远用双语标注，避免用户切到看不懂的语言后找不到入口） */
export const LANGUAGE_LABELS: Record<LanguageSetting, string> = {
	auto: "跟随浏览器 / Auto",
	zh: "简体中文",
	en: "English",
};

/**
 * 解析最终语言。
 *  - 显式设置（zh/en）优先
 *  - auto：看传入的浏览器语言（前端传 navigator.language，服务端传 Accept-Language）
 *  - 都没有时回退到中文（本项目的默认语言）
 */
export function resolveLanguage(setting: string | null | undefined, browserLanguage?: string | null): ResolvedLanguage {
	const value = (setting ?? "auto").toLowerCase();
	if (value === "zh" || value === "en") return value;
	const browser = (browserLanguage ?? "").toLowerCase();
	if (browser === "") return "zh";
	return browser.includes("zh") ? "zh" : "en";
}

export type Dict = Record<string, string>;

/** 把 {{name}} 占位替换成实际值 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
	if (!params) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		const value = params[key];
		return value === undefined || value === null ? match : String(value);
	});
}

/**
 * 用「语言 → 字典」映射创建翻译函数。
 *
 * 字典是注入的（不在本文件 import），这样：
 *  - Worker 静态引入全部语言（体积无所谓）
 *  - 浏览器只静态引入默认语言，其它语言用动态 import，避免把双语字典都塞进首包
 *
 * 找不到 key 时按 当前语言 → 中文 → key 顺序回退，漏翻不会显示空白。
 */
export function createTranslator(
	lang: ResolvedLanguage,
	dicts: Partial<Record<ResolvedLanguage, Dict>>,
): Translator {
	return (key, params) => {
		const template = dicts[lang]?.[key] ?? dicts.zh?.[key];
		if (template === undefined) return key;
		return interpolate(template, params);
	};
}

export type Translator = (key: string, params?: Record<string, unknown>) => string;

/** 所有 key（用于测试两种语言是否对齐） */
export function allKeys(...dicts: Dict[]): Array<{ key: string; present: boolean[] }> {
	const keys = new Set<string>();
	for (const dict of dicts) for (const key of Object.keys(dict)) keys.add(key);
	return [...keys]
		.sort()
		.map((key) => ({ key, present: dicts.map((dict) => key in dict) }));
}
