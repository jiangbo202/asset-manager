-- 0004_timezone.sql — v0.13：可配置时区（默认 UTC）
--
-- 影响面：
--   * 每日快照的"哪一天"与触发小时，按该时区计算
--   * 价格/数量历史的生效日期（手动录入时的默认值）
--   * 操作历史日期区间筛选的边界
--   * 界面上的时间展示
-- 存储始终是 UTC ISO 字符串，这里只影响"日历"的解释方式。

INSERT INTO settings (key, value) VALUES ('timezone', 'UTC') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('schema_version', '4') ON CONFLICT (key) DO UPDATE SET value = '4';
