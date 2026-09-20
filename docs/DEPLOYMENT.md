# 部署与开发体验设计（对标 SubsTracker）

> 参考项目：[wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker)（Cloudflare Workers + KV + Hono，MIT）
> 本文回答："怎么让部署体验做到 SubsTracker 那样"，以及"哪里会不一样、为什么"。
> 关联文档：`docs/PRD.md`、`docs/feasibility-and-design.md`

---

## 1. SubsTracker 的 DX 拆解（我们要对齐的点）

| # | SubsTracker 的做法 | 我们要不要照做 |
|---|---|---|
| 1 | `git clone` → `npm install` → `npm run deploy:safe` 一条命令搞定资源创建 + 部署 | ✅ 照做 |
| 2 | `scripts/setup-kv.cjs`：自动 `wrangler kv namespace list` 查重 → 不存在则 create → 把 id 注入 `wrangler.toml` | ✅ 照做，改造成 `setup-d1.cjs` |
| 3 | 部署完终端打印访问 URL | ✅ 照做，并额外打印 setup token 与"下一步做什么" |
| 4 | GitHub Actions：fork + 2 个 Secret → push 自动部署 | ⚠️ **不自建 workflow**（D17）：push 自动部署交给 Cloudflare **Workers Builds**（一键按钮路径本就依赖它）；README 仅附一段可选 yml |
| 5 | `wrangler.dev.toml` 与生产配置分离，避免 setup 脚本写入的绑定污染本地开发 | ✅ 照做（生产 `wrangler.jsonc` / 本地 `wrangler.dev.jsonc`） |
| 6 | 首次访问自动迁移（`ensureMigrations` 挂全局中间件，幂等 + 锁 + 备份） | ⚠️ 用 D1 官方 migrations（`wrangler d1 migrations apply --remote`）替代自研迁移 |
| 7 | 默认账号 `admin/password` + "立刻改密码" | ❌ **不照做**：改为部署时生成 setup token + 用户自设密码（安全得多，DX 损失很小） |
| 8 | 忘记密码 → Dashboard 改 KV 里的 `config` | ✅ 抄思路：README 写清"Dashboard → D1 → Console 执行 `DELETE FROM auth;` → 重新 setup" |
| 9 | 备份导出 / 导入（合并 / 覆盖两种模式） | ✅ 照做（PRD FR-8 已含） |
| 10 | 无前端构建步骤（服务端 HTML 模板 + vanilla JS，`"build": "echo no build"`） | ⚠️ 我们有 Vite 构建，但由 `deploy:safe` 自动串起来，用户感知一致 |
| 11 | README 结构：5 分钟上手 / 部署 / 第一次必做 / 日常 / 原理 / 功能 / FAQ / 升级 / 安全 | ✅ 照做，目录一一对应 |
| 12 | `npm test` = Vitest + `@cloudflare/vitest-pool-workers` | ✅ 照做 |
| 13 | 项目规模参考：约 6,900 行 JS，依赖只有 hono | 参考即可，我们会更大 |

---

## 2. 部署路径（已定稿：2 条主路径 + 1 段可选附录）

> **D17 结论**：主推 **路径 A（一键按钮）**，保留 **路径 B（CLI）**，**不自带 GitHub Actions workflow**——因为路径 A 已经跑在 Workers Builds 上（push 已能自动部署），再维护一份 Actions 是重复成本。README 附录给一段 yml 供想自建 CI 的人抄。
>
> **D16 结论**：仓库公开（MIT），定位为“别人可以 fork 后部署到自己 Cloudflare 自己用”的开源模板 → 路径 A 必须做到真正可用（含 `.dev.vars.example` 声明 secrets、预置占位 database_id、迁移用 binding 名）。

