# PRD：个人资产管理（Asset Manager）

| 项 | 值 |
|---|---|
| 版本 | **v1.11**（M0–M7 均已实现；双语 + 可配置时区） |
| 部署形态 | 纯 Web，100% Cloudflare（Workers + Static Assets + D1） |
| 用户模型 | **单用户、单密码**，无多租户 |
| 成本约束 | **必须落在 Cloudflare 免费额度内，不买 Paid** |
| 基准币种 | 默认 **USD**，可在设置页切换 |
| 日期 | 2026-09-20 |

## 变更记录

- **v1.11（v0.13 完成）**：① **可配置时区**（FR-13，默认 UTC）：影响快照日期与触发小时、价格历史生效日、历史筛选边界、时间展示 ② 字典按语言**动态加载**（英文词典拆成独立 chunk，中文用户不再下载它）。
- **v1.10（v0.12 完成）**：**中英文双语**（FR-12）：字典集中在 `src/shared/i18n.ts`，语言设置 `auto/zh/en` 存在设置表、由 `/api/auth/me` 下发给前端；服务端按 `Accept-Language` 本地化校验错误 / 导入警告 / 行情失败原因 / 审计备注。替换了此前 v1.9 里记录的 FR-9.12 偏离项。
- **v1.9（v0.11 完成）**：① 代码查询：输入代码自动填名称/币种/市场，价格框可一键取最新价（含 24h 缓存与按市场过滤）② 限流冷却：429 冷却 10 分钟、连续失败 3 次冷却 30 分钟，冷却期内自动跳过并说明原因 ③ **汇率按日冻结**，修掉 D9 的"改汇率平移历史曲线" ④ 前端分包懒加载。
- **v1.8（v0.10 完成）**：外部行情（7 个数据源、默认启用免费接口、可回退、可自定义 HTTP 源）、每日快照 + Cron 调度、手写 SVG 走势图（总额/按类别堆叠，受筛选联动）。D2「行情默认关闭」被本版取代：**默认开启**，因为全部为免费无 Key 接口且失败只影响"数据新鲜度"。
- **v1.7（M2 + M3 完成，功能已按 PRD v1 交付）**：筛选持久化到 URL、图表下钻与联动、**市场多选筛选（FR-6.3）**、响应式；备份导出/导入（含 dryRun 差异预览、版本校验、引用完整性校验、可选浏览器端加密）；设置页补齐。
- **v1.6（M1 完成）**：内置平台图标库（52 个精选字母标 + 品牌色 + 首字母兜底）、图标选择器、账户/持仓归档、历史页日期区间筛选、修掉“多币种成本/盈亏直接相加”的正确性 bug（新增 `costDisplay` / `pnlDisplay`）。
- **v1.5（Spike 完成）**：砍掉 ECharts，改为**手写 SVG/CSS 图表**（环形图 + squarified treemap），前端产物 **81.5KB gzip**（原 244.6KB）；新增本地开发方案（`docs/LOCAL_DEV.md`）；M0 与 Spike 已跑通（详见 README 当前状态）。
- **v1.4**：定稿技术栈（D18：React + Vite + TS + 手写 CSS + ECharts 按需）与部署路径（D17：一键按钮 + CLI 两条，不做独立 Actions）；仓库定为公开开源模板（D16）；无遥测（D19）。
- **v1.3**：新增 **FR-9 部署与运维体验**，对标 SubsTracker 的三条部署路径与一键部署脚本；新增 `docs/DEPLOYMENT.md`；新增 M0 里程碑（估时升至 7–9 人天）。
- **v1.2（冻结）**：① setup token 定为**必做**（消除首访抢注窗口）② 币种内置 USD/HKD/CNY 且允许用户自行添加 ③ 明确现金账户计入总资产与所有分布图 ④ 持仓仅备注、不做标签 ⑤ §12 全部决策确认完毕。
- **v1.1**：① 走势图/每日快照/行情全部移出 v1，进 TODO（v1 不做时间序列）② 认证改为"首访 setup 页设置密码"流程 ③ 移除 Cron 与 snapshots 表 ④ 免费额度风险等级下调为低。
- v1.0：首版整合（手动价格数量、随机初始密码+强制改密、行情开关占位、多市场筛选、平均成本法、单用户）。

---

## 1. 目标与非目标

### 1.1 v1 目标
1. 手动记录个人资产：股票、加密货币、现金。
2. 按"券商 / 加密平台 / 现金账户"组织资产，支持平台图标。
3. 随时增删改，且**每一次改动都有历史操作记录可追溯**。
4. 可视化（**静态/当前时点**）：总资产、类别分布饼图、账户分布、币种分布、Treemap、持仓明细表。
5. 首次访问需凭**部署时生成的一次性 setup token** 完成初始化并设置密码；此后进入任何内容页都需登录。
6. 支持备份导出与导入。
7. 显示币种可切换（默认 USD），手动维护汇率。
8. 全部运行在免费额度内（见 §8）。

### 1.2 v1 明确不做（→ TODO，见 §11）
- **任何时间序列图表（"每天走势"）与每日快照**、Cron 定时任务
- **任何外部行情/汇率抓取**（仅保留开关占位，见 FR-7.3）
- 交易流水账本、FIFO/分红/拆股/定投
- 多用户、分享、只读链接、CSV 对账单导入
- 移动端 App（仅响应式 Web）

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| 账户 Account | 资金容器：券商账户 / 加密平台账户 / 现金账户 |
| 持仓 Holding | 账户下的一个资产条目（股票代码、币种、或现金余额） |
| 组合快照 View | 当前时点的资产汇总视图（不是时间序列） |
| 显示币种 | 汇总展示用币种，可在设置页切换 |

---

