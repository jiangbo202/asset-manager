# 安全模型

> 这是一个**单用户、个人自用**的记账工具。本文说明它防住了什么、没防住什么，
> 以及如果你要把它暴露在公网应该注意什么。

---

## 1. 威胁模型

| 场景 | 是否在防护范围 |
|---|---|
| 公网上的陌生人猜到你部署的网址 | ✅ 需要密码才能看到任何数据 |
| 部署后被你以外的人抢先完成初始化 | ✅ 初始化需要部署时生成的一次性 setup token |
| 数据库文件（D1）泄露 | ✅ 密码只有不可逆校验值；API Key 加密存储 |
| 暴力破解密码 | ✅ 连续 5 次失败锁定 15 分钟 |
| 会话被窃取后长期有效 | ✅ 会话可全部吊销；改密码会吊销其它设备 |
| 有人拿到你的浏览器（已登录状态） | ❌ 等同于拿到密码（任何 Web 应用都如此） |
| 你的 Cloudflare 账号被攻破 | ❌ 攻击者可直接读 D1 |
| 你部署了带后门的第三方 fork | ❌ 请在部署前阅读代码差异 |

## 2. 认证设计

```
初始化 / 改密码（浏览器）:
  key = PBKDF2-SHA256(password, kdfSalt, 300_000)      ← 重活全在浏览器
Worker:
  verifier = SHA-256(key ‖ verifierSalt)               ← 单次哈希 ≈0.1ms
  只存 verifier / kdf_salt / verifier_salt

登录（浏览器）:
  GET /api/auth/params → {kdfSalt, iterations}
  key = PBKDF2-SHA256(password, kdfSalt, iterations)
  POST /api/auth/login { credential: key }
Worker:
  timingSafeEqual(SHA-256(credential ‖ verifierSalt), verifier)
```

### 为什么把 KDF 放在浏览器

Cloudflare Workers 免费版有 **10ms CPU/请求**的硬限制（Paid 才能提高）。
服务端跑高迭代 PBKDF2 很容易触顶并返回 502，所以把昂贵的派生放到浏览器（不受限），
Worker 只做一次 SHA-256。

### 已知取舍

- 发送到服务端的 `credential` **等价于密码**（pass-the-hash）。防护依赖 HTTPS 与 HttpOnly Cookie。
- 数据库泄露不会直接得到可登录凭据：要拿到它必须逆推 SHA-256 原像（不可行）。
- 若你更希望「服务端持有完整哈希」，唯一在免费版可行的做法是把迭代数降到约 1 万次并强依赖限流，
  安全性反而更低 —— 因此本项目选择当前方案。

### 其它措施

- 会话 Cookie：`am_session`，HttpOnly + SameSite=Lax + Path=/，线上自动加 `Secure`；库里只存 `sha256(token)`
- 登录限流：失败计数与锁定时间存在 `settings`，5 次 → 15 分钟
- 所有写接口校验 `Origin` 与自定义头（CSRF 防护）
- 初始化写入用条件 INSERT，并发下只可能成功一次
- token 与密码都不写日志；审计只记「setup 成功」这类事件

## 3. 密钥与敏感数据

| 数据 | 存放位置 | 保护方式 |
|---|---|---|
| 登录密码 | 不存 | 只存不可逆 verifier |
| `SETUP_TOKEN` | Worker Secret | 跳过初始化后即失效（`/api/auth/setup` 返回 409） |
| `SESSION_SECRET` | Worker Secret | 用于派生加密密钥；泄露需轮换 |
| 第三方行情 API Key | `settings.provider_keys` | AES-GCM 加密（密钥由 `SESSION_SECRET` 派生）；接口从不回传明文；**不进备份**；审计里只写标记 |
| 自定义数据源请求头（可能含 Bearer Token） | `settings.provider_config` | 同样加密与审计脱敏，且**不进备份** |
| 资产数据 | D1 | 依赖 Cloudflare 账号安全 + 你自行导出的备份 |

轮换 `SESSION_SECRET` 的后果：所有会话失效，**已加密的 API Key 需要重新填写**。

## 4. 部署建议

1. **不要用可猜测的 `workers.dev` 子域**；绑自有域名（或至少改成一个随机子域）。
2. 建议叠加 **Cloudflare Access**（Zero Trust 免费版 ≤50 用户）：在 Worker 之前再加一道邮箱 OTP，
   与 App 自带密码互不冲突。
3. 用最小权限 API Token：只给 **Workers 编辑 + D1 编辑**，不要用 Global API Key。
4. 开 Cloudflare 账号的两步验证。
5. 定期导出备份，并把它当密码一样保管（其中包含全部资产数据）。
6. 部署别人的 fork 前先看 diff —— 这个应用的权限就是「读取你的全部资产数据」。

## 5. 安全响应头

`public/_headers` 对所有静态资源生效：

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

`style-src` 允许 `unsafe-inline` 是因为图表用内联样式定位；脚本不允许内联，也不加载任何外部资源。

## 6. 隐私

- 不含分析脚本、不含遥测、不引入第三方字体或 CDN
- 除你主动启用的行情接口外，Worker 不会向外界发起任何请求
- 数据只存在你自己的 Cloudflare 账号里

## 7. 上报漏洞

如果你发现了安全问题，请**不要**直接开 public issue，用以下任一方式：

- 仓库的 GitHub Security Advisory（Security → Report a vulnerability）
- 或先开一个不含细节的 issue，说明希望私下沟通

请在报告里包含：影响、复现步骤、是否需要特定配置。个人项目响应可能较慢，但会认真处理。

## 8. 不在防护范围

- 恶意浏览器扩展、被入侵的终端
- 你的 Cloudflare 账号本身被攻破
- 你主动把 `SETUP_TOKEN` / 密码贴到公开场合
- 第三方行情接口返回的数据正确性（行情仅供便利，价格永远允许手工覆盖）
