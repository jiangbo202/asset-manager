# 个人资产管理（Cloudflare 纯托管）可行性与方案讨论

> 状态：讨论稿，暂不开发。核实时间：2026-09-20。

## 1. 结论

**可行性：高。** 整个应用可以 100% 跑在 Cloudflare 免费额度内，成本 $0/月（可选 $5/月 Worker Paid 换取 CPU 余量）。

- 前端 + 后端：单个 Worker（静态资源 + Hono API）
- 数据库：D1（SQLite）
- 定时任务：Cron Triggers（每天写一次快照）
- 认证：自建密码（满足需求 4）或 Cloudflare Access（Zero Trust 免费版 ≤50 用户）
- 备份：应用内 JSON 导出/导入 + `wrangler d1 export` + D1 Time Travel（免费 7 天）

**主要不确定性只有两个：**
1. Workers 免费版 **10ms CPU/请求** 的硬限制（密码哈希、复杂聚合计算是潜在触发点）。
2. 免费/非官方行情 API 的稳定性与对 Cloudflare 出口 IP 的可用性。

两者都有明确的对策（见 §9），不构成阻塞。

## 2. 平台能力与限额（已核实）

| 能力 | 免费版 | 说明 |
|---|---|---|
| Workers 请求 | 100,000/天 | 超额返回 Error 1027（fail open/closed 可配） |
| Workers CPU | **10ms/HTTP 请求，10ms/Cron 触发** | wall time 不限（客户端保持连接）；官方称"平均 2.2ms，重认证/SSR 类 10–20ms"；偶发超标有缓冲 |
| Subrequests | 50/次调用；同时 6 个出站连接 | 行情抓取要批量接口，避免逐个 symbol |
| Cron Triggers | 5 个/账号 | 够用；不保证准点，可能延迟数分钟 |
| 静态资源 | 20,000 文件/版本，单文件 25MiB | SPA 路由用 `not_found_handling: single-page-application` |
| D1 存储 | 5GB/账号，单库 500MB | 本项目可用几十年 |
| D1 读 | 5,000,000 行/天 | |
| D1 写 | 100,000 行/天 | **2026-09-01 起超额会直接报错**（不再只是告警） |
| D1 Time Travel | 7 天 | 免费的兜底恢复能力 |
| KV | 100k 读/天，**1,000 写/天**，1GB | 写额度低，只适合做缓存/会话 |
| Durable Objects (SQLite) | 免费版可用，5GB/账号 | 无"行读写"日限，作为 D1 的替代方案 |
| R2 | 10GB 存储，A 类 100 万/月，出站免费 | 可选（存备份）；需开通 R2 订阅 |
| Zero Trust / Access | 免费版 **50 用户上限** | 2026-08 起可直接"一键保护某个 Worker"（含 workers.dev、Custom Domain、preview） |

> 结论：单用户应用的真实用量大约在限额的 0.1% 量级，**唯一的真实约束是 10ms CPU**。

## 3. 推荐架构

```
浏览器 (React SPA, 静态资源)
   │  fetch /api/*  (Cookie 会话)
   ▼
Cloudflare Worker (Hono)
   ├── 静态资源绑定 (SPA, 同一 Worker 部署)
   ├── D1  (accounts / instruments / transactions / prices / snapshots / audit_log / settings)
   ├── KV  (可选：短期行情缓存, TTL 缓存)
   └── Cron Trigger（每日快照 + 抓价 + 备份）
        └── 外部: 行情 API / 汇率 API
```

选型建议：

