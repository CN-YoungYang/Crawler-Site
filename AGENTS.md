# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js crawler for public bidding notices from `yfbzb.com` (with multi-site support). Keep the runtime flow small and direct:

- `index.js`: entry point; parses `SITES` (comma-separated, fallback `SITE`, default `yfbzb`)/`TOTAL_PAGES`/`INTERVAL_MS`/`MIN_DELAY_S`/`MAX_DELAY_S`/`CRON_EXPR` plus per-site overrides `TOTAL_PAGES_<SITE>`/`CRON_<SITE>`/`SITES_CONFIG` JSON from env (argv fallback), validates each site and cron, starts `server.js` static server (`HTTP_PORT` 8080, `HTTP_ENABLED`, health on `/health`) and pre-generates `file/index.html` navigation (`generateNav()`), and runs a Node `setTimeout`-based scheduler — per-site `scheduleLoopForSite` concurrent via `Promise.all`, single run when `CRON_EXPR` empty, daily `m h * * *` otherwise (per-site `CRON_<SITE>` independent), refreshes navigation after each `generateReport(site)`.
- `crawler.js`: fetching, HTML parsing, retry handling, deduplication, checkpoint/resume, graceful shutdown, and Excel output. Site-aware via pluggable strategy (`sites/<site>.js` hooks `buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`headers`, defaults in `sites/_base.js`): `file/<site>/`, `state-<site>.json`, `crawl({site,…})` / `crawlPage(pageNo, siteConfig, …)` (old `(baseUrl, urlSuffix)` signature kept for tests). It exports `crawl()`, `crawlPage()`, `backoffDelay()`, `readRecentIds()`, `fileDir()`, `stateFile()`.
- `log.js`: dual-channel logging (console Chinese + structured JSONL) shared by `crawler.js` and `report.js`; per-site `logs/<site>/crawler-YYYY-MM-DD.jsonl`, `log(msg,{site})` must pass `site` explicitly under concurrent multi-site (global `currentSite`/`setSite()` retained for compat but races), `logDir(site)` and `pruneOldLogs(site)` per-site.
- `report.js`: reporting and Excel analysis helpers; `scanFiles(site)` / `generateReport(site)` per site, `generateAllReports(sites)` concurrent via `Promise.all`, plus total navigation `collectSiteStats(site)` / `buildNavHtml(sitesData)` / `generateNav(sites)` (dynamic `sites/*` discovery, `yfbzb`/`ceb` pinned, `demo` excluded, card CTA → `file/<site>/index.html` + secondary `↗ 原站` → `originUrl`, `NAV_CSS`, `file/index.html` + `file/tokens.css`, placeholder per-site report if missing).
- `server.js`: zero-dependency static server hosting `file/` on `HTTP_PORT` (default 8080, `HTTP_ENABLED` toggle, `EXPOSE 8080`); `createServer()`/`startServer()`/`buildHealthPayload()`; routing `/` → `file/index.html` (nav), `/<site>/` → `file/<site>/index.html`, traversal-safe `safeJoin`, correct MIME, `HEAD` support; advanced `GET /health`/`/healthz`/`/api/health` → `{status,timestamp,uptime,navExists,navGeneratedAt,totals,sites[]}` with `no-store`, used by compose `healthcheck` (`node require('http').get`).
- `sites/`: site registry. `sites/yfbzb.js` is live (with `linkPrefix` + `displayName`/`description`/`originUrl`), `sites/ceb.js` is live (custom `buildUrl`/`parse`/`extractId`/`isBoundary`, `batchSize:1`, `requestDelay`, `displayName`/`originUrl`), `sites/demo.js` is an example template showing strategy hooks, `sites/site2.js` is a skeleton placeholder, `sites/_base.js` is the default strategy base, `sites/index.js` exposes `getSiteConfig(site)`/`getSiteConfigs(sites)`/`listSites()`/`listEnabledSites()`/`normalizeSites()`/`parseSitesList()`.
- `test/`: zero-dependency Node test suites and fixtures. `test/run.js` loads every suite.
- `file/`: generated Excel output, partitioned by site then publish date (for example, `file/yfbzb/2026-08-14.xlsx`) plus per-site reports `file/<site>/index.html`/`tokens.css`/`<date>.html` and total navigation `file/index.html`/`file/tokens.css` (hosted by `server.js` on `HTTP_PORT` 8080, `GET /health` probe). Do not hand-edit generated files. Legacy flat `file/*.xlsx` is kept without migration.
- `logs/`: generated JSONL logs, per-site per-day (`logs/yfbzb/crawler-YYYY-MM-DD.jsonl`). Created at runtime; pruned on a 30-day window by `report.js`.
- `state-<site>.json`: transient per-site checkpoint (cwd-relative); written each batch, deleted on clean finish. Per-site, no collision under concurrent multi-site (one container multiple sites).
- `server.js`: static server for `file/` (see above), started by `index.js`, fronted by external reverse proxy for domain.
- `Dockerfile` / `.dockerignore` / `docker-compose.yml`: container image (`node:20-alpine` + `tzdata` + `TZ=Asia/Shanghai` + `EXPOSE 8080`) and single-service compose with `SITES=yfbzb,ceb` concurrent (bind mount `file/`/`logs/`, `ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"`, `healthcheck` on `/health`, per-site `CRON_<SITE>`/`TOTAL_PAGES_<SITE>` env, `HTTP_PORT`/`HTTP_ENABLED`).
- `.github/workflows/docker-build.yml`: GHCR build & push on `push main` / `tag v*` / `workflow_dispatch` (`npm test` gate, `gha` cache, `linux/amd64,linux/arm64`).
- `page_content.html`: yfbzb 离线样页快照，用于离线校验 Cheerio 选择器；ceb 无随仓样页（`.dockerignore` 的 `page_content*.html` 排除于镜像），回归以线上解析为准。
- `docs/agents/`: local workflow and domain notes.
- `CLAUDE.md`: repository-specific agent instructions; consult it before changing crawler behavior.

## Build, Test, and Development Commands

- `npm install`: install declared dependencies.
- `node index.js [pages] [intervalMs] [minDelaySec] [maxDelaySec]`: run the crawler. Example: `node index.js 10 5000 0 0`.
- `SITES=yfbzb,ceb TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR="0 2 * * *" node index.js`: env overrides argv; `SITES` comma-separated concurrent, `SITE` single-site compat, `CRON_<SITE>`/`TOTAL_PAGES_<SITE>` per-site override or `SITES_CONFIG` JSON; `CRON_EXPR` empty = single run + keepalive, `m h * * *` = daily schedule (`nextCronDelay`), per-site independent.
- `node test/run.js` or `npm test`: run the complete test suite (zero-dep `assert`, `freshCrawler()` + `withTempCwd()` isolation).
- `docker build -t crawler:local .` / `docker compose up -d --build` / `docker compose logs -f crawler` / `curl http://127.0.0.1:8080/health | jq` / `docker compose down`: container run (`TZ=Asia/Shanghai`, bind mount `file/`/`logs/`, `SITES` multi-site, `HTTP_PORT` 8080 hosted nav at `/` + per-site reports at `/<site>/` + advanced probe at `/health`).

There is no configured build, formatter, or linter. Use a supported current Node.js release (Node 18+ is the project baseline).

## Coding Style & Naming Conventions

Use CommonJS (`require`/`module.exports`), 2-space indentation, semicolons, and `camelCase` for variables and functions. Name tests as `test/<behavior>.test.js`. Preserve Chinese for CLI usage and runtime log messages.

Keep `crawler.js` behavior explicit: 403 (or site `isBoundary`) represents the site's end-of-data boundary and must not be retried as a network failure; `isBoundary`/`buildUrl`/`parse`/`extractId` are pluggable per-site via `sites/<site>.js` (`sites/_base.js` defaults). Deduplication is keyed by `id` (via `extractId`); preserve both in-memory filtering and merge-time protection when changing output logic. The checkpoint (`state-<site>.json` via `stateFile(site)`) is deleted on clean finish — don't make it persist across successful runs. Retry backoff is exponential + full jitter via `backoffDelay()` (base 2s, cap 60s); keep it a pure function so `test/backoff.test.js` can assert its semantics without waiting on real timers. Per-site `batchSize`/`failureThreshold`/`timeout`/`headers` override the `BATCH_SIZE`/`FAILURE_STOP_THRESHOLD`/`REQUEST_TIMEOUT`/`USER_AGENT` globals.

## Testing Guidelines

Tests use Node's built-in assertion facilities and mock `axios` through `require.cache`. Use `freshCrawler()` from `test/helper.js` when a test needs a new mocked crawler module, and `withTempCwd()` for tests that write Excel files or logs (it isolates `file/<site>/`, `logs/<site>/`, and `state-<site>.json` to a temp dir via cwd-relative `fileDir(site)`/`logDir(site)`/`stateFile(site)`). Cover parsing/deduplication, 403 boundaries, retry backoff, file merging, and crawl termination as applicable. Run `node test/run.js` (or `npm test`) before submitting changes. `SITE=site2` fails fast (placeholder); `SITES=yfbzb,ceb` with mock should verify `file/<site>/`/`logs/<site>/` isolation.

## Commit & Pull Request Guidelines

Follow Conventional Commit prefixes with a concise Chinese summary, for example: `fix: 修正 403 边界处理`. Keep commits focused. Pull requests should explain the behavioral change, list verification commands and results, link the relevant issue when available, and include sample output or screenshots only when they clarify changed user-visible behavior.

## Security & Configuration

Respect the target site's crawler policy and rate limits. Query filters, URLs, and selectors are site-specific per `sites/<site>.js` (`baseUrl`/`urlSuffix`/`selectors` plus optional `buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`headers`) and consumed by `crawler.js`; review `sites/index.js` registry and `sites/_base.js` defaults before changing crawl scope. One container multiple sites concurrent (`SITES=yfbzb,ceb` via `Promise.all`, per-site `CRON_<SITE>` independent); `site2` is a skeleton and must fail fast (skipped with warn in multi-site mode). Do not commit credentials or generated output (`file/`/`logs/`/`state-<site>.json`). `TZ=Asia/Shanghai` is required in image/compose — otherwise date partitioning drifts.
