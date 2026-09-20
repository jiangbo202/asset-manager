# 本地开发指南

> 目标：**改一行代码 1 秒内看到结果，全程不碰线上数据、不消耗 Cloudflare 免费额度。**
> 关联：`README.md`、`docs/PRD.md`、`docs/DEPLOYMENT.md`

---

## 0. 前置：Node 版本

请用 **Node 20 / 22 / 24（推荐 24 LTS）**。Wrangler 与 Vitest 官方声明的支持范围是 `^20 || ^22 || >=24`，
Node 23 这类奇数版本会一直报 `EBADENGINE` 警告（能用但不保证）。

```bash
node -v          # 期望 v24.x 或 v22.x
# 用 nvm 切换：
nvm install 24 && nvm use 24
```

## 1. 一次性准备

```bash
git clone <你的仓库地址> asset-manager
cd asset-manager
npm install
cp .dev.vars.example .dev.vars     # 本地用的 SETUP_TOKEN / SESSION_SECRET
npm run db:migrate:local           # 给本地 D1 建表
npm run db:seed:local              # 可选：塞一批示例数据，方便看图表
```

## 2. 三种"本地跑起来"的方式

| 方式 | 命令 | 用途 | 特点 |
|---|---|---|---|
| **开发服务器** | `npm run dev` | 日常开发 | Worker 跑在本地 workerd，前端 HMR，改 Worker 代码会热重载且**前端状态不丢**；端口 5173 |
| **生产预览** | `npm run build && npm run preview` | 上线前验证 | 用构建产物在 workerd 里跑，行为与线上几乎一致（含 `_headers` 安全头、SPA 回退）；会自动应用本地迁移 |
| **单元/集成测试** | `npm test` | 回归验证 | 跑在真实 workerd 运行时，用本地 D1，不是 jsdom 模拟 |

`npm run dev` 起来后：

- 打开 http://localhost:5173
- 首次会进入**初始化页**，`SETUP_TOKEN` 填 `.dev.vars` 里的值（默认 `dev-setup-token-local-only`），然后设置自己的密码
- 登录后就看到仪表盘

> 本地数据全部落在 `.wrangler/state/`（已被 git 忽略）。
> `npm run setup:d1` 会改写 `wrangler.jsonc` 的 database_id，但**不会影响本地数据**——因为
> 本地开发用的是 `wrangler.dev.jsonc`，里面的 id 固定为 `local-dev-db`。

## 3. 本地数据库操作

```bash
npm run db:migrate:local                    # 应用 migrations/ 下的新迁移
npm run db:reset:local                      # 清空本地数据 + 重新迁移（改 schema 后常用）
npm run db:seed:local                       # 再塞一次示例数据
npm run db:console:local -- "SELECT * FROM holdings"
npm run db:console:local -- "DELETE FROM auth"   # 想重新走一遍初始化流程
```

查看本地库里的表：

```bash
npx wrangler d1 execute DB --local --config wrangler.dev.jsonc \
  --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
```

## 4. 调试

| 需求 | 做法 |
|---|---|
| 给 Worker 打断点 | Vite 插件默认开调试端口 **9229**：Chrome → `chrome://inspect` → Configure → `localhost:9229` → 在 `src/worker/**` 里下断点 |
| 看服务端日志 | `npm run dev` 的终端会直接打印；线上用 `npx wrangler tail` |
| 看线上 CPU 时间 / 错误 | `npx wrangler tail`（这是验证"免费版 10ms CPU 够不够"的唯一可靠方式） |
| 改前端不刷新页面 | Vite HMR 自动生效；改 `src/worker/**` 时插件会重启 Worker 但**保留前端状态** |
| 类型检查 | `npm run lint`（分别检查 web / worker / 配置文件三套 tsconfig） |
| 测试单文件 | `npx vitest run tests/api/portfolio.test.ts` |

## 5. 目录结构速查

```
src/worker/           Worker（Hono + D1）
  index.ts            fetch / scheduled 入口
  app.ts              中间件装配（会话解析、错误兜底）
  api/                HTTP 路由（auth / accounts / holdings / portfolio / settings / history）
  core/               会话、凭据校验、审计、工具函数
  data/               repo 层（SQL 都写在这里）
  services/           业务编排（组合聚合等）
src/web/              前端（React）
  lib/                api / crypto / charts / router / format
  pages/              页面
src/shared/           前后端共用：枚举标签、API 类型
migrations/           D1 迁移（官方 migrations，部署时自动应用）
scripts/              部署与本地开发脚本
tests/                Vitest（跑在 workerd 里）
```

## 6. 常见问题

**Q：`npm run dev` 报 `EBADENGINE`**
用 Node 24 LTS（见 §0）。

**Q：初始化时提示 `setup token 不正确`**
`.dev.vars` 里的 `SETUP_TOKEN` 就是答案；或重启 dev server 让它重新加载。

**Q：想重新走一遍初始化**
`npm run db:console:local -- "DELETE FROM auth"`，然后刷新页面。

**Q：页面提示"数据库需要升级 / no such table"**
`git pull` 拉到含新迁移的代码后，本地库还是旧结构。跑 `npm run db:migrate:local` 即可（`npm run dev` 现在会自动跑）。
线上对应 `npm run db:migrate:remote` 或重新执行 `npm run deploy:safe`。

**Q：改了 `migrations/0001_init.sql`（还没上线）**
直接改文件 + `npm run db:reset:local`。
**如果迁移已经上线**，不要改旧文件，新建 `migrations/0002_xxx.sql`（D1 靠文件名顺序记录已应用的迁移）。

**Q：本地端口被占用**
`npm run dev -- --port 5180`。

**Q：想连线上数据库调试**
`npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) FROM holdings"`（只读查询，别在线上跑写操作）。
