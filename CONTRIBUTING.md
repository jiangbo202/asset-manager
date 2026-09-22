# 贡献指南

感谢愿意参与。这是一个**个人自用的小工具**，所以欢迎一切能让它更可靠、更好用的改动；
但它有明确的边界（见 [PRD §1.2](docs/PRD.md)），请先读一遍再动手。

---

## 1. 开始之前

| 你想做的事 | 建议先做什么 |
|---|---|
| 报 bug | 用 issue 模板，附上复现步骤与 `wrangler tail` 的相关日志 |
| 提功能 | 先开 issue 说清场景与预期，避免写完才发现不在范围内 |
| 改代码 | 先跑通本地环境（[LOCAL_DEV.md](docs/LOCAL_DEV.md)），再小步提交 |

**明确不接受的方向**：多用户/协作、投资建议类功能、引入重型前端依赖、接入需要付费的服务。

## 2. 本地环境

```bash
git clone https://github.com/<你的用户名>/asset-manager.git
cd asset-manager
npm install
npm run setup:repo -- <你的GitHub用户名>   # 把文档/徽章里的仓库地址换成你自己的（省略用户名则从 git remote 推断）
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

Node 版本见 `.nvmrc`（24 LTS）。

## 3. 提交前必须通过

```bash
npm run verify        # lint + test + build + 首包体积
```

等价于 CI（`.github/workflows/ci.yml`）会跑的检查。四项都过了再提 PR。

## 4. 代码约定

**架构边界**

- SQL 只写在 `src/worker/data/`（仓储层）；业务编排放 `src/worker/services/`
- 路由只做参数校验与编排，不写 SQL、不做聚合计算
- 前后端共用类型放 `src/shared/`（`api-types.ts`、`labels.ts`、`i18n.ts`、`time.ts`）

**依赖纪律**

运行时依赖目前只有 `hono` / `react` / `react-dom`。新增依赖前请先考虑：

1. 能不能手写？图表、treemap、走势图、时区换算、i18n **都是手写的**
2. 能不能只在需要时 `import()`？页面已经全部懒加载，新增大依赖请同样处理
3. 加了之后首包会不会超预算？`npm run check:bundle` 会给答案

**数据库**

- 改结构：**新建** `migrations/000N_描述.sql`，不要改已上线的文件
- 新设置项：`INSERT ... ON CONFLICT DO NOTHING` 给默认值，并递增 `settings.schema_version`
- 同步更新 `src/shared/version.ts` 里的 `SCHEMA_VERSION`

**文案与国际化**

- 所有用户可见文案走 `t("key")`；新增 key 必须在 `src/shared/locales/zh.ts` 与 `en.ts` **各加一条**
  （测试会断言两种语言的 key 完全对齐，漏翻直接失败）
- 服务端提示用「字段名 key + 消息模板」组合（见 `src/worker/api/validate.ts`），不要拼中文字符串

**时间与时区**

- 存储一律 UTC ISO 字符串
- 「哪一天 / 几点」用 `src/shared/time.ts` 的 `dateIn` / `hourIn` / `zonedDayRange`，不要用 `toISOString().slice(0,10)`

**测试**

- 新行为要带断言；bug 修复先写一个能复现的用例
- 测试跑在真实 workerd 运行时（`@cloudflare/vitest-plugin`），可以放心用 `env.DB`
- 不要在测试里打真实网络：适配器测试请注入假的 `fetch`（参考 `tests/services/providers.test.ts`）

## 5. 提交与 PR

- 提交信息用中文或英文都行，但请写清「为什么」而不只是「改了什么」
- 一个 PR 只做一件事；重构与新功能不要混在一起
- PR 描述里说明：动机、做法、影响面（是否涉及迁移/文案/体积），并附验证方式
- 界面改动请附截图（深色/浅色、窄屏各一张更好）

## 6. 文档

改了行为就同步改文档，避免文档与实现脱节：

| 文档 | 什么时候需要改 |
|---|---|
| `README.md` | 功能、部署步骤、FAQ、路线图有变化 |
| `README.en.md` | 与 `README.md` 同步；只改中文或只改英文会导致两份不一致 |
| `docs/pic/*.png` | 界面截图（两版 README 共用）；改名或删图会被 `npm run check:scripts` 拦下 |
| `docs/PRD.md` | 需求或验收标准变化（新增 FR / 决策） |
| `docs/ARCHITECTURE.md` | 数据模型、模块划分、关键算法、体积预算变化 |
| `docs/DEPLOYMENT.md` | 部署脚本或路径变化 |
| `docs/LOCAL_DEV.md` | 本地开发流程、脚本命令变化 |
| `docs/OPERATIONS.md` | 迁移、备份、升级、排障方式变化 |
| `SECURITY.md` | 认证、密钥、权限模型变化 |

再加一条**口径**规矩：新增"用到持仓的统计"（占比、盈亏、新鲜度、告警…）时，
先看一眼 `tests/api/cash-rules.test.ts` —— 现金（价格恒为 1、无行情、无成本）该不该
进这个统计，在那里列出并补一条断言。这个坑已经踩过三次（未填成本、价格新鲜度、停更告警）。

## 7. 发布节奏

没有固定节奏。维护者会在确认成本与体积都在预算内、测试全绿后合并与部署。
`npm run verify` 通过是合并的前提。

## 8. 许可证

提交即表示你同意以 [MIT](LICENSE) 分发你的贡献。
