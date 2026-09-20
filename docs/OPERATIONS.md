# 运维手册

> 日常会用到的东西：数据库迁移、备份与恢复、升级、限额监控、定时任务、故障处理。
> 部署见 [DEPLOYMENT.md](DEPLOYMENT.md)，本地开发见 [LOCAL_DEV.md](LOCAL_DEV.md)。

---

## 1. 数据库迁移

迁移文件在 `migrations/`，命名 `000N_描述.sql`，**只追加不修改**（D1 靠文件名顺序记录已应用的迁移）。

```bash
npm run db:migrate:local     # 本地
npm run db:migrate:remote    # 线上
npm run deploy:safe          # 部署时会自动带上迁移
```

规则：

- 改结构 → 新建文件；已经部署过的环境只会执行新文件
- 每条语句尽量幂等（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`）
- 涉及新设置项时顺手 `INSERT ... ON CONFLICT DO NOTHING`，并递增 `settings.schema_version`
- 代码里的 `SCHEMA_VERSION`（`src/shared/version.ts`）要与迁移目录的最新版本一致；
  `/api/auth/me` 会比对它，落后时首屏直接提示「数据库需要升级」并给出命令

### 迁移记录与实际结构不一致时

D1 只记录「哪些文件跑过」，不会校验结构。如果有人手工删过表（或从半途失败的迁移里恢复），
可能出现「显示已应用但表不存在」。此时缺表接口会返回 `503 migration_required`；
真正的修法是手工建表或从备份恢复（`wrangler d1 export` 的文件 + `wrangler d1 execute`）。

## 2. 备份与恢复

### 2.1 应用内（日常推荐）

设置 → 备份与恢复：

- **导出**：JSON，可选包含操作历史、可选口令加密（AES-GCM 在浏览器完成，口令不出浏览器）
- **导入**：选择文件 → 「预览差异」（逐实体 新增/覆盖/删除 + 警告）→ 选择合并/覆盖 → 确认

导入行为：

| 项 | 说明 |
|---|---|
| 校验 | format / schemaVersion / 枚举 / 数值范围 / id 唯一 / 引用完整性 |
| 原子性 | ≤1000 条语句时单事务；超出会分批并在预览里提示风险 |
| 幂等 | 历史与审计用 `INSERT OR IGNORE`，重复导入不产生重复行 |
| 审计 | 只追加不删除；replace 导入也会保留历史并追加一条记录 |
| 密码 | 不导出；换环境后需要重新初始化 |

### 2.2 命令行（数据库级）

```bash
# 备份
npx wrangler d1 export DB --remote --output=backup-$(date +%F).sql

# 恢复（会写入语句；建议先看看文件内容）
npx wrangler d1 execute DB --remote --file=backup-2026-09-20.sql
```

### 2.3 Time Travel（免费 7 天）

Dashboard → Workers & Pages → D1 → 选库 → Time Travel，可回滚到过去 7 天任意时间点。
误操作（例如覆盖导入选错了）优先用这个，比重新初始化快得多。

## 3. 升级

```bash
git pull
npm install
npm run deploy:safe
```

- 迁移会自动应用；若页面提示「数据库需要升级」，说明迁移没跑成功，见 §1
- 升级前建议导出一次备份（尤其是跨版本升级）
- fork 用户如改过代码，注意 README 里「第一次必做」是否有新增步骤

## 4. 定时任务（Cron）

- 只有 1 个触发器：**每小时**跑一次（`0 * * * *`）
- 实际干活只在「配置时区里的小时」匹配时发生（默认 22 点，设置页可改）：
  1. 刷新行情（批量接口优先）
  2. 打当日快照
- 同一天不会重复打快照；漏跑的日子会在下一个匹配小时补上
- 手动触发：设置页「立即刷新行情」「立即拍快照」，或在总览页点「更新行情」

排障：设置页「最近运行」会列出最近 10 次的触发方式、更新条数、失败条数与请求数。

## 5. 限额监控

设置 → 数据概览会显示各表行数与免费额度对照。经验值：

| 资源 | 典型值 | 免费额度 |
|---|---|---|
| Workers 请求 | < 1,000/天 | 100,000/天 |
| CPU/请求 | 1–3ms（仪表盘、写操作） | 10ms |
| D1 行读 | < 50,000/天 | 5,000,000/天 |
| D1 行写 | < 100/天 | 100,000/天 |
| D1 存储 | 快照约 1–2MB/年 | 5GB |

> 自 2026-09 起 D1 免费额度超额会**直接返回错误**（当天不可用，UTC 零点重置），所以出现异常时
> 先排除「是不是有人写了循环、或改了查询范围」。

要清理历史数据时（可选）：

```bash
# 看看快照占用
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*), MIN(date), MAX(date) FROM snapshots"
# 删除 3 年前的快照（按需）
npx wrangler d1 execute DB --remote --command "DELETE FROM snapshots WHERE date < '2023-01-01'"
```

审计日志建议保留（它是操作凭证），确实要清可以按年份删。

## 6. 常见故障

| 现象 | 处理 |
|---|---|
| 页面提示「数据库需要升级」 | 跑迁移（§1）；`npm run deploy:safe` 会带上 |
| 忘记密码 | Dashboard → D1 → Console 执行 `DELETE FROM auth;` → `npm run setup:secrets` → 刷新网页重新初始化 |
| 忘记 `SETUP_TOKEN` | 同上；token 只在生成时打印一次 |
| 行情长时间不更新 | 设置页看「最近运行」与数据源冷却状态；免费接口限流属正常，也可填自己的 API Key |
| 走势图某几天是平的 | 那天没有快照，系统沿用前一日并标注；可手动补一条 |
| 提示「缺汇率」 | 设置 → 汇率补上（如 `1 USD = 7.8 HKD`）；或让行情自动抓（需该币种在组合里出现过） |
| 界面还是旧版本 | 浏览器缓存了静态资源；强刷一次（静态资源带 hash，一般不会有这个问题） |
| Worker 返回 502 / `exceededCpu` | 看 `wrangler tail`：若持续超过 10ms，检查是否引入了重计算（大 JSON 解析、循环内查询） |

## 7. 安全事件处理

1. **`SESSION_SECRET` 泄露**：重新 `npm run setup:secrets`（会生成新值）→ 所有会话失效；
   注意：加密存储的第三方 API Key 会解不开，需要重新填写。
2. **密码泄露**：登录后立即在设置页改密码（会吊销其它会话）。
3. **怀疑被人访问**：删除 `sessions` 全表（登出所有设备）+ 改密码；必要时用 Time Travel 回滚数据。
4. **上报漏洞**：见 [SECURITY.md](../SECURITY.md)。

## 8. 数据可带走

应用不锁定你的数据：

- 应用内导出 JSON（业务数据全量）
- `wrangler d1 export` 导出完整 SQLite
- 数据模型见 [ARCHITECTURE.md §4](ARCHITECTURE.md)，字段语义清晰，可自行迁移到其它系统
