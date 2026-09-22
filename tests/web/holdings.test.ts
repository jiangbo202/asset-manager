import { describe, expect, it } from "vitest";
import { isCodeLikeName, shouldFillNameFromLookup, symbolsEqual } from "../../src/web/lib/holdings";

/**
 * 代码查询后「名称」该不该被覆盖
 *
 * 这里的第一组就是用户报的那个 bug：编辑持仓 → 改代码 → 点「查名称」→
 * 界面说"已匹配 Tesla, Inc."，名称框里却还留着上一支标的的名字。
 */
describe("查询后是否写入名称", () => {
	const base = {
		currentName: "",
		typedSymbol: "",
		nameOwner: "",
		touched: false,
		matchedName: "Tesla, Inc.",
		matchedSymbol: "TSLA",
	};

	it("报的那个 bug：编辑时改了代码，名称还是旧标的的名字（未手改）→ 应当替换", () => {
		expect(
			shouldFillNameFromLookup({
				...base,
				currentName: "Solid Power, Inc.",
				typedSymbol: "TSLA",
				nameOwner: "SLDP", // 表单是从这条持仓打开的
			}),
		).toBe(true);
	});

	it("用户手改过名称 + 又换了代码 → 保留他写的名字", () => {
		expect(
			shouldFillNameFromLookup({
				...base,
				currentName: "我的特斯拉",
				typedSymbol: "TSLA",
				nameOwner: "SLDP",
				touched: true,
			}),
		).toBe(false);
	});

	it("用户手改过名称 + 代码没变 → 也不覆盖", () => {
		expect(
			shouldFillNameFromLookup({
				...base,
				currentName: "苹果（长期持有）",
				typedSymbol: "AAPL",
				nameOwner: "AAPL",
				touched: true,
			}),
		).toBe(false);
	});

	it("名称为空（新增持仓）→ 填", () => {
		expect(shouldFillNameFromLookup({ ...base, typedSymbol: "AAPL" })).toBe(true);
	});

	it("名称只是代码占位 → 任何时候都用正式名称纠正", () => {
		// 港股三种写法都要认：库里统一 5 位、Yahoo 是 4 位、用户可能带 .HK
		for (const currentName of ["03121", "3121.HK", "3121", "3121.hk"]) {
			expect(
				shouldFillNameFromLookup({
					...base,
					currentName,
					typedSymbol: "03121",
					nameOwner: "03121",
					matchedName: "中手游",
					matchedSymbol: "03121.HK",
				}),
				currentName,
			).toBe(true);
		}
	});

	it("查询结果自己就是代码替身（数据源没给正式名）→ 不填", () => {
		expect(
			shouldFillNameFromLookup({ ...base, typedSymbol: "TSLA", matchedName: "TSLA", matchedSymbol: "TSLA" }),
		).toBe(false);
		expect(shouldFillNameFromLookup({ ...base, typedSymbol: "TSLA", matchedName: null })).toBe(false);
	});

	it("代码没变、名称是原有的（未手改）→ 保持原样，不动", () => {
		expect(
			shouldFillNameFromLookup({
				...base,
				currentName: "Apple Inc.",
				typedSymbol: "AAPL",
				nameOwner: "AAPL",
				matchedName: "Apple Inc. Common Stock",
			}),
		).toBe(false);
	});

	it("代码大小写或空格不同不算换代码（不误判为陈旧）", () => {
		expect(
			shouldFillNameFromLookup({
				...base,
				currentName: "Apple Inc.",
				typedSymbol: " aapl ",
				nameOwner: "AAPL",
				matchedName: "Apple Inc. Common Stock",
			}),
		).toBe(false);
	});
});

describe("名称是否只是代码替身", () => {
	it("匹配原样与去掉交易所后缀的形式", () => {
		expect(isCodeLikeName("03121", ["03121"])).toBe(true);
		expect(isCodeLikeName("3121.HK", ["3121"])).toBe(true);
		expect(isCodeLikeName("3121", ["3121.HK"])).toBe(true);
		expect(isCodeLikeName("tsla", ["TSLA"])).toBe(true);
		expect(isCodeLikeName("3121", ["03121"])).toBe(true);
		expect(isCodeLikeName("Tesla, Inc.", ["TSLA"])).toBe(false);
		expect(isCodeLikeName("", ["TSLA"])).toBe(false);
		expect(isCodeLikeName("03121", [null, undefined, ""])).toBe(false);
	});
});

describe("两个代码是否指同一支标的", () => {
	it("忽略大小写、空格、交易所后缀与港股前导零", () => {
		expect(symbolsEqual("AAPL", " aapl ")).toBe(true);
		expect(symbolsEqual("03121", "3121.HK")).toBe(true);
		expect(symbolsEqual("3121", "03121")).toBe(true);
		expect(symbolsEqual("600519", "600519.SS")).toBe(true);
		expect(symbolsEqual("AAPL", "TSLA")).toBe(false);
		// 两个空值不算"相等"：不知道代码时不该判定成"没换代码"
		expect(symbolsEqual("", "")).toBe(false);
		expect(symbolsEqual(null, undefined)).toBe(false);
	});
});
