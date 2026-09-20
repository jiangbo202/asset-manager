# 本地开发指南

> 目标：**改一行代码 1 秒内看到结果，全程不碰线上数据、不消耗 Cloudflare 免费额度。**

---

## 0. 前置：Node 版本

请用 **Node 20 / 22 / 24（推荐 24 LTS）**。仓库根目录有 `.nvmrc`：

```bash
node -v          # 期望 v24.x 或 v22.x
nvm use          # 读取 .nvmrc
```

Wrangler 与 Vitest 官方支持范围是 `^20 || ^22 || >=24`；Node 23 这类奇数版本会一直报 `EBADENGINE` 警告。

## 1. 一次性准备

```bash
git clone https://github.com/<你的用户名>/asset-manager.git
cd asset-manager
npm install
cp .dev.vars.example .dev.vars     # 本地用的 SETUP_TOKEN / SESSION_SECRET
npm run db:migrate:local           # 给本地 D1 建表
npm run db:seed:local              # 可选：塞一批示例数据，方便看图表
```

## 2. 三种「本地跑起来」的方式

| 方式 | 命令 | 用途 | 特点 |
|---|---|---|---|
| **开发服务器** | `npm run dev` | 日常开发 | Worker 跑在本地 workerd，前端 HMR，改 Worker 代码会热重载且**前端状态不丢**；端口 5173 |
| **生产预览** | `npm run build && npm run preview` | 上线前验证 | 用构建产物在 workerd 里跑，行为与线上几乎一致（含 `_headers` 安全头、SPA 回退）；会自动应用本地迁移 |
| **测试** | `npm test` | 回归验证 | 跑在真实 workerd 运行时，用本地 D1，不是 jsdom 模拟 |

`npm run dev` 起来后：

- 打开 http://localhost:5173
- 首次会进入**初始化页**，`SETUP_TOKEN` 填 `.dev.vars` 里的值（默认 `dev-setup-token-local-only`），然后设置自己的密码
- 登录后就看到仪表盘

> `npm run dev` / `npm run preview` 通过 npm 的 `predev` / `prepreview` 钩子**自动应用本地迁移**，
> 所以 `git pull` 拉到新迁移后直接启动即可。

## 3. 本地数据库操作

```bash
npm run db:migrate:local                    # 应用 migrations/ 下的新迁移
npm run db:reset:local                      # 清空本地数据 + 重新迁移（改 schema 后常用）
npm run db:seed:local                       # 再塞一次示例数据
npm run db:console:local -- "SELECT * FROM holdings"
npm run db:console:local -- "DELETE FROM auth"   # 想重新走一遍初始化流程
npm run db:migrate:preview                  # 给预览用的本地库应用迁移
```

查看表清单：

```bash
npx wrangler d1 execute DB --local --config wrangler.dev.jsonc \
  --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
```

## 4. 调试

| 需求 | 做法 |
|---|---|
| 给 Worker 打断点 | Vite 插件默认开调试端口 **9229**：Chrome → `chrome://inspect` → Configure → `localhost:9229`，然后在 `src/worker/**` 下断点 |
| 看服务端日志 | `npm run dev` 的终端直接打印；线上用 `npx wrangler tail` |
| 看线上 CPU 时间 / 错误 | `npx wrangler tail`（验证免费版 10ms 是否够用的唯一可靠方式） |
| 改前端不刷新页面 | Vite HMR 自动生效；改 Worker 代码时插件会重启 Worker 但保留前端状态 |
| 类型检查 | `npm run lint`（分别检查 web / worker / 配置文件 / 测试四套 tsconfig） |
| 全套检查 | `npm run verify`（lint + test + build + 首包体积） |
| 跑单个测试 | `npx vitest run tests/api/portfolio.test.ts` |

## 5. 改动约定

| 场景 | 要做什么 |
|---|---|
| 加了新的用户可见文案 | 在 `src/shared/locales/zh.ts` 与 `en.ts` **各加一条**（测试会断言两种语言 key 完全对齐） |
| 改了数据库结构 | **新增** `migrations/000N_xxx.sql`，不要改已上线的文件；本地 `npm run db:migrate:local` |
| 加了新页面 | 在 `src/web/App.tsx` 里用 `React.lazy` 懒加载，并跑 `npm run check:bundle` 确认体积 |
| 引入第三方库 | 先想清楚能否手写或动态 import —— 运行时依赖目前只有 hono + react + react-dom |
| 新增接口 | 在 `src/worker/api/` 下加路由，写进 `docs/PRD.md` 的 FR 表，补 `tests/api/` 断言 |
| 改了行为 | 同步更新 `README.md` / `docs/PRD.md` / `docs/ARCHITECTURE.md` 里对应的描述 |

## 6. 目录速查

```
src/worker/           Worker（Hono + D1）
  index.ts            fetch / scheduled 入口
  app.ts              中间件装配（语言、会话、错误兜底、安全头）
  api/                HTTP 路由 + 校验
  core/               会话、凭据校验、审计、密钥加密、i18n
  data/               repo 层（SQL 只写在这里）
  services/           业务编排（组合聚合、快照、行情、备份、调度）
src/web/              前端（React）
  lib/                api / i18n / router / format / charts / trend / icons / crypto
  pages/              页面
  components/         可复用组件
src/shared/           前后端共用：类型、枚举标签、i18n 字典、时区工具
migrations/           D1 迁移
scripts/              部署与本地开发脚本
tests/                Vitest（api 集成 + services 单测）
```

## 7. 常见问题

**Q：报 `You installed workerd on another platform`**
`node_modules` 是用另一种架构的 node 装的（典型场景：Apple Silicon 上先用 x64 的 node 装过一次，
之后切到 nvm 的 arm64 node）。修法：

```bash
rm -rf node_modules && npm install    # 用你当前要用的那个 node
```

`npm run dev` / `build` / `test` 前会自动跑 `scripts/check-env.cjs`，遇到这种情况会直接告诉你。

**Q：构建报 `ENOTEMPTY` 或 `EACCES`（dist / node_modules）**
这些目录里有不属于当前用户的文件，通常是用 `sudo` 或别的用户跑过安装/构建。修法：

```bash
sudo chown -R $(whoami) node_modules dist .wrangler
```

**Q：`npm install` 警告 "N packages have install scripts not yet covered by allowScripts"**
这是 npm 11.19+ 的供应链保护：默认不自动执行依赖的 postinstall 脚本。
本项目不依赖这些脚本（workerd / esbuild 的平台二进制在各自的平台包里）。
构建与测试都能正常跑就可以忽略；确实需要执行时用 `npm install-scripts approve <pkg>`。

**Q：`npm run dev` 报 `EBADENGINE`**
用 Node 24 LTS（见 §0）。

**Q：初始化时提示 `setup token 不正确`**
`.dev.vars` 里的 `SETUP_TOKEN` 就是答案；或重启 dev server 让它重新加载。

**Q：想重新走一遍初始化**
`npm run db:console:local -- "DELETE FROM auth"`，然后刷新页面。

**Q：页面提示「数据库需要升级 / no such table」**
`git pull` 拉到含新迁移的代码后本地库还是旧结构。跑 `npm run db:migrate:local`（`npm run dev` 现在会自动跑）。

**Q：本地端口被占用**
`npm run dev -- --port 5180`。

**Q：想连线上数据库调试**
`npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) FROM holdings"`（只读查询，别在线上跑写操作）。

**Q：`npm test` 里的测试会不会打真实网络**
不会。行情适配器的测试都注入了假的 `fetch`；只有你手工跑验证脚本时才会走真实接口。