### 路径 A：Deploy to Cloudflare 按钮（最接近"一键"，推荐放 README 顶部）

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/asset-manager)
```

Cloudflare 会（已核实官方文档）：

1. 把仓库 clone 到用户自己的 GitHub/GitLab 账号（用户可继续开发）
2. 在配置页让用户自定义仓库名、Worker 名、**资源名（D1 库名）**，并回写到新仓库的 wrangler 配置
3. **自动创建 D1 并绑定**（支持 KV / D1 / R2 / DO / Queues 等）
4. 用 Workers Builds 执行构建与部署
5. 读取 `wrangler.jsonc` 决定需要哪些资源；因此**仓库里必须给出资源名/id 的默认占位值**

关键实现要求（官方明确）：
- 自定义 build / deploy 命令会被自动识别并预填；我们的 `deploy` 脚本里包含 D1 迁移
- **D1 迁移必须用 binding 名而不是库名**，否则用户在向导里改了库名就会失败：
  ```jsonc
  {
    "scripts": {
      "build": "vite build",
      "deploy": "npm run db:migrate:remote && wrangler deploy",
      "db:migrate:remote": "wrangler d1 migrations apply DB --remote"
    }
  }
  ```
- **Secrets 通过 `.dev.vars.example` / `.env.example` 声明**，部署向导会让用户填值 → 正好用来收集 `SETUP_TOKEN`：
  ```ini
  # .dev.vars.example
  SETUP_TOKEN=  # 用 openssl rand -hex 32 生成
  SESSION_SECRET=  # 用 openssl rand -hex 32 生成
  ```
- 在 `package.json` 里给 binding 写说明（支持 markdown），引导用户生成随机值：
  ```jsonc
  {
    "cloudflare": {
      "bindings": {
        "SETUP_TOKEN":   { "description": "初始化口令。用 `openssl rand -hex 32` 生成，首次打开网页时要用它完成初始化。" },
        "SESSION_SECRET":{ "description": "会话签名密钥。用 `openssl rand -hex 32` 生成。" }
      }
    }
  }
  ```
- 限制：**仓库必须公开**、仅 GitHub/GitLab、不支持 monorepo、仅 Workers（非 Pages）

> 这条路径的好处：用户在向导里**自己填 SETUP_TOKEN，所以他自己知道 token**，不存在"日志里打印 token"的泄露问题。

### 路径 B：命令行（对标 SubsTracker 的 `deploy:safe`）

```bash
git clone https://github.com/<you>/asset-manager.git
cd asset-manager
npm install
export CLOUDFLARE_API_TOKEN=你的token        # Windows: $env:CLOUDFLARE_API_TOKEN="..."
npm run deploy:safe
```

`deploy:safe` 流水线：

```
npm run build               # vite build → dist/（静态资源）
  ↓
node scripts/setup-d1.cjs   # 查重/创建 D1 → 注入 database_id 到 wrangler.jsonc
  ↓
wrangler d1 migrations apply DB --remote
  ↓
wrangler deploy             # 上传 Worker + 静态资源
  ↓
node scripts/setup-secrets.cjs   # 生成并写入 SETUP_TOKEN / SESSION_SECRET，打印一次
  ↓
打印：访问 URL + SETUP TOKEN + 下一步（打开网页 → 填 token → 设密码）
```

> 顺序说明：`wrangler secret put` 依赖 Worker 已存在，所以放在 `deploy` 之后；secret 在下一次请求即生效。
> setup token 丢失时的恢复：重跑 `npm run setup:secrets` 覆盖即可（此时需同时把 D1 里的 auth 行清掉才能重新初始化）。

### 路径 C（可选附录，不默认随仓库提供）：GitHub Actions

用于“不想授权 Cloudflare 访问 GitHub / 想自己控 CI” 的用户。README 附录给模板，不进主流程。

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push: { branches: [main] }
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run lint && npm test        # 部署前门禁（照抄 SubsTracker）
      - run: npm run setup:d1
      - run: npm run deploy:safe
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          SETUP_TOKEN: ${{ secrets.SETUP_TOKEN }}      # 用户自己设，不自动生成
          SESSION_SECRET: ${{ secrets.SESSION_SECRET }}
```

⚠️ **public repo 的陷阱**：Actions 日志是公开可见的，因此**绝不能**在 CI 里生成并打印 setup token。做法与 SubsTracker 的 "用户自备 Secret" 一致——`SETUP_TOKEN` / `SESSION_SECRET` 由用户自己生成后存进 GitHub Secrets，CI 只读不打印。

