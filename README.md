# 资产管理 · asset-manager

**简体中文** | [English](README.en.md)

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![首包 93 KB gzip](https://img.shields.io/badge/%E9%A6%96%E5%8C%85-93%20KB%20gzip-blue)](#-免费额度够用吗)

**散落在各家券商与平台的钱，一处看清。** 股票、ETF、加密货币、现金都收进同一个页面；
一键更新行情，总资产与浮动盈亏立刻算好 —— 不必再挨个登录各家 App 对账。

单用户、密码登录、数据只存在你自己的 Cloudflare 账号里；跑在免费额度内，零月费。
想改就 fork，没有遥测、没有第三方 CDN、没有 UI 库。

## 📸 界面预览

### 总览 · 关键指标与净值走势

![总览](docs/pic/account_total.png)

### 总览 · 分布图与持仓明细

![分布与明细](docs/pic/have.png)

### 持仓 · 录入与批量改价

![持仓](docs/pic/position.png)

### 账户 · 内置平台图标

![账户](docs/pic/add_account.png)

## ✨ 它做了什么

**记账**

- 账户（券商 / 加密平台 / 现金，可标市场、币种、备注、归档）+ 持仓（股票 / ETF / 加密 / 基金 / 现金）
- 平均成本法算盈亏；支持归档、批量改价、同一标的分散在多个账户
- 填完代码自动查名称 / 币种 / 市场，一键取最新价

**看清**

- 环形图（类别 / 账户 / 币种 / 标的，点扇区即筛选）+ treemap（可下钻、同一标的可合并）
- 每日走势（区间切换、总额或按类别堆叠）+ 持仓明细表（点表头排序、按陈旧度排序）
- 筛选条件写进 URL：刷新、收藏、分享都能还原同一视图

**行情**

- 默认接免费公开接口，**零配置可用**；一个标的依次尝试多个源，失败自动顺延并写明原因
- 优先批量接口，命中限流自动冷却换源；可填自己的 API Key（加密存储）或接自定义数据源
- 缺汇率时明确标为「未折算」而不是按 1:1 糊弄；稳定币（USDT/USDC 等）按 1:1 折美元

**留痕与自动化**

- 操作历史：所有写操作留档，列表直接显示「改的是谁、改了什么」，展开看字段级 diff
- 每日快照由 Cron 完成：到点先刷行情、再拍当日净值；汇率按日冻结，事后改汇率不会平移历史曲线
- 备份：导出 JSON（可选含历史、可选口令加密）；导入前全量校验 + 差异预览
- 会话管理：列出每个登录设备的系统 / 浏览器 / IP / 最近活跃，标出「本设备」，可单独踢出
- Cloudflare 用量：设置页最底部显示今天的请求数与 D1 行读 / 行写，对着免费额度给出 x/y

**其它**

- 公开只读链接（默认关闭）：开启后可分享总览，并可**按区域多选**（开头 / 走势 / 分布 / 持仓明细），
  裁剪在服务端做 —— 不分享明细，数量与成本就不会出现在接口响应里
- 中英文双语 + 可配置时区（默认 UTC）；响应式，窄屏隐藏次要列

## 🚀 部署（5 分钟）

**先说清楚哪些不用你管**：建 D1、应用数据库迁移、写入 Secrets、构建与部署，都由脚本或向导自动完成。
必须由人做的只有下面这些（账号、授权、密码这类）。

### 路径 A：一键部署（不碰终端）

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)

| # | 手动步骤 | 在哪做 |
|---|---|---|
| 1 | 点上面的按钮 | 本页 |
| 2 | 点 `New GitHub connection`，在 GitHub 授权 Cloudflare Workers | 向导 |
| 3 | 建议勾「Create private Git repository」；项目名填 `asset-manager` | 向导 |
| 4 | 点 **Deploy**，等 1–3 分钟 | 向导 |
| 5 | 把 **Deploy command** 改成 `npm run deploy`（让每次部署自动跑迁移） | Worker → Settings → Build |
| 6 | 加两个 Secret（类型选 *Secret*）：`SETUP_TOKEN`、`SESSION_SECRET`，各自 `openssl rand -hex 32` | Worker → Settings → Variables and Secrets |
| 7 | 打开 `https://<项目名>.<你的子域>.workers.dev`，粘贴 `SETUP_TOKEN`，设置自己的密码 | 浏览器 |

> `SETUP_TOKEN` 只显示一次，**自己记好**。别用示例里的占位值：服务端会拒绝用占位值完成初始化。

D1 由向导自动创建并把 id 回写进你的仓库（构建日志里能看到形如 `4f191450-…` 的 id）。
只有当日志报找不到 D1 时，才需要手动建库并在 Worker → Settings → Bindings 加绑定（**变量名必须是 `DB`**）。

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

**以后上游更新了怎么办？** 一键部署出来的是一份**副本**，上游不会自动流过去：

```bash
npm run update:upstream    # 合并上游（唯一自动处理的冲突是你的 database_id，会保留）
git push                   # Workers Builds 自动重新构建部署
```

