import type { Context } from "hono";
import { makeTranslator, resolveLanguage, type ResolvedLanguage, type Translator } from "../../shared/i18n";
import type { AppEnv } from "../types";

/**
 * 服务端语言判定：直接看 Accept-Language（浏览器自动带上，用户无需配置）。
 * 这样校验错误、导入警告、行情失败原因都能跟着界面语言走。
 */
export function detectLang(acceptLanguage: string | null | undefined): ResolvedLanguage {
	return resolveLanguage("auto", acceptLanguage ?? null);
}

export function translator(lang: ResolvedLanguage | string | undefined): Translator {
	return makeTranslator(lang === "en" ? "en" : "zh");
}

/** 在路由里取当前请求的翻译函数 */
export function tOf(c: Context<AppEnv>): Translator {
	return translator(c.get("lang"));
}
