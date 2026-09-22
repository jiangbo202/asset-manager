import { describe, expect, it } from "vitest";
import {
	DEFAULT_PUBLIC_SECTIONS,
	parsePublicSections,
	serializePublicSections,
} from "../../src/shared/public-sections";

/**
 * 分区解析（纯函数）
 *
 * 存库的是逗号分隔字符串，读出来要能扛住脏数据：
 * 认不出的值一律丢弃，全丢弃就等于"没有可分享的区域"（不放行任何分区接口），
 * 而不是回退成"全部分享" —— 那是反向放宽。
 */
describe("公开分享区域的解析", () => {
	it("没存过 → 默认全部", () => {
		expect(parsePublicSections(null)).toEqual([...DEFAULT_PUBLIC_SECTIONS]);
		expect(parsePublicSections(undefined)).toEqual([...DEFAULT_PUBLIC_SECTIONS]);
	});

	it("正常解析，并去重、按固定顺序（比较与展示都稳定）", () => {
		expect(parsePublicSections("holdings,summary")).toEqual(["summary", "holdings"]);
		expect(parsePublicSections("summary,summary,trend")).toEqual(["summary", "trend"]);
	});

	it("未知值与空白一律丢弃", () => {
		expect(parsePublicSections("summary, nope ,")).toEqual(["summary"]);
		expect(parsePublicSections(",,,, ")).toEqual([]);
		expect(parsePublicSections("bogus")).toEqual([]);
	});

	it("序列化后能原样解析回来", () => {
		expect(serializePublicSections(["trend", "summary"])).toBe("summary,trend");
		expect(parsePublicSections(serializePublicSections(["holdings"]))).toEqual(["holdings"]);
	});
});
