# Asset Manager · 个人资产管理

把股票、加密货币、现金放在一处记录和查看的个人记账工具。**纯 Cloudflare 部署**（Workers + D1 + 静态资源），
数据只存在你自己的账号里，不含任何遥测与第三方统计。

> 状态：**v0.13 — 功能已按 PRD 完成**（尚未在真实 Cloudflare 账号部署验证）。
> 已实现：初始化/登录/改密码、账户（52 个内置平台图标、归档）、持仓（批量改价、归档）、
> 组合视图（环形图四维度 + 点击下钻筛选、treemap 下钻、明细表可排序）、
> **外部行情自动更新**（默认免费数据源，多源回退，可自定义）、**每日走势图**、
> 操作历史（字段级 diff + 类型/日期筛选）、设置（显示币种 / 汇率 / 行情 / 数据概览）、
> 备份导出与导入（差异预览 + 可选口令加密）。

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
- **行情自动更新**：默认接免费接口（CoinGecko / Binance / Yahoo / 腾讯 / Frankfurter / open.er-api），
  一个标的依次尝试多个源、前一个失败自动顺延；6 条持仓实测只用 5 次请求；
  支持持仓级指定数据源与代码（如把 `BTC` 指向 `bitcoin`）；也可以填 URL 模板接自己的行情服务
- **每日走势图**：手写 SVG（零图表库），支持 1M/3M/6M/1Y/ALL、总额/按类别堆叠、悬浮明细、缺日自动沿用前一日
- **每日快照**：Cron 每小时触发、只在配置的小时动手，先刷新行情再拍快照；漏跑会在下次自动补上
- **输入代码自动补全**：持仓表单里填完代码（或点「查名称」）会自动带出名称、币种、市场与交易所；
  价格框旁的「取最新价」按钮可以直接把最新价填进去
- **抗限流**：免费接口偶发 429 时，该数据源自动冷却 10 分钟（连续失败 30 分钟），
  期间自动换用其它源，并在设置页标明"限流冷却 N 分钟"，不再静默失败
- **汇率按日冻结**：快照会记住当天的汇率，事后改汇率不会再让历史曲线整体平移
- **中英文双语**：设置 → 界面语言可切换「跟随浏览器 / 简体中文 / English」，立即生效并随备份迁移；
  连服务端的校验错误、导入警告、行情失败原因都会跟着语言走
- 免费额度护栏：仪表盘只有一个聚合接口，价格历史只写不读，无 Cron

**路线图**

- v0.14：CSV 导入（券商对账单）、交易日历感知（非交易日沿用收盘价）、更多币种的自动汇率
- v0.15：交易流水账本、FIFO / 分红 / 拆股、定投
- 更远：TOTP 二次验证、i18n、多用户 / 家庭共享

## 🌐 语言与时区 / Language & time zone

**时区**（设置 → 时区，默认 **UTC**）：影响每日快照的"哪一天/几点"、价格历史的生效日期、
操作历史的日期筛选边界，以及界面上所有时间的展示。数据库里始终存 UTC，时区只决定"日历怎么解释"。
内置 21 个常用 IANA 时区，也可以直接填 `Asia/Shanghai` 这类名称（非法值会被拒绝并提示）。

**语言**：界面支持 **简体中文 / English**，在「设置 → 界面语言」切换（默认跟随浏览器）。
英文词典按需加载（独立 chunk，9.5KB），中文用户不会下载它。
服务端提示（表单校验、导入警告、行情失败原因、操作历史备注）也会按请求的 `Accept-Language` 返回对应语言。
字典在 `src/shared/locales/{zh,en}.ts`，新增文案只需在两份字典里各加一条 —— 测试会断言两种语言的 key 完全对齐，漏翻会直接失败。

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
| Cron | 1 个触发器（每小时；只在配置小时干活） | 5 个 / 账号 |
| Subrequests | 每天 1 次批量抓取，实测 5–10 次 | 50 次 / 调用 |

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

**升级后打开页面提示"数据库需要升级"？**
说明数据库结构落后于代码（本地常见于 `git pull` 之后）。按页面上的提示执行：

```bash
npm run db:migrate:local     # 本地
npm run db:migrate:remote    # 线上（或直接重新跑 npm run deploy:safe）
```

迁移是幂等的，不会动已有数据。`npm run dev` / `npm run preview` 现在会先自动跑一次本地迁移，通常不会再遇到。

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

**价格为什么没更新？**
行情每天自动更新一次（默认 UTC 22 点，见「设置 → 行情与快照」）。想立刻更新就点那里的「立即刷新行情」。
失败时先看同一页的「最近运行」与失败原因；免费接口偶发限流是正常的，系统会自动换下一个数据源。

**提示"限流冷却"是什么？**
免费接口（CoinGecko / Yahoo 等）对同一 IP 有频率限制。命中限流后本应用会把该数据源暂停 10 分钟，
期间自动使用其它数据源；连续失败 3 次则暂停 30 分钟。冷却状态和上次错误都能在「设置 → 行情与快照」里看到。
想彻底避开，可以填自己的 API Key 或用「自定义数据源」接自己的服务。

**能接自己的行情服务吗？**
可以。「设置 → 行情与快照 → 自定义数据源」填 URL 模板（用 `{symbol}` 占位代码、`{key}` 占位密钥）
和 JSON 价格路径（如 `data.price`）即可；启用后它会优先于内置数据源被尝试。

**走势图为什么有几天是平的？**
那天没有快照（比如部署晚了、或者 Worker 没被触发），系统会沿用前一日数值并标注"沿用前一日"。
也可以在设置页手动补一条快照。

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
npm run build      # 构建前端与 Worker（设置页/持仓页等按需分包）
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
