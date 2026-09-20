# Asset Manager · 个人资产管理

把股票、加密货币、现金放在一处记录和查看的个人记账工具。**纯 Cloudflare 部署**（Workers + D1 + 静态资源），
数据只存在你自己的账号里，不含任何遥测与第三方统计。

> 状态：**v0.9 — 功能已按 PRD v1 完成**（尚未在真实 Cloudflare 账号部署验证）。
> 已实现：初始化/登录/改密码、账户（52 个内置平台图标、归档）、持仓（批量改价、归档）、
> 组合视图（环形图四维度 + 点击下钻筛选、treemap 下钻、明细表可排序）、
> 操作历史（字段级 diff + 类型/日期筛选）、设置（显示币种 / 汇率 / 数据概览）、
> 备份导出与导入（差异预览 + 可选口令加密）。
> 未实现（见 [路线图](#路线图)）：外部行情、每日走势图。

---

## 🚀 5 分钟上手

```bash
git clone <你的仓库地址> asset-manager
cd asset-manager && npm install

export CLOUDFLARE_API_TOKEN=你的token      # Windows: $env:CLOUDFLARE_API_TOKEN="你的token"
npm run deploy:safe
```

部署脚本会：创建/复用 D1 → 构建 → 应用迁移 → 部署 → 生成 `SETUP_TOKEN` 并**在终端打印一次**。

然后：

1. 打开终端打印的网址
2. 粘贴 `SETUP_TOKEN`
3. 设置你自己的登录密码 → 开始记录

> `CLOUDFLARE_API_TOKEN` 需要 **Workers 编辑 + D1 编辑** 权限。

## 📦 部署（两种方式）

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/你的用户名/asset-manager)

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
```

## 💻 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

本地数据落在 `.wrangler/state/`，**不消耗任何线上额度**。首次进入初始化页时，`SETUP_TOKEN` 填 `.dev.vars` 里的值。
完整指南（调试、断点、D1 操作、常见问题）：**[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)**

## ✅ 第一次必做

1. 用 `SETUP_TOKEN` 完成初始化，设置自己的密码
2. 「设置」里确认显示币种（默认 USD）
3. 若要记非 USD 资产，在「设置 → 汇率」补上汇率（如 `1 USD = 7.8 HKD`）
4. 「账户」里建券商 / 加密平台 / 现金账户
5. 「持仓」里录入数量、价格、平均成本（v1 全部手动录入）
6. 到「设置 → 数据概览」看一眼 D1 用量，心里有数

## 🧩 功能一览

**已实现**

- 初始化流程：部署生成一次性 setup token → 设置密码（可一键生成随机强密码）
- 认证：PBKDF2 在**浏览器端**派生（30 万次迭代），Worker 只做一次 SHA-256；登录失败 5 次锁定 15 分钟；会话可全部吊销
- 账户：券商 / 加密平台 / 现金，支持市场、币种、备注、**52 个内置平台图标选择器**（字母标 + 品牌色，无商标风险；未选中时用名称首字母自动配色）
- 持仓：股票 / ETF / 加密 / 基金 / 现金，手动数量与价格，平均成本法算盈亏，支持归档与批量改价
- 批量更新价格（一屏改完一次提交）
- 组合视图：总资产、成本合计、浮动盈亏、价格新鲜度、环形图（类别/账户/币种/标的四个维度，**点击扇区即筛选**）、treemap（**可下钻到单个账户**）、明细表
- 筛选条件写入 URL：刷新、收藏、分享链接都能还原同一个视图
- 价格陈旧提醒：超过 7 天未更新的持仓会在总览顶部列出，並在明细表中标黄
- 多币种：显示币种可切换（内置 USD/HKD/CNY，可自行添加），汇率手动维护；缺汇率时**明确标为“未折算”而不是按 1:1 糊弄**
- 操作历史：所有写操作自动留档，可展开看字段级 diff，支持类型/操作/日期区间筛选
- 响应式：窄屏隐藏次要列、导航横向滚动、单列表单
- 备份：导出 JSON（可选包含操作历史、可选口令加密）；导入前先做**全量校验 + 差异预览**，支持合并/覆盖两种模式
- 免费额度护栏：仪表盘只有一个聚合接口，价格历史只写不读，无 Cron

**路线图**

- v0.10：外部行情自动更新（可在设置里开关）、自动汇率
- v0.11：每日走势图（`price_history` / `qty_history` 已从第一天开始记录，届时直接有数据）
- 更远：交易流水账本、FIFO / 分红 / 拆股、TOTP、多用户

## 🔐 数据与隐私

- 所有数据在你自己的 Cloudflare D1 里，本应用**没有后端服务器**，也不上传任何数据
- 不含 Analytics、不含遥测、不含第三方字体/CDN
- 密码只以不可逆校验值存储；数据库泄露也无法直接登录
- 备份文件包含全部资产数据，下载后请当密码一样保管

## 💰 会超免费额度吗

不会。典型的个人用量大约是这样（免费版限额见括号）：

| 资源 | 典型用量 | 免费额度 |
|---|---|---|
| Workers 请求 | < 1,000 / 天 | 100,000 / 天 |
| Workers CPU | 首页聚合 ≈ 1–3 ms | 10 ms / 请求 |
| D1 行读 | < 50,000 / 天 | 5,000,000 / 天 |
| D1 行写 | < 100 / 天 | 100,000 / 天 |
| D1 存储 | < 10 MB | 5 GB |
| 静态资源 | 约 90 KB gzip（前端整包） | 免费 |
| Cron | 未使用 | 5 个 / 账号 |

「设置 → 数据概览」可以随时看到自己的实际行数。

## 💾 备份与恢复

三层保险，建议至少用上前两层：

**1. 应用内导出（推荐日常用）**
设置 → 备份与恢复 → 导出 JSON。可选：包含操作历史、用口令加密（AES-GCM，在浏览器里加密，口令不会发给服务器）。
导入时先点「预览差异」，看清楚会新增/覆盖/删除多少条，再确认；支持**合并**（按 id 覆盖）与**覆盖**（先清空业务数据）两种模式。

**2. 命令行全量备份（数据库级）**

```bash
npx wrangler d1 export DB --remote --output=backup-$(date +%F).sql
```

恢复：`npx wrangler d1 execute DB --remote --file=backup-2026-09-20.sql`

**3. Cloudflare Time Travel（免费 7 天，兵不血刃的兼底）**

Dashboard → Workers & Pages → D1 → 选库 → Time Travel，可以回滚到过去 7 天内的任意时间点。
误操作（比如覆盖导入选错了）先在 Time Travel 里恢复，比重新初始化快得多。

> 注意：备份文件里是你的全部资产数据，请当密码一样保管。

## ❓ FAQ

**忘记密码怎么办？**
在 Cloudflare Dashboard → Workers & Pages → D1 → `asset-manager-db` → Console 执行：

```sql
DELETE FROM auth;
```

然后本地重跑 `npm run setup:secrets`（或重新部署）拿到新的 `SETUP_TOKEN`，刷新网页重新初始化。
数据（账户/持仓）不受影响。

**忘记 `SETUP_TOKEN` 了？**
同上：删掉 `auth` 行 + 重新生成 token。注意 token 只在生成时打印一次。

**部署时报 `Authentication error [code: 10000]`**
API Token 权限不足或没设置。确认 Token 含 **Workers 编辑 + D1 编辑**，或改用 `npx wrangler login`。

**为什么没有行情 / 走势图？**
v1 有意不做（见 [docs/PRD.md](docs/PRD.md) 的 D3 决策），设置里的「外部行情」开关是占位，点了会提示下个版本支持。

**改了汇率，为什么所有数字都变了？**
v1 只维护"当前汇率"，没有按日冻结，所以历史数值会跟着变。这是已知限制，修正在路线图里。

**能多人一起用吗？**
不能，也不打算做。单用户单密码，数据在你自己账号里。

## 🔄 升级

```bash
git pull
npm install
npm run deploy:safe      # 会自动应用新的 D1 迁移
```

升级前建议先导出一份备份（v0.2 提供）。

## 🛠 开发

```bash
npm run dev        # 开发服务器（workerd + HMR）
npm run build      # 构建前端与 Worker
npm run preview    # 用构建产物本地跑，接近线上
npm test           # Vitest，跑在真实 workerd 里
npm run lint       # 三套 tsconfig 的类型检查
```

技术栈刻意保持精简：Hono + D1 + React + 手写 CSS + 手写 SVG 图表（**无 UI 库、无图表库、无状态管理库**）。
前端整包 81.5 KB gzip，Worker 28.7 KB gzip。

文档：

- [docs/PRD.md](docs/PRD.md) — 需求与已确认决策（15 节）
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — 部署与开发体验设计
- [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) — 本地开发指南
- [docs/feasibility-and-design.md](docs/feasibility-and-design.md) — 平台限额与可行性分析

## 📄 License

MIT。个人记账工具，**不提供投资建议**；请自行确认所在地区对加密资产记录的合规要求。
