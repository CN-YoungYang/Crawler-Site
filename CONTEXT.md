# CONTEXT — crawler（单上下文）

> 单上下文仓库，术语与边界集中于此。按 `docs/agents/domain.md` 指引，`CONTEXT.md` 定义通用语言，`docs/adr/` 记录关键决策。

## 上下文边界

抓取单个或多个招标公告站点的公开列表页（以 `yfbzb.com invitedBidSearch` 为首站），经去重后按发布日期分区落盘为 Excel，辅以站点隔离的日志与报告。前端报告与 CLI/容器调度均属同一上下文，不另拆子域。

## 通用语言（Ubiquitous Language）

| 术语 | 含义 | 关联代码 |
|------|------|----------|
| **站点 (Site)** | 一个抓取目标，由 `sites/<site>.js` 的 `{ name, displayName, description, originUrl, baseUrl, urlSuffix, selectors, linkPrefix, buildUrl, parse, extractId, isBoundary, parseTotalPages, batchSize, timeout, headers, proxy, requestDelay, fallbackOn405 }` 定义（后者为可选策略钩子，默认值见 `sites/_base.js`；全站 `axios`，`ceb` 固定 IP 被 WAF 拦时经 `HTTP_PROXY/CEB_PROXY_URL` 代理换 IP（`mihomo` sidecar 将远端 `clash_fast.yaml` 转 `http://mihomo:7890`）；`displayName`/`description`/`originUrl` 供总导航卡片展示）；通过 `SITES`（逗号分隔并发）或 `SITE`/`CRAWLER_SITE` 选择，`SITES` 下未实现站点 warn 跳过、单站点下 fail-fast。 | `sites/index.js#getSiteConfig`, `sites/yfbzb.js`, `sites/ceb.js`, `sites/demo.js`, `sites/_base.js` |
| **站点注册表 (Site Registry)** | `sites/index.js` 的 `registry` 与 `normalizeSite()`/`normalizeSites()`/`parseSitesList()`/`getSiteConfigs()`/`listSites()`/`listEnabledSites()`，集中校验与枚举站点；支持 `SITES` 多值与每站 `CRON_<SITE>`/`TOTAL_PAGES_<SITE>`/`SITES_CONFIG`。 | `sites/index.js` |
| **公告 (Notice)** | 单条招标条目，字段 `id`（`link` 末段去扩展名）、`title`、`link`、`noticeType`、`area`、`publishTime`。 | `crawler.js#crawlPage` |
| **选择器 (Selectors)** | 站点相关的 Cheerio 选择器 `rows/titleLink/noticeType/area/publishTime`，默认 `#treeTable tbody tr` 等，随站点配置可覆写；或由站点 `parse($, html, existingIds, siteConfig)` 完全接管（JSON API 等）。 | `sites/<site>.js#selectors`, `sites/_base.js#defaultParse` |
| **数据边界 (Boundary)** | 目标站点对超出当日可访 `pageNo` 返回 403（或站点自定义 `isBoundary(error)` 判定）视为正常的数据到底信号，不重试、不计失败，置 `endReached` 后干净停止。边界是逐页被动信号，与主动收窄的「有效页数上限」互补。 | `crawler.js#crawlPage`, `sites/_base.js#defaultIsBoundary` |
| **有效页数上限 (Effective Page Cap)** | `min(配置 TOTAL_PAGES, 站点分页自报真实总页数)`——成功页经可选钩子 `parseTotalPages($, html, siteConfig)` 提取（yfbzb 取 `.pagination` 内「共 N 条」÷ pageSize；ceb 取「共 N 页」），`crawl()` 每批合并重算（后观测覆盖前观测），循环条件与批次 clamp 均用之；未观测/解析失败时退化为仅配置值。绝不读统计横幅的存量总数（如 yfbzb「近1个月共76470条」）。 | `crawler.js#extractRealTotalPages`, `crawler.js#crawl`, `sites/yfbzb.js#parseTotalPages`, `sites/ceb.js#parseTotalPages` |
| **去重键 (Dedup Key)** | `id` 为主键（经站点 `extractId(link)` 抽取，默认 `link.split("/").pop()`）；内存侧比对 `readRecentIds(site)`（`file/<site>/` 昨日+今日），写盘侧再次合并去重，新行优先。 | `crawler.js#readRecentIds`, `sites/_base.js#defaultExtractId` |
| **分区写盘 (Partitioned Excel)** | 按 `publishTime` 分组，写入 `file/<site>/YYYY-MM-DD.xlsx`；整文件读-合并-回写，历史扁平 `file/*.xlsx` 保留不迁移；每站按 `batchSize`/`failureThreshold` 独立批次并发与早停。 | `crawler.js#fileDir` |
| **Checkpoint** | `state-<site>.json`（`stateFile(site)`，cwd 相对），`{ currentPage, existingIds[] }`，每批写入、正常完成即删，仅供当日崩溃续跑，`SIGINT/SIGTERM` 优雅退出时保留以便下次续跑。 | `crawler.js#stateFile` |
| **双通道日志 (Dual-channel Log)** | 控制台中文（`[ISO][PID][site]`，`docker logs` 按站点可区分）+ 结构化 JSONL `logs/<site>/crawler-YYYY-MM-DD.jsonl`（`event`/`site` 可 grep），30 天保留；多站点并发时 `log(msg,{site})` 必须显式传 `site`，`logDir(site)`/`pruneOldLogs(site)` 按站点隔离。 | `log.js#log, logDir, pruneOldLogs` |
| **保留窗口 (Retention Window)** | 30 天，Excel 与日志同窗口；`report.js#scanFiles` 清过期 xlsx，`report.js#generateReport` 触发 `log.js#pruneOldLogs(site)`。 | `report.js`, `log.js` |
| **报告 (Report)** | `scanFiles(site)` + `buildIndexHtml`/`buildDetailHtml` + `generateReport(site)`/`generateAllReports(sites)`（后者 `Promise.all` 并发），索引页内联跨全部日期最新 `LATEST_PREVIEW_COUNT`=10 条「最新公告」预览（每行带日期列，其余数据轻量不内联），产物 `file/<site>/index.html`、`tokens.css`、`<date>.html`。 | `report.js` |
| **总导航 (Navigation)** | `collectSiteStats(site)` + `buildNavHtml(sitesData)` + `generateNav(sites)` 动态发现 `sites/*`（`parseSitesList()` 优先，`yfbzb`/`ceb` 置顶、`demo` 排除），卡片 CTA → `file/<site>/index.html` + 副链 `↗ 原站` → `originUrl`/`baseUrl`，样式 `NAV_CSS`+`COMMON_CSS`，产物 `file/index.html`+`file/tokens.css`，随每次 `generateReport(site)` 与启动自动刷新，缺失站点报告自动补空占位；由 `server.js` 托管于 `/`。 | `report.js#generateNav`, `server.js` |
| **静态服务 (Static Server)** | `server.js#createServer`/`startServer`/`buildHealthPayload`，零依赖 `http` 托管 `file/` 于 `HTTP_PORT`（默认 8080，`EXPOSE 8080`，`HTTP_ENABLED` 开关），路由 `/`→总导航、`/<site>/`→站点报告、`safeJoin` 防穿越、`HEAD` 支持；意图由外部反代 `80/443→8080` 以域名暴露。 | `server.js`, `index.js` |
| **健康探针 (Health Probe)** | `GET /health`/`/healthz`/`/api/health` 返回 `{status,timestamp,uptime,navExists,navGeneratedAt,totals:{sites,dates,records},sites:[{site,displayName,totalDates,totalRecords,latestUpdate,hasReport}]}`（实时 `scanFiles`，`no-store`，`HEAD` 支持），供 `docker-compose.yml#healthcheck`（`node require('http').get`）、反代后端摘除与监控告警使用。 | `server.js#buildHealthPayload` |
| **调度 (Schedule)** | `index.js#parseEnv`（`SITES` 列表 + 每站 `TOTAL_PAGES_<SITE>`/`CRON_<SITE>`/`SITES_CONFIG`/`HTTP_PORT`/`HTTP_ENABLED`，env 优先、argv 回退）→ `validateInput`（逐站 `getSiteConfig`/`nextCronDelay`，`SITES` 下占位 warn 跳过）→ `startServer()`+`generateNav()`→`scheduleLoop`（每站 `scheduleLoopForSite` 并发 via `Promise.all`）；`CRON_EXPR`/`CRON_<SITE>` 空为单次后常驻，`m h * * *` 为每站独立每日定时，`sleepInterruptible` 1s 轮询 `isStopping()` 以响应 `docker stop` 并关闭 HTTP 服务。 | `index.js` |
| **容器隔离 (One Container Multiple Sites)** | 一容器并发多站点（`SITES=yfbzb,demo`，`Promise.all`），`SITES`/`CRON_<SITE>`/`TOTAL_PAGES_<SITE>`/`HTTP_PORT`/`HTTP_ENABLED` 区分；`file/<site>/`、`logs/<site>/`、`state-<site>.json` 按站点隔离，`file/index.html` 总导航与 `file/<site>/` 报告由 `server.js` 托管于 `HTTP_PORT`（`EXPOSE 8080`，`healthcheck` 在 `/health`），`TZ=Asia/Shanghai` 固定在镜像与 compose；`SITE` 单站点兼容。 | `Dockerfile`, `docker-compose.yml`, `server.js` |