## 3. 关键设计决策（已确认）

| # | 决策 | 来源 |
|---|---|---|
| D1 | **持仓由用户手动编辑（数量 + 价格 + 平均成本）**，不做流水推导 | 用户确认 |
| D2 | ~~外部行情默认关闭~~ → **v0.10 起默认开启**：全部免费无 Key 接口，失败只影响新鲜度；用户可逐个关闭或配置自定义源 | v0.10 取代 |
| D3 | **v1 不做走势图/每日快照**，移入 TODO | 用户确认 |
| D4 | 支持多市场（美股/港股/A股/加密）+ 全局筛选切换 | 用户确认 |
| D5 | 显示币种可切换，默认 USD；汇率手动维护 | 用户确认 |
| D6 | **不使用 Workers Paid**，一切设计服从免费额度 | 用户确认 |
| D7 | 盈亏用**平均成本法**；FIFO/分红/拆股进 TODO | 用户确认 |
| D8 | 单用户单密码 | 用户确认 |
| D9 | 改汇率会使折算后的历史/报表数值整体平移（v1 已知限制，UI 提示；按日冻结汇率进 TODO） | 用户确认接受 |
| D10 | 图标：内置精选 SVG + 字母兜底；**自定义上传放 v1.x** | 用户确认 |
| D11 | 认证：**首访 setup 页设置密码**（页面提供"生成随机密码"按钮，可复制后使用或自行输入）；设置完成后所有内容页需登录 | 用户确认 |
| D12 | **setup 必须携带部署时生成的一次性 token**（防首访抢注），不可关闭 | 用户确认（方案 1） |
| D13 | 币种：内置 USD / HKD / CNY，**允许用户自行添加其他币种**（需自填汇率） | 用户确认 |
| D14 | 现金账户**计入**总资产与所有分布图（类别/账户/币种/treemap） | 用户确认 |
| D15 | 持仓仅做备注（note），**不做标签**；标签、自定义图标上传进 v1.x | 用户确认 |
| D16 | **仓库公开**（MIT），定位为可被别人 fork 并部署到自己 Cloudflare 的开源模板 | 用户确认（① 公开） |
| D17 | 部署路径收敛为**两条**：① Deploy to Cloudflare 一键按钮（主）② `npm run deploy:safe` CLI（备）；**不做独立 GitHub Actions workflow**（Workers Builds 已覆盖） | 采用推荐 |
| D18 | 前端 = **React + Vite + TypeScript**；样式用**手写 CSS + CSS 变量**，不用 Tailwind/UI 库；**图表也手写（SVG 环形图 + CSS treemap），不引图表库**；前端产物预算 **≤100KB gzip** | 用户要求“简单 + 轻量”；实测 ECharts 使产物达 244KB gzip，故移除 |
| D19 | 不接入任何分析/遥测脚本（无 Analytics、无上报），财务数据不出自己的 Worker | 安全默认 |

---

## 4. 功能需求

### FR-1 首次访问与认证

**流程**

```
部署完成
  └─ 首次访问任意页面
       ├─ GET /api/auth/me → {initialized:false}
       ├─ 进入 /setup（公开，唯一无需登录的页面）
       │    ├─ ① 填入部署终端打印的一次性 setup token（FR-1.9）
       │    ├─ ② 设置密码："生成随机密码"按钮生成 ≥16 字符强口令（显示并一键复制），或自行输入（≥12 字符，二次确认）
       │    └─ 提交 → 浏览器端 PBKDF2 派生 → POST /api/auth/setup {credential, setupToken}
       │         └─ 校验 token → 原子写入（INSERT ... WHERE NOT EXISTS）
       └─ 初始化完成后：所有页面与 /api/* 均需登录（/setup 返回 409）
```

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-1.1 | setup 页是唯一的公开页面 | 未初始化时：非 setup 请求一律跳转/403；初始化后：/setup 返回 409 或跳转登录页 |
| FR-1.2 | setup 提供"生成随机密码"便捷入口 | 建议 ≥16 字符（4 词组口令或 base58），显示明文、可一键复制，用户可选择采用或自行填写 |
| FR-1.3 | setup 写入必须原子且只成功一次 | 并发两次提交，只有一次成功，第二次 409；用条件 INSERT 或事务 |
| FR-1.4 | 密码不以明文/可逆形式入库 | 库中仅存 `verifier`；无明文、无原始派生 key |
| FR-1.5 | 登录态 | `__Host-` 前缀 Cookie，HttpOnly + Secure + SameSite=Lax；默认 30 天；支持"登出所有设备" |
| FR-1.6 | 修改密码 | 需验证旧密码；新密码 ≥12 字符；改完吊销其他所有会话 |
| FR-1.7 | 防暴力破解 | 连续 5 次失败锁定 15 分钟（记 D1）；失败文案统一 |
| FR-1.8 | 鉴权必须适配免费版 10ms CPU | **浏览器端重 KDF + Worker 端单次 SHA-256**（见 §9.1）；Worker 内禁止高迭代 PBKDF2/Argon2/bcrypt |
| FR-1.9 | **setup token 必做（不可关闭）** | 部署脚本用 `openssl rand` 生成 ≥32 字符随机 token → 终端打印一次 → `wrangler secret put SETUP_TOKEN` 写入 Worker Secret；`/setup` 页必须填入该 token，校验用常数时间比较，错误返回 401 |
| FR-1.10 | token 无需单独的失效逻辑 | setup 成功即写入 auth 行，此后 `/api/auth/setup` 一律返回 409，token 自然失效 |