| 层 | 选择 | 理由 |
|---|---|---|
| 前端 | React + Vite + TypeScript + Tailwind | 与 `@cloudflare/vite-plugin` 官方模板一致，一条命令构建+部署 |
| 图表 | ECharts（treemap/饼/堆叠面积齐全）或 Recharts（更轻） | 需求包含饼图、走势、分布；ECharts 覆盖最全，静态资源体积无所谓 |
| 后端 | Hono + Zod | Workers 生态标准，路由/中间件/校验都轻量 |
| DB | D1 | 迁移、导出、Time Travel 工具链最成熟 |
| 本地开发 | `wrangler dev` + 本地 D1 + Vitest `@cloudflare/vitest-pool-workers` | 不消耗线上额度 |
| 部署 | `wrangler deploy`（含静态资源） | 单次原子部署 |

为什么不用 Durable Objects 做主力存储：查询/聚合/导出体验不如 D1，且本项目不存在并发写冲突问题。**保留 DO 作为 plan B**——如果 D1 的每日行读写限额在实际使用中被证明是问题（大概率不会），DO SQLite 无行级日限。

## 4. 数据模型（草稿）

核心争论点：**持仓是"交易流水推导"还是"直接可编辑的余额"。**

- 流水制：历史准确、能算成本与盈亏、天然就是"操作记录"；但录入成本高，期初持仓要造假期初交易。
- 余额制：录入简单；但"历史操作记录"要靠审计日志补，盈亏要靠手填成本。

**建议折中（推荐）：**
- 股票/加密：以 `transactions` 为准，数量与成本自动推导；支持一笔 `opening_balance` 类型交易来录入存量持仓。
- 现金：以 `deposit/withdraw/adjust` 交易推导各账户各币种余额，录入界面提供"直接设为 X"（底层写成一笔 adjust 交易）。
- 所有写操作统一走 service 层，自动写 `audit_log`。

```sql
accounts        (id, name, kind[broker|exchange|cash|wallet], currency, icon_key, sort, archived, note)
instruments     (id, symbol, name, class[stock|etf|crypto|fund|cash], currency,
                 price_source[yahoo|coingecko|binance|stooq|manual], source_symbol, manual_price)
transactions    (id, account_id, instrument_id, type[buy|sell|dividend|deposit|withdraw|fee|transfer_in|transfer_out|opening],
                 qty, price, fee, fx_rate, trade_date, note, created_at)
prices          (source, symbol, date, close, currency, fetched_at, PRIMARY KEY(source,symbol,date))
fx_rates        (date, base, quote, rate, PRIMARY KEY(date,base,quote))
snapshots       (date, base_currency, total_value, breakdown_json, created_at, PRIMARY KEY(date))
audit_log       (id, ts, entity, entity_id, action[create|update|delete|import], before_json, after_json, note)
settings        (key, value)          -- base_currency, snapshot_hour, snapshot_tz ...
auth            (id=1, algo, salt, hash, iterations, must_change, updated_at, last_login_at)
```

关键设计点：

1. **`snapshots` 每天一行、明细塞 JSON**。不要每天为每个持仓写一行：50 个持仓 × 365 天 = 18k 行/年，一次"看一年走势"就要读 18k 行，会很快吃掉 5M 行/天的额度。一天一行 → 一年 365 行。
2. **`prices` 落库缓存日线**，不要每次打开页面都打外部 API（省 subrequest、省配额、断网也能看图）。
3. **汇率必须按日快照保存**：多币种净值曲线要用当日汇率折算，不能用今天的汇率回算历史，否则曲线会随汇率漂移。
4. 非交易日/停牌：取最近一个可用收盘价（forward fill），否则曲线上会出现空洞。
5. 快照时间点要可配置（默认 UTC 22:00 左右，覆盖美股收盘；纯 A 股/港股用户可调）。

## 5. 功能拆解

