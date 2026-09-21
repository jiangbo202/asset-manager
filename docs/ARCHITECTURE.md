# 架构与实现

> 本文回答「**怎么实现**」与「为什么这样实现」。需求与验收标准见 [PRD.md](PRD.md)。

---

## 1. 总览

```
浏览器（React SPA，静态资源）
   │  fetch /api/*（Cookie 会话，Accept-Language 决定提示语言）
   ▼
Cloudflare Worker（Hono）
   ├─ 静态资源：同一个 Worker 部署，SPA 回退
   ├─ D1：账户 / 持仓 / 历史 / 快照 / 汇率 / 审计 / 设置 / 会话
   ├─ Cron（每小时）：在配置时区的小时里「刷新行情 → 打每日快照」
   └─ 出站：免费行情与汇率接口（CoinGecko / Binance / Yahoo / 腾讯 / Frankfurter / open.er-api / 自定义）
```

单 Worker、单数据库、无外部依赖服务。没有队列、没有定时容器、没有第三方鉴权。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| Worker 框架 | Hono | 十余 KB，路由/中间件/校验齐全 |
| 数据库 | D1（SQLite）+ 官方 migrations | 支持 SQL 聚合与 Time Travel |
| 前端 | React 19 + Vite + TypeScript | 与 Cloudflare 官方 SPA 模板一致 |
| 样式 | 手写 CSS + CSS 变量 | 无 Tailwind、无 UI 库；深色模式跟随系统 |
| 图表 | **手写 SVG / CSS** | 环形图（stroke-dasharray）、squarified treemap、面积/堆叠走势图 |
| 国际化 | 自研（`src/shared/i18n.ts` + `locales/`） | 纯数据字典，前后端共用；按语言动态加载 |
| 时区 | 自研（`src/shared/time.ts`，基于 `Intl`） | 存储 UTC，展示与「哪一天」按配置时区 |
| 测试 | Vitest + `@cloudflare/vitest-plugin` | 跑在真实 workerd 运行时，非 jsdom 模拟 |
| 类型检查 | 4 套 tsconfig（web / worker / node / tests） | `npm run lint` 全查 |

**依赖纪律**：运行时依赖只有 `hono` / `react` / `react-dom`。曾尝试用 ECharts，实测首包从 81KB 涨到 244KB，
改为手写图表后回到 91KB —— 因此立了一条 CI 体积护栏（`npm run check:bundle`）。

## 3. 目录结构

```
src/
├── worker/
│   ├── index.ts            fetch + scheduled 入口
│   ├── app.ts              中间件装配（语言、会话解析、错误兜底、安全头）
│   ├── api/                HTTP 路由：auth / accounts / holdings / portfolio / settings / history / backup / quotes
│   │   ├── middleware.ts   requireInitialized / requireAuth（含 must_change 强制改密）
│   │   └── validate.ts     字段校验（labelKey + 模板 → 本地化错误）
│   ├── core/               基础设施：errors / utils / credentials / session / audit / secrets / i18n
│   ├── data/               仓储层（SQL 只出现在这里）：accounts / settings / fx / history / auth
│   └── services/           业务编排
│       ├── portfolio.ts    组合聚合（折算、占比、盈亏）
│       ├── snapshots.ts    每日快照 + 走势序列（按日补齐、降采样、汇率冻结）
│       ├── scheduler.ts    Cron 小时闸门
│       ├── backup.ts       导出 / 校验 / 差异预览 / 导入
│       └── quotes/         行情：providers（适配器）/ index（编排+健康度）/ health / lookup
├── web/
│   ├── App.tsx             路由 + 认证门禁 + 页面懒加载
│   ├── lib/                api / i18n / router / format / charts / trend / icons / crypto / download / useAsync
│   ├── pages/              Setup / Login / ChangePassword / Dashboard / Accounts / Holdings / History / Settings / MarketDataSection
│   └── components/         MarketFilter 等
└── shared/                 前后端共用：api-types / labels / i18n / locales / time / version
migrations/                 D1 迁移（追加式）
scripts/                    部署与本地开发脚本
tests/                      Vitest（api 集成 + services 单测）
```

## 4. 数据模型

