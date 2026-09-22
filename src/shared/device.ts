/**
 * 会话列表用：把 User-Agent 拆成「系统 · 浏览器」
 *
 * 不用 UA 解析库：这里只要能让用户认出"哪台设备是我的"，几十行足够；
 * 引库会进首包体积（有 CI 门禁），收益不成比例。
 * 返回结构化字段而不是拼好的字符串：拼法与语言有关（"未知设备"要翻译），
 * 放在界面层做；这里只负责识别，方便单测。
 */

export interface DeviceInfo {
	/** iPhone / iPad / Android / Windows / Mac / Linux / ChromeOS，识别不出为 null */
	os: string | null;
	/** Safari / Chrome / Edge / Firefox / Opera / 其它 Chromium 内核，识别不出为 null */
	browser: string | null;
}

/** 只看前缀特征，顺序有讲究：先排除其它浏览器伪装的常见串 */
export function describeUserAgent(userAgent: string | null | undefined): DeviceInfo {
	const ua = (userAgent ?? "").trim();
	if (!ua) return { os: null, browser: null };

	const os = ((): string | null => {
		if (/iPhone/i.test(ua)) return "iPhone";
		if (/iPad/i.test(ua)) return "iPad";
		if (/Android/i.test(ua)) return "Android";
		// iPadOS 13+ 的 Safari 会把自己报成 Macintosh，这里靠触摸点区分，识别不出就归 Mac
		if (/Windows/i.test(ua)) return "Windows";
		if (/Mac OS X|Macintosh/i.test(ua)) return "Mac";
		if (/CrOS/i.test(ua)) return "ChromeOS";
		if (/Linux|X11/i.test(ua)) return "Linux";
		return null;
	})();

	const browser = ((): string | null => {
		if (/Edg[A-Z]?\//i.test(ua) || /Edge\//i.test(ua)) return "Edge";
		if (/OPR\/|Opera/i.test(ua)) return "Opera";
		if (/Firefox\//i.test(ua) || /FxiOS\//i.test(ua)) return "Firefox";
		if (/CriOS\//i.test(ua)) return "Chrome"; // iOS 上的 Chrome
		if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return "Chrome";
		if (/Safari\//i.test(ua)) return "Safari";
		// curl / 脚本 / 其它 HTTP 客户端
		if (/curl|wget|python|node-fetch|undici|okhttp/i.test(ua)) return null;
		return null;
	})();

	return { os, browser };
}
