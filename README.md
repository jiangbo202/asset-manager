# Asset Manager · 个人资产管理

> **散落在各家券商与平台的钱，一处看清。**
> 股票、ETF、加密货币、现金都收进同一个页面；一键更新行情，总资产与浮动盈亏立刻算好 ——
> 不必再挨个登录各家 App 对账。

**整套跑在 Cloudflare 免费额度内**（Workers + D1 + 静态资源）：数据只存在你自己的 Cloudflare 账号里，
没有服务器要运维，没有遥测，也没有第三方统计；每天自动拍一张净值快照，历史走势自己攒。

**简体中文** | [English](README.en.md)

[![CI](https://github.com/jiangbo202/asset-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangbo202/asset-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![首包 93 KB gzip](https://img.shields.io/badge/%E9%A6%96%E5%8C%85-93%20KB%20gzip-blue)](#-免费额度够用吗)

> **Fork 之后先跑一次** `npm run setup:repo` —— 它会读取你的 git remote，把文档、徽章与 issue 模板里的仓库地址
> 换成你自己的（否则链接都指向原仓库）。

---

## 📸 界面预览

### 总览 · 关键指标与净值走势

![总览：总资产、持仓成本、浮动盈亏、价格新鲜度与走势图](docs/pic/account_total.png)

四张指标卡一眼看完全局；走势可切 `1M / 3M / 6M / 1Y / ALL`，也能从「总额」切成「按类别」堆叠。
右上角「更新行情」立刻抓最新价，不用等每日定时任务。

### 总览 · 分布图与持仓明细

![总览：环形图、treemap 与持仓明细表](docs/pic/position.png)

环形图支持**类别 / 账户 / 币种 / 标的**四个维度，点扇区即筛选；treemap 可下钻到单个账户，
勾选「同一标的合并」后跨券商的同一支股票会合成一块（悬停看各账户明细）。
持仓明细支持点表头排序、按价格陈旧度排序。

### 持仓 · 录入与批量改价

![持仓页：持仓列表与批量更新价格](docs/pic/have.png)

填代码可自动补全名称 / 币种 / 市场，「取最新价」一键填价；底部「批量更新价格」一屏改完一次提交。

### 账户 · 内置平台图标

![账户页：新建账户与平台图标选择器](docs/pic/add_account.png)

券商、加密平台、银行现金共 **53 个内置图标**（字母标 + 品牌色，无商标风险）。
未挑图标时按账户名首字母自动配色，不留白块。

---

## 📑 目录

1. [界面预览](#-界面预览)
2. [它做了什么](#-它做了什么)
3. [部署（5 分钟）](#-部署5-分钟)
4. [第一次必做](#-第一次必做)
5. [本地开发](#-本地开发)
6. [语言与时区](#-语言与时区)
7. [行情与汇率](#-行情与汇率)
8. [备份与恢复](#-备份与恢复)
9. [数据与隐私](#-数据与隐私)
10. [免费额度够用吗](#-免费额度够用吗)
11. [FAQ](#-faq)
12. [升级](#-升级)
13. [开发与贡献](#-开发与贡献)
14. [路线图](#-路线图)

---

## ✨ 它做了什么

**记账**

- 账户：券商 / 加密平台 / 现金，可标市场、币种、备注；支持归档
- 持仓：股票 / ETF / 加密 / 基金 / 现金；现金只需填余额
- 平均成本法算盈亏；支持归档、批量改价、多头寸同标的（不同账户各记各的）
- 填完代码自动带出名称 / 币种 / 市场，「取最新价」一键填价

**看数**

- 环形图（类别 / 账户 / 币种 / 标的，点扇区即筛选）+ treemap（可下钻、同一标的可合并）
- 每日走势：区间切换、总额或按类别堆叠，悬浮看当日明细
- 持仓明细表：点表头排序、按陈旧度排序；市场可多选（点「加密」会连同代币化股票一起列出）
- **筛选条件写进 URL**：刷新、收藏、分享都能还原同一视图

**行情**

- 默认接免费公开接口，**零配置可用**；一个标的依次尝试多个源，失败自动顺延
- 优先用批量接口省请求；命中限流自动冷却该源并换源，绝不静默失败
- 可填自己的 API Key（加密存储），或用「自定义数据源」接任意 HTTP 行情服务

**记录与追溯**

- **每日快照**：Cron 到点先刷行情、再拍当日净值（见 [行情与汇率](#-行情与汇率)）
- 会话管理：列出每个登录设备的系统 / 浏览器 / IP / 登录时间 / 最近活跃，标出「本设备」，可单独踢出某台设备
- **汇率按日冻结**：快照记住当天汇率，事后改汇率不会让历史曲线整体平移
- 操作历史：所有写操作留档，列表直接显示「改的是谁、改了什么」，展开看字段级 diff
- 备份：导出 JSON（可选含历史、可选口令加密）；导入前全量校验 + **差异预览**，支持合并 / 覆盖

**分享**

- **公开只读链接**（默认关闭）：开启后别人打开链接不用密码就能看「总览」，右上角随时可登录；
  访客看不到账户备注、操作历史、设置与备份，也不能刷新行情。关闭后立即恢复必须登录
- 分享区域可**多选**：开头（总资产、新鲜度）/ 走势 / 分布（环形图与 treemap）/ 持仓明细（数量、成本、盈亏）。
  裁剪在服务端做 —— 不分享明细，数量与成本就不会出现在接口响应里

**其它**

- 多币种：显示币种可切换，**缺汇率时明确标为「未折算」而不是按 1:1 糊弄**；稳定币（USDT/USDC 等）按 1:1 折美元
- 行情失败会写明**哪家数据源、请求的是什么代码、我们把它当成什么去查的**（类别 · 市场 · 覆盖代码），
  连续多次失败会提示多半是代码或配置写错了（例如美股代码记成了港股）
- 保存持仓时校验市场与代码是否自相矛盾（港股 / A 股代码必须是数字），把这类错误拦在录入时
- 中英文双语（英文词典按需加载）+ 可配置时区
- 响应式：窄屏隐藏次要列、单列表单

## 🚀 部署（5 分钟）

**先说清楚哪些不用你管**：建 D1、应用数据库迁移、写入 Secrets、构建与部署，都由脚本或向导自动完成。
必须由人做的只有下面这些（账号、授权、密码这类）。

### 路径 A：一键部署（不碰终端）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)

| # | 手动步骤 | 在哪做 |
|---|---|---|
| 1 | 点上面的按钮 | 本页 |
| 2 | 点 `New GitHub connection`，在 GitHub 授权 Cloudflare Workers | 向导 |
| 3 | 建议勾「Create private Git repository」；项目名填 `asset-manager` | 向导 |
| 4 | 点 **Deploy**，等 1–3 分钟 | 向导 |
| 5 | 把 **Deploy command** 改成 `npm run deploy`（让每次部署自动跑迁移） | Worker → Settings → Build |
| 6 | 加两个 Secret（类型都选 *Secret*）：`SETUP_TOKEN`、`SESSION_SECRET`，各自 `openssl rand -hex 32` | Worker → Settings → Variables and Secrets |
| 7 | 打开 `https://<项目名>.<你的子域>.workers.dev`，粘贴 `SETUP_TOKEN`，设置自己的密码 | 浏览器 |

> `SETUP_TOKEN` **只在向导里填一次、自己记好**：首次打开网页要用它。
> 别沿用示例里的占位值 —— 服务端会拒绝用占位值完成初始化，不会静默部署出一个"用公开口令就能接管"的实例。

D1 会由向导自动创建并把 id 回写进你的仓库（构建日志里能看到形如 `4f191450-…` 的 id）。
只有当日志报找不到 D1 时，才需要手动建库并在 Worker → Settings → Bindings 加一条 D1 绑定（**变量名必须是 `DB`**）。

### 路径 B：命令行（迁移与 Secrets 也一并做完）

```bash
git clone https://github.com/jiangbo202/asset-manager.git
cd asset-manager && npm install

export CLOUDFLARE_API_TOKEN=你的token      # Windows: $env:CLOUDFLARE_API_TOKEN="你的token"
npm run deploy:safe
```

| # | 手动步骤 | 在哪做 |
|---|---|---|
| 1 | 建一个 API Token，权限勾 **Workers 编辑 + D1 编辑** | 控制台 → My Profile → API Tokens |
| 2 | 跑上面三条命令 | 终端 |
| 3 | **抄下终端只打印一次的 `SETUP_TOKEN`** | 终端 |
| 4 | 打开网址 → 粘贴 token → 设密码 | 浏览器 |

`deploy:safe` 依次执行：检查登录 → 创建 / 复用 D1 → 构建 → 应用迁移 → 部署 → 写入 Secrets。

### 构建失败 / 想重测

| 现象 | 处理 |
|---|---|
| 构建日志 `Failed: error occurred while running build command` | 把 Build command 临时改成 `npx vite build` 再 Retry（体检脚本只提示环境问题，不含构建逻辑）；或把上游修复合并进你的仓库 |
| 首页报「数据库需要升级」/ `no such table` | 路径 A 的第 5 步没做 |
| 初始化报 500「未配置密钥」 | 路径 A 的第 6 步没做 |
| 想重测一键部署 | 先删干净：GitHub 仓库、Worker、D1 三样都要删，否则撞重名 |

逐步说明（向导每个字段怎么选）、[验收清单](docs/DEPLOYMENT.md#a5-验收清单重测时照着勾) 与故障排查见
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

**以后上游更新了怎么办？** 一键部署出来的是一份**副本**，上游不会自动流过去：

```bash
npm run update:upstream    # 合并上游（唯一自动处理的冲突是你的 database_id，会保留）
git push                   # Workers Builds 自动重新构建部署
```

详见 [升级](#-升级)。

## ✅ 第一次必做

部署完成后，还需要你在浏览器里做这些：

1. 用 `SETUP_TOKEN` 完成初始化，设置自己的密码
2. 设置里确认**显示币种**（默认 USD）与**时区**（默认 UTC）
3. 要记非 USD 资产，就在「设置 → 汇率」补汇率（点「获取最新汇率」可直接抓）
4. 「账户」建券商 / 加密平台 / 现金账户
5. 「持仓」录入代码、数量、价格、平均成本
6. 「设置 → 数据概览」看一眼 D1 用量，心里有数

## 💻 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

本地数据落在 `.wrangler/state/`，**不消耗任何线上额度**；`npm run dev` 会先自动应用本地迁移。
初始化页的 `SETUP_TOKEN` 填 `.dev.vars` 里的值。完整指南见 **[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)**。

## 🌐 语言与时区

**语言**：设置 → 界面语言，可选「跟随浏览器 / 简体中文 / English」，立即生效并随备份迁移。
服务端提示（校验错误、导入警告、行情失败原因、操作历史备注）也按请求的 `Accept-Language` 返回对应语言。

**时区**：默认 **UTC**，内置 21 个常用 IANA 时区，也可直接填 `Asia/Shanghai`。

| 时区影响 | 说明 |
|---|---|
| 每日快照的「哪一天 / 几点」 | 按该时区的日历日与钟点，改时区后触发时间自动跟着变 |
| 价格 / 数量历史的生效日期 | 手动录入与自动抓取都取「该时区的今天」 |
| 操作历史日期筛选 | 你选 2026-09-20 = 你那个时区的那一天 |
| 界面时间展示 | 按该时区渲染，而不是打开页面那台机器的时区 |

数据库里始终存 UTC，时区只决定「日历怎么解释」，所以换时区不会让历史数据错位。

## 📈 行情与汇率

| 数据源 | 覆盖 | 说明 |
|---|---|---|
| CoinGecko | 加密 | 无 Key，一次查多币；代码用 coin id（如 `bitcoin`），常见币已内置映射 |
| Binance | 加密 | 无 Key，一次查多对；备用 |
| Yahoo Finance | 股票 / 加密 / 汇率 | 覆盖最广：美股、港股 `.HK`、A 股 `.SS/.SZ`、`BTC-USD`、`HKD=X` |
| 腾讯行情 | 港股 / A 股 | 一次查多码（如 `hk00700`）；备用 |
| Frankfurter（欧央行） | 汇率 | 无 Key，工作日更新 |
| open.er-api | 汇率 | 备用，币种更多 |
| 自定义 | 任意 | URL 模板 + JSON 点号路径 + 自定义请求头 |

代码映射规则（可用「行情代码覆盖」逐条改写）：

```
700    + 港股 → Yahoo 0700.HK   / 腾讯 hk00700
600519 + A股  → Yahoo 600519.SS / 腾讯 sh600519
BTC    + 加密 → CoinGecko bitcoin / Binance BTCUSDT / Yahoo BTC-USD
```

### 什么时候会自动抓？

**行情**：每天一次（Cron，在你配置的那个小时），或你点「更新行情」时。

**汇率**不是独立任务，搭在行情刷新上 —— 只在上面两种时机发生，而且只抓组合里出现过的币种。
想立刻拿到某个货币对的当前价，就在「设置 → 汇率」点 **「获取最新汇率」**：
按数据源优先级依次尝试，把结果**填进输入框**，你确认后再点「保存汇率」。
（按钮不直接保存：手工汇率优先级最高且不会被自动覆盖，一点就存会悄悄冻结这个货币对。）

### 快照是怎么拍的

Cron 每小时醒一次，**一次调用只做一件事**：

| 时刻（按你的时区） | 做什么 |
|---|---|
| 正好是配置的小时 | 刷新行情 |
| 之后任意整点，当天还没快照 | 拍当日快照 |

所以快照通常比刷新晚一个整点，用的是当天较早刷到的价格（日级数据，够用）。
哪一步没跑成，当天后续小时会自动补做 —— 免费版每次调用只有 10ms CPU，
把两件事叠在一次调用里会稳定超限，拆开才留得下余量。

## 💾 备份与恢复

三层保险，建议至少用上前两层：

1. **应用内导出**（设置 → 备份与恢复）：JSON，可选包含操作历史、可选口令加密
   （AES-GCM 在浏览器里加密，口令不会发给服务器）。导入前先「预览差异」，支持**合并**与**覆盖**。
2. **命令行全量备份**：

   ```bash
   npx wrangler d1 export DB --remote --output=backup-$(date +%F).sql
   # 恢复：npx wrangler d1 execute DB --remote --file=backup-2026-09-20.sql
   ```

3. **Cloudflare Time Travel**（免费 7 天）：Dashboard → D1 → Time Travel 可回滚到任意时间点。

> 备份文件是你的全部资产数据，请当密码一样保管。
>
> 备份**不含任何凭据**：没有登录密码、没有会话，也没有第三方 API Key 与自定义数据源的请求头；
> 换环境后重新初始化并填一次 Key 即可。

## 🔐 数据与隐私

- 所有数据在你自己的 Cloudflare D1 里，本应用**没有后端服务器**，也不上传任何数据
- 不含 Analytics、不含遥测、不含第三方字体 / CDN
- 密码只存不可逆校验值，数据库泄露也无法直接登录（见 [SECURITY.md](SECURITY.md)）
- 第三方 API Key 用 `SESSION_SECRET` 派生密钥加密后入库，接口从不回传明文

## 💰 免费额度够用吗

够用。个人典型用量与实测值：

| 资源 | 实际用量 | 免费额度 |
|---|---|---|
| Workers 请求 | < 1,000 / 天 | 100,000 / 天 |
| Workers CPU | 页面读取 1–4 ms；行情刷新 ≈ 8 ms；拍快照 ≈ 5 ms | 10 ms / 请求 |
| D1 行读 | < 50,000 / 天 | 5,000,000 / 天 |
| D1 行写 | < 100 / 天 | 100,000 / 天 |
| D1 存储 | < 20 MB | 5 GB |
| Cron | 1 个触发器（每小时，只在配置小时干活） | 5 个 / 账号 |
| Subrequests | 每天 1 次批量抓取，实测 5–10 次 | 50 次 / 调用 |
| 静态资源 | 首包 93 KB gzip + 按需分包 | 免费 |

CPU 数字来自 `npm run watch:cpu`（实时读线上 `wrangler tail` 的 `cpuTime`）。
免费版每次调用只有 10ms，所以架构是围着这个限制设计的：

- 认证的 PBKDF2 放在**浏览器**，Worker 只做一次 SHA-256
- 聚合在 SQL 里做，不在 JS 里遍历行；走势点服务端降采样
- 每个接口尽量**一次 batch 读完**（实测：一条 D1 语句约 0.3ms 本地 / 2ms 线上 CPU，
  而 `db.batch` 内的多条语句只算一次往返）
- 行情刷新与快照**拆成两次调用**，不让它们叠在同一次里
- `tests/api/query-budget.test.ts` 把每条路由的语句数与往返次数固定成上限，加回一次串行查询 CI 就会失败

「设置 → 数据概览」可随时查看实际行数。

### 用超了会怎样？会不会产生账单？

**免费版不会产生账单。** Workers Free 没有任何"超额计费"口径 —— 用超了就是**报错**，不扣钱：

| 超了什么 | 你会看到 | 何时恢复 |
|---|---|---|
| Workers 请求 > 100,000/天 | Cloudflare 的错误页（`Error 1027`：「站点暂时不可用，所有者已达套餐上限」） | UTC 零点自动恢复 |
| D1 行读 / 行写 超限 | 需要读库的接口返回 503，并提示「今天的免费额度用完了，UTC 零点恢复，数据没有丢」 | UTC 零点自动恢复 |
| D1 存储 > 5 GB | 无法写入 / 建表，需要先清理 | 手动清理后立即恢复 |

**唯一的计费路径是你主动升级到 Workers Paid**（$5/月起：每月 1000 万请求，D1 转为按量计费）。
不升级就不会有账单。

两个值得知道的事实：

- **页面本身不算额度**：HTML / JS / CSS / 图标属于**静态资源**，Cloudflare 的口径是"静态资源请求免费且无限"，
  只有 `/api/*` 会真正调用 Worker 并计数。所以「打开一次总览」大约消耗 3 次请求
  （portfolio / history / accounts），100,000/天 ≈ **3 万次总览访问** —— 个人使用碰不到。
- **数据不会丢**：D1 超限只是让查询失败，已存的数据不受影响；恢复后一切照旧。

真遇到了怎么办：① 等 UTC 零点自动恢复；② 控制台 Workers & Pages → 你的 Worker → **Metrics**、
以及 **D1 → Metrics** 看用量曲线；③ 应用内「设置 → 数据概览」看各表行数；
④ D1 达到每日上限时 Cloudflare 还会**发邮件提醒**。用「公开只读分享」时要留意：
访客每刷新一次都会消耗请求数。

## ❓ FAQ

**忘记密码怎么办？**
Dashboard → Workers & Pages → D1 → `asset-manager-db` → Console 执行 `DELETE FROM auth;`，
然后 `npm run setup:secrets -- --rotate` 拿到新的 `SETUP_TOKEN`，刷新网页重新初始化。账户与持仓不受影响。

> `setup:secrets` 默认幂等（不覆盖已存在的 Secret），因为 `SESSION_SECRET` 用来加密库里的 API Key；
> 轮换它会让所有登录失效、已保存的 Key 需要重填，所以必须显式加 `-- --rotate`。

**忘记 `SETUP_TOKEN` 了？**
同上：删掉 `auth` 行，再 `npm run setup:secrets -- --rotate`。token 只在生成时打印一次。

**升级后提示「数据库需要升级」？**
结构落后于代码。按页面提示跑 `npm run db:migrate:local`（本地）或 `npm run db:migrate:remote`（线上，或直接重跑 `npm run deploy:safe`）。迁移是幂等的，不会动已有数据。

**部署时报 `Authentication error [code: 10000]`**
Token 权限不足或未设置。确认含 **Workers 编辑 + D1 编辑**，或改用 `npx wrangler login`。

**怎么确认定时任务真的跑了？**
操作历史里会有来源为 `system` 的记录：「刷新行情：…」是到点刷的行情，「定时快照（…）」「补拍当日快照（…）」是拍的快照。
设置页的「行情与快照」卡片也会显示**上次行情刷新**与**下次定时运行**的时间。

**fork 之后用 Sync fork 是不是就一直是新的了？**
不一定。Sync fork 只能在你的分支**没有自己的提交**时快进。一键部署会把真实的 `database_id`
写进仓库并提交，分支就分叉了 —— 这时按钮要么不可用，要么提示丢弃提交（会把你的 id 冲掉）。
稳妥做法还是 `npm run update:upstream`（自动保留你的 id），详见 [升级](#-升级)。

**访问量超出免费额度会扣钱吗？**
不会。免费版用超了是**报错**（Workers 请求超限返回 `Error 1027`；D1 超限接口返回 503 并说明
"UTC 零点恢复、数据没丢"），不会产生任何账单 —— 只有你主动升级到 Workers Paid 才可能被计费。
详见 [免费额度够用吗](#-免费额度够用吗)。

**`git merge upstream/main` 报 `refusing to merge unrelated histories`？**
这是正常现象：一键部署出来的是「模板复制」，与上游没有共同祖先。加 `--allow-unrelated-histories`
做一次对齐即可（记得把 `database_id` 写回你自己的），之后更新就是普通合并。命令见 [升级](#-升级)。

**一键部署之后，更新一定要用终端吗？**
跟进上游更新目前需要一次终端命令（本质是 git 合并）。如果你不想碰终端，可以让仓库保持"没有本地提交"
（即 `database_id` 手工维护），这样 fork 的 Sync fork 按钮可用 —— 但多数人会觉得比跑一次命令更麻烦。
部署本身完全不需要终端。详见 [部署指南 §6](docs/DEPLOYMENT.md#6-从上游更新)。

**点了 Deploy to Cloudflare 按钮，接下来呢？**
向导只做三件事：授权 GitHub、填项目名、点 Deploy（把仓库复制到你的账号并建好构建项目）。
之后还要补：D1 绑定、跑一次迁移、加两个密钥 —— 逐步说明见
[部署指南 · 路径 A](docs/DEPLOYMENT.md#路径-a一键部署按钮推荐给非开发者)。

**怎么分享给别人看？**
设置 → 「公开只读分享」打开开关，把显示的链接发出去即可。访客只能看总览（总资产、分布、treemap、走势、持仓明细），
页面会标「只读分享」并给出登录入口 —— 想改数据的自己登录。开关随时可关，关掉后链接只会显示登录页。

**价格为什么没更新？**
行情每天自动更新一次，时间在「设置 → 行情与快照」里配（默认 22 点，按你的时区）。
想立刻更新就点「更新行情」或「立即刷新行情」。

**港股 / A 股代码怎么填？**
港股填 `700`、`0700`、`3121`、`03121` 都可以，带不带 `.HK` 后缀也都行 —— 保存时会**统一成港交所的 5 位**
（`00700`、`03121`），界面上看到的和券商对账单一致。
请求数据源时再自动转成对方要的格式：Yahoo 用 4 位的 `3121.HK`，腾讯用 5 位的 `hk03121`。

**控制台里「beacon.min.js 被 CSP 拦截」是什么？**
那是 Cloudflare 自己注入的 Web Analytics（`static.cloudflareinsights.com`），我们的 CSP 只允许
`script-src 'self'`，所以它被拦住了 —— 这正是预期行为（本项目不带任何第三方脚本）。
如果不想看到这条提示，去 Cloudflare 控制台关掉该站点的 Web Analytics 即可。

**提示「限流冷却」是什么？**
免费接口对同一 IP 有频率限制。命中后该源暂停 10 分钟（连续失败 30 分钟），期间自动换源。
冷却状态与上次错误都能在设置页看到；想彻底避开可填自己的 API Key 或用自定义数据源。

**走势图为什么有几天是平的？**
那天没有快照（例如部署晚了、Worker 没被触发），系统沿用前一日并标注「沿用前一日」；
快照漏跑当天会自动补做，也可以手动补一条。

**能接自己的行情服务吗？**
可以。设置 → 行情与快照 → 自定义数据源，填 URL 模板（`{symbol}` 占位代码、`{key}` 占位密钥）
与 JSON 价格路径（如 `data.price`）。

**能多人一起用吗？**
不能，也不打算做。单用户单密码，数据在你自己账号里。

## 🔄 升级

先导出一份备份（设置 → 备份）。升级一般不动数据（迁移只改表结构），但备份不亏。

**你自己的仓库就是从本仓库克隆的**（直接 `git remote -v` 看得到上游）：

```bash
git pull
npm install
npm run deploy:safe      # 自动应用新的 D1 迁移
```

**你是点「Deploy to Cloudflare」按钮部署的** —— 那次是把仓库**复制**一份给你，
上游后续的修复与功能不会自动流过去，需要显式合并：

```bash
npm run update:upstream   # 地址自动取自 package.json 的 repository
# 或指定：npm run update:upstream -- https://github.com/<上游作者>/asset-manager.git
git push                  # Workers Builds 会自动重新构建部署
```

> **如果报 `fatal: refusing to merge unrelated histories`**：说明你那份是「模板复制」（新仓库 + 初始提交），
> 与上游**没有共同祖先** —— 一键部署就是这样，不是 fork。先做一次**一次性对齐**，之后就正常了：
>
> ```bash
> git merge --allow-unrelated-histories -X theirs upstream/main   # 新旧代码重叠的文件以上游为准
> # 上面会把 database_id 改成上游的占位值，写回你自己的（控制台里那个 UUID）
> git add -A && git commit -m "chore: 写回自己的 database_id"
> git push
> ```
>
> 对齐后 `git merge-base HEAD upstream/main` 有输出，以后 `npm run update:upstream` 就是普通合并了
> （它会自动保住你的 `database_id`）。**改过代码的人别用 `-X theirs`**，改用
> `git merge --allow-unrelated-histories upstream/main` 后逐个看冲突。

> **如果报 `Missing script: "update:upstream"`**：说明你那份副本是在这个命令加进来之前复制的，
> 得先手动合并一次（之后就能用命令了）：
>
> ```bash
> git remote add upstream https://github.com/jiangbo202/asset-manager.git   # 已有则跳过
> git fetch upstream
> git merge upstream/main        # 冲突时保留你 wrangler.jsonc 里的 database_id
> git push
> ```

这条命令会：检查工作区干净 → 加 `upstream` remote → 拉取 → **先列出将要合并的提交** →
合并。中途只会在一种情况下冲突：`wrangler.jsonc` 里的 `database_id`（你填了真实 id，上游是占位值），
这时**自动保留你的**，不会把 id 冲掉。其它冲突会原样停下并告诉你怎么处理。

> **关于 fork 的 Sync fork 按钮**：只有当你的副本**没有自己的提交**时它才能一键更新。
> 一键部署会把真实的 `database_id` 写进仓库并提交，于是分支与上游"分叉"了 ——
> 这时 GitHub 要么不给点，要么提示"丢弃提交"（那会把你的 id 冲掉）。
> 所以大多数情况下还是走上面 `update:upstream` 这条（它会保留你的 id）；
> 如果你确实用了 Sync fork，更新完请确认 `wrangler.jsonc` 里的 `database_id` 还是你自己的，
> 不是 `REPLACE_WITH_YOUR_D1_ID`。

**升级后页面提示「数据库需要升级」** = 迁移没跑：把 Worker → Settings → Build 的 Deploy command
设成 `npm run deploy`（每次部署自动迁移），或本地跑一次 `npm run db:migrate:remote`。

## 🛠 开发与贡献

```bash
npm run dev        # 开发服务器（workerd + HMR，Worker 调试端口 9229）
npm run build      # 构建前端与 Worker
npm run preview    # 用构建产物本地跑，接近线上
npm test           # Vitest，跑在真实 workerd 里
npm run lint       # 四套 tsconfig 的类型检查
npm run verify     # 以上全跑 + 首包体积 + 脚本接线检查
npm run watch:cpu  # 实时看线上每次调用的 CPU 时间（免费额度排障用）

npm run deploy:safe      # 部署（建库 → 构建 → 迁移 → 部署 → 写 Secrets）
npm run update:upstream  # 把这台部署跟上游模板对齐（一键部署出来的副本用）
```

技术栈刻意保持精简：**Hono + D1 + React**，没有 UI 库、没有图表库、没有状态管理库。
图表（环形图 / treemap / 走势图）全部手写 SVG 与 CSS。

```
src/worker/     Worker：api 路由 / core 基础设施 / data 仓储层 / services 业务编排
src/web/        前端：lib（api、i18n、图表…）/ pages / components
src/shared/     前后端共用：类型、枚举标签、i18n 字典、时区工具
migrations/     D1 迁移（追加式，不修改已上线的文件）
scripts/        部署与本地开发脚本
tests/          Vitest（跑在 workerd 运行时，不是 jsdom 模拟）
```

改代码前请读 **[CONTRIBUTING.md](CONTRIBUTING.md)**（约定、测试要求、文档索引）。

## 🗺 路线图

- **CSV 导入**：导入券商对账单，支持列映射与重复检测
- **交易日历感知**：非交易日沿用收盘价，避免曲线出现无意义台阶
- **更多币种的自动汇率**：目前 ECB 覆盖面有限
- **交易流水账本**：FIFO 成本、分红、拆股、定投
- **TOTP 二次验证**、自定义图标上传、多用户 / 家庭共享

## 📚 文档

| 文档 | 内容 |
|---|---|
| [README.en.md](README.en.md) | English README（内容与本文对应） |
| [docs/PRD.md](docs/PRD.md) | 需求与已确认决策、验收标准 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、数据模型、免费额度护栏、关键取舍 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署脚本、三条路径、故障排查 |
| [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) | 本地开发、调试、D1 操作 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 迁移、备份恢复、升级、定时任务、排障 |
| [SECURITY.md](SECURITY.md) | 安全模型与漏洞上报 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |

## 📄 License

[MIT](LICENSE)。个人记账工具，**不提供投资建议**；请自行确认所在地区对加密资产记录的合规要求。