## 非目标/排除

- 全站 `axios` 静态抓取；`ceb` 因 WAF 固定 IP 被拦时经代理换 IP（`HTTP_PROXY/CEB_PROXY_URL` 经 `http-proxy-agent/https-proxy-agent` 注入，`mihomo` sidecar 将远端 `clash_fast.yaml` 转 `http://mihomo:7890`），未配时代理直连。
- **ceb→ctbpsp.com 切换已否决（2026-08-25，见 ADR 0002）**：ctbpsp JSON API 的网易易盾票据被服务端风控对全自动流量一律拒绝（协议已 100% 还原仍被拒，票据单次消费），ceb 维持旧源+代理换 IP；成果归档于 `jsreverse-yidun/`（gitignored），结论见 `docs/progress-ceb-ctbpsp.md`。
- `CRON_EXPR` 仅支持 `m h * * *`（如 `0 2 * * *`），复杂表达式需另引 cron 库。
- 旧扁平 `file/*.xlsx` 不迁移，仅新站点走 `file/<site>/`。

## 关联 ADR

- `docs/adr/0001-docker-site-isolation.md` — Docker 化、GHCR、多站点隔离与占位策略（含 2026-08-20 修订：一容器多站点并发与策略化）。
- `docs/adr/0002-ceb-keep-legacy-source.md` — ceb 否决切换 ctbpsp.com，维持旧源代理换 IP（2026-08-25）。