```sql
accounts(id, name, kind[broker|exchange|cash], market, currency, icon_key, icon_data,
         sort, archived, note, created_at, updated_at)

holdings(id, account_id→accounts, class[stock|etf|crypto|fund|cash], market, symbol, name, currency,
         qty, price, avg_cost, price_updated_at,
         quote_source, quote_symbol,          -- 行情源与代码覆盖
         archived, note, created_at, updated_at)

-- 只写不读的历史，供走势与回溯（v1 起就在记录）
price_history(id, holding_id, effective_date, price, source[manual|import|api], created_at)
qty_history  (id, holding_id, effective_date, qty,   source, created_at)

-- 汇率：manual 永不被自动抓取覆盖
fx_rates(base, quote, rate, updated_at, source[manual|auto])
fx_rate_history(id, base, quote, rate, changed_at)
-- 按日冻结的汇率：画历史曲线用「那一天的汇率」
fx_daily(date, base, quote, rate, source, created_at)  PK(date,base,quote)

-- 每日快照：一天一行，明细按原币种存 JSON
snapshots(date PK, base_currency, total,
          by_currency_json, by_class_json, by_account_json, detail_json, created_at)

-- 行情运行与缓存
quote_cache(key PK, source, symbol, currency, price, fetched_at, error)
quote_runs(id, started_at, finished_at, trigger[cron|manual], updated, failed, requests, report_json)
lookup_cache(key PK, symbol, market, payload_json, fetched_at)

-- 系统
audit_log(id, ts, actor, entity, entity_id, action, before_json, after_json, source, note)
settings(key PK, value)
auth(id=1, algo, kdf_salt, iterations, verifier, verifier_salt, must_change, created_at, updated_at, last_login_at)
sessions(id PK, created_at, expires_at, last_seen, ua, ip)
```

### 4.1 关键设计点

1. **快照一天一行**，明细塞 JSON。若改成「每天 × 每持仓一行」，50 个持仓 × 365 天 = 1.8 万行/年，
   看一次「一年走势」就要读 1.8 万行，很快吃掉免费额度。
2. **`detail_json` 按原币种记录**（`{i,a,c,u,m,v}`），因此切换显示币种或改汇率时，
   任意历史点都能用当日冻结汇率重算，而不是只能显示记录时的那个币种。
3. **价格与数量历史从一开始就记录**（即使当前版本只用它做备份），使将来的走势分析无需回溯采集。
4. **审计日志只追加**：replace 导入也只清业务数据，历史记录是证据，不能被导入操作覆盖。
5. **`quote_source` / `quote_symbol` 挂在持仓上**：默认按市场推导代码，个别标的可逐条覆盖。
6. **`fx_rates.source`**：手工汇率优先级最高，自动抓取只更新 `auto` 行。

## 5. 免费额度护栏

| 资源 | 免费额度 | 本项目的用法与对策 |
|---|---|---|
| Workers 请求 | 100,000/天 | 单用户实际 < 1,000/天；仪表盘合并为一个聚合接口 |
| **Workers CPU** | **10ms/请求，10ms/Cron** | ① 认证的 PBKDF2 放浏览器，Worker 只做一次 SHA-256（≈0.1ms）② 聚合在 SQL 里做，不在 JS 里遍历行 ③ 走势点服务端降采样到 ≤400 点 ④ 页面代码分包，减小解析量 ⑤ 定时任务**一次调用只干一件重活**（配置的小时刷行情、之后拍快照），并且持仓分批刷新（`CRON_MAX_HOLDINGS = 6`，按最久未更新轮转） ⑥ 热路径少跑数据库往返：配置一次 `getSettings()` 读完、连着几次写合并成一次 `db.batch`（每条 D1 语句的准备/解析都占 CPU） |
| Subrequests | 50/次调用 | 优先用批量接口（CoinGecko/Binance/腾讯）；Yahoo/自定义按标的单请求，用 6 并发 + 单次刷新请求预算上限 |
| 同时出站连接 | 6 | `mapLimit(items, 6, fn)` |
| Cron | 5 个/账号 | 只用 1 个（每小时）；非目标小时只读两次配置就返回；错过的当天小时会重试（补拍） |
| D1 行读 | 5,000,000/天 | 仪表盘查询限制在几千行内；历史按区间 + 降采样 |
| D1 行写 | 100,000/天 | 单次编辑约 3 行（持仓 + 历史 + 审计）；批量改价用一次 `batch`；行情一次刷新约 2 行/标的 |
| D1 存储 | 5GB/账号，单库 500MB | 快照一年约 1–2MB |
| 静态资源 | 20,000 文件 | 首包 93KB gzip + 按需分包 |

