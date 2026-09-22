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

#### A1. 向导里怎么点

Cloudflare 会打开 **Create an app → Set up your application**，一共三步：

| 界面元素 | 怎么选 |
|---|---|
| **Git account** → `New GitHub connection` | 点它，在 GitHub 上授权 Cloudflare Workers（可选择只授权这个仓库） |
| `Create private Git repository` | 建议勾上：这是私人记账应用，仓库虽然不含任何数据与密钥，但也没必要公开 |
| **Project name** | 填 `asset-manager`（会成为 Worker 名与 `asset-manager.<你的子域>.workers.dev` 地址） |
| **Deploy** | 点它，Cloudflare 会把仓库复制到你的账号、建好 Workers Builds 项目并开始首次构建（1–3 分钟） |

> 这一步**只做克隆仓库 + 建构建项目**。数据库、密钥都还没配好，所以部署完成后直接打开网址
> 会看到报错或"数据库需要升级"——按下面 A2 补完即可。

#### A2. 部署后必须补的三件事

| # | 做什么 | 在哪做 |
|---|---|---|
| 1 | **D1 数据库**：向导会按 `wrangler.jsonc` 里的绑定自动创建 D1，并把真实 `database_id` 回写进你新仓库的配置 —— 通常**这一步已经替你做完**（构建日志里出现形如 `4f191450-…` 的 id 就是证据）。若日志报找不到 D1，就去控制台 → **Storage & Databases → D1** 建一个，再回 Worker → **Settings → Bindings** 加 D1 绑定，**变量名必须是 `DB`**，并把 id 写回 `wrangler.jsonc` | 控制台 + 仓库 |
| 2 | **建表**：`npm run db:migrate:remote`（需要 `CLOUDFLARE_API_TOKEN`，权限 Workers 编辑 + D1 编辑）。想一劳永逸可以在 **Settings → Build → Deploy command** 里把 `npx wrangler deploy` 改成 `npm run deploy` —— 它会在每次部署前自动跑迁移 | 本地终端 或 Builds 设置 |
| 3 | **两个密钥**：Worker → **Settings → Variables and Secrets** 添加（都选 *Secret* 类型）`SETUP_TOKEN` 与 `SESSION_SECRET`，各自用 `openssl rand -hex 32` 生成。**`SETUP_TOKEN` 要记好**，首次打开网页时要用它完成初始化 | 控制台 |

缺第 3 步会怎样：页面能打开，但点了初始化会收到 500 与一条明确的提示（`SETUP_TOKEN` / `SESSION_SECRET`
未配置或仍是示例值）—— 这是有意设计的，避免部署出一个"用公开默认口令就能接管"的实例。

#### A3. 首次打开

1. 访问 `https://<Worker 名>.<你的子域>.workers.dev`
2. 粘贴 `SETUP_TOKEN` → 设置自己的登录密码（可用页面上的「生成随机密码」）
3. 进入「设置」确认显示币种与时区 → 回「账户」开始记

#### A2b. 首次构建就失败怎么办

构建命令是 `npm run build`，它会先跑一个环境体检（`check:env`）。体检只提示环境问题，
不含任何构建逻辑，所以绕过它不会漏掉构建步骤：

```
Worker → Settings → Build → Build command 改成：npx vite build
```

另一条路是把上游的修复拉到你的仓库里（见下方"部署之后如何更新"）。两种都可以，改完点 **Retry deployment**。

#### A2c. 部署之后如何更新

一键部署是**在你点击的那一刻把仓库复制一份**给你，所以上游后续的修复不会自动流过去。
一条命令跟进：

```bash
npm run update:upstream
git push      # Workers Builds 自动重新构建部署（推送即部署）
```