---

## 3. `scripts/setup-d1.cjs` 设计（照抄 setup-kv.cjs 的思路，换成 D1）

```
1. 读 wrangler.jsonc 的 name（Worker 名）
2. npx wrangler d1 list --json  → 按 name 前缀匹配本项目
   （SubsTracker 的经验：wrangler 会给资源名加项目名前缀，只匹配当前项目，避免误用同名资源）
3. 不存在 → npx wrangler d1 create <worker>-asset-db
4. 拿到 database_id → 用正则替换 wrangler.jsonc 里 d1_databases[0].database_id 的占位值
5. 幂等：重复执行不会重复建库、不会重复写配置
6. 输出：库名 + database_id + "已更新 wrangler.jsonc"
```

设计要点：
- **`wrangler.jsonc` 里必须预置占位值**（Deploy to Cloudflare 按钮也要求如此）：
  ```jsonc
  {
    "name": "asset-manager",
    "main": "src/worker/index.ts",
    "compatibility_date": "2026-09-20",
    "assets": {
      "directory": "./dist",
      "binding": "ASSETS",
      "not_found_handling": "single-page-application",
      "run_worker_first": ["/api/*"]
    },
    "d1_databases": [
      { "binding": "DB", "database_name": "asset-manager-db", "database_id": "REPLACE_ME" }
    ]
  }
  ```
- 脚本要处理 `wrangler.jsonc`（JSONC 带注释）→ 用正则替换 id 字符串最稳，不要 JSON.parse（会丢注释）
- 本地开发不碰生产配置：另建 `wrangler.dev.jsonc`，用本地 D1（miniflare 的 `.wrangler/state`），带假 id 即可

---

## 4. 目录结构（对齐 SubsTracker 的分层，前后端同仓）

```
asset-manager/
├── package.json                 # scripts + cloudflare.bindings 说明
├── wrangler.jsonc               # 生产配置（含占位 database_id）
├── wrangler.dev.jsonc           # 本地开发配置
├── .dev.vars.example            # 声明需要的 secrets（部署向导读它）
├── scripts/
│   ├── setup-d1.cjs             # 查/建 D1 + 注入 database_id
│   ├── setup-secrets.cjs        # 生成 SETUP_TOKEN / SESSION_SECRET 并 wrangler secret put
│   └── deploy-safe.cjs          # 串联全流程 + 打印下一步
├── migrations/                  # D1 官方迁移
│   └── 0001_init.sql
├── src/
│   ├── worker/
│   │   ├── index.ts             # fetch + scheduled 入口
│   │   ├── app.ts               # Hono 装配（中间件：migrate 检查/日志/认证/错误兜底）
│   │   ├── api/                 # auth / accounts / holdings / history / settings / backup
│   │   ├── core/                # auth(KDF 校验、会话)、audit、fx、errors
│   │   ├── data/                # repo 层（accounts.repo.ts / holdings.repo.ts / ...）
│   │   └── services/            # 业务编排（portfolio 聚合、备份导入导出）
│   └── web/                     # React + Vite（构建产物 dist/）
├── public/                      # 图标 sprite 等原样拷贝的静态资源
├── tests/
│   ├── api/                     # 路由级（Vitest + pool-workers）
│   ├── core/
│   └── services/
├── .github/workflows/deploy.yml
├── README.md
└── LICENSE                      # MIT
```

---

## 5. 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars      # 本地随便填
npm run dev                          # vite dev + wrangler dev（Cloudflare Vite 插件）
npm run db:migrate:local             # wrangler d1 migrations apply DB --local
npm test                             # vitest run（pool-workers，真实 workerd 运行时）
npm run lint                         # tsc --noEmit
```

本地不需要任何云端资源，D1 走 miniflare 本地文件（`.wrangler/state`），**不消耗线上免费额度**。

---

## 6. README 结构（对齐 SubsTracker）

```
# Asset Manager — 个人资产管理
[Deploy to Cloudflare 按钮]
一句话简介 / 截图 / 功能亮点