### 最贵的操作不是业务逻辑，而是“每条 D1 语句”

实测（真实 workerd，方法见 `tests/api/query-budget.test.ts`）：

- 单条 D1 语句的固定开销约 **0.3ms**（本地 workerd）；线上用 `npm run watch:cpu` 观察到的量级约 **2ms/条**
- **一次 `db.batch` 里的多条语句只算一次往返**，实测比串行快约 **4 倍**

所以热路径一律“一次 batch 读齐”：

- 每个请求的认证上下文 = **1 次 batch**（session + auth 行；`requireInitialized` / `requireAuth` /
  需要认证行的路由都直接复用上下文，不再查库）
- `/api/portfolio`：设置 + 持仓 + 汇率一次 batch
- `/api/portfolio/history`：设置 + 当前汇率 + 每日冻结汇率一次 batch，再取快照
- `/api/settings/overview`：8 个 COUNT 合成一条 SQL（子查询）
- 行情刷新：设置一次读完，收尾 3 次写合成 1 次 batch

`tests/api/query-budget.test.ts` 把每条路由的“语句数 + 往返数”固定成上限：
不小心加回一次串行查询，CI 会直接报出是哪条 SQL。

> 2026-09 起 D1 免费额度超额会**直接报错**（不再只是告警），所以上述护栏是硬要求，不是优化项。

## 6. 关键实现细节

### 6.1 认证

```
初始化/改密码（浏览器）:
  key = PBKDF2-SHA256(password, kdfSalt, 300_000)
Worker:
  verifier = SHA-256(key ‖ verifierSalt)     // 单次哈希，≈0.1ms
  只存 verifier、kdf_salt、verifier_salt

登录（浏览器）:
  GET /api/auth/params → {kdfSalt, iterations}
  key = PBKDF2-SHA256(password, kdfSalt, iterations)
  POST /api/auth/login {credential: key}
Worker:
  常数时间比较 SHA-256(credential ‖ verifierSalt) 与 verifier
```

已知取舍：该 `key` 等价于密码（pass-the-hash），依赖 HTTPS 与 HttpOnly Cookie 保护。
换来的是**免费版 10ms CPU 下的可用性**。详见 [SECURITY.md](../SECURITY.md)。

- 会话：Cookie 放随机 token，库里只存 `sha256(token)`，因此可随时吊销（支持「登出所有设备」）。
- 登录限流：失败计数与锁定时间写在 `settings`（5 次 → 15 分钟）。

### 6.2 组合聚合（`services/portfolio.ts`）

单个 SQL 读取出全部持仓（含账户名/图标），随后在内存中计算：

- 原币种市值 → 用汇率折算到显示币种；**查不到汇率时该持仓标记 `fxMissing` 并从总额排除**
- 同时给出 `costDisplay` / `pnlDisplay`（折算后的成本与盈亏）——多币种汇总必须用这两个，
  否则就是把不同币种的数字相加
- 输出 `byClass` / `byAccount` / `byCurrency` / `holdings`，前端所有图表都从这一个响应渲染

### 6.3 每日快照与走势（`services/snapshots.ts`）

- `takeSnapshot`：按显示币种算总额，同时写 `by_*_json`、`detail_json`、以及当天的 `fx_daily`
- `buildTrendSeries`：
  1. 读取区间内快照
  2. 用**各快照日期的冻结汇率**（缺失则 forward fill 到最近一天，再回退当前汇率）折算每个明细
  3. 按日 forward fill 补齐缺失日期（标注 `filled`）
  4. 点数 > 400 时按周/月降采样
  5. 返回 `rateMode`（frozen / mixed / current）让界面标注口径

### 6.4 行情（`services/quotes/`）