> ⚠️ 安全说明：FR-1.1 的"首访无需密码"原本存在"首个访问者可抢注"的窗口期，已由 **FR-1.9 的 setup token 关闭**：攻击者即便猜到 URL，没有部署终端打印的 token 也无法完成初始化。残留风险仅为 token 本身泄露（终端输出被他人看到、贴进聊天记录等），部署时注意即可。

### FR-2 账户管理（券商 / 加密平台 / 现金）

| 编号 | 需求 |
|---|---|
| FR-2.1 | 新增/编辑/删除/归档账户；字段：名称、类型（券商/加密平台/现金）、市场、币种、图标、备注、排序 |
| FR-2.2 | 内置平台图标库（精选 30–60 个 SVG，打包进静态资源，不外链）；**无匹配时用"首字母 + 确定性品牌色"兜底** |
| FR-2.3 | 删除账户需二次确认；账户下有持仓时，要求先清空或选择"一并删除持仓" |
| FR-2.4 | 账户列表展示：图标、名称、类型、市场、币种、市值（折算显示币种）、持仓数、占比 |
| FR-2.5 | 自定义图标上传 → v1.x（v1 只做内置 + 字母兜底） |

### FR-3 持仓管理（手动数量 + 价格 + 成本）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-3.1 | 新增持仓：账户、类别（股票/ETF/加密/基金/现金）、市场、代码、名称、币种、**数量**、**当前价格**、**平均成本价**、备注 | 全手动输入 |
| FR-3.2 | 每次保存数量或价格时，追加写入 `price_history` / `qty_history`（生效日期默认今天，可改） | **v1 只写不读**，为 v2 走势图预埋数据，成本≈1 行/次 |
| FR-3.3 | 修改数量时默认**不改动平均成本**，界面提示是否同步调整，允许手动改 | 避免静默篡改成本 |
| FR-3.4 | 市值 = 数量 × 价格；盈亏额 = (价格 − 平均成本) × 数量；盈亏率 = (价格/平均成本 − 1)；未填成本显示"—" | |
| FR-3.5 | **批量更新价格页**：一屏列出全部持仓的价格输入框，一次提交批量保存 | 手动维护价格的核心效率手段 |
| FR-3.6 | 每行显示"价格最后更新时间"；距今 > 7 天标黄提示数据陈旧 | v1 无行情，必须让用户知道数据有多旧 |
| FR-3.7 | 支持归档/删除；删除写入审计日志（含完整快照） | |
| FR-3.8 | 现金账户：`数量=余额`、`价格=1`，界面隐藏价格与成本字段 | 统一模型 |

### FR-4 操作历史（审计）

| 编号 | 需求 |
|---|---|
| FR-4.1 | 所有写操作（账户/持仓/设置/汇率/导入/密码/setup）自动写 `audit_log`，含 before/after JSON、UTC 时间戳、操作类型、来源 |
| FR-4.2 | "操作历史"页：时间倒序、按实体类型/操作类型/日期区间筛选、分页 |
| FR-4.3 | 每条可展开查看字段级 diff（旧值 → 新值） |
| FR-4.4 | 审计日志只读，不可编辑/删除（仅随"整库替换导入"消失） |
| FR-4.5 | 记录来源：`web` / `import` / `system` |

### FR-5 可视化（当前时点，无时间序列）

| 编号 | 需求 |
|---|---|
| FR-5.1 | 顶部统计卡：总资产（显示币种，**含现金余额**）、持仓数、账户数；不提供"当日/区间变化"，改为显示"最久未更新价格天数" |
| FR-5.8 | **现金账户计入总资产，并参与类别/账户/币种饼图与 Treemap**（现金市值 = 余额，按账户币种折算） |
| FR-5.2 | **饼图/环形图**：按 资产类别 / 账户 / 币种 / 单一标的 四个维度切换 |
| FR-5.3 | **Treemap**：账户 → 标的 的层级占比（面积 = 市值） |
| FR-5.4 | 持仓明细表：代码、名称、账户、类别、市场、数量、价格、市值、占比、成本、盈亏额、盈亏率、价格更新时间；支持排序与筛选 |
| FR-5.5 | 账户卡片视图：每个账户的市值、占比、持仓数、迷你占比条 |
| FR-5.6 | 空状态：无数据时引导"创建第一个账户"，不显示空图表 |
| FR-5.7 | 图表数据由后端下采样/聚合到 ≤ 500 个数据点后再下发（护栏 NFR） |

### FR-6 筛选与切换

| 编号 | 需求 |
|---|---|
| FR-6.1 | 全部视图支持按 **账户 / 资产类别 / 市场 / 币种** 筛选 |
| FR-6.2 | 筛选状态全局唯一、写入 URL query，刷新/分享可保持；筛选联动影响所有图表与统计 |
| FR-6.3 | 市场筛选支持多选（美股 / 港股 / A股 / 加密 / 其他，市场为持仓上的标签）——已实现：URL `?market=us,hk`，界面为可点选的 chips |
| FR-6.4 | 盈亏统一用平均成本法 |

### FR-7 设置页

| 编号 | 需求 | 备注 |
|---|---|---|
| FR-7.1 | **显示币种**切换（默认 USD）；内置 USD / HKD / CNY，**并允许用户自行添加任意币种**（需为其录入汇率）；切换后所有汇总、图表、表格立即重算 | 用 FR-7.2 汇率折算；币种为数据驱动，非硬编码枚举 |
| FR-7.2 | 汇率表：手动录入，记录变更历史（写审计）；界面提示"修改汇率会使折算数值整体变化" | v1 无自动汇率 |
| FR-7.3 | **外部行情开关**：默认关闭；点击开启时弹提示"下个版本支持"，开关保持关闭、不存状态 | 纯占位 |
| FR-7.4 | 修改密码、登出所有设备 | |
| FR-7.5 | 备份导出 / 导入入口 | 见 FR-8 |
| FR-7.6 | 数据概览：各表行数、审计条数、导出体积估算 | 便于判断是否接近免费额度 |
| FR-7.7 | ~~每日快照时间设置~~ | 随 D3 移除 |

