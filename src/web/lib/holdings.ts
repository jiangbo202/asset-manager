/**
 * 持仓表单：代码查询后「名称」该不该被覆盖
 *
 * 这段判断踩过两次坑，所以抽成纯函数并由单测钉住：
 *
 * 1. 一开始无条件覆盖 → 用户把持仓改名成「特斯拉（长期）」后，随便点一下查询就被改回
 *    「Tesla, Inc.」，自定义的名字丢了
 * 2. 于是改成「只填空名称，或名称只是代码时」→ 编辑持仓时改了代码，名称框里还留着
 *    **上一支标的的名字**（既非空、也非代码），于是查询成功后名称纹丝不动：
 *    用户看到"已匹配 Tesla, Inc."却仍然写着 Solid Power, Inc.
 *
 * 正确的规则要看**名称属于哪个代码**：
 *   - 名称还属于旧代码（用户没手动改过）→ 换代码后它就是陈旧的，应当替换
 *   - 用户手动敲过名称 → 那是他的意图，不覆盖（界面会提示"名称保留了你填的值"）
 *   - 名称本身只是代码（占位）→ 任何时候都该被正式名称纠正
 */

import { normalizeHkSymbol } from "../../shared/labels";

export interface NameFillInput {
	/** 表单里当前的名称 */
	currentName: string;
	/** 表单里当前的代码（用户刚输入的） */
	typedSymbol: string;
	/** 当前名称"属于"哪个代码：加载编辑表单时的代码，或上次自动填入时的代码 */
	nameOwner: string;
	/** 用户是否手动编辑过名称框 */
	touched: boolean;
	/** 查询到的正式名称 */
	matchedName: string | null | undefined;
	/** 查询到的代码（可能与输入的不同，例如补全了后缀） */
	matchedSymbol?: string | null;
}

/**
 * 归一化：去掉交易所后缀（.HK/.SS/.SZ）并统一港股写法
 *
 * 用 shared/labels 的 normalizeHkSymbol 而不是自己补零：库里港股统一 5 位，
 * 而用户/数据源可能写成 3121.HK 或 3121 —— 这三种写法都该被认成同一个代码。
 */
const normalizeSymbol = (value: string | null | undefined): string => {
	const bare = (value ?? "").trim().replace(/\.[A-Z]+$/i, "");
	return normalizeHkSymbol(bare).toUpperCase();
};

/** 两个代码是否指同一支标的（忽略大小写、空格、交易所后缀与港股前导零） */
export function symbolsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
	const left = normalizeSymbol(a);
	return left !== "" && left === normalizeSymbol(b);
}

/** 名称是否只是"代码的替身"（没有正式名称时的占位值） */
export function isCodeLikeName(value: string, symbols: Array<string | null | undefined>): boolean {
	const normalizedValue = normalizeSymbol(value);
	if (normalizedValue === "") return false;
	return symbols.some((symbol) => {
		const candidate = normalizeSymbol(symbol);
		return candidate !== "" && candidate === normalizedValue;
	});
}

export function shouldFillNameFromLookup(input: NameFillInput): boolean {
	const { currentName, typedSymbol, nameOwner, touched, matchedName, matchedSymbol } = input;
	if (!matchedName) return false;

	// 查询结果自己就是代码替身（数据源没给出正式名称）→ 不填，免得把代码当名字
	if (isCodeLikeName(matchedName, [typedSymbol, matchedSymbol])) return false;

	// 名称为空 → 填
	if (currentName.trim() === "") return true;

	// 名称只是代码占位 → 用正式名称纠正
	if (isCodeLikeName(currentName, [typedSymbol, matchedSymbol, nameOwner])) return true;

	// 代码换了、且名称不是用户手动写的 → 那是上一支标的的名字，替换
	return !symbolsEqual(nameOwner, typedSymbol) && !touched;
}
