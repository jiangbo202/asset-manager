-- 0003_v011.sql — v0.11：汇率按日冻结、代码查询缓存、数据源健康度
--
-- 1) 汇率按日冻结：修掉 PRD D9 的"改汇率会让历史曲线整体平移"
--    每次拍快照时把当天的汇率一并落库，画历史时用"那一天的汇率"。
-- 2) 代码查询缓存：输入代码后查名称/价格会打第三方搜索接口，缓存 24 小时避免反复打。
-- 3) 数据源健康度：记录连续失败与限流冷却时间，冷却期内跳过该源。

CREATE TABLE IF NOT EXISTS fx_daily (
  date       TEXT NOT NULL,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  PRIMARY KEY (date, base, quote)
);
CREATE INDEX IF NOT EXISTS idx_fx_daily_date ON fx_daily (date);

CREATE TABLE IF NOT EXISTS lookup_cache (
  key          TEXT PRIMARY KEY,
  symbol       TEXT NOT NULL,
  market       TEXT,
  payload_json TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_cache_fetched ON lookup_cache (fetched_at DESC);

INSERT INTO settings (key, value) VALUES ('provider_health', '{}') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('schema_version', '3') ON CONFLICT (key) DO UPDATE SET value = '3';
