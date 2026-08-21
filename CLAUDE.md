# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Node.js web crawler that scrapes public bidding/notice listings from `yfbzb.com` (`invitedBidSearch`) and `ceb` (中国招标公共服务平台·湖北), deduplicates them against previously saved data, and writes the results to Excel files partitioned by publish date. Supports multiple sites in one container, each with independent scheduling and pluggable parsing logic via `sites/<site>.js` strategy hooks. Built-in lightweight static server hosts `file/` (`file/index.html` total navigation + `file/<site>/` per-site reports) on `HTTP_PORT` (default 8080, `EXPOSE 8080`, `healthcheck` on `/health`), intended to be fronted by an external reverse proxy for domain access.

## Commands

```bash
# 本地（宿主机）
node index.js [页数] [间隔时间(毫秒)] [最小延迟(秒)] [最大延迟(秒)]
# Defaults: 100 pages, 5000ms interval, 0s min delay, 300s max delay
# Example: node index.js 100 5000 0 300

# 环境变量（容器推荐，优先级高于位置参数）
SITES=yfbzb,ceb TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR="0 2 * * *" node index.js
# SITES 逗号分隔，一容器并发爬多站点；兼容单站点 SITE=yfbzb
# 每站独立覆盖：CRON_YFBZB="0 2 * * *" CRON_SITE2="0 3 * * *" TOTAL_PAGES_SITE2=50
# 或 JSON：SITES_CONFIG='{"yfbzb":{"totalPages":100,"cron":"0 2 * * *"}}'
# CRON_EXPR 为空 → 单次运行后常驻；设为 "m h * * *"（如 "0 2 * * *"）→ Node 内置定时每日触发（支持每站独立 CRON_<SITE>）
# 静态服务：HTTP_PORT=8080 HTTP_ENABLED=true（托管 file/，根 / 为总导航，/health 为探针，EXPOSE 8080，compose healthcheck 已配）

# Docker
docker build -t crawler:local .
docker compose up -d --build
docker compose logs -f crawler
curl http://127.0.0.1:8080/health | jq  # 进阶探针：totals/sites/navGeneratedAt/uptime

# GHCR（由 .github/workflows/docker-build.yml 自动推送：push main / tag v* / workflow_dispatch）
# 镜像：ghcr.io/<owner>/crawler:latest + sha + semver，npm test 门禁，gha 缓存，多架构 amd64/arm64
```