### 构建失败 / 报错对照

| 现象 | 处理 |
|---|---|
| 构建日志 `Failed: error occurred while running build command` | 把 Build command 改成 `npx vite build` 再 Retry（体检脚本只提示环境问题）；或合并上游修复 |
| 首页报「数据库需要升级」/ `no such table` | 路径 A 的第 5 步没做 |
| 初始化报 500「未配置密钥」 | 路径 A 的第 6 步没做 |
| `Missing script: "update:upstream"` | 副本早于该命令：先手动 `git remote add upstream … && git merge upstream/main` 一次 |
| `refusing to merge unrelated histories` | 一键部署是「模板复制」：加 `--allow-unrelated-histories` 对齐一次（见[升级](#-升级)）|
| 想重测一键部署 | 先删干净：GitHub 仓库、Worker、D1 三样 |

向导每个字段怎么选、[验收清单](docs/DEPLOYMENT.md#a5-验收清单重测时照着勾) 与完整排查见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## ✅ 第一次必做

1. 用 `SETUP_TOKEN` 完成初始化，设置自己的密码
2. 设置里确认**显示币种**（默认 USD）与**时区**（默认 UTC）
3. 要记非 USD 资产，就在「设置 → 汇率」补汇率（点「获取最新汇率」可直接抓）
4. 「账户」建券商 / 加密平台 / 现金账户，「持仓」录入代码、数量、价格、平均成本
5. 「设置 → 数据概览」看一眼行数，心里有数

## 💰 免费额度够用吗

够用。个人典型用量与实测值：

| 资源 | 实际用量 | 免费额度 |
|---|---|---|
| Workers 请求 | < 1,000 / 天 | 100,000 / 天 |
| Workers CPU | 页面读取 1–4 ms；行情刷新 ≈ 8 ms；拍快照 ≈ 5 ms | 10 ms / 请求 |
| D1 行读 / 行写 | < 50,000 / < 100 每天 | 5,000,000 / 100,000 每天 |
| D1 存储 | < 20 MB | 单库 500 MB（账号共 5 GB）|
| 静态资源 | 首包 93 KB gzip + 按需分包 | **免费且不限量** |

架构就是围着 10ms CPU 设计的：认证的 PBKDF2 放在**浏览器**、聚合在 SQL 里做、每个接口尽量
**一次 batch 读完**、行情刷新与快照拆成两次调用。`tests/api/query-budget.test.ts` 把每条路由的
语句数与往返次数固定成上限，加回一次串行查询 CI 就会失败。

**用超了会怎样？不会产生账单。** 免费版没有超额计费口径，超了是**报错**（唯一的计费入口是主动升级
Workers Paid，$5/月起）：

| 超了什么 | 你会看到 | 恢复 |
|---|---|---|
| Workers 请求 > 100,000/天 | Cloudflare 错误页 `Error 1027` | UTC 零点自动 |
| D1 行读 / 行写 | 接口返回 503 并提示「今天的免费额度用完了，UTC 零点恢复，数据没有丢」 | UTC 零点自动 |
| D1 存储 > 500 MB | 无法写入，需先清理 | 清理后立即 |

**页面本身不计额度**：HTML / JS / CSS 属于静态资源，只有 `/api/*` 调用 Worker 并计数 ——
打开一次总览约 3 次请求，100,000/天 ≈ 3 万次访问。D1 触及每日上限时 Cloudflare 还会发邮件提醒；
已存数据不受影响。

### 想看实际用量？（可选）

设置页最底部 → 「Cloudflare 用量」：填一个**只读** Token 就能看到今天的真实数字与进度条
（≥70% 黄、≥90% 红）。

| 字段 | 填什么 |
|---|---|
| API Token | 控制台 → **My Profile → API Tokens → Create Token → Custom token**，权限只勾两项只读：**Account Analytics: Read**、**D1: Read** |
| 账号 ID | 控制台 **Workers & Pages** 右侧栏的 Account ID（或地址栏 `dash.cloudflare.com/<这一串>/…`）|
| Worker 名称 | 默认 `asset-manager`（写错该项显示「未取到」）|
| D1 数据库名 | 默认 `asset-manager-db` |

Token 只读、加密存在你自己的 D1 里、接口永不回传（审计里也只留 `(set)`）；不填这张卡就显示
「未配置」，其它功能完全不受影响。数字缓存在本地，点「刷新用量」才去 Cloudflare 取。

<details>
<summary>先在终端验一遍 Token 权限（可选，省一轮来回）</summary>

```bash
export CF_TOKEN='你的 token' CF_ACCOUNT='你的 Account ID'
# ① token 是否有效
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | head -c 200
# ② 有 D1: Read 吗（返回库列表即通过）
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/d1/database" | head -c 300
```

常见现象：整卡报「Token 无效或权限不足」= 权限没勾全；某行显示「未取到」= Worker 名称或库名对不上
（账号下有多个库时不会去猜）；只有库大小「未取到」= Token 少了 `D1: Read`。

</details>

## 🔐 数据与隐私

- 不含分析脚本、不含遥测，不加载任何第三方字体或 CDN
- 除你主动启用的行情接口外，Worker 不会向外界发起请求；数据只存在你自己的 Cloudflare 账号里
- 密码用 PBKDF2（30 万次）在**浏览器**派生，库里只有不可逆 verifier；行情 Key 与用量 Token 均加密存储
- 详见 [SECURITY.md](SECURITY.md)

## ❓ FAQ

**一键部署之后要做什么？**
向导只做授权 + 建仓库 + 部署。之后补三件事：D1 绑定（通常已自动完成）、跑一次迁移、
加两个 Secret —— 见上表与 [部署指南](docs/DEPLOYMENT.md#a2-部署后必须补的三件事)。

**更新上游一定要用终端吗？**
目前是（本质是一次 git 合并）：`npm run update:upstream && git push`。部署本身不需要终端。
报 `refusing to merge unrelated histories` 说明你那份是「模板复制」（与上游无共同祖先），
先做一次对齐；报 `Missing script` 说明副本早于该命令，先手动合并一次。见[升级](#-升级)。

**怎么确认定时任务真的跑了？**
操作历史里来源为 `system` 的记录：「刷新行情：…」是到点刷的，「定时快照（…）」「补拍当日快照（…）」是拍的。
设置页的「行情与快照」卡片也会显示上次刷新与下次运行时间。

**怎么分享给别人看？**
设置 → 「公开只读分享」打开开关，把链接发出去。访客只能看总览，按你勾选的区域显示，
看不到账户备注、操作历史、设置与备份，也不能刷新行情；关闭后立即恢复必须登录。

**价格为什么没更新？**
看「操作历史」里那次失败的原因：会写明哪家数据源、请求的是什么代码、我们把它当成什么去查的。
连续失败多半是代码或配置写错（例如美股代码记成了港股）。

**港股 / A 股代码怎么填？**
填 4 位或 5 位都行（`700` / `0700` / `3121.HK`），保存时统一成港交所 5 位 `00700` / `03121`；
请求数据源时再转成对方格式。

**控制台报 `beacon.min.js` 被 CSP 拦截？**
那是 Cloudflare 自己注入的 Web Analytics，CSP 只允许 `'self'` 所以被挡，属预期行为。

## 🔄 升级

先导出备份（设置 → 备份）。升级一般不动数据，但备份不亏。

**本仓库克隆出来的**：`git pull && npm install && npm run deploy:safe`

**一键部署出来的副本**（上游不会自动流过去）：

```bash
npm run update:upstream && git push
```

> 报 `refusing to merge unrelated histories`（模板复制，与上游无共同祖先）：
>
> ```bash
> git merge --allow-unrelated-histories -X theirs upstream/main
> # 会把 database_id 改成占位值 → 写回你自己的再提交
> git add -A && git commit -m "restore my database_id" && git push
> ```
>
> 改过代码的人别用 `-X theirs`，去掉它逐个看冲突。之后 `update:upstream` 会自动保住你的 id。

升级后若首页报「数据库需要升级」= 迁移没跑：把 Builds 的 Deploy command 设成 `npm run deploy`，
或本地跑一次 `npm run db:migrate:remote`。完整说明见 [docs/DEPLOYMENT.md §6](docs/DEPLOYMENT.md#6-从上游更新)。

## 💻 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

本地数据落在 `.wrangler/state/`，**不消耗任何线上额度**。初始化页的 `SETUP_TOKEN` 填 `.dev.vars` 里的值。
完整指南见 [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)。

## 🛠 开发与贡献

```bash
npm run dev        # 开发服务器（workerd + HMR）
npm run lint       # 四套 tsconfig 的类型检查
npm test           # Vitest，跑在真实 workerd 里
npm run verify     # 以上全跑 + 首包体积 + 脚本接线检查
npm run watch:cpu  # 实时看线上每次调用的 CPU 时间（免费额度排障用）

npm run deploy:safe      # 部署（建库 → 构建 → 迁移 → 部署 → 写 Secrets）
npm run update:upstream  # 把这台部署跟上游模板对齐（一键部署出来的副本用）
```

技术栈刻意保持精简：**Hono + D1 + React**，没有 UI 库、没有图表库、没有状态管理库 ——
环形图 / treemap / 走势图全部手写 SVG。

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

- CSV 导入券商对账单、交易日历感知、更多币种自动汇率
- 目标：免费额度内跑得下、代码读得懂、fork 出去能改成自己的

## 📚 文档

| 文档 | 什么时候看 |
|---|---|
| [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) | 本地开发、调试、种子数据 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署、向导字段、故障排查 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 迁移、备份恢复、限额监控、定时任务 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 目录结构、数据模型、CPU 预算、关键实现 |
| [docs/PRD.md](docs/PRD.md) | 需求编号（FR-x.x）与设计取舍 |
| [SECURITY.md](SECURITY.md) | 威胁模型、认证设计、公开分享的边界 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 约定、测试要求、文档同步 |

## 📄 License

MIT，见 [LICENSE](LICENSE)。
