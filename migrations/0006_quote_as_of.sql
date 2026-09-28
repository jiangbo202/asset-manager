-- 报价时间（asOf）：上游自带的"这个价格是什么时候的"
--
-- 动机：`price_updated_at` 记的是"我们什么时候抓的"，不是"这个价格是什么时候的"。
-- 周末点一次刷新，界面上写着"今天"（抓取时间），而价格其实是上周五的收盘价 ——
-- 两件事被混成一个字段，用户没法判断眼前这个数该不该信。
--
-- asOf 只在上游明确给出时间时才有值：
--   Yahoo    meta.regularMarketTime（epoch 秒）
--   腾讯      fields[30]（"YYYY/MM/DD HH:mm:ss"，港股与 A 股均为 UTC+8）
--   ECB      date（只有日期，存 YYYY-MM-DD）
--   er-api   time_last_update_unix（epoch 秒）
--   加密/自定义源  上游不给时间 —— 留空，由刷新流程按"抓取时刻"兜底
--
-- 注意：停更告警与价格新鲜度仍然按 price_updated_at（抓取新鲜度）判断，不用 asOf。
-- 否则每逢周末、假期，全部股票都会被告警 —— 那是噪音，不是信息。
-- asOf 是给人看的标注（PRD FR-10.11），不是告警的判据。

ALTER TABLE holdings ADD COLUMN price_as_of TEXT;
ALTER TABLE quote_cache ADD COLUMN as_of TEXT;
ALTER TABLE fx_rates ADD COLUMN as_of TEXT;
