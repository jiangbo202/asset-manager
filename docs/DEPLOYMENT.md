# 部署指南

> 目标：**一条命令部署到自己的 Cloudflare 账号**，不需要手工创建数据库、改配置文件或点十几次面板。
> 本地开发见 [LOCAL_DEV.md](LOCAL_DEV.md)，日常运维见 [OPERATIONS.md](OPERATIONS.md)。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费版即可（不需要 Workers Paid） |
| Node.js | 20 / 22 / 24（推荐 24 LTS，见 `.nvmrc`） |
| API Token（命令行部署用） | 权限：**Workers 编辑** + **D1 编辑** |
| 域名（可选） | 不绑域名也能用 `*.workers.dev`；绑自有域名更整洁，也便于后续叠加 Cloudflare Access |

> Node 请用偶数版本。奇数版本（如 23）虽然能跑，但 Wrangler 与 Vitest 会持续报 `EBADENGINE` 警告。

## 2. 部署路径

### 路径 A：一键部署按钮（推荐给非开发者）

在 README 顶部点按钮，或直接访问：

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<你的用户名>/asset-manager
```

Cloudflare 会：

1. 把仓库复制到你自己的 GitHub/GitLab 账号（之后可继续开发）
2. 让你在向导里自定义仓库名、Worker 名、**D1 库名**
3. **自动创建 D1 并绑定**，把真实 `database_id` 写回你新仓库的配置
4. 用 Workers Builds 执行 build 与 deploy
5. 从 `.dev.vars.example` 识别需要你填写的两个 Secret：

| Secret | 怎么来 |
|---|---|
| `SETUP_TOKEN` | `openssl rand -hex 32`，**自己留存**，首次打开网页要用 |
| `SESSION_SECRET` | `openssl rand -hex 32` |

> 这条路径下 token 是你自己填的，所以**不会出现在任何日志里**。

⚠️ **向导里预填的值是仓库公开的示例占位值，必须替换掉。** 如果你直接提交，别人就能用这个已知口令
抢先初始化你的实例。服务端会拒绝用占位值完成初始化（报 `setup_token_placeholder` 并提示
`openssl rand -hex 32`），所以不会出现"悄悄部署出一个不安全实例"的情况——但请一开始就填真随机值。

### 路径 B：命令行

```bash
git clone https://github.com/<你的用户名>/asset-manager.git
cd asset-manager
npm install

