# asset-manager · personal asset tracker

[简体中文](README.md) | **English**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![93 KB gzip first load](https://img.shields.io/badge/first%20load-93%20KB%20gzip-blue)](#-does-it-stay-within-the-free-tier)

**Every account, one page.** Stocks, ETFs, crypto and cash in a single view; one click refreshes quotes and
recomputes your total and unrealised P&L — no more logging into each broker to check.

Single user, password login, data stays in your own Cloudflare account, and it runs inside the free tier.
No telemetry, no third-party CDN, no UI or chart library — fork it and change whatever you like.

## 📸 Screenshots

### Overview · key figures and net-worth trend

![Overview](docs/pic/account_total.png)

### Overview · breakdown and holdings table

![Breakdown and holdings](docs/pic/have.png)

### Holdings · entry and bulk price update

![Holdings](docs/pic/position.png)

### Accounts · built-in platform icons

![Accounts](docs/pic/add_account.png)

## ✨ What it does

**Bookkeeping**

- Accounts (broker / exchange / cash, with market, currency, note, archive) and holdings (stock / ETF /
  crypto / fund / cash)
- Average-cost P&L; archiving, bulk price updates, the same symbol split across accounts
- Type a symbol and it fills in name / currency / market, with one-click price fetching

**Seeing the picture**

- Donut chart (class / account / currency / instrument, click a slice to filter) plus a drill-down treemap
  that can merge the same symbol across accounts
- Daily net-worth trend (switchable range, total or stacked by class) and a sortable holdings table
- Filters live in the URL: reload, bookmark or share and you get the same view back

**Quotes**

- Free public APIs by default, **zero configuration**; several providers are tried in order and the reason
  for each failure is shown
- Batch endpoints preferred, rate limits cool a provider down and switch to the next one; bring your own
  API keys (encrypted) or point the custom provider anywhere
- Missing FX rates are labelled “not converted” instead of silently using 1:1; stablecoins (USDT/USDC, …)
  are treated as 1:1 USD

**History and automation**

- Activity history: every write is recorded, the list shows what changed and what it was, expand for a
  field-level diff
- Daily snapshots via Cron: refresh quotes at your hour, then take the day's net worth; FX rates are frozen
  per day so editing a rate later never shifts the historical curve
- Backup: export JSON (optionally with history, optionally passphrase-encrypted); imports are validated and
  diffed before anything is written
- Sessions: every signed-in device with OS / browser / IP / last active, “this device” marked, sign-out per device
- Cloudflare usage: today's Worker requests and D1 rows read/written against the free-tier limits

**Other**

- Public read-only link (off by default) with **per-section sharing** (top / trend / breakdown / holdings);
  the trimming happens server-side, so unshared quantities and costs never reach the response
- Chinese and English, configurable time zone (UTC by default); responsive layout

## 🚀 Deployment in 5 minutes

**What you do not have to do**: creating D1, applying migrations, writing secrets, building and deploying are
all handled by the script or the wizard. Only the steps below need a human (accounts, authorisation, passwords).

### Path A: one-click deploy (no terminal)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiangbo202/asset-manager)

| # | Manual step | Where |
|---|---|---|
| 1 | Click the button above | this page |
| 2 | Click `New GitHub connection` and authorise Cloudflare Workers on GitHub | wizard |
| 3 | Recommended: tick “Create private Git repository”; project name `asset-manager` | wizard |
| 4 | Click **Deploy** and wait 1–3 minutes | wizard |
| 5 | Set **Deploy command** to `npm run deploy` (migrations on every deploy) | Worker → Settings → Build |
| 6 | Add two secrets (type *Secret*): `SETUP_TOKEN`, `SESSION_SECRET`, each from `openssl rand -hex 32` | Worker → Settings → Variables and Secrets |
| 7 | Open `https://<project>.<your-subdomain>.workers.dev`, paste `SETUP_TOKEN`, choose your password | browser |

> `SETUP_TOKEN` is shown once — keep it. Do not keep the sample value: the server refuses to initialise with it.

The wizard creates D1 and writes its real id back into your repository (you will see something like
`4f191450-…` in the build log). Only if the log complains about a missing D1 do you need to create one and add a
binding under Worker → Settings → Bindings (**the variable name must be `DB`**).

### Path B: command line (migrations and secrets handled too)

```bash
git clone https://github.com/jiangbo202/asset-manager.git
cd asset-manager && npm install

export CLOUDFLARE_API_TOKEN=your-token      # Windows: $env:CLOUDFLARE_API_TOKEN="your-token"
npm run deploy:safe
```

| # | Manual step | Where |
|---|---|---|
| 1 | Create an API token with **Workers Scripts: Edit + D1: Edit** | dashboard → My Profile → API Tokens |
| 2 | Run the three commands above | terminal |
| 3 | **Copy the `SETUP_TOKEN`** — printed exactly once | terminal |
| 4 | Open the URL, paste the token, set your password | browser |

**What about future upstream updates?** The one-click flow gives you a **copy**, so upstream changes do not
reach you automatically:

```bash
npm run update:upstream    # merge upstream (the only conflict it resolves is your database_id — yours wins)
git push                   # Workers Builds rebuilds and redeploys
```

### When something fails

| Symptom | What to do |
|---|---|
| Build log: `Failed: error occurred while running build command` | Set Build command to `npx vite build` and hit *Retry*, or merge the upstream fix |
| “Database needs an upgrade” / `no such table` | Follow-up 5 of path A was skipped |
| 500 “secrets not configured” during initialisation | Follow-up 6 of path A was skipped |
| `Missing script: "update:upstream"` | Your copy predates that command: merge once by hand (`git remote add upstream … && git merge upstream/main`) |
| `refusing to merge unrelated histories` | Template copy shares no ancestor with upstream: align once with `--allow-unrelated-histories` (see [Upgrading](#-upgrading)) |
| Re-testing the one-click flow | Delete all three: GitHub repo, Worker, D1 |

Field-by-field wizard instructions, an acceptance checklist and full troubleshooting:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (Chinese).

## ✅ First-run checklist

1. Complete initialisation with the `SETUP_TOKEN` and set your own password
2. Confirm the **display currency** (USD by default) and **time zone** (UTC by default)
3. For non-USD assets, add FX rates under Settings → FX rates (or click **“Fetch latest rate”**)
4. Create accounts, then add holdings with symbol, quantity, price and average cost
5. Glance at Settings → Data overview to see how much of the free tier you are using

## 💰 Does it stay within the free tier?

Yes. Typical personal usage, with measured numbers:

| Resource | Actual usage | Free tier |
|---|---|---|
| Worker requests | < 1,000 / day | 100,000 / day |
| Worker CPU | page reads 1–4 ms; quote refresh ≈ 8 ms; snapshot ≈ 5 ms | 10 ms / request |
| D1 rows read / written | < 50,000 / < 100 per day | 5,000,000 / 100,000 per day |
| D1 storage | < 20 MB | 500 MB per database (5 GB per account) |
| Static assets | 93 KB gzip first load + on-demand chunks | **free and unlimited** |

The architecture is built around the 10 ms CPU budget: PBKDF2 runs **in the browser**, aggregation happens in
SQL, every endpoint reads what it needs in **one `db.batch`**, and quote refresh and snapshots are split into
two invocations. `tests/api/query-budget.test.ts` pins the statement and round-trip budget of every route, so
adding a serial query back fails CI.

**Going over never costs money.** The free tier has no overage pricing — you get **errors**, not charges (the
only way to be billed is to upgrade to Workers Paid, from $5/month):

| What you exceeded | What you see | Recovers |
|---|---|---|
| Worker requests > 100,000/day | Cloudflare error page `Error 1027` | at midnight UTC |
| D1 rows read / written | Endpoints return 503: “today's free quota is used up, resets at midnight UTC, data intact” | at midnight UTC |
| D1 storage > 500 MB | Writes blocked until you free space | after cleanup |

**Pages do not count**: HTML / JS / CSS are static assets, only `/api/*` invokes the Worker and is counted —
one overview load is about 3 requests, so 100,000/day ≈ 30,000 page views. Cloudflare also emails you when D1
hits its daily limit, and stored data is unaffected.

### Want the actual numbers? (optional)

Bottom of Settings → “Cloudflare usage”: paste a **read-only** token to see today's real figures with progress
bars (yellow past 70 %, red past 90 %).

| Field | What to use |
|---|---|
| API token | dashboard → **My Profile → API Tokens → Create Token → Custom token**, with only two read permissions: **Account Analytics: Read**, **D1: Read** |
| Account ID | shown in the right-hand sidebar of **Workers & Pages** (or in the URL `dash.cloudflare.com/<id>/…`) |
| Worker name | defaults to `asset-manager` (a wrong name shows “unavailable”) |
| D1 database name | defaults to `asset-manager-db` |

The token is read-only, stored encrypted in your own D1 and never returned by the API (audit logs only record
`(set)`); leave it empty and the card says “not configured” — nothing else changes. Numbers are cached locally
and only refreshed when you press the button.

<details>
<summary>Verify the token from the terminal first (optional, saves a round trip)</summary>

```bash
export CF_TOKEN='your token' CF_ACCOUNT='your Account ID'
# 1) is the token valid?
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | head -c 200
# 2) does it have D1: Read? (listing databases means yes)
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/d1/database" | head -c 300
```

Common outcomes: “token invalid or insufficient permissions” = missing a permission; a single row showing
“unavailable” = wrong Worker or database name (with several databases we refuse to guess); only the database
size missing = the token lacks `D1: Read`.

</details>

## 🔐 Data and privacy

- No analytics, no telemetry, no third-party fonts or CDNs
- Apart from the quote providers you enable, the Worker makes no outbound requests; data lives in your own
  Cloudflare account
- Passwords are derived with PBKDF2 (300k iterations) **in the browser**; only an irreversible verifier is
  stored; quote API keys and the usage token are encrypted at rest
- See [SECURITY.md](SECURITY.md)

## ❓ FAQ

**What do I do after the one-click deploy?**
The wizard only authorises, copies the repo and deploys. Then: D1 binding (usually already done), one
migration run, and two secrets — see the table above and the
[deployment guide](docs/DEPLOYMENT.md#a2-部署后必须补的三件事).

**Does updating always need a terminal?**
For now, yes — it is a git merge: `npm run update:upstream && git push`. Deploying itself never does.
`refusing to merge unrelated histories` means your repo is a template copy (no shared ancestor): align once.
`Missing script` means your copy predates that command: merge by hand once. See [Upgrading](#-upgrading).

**How do I confirm the scheduled job ran?**
Activity history gets entries with source `system` (“刷新行情…” for the scheduled refresh, “定时快照…” /
“补拍当日快照…” for snapshots). The Quotes & snapshots card in Settings also shows the last refresh and the
next run.

**How do I share it with someone?**
Settings → “Public read-only link”, switch it on and send the URL. Visitors see only the overview, limited to
the sections you tick — no account notes, history, settings or backups, and no quote refresh. Switch it off and
the link shows the sign-in page again.

**Why did prices not update?**
Check the failure reason in Activity history: it names the provider, the symbol that was requested and what we
asked it for. Repeated failures usually mean a wrong symbol or configuration (for example a US ticker recorded
as a Hong Kong one).

**How do I enter Hong Kong / A-share symbols?**
4 or 5 digits both work (`700` / `0700` / `3121.HK`); they are stored as the 5-digit HKEX code (`00700` /
`03121`) and converted per provider on request.

**The console reports `beacon.min.js` blocked by CSP.**
That is Cloudflare's own Web Analytics injection; our CSP only allows `'self'`, so it is expected.

## 🔄 Upgrading

Export a backup first (Settings → Backup). Upgrades do not touch your data, but a backup never hurts.

**Your repo is a clone of this one**: `git pull && npm install && npm run deploy:safe`

**Your repo came from the one-click flow** (upstream changes do not reach it automatically):

```bash
npm run update:upstream && git push
```

> `refusing to merge unrelated histories` (template copy, no shared ancestor):
>
> ```bash
> git merge --allow-unrelated-histories -X theirs upstream/main
> # this resets database_id to a placeholder — put yours back, then commit
> git add -A && git commit -m "restore my database_id" && git push
> ```
>
> If you edited code, drop `-X theirs` and resolve the conflicts yourself. Afterwards `update:upstream` keeps
> your id automatically.

“Database needs an upgrade” after updating means the migration did not run: set the Builds **Deploy command** to
`npm run deploy`, or run `npm run db:migrate:remote` locally. Details:
[docs/DEPLOYMENT.md §6](docs/DEPLOYMENT.md#6-从上游更新) (Chinese).

## 💻 Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev            # http://localhost:5173
```

Local data lives in `.wrangler/state/` and **costs nothing**; the `SETUP_TOKEN` on the setup page is the one in
`.dev.vars`. Full guide: [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) (Chinese).

## 🛠 Development and contributing

```bash
npm run dev        # dev server (workerd + HMR)
npm run lint       # type checks across four tsconfigs
npm test           # Vitest, running inside real workerd
npm run verify     # all of the above + bundle size + script wiring checks
npm run watch:cpu  # live CPU time per invocation (free-tier debugging)

npm run deploy:safe      # deploy (D1 → build → migrations → deploy → secrets)
npm run update:upstream  # align this deployment with the upstream template
```

The stack is deliberately minimal: **Hono + D1 + React**, no UI library, no chart library, no state manager —
donut, treemap and trend chart are hand-written SVG.

```
src/worker/     Worker: api routes / core / data repositories / services
src/web/        Frontend: lib (api, i18n, charts…), pages, components
src/shared/     Shared: types, enum labels, i18n dictionaries, time-zone helpers
migrations/     D1 migrations (append-only, never edit a shipped file)
scripts/        Deployment and local-dev scripts
tests/          Vitest (running in workerd, not a jsdom simulation)
```

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** before changing code (Chinese; conventions, testing, docs index).

## 🗺 Roadmap

- CSV import of broker statements, trading-calendar awareness, automatic rates for more currencies
- Goal: fits inside the free tier, readable code, forkable into something of your own

## 📚 Documentation

| Document | When to read it |
|---|---|
| [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) | Local development, debugging, seed data |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment, wizard fields, troubleshooting |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Migrations, backup/restore, quota monitoring, cron |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layout, data model, CPU budget, key decisions |
| [docs/PRD.md](docs/PRD.md) | Requirement IDs (FR-x.x) and design trade-offs |
| [SECURITY.md](SECURITY.md) | Threat model, auth design, public-sharing boundaries |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions, testing, docs sync |

The `docs/` files are written in Chinese; the deployment walkthrough is worth reading with a translator.

## 📄 License

MIT — see [LICENSE](LICENSE).
