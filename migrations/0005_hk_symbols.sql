-- 0005_hk_symbols.sql — 港股代码统一为港交所的 5 位写法
--
-- 港交所公布的代码一律是 5 位（含前导零）：00700 腾讯、03121 南方KOSPI、09988 阿里巴巴。
-- 券商对账单、港股通、腾讯行情也都是 5 位；4 位（700 / 3121）是 Yahoo 的内部格式，
-- 现在只在请求 Yahoo 时临时转换，库里统一存 5 位。
--
-- 影响面：
--   * holdings.symbol 里 market = 'hk' 且去掉 .HK 后缀后是纯数字的行
--     （3121 → 03121、700 → 00700、00700.HK → 00700）
--   * 8 开头的人民币柜台（如 80737）本来就是 5 位，printf 不会再补零，保持原样
--   * 非数字代码（例如用户自己写的覆盖值）一律不动
--
-- 注意：price_history / quote_cache 都按 holding_id 关联，不受影响；
-- 操作历史（audit）里留存的是当时的值，属于历史记录，不改。

UPDATE holdings
SET symbol = printf('%05d', CAST(replace(upper(symbol), '.HK', '') AS INTEGER))
WHERE market = 'hk'
  AND symbol IS NOT NULL
  AND replace(upper(symbol), '.HK', '') <> ''
  AND replace(upper(symbol), '.HK', '') NOT GLOB '*[^0-9]*';

INSERT INTO settings (key, value) VALUES ('schema_version', '5') ON CONFLICT (key) DO UPDATE SET value = '5';