### FR-8 备份与导入

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-8.1 | 一键导出 JSON | 含 `schema_version`、`exported_at`、`app_version`、全部业务数据（账户/持仓/history/审计/设置/汇率） |
| FR-8.2 | 导出**不含**密码 verifier 与任何密钥 | 只导出业务数据；导入后需重新登录 |
| FR-8.3 | 可选：浏览器端口令加密后下载（AES-GCM，WebCrypto） | Worker 零额外 CPU |
| FR-8.4 | 导入：上传 → 校验结构 → **差异预览（新增/修改/删除计数）** → 确认 → 事务写入 | 导入前自动把当前数据写入审计（可回滚） |
| FR-8.5 | 两种模式：`replace`（整体替换，需二次确认）/ `merge`（按 id 合并） | |
| FR-8.6 | 文档提供 CLI 全量备份：`npx wrangler d1 export <db> --remote --output=backup.sql` | |
| FR-8.7 | 文档说明 D1 Time Travel（免费 7 天）恢复流程 | |
| FR-8.8 | 导入失败必须原子回滚，不允许半量数据 | 使用 D1 batch/事务 |

### FR-9 部署与运维体验（对标 SubsTracker，详见 `docs/DEPLOYMENT.md`）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-9.1 | **一条命令部署**：`npm run deploy:safe` = 构建 → 查/建 D1 → 应用迁移 → 部署 → 写 secrets → 打印下一步 | 全新环境上只给一个 `CLOUDFLARE_API_TOKEN` 就能跑通 |
| FR-9.2 | **Deploy to Cloudflare 一键按钮** | README 顶部按钮可用；Cloudflare 自动 provision D1、向导收集 `SETUP_TOKEN`/`SESSION_SECRET`；`deploy` 脚本中的迁移命令**用 binding 名而非库名** |
| FR-9.3 | 不单独维护 GitHub Actions workflow | CI 能力由 Cloudflare **Workers Builds** 覆盖（一键按钮路径）；README 附录提供一段可选 yml 供想自建 CI 的人参考 |
| FR-9.4 | setup token 的获取路径写清楚 | 按钮路径：**部署向导里用户自填**（从 `.dev.vars.example` 声明）；CLI 路径：脚本生成 + 终端打印一次（public repo 下 CI 日志不得出现 token） |
| FR-9.9 | 作为开源模板的完成度 | MIT LICENSE；`.gitignore` 排除 `.dev.vars` / `.wrangler/`；README 含截图 + 一键按钮 + 部署后已知限制；无遥测 |
| FR-9.10 | fork 用户的升级路径 | `git pull` → `npm run deploy:safe`（自动应用新 migration）；备份文件带 `schema_version`，跨版本导入有明确兼容策略 |
| FR-9.11 | 模板化：不得硬编码个人化内容 | 显示币种、时区、图标集全为可配置项；仓库内不含任何个人资产数据/截图中的真实金额（截图需脱敏） |
| FR-9.12 | 界面语言 | ✅ v0.12 已完成（见 FR-12）：中英文可切换，字典集中管理 |
| FR-9.13 | 免责声明 | README 与页面页脚：“个人记账工具，不提供投资建议；数据存在你自己的 Cloudflare 账号” |
| FR-9.5 | 本地开发零云端依赖 | `npm run dev` + 本地 D1（`.wrangler/state`），不消耗线上额度 |
| FR-9.6 | 忘记密码可恢复 | README 交代：D1 Console 执行 `DELETE FROM auth;` → 重跑 `npm run setup:secrets` → 重新初始化 |
| FR-9.7 | README 结构对齐 SubsTracker | 5 分钟上手 / 部署（三选一）/ 第一次必做 / 日常 / 备份迁移 / 忘记密码 / FAQ / 升级 / 开发 / 安全提醒 |
| FR-9.8 | 免费额度实测数据写进 README | 给出典型用量与限额对比，回答"会不会超额" |

### FR-10 行情与每日走势（v0.10）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-10.1 | **默认接入免费行情，零配置可用** | 内置 CoinGecko / Binance / Yahoo / 腾讯 / Frankfurter / open.er-api，均无需 API Key，默认启用 |
| FR-10.2 | **多源回退**：一个标的依次尝试数据源，前一个失败顺延 | 真网验证：CoinGecko 被限流后自动落到 Binance 取到 BTC/ETH |
| FR-10.3 | **省 subrequest**：优先使用批量接口 | 6 条持仓只用 5 次请求（Binance 一次取 2 币、腾讯一次取多码） |
| FR-10.4 | **代码映射**：按市场推导各源代码，并允许持仓级覆盖 | `700`+hk → Yahoo `0700.HK` / 腾讯 `hk00700`；`BTC` → CoinGecko `bitcoin` / Binance `BTCUSDT`；覆盖字段 `quote_source` / `quote_symbol` |
| FR-10.5 | **可自定义数据源**：URL 模板 + JSON 路径 | `https://host/q?symbol={symbol}&k={key}` + `data.price`，可选币种路径、请求头、Key |
| FR-10.6 | **手工汇率永不被自动抓取覆盖** | `fx_rates.source` 区分 manual/auto，只更新 auto |
| FR-10.7 | **每日快照**：一天一行，明细存原币种 | Cron 每小时触发、只在配置小时干活；先刷新行情再拍快照；同日不重复；漏跑可自愈 |
| FR-10.8 | **走势图**：手写 SVG，总额/按类别堆叠 | 1M/3M/6M/1Y/ALL 区间、悬浮提示、按日 forward fill、>400 点服务端降采样 |
| FR-10.9 | **走势与筛选联动** | 类别/账户/市场筛选同时作用于当前值与历史曲线（快照明细含市场） |
| FR-10.10 | 失败不阻塞记账 | 抓取失败只提示"数据陈旧"，不影响账户/持仓/快照；失败原因可在设置页查看 |
| FR-10.11 | API Key 加密存储 | 用 `SESSION_SECRET` 派生密钥 AES-GCM 加密后入 settings，接口不回传明文 |
| FR-10.12 | 免费额度内 | 每小时 Cron（仅 1 个触发器）+ 每天 1 次批量抓取；典型每日请求 < 20 次 |
| FR-10.13 | **代码查询**：输入代码 → 名称 / 最新价 / 币种 / 市场 | `GET /api/quotes/lookup`；先用市场规则推导代码并置顶（`700`+hk → `0700.HK`），再用 Yahoo 搜索补充正式名称与交易所，**按市场过滤噪音结果**；结果缓存 24h，`force=true` 绕过 |
| FR-10.14 | **限流冷却**：偶发 429 不再静默失败 | 429/403 → 该源冷却 10 分钟；连续失败 3 次 → 冷却 30 分钟；冷却期内跳过该源并写入报告与设置页；成功后清零 |