## 🚀 5 分钟上手
部署 → 初始化（填 setup token → 设密码）→ 建账户 → 录持仓 → 看饼图

## 📦 部署（二选一）
### 方式一：一键部署按钮（推荐，Cloudflare 自动建 D1 + 向导里填 SETUP_TOKEN）
### 方式二：命令行 npm run deploy:safe（自动建 D1 + 应用迁移 + 生成 secret + 打印 URL）
（附录：想自建 CI 的人可参考的 GitHub Actions yml）
（含：需要哪些 Secret、API Token 权限清单）

## ✅ 第一次必做配置
1. 用 setup token 完成初始化并设置密码
2. 设置显示币种（默认 USD）+ 汇率
3. 建立第一个账户（选平台图标）
4. 录入持仓（数量 / 价格 / 平均成本）
5. 导出一份备份

## 📋 日常怎么用
（账户/持仓/批量更新价格/筛选/审计历史）

## 💾 备份与迁移
（导出 JSON / 导入合并 / 导入覆盖 / wrangler d1 export / Time Travel 7 天）

## 🔐 忘记密码怎么办
Dashboard → Workers & Pages → D1 → asset-manager-db → Console:
  DELETE FROM auth;
然后重跑 npm run setup:secrets，用新 token 重新初始化。

## 🧩 功能一览 / 工作原理（架构图 + 免费额度说明）

## ❓ FAQ（预计 10~15 条，抄 SubsTracker 的密度）
- 部署时报 Authentication error [code: 10000]
- 为什么没有行情/走势图？→ v1 不做，见 PRD TODO
- 为什么改汇率后数字都变了？→ v1 已知限制
- 为什么设置页的"外部行情"开关点了没反应？→ 下个版本
- 会不会超免费额度？→ 给出实测用量与限额对比
- 忘记 setup token
- 如何升级 / 迁移到另一个 Cloudflare 账号

## 🔄 升级（git pull → npm install → npm run deploy:safe）
## 🛠 开发（命令 + 目录说明）
## 🔐 安全提醒
## 📄 License (MIT)
```

---

## 7. 与 SubsTracker 的关键差异（都是有意的）

| 项 | SubsTracker | 本项目 | 原因 |
|---|---|---|---|
| 存储 | KV（单 Key 存 JSON） | **D1（SQLite）** | 需要按类别/账户/币种聚合、排序、分页；KV 做不了 |
| 初始化 | 默认 `admin/password` | **setup token + 用户自设密码** | 默认密码在公网等于没有密码 |
| 数据迁移 | 自研 `ensureMigrations`（幂等 + 锁 + 备份） | **D1 官方 migrations** | 官方工具链更可靠，且有 Time Travel 兜底 |
| 前端 | 服务端 HTML 模板 + vanilla JS（无构建） | **React + Vite（有构建，但被脚本隐藏）** | 可视化交互复杂度完全不同（多维筛选联动 / treemap / 排序表格） |
| 主密码保管 | KV 明文可读可改 | **只存不可逆 verifier** | 个人财务数据 |
| 备份 | 全部数据在 KV，导出即 JSON | 关系表 → 导出需跨表组装 | 增加 schema_version 与导入事务 |

---

## 8. 决策已定稿（v1.4）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 仓库是否公开 | ✅ **公开**，MIT；别人可 fork 到自己 Cloudflare 自己用 |
| 2 | 前端是否保留构建步骤 | ✅ **保留**：React + Vite + TS（详见 PRD §15.2 的对比） |
| 3 | 是否使用 Workers Builds | ✅ **用**，作为一键按钮与 push 自动部署的执行体；不自建 Actions |
| 4 | setup token 的传递 | 按钮路径：**向导自填**（主）；CLI 路径：脚本生成 + 终端打印（备）；任何路径均不得把 token 写进 CI 日志 |

> 结论：**部署体验完全可以做到和 SubsTracker 一样（甚至更好）**，因为我们额外拿到了官方"一键部署按钮 + 自动 provision D1 + Secrets 向导"这套能力。唯一需要多写代码的地方是 `setup-d1.cjs` 与 `setup-secrets.cjs` 两个脚本，合计约 150 行。
