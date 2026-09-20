-- 0001_init.sql — 初始 schema
-- 设计说明见 docs/PRD.md §5：
--   * 持仓为「手动编辑数量/价格/平均成本」，不做交易流水推导
--   * price_history / qty_history 在 v1 只写不读，为 v2 走势图预埋数据
--   * 快照表与时间序列在 v1 不做（见 PRD D3）

-- ── 账户（券商 / 加密平台 / 现金） ──────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('broker', 'exchange', 'cash')),
  market      TEXT,
  currency    TEXT NOT NULL,
  icon_key    TEXT,
  icon_data   TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts (archived, sort);

-- ── 持仓（现金也在这张表：qty=余额, price=1） ────────────────────
CREATE TABLE IF NOT EXISTS holdings (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  class            TEXT NOT NULL CHECK (class IN ('stock', 'etf', 'crypto', 'fund', 'cash')),
  market           TEXT,
  symbol           TEXT,
  name             TEXT NOT NULL,
  currency         TEXT NOT NULL,
  qty              REAL NOT NULL DEFAULT 0,
  price            REAL NOT NULL DEFAULT 0,
  avg_cost         REAL,
  price_updated_at TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings (account_id, archived);
CREATE INDEX IF NOT EXISTS idx_holdings_class ON holdings (class, archived);
CREATE INDEX IF NOT EXISTS idx_holdings_market ON holdings (market, archived);

-- ── 历史（v1 只写不读，为走势图预埋） ────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id             TEXT PRIMARY KEY,
  holding_id     TEXT NOT NULL REFERENCES holdings (id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  price          REAL NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('manual', 'import', 'api')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history_holding ON price_history (holding_id, effective_date);

CREATE TABLE IF NOT EXISTS qty_history (
  id             TEXT PRIMARY KEY,
  holding_id     TEXT NOT NULL REFERENCES holdings (id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  qty            REAL NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('manual', 'import', 'api')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qty_history_holding ON qty_history (holding_id, effective_date);

-- ── 汇率（v1 手动维护；不做按日冻结，见 PRD D9） ─────────────────
CREATE TABLE IF NOT EXISTS fx_rates (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (base, quote)
);

CREATE TABLE IF NOT EXISTS fx_rate_history (
  id         TEXT PRIMARY KEY,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       REAL NOT NULL,
  changed_at TEXT NOT NULL
);

-- ── 审计日志（只读，不可编辑/删除） ──────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  source      TEXT NOT NULL DEFAULT 'web',
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id, ts DESC);

-- ── 配置 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 认证（单用户，仅一行） ───────────────────────────────────────
-- verifier = SHA-256(credential_bytes || verifier_salt)：Worker 只做一次哈希，
-- 昂贵的 PBKDF2 在浏览器端完成（免费版 10ms CPU 限制，见 PRD §9.1）
CREATE TABLE IF NOT EXISTS auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  algo          TEXT NOT NULL,
  kdf_salt      TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  verifier      TEXT NOT NULL,
  verifier_salt TEXT NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- ── 会话（支持"登出所有设备"） ───────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY, -- sha256(cookie token) 的十六进制
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen  TEXT,
  ua         TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ── 默认配置 ─────────────────────────────────────────────────────
INSERT INTO settings (key, value) VALUES ('display_currency', 'USD')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('schema_version', '1')
  ON CONFLICT (key) DO NOTHING;