### FR-13 时区（v0.13）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-13.1 | **时区可配置，默认 UTC** | 设置 → 时区（内置 21 个常用 IANA 时区 + 自定义输入），非法值直接拒绝并给出示例 |
| FR-13.2 | 存储始终是 UTC | 数据库里的 `created_at` / `ts` 等一律 UTC ISO 字符串；时区只影响"日历怎么解释" |
| FR-13.3 | **每日快照**按配置时区的日历日与小时 | 快照日期 = 该时区当天；Cron 小时闸门比较的是该时区的钟点（`?tz` 变化无需改代码） |
| FR-13.4 | 价格/数量历史的生效日期 | 手动录入与自动抓取都取"配置时区的今天" |
| FR-13.5 | 操作历史日期筛选 | 用户选 2026-09-20 指的是该时区的那一天，服务端用 `zonedDayRange` 换算 UTC 边界（含夏令时） |
| FR-13.6 | 界面时间展示 | 按配置时区渲染（不是浏览器的本地时区） |
| FR-13.7 | 设置页实时反馈 | 显示当前 UTC 偏移与当地时间，非法名称即时提示 |

### FR-12 多语言（v0.12）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-12.1 | **中英文界面**，可在设置页切换 | 设置 → 界面语言：跟随浏览器 / 简体中文 / English；切换立即生效并写入设置表 |
| FR-12.2 | 语言偏好随备份迁移 | 存 `settings.language`；`/api/auth/me` 下发，首屏即按偏好渲染（localStorage 兜底，避免闪烁） |
| FR-12.3 | **服务端提示也本地化** | Worker 按请求的 `Accept-Language` 生成校验错误、导入警告、行情失败原因、审计备注；`error.field_required` 等模板 + `field.*` 字段名组合 |
| FR-12.4 | 字典集中管理、零依赖 | 文案在 `src/shared/locales/{zh,en}.ts`，前后端共用同一份；插值用 `{{name}}` |
| FR-12.7 | **字典按语言动态加载** | 中文静态引入（默认语言，首屏无异步）；英文用 `import()` 拆成独立 chunk，中文用户不再下载它（v0.13 实现） |
| FR-12.5 | 漏翻可被发现 | 测试断言 zh/en 的 key 完全对齐；缺失 key 回退到中文而不是显示空白 |
| FR-12.6 | 与语言无关的部分保持不变 | 币种符号、平台图标品牌色、数字格式化跟随系统 locale |

> 无法本地化的部分：极少数"备份文件被手工改坏"才会出现的结构性校验错误（如 `accounts[3].id must be a non-empty string`）保留英文技术描述，便于定位是第几行出错。

### FR-11 汇率按日冻结（v0.11）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-11.1 | 拍快照时把当天生效的汇率一并冻结（`fx_daily`） | 每个快照日一行一行地记录当时汇率 |
| FR-11.2 | 画历史曲线时优先用"那一天的汇率"，缺失时回退当前汇率 | 事后把 HKD→USD 从 0.128 改成 0.2，昨天那一点的总额仍是 1280 而不是 2000 |
| FR-11.3 | 明确告知用户用了哪种口径 | 走势图下方标注"使用当日冻结汇率 / 部分冻结 / 当前汇率" |

> 该版修复了 D9：**改汇率不再让历史曲线整体平移**。当前值仍按当前汇率折算（这是对的），历史点用当时汇率（这才是历史）。残余限制：第一个快照之前的日期没有冻结汇率，只能用当前值。

---

## 5. 数据模型（v1）