| 需求 | 方案要点 |
|---|---|
| 资产类别：股票/加密/现金 | `instruments.class` + `accounts.kind` 二维分类，饼图/堆叠图两个维度都能切 |
| 券商/平台/现金账户 + 图标 | `accounts` 表 + `icon_key`；图标**打包进静态资源**，不外链 |
| 增删改 + 历史操作记录 | 审计日志（含 before/after diff），前端提供"操作历史"页与按实体筛选、回滚入口（可选） |
| 分布图 | 按 类别 / 账户 / 标的 / 币种 的饼图 + treemap |
| 每天走势 | `snapshots` 折线 + 堆叠面积（分类别）+ 区间对比（近 1M/3M/1Y/全部） |
| 盈亏 | `总资产 − 净投入`；单标的用平均成本法；未录成本时显示"—"而不是 0 |
| 备份/导入 | 见 §8 |

**图标方案（需求 3.3）：**
- 内置一套精选 SVG（30–60 个常见品牌），打包为静态资源 + sprite，离线可用。
- simple-icons 覆盖不到的（多数券商：富途/老虎/IBKR/招商…）用**首字母字母块 + 品牌色**兜底，并支持用户上传自定义 SVG/PNG（小图存 D1 base64 即可，几 KB）。
- 注意：simple-icons 会因商标政策移除部分品牌图标，所以**必须有兜底**，不能假设某个 logo 一定存在。
- 商标：个人自用、不声称关联即可，风险可忽略。

## 6. 行情/汇率数据源

原则：**每个 instrument 可独立配置数据源，且始终允许手工覆盖价格**。行情只是"便利功能"，不是系统正确性的依赖。

| 类别 | 候选 | 备注 |
|---|---|---|
| 加密 | CoinGecko keyless 公共 API、Binance 公共 API | 均无需 key；CoinGecko 一次可查多个 id（省 subrequest）；Binance 无 key 但有地域限制可能 |
| 美股 | Yahoo Finance 非官方 chart 接口、Finnhub、Twelve Data、Tiingo、Stooq | Yahoo 非官方、可能对数据中心 IP 限流；Finnhub/Twelve Data 需 key，免费额度小 |
| 港股/A股 | Stooq（含 HK）、腾讯/新浪非官方行情（需 Referer 头） | ⚠️ 待实机验证可用性 |
| 汇率 | frankfurter.dev（ECB，无 key，含历史）、open.er-api.com | 覆盖主流法币，无加密 |

抓取策略：
- **每日 Cron**：批量拉当日收盘价 + 汇率 → 写 `prices`/`fx_rates` → 写 `snapshots`。批量接口 + 50 subrequest 上限完全够。
- **页面实时刷新（可选）**：仅对"当前持仓涉及的 symbol"按 TTL（60s）缓存到 KV/D1 后再取，避免打爆第三方限流。
- 失败处理：抓不到就沿用上一日价格，并在 UI 标注"数据陈旧"。
- API key 一律放 Worker Secrets（`wrangler secret put`），绝不出现在前端 bundle 或导出的备份里。

## 7. 首次部署与"初始化随机密码"（需求 4）

### 方案 A（推荐）：部署时本地生成，无"抢注窗口"

```
deploy 脚本:
 1. wrangler d1 migrations apply --remote
 2. 本地 crypto 生成随机密码（如 4 词口令 或 16 字符 base58）
 3. 本地 PBKDF2 计算 hash + salt
 4. wrangler d1 execute --remote 写入 auth 表
 5. 终端打印明文密码（只打印一次）
```
优点：线上不存在"第一个访问者即可初始化"的窗口期，也不需要 setup token。
缺点：密码变更要走同样的 CLI 或应用内"修改密码"。

### 方案 B：首访初始化
首次请求发现 `auth` 为空 → 进入 setup 模式 → 生成随机密码存 hash、明文只显示一次。
**风险**：在 setup 完成前，任何知道 URL 的人都能抢注。缓解：用 `SETUP_TOKEN`（部署时 `wrangler secret put`）保护 setup 接口，或先挂 Access 再放开。