export CLOUDFLARE_API_TOKEN=你的token      # Windows: $env:CLOUDFLARE_API_TOKEN="你的token"
npm run deploy:safe
```

`npm run deploy:safe` 的七个步骤：

```
▶ 检查登录状态            wrangler whoami
▶ 创建 / 复用 D1 数据库    scripts/setup-d1.cjs
▶ 构建前端与 Worker        vite build（含 Worker 打包与静态资源）
▶ 应用 D1 迁移（远程）      wrangler d1 migrations apply DB --remote
▶ 部署 Worker             wrangler deploy（自动使用 dist 里的产物配置）
▶ 写入 Secrets            scripts/setup-secrets.cjs（生成并打印 SETUP_TOKEN）
▶ 打印访问地址与下一步
```

顺序不能换，原因：

- `setup:d1` 必须在 build 之前 —— 构建会把配置（含真实 `database_id`）复制进产物
- `secret put` 必须在 deploy 之后 —— Worker 需要已存在
- 迁移必须在 deploy 之前 —— 新代码可能依赖新表

单独执行某一步：

```bash
npm run setup:d1          # 只创建/复用 D1 并写入 database_id
npm run build             # 只构建
npm run db:migrate:remote # 只应用迁移
npm run deploy            # 迁移 + 部署
npm run setup:secrets     # 写入 SETUP_TOKEN / SESSION_SECRET（已存在则不动；轮换加 -- --rotate）
```

### 路径 C：本地预览（不部署，验证行为）

```bash
npm run build && npm run preview     # 用构建产物在 workerd 里跑，接近线上
```

会自动应用本地迁移；行为与线上几乎一致（含 `_headers` 安全响应头与 SPA 回退）。

> **为什么不提供 GitHub Actions 部署？** 路径 A 已经跑在 Workers Builds 上，
> 再维护一份部署 workflow 是重复成本。仓库里的 `.github/workflows/ci.yml` 只做质量检查
> （lint / test / build / 首包体积），不部署。

## 3. 部署脚本做了什么

### `scripts/setup-d1.cjs`

1. 读 `wrangler.jsonc` 里的 Worker 名与库名
2. `wrangler d1 list --json` 按名字查已有库（**只匹配当前项目**，避免误用同名库）
3. 不存在则 `wrangler d1 create`，从输出解析 `database_id`
4. 用正则把 id 写回 `wrangler.jsonc`（不用 JSON.parse，避免丢注释）
5. 幂等：重复执行不会重复建库或改配置

未登录时给出可执行的提示，而不是抛一堆栈。

### `scripts/setup-secrets.cjs`

生成 32 字节随机值并 `wrangler secret bulk` 写入，然后**在终端打印一次** `SETUP_TOKEN`。

它是**幂等**的：先用 `wrangler secret list` 读一下已有的 Secret，已存在的不再覆盖，所以重复部署不会
把 `SESSION_SECRET` 换掉（换掉会让所有登录失效、已保存的行情 API Key 解不开）。需要轮换时显式执行
`npm run setup:secrets -- --rotate`。

在 public 仓库的 CI 里不要运行它（日志公开）；那种场景请改用用户自备的 Secret。

### 配置文件

| 文件 | 用途 |
|---|---|
| `wrangler.jsonc` | 生产配置：Worker 名、`assets.not_found_handling: single-page-application`、D1 绑定（含占位 `database_id`）、每小时 Cron |
| `wrangler.dev.jsonc` | 本地开发/测试：固定占位 `database_id`，本地数据落在 `.wrangler/state`，跑 `setup:d1` 不会影响它 |
| `.dev.vars.example` | 声明需要哪些 Secret（一键部署向导读它）；复制为 `.dev.vars` 用于本地 |

> `database_id` 的占位值 `REPLACE_WITH_YOUR_D1_ID` 是**故意留的**：一键部署按钮要求仓库里有默认值，
> Cloudflare 会替换它；命令行路径由 `setup-d1.cjs` 替换。

## 4. 部署后验证

```bash
# 1. 打开网址，应看到初始化页
# 2. 用 SETUP_TOKEN 完成初始化并设置密码
# 3. 建一个账户 + 一条持仓，看到图表
# 4. 看 Worker 日志与 CPU 时间（关键：确认免费版 10ms 够用）
npx wrangler tail
```

`wrangler tail` 的默认输出**不含 `cpuTime`**，用项目自带的脚本来统计：

```bash
npm run watch:cpu          # 实时打印每次请求的 CPU 时间，Ctrl-C 给出 p50/p95/max
npm run watch:cpu -- --demo   # 先用合成数据看一眼输出格式
```

也可以直接看 `wrangler tail --format json` 的原始事件，或仪表盘的 Metrics → CPU time 曲线。

关注 `cpuTime`：仪表盘与写操作应在 **1–3ms**；偶发超过 10ms 会被 Cloudflare 判为
`exceededCpu` 并返回 502。若持续超标，先看是否有人手动改过代码引入了重计算。

## 5. 自定义域名（可选）

Dashboard → Workers & Pages → 选你的 Worker → Settings → Domains & Routes → Add custom domain。
域名需要在同一个 Cloudflare 账号下。绑自有域名后可以再叠加 Cloudflare Access：

Zero Trust（免费版 ≤50 用户）→ Access → Applications → 添加自托管应用 → 选择你的域名，
即可在 Worker 之前再加一道邮箱 OTP 登录（与 App 自带密码互不冲突）。

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `Authentication error [code: 10000]` | Token 权限不足或未设置。确认含 **Workers 编辑 + D1 编辑**，或改用 `npx wrangler login` |
| `未登录 Cloudflare`（setup-d1 报错） | 同上；脚本会直接告诉你该做什么 |
| 页面提示「数据库需要升级」 | 数据库结构落后于代码。重跑 `npm run deploy:safe`，或单独 `npm run db:migrate:remote` |
| `no such table: xxx` | 同上一行；若迁移记录已存在但表确实丢了（例如手工删过表），需要手工重建或从备份恢复 |
| 初始化时 `setup token 不正确` | 用的是终端最后一次打印的 token；丢失则删掉 `auth` 行 + `npm run setup:secrets -- --rotate` |
| 提示 `SETUP_TOKEN 还是示例里的占位值` | 你在一键部署向导里沿用了默认值。用 `openssl rand -hex 32` 生成新值更新 Secret 后重试（无需改代码） |
| 部署成功但页面 404 | 确认 `wrangler deploy` 读到的是构建产物配置（输出里会写 `Using redirected Wrangler configuration`） |
| 行情一直失败 | 看设置页「最近运行」的失败原因；免费接口偶发限流属正常，系统会自动换源并冷却 |
| 首包体积 CI 失败 | `npm run check:bundle` 会列出各 chunk；大依赖请改成动态 `import()` |

更多日常运维（迁移、备份恢复、限额监控）见 [OPERATIONS.md](OPERATIONS.md)。