```
providers.ts   适配器 + 代码映射（纯函数，易测）
  ├─ 输入归一化：QuoteTarget{ kind, symbol, currency, market, sourceOverride, symbolOverride }
  ├─ 每个适配器返回统一 Quote{ key, price, currency, source, symbol, name? }
  └─ 代码映射规则：700+hk→0700.HK、03121+hk→3121.HK（Yahoo 4 位）/ hk03121（腾讯 5 位）、
     600519+cn→600519.SS / BTC→bitcoin 或 BTCUSDT
index.ts       编排
  ├─ 收集目标：非现金、未归档、有代码的持仓；以及组合里出现但缺汇率的币种对
  ├─ 按类型依次尝试数据源（planProviders），前一个失败顺延
  ├─ 请求预算与 6 并发限制
  ├─ 写入：持仓价格 + price_history + quote_cache + fx_rates(auto) + quote_runs
  └─ 健康度：429 → 冷却 10 分钟；连续失败 3 次 → 30 分钟；成功后清零
lookup.ts      代码查询（输入代码 → 名称/价格/币种/市场）
  ├─ 先按市场规则推导代码并置顶，再用 Yahoo 搜索补充正式名称与交易所
  ├─ 按市场过滤噪音结果（搜 "700" 不会返回加拿大基金）
  └─ 结果缓存 24h（lookup_cache），force=true 绕过
```

### 6.5 备份导入（`services/backup.ts`）

1. `parseBackup`：全量校验（format / schemaVersion / 枚举 / 数值范围 / id 唯一 / 引用完整性）。
   用户会遇到的错误走 i18n；"备份被手工改坏"才出现的结构性错误保留英文技术描述（便于定位第几行）。
2. `previewBackup`：逐实体的 新增/覆盖/删除 计数 + 警告（缺汇率、孤儿历史、大数据量、replace 语义）。
3. `applyBackup`：拼装语句后写入
   - ≤1000 条：**单次 `batch`（一个事务，原子）**
   - 超出：分批 500，并在预览阶段明确告知「可能部分写入」
   - 历史表与审计表用 `INSERT OR IGNORE` → 重复导入不产生重复行
   - 跳过 `settings.schema_version`（库自身的结构标记）、`provider_keys` 与 `provider_config`（凭据及其配置）
   - 导出时同样排除这两项：备份是"数据"，不是"凭据"
7. **审计脱敏**：设置类写操作的审计快照会把 `provider_keys` 与自定义源的 `headers`/`key` 换成标记，
   只保留「哪些源启用」这类无害信息 —— 审计会被导出、也会在界面展示

### 6.6 国际化

- 字典按 key 组织（约 380 个 key × 2 语言），插值 `{{name}}`
- 前端：默认语言静态引入；其它语言 `import()` 拆成独立 chunk（英文 9KB）
- 服务端：`detectLang(Accept-Language)` → middleware 写入 `c.set('lang')` → 路由用 `tOf(c)`
- 校验错误用「字段名 key + 模板」组合（`error.field_required` + `field.accountName`），而不是拼字符串
- 测试断言两种语言的 key 完全对齐，漏翻直接失败

### 6.7 时区

- 存储永远是 UTC ISO；时区只影响「日历怎么解释」
- `src/shared/time.ts` 基于 `Intl.DateTimeFormat` 实现 `dateIn` / `hourIn` / `offsetMinutes` / `zonedDayRange`
- 影响面：快照日期与 Cron 闸门、价格历史生效日期、历史筛选边界、界面时间展示

## 7. 测试策略

| 层次 | 位置 | 做法 |
|---|---|---|
| 纯函数单测 | `tests/services/` | 代码映射、适配器解析、健康度冷却、readPath |
| API 集成 | `tests/api/` | 用 `SELF.fetch` 打真实 Worker + 真实 D1（每个文件前自动应用迁移） |
| 网络隔离 | 同上 | 适配器层注入假 `fetch`，真实网络只在人工验证时使用 |
| 体积门禁 | `scripts/check-bundle.cjs` | 首包 > 110KB 或合计 > 160KB 直接失败 |

约定：新增行为必须带测试；改 SQL 必须新增迁移文件（不改已上线的文件）。

## 8. 已知限制

1. **汇率只存当前值 + 按日冻结的快照值**：第一个快照之前的日期只能用当前汇率。
2. **免费行情接口非官方**：Yahoo 的 chart/search 是未公开接口，可能变更或被封；因此允许手工价格覆盖与自定义源。
3. **结构化校验错误未本地化**（见 §6.5 第 1 点，有意为之）。
4. **单进程假设**：单用户场景下没有并发写冲突处理（D1 自身保证单条语句原子性）。
5. **`price_history` 目前只写不读**：为后续走势/成本分析预埋，暂不参与计算。