```sql
accounts(id TEXT PK, name TEXT, kind TEXT CHECK(kind IN ('broker','exchange','cash')),
         market TEXT, currency TEXT, icon_key TEXT,
         sort INTEGER, archived INTEGER DEFAULT 0, note TEXT,
         created_at TEXT, updated_at TEXT)

holdings(id TEXT PK, account_id TEXT FK, class TEXT CHECK(class IN ('stock','etf','crypto','fund','cash')),
         market TEXT, symbol TEXT, name TEXT, currency TEXT,
         qty REAL, price REAL, avg_cost REAL, price_updated_at TEXT,
         archived INTEGER DEFAULT 0, note TEXT, created_at TEXT, updated_at TEXT)

-- v1 只写不读：为 v2 走势图预埋数据
price_history(id TEXT PK, holding_id TEXT FK, effective_date TEXT, price REAL,
              source TEXT CHECK(source IN ('manual','import','api')), created_at TEXT)
qty_history  (id TEXT PK, holding_id TEXT FK, effective_date TEXT, qty REAL,
              source TEXT CHECK(source IN ('manual','import','api')), created_at TEXT)

fx_rates(base TEXT, quote TEXT, rate REAL, updated_at TEXT, PRIMARY KEY(base, quote))
fx_rate_history(id TEXT PK, base TEXT, quote TEXT, rate REAL, changed_at TEXT)

audit_log(id TEXT PK, ts TEXT, actor TEXT, entity TEXT, entity_id TEXT,
          action TEXT, before_json TEXT, after_json TEXT, note TEXT)

settings(key TEXT PK, value TEXT)
auth(id INTEGER PK CHECK(id=1), algo TEXT, kdf_salt TEXT, kdf_iterations INTEGER,
     verifier TEXT, verifier_salt TEXT, must_change INTEGER DEFAULT 0,
     created_at TEXT, updated_at TEXT, last_login_at TEXT)
sessions(id TEXT PK, token_hash TEXT, created_at TEXT, expires_at TEXT, ua TEXT, ip TEXT)
```

设计要点：

1. **无 `snapshots` 表、无 Cron**（v1 无时间序列）。移除后免费额度占用进一步下降，也少一个故障点。
2. `price_history` / `qty_history` 从第一天开始记录（只写不读），v2 加走势图时立刻就有数据，无需回溯。
3. `holdings` 同时承载现金（qty=余额, price=1），避免双模型。
4. 汇率折算在渲染时计算；`fx_rates` 只存当前值，因此改汇率会整体平移数值（D9）。
5. id 用 ULID/UUIDv7（可排序），便于审计与导入合并。

---

## 6. 页面与信息架构

```
/setup                       首次初始化（唯一公开页面）
/login                       登录
/                            仪表盘：统计卡 + 饼图 + treemap + 明细表（当前时点）
/accounts                    账户列表（卡片/表格）
/accounts/:id                账户详情：该账户持仓汇总
/holdings                    全部持仓明细表（排序/筛选）
/holdings/quick-update       批量更新价格
/history                     操作历史（审计）
/settings                    设置（显示币种、汇率、行情开关、密码、备份导入、数据概览）
```

交互约定：筛选状态写入 URL；深色模式跟随系统；移动端优先保证"录入"与"看总数"可用。

---

## 7. API 契约（草案）

```
鉴权
  GET  /api/auth/me                  → {initialized, setupTokenRequired:true, authenticated, session?}
  GET  /api/auth/params              → {kdfSalt, iterations}     # 登录/setup 前取盐
  POST /api/auth/setup               → {credential, setupToken}   # 仅未初始化时可用；token 错→401，已初始化→409；原子
  POST /api/auth/login               → {credential} ; set-cookie
  POST /api/auth/logout
  POST /api/auth/change-password     → {oldCredential, newCredential}
  POST /api/auth/logout-all

账户
  GET    /api/accounts
  POST   /api/accounts
  PATCH  /api/accounts/:id
  DELETE /api/accounts/:id?cascadeHoldings=true

持仓
  GET    /api/holdings?accountId=&class=&market=&currency=
  POST   /api/holdings
  PATCH  /api/holdings/:id
  POST   /api/holdings/bulk-price    → [{id, price, effectiveDate}]
  DELETE /api/holdings/:id

组合视图
  GET  /api/portfolio?currency=USD&class=&market=&accountId=
       → { total, counts, byClass[], byAccount[], byCurrency[], treemap[], holdings[] }

审计
  GET  /api/history?entity=&action=&from=&to=&page=&pageSize=

设置 / 汇率
  GET  /api/settings
  PUT  /api/settings
  GET  /api/fx
  PUT  /api/fx

备份
  GET  /api/backup/export            → application/json 附件
  POST /api/backup/import?mode=replace|merge&dryRun=true
```

约定：统一 `{ok, data}` / `{ok:false, error:{code,message}}`；所有写接口校验 `Origin` + 自定义头 `X-Requested-With`（CSRF）；聚合只走一个 `/api/portfolio` 接口，避免多接口导致 CPU 与请求数上升。

---

## 8. 免费额度护栏（硬约束）

| 资源 | 免费额度 | 本项目预算与对策 |
|---|---|---|
| Workers 请求 | 10 万/天 | 单用户实际 < 1 千/天；仪表盘合并为 1 个接口 |
| **Workers CPU** | **10ms/请求** | ① 认证用浏览器端 KDF（§9.1）② 聚合在 SQL 里做 ③ 图表数据 ≤500 点 ④ 上线前用 `wrangler tail` 实测，目标 p95 < 3ms |
| Subrequests | 50/请求 | v1 无任何外部请求，天然 0 |
| Cron | 5 个/账号 | **v1 不使用** |
| D1 行读 | 500 万/天 | 组合视图查询限制在几千行内 |
| D1 行写 | 10 万/天 | 单次编辑 ≈ 3 行（holding + history + audit）；禁止循环逐行写；批量更新用单条 batch |
| D1 存储 | 5GB/账号（单库 500MB） | 十年数据 < 10MB |
| KV | 写 1,000/天 | **v1 不使用 KV** |
| 静态资源 | 20,000 文件 / 25MiB 单文件 | 图标合并为 sprite |

> v1.2 移除行情抓取、Cron 与时间序列后，**免费额度风险等级由"中"降为"低"**：唯一需要设计的点是认证 CPU，已由 §9.1 解决；setup token 仅在校验时做一次常数时间比较，可忽略。

---

## 9. 安全需求

### 9.1 认证方案（为满足 10ms CPU）

