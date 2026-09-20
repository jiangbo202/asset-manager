-- 本地开发用示例数据（只应在 --local 执行，绝不要在 --remote 上跑）
-- 用法：npm run db:seed:local

INSERT OR REPLACE INTO accounts (id, name, kind, market, currency, icon_key, icon_data, sort, archived, note, created_at, updated_at)
VALUES
  ('dev-acc-broker', '示例券商', 'broker', 'us', 'USD', 'ibkr', NULL, 1, 0, '本地示例数据，可随时删', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-acc-crypto', '示例交易所', 'exchange', 'crypto', 'USD', 'binance', NULL, 2, 0, '本地示例数据，可随时删', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-acc-cash', '示例现金账户', 'cash', NULL, 'HKD', 'cash', NULL, 3, 0, '本地示例数据，可随时删', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR REPLACE INTO holdings (id, account_id, class, market, symbol, name, currency, qty, price, avg_cost, price_updated_at, archived, note, created_at, updated_at)
VALUES
  ('dev-h-aapl', 'dev-acc-broker', 'stock', 'us', 'AAPL', '苹果', 'USD', 30, 228.5, 175.2, '2026-09-19T20:00:00.000Z', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-h-voo', 'dev-acc-broker', 'etf', 'us', 'VOO', '标普500 ETF', 'USD', 12, 560.1, 430, '2026-09-19T20:00:00.000Z', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-h-btc', 'dev-acc-crypto', 'crypto', 'crypto', 'BTC', '比特币', 'USD', 0.35, 95000, 42000, '2026-09-19T20:00:00.000Z', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-h-eth', 'dev-acc-crypto', 'crypto', 'crypto', 'ETH', '以太坊', 'USD', 3.2, 3400, 2100, '2026-09-19T20:00:00.000Z', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev-h-cash-hkd', 'dev-acc-cash', 'cash', NULL, NULL, '港币现金', 'HKD', 45000, 1, NULL, '2026-09-19T20:00:00.000Z', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR REPLACE INTO fx_rates (base, quote, rate, updated_at)
VALUES ('USD', 'HKD', 7.8, '2026-01-01T00:00:00.000Z');
