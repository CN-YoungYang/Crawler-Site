# ADR 0001 — Docker 化、GHCR 自动构建与多站点隔离

- **日期**: 2026-08-19
- **状态**: 已采纳（含 2026-08-21 修订：`ceb` 代理换 IP 根治 WAF 405）
- **上下文**: 见 `CONTEXT.md`；原项目为裸 `node index.js [pages] [interval] [minDelay] [maxDelay]` 一次性批处理，`file/`/`logs/`/`state.json` 落 cwd，无镜像、无 CI、换机器即丢数据。用户要求常驻容器、GHCR 自动发布，并为多站点预留可演进的扩展位，产物按 `file/<site>/` 分站点隔离、旧数据不迁移。2026-08-20 修订为 **一容器并发多站点、各站独立逻辑与定时**（策略化）；2026-08-21 修订 `ceb` 为 **代理换 IP** 根治固定 IP 下 WAF 405（`http-proxy-agent`，可选 `mihomo` sidecar）。
- **关联烤问**: 8+2 约束已收敛（常驻 / 环境变量 / `TZ=Asia/Shanghai` / GHCR / 配置对象占位 / `file/<site>/`+日志隔离 / 一容器多站点并发 / 策略化 / 不迁移），详见 `.scratch` 与 `CLAUDE.md`。

## 决策

1. **常驻形态：Node 内置定时 > 系统 cron**
   - 采用 `index.js#scheduleLoop` + `nextCronDelay("m h * * *")` + `sleepInterruptible(1s 轮询 isStopping)`，`CRON_EXPR` 为空则单次后常驻、`m h * * *` 则每日定时（如 `0 2 * * *`）。
   - 理由：Alpine `crond`/`supercronic` 需额外包、信号/日志/时区坑多；Node 侧零依赖即可满足 `0 2 * * *` 场景，且与既有 `SIGINT`/`SIGTERM` 优雅退出（`isStopping()`）天然衔接，`docker stop` 可被 1s 中断。

2. **参数：环境变量优先、位置参数回退（支持多站点）**
   - `parseEnv()` 合并 `SITES`（逗号分隔，`SITES=yfbzb,demo`）/`SITE`/`CRAWLER_SITE`、`TOTAL_PAGES`/`PAGES`、`INTERVAL_MS`/`INTERVAL`、`MIN_DELAY_S`/`MIN_DELAY`、`MAX_DELAY_S`/`MAX_DELAY`、`CRON_EXPR`/`CRON`，未设回退到 `parseArguments()`；每站独立覆盖 `TOTAL_PAGES_<SITE>`/`INTERVAL_MS_<SITE>`/`MIN_DELAY_S_<SITE>`/`MAX_DELAY_S_<SITE>`/`CRON_<SITE>`/`CRON_EXPR_<SITE>`，或 `SITES_CONFIG` JSON（`{"yfbzb":{"cron":"0 2 * * *"}}`），优先级：每站 env > JSON > 全局 env > argv。`parseSitesList()`/`normalizeSites()` 负责解析与去重。
   - `validateInput` 逐站 `getSiteConfig(site)` 校验站点、以 `nextCronDelay(cronExpr)` 校验每站 cron；`SITES` 多值下占位/未知站点 warn 跳过（保留有效站点继续运行），单站点下仍 fail-fast；`require.main===module` 守卫避免 `require` 时自启动。

3. **持久化：bind mount > named volume（多站点共享）**
   - `docker-compose.yml` 单服务 `crawler` 采用 `./file:/app/file`、`./logs:/app/logs`，`file/<site>/`、`logs/<site>/` 人可直读、可备份、按站点隔离；`state-<site>.json` 按站点隔离，默认不挂载（随容器生命周期，正常完成即删），需崩溃续跑可按站点显式挂载 `./state-yfbzb.json:/app/state-yfbzb.json` `./state-demo.json:/app/state-demo.json`。一容器内多站点并发写不同子目录，不冲突。