```
setup / 改密码（浏览器）:
  key = PBKDF2-SHA256(password, kdfSalt, 300_000)     // 重活全在浏览器，Worker 不消耗 CPU
  POST key
Worker:
  verifier = SHA-256(key + verifierSalt)              // 单次哈希，≈0.1ms
  存 verifier，丢弃 key

登录（浏览器）:
  GET /api/auth/params → {kdfSalt, iterations}
  key = PBKDF2-SHA256(password, kdfSalt, 300_000)
  POST /api/auth/login {credential: key}
Worker:
  constantTimeEqual(SHA-256(credential + verifierSalt), verifier)
```

已知取舍：该 `key` 等价于密码（pass-the-hash），依赖 HTTPS + HttpOnly Cookie 保护。个人自用、非公开场景可接受；D1 泄露不会直接得到可登录凭据（需攻破 SHA-256 原像）。

### 9.2 首访抢注防护（对应 FR-1.9 / D12）

已采用**方案 1**：

```
部署时:
  TOKEN=$(openssl rand -base64 32)
  echo "SETUP TOKEN（仅显示一次）: $TOKEN"
  echo "$TOKEN" | npx wrangler secret put SETUP_TOKEN

初始化时:
  POST /api/auth/setup {credential, setupToken}
    → timingSafeEqual(setupToken, env.SETUP_TOKEN) 失败 → 401
    → 已存在 auth 行 → 409
    → 通过 → 写 auth + audit_log（source=system，不记录 token 与密码）
```

补充要求：
- token 与密码都不写入日志；审计只记"setup 成功"事件。
- token 保存在 Worker Secret，运行时不可修改，因此不需要单独的失效逻辑（由 409 兜底）。
- 建议部署后立即完成初始化；并可选叠加 Cloudflare Access 作为第二道边界。

### 9.3 其他
- 不使用可猜测的 `workers.dev` 子域；建议自有域名 + 可选叠加 Cloudflare Access（Zero Trust 免费 ≤50 用户，2026-08 起可一键保护单个 Worker）。
- 安全响应头（HSTS、CSP、X-Content-Type-Options、Referrer-Policy）用 `_headers` 配置。
- 备份文件含全部资产数据：默认风险提示，可选客户端加密。
- v1 无任何第三方密钥；未来 API key 只放 Worker Secrets。

---

## 10. 里程碑

| 阶段 | 内容 | 交付判定 | 估算 | 状态 |
|---|---|---|---|---|
| M0 能一键部署 | `setup-d1.cjs` / `setup-secrets.cjs` / `deploy:safe` / 两条部署路径 / README（含 FAQ）+ LICENSE（FR-9） | 陌生环境上一键部署成功；公开仓库可直接被 fork 使用 | 1.5 天 | ✅ 脚本完成，待真实账号验证 |
| Spike | 骨架 + setup/login + 账户 + 2 条持仓 + 饼图；实测 CPU time | 验证免费额度与认证方案可行 | 0.5–1 天 | ✅ 本地 workerd 全链路通过（CPU 待线上 tail 确认） |
| M1 能录能用 | FR-1 / FR-2 / FR-3 / FR-4 | 能初始化、登录、建账户、录持仓、看审计 | 2.5–3.5 天 | ✅ 完成（含图标库 / 归档 / 历史筛选） |
| M2 能看懂 | FR-5 / FR-6（环形图、treemap、明细、筛选联动） | 组合视图正确、筛选联动一致 | 1.5–2 天 | ✅ 完成（含 URL 筛选、下钻、响应式） |
| M3 能长期用 | FR-7 / FR-8 + 空状态 + 响应式 + 陈旧提示 | 导出导入闭环、切换币种正确 | 1.5–2 天 | ✅ 完成（含差异预览与客户端加密） |
| M4 能自动/能看历史（v0.10） | FR-10：行情刷新 + 每日快照 + 走势图 | 免费源开箱可用、失败可回退、快照驱动走势 | 2 天 | ✅ 完成（含真网验证） |
| M5 更好用更抗造（v0.11） | FR-10.13/10.14 + FR-11：代码查询、限流冷却、汇率按日冻结、前端分包 | 输入代码自动补全、限流不再静默失败、历史曲线不随汇率漂移 | 1.5 天 | ✅ 完成（含真网验证） |
| M6 双语（v0.12） | FR-12：中英文界面 + 服务端提示本地化 | 切语言后界面与报错都切换；新增 key 有测试兜底 | 1 天 | ✅ 完成（含真网验证） |
| M7 时区（v0.13） | FR-13：可配置时区（默认 UTC）+ 字典动态加载 | 快照/历史/展示都按配置时区；首包不再含英文词典 | 0.5 天 | ✅ 完成（含真网验证） |
| 合计 | | | **约 8–10 人天** | 功能完成；待真实账号部署验证 |

---

## 11. TODO（v2+）

1. ~~每日走势图 + 每日快照 + Cron~~ → v0.10 已完成（FR-10）
2. ~~外部行情自动抓取~~ → v0.10 已完成（FR-10.1–10.6）
3. ~~自动汇率 + 汇率按日冻结~~ → v0.11 已完成（FR-11）；剩下的 TODO 是"更多币种的自动汇率"（ECB 覆盖面有限）
4. 交易流水账本 + FIFO 成本 + 分红 + 拆股 + 定投
5. 自定义图标上传
6. CSV 导入（券商对账单）、批量导出
7. 自动化 R2 每日备份轮转
8. 目标配置与偏离提醒、再平衡建议
9. TOTP 二次验证、Cloudflare Access 集成开关
10. 多用户/家庭共享

---

## 12. 待确认问题

**全部决策已确认，v1.2 需求冻结。** 后续新增内容一律进 §11 TODO，不在 v1 内扩 scope。

