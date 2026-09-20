import type { Context } from "hono";
import { createTranslator, resolveLanguage, type ResolvedLanguage, type Translator } from "../../shared/i18n";
// Worker 静态引入全部语言：体积无所谓（几十 KB），换来零异步
import en from "../../shared/locales/en";
import zh from "../../shared/locales/zh";
import type { AppEnv } from "../types";

const DICTS: Record<ResolvedLanguage, typeof zh> = { zh, en };

/**
 * 服务端语言判定：直接看 Accept-Language（浏览器自动带上，用户无需配置）。
 * 这样校验错误、导入警告、行情失败原因都能跟着界面语言走。
 */
export function detectLang(acceptLanguage: string | null | undefined): ResolvedLanguage {
	return resolveLanguage("auto", acceptLanguage ?? null);
}

export function translator(lang: ResolvedLanguage | string | undefined): Translator {
	return createTranslator(lang === "en" ? "en" : "zh", DICTS);
}

/** 在路由里取当前请求的翻译函数 */
export function tOf(c: Context<AppEnv>): Translator {
	return translator(c.get("lang"));
}