4. **镜像与时区**
   - `Dockerfile`: `node:20-alpine` + `tzdata`/`ca-certificates`/`ttf-freefont`/`su-exec` + `ENV TZ=Asia/Shanghai` + `WORKDIR /app` + `EXPOSE 8080` + `ENTRYPOINT ["node","index.js"]`。未固定时区会导致 `readRecentIds()`/`publishTime` 分区按 UTC 错一天。
   - 2026-08-21 增量（`ceb` 代理换 IP）：`package.json` 新增 `http-proxy-agent`/`https-proxy-agent`，`crawler.js` 新增 `resolveProxyUrl`/`getProxyAgents`/`isNoProxy` + `axios` 注入（`proxy:false + httpAgent/httpsAgent`），`docker-compose.yml` 回调至 `mem_limit 400m`/`cpus 0.5`（轻量无 `chromium`）并透传 `HTTP_PROXY/CEB_PROXY_URL` + 可选 `mihomo` sidecar（`proxy-providers` 拉远端 `clash_fast.yaml` 转 `http://mihomo:7890`）。

5. **GHCR 发布**
   - `.github/workflows/docker-build.yml`: `push main` / `tag v*` / `workflow_dispatch` 触发，`setup-qemu`+`setup-buildx` 多架构 `linux/amd64,linux/arm64`，`docker/metadata-action` 生成 `latest`（仅 main）+ `sha` + `semver`/`major.minor`，`gha` 缓存，`npm ci`+`npm test` 门禁，推送至 `ghcr.io/<owner>/crawler`（需 `Settings > Actions > Workflow permissions: Read and write`）。

6. **多站点：配置对象 + 策略钩子（2026-08-20 修订，2026-08-21 增 `proxy`）**
   - `sites/yfbzb.js` 实站（`linkPrefix`，`axios`）、`sites/ceb.js` 实站（2026-08-21 起 `axios` + 代理换 IP，`buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize:1`/`requestDelay`/`headers`/`proxy`/`fallbackOn405` + 可选 `mihomo` sidecar）、`sites/demo.js` 策略示例（展示 `buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`failureThreshold`/`timeout`/`headers`/`proxy` 钩子）、`sites/site2.js` 骨架占位（`baseUrl=""`、`disabledReason`，`getSiteConfig` 触发 fail-fast）、`sites/_base.js` 默认策略（`defaultBuildUrl`/`defaultParse`/`defaultExtractId`/`defaultIsBoundary`，供站点复用）、`sites/index.js` 注册表 `registry`/`normalizeSite()`/`normalizeSites()`/`parseSitesList()`/`getSiteConfig()`/`getSiteConfigs()`/`listSites()`/`listEnabledSites()`。新增站点只需加一个配置对象（`sites/<site>.js`）并在 `SITES` 中列出，无需改 `docker-compose.yml` 多服务；`proxy` 使 `ceb` 等固定 IP 被 WAF 拦的站点可独立换 IP 而不影响直连站点。
   - 贯穿站点化：`crawler.js#fileDir(site)`→`file/<site>/`、`stateFile(site)`→`state-<site>.json`、`readRecentIds(site)`、`crawl({site})`/`crawlPage(pageNo, siteConfig, …)` 委托站点策略（`buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`timeout`/`headers`，缺省走 `selectors`）；`log.js#log(msg,{site})`/`logDir(site)`/`pruneOldLogs(site)`（并发下必须显式传 `site`，`setSite` 保留兼容但会竞态）；`report.js#fileDir(site)`/`scanFiles(site)`/`generateReport(site)`/`generateAllReports(sites)`（后者 `Promise.all` 并发）。旧 `(baseUrl, urlSuffix)` / `(totalPages, interval)` 签名保留以兼容 `test/*.test.js`。
   - 调度：`index.js#scheduleLoop` 每站一 `scheduleLoopForSite` 并发（`Promise.all`），`SITES` 逗号分隔，`CRON_<SITE>` 每站独立定时（`nextCronDelay` 仍仅 `m h * * *`），`sleepInterruptible` 1s 轮询 `isStopping()`。无 cron 时各站并发单次后常驻；有 cron 时各站独立定时循环。

7. **存放隔离与旧数据**
   - 产出 `file/<site>/YYYY-MM-DD.xlsx`、`logs/<site>/crawler-YYYY-MM-DD.jsonl`、`state-<site>.json` 全量按站点隔离；日志 `event`/`site` 可 grep，控制台 `[site]` 前缀便于 `docker logs` 按站点区分。一容器并发多站点时各站独立子目录，`SITES` 多值下占位站点 warn 跳过不落脏文件，单站点 `SITE=site2` 仍 fail-fast 不得创建 `file/site2/`/`logs/site2/`。历史扁平 `file/*.xlsx` 保留不迁移，`readRecentIds(site)` 仅读 `file/<site>/`。