| # | 决策 | 状态 |
|---|---|---|
| 1 | 走势图 / 每日快照 / 行情 / Cron 移出 v1 | ✅ 确认（进 TODO 1、2） |
| 2 | 浏览器端 KDF + Worker 单次 SHA-256 认证 | ✅ 确认（§9.1） |
| 3 | 多市场（美股/港股/A股/加密）+ 全局筛选切换 | ✅ 确认（FR-6） |
| 4 | 改汇率会使折算数值整体平移 | ✅ 接受为 v1 已知限制（TODO 3 修复） |
| 5 | 图标仅内置 + 字母兜底，上传放 v1.x | ✅ 确认（D10 / TODO 5） |
| 6 | setup token 必做（防首访抢注） | ✅ 确认（方案 1，FR-1.9 / §9.2） |
| 7 | 币种内置 USD / HKD / CNY，允许自行添加 | ✅ 确认（D13 / FR-7.1） |
| 8 | 现金账户计入总资产与所有分布图 | ✅ 确认（D14 / FR-5.8） |
| 9 | 持仓仅备注，不做标签 | ✅ 确认（D15） |
| 10 | 持仓手动编辑数量/价格/成本，平均成本法 | ✅ 确认（D1 / D7） |
| 11 | 单用户单密码、不买 Paid、免费额度内 | ✅ 确认（D6 / D8） |

---

## 13. 附：与既有开源方案对比

| 方案 | 结论 |
|---|---|
| Ghostfolio | 功能强，但需 Node + Postgres，无法纯 Cloudflare 托管 |
| Firefly III | PHP + MySQL，同上 |
| Notion / 表格 | 无审计、可视化弱、依赖第三方 |

自建收益：零成本、数据自持、可视化贴合自身持仓；代价约 7–9 人天。

---

## 14. 部署与开发体验（DX）

完整设计见 **`docs/DEPLOYMENT.md`**，要点：

- **两条主路径**：① Deploy to Cloudflare 一键按钮（Cloudflare 自动 provision D1 + 向导收集 Secrets）② `npm run deploy:safe` 命令行（GitHub Actions 不自带，仅作 README 附录）
- **脚本**：`scripts/setup-d1.cjs`（查/建 D1 并把 database_id 注入 `wrangler.jsonc`）、`scripts/setup-secrets.cjs`（生成 SETUP_TOKEN / SESSION_SECRET）
- **本地开发**：`wrangler.dev.jsonc` + 本地 D1，零云端依赖
- **与 SubsTracker 的有意差异**：D1 取代 KV（要聚合查询）、setup token 取代默认密码、D1 官方 migrations 取代自研迁移、React+Vite 取代服务端 HTML 模板（构建步骤由脚本隐藏）

### 已定稿（v1.4）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 仓库是否公开 | ✅ **公开**，MIT，定位为他人可 fork 自部署的开源模板 → 同时启用 Workers Builds + 一键按钮 |
| 2 | 前端是否保留构建步骤 | ✅ **保留**：React + Vite + TS（理由见 §15） |
| 3 | 是否使用 Workers Builds | ✅ **用**，作为一键按钮与 push 自动部署的执行体；不自建 Actions |

## 15. 技术栈选型（已确认）

### 15.1 最终清单

| 层 | 选型 | 体积/成本 |
|---|---|---|
| Worker 框架 | **Hono** | ~15KB，官方生态标准 |
| 校验 | **Zod** | — |
| 数据库 | **D1** + 官方 migrations | — |
| 前端框架 | **React 19 + TypeScript** | react+react-dom ≈ 45KB gzip |
| 构建 | **Vite + @cloudflare/vite-plugin** | 官方模板，与 Workers Builds 无缝 |
| 样式 | **手写 CSS + CSS 变量**（不用 Tailwind / UI 库） | ~8KB |
| 图表 | **手写**：SVG stroke-dasharray 环形图 + squarified treemap（CSS 绝对定位） | 运行时 **0 依赖**，实测整包 81.5KB gzip |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` | — |
| 前端产物 | **首屏 95.3KB gzip + 按需分包**（中文词典在首包；英文词典 9.5KB 独立 chunk，仅英文用户加载；设置页 5.9KB / 持仓页 4.4KB 等按需） | 静态资源不计 CPU，不计请求额度 |

### 15.2 为什么不用“无构建的 HTML 模板 + vanilla JS”（SubsTracker 的做法）

| 维度 | 无构建模板 | React + Vite |
|---|---|---|
| 部署命令数 | 少一个 `vite build` | 多一个 `vite build`（被 `deploy:safe` 隐藏，用户无感） |
| 维护成本 | **高**：筛选联动多图表 + 可排序表格 + 表单校验全要手写 DOM | 低：声明式数据流 |
| 代码量（估） | 仪表盘+表格+表单 ≈ 2500–3500 行指令式 JS | ≈ 1200–1800 行组件 |
| v2 扩展（行情/走势图/流水） | 每加一个交互都要手写 DOM 更新 | 加组件即可 |
| 依赖数量 | 更少（~3 个） | 多 6–8 个 devDependencies，运行时不增加 CPU |
| 对 fork 者的熟悉度 | 一般 | **高**（Cloudflare 官方 SPA 教程就是这个栈） |

结论：**“简单” 体现为“少踩坑、少维护”，而不是“少跑一个 build”，所以选 React + Vite。** 同时用三条纪律守住“轻量”：手写 CSS、**手写图表（不引 ECharts/Chart.js）**、拒绝 UI 组件库。v0.13 把英文词典改为动态 import 后首屏 **95.3KB gzip**（中文词典约 6KB 在首包，英文 9.5KB 按需）。
