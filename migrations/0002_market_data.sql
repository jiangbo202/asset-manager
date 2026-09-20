-- 0002_market_data.sql — v0.10：外部行情 + 每日快照
--
-- 放到新迁移文件里（不改 0001）：D1 靠文件名顺序记录已应用的迁移，
-- 已经上线过的环境只能追加新文件。

-- 每条持仓可以覆盖"用哪个数据源 / 用什么代码去查"
-- 例：quote_source='coingecko' + quote_symbol='bitcoin'（因为 CoinGecko 要的是 coin id 而不是 BTC）
ALTER TABLE holdings ADD COLUMN quote_source TEXT;
ALTER TABLE holdings ADD COLUMN quote_symbol TEXT;

-- 汇率区分"手工维护"与"自动抓取"：手工的永远不会被自动抓取覆盖
ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- 每日快照（一天一行，明细放 JSON：避免 50 持仓 × 365 天 = 1.8 万行的读放大）
CREATE TABLE IF NOT EXISTS snapshots (
  date             TEXT PRIMARY KEY,
  base_currency    TEXT NOT NULL,
  total            REAL NOT NULL,
  -- 按**原币种**存小计，这样切换显示币种 / 修改汇率时仍能重算历史曲线
  by_currency_json TEXT NOT NULL,
  by_class_json    TEXT NOT NULL,
  by_account_json  TEXT NOT NULL,
  detail_json      TEXT,
  created_at       TEXT NOT NULL
);

-- 行情缓存：记录每个"数据源+代码"最近一次拿到的价格，便于排查与跨日比较
CREATE TABLE IF NOT EXISTS quote_cache (
  key        TEXT PRIMARY KEY, -- <source>:<symbol>:<currency>
  source     TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  currency   TEXT NOT NULL,
  price      REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_cache_fetched ON quote_cache (fetched_at DESC);

-- 行情刷新日志（最近 N 次，用于设置页展示"上次更新发生了什么"）
CREATE TABLE IF NOT EXISTS quote_runs (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  trigger        TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  updated        INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  requests       INTEGER NOT NULL DEFAULT 0,
  report_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_runs_started ON quote_runs (started_at DESC);

-- 默认设置
INSERT INTO settings (key, value) VALUES ('market_data_enabled', '1') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('snapshot_hour_utc', '22') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('provider_config', '{}') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('schema_version', '2') ON CONFLICT (key) DO UPDATE SET value = '2';