### 方案 C（省 CPU，可作为叠加层）：Cloudflare Access
Zero Trust 免费（≤50 用户），2026-08 起可一键保护单个 Worker（含 workers.dev / Custom Domain / preview），登录走邮箱 OTP + 内置 IdP。
- Worker 内可读 `ctx.access.getIdentity()`，本地开发可用 `wrangler.jsonc` 的 `access.dev` 模拟。
- 如果用了 Access，需求 4 的"随机密码"就变成可选（可作为第二道口令，或直接不做 App 层认证）。

### ⚠️ 10ms CPU 与密码哈希的直接冲突

PBKDF2-SHA256 主流迭代数（10 万次以上）在 10ms 内很可能跑不完 → 登录接口有概率 Error 1102。对策（按推荐顺序）：

1. **Access 承担认证边界**（0 CPU 成本，且天然防暴力破解）。
2. 保留自建密码但**降低迭代数**（如 1 万次），配合**严格登录限流**（5 次失败锁 15 分钟）。单用户场景下可接受。
3. 依赖"偶发超标有缓冲"特性：登录频率极低（每次会话一次），偶发超标通常被容忍——但**不要把它当设计前提**。
4. 升级 Workers Paid（$5/月，CPU 上限 30s）——最省心。

会话方案：`__Host-` 前缀 + HttpOnly + Secure + SameSite=Lax 的 Cookie，值为 HMAC 签名令牌（密钥在 Secret），或存不透明 session id 到 D1 以便随时吊销。配合 Origin 校验 + 自定义头做 CSRF 防护。

## 8. 备份与导入（需求 5）

分三层，互为补充：

1. **应用内 JSON 导出/导入**（用户可见、可迁移）
   - 导出：`{schema_version, exported_at, app_version, data:{accounts, instruments, transactions, prices?, snapshots?, settings}}`
   - 导入：校验版本 → **dry-run 差异预览** → 事务内 replace 或 merge（按 id/业务键去重）
   - 可选：在浏览器端用 WebCrypto AES-GCM 加密（口令加密），既避免敏感数据明文落地，也**不消耗 Worker CPU**
   - 注意：默认**不导出** API key / 密码 hash（或单独加密导出）
2. **CLI 全量备份**：`npx wrangler d1 export <db> --remote --output=backup-YYYYMMDD.sql`（文档已核实支持）
3. **平台兜底**：D1 Time Travel 免费 7 天，可回滚到任意时间点
4. 可选自动化：Cron 每日把 JSON 备份写入 R2（免费 10GB），保留 N 份轮转。R2 需单独开通订阅，不启用也不影响前三条。

导入健壮性要求：只接受 schema_version ≤ 当前版本；导入前自动生成一份"导入前快照"到 audit_log/文件，便于回滚。

## 9. 风险清单与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | 免费版 10ms CPU 被击穿（哈希、大 JSON 解析、全量聚合） | 502/1102 | Access 承担认证；聚合放 SQL 而非 JS；分页/限制区间；实测 CPU time；必要时 $5/月 |
| 2 | D1 免费限额 2026-09-01 起**硬报错** | 服务不可用（当天） | 快照一天一行；不写循环；写入量监控；保留 DO/Paid 退路 |
| 3 | 免费行情 API 不稳 / 封 CF 出口 IP | 价格不准/图断 | 多源可插拔 + 手工价格兜底 + 陈旧标记；价格落库缓存 |
| 4 | 免费 API 的 ToS/再分发条款 | 合规 | 仅个人自用、不公开、不再分发数据 |
| 5 | 单库无自动异地备份 | 数据丢失 | 三层备份 + 建议定期导出到本地 |
| 6 | setup 抢注 / 弱口令 / 暴力破解 | 财务数据泄露 | 方案 A 无窗口期；登录限流；Access；不用可猜的 workers.dev 子域 |
| 7 | 备份文件泄露（含全部资产数据） | 隐私 | 客户端加密备份；备份不落第三方 |
| 8 | 多币种 + 非交易日的净值口径不一致 | 曲线"跳跃"/误导 | 汇率按日快照 + forward fill + 明确口径文档 |
| 9 | Cron 不准点/漏跑 | 走势缺日 | 惰性补偿：首次访问时检查并补当日快照 |
| 10 | 商标/logo 使用 | 法务（低） | 内置精选 + 字母兜底，个人自用 |
| 11 | 时区与"今天"的定义 | 快照错日 | 统一 UTC 存储、UTC+可配置展示时区、快照日以配置时区切分 |