There is no build, formatter, or lint step. Run the crawler directly with `node index.js`. The reporting helpers live in `report.js` and the static server in `server.js`. Docker artifacts: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.github/workflows/docker-build.yml`.

Tests: zero-dependency `node:test`-style suites under `test/*.test.js` (plain `assert`, no runner installed). They mock `axios` via `require.cache` (see `test/helper.js` — `crawler.js` requires axios at module top, so each test calls `freshCrawler()` to re-capture the mock, and `withTempCwd()` to keep `crawl()`'s `file/<site>/`/`logs/<site>/`/`state-<site>.json` writes from polluting the repo). Run all suites with `node test/run.js` or `npm test` (the `npm test` placeholder was wired to `node test/run.js`). Seams under test are the five listed in their headers (crawlPage dedup / 403 boundary / retry backoff / file-merge dedup / crawl termination); don't add tests at other seams without confirming them first.

## Architecture

Site-aware (index + crawler + log + report + sites registry), data flow is linear:

1. **`index.js`** — entry point. Parses `SITES` (comma-separated, fallback `SITE`/`CRAWLER_SITE`, default `yfbzb`)/`TOTAL_PAGES`/`INTERVAL_MS`/`MIN_DELAY_S`/`MAX_DELAY_S`/`CRON_EXPR` from env (argv fallback), plus per-site overrides `TOTAL_PAGES_<SITE>`/`INTERVAL_MS_<SITE>`/`CRON_<SITE>`/`SITES_CONFIG` JSON (per-site > global > argv). Validates each site via `getSiteConfig()` and each `CRON_<SITE>` via `nextCronDelay()` (仅支持 `m h * * *`)，applies per-site random startup delay (`minDelay`–`maxDelay` seconds)，then starts `server.js` static server (`HTTP_PORT` default 8080, `HTTP_ENABLED` toggle, `healthcheck` on `/health`), pre-generates `file/index.html` navigation via `generateNav()`, and runs a Node `setTimeout`-based scheduler — one `scheduleLoopForSite` per site, concurrent via `Promise.all`: single run + keepalive when `CRON_EXPR` empty, daily at `CRON_<SITE>` otherwise. Each `runOnce` does `crawl() → generateReport(site) → generateNav()` so navigation stays fresh. Sleep is interruptible (1s poll on `stopping`) so `docker stop` (SIGTERM) exits promptly and closes the HTTP server. Failed/placeholder sites are skipped with warn, valid sites continue.

2. **`crawler.js`** — site-aware, exports `crawl`, `crawlPage`, `backoffDelay`, `readRecentIds`, `fileDir`, `stateFile`, `isStopping`.
   - `crawl()`: orchestrates. Crawls in **batches concurrently** (`Promise.all` over `crawlPage`, per-site `batchSize` or `BATCH_SIZE`=10), with `interval` ms wait between batches. Terminates on either: (a) a batch where no page yielded new data **and** no page failed (`failedCount===0`) — any failure (`failedCount>0`) continues to avoid masking (per-site `failureThreshold`/`FAILURE_STOP_THRESHOLD`=2 仅用于 `continue_despite_failures` 的 warn 分级), (b) reaching `totalPages`, or (c) any page returning `endReached` (site `isBoundary` default 403).
   - `crawlPage()`: fetches one page via `axios` (per-site `timeout`/`headers`/`method` or `REQUEST_TIMEOUT`=30s + real Chrome `User-Agent`) + parses via site strategy. If site defines `parse($, html, existingIds, siteConfig)` it fully delegates; otherwise uses `selectors` via `sites/_base.js#defaultParse`. `buildUrl(pageNo)`, `extractId(link)`, `isBoundary(error)`, `linkPrefix`, `batchSize`/`failureThreshold`/`method`/`fallbackOn405` are all pluggable per-site (see `sites/_base.js`). Retries up to `maxRetries` (default 3) with **exponential backoff + full jitter** (`backoffDelay`: `base=2s`, cap 60s, `random(0, delay)`) **on network/timeout/405 errors** — boundary is NOT retried, and `GET 405` on sites with `fallbackOn405:true` (e.g. `ceb`) auto-switches to `POST` (qIdx via `URL` API, respects existing `Content-Type`) with backoff and counts toward `maxRetries`. Returns `failed`/`endReached` flags so `crawl()` can distinguish failure from end-of-data.
   - **403 is a data boundary, not a failure.** The site returns 403 for `pageNo` beyond today's available data, not for bans/limiting. `crawlPage` catches via site `isBoundary` (default 403), marks `endReached` (no retry), and `crawl()` stops cleanly. Don't "fix" 403 as if it were a connection failure.
   - **Dedup is keyed on `id`**, done twice: in-memory against `readRecentIds()` (today's + yesterday's Excel) to filter the stream, then again at file-merge time via a `Set` of new ids to avoid writing duplicates. `extractId` is pluggable per-site (default `link.split('/').pop().split('.')[0]`).
   - **Checkpoint / resume**: `state-<site>.json` via `stateFile(site)` (cwd-relative) stores `currentPage` + `existingIds` (Set serialized as array), written after each batch. On startup, if `state-<site>.json` exists, `crawl()` resumes from `currentPage` and seeds `existingIds` from it (instead of `readRecentIds(site)`); otherwise it starts at page 1 with `readRecentIds(site)`. On clean finish (403 boundary, `totalPages`, or early-stop), `state-<site>.json` is **deleted** — it only serves "crashed mid-run today, resume next time", never persists across days. Don't make it survive a successful run.
   - **Graceful shutdown**: `SIGINT`/`SIGTERM` set a `stopping` flag (not an immediate exit). The main loop finishes the in-flight `Promise.all` batch, then breaks without starting the next (and skips the `interval` sleep). `allData` is flushed to Excel and the checkpoint is **kept** (so the next run resumes). A second signal force-exits. Global `stopping` is process-wide — `docker stop` stops all sites' in-flight batches gracefully.
   - **Output partitioning**: results are grouped by `publishTime` and written to `file/<site>/<publishTime with / replaced by ->.xlsx` (site isolated, e.g. `file/yfbzb/2026-08-19.xlsx`; legacy flat `file/*.xlsx` kept without migration). Each file is read, merged with new rows (new rows win), and rewritten in full. Logs go through `log.js` (see below).
   - **Site config**: `sites/yfbzb.js` is live, `sites/ceb.js` is live (`buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize:1`/`requestDelay`/`headers`/`method:GET`/`fallbackOn405`), `sites/demo.js` is an example template showing `buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`headers` hooks, `sites/site2.js` is a skeleton placeholder, `sites/_base.js` exports `defaultBuildUrl`/`defaultParse`/`defaultExtractId`/`defaultIsBoundary` for reuse, `sites/index.js` exposes `getSiteConfig(site)` / `getSiteConfigs(sites)` / `listSites()` / `listEnabledSites()` / `normalizeSites()` / `parseSitesList()`. `crawl({site,…})` and `crawlPage(pageNo, siteConfig, …)` are site-aware; old `(totalPages, interval)` / `(baseUrl, urlSuffix)` signatures are kept for tests. `readRecentIds(site)` reads `file/<site>/`.

3. **`log.js`** — dual-channel logging, required by both `crawler.js` and `report.js` (replaces a previously duplicated `log()` in each). `console.log` Chinese messages (ISO + PID + site prefix, for humans / `docker logs` / scheduled-task stdout) **and** structured JSONL to `logs/<site>/crawler-YYYY-MM-DD.jsonl` (per-site per-day, `event` field grep-able: `page_fetched`/`page_failed`/`batch_done`/`crawl_end`/`retry`/`boundary_403`/etc., with `site` field). The two channels coexist — neither replaces the other. `log(msg, {site})` must pass `site` explicitly under multi-site concurrency (global `currentSite`/`setSite()` is retained for backward compat but races when sites run concurrently). `logDir(site)` / `pruneOldLogs(site)` are site-aware and per-call cwd-relative. `pruneOldLogs()` reuses the 30-day retention window and is called by `report.js`'s `generateReport(site)` so expired logs are cleaned alongside expired xlsx.

4. **`report.js`** — per-site HTML reports + total navigation. `scanFiles(site)` reads/cleans `file/<site>/*.xlsx` (verifies zip magic, prunes >30 days) and returns `{date,fileName,rows}` sorted desc; `buildIndexHtml(files)` / `buildDetailHtml(file)` generate per-site `index.html` + `<date>.html` with `TOKENS_CSS`/`COMMON_CSS` inline style and client-side search/sort; `generateReport(site)` atomically writes `file/<site>/index.html` + `tokens.css` + detail pages and prunes logs. **Navigation**: `collectSiteStats(site)` + `buildNavHtml(sitesData)` + `generateNav(sites)` (dynamic discovery via `parseSitesList()` fallback, `yfbzb`/`ceb` pinned, `demo` excluded, placeholder per-site report if missing) writes `file/index.html` (total navigation, card grid, `NAV_CSS`) + `file/tokens.css`; `generateAllReports(sites)` concurrently generates all per-site reports then `generateNav()` so navigation reflects fresh totals. Navigation cards show `displayName`/`description`/`originUrl` from `sites/<site>.js` (fallback to key/baseUrl), stats row `总计天数 · 总记录 · 最近更新`, main CTA `→ file/<site>/index.html` and secondary `↗ 原站`.

5. **`server.js`** — zero-dependency (Node `http`/`fs`/`path`) static server hosting `file/` on `HTTP_PORT` (default 8080, `HTTP_ENABLED` toggle). `createServer({port,root})` / `startServer()` / `buildHealthPayload()`. Routing: `/` → `file/index.html` (total nav), `/<site>/` or `/<site>` → `file/<site>/index.html`, `/file/...` prefix compatible, directory → `index.html` fallback, `safeJoin` prevents traversal, `HEAD` supported, correct `Content-Type`/`Content-Length`/`Cache-Control` and `Content-Disposition` for xlsx. **Health probe (advanced)**: `GET /health`/`/healthz`/`/api/health` returns `{status:"ok", timestamp, uptime, navExists, navGeneratedAt, totals:{sites,dates,records}, sites:[{site,displayName,description,totalDates,totalRecords,latestUpdate,hasReport}]}` (lazy `require('./report')` + `scanFiles` per site, `no-store`). `index.js` starts the server on boot and closes it on `SIGINT`/`SIGTERM` alongside `isStopping`.

## Conventions worth knowing

- UX strings, log messages, and CLI usage text are in **Chinese** — match this when editing user-facing output.
- `page_content.html` 是 yfbzb 的离线样页快照，用于离线校验 cheerio 选择器；ceb 无随仓样页（由 `.dockerignore` 的 `page_content*.html` 排除于镜像），回归需以线上解析/测试为准。
- The crawler uses static `axios` fetches, not a headless browser. (`puppeteer` was previously listed in `package.json` but never imported; it has been removed. Don't assume a browser-rendering path exists.)
- The target query encodes fixed filters (`provinceId=12&noticeType=3&invitedBidType=3`); per-site values now live in `sites/<site>.js` (`baseUrl`/`urlSuffix`/`selectors` plus optional strategy hooks `buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`failureThreshold`/`timeout`/`headers`), edited via site config rather than hardcoded strings in `crawl()`. See `sites/_base.js` for defaults and `sites/demo.js` for an example API site.
- **Failure-vs-boundary separation** (post-grilling fix): a page that 403s is an `endReached` data boundary (logged as "无新增数据（站点边界）"), not a failure; genuine network errors retry (exponential backoff + jitter) then become `failed` and count toward `failureThreshold`. The two used to share the `hasNewData:false` path and triggered false early-stops — keep them separate. `isBoundary` is pluggable per-site.
- `FAILURE_STOP_THRESHOLD` (=2), `BATCH_SIZE` (=10), `REQUEST_TIMEOUT` (=30000), `BACKOFF_BASE_MS` (=2000), `BACKOFF_CAP_MS` (=60000), and `USER_AGENT` are named constants near the top of `crawler.js`; per-site `failureThreshold`/`batchSize`/`timeout`/`headers` in `sites/<site>.js` override them.
- **Path consistency**: `fileDir(site)` (`file/<site>/`) and `stateFile(site)` (`state-<site>.json`) are cwd-relative, as is `log.js`'s `logs/<site>/` dir (resolved per-call, not frozen at module load, so `withTempCwd` test isolation works). `state-<site>.json` is per-site — one container runs multiple sites concurrently, checkpoints are per-site and don't collide. Keep them site-aware and cwd-relative.
- **Docker**: `Dockerfile` is `node:20-alpine` + `tzdata` + `ENV TZ=Asia/Shanghai` + `WORKDIR /app` + `USER node` + `EXPOSE 8080` + `ENTRYPOINT ["node","index.js"]`; `docker-compose.yml` is single service `crawler` with `SITES=yfbzb,ceb` (comma-separated, concurrent), per-site `CRON_<SITE>`/`TOTAL_PAGES_<SITE>` or `SITES_CONFIG` JSON, bind mounts `./file:/app/file` `./logs:/app/logs`, `ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"` + `healthcheck` (`node require('http').get(.../health)`), `HTTP_PORT`/`HTTP_ENABLED` env, and `CRON_EXPR` scheduling; `.github/workflows/docker-build.yml` pushes to `ghcr.io/<owner>/crawler` on `push main` / `tag v*` / `workflow_dispatch` with `npm test` gate, `gha` cache, `linux/amd64,linux/arm64`.
- **One container multiple sites (concurrent)**: `SITES=yfbzb,ceb` runs sites concurrently via `Promise.all` per `scheduleLoopForSite`; each site has independent `CRON_<SITE>` scheduling, isolated `file/<site>/`/`logs/<site>/`/`state-<site>.json`, and pluggable parsing via `sites/<site>.js` strategy. `SITE` (single) is retained for backward compat. `site2` placeholder still fails fast and should not create `file/site2/` or `logs/site2/` when skipped.
- **Navigation & static serving**: `file/index.html` is the total navigation (dynamic `sites/*` discovery, `yfbzb`/`ceb` pinned, card CTA → `file/<site>/index.html`, secondary `↗ 原站` → `originUrl`/`baseUrl`), generated by `report.js#generateNav()` via `buildNavHtml`+`NAV_CSS` and refreshed after each `generateReport(site)` and on boot; `server.js` hosts `file/` on `HTTP_PORT` (default 8080) with `/health` advanced probe (see above), `file/tokens.css` shared between navigation and per-site reports, intended to be fronted by an external reverse proxy (`80/443 → 8080`) for domain access. Per-site `displayName`/`description`/`originUrl` live in `sites/<site>.js`.


## 沟通和提交

- 回复使用中文。
- 提交信息使用 Conventional Commit + 中文摘要。
- 推荐验证信息写入 PR 或交付说明。

## Repository Documentation

- `AGENTS.md` is the contributor guide and should stay aligned with this file.
- Issues live in GitHub Issues; see `docs/agents/issue-tracker.md`.
- Domain and architecture context is documented in `docs/agents/domain.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (CN-YoungYang/Crawler-Site). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