## 修订 2026-08-20 — 一容器多站点并发与策略化

- **背景**: 用户要求一容器爬多个站点且每站逻辑不同、每站独立定时、容器内并发；先做扩展位（钩子打通，不一次性实现所有重逻辑）。
- **变更**: `SITES` 逗号分隔 + `CRON_<SITE>`/`TOTAL_PAGES_<SITE>`/`SITES_CONFIG` 每站覆盖；`index.js` 每站 `scheduleLoopForSite` 并发（`Promise.all`）；`crawler.js` 委托 `sites/<site>.js` 策略（`buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`failureThreshold`/`timeout`/`headers`，`sites/_base.js` 默认）；`log.js` 要求 `log(msg,{site})` 显式传 `site` 以避免 `currentSite` 并发竞态；`report.js` `generateAllReports` 改 `Promise.all`；`docker-compose.yml` 单服务 `crawler` 替代一服务一站点。
- **兼容**: `SITE` 单站点、`CRON_EXPR` 全局、`crawl({site})` 旧签名均保留；`yfbzb` 现有行为不变。

## 修订 2026-08-20 — 总导航与静态服务（含进阶探针）

- **背景**: 用户要求“导航页，显示 yfbzb 和 ceb 的入口”且“通过域名访问”，需在不引入前端构建的前提下提供可被外部反代的入口页。
- **变更**:
  - `sites/yfbzb.js`/`sites/ceb.js` 新增 `displayName`/`description`/`originUrl` 供导航卡片展示；
  - `report.js` 新增 `collectSiteStats(site)`/`buildNavHtml(sitesData)`/`generateNav(sites)`（动态发现 `parseSitesList()`，`yfbzb`/`ceb` 置顶，`demo` 排除，缺失站点报告自动补空占位，`NAV_CSS`+`COMMON_CSS` 自适应，`file/index.html`+`file/tokens.css`）与 `generateAllReports(sites)` 末尾刷新导航，每站 `runOnce` 内 `crawl → generateReport → generateNav`；
  - 新增 `server.js`（零依赖 `http`，`createServer`/`startServer`/`buildHealthPayload`，托管 `file/` 于 `HTTP_PORT` 默认 8080，`EXPOSE 8080`，路由 `/`→总导航、`/<site>/`→站点报告、`safeJoin` 防穿越、`HEAD` 支持，`GET /health|/healthz|/api/health` 进阶探针 `no-store` 返回 `{status,timestamp,uptime,navExists,navGeneratedAt,totals,sites[]}`）；
  - `index.js` 启动时 `startServer()`+`generateNav(env.sites)` 预生成并在 `SIGINT`/`SIGTERM` 时关闭 HTTP 服务；
  - `Dockerfile` 加 `EXPOSE 8080`，`docker-compose.yml` 加 `ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"` + `healthcheck`（`node require('http').get(.../health)`，`interval 30s`）与 `HTTP_PORT`/`HTTP_ENABLED` env，`.env.example` 同步；
  - 意图由外部反代承载 `80/443` 与 HTTPS，本容器仅暴露 `8080`，域名 `your.domain.com/`→总导航、`/<site>/`→报告、`/health`→探针。
- **兼容**: `HTTP_ENABLED=false` 可禁用服务，`SITES` 单站点与旧 `file/<site>/` 报告路径不变；纯静态 `file/index.html` 仍可 `file://` 打开。

## 修订 2026-08-21 — ceb 代理换 IP 根治 WAF 405