## 10. 成本

| 项 | 费用 |
|---|---|
| Workers + 静态资源 + D1 + Cron + KV(可选) + Access | $0/月（免费额度内） |
| R2 备份（可选） | $0/月（10GB 内） |
| 自定义域名（可选，Access 和美观都更好） | ~$10/年 |
| Workers Paid（可选，消除 CPU 焦虑） | $5/月 |

## 11. 工作量估算（单人）

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 定 schema + 迁移 + 项目骨架 + 部署流水线 | 0.5–1 天 |
| P1 | 认证（方案 A）+ 会话 + 限流 + 安全头 | 1 天 |
| P2 | 账户/标的/交易 CRUD + 审计日志 + 成本推导 | 1.5–2 天 |
| P3 | 行情/汇率抓取 + 每日快照 Cron + 惰性补偿 | 1–1.5 天 |
| P4 | 可视化（饼图/treemap/走势/堆叠/表格 + 区间切换） | 1–2 天 |
| P5 | 备份导出/导入 + 差异预览 + 加密 | 1 天 |
| P6 | 打磨：图标库、移动端、错误态、陈旧数据提示 | 1 天 |
| 合计 | | **约 7–10 人天** |

最小可用版（不做外部行情，全部手工估值 + 单一密码 + 饼图/走势）约 **3–4 人天**。

建议里程碑：M1 = P0+P1+P2（能录能用）；M2 = P3+P4（能看趋势）；M3 = P5+P6（能长期用）。

## 12. 需要你拍板的问题

1. **持仓录入模型**：接受"交易流水推导"（准确但录入多），还是要"直接编辑数量"（简单但盈亏靠手填）？还是按建议做折中？
2. **认证**：只用自建随机密码（方案 A），还是叠一层 Cloudflare Access？如果接受 Access，App 层密码可以做得很轻。
3. **行情**：一期是否就要接外部行情？还是先手工估值、二期再接？（我建议先手工，把数据模型和 UI 跑通）
4. **主要市场**：美股 / 港股 / A 股 / 加密，各占比？这决定数据源选型和快照时间点。
5. **基准币种**：CNY / HKD / USD？
6. **成本基线**：是否接受 $5/月 Paid？如果接受，10ms CPU 这条最大风险直接消失。
7. **精度要求**：需要成本/盈亏核算到什么程度（平均成本法即可？要不要 FIFO？要不要分红/拆股）？
8. **是否多设备/多人**：确认单用户单密码即可？

## 13. 备选方案（为什么仍建议自建）

| 方案 | 结论 |
|---|---|
| Ghostfolio | 开源、功能强，但需 Node + Postgres，**不能纯 Cloudflare 托管** |
| Firefly III | PHP + MySQL，同上 |
| Notion / Google Sheets | 无操作审计、可视化弱、依赖第三方 |
| Durable Objects 作主存储 | 无行级日限，但查询/导出工具链弱，留作 plan B |

自建的收益：完全可控、零成本、数据自持、可视化可按自己持仓结构定制；代价是约 1–2 周的开发投入。

## 14. 下一步（等你确认后）

1. 回答 §12 的问题 → 锁定范围
2. 输出 `wrangler.jsonc` + D1 迁移脚本 + API 契约（OpenAPI 风格）
3. 用最小闭环（登录 → 建账户 → 录持仓 → 看饼图）做技术验证 spike，**先实测 10ms CPU 与行情源可用性**，再决定是否进入 P2
