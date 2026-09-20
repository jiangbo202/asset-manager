# Asset Manager · 个人资产管理

把股票、加密货币和现金放在一处记录和查看的个人记账工具。**纯 Cloudflare 部署**（Workers + D1 + 静态资源），
数据只存在你自己的 Cloudflare 账号里，不含任何遥测与第三方统计。

[![CI](https://github.com/jiangbo202/asset-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangbo202/asset-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Fork 之后先跑一次**：`npm run setup:repo -- 你的GitHub用户名` —— 它会把本文与 issue 模板里的
> `USERNAME` 占位符替换成你自己的仓库地址（否则徽章与链接都是错的）。

---

## 目录

1. [5 分钟上手](#-5-分钟上手)
2. [部署（两种方式）](#-部署两种方式)
3. [本地开发](#-本地开发)
4. [第一次必做](#-第一次必做)
5. [功能一览](#-功能一览)
6. [语言与时区](#-语言与时区)
7. [行情数据源](#-行情数据源)
8. [备份与恢复](#-备份与恢复)
9. [数据与隐私](#-数据与隐私)
10. [免费额度](#-免费额度)
11. [FAQ](#-faq)
12. [升级](#-升级)
13. [开发与贡献](#-开发与贡献)
14. [路线图](#-路线图)

---

## 🚀 5 分钟上手

```bash
git clone https://github.com/jiangbo202/asset-manager.git
cd asset-manager && npm install

export CLOUDFLARE_API_TOKEN=你的token      # Windows: $env:CLOUDFLARE_API_TOKEN="你的token"
npm run deploy:safe
```

`deploy:safe` 会依次：创建/复用 D1 → 构建 → 应用迁移 → 部署 → 生成 `SETUP_TOKEN` 并**在终端打印一次**。

然后：

1. 打开终端打印的网址
2. 粘贴 `SETUP_TOKEN`
3. 设置你自己的登录密码 → 开始记账

> `CLOUDFLARE_API_TOKEN` 需要 **Workers 编辑 + D1 编辑** 权限。

## 📦 部署（两种方式）

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)

Cloudflare 会：把仓库复制到你自己的账号 → 自动创建 D1 并绑定 → 在向导里让你填两个 Secret →
用 Workers Builds 构建并部署。向导里要填的：

| 名称 | 怎么来 |
|---|---|
| `SETUP_TOKEN` | `openssl rand -hex 32`，**自己记好**，首次打开网页要用 |
| `SESSION_SECRET` | `openssl rand -hex 32` |

### 方式二：命令行

见上面「5 分钟上手」。常用命令：

```bash
npm run setup:d1          # 只创建/复用 D1 并写入 database_id
npm run setup:secrets     # 重新生成 SETUP_TOKEN / SESSION_SECRET
npm run db:migrate:remote # 只应用数据库迁移
npm run deploy            # 迁移 + 部署（不含 D1 创建与 secret）
npm run verify            # 本地全套检查：lint + test + build + 首包体积
npm run setup:repo -- 你的用户名   # fork 后替换文档里的仓库地址占位符
```

细节与故障排查见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 💻 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

本地数据落在 `.wrangler/state/`，**不消耗任何线上额度**。`npm run dev` 会先自动应用本地迁移。
首次进入初始化页时，`SETUP_TOKEN` 填 `.dev.vars` 里的值。

完整指南（调试、断点、D1 操作、常见问题）：**[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)**

## ✅ 第一次必做

1. 用 `SETUP_TOKEN` 完成初始化，设置自己的密码
2. 设置里确认**显示币种**（默认 USD）与**时区**（默认 UTC）
3. 若要记非 USD 资产，在「设置 → 汇率」补上汇率（如 `1 USD = 7.8 HKD`）
4. 「账户」里建券商 / 加密平台 / 现金账户（可挑平台图标）
5. 「持仓」里录入代码、数量、价格、平均成本 —— 填完代码可自动查名称，价格可一键取最新价
6. 到「设置 → 数据概览」看一眼 D1 用量，心里有数

## 🧩 功能一览

**账户与持仓**

- 账户：券商 / 加密平台 / 现金，支持市场、币种、备注、**52 个内置平台图标**（字母标 + 品牌色，无商标风险；未选中时用名称首字母自动配色）
- 持仓：股票 / ETF / 加密 / 基金 / 现金；手动数量与价格；平均成本法算盈亏；支持归档与批量改价
- 现金只需填余额，价格恒为 1
- **输入代码自动补全**：填完代码（或点「查名称」）自动带出名称、币种、市场与交易所；「取最新价」一键填价

**可视化**

- 环形图（类别 / 账户 / 币种 / 标的四个维度，**点击扇区即筛选**）
- Treemap（账户 → 标的，可下钻到单个账户）
- 每日走势图：1M/3M/6M/1Y/ALL，总额或按类别堆叠，悬浮看当日明细
- 持仓明细表：可点击表头排序、按陈旧度排序
- 筛选条件写入 URL：刷新、收藏、分享链接都能还原同一视图

**行情与快照**

- 默认接免费公开接口，**零配置可用**（CoinGecko / Binance / Yahoo / 腾讯 / Frankfurter / open.er-api）
- 一个标的依次尝试多个数据源，前一个失败自动顺延（实测 CoinGecko 被限流后自动落到 Binance）
- 优先使用批量接口省请求：6 条持仓实测只用 5 次请求（免费版上限 50 次/调用）
- **抗限流**：命中 429 时该源自动冷却 10 分钟（连续失败 3 次冷却 30 分钟），期间换用其它源，绝不静默失败
- 可以填自己的 API Key（加密存储），或用「自定义数据源」接任意 HTTP 行情服务
- **每日快照**：Cron 每小时触发、只在配置的小时动手，先刷新行情再拍快照；漏跑会在下次自动补上

**其它**

- 多币种：显示币种可切换，汇率手动维护；**缺汇率时明确标为「未折算」而不是按 1:1 糊弄**
- **汇率按日冻结**：快照记住当天汇率，事后改汇率不会让历史曲线整体平移
- 操作历史：所有写操作自动留档，可展开看字段级 diff，支持类型 / 操作 / 日期区间筛选
- 备份：导出 JSON（可选包含操作历史、可选口令加密）；导入前先做**全量校验 + 差异预览**，支持合并/覆盖
- **中英文双语** + **可配置时区**
- 响应式：窄屏隐藏次要列、导航横向滚动、单列表单

## 🌐 语言与时区

**语言**：设置 → 界面语言，可选「跟随浏览器 / 简体中文 / English」，立即生效并随备份迁移。
服务端提示（表单校验、导入警告、行情失败原因、操作历史备注）也会按请求的 `Accept-Language` 返回对应语言。
英文词典按需加载（独立 chunk，约 9KB），中文用户不会下载它。

**时区**：设置 → 时区，默认 **UTC**，内置 21 个常用 IANA 时区，也可直接填 `Asia/Shanghai` 这类名称。

| 时区影响 | 说明 |
|---|---|
| 每日快照的「哪一天 / 几点」 | 按该时区的日历日与钟点，改时区后快照时间自动跟着变 |
| 价格 / 数量历史的生效日期 | 手动录入与自动抓取都取「该时区的今天」 |
| 操作历史日期筛选 | 你选 2026-09-20 = 你那个时区的那一天 |
| 界面时间展示 | 按该时区渲染，而不是打开页面那台机器的本地时区 |

数据库里始终存 UTC，时区只决定「日历怎么解释」——所以换时区不会让历史数据错位。

## 📈 行情数据源

| 数据源 | 覆盖 | 说明 |
|---|---|---|
| CoinGecko | 加密 | 无 Key，一次查多币；代码用 coin id（如 `bitcoin`），常见币已内置映射 |
| Binance | 加密 | 无 Key，一次查多对；备用 |
| Yahoo Finance | 股票 / 加密 / 汇率 | 覆盖最广：美股、港股 `.HK`、A股 `.SS/.SZ`、`BTC-USD`、`HKD=X`；每标的 1 次请求 |
| 腾讯行情 | 港股 / A股 | 一次查多码（如 `hk00700`）；备用 |
| Frankfurter（欧央行） | 汇率 | 无 Key，工作日更新 |
| open.er-api | 汇率 | 备用，币种更多 |
| 自定义 | 任意 | URL 模板 + JSON 点号路径 + 自定义请求头，可接自建服务 |

代码映射规则（可用「行情代码覆盖」逐条改写）：

```
700   + 港股  → Yahoo 0700.HK   / 腾讯 hk00700
600519 + A股  → Yahoo 600519.SS / 腾讯 sh600519
BTC   + 加密  → CoinGecko bitcoin / Binance BTCUSDT / Yahoo BTC-USD
```

## 💾 备份与恢复

三层保险，建议至少用上前两层：

1. **应用内导出**（设置 → 备份与恢复）：导出 JSON，可选包含操作历史、可选口令加密（AES-GCM，在浏览器里加密，口令不会发给服务器）。
   导入时先点「预览差异」看清楚会新增/覆盖/删除多少条，再确认；支持**合并**与**覆盖**两种模式。
2. **命令行全量备份**：

   ```bash
   npx wrangler d1 export DB --remote --output=backup-$(date +%F).sql
   # 恢复：npx wrangler d1 execute DB --remote --file=backup-2026-09-20.sql
   ```

3. **Cloudflare Time Travel**（免费 7 天）：Dashboard → D1 → Time Travel 可回滚到任意时间点。

> 备份文件里是你的全部资产数据，请当密码一样保管。

## 🔐 数据与隐私

- 所有数据在你自己的 Cloudflare D1 里，本应用**没有后端服务器**，也不上传任何数据
- 不含 Analytics、不含遥测、不含第三方字体/CDN
- 密码只以不可逆校验值存储；数据库泄露也无法直接登录（见 [SECURITY.md](SECURITY.md)）
- 第三方 API Key 用 `SESSION_SECRET` 派生密钥加密后入库，接口从不回传明文

## 💰 会超免费额度吗

不会。典型的个人用量：

| 资源 | 典型用量 | 免费额度 |
|---|---|---|
| Workers 请求 | < 1,000 / 天 | 100,000 / 天 |
| Workers CPU | 首页聚合 ≈ 1–3 ms | 10 ms / 请求 |
| D1 行读 | < 50,000 / 天 | 5,000,000 / 天 |
| D1 行写 | < 100 / 天 | 100,000 / 天 |
| D1 存储 | < 20 MB | 5 GB |
| Cron | 1 个触发器（每小时；只在配置小时干活） | 5 个 / 账号 |
| Subrequests | 每天 1 次批量抓取，实测 5–10 次 | 50 次 / 调用 |
| 静态资源 | 首包 91 KB gzip + 按需分包 | 免费 |

「设置 → 数据概览」可以随时看到实际行数。

## ❓ FAQ

**忘记密码怎么办？**
Dashboard → Workers & Pages → D1 → `asset-manager-db` → Console 执行 `DELETE FROM auth;`，
然后重跑 `npm run setup:secrets`（或重新部署）拿到新的 `SETUP_TOKEN`，刷新网页重新初始化。账户与持仓数据不受影响。

**忘记 `SETUP_TOKEN` 了？**
同上：删掉 `auth` 行 + 重新生成 token。token 只在生成时打印一次。

**升级后提示「数据库需要升级」？**
数据库结构落后于代码。按页面提示执行 `npm run db:migrate:local`（本地）或 `npm run db:migrate:remote`（线上，或直接重跑 `npm run deploy:safe`）。
迁移是幂等的，不会动已有数据。

**部署时报 `Authentication error [code: 10000]`**
API Token 权限不足或未设置。确认 Token 含 **Workers 编辑 + D1 编辑**，或改用 `npx wrangler login`。

**价格为什么没更新？**
行情每天自动更新一次（默认 22:00，按你配置的时区）。想立刻更新就点「设置 → 行情与快照 → 立即刷新行情」。

**提示「限流冷却」是什么？**
免费接口对同一 IP 有频率限制。命中后该数据源暂停 10 分钟（连续失败 30 分钟），期间自动换用其它源。
冷却状态与上次错误都能在设置页看到；想彻底避开可以填自己的 API Key 或用自定义数据源。

**走势图为什么有几天是平的？**
那天没有快照（比如部署晚了、或 Worker 没被触发），系统会沿用前一日数值并标注「沿用前一日」。也可以手动补一条快照。

**能接自己的行情服务吗？**
可以。设置 → 行情与快照 → 自定义数据源，填 URL 模板（`{symbol}` 占位代码、`{key}` 占位密钥）与 JSON 价格路径（如 `data.price`）。

**能多人一起用吗？**
不能，也不打算做。单用户单密码，数据在你自己账号里。

## 🔄 升级

```bash
git pull
npm install
npm run deploy:safe      # 会自动应用新的 D1 迁移
```

升级前建议先导出一份备份。若页面提示数据库需要升级，说明迁移没跑成功，见 FAQ。

## 🛠 开发与贡献

```bash
npm run dev        # 开发服务器（workerd + HMR，Worker 调试端口 9229）
npm run build      # 构建前端与 Worker
npm run preview    # 用构建产物本地跑，接近线上
npm test           # Vitest，跑在真实 workerd 里
npm run lint       # 四套 tsconfig 的类型检查
npm run verify     # 以上全跑 + 首包体积检查
```

技术栈刻意保持精简：**Hono + D1 + React**，没有 UI 库、没有图表库、没有状态管理库。
图表（环形图 / treemap / 走势图）全部手写 SVG/CSS；样式是手写 CSS + CSS 变量。

```
src/worker/     Worker：api 路由 / core 基础设施 / data 仓储层 / services 业务编排
src/web/        前端：lib（api、i18n、图表…）/ pages / components
src/shared/     前后端共用：类型、枚举标签、i18n 字典、时区工具
migrations/     D1 迁移（追加式，不修改已上线的文件）
scripts/        部署与本地开发脚本
tests/          Vitest（跑在 workerd 运行时，非 jsdom 模拟）
```

改代码前请读 **[CONTRIBUTING.md](CONTRIBUTING.md)**（约定、测试要求、文档索引）。

## 🗺 路线图

- **CSV 导入**：导入券商对账单，支持列映射与重复检测
- **交易日历感知**：非交易日沿用收盘价，避免曲线出现无意义的台阶
- **更多币种的自动汇率**：目前 ECB 覆盖面有限
- **交易流水账本**：FIFO 成本、分红、拆股、定投
- **TOTP 二次验证**、自定义图标上传、多用户 / 家庭共享

## 📚 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 需求与已确认决策、验收标准 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、数据模型、免费额度护栏、关键设计取舍 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署脚本、三条路径、故障排查 |
| [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) | 本地开发、调试、D1 操作 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 迁移、备份恢复、升级、排障 |
| [SECURITY.md](SECURITY.md) | 安全模型与漏洞上报 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |

## 📄 License

[MIT](LICENSE)。个人记账工具，**不提供投资建议**；请自行确认所在地区对加密资产记录的合规要求。