- **背景**: `ceb` 在容器内固定出口 IP 下 `GET 405 → fallback POST 仍 405` 空转 100 页（宿主机同 URL `axios` 200），根因系阿里云 WAF 按 IP 段拦截，与指纹无关；`requestDelay`/`batchSize:1`/`fallbackOn405` 仅止损，不根治。`puppeteer-core + chromium` 治错方向（+~150MB、内存 800m），应以换 IP 根治。
- **变更**:
  - 移除 `puppeteer-core`/`chromium` 全链路（`package.json`/`Dockerfile`/`docker-compose.yml` 回调至轻量 400m/`cpus 0.5`）；`crawler.js` 新增 `resolveProxyUrl`/`getProxyAgents`/`isNoProxy`/`desensitizeProxyUrl`（优先级 `PROXY_<SITE>/CEB_PROXY_URL/PROXY_URL/HTTP_PROXY` + `NO_PROXY` 白名单，`axios` 注入 `proxy:false + httpAgent/httpsAgent`，事件 `proxy_enabled/bypassed/invalid`），保留双 405 快败与连续 405 熔断（代理下 405 仍触发）；
  - `sites/ceb.js` 删 `engine:'browser'`，回归 `axios` + `fallbackOn405` + 代理注释（`HTTP_PROXY=http://mihomo:7890`），`requestDelay/batchSize:1` 保留防风控；
  - 新增 `mihomo/config.yaml.example`（`mixed-port:7890` + `proxy-providers` 拉 `https://xxx.xxx.xxx.xxx/NodeMergeClash/output/clash_fast.yaml`，`proxy-groups PROXY/auto` + `RULES MATCH,PROXY`），`docker-compose.yml` 可选 `mihomo` sidecar（默认注释，按需启用）；
  - `package.json` 改为 `http-proxy-agent`/`https-proxy-agent`，文档全量脱敏（`xxx.xxx.xxx.xxx` 占位）。
- **权衡**: 镜像回到轻量、无 `chromium` 体积/内存负担；换 IP 才是对 IP 段封禁的根治，代理仅 `ceb` 按需启用，不影响 `yfbzb` 直连。
- **验证**: 代理解析/白名单/脱敏单测；`mockAxios` 双 405 快败 `calls=4` 与熔断；`npm test` 6 套件全绿。

## 后果

- 正面：换机器/重装可通过 `docker compose up -d` 常驻、`ghcr.io` 拉取、宿主机 `file/`/`logs/` 可审计；新站点接入成本为“一配置对象（`sites/<site>.js` 策略） + `SITES` 加名”，无需新增 compose 服务；各站可独立定制抓取/解析/边界与定时。
- 负面/权衡：`nextCronDelay` 仅支持 `m h * * *`，复杂 cron 需另引依赖；多架构构建在 x86 runner 上 QEMU 较慢（需要时可先单架构）；一容器内 `N*batchSize` 并发可能对目标站限流敏感，可通过站点 `batchSize` 自降并发或后续加站间错峰/全局限流。

## 备选方案（已否决）

- `supercronic`/`crond` 常驻：额外进程与信号/时区复杂度，不采纳。
- Named volume：宿主机不可直读、站点隔离不直观，不采纳。
- 策略类/插件抽象：第二站点完全未知，过度抽象，不采纳。

## 验证

- `npm test` / `node test/run.js` 6 套件全绿（`withTempCwd` 按 `file/<site>/`/`logs/<site>/`/`state-<site>.json` 隔离）。
- `SITE=site2` 单站点启动即 `getSiteConfig` 抛错、exit 1，不落脏文件；`SITES=yfbzb,site2` 多站点下 `site2` warn 跳过、`yfbzb` 正常运行（`file/site2/`/`logs/site2/` 不创建）。
- 策略钩子：`buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`linkPrefix` 均有单测/冒烟覆盖；`SITES=yfbzb,demo` 并发冒烟 `file/yfbzb/` 与 `file/demo/`、`logs/yfbzb/` 与 `logs/demo/` 隔离且 `site` 前缀正确。
- 每站独立定时：`CRON_YFBZB`/`CRON_DEMO`/`SITES_CONFIG` 解析与 `nextCronDelay` 逐站校验。
- 本地 `docker build` + `docker compose up -d --build` + `docker compose logs -f crawler` 可观测多站点 `[yfbzb]`/`[demo]` 日志与 `file/<site>/` 产出；`docker stop` 触发所有站点当前批次优雅落盘。
- 导航与静态服务：`SITES=yfbzb,ceb node -e "require('./report').generateNav()"` 生成 `file/index.html`（卡片 `yfbzb`/`ceb` 置顶，`displayName`+统计+`↗ 原站`，缺失报告自动补空）；`node -e "require('./server').createServer().listen(18080)"` 后 `curl /`→导航、`curl /yfbzb/`→报告、`curl /health`→`{status:"ok",totals,sites}`，`compose healthcheck` 30s 探活，外层反代 `80/443→8080` 后域名可访问。