细节、冲突处理与手动做法见 **[6. 从上游更新](#6-从上游更新)**。

#### A4. 重测一键部署：先清干净

向导是**从零创建资源**的，所以重测前要把上一次留下的东西删掉，否则会撞重名（仓库已存在、
Worker 名被占用）。三样都要删，顺序无所谓：

| 删什么 | 在哪删 | 不删会怎样 |
|---|---|---|
| GitHub **仓库** | 你新账号里那个副本 → Settings → 最下方 Danger Zone → Delete this repository | 向导建同名仓库失败（或你得改名） |
| **Worker**（含 Workers Builds 项目） | 控制台 **Workers & Pages** → 选中它 → Settings → 最下方 Delete | 新部署会尝试覆盖旧的，构建配置可能沿用旧的 |
| **D1 数据库** | 控制台 **Storage & Databases → D1** → 选中它 → Settings → Delete | 账号里留下一堆没用的库（免费额度里也算配额） |

不用动的：Cloudflare 账号本身、GitHub 上给 Cloudflare Workers 的授权（留着还能少点几次授权）。

删完再点一次 Deploy to Cloudflare，按 A1 走一遍即可。

#### A5. 验收清单（重测时照着勾）

- [ ] 向导三个字段填完 → 点 **Deploy**，构建日志里**没有** `Failed: error occurred while running build command`
- [ ] 构建日志里能看到形如 `4f191450-…` 的 id → 说明 D1 已自动创建并回写
- [ ] 构建日志末尾出现 `Deployed … workers.dev` 之类的地址
- [ ] 把 **Deploy command** 改成 `npm run deploy`（否则下一步首页会报"数据库需要升级"）
- [ ] 加 `SETUP_TOKEN` / `SESSION_SECRET` 两个 Secret，再 Retry 一次部署
- [ ] 打开 `https://<项目名>.<子域>.workers.dev` → 看到初始化页（不是报错页）
- [ ] 用 `SETUP_TOKEN` 完成初始化 → 能进「设置」，D1 用量能读出来
- [ ] （可选）打开「公开只读分享」→ 用无痕窗口看总览 → 点「更新行情」应被拒绝

#### 一键部署的取舍

| | 一键按钮 | 命令行（路径 B） |
|---|---|---|
| 需要本地环境 | 不需要 | 需要 Node 20/22/24 |
| D1 / 迁移 / 密钥 | 要自己补（见 A2） | `npm run deploy:safe` 一次做完 |
| 后续更新 | push 到你的仓库即自动部署 | 本地再跑一次 `npm run deploy:safe` |

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

## 6. 从上游更新

一键部署出来的仓库是**一次快照**，上游的新提交不会自动流过去 —— 这是所有模板/脚手架类项目的固有行为。
仓库提供了一个命令来做这件事：

```bash
npm run update:upstream
# 上游地址默认取 package.json 的 repository；也可显式指定：
npm run update:upstream -- https://github.com/<上游作者>/asset-manager.git
```

它按顺序做这些事，每一步都会打印出来：

1. 检查工作区是否干净（脏工作区上做合并很难回退）→ 不干净就停下并告诉你 `commit` 或 `stash`
2. 加/更新 `upstream` remote（本地路径也可以，方便内网镜像）
3. `git fetch upstream`
4. **先列出将要合并的提交**（最多 20 条），再执行 `git merge upstream/main`
5. 若冲突里包含 `wrangler.jsonc` → 自动保留你的版本（你有真实 `database_id`，上游是占位值）；
   其它冲突会列出文件名并停下，让你解决或 `git merge --abort`

完成后把结果推上去，Workers Builds 会自动重新构建部署：

```bash
git push
```

升级前建议导出一份备份。**这次更新若带数据库迁移**：

- Builds 的 **Deploy command** 是 `npm run deploy` → 自动跑，无需操作
- 否则本地跑一次 `npm run db:migrate:remote`

手动做法（不想用脚本、或想保留自己的改动）等价于：

```bash
git remote add upstream https://github.com/<上游作者>/asset-manager.git
git fetch upstream
git merge upstream/main          # 冲突时保留你的 wrangler.jsonc
```

> fork 出来的仓库还有个更省事的办法：GitHub 仓库页的 **Sync fork → Update branch** 按钮。

## 7. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `Authentication error [code: 10000]` | Token 权限不足或未设置。确认含 **Workers 编辑 + D1 编辑**，或改用 `npx wrangler login` |
| `未登录 Cloudflare`（setup-d1 报错） | 同上；脚本会直接告诉你该做什么 |
| 页面提示「数据库需要升级」 | 数据库结构落后于代码。重跑 `npm run deploy:safe`，或单独 `npm run db:migrate:remote` |
| `no such table: xxx` | 同上一行；若迁移记录已存在但表确实丢了（例如手工删过表），需要手工重建或从备份恢复 |
| 初始化时 `setup token 不正确` | 用的是终端最后一次打印的 token；丢失则删掉 `auth` 行 + `npm run setup:secrets -- --rotate` |
| 提示 `SETUP_TOKEN 还是示例里的占位值` | Secret 没设或沿用了示例值。用 `openssl rand -hex 32` 生成后，在 Worker → Settings → Variables and Secrets 里更新（无需改代码） |
| 一键部署后初始化报 500「未配置密钥」 | 走 A2 第 3 步：补 `SETUP_TOKEN` 与 `SESSION_SECRET` 两个 Secret |
| 一键部署后构建日志报找不到 D1 / `database_id` | 走 A2 第 1 步：建 D1 并把真实 id 写回 `wrangler.jsonc`（仓库里是占位值 `REPLACE_WITH_YOUR_D1_ID`） |
| 构建日志提示属主检查失败 | 已只在本地生效（CI 会跳过该检查）；如果你在自己机器上遇到，按提示 `sudo chown -R $(whoami) .` |
| 构建日志里出现 `database_id 是具体值…不是占位值` | 只是提示，不影响构建。你**自己的副本**里就应该填真实 id（一键部署向导回写的也是真实 id）；这条提示留给模板维护者，提醒别把真实 id 提交回上游仓库 |
| 部署成功但页面 404 | 确认 `wrangler deploy` 读到的是构建产物配置（输出里会写 `Using redirected Wrangler configuration`） |
| 行情一直失败 | 看设置页「最近运行」的失败原因；免费接口偶发限流属正常，系统会自动换源并冷却 |
| 首包体积 CI 失败 | `npm run check:bundle` 会列出各 chunk；大依赖请改成动态 `import()` |

更多日常运维（迁移、备份恢复、限额监控）见 [OPERATIONS.md](OPERATIONS.md)。
