# ADR 0001 — Docker 化、GHCR 自动构建与多站点隔离

- **日期**: 2026-08-19
- **状态**: 已采纳（2026-08-28 更新：`ceb` 使用 easy_proxies multi-port 换 IP）
- **上下文**: 见 `CONTEXT.md`；原项目为裸 `node index.js [pages] [interval] [minDelay] [maxDelay]` 一次性批处理，`file/`/`logs/`/`state.json` 落 cwd，无镜像、无 CI、换机器即丢数据。用户要求常驻容器、GHCR 自动发布，并为多站点预留可演进的扩展位，产物按 `file/<site>/` 分站点隔离、旧数据不迁移。2026-08-20 修订为 **一容器并发多站点、各站独立逻辑与定时**（策略化）；2026-08-21 修订 `ceb` 为 **代理换 IP** 根治固定 IP 下 WAF 405，当前由 `easy_proxies` sidecar 的 multi-port 提供代理入口。
- **关联约束**: 8+2 约束已收敛（常驻 / 环境变量 / `TZ=Asia/Shanghai` / GHCR / 配置对象占位 / `file/<site>/`+日志隔离 / 一容器多站点并发 / 策略化 / 不迁移），详见 `CLAUDE.md`。

## 决策

1. **常驻形态：Node 内置定时 > 系统 cron**
   - 采用 `index.js#scheduleLoop` + `nextCronDelay("m h * * *")` + `sleepInterruptible(1s 轮询 isStopping)`，`CRON_EXPR` 为空则单次后常驻、`m h * * *` 则每日定时（如 `0 2 * * *`）。
   - 理由：Alpine `crond`/`supercronic` 需额外包、信号/日志/时区坑多；Node 侧零依赖即可满足 `0 2 * * *` 场景，且与既有 `SIGINT`/`SIGTERM` 优雅退出（`isStopping()`）天然衔接，`docker stop` 可被 1s 中断。

2. **参数：环境变量优先、位置参数回退（支持多站点）**
   - `parseEnv()` 合并 `SITES`（逗号分隔，`SITES=yfbzb,ceb`）/`SITE`/`CRAWLER_SITE`、`TOTAL_PAGES`/`PAGES`、`INTERVAL_MS`/`INTERVAL`、`MIN_DELAY_S`/`MIN_DELAY`、`MAX_DELAY_S`/`MAX_DELAY`、`CRON_EXPR`/`CRON`，未设回退到 `parseArguments()`；每站独立覆盖 `TOTAL_PAGES_<SITE>`/`INTERVAL_MS_<SITE>`/`MIN_DELAY_S_<SITE>`/`MAX_DELAY_S_<SITE>`/`CRON_<SITE>`/`CRON_EXPR_<SITE>`，或 `SITES_CONFIG` JSON（`{"yfbzb":{"cron":"0 2 * * *"}}`），优先级：每站 env > JSON > 全局 env > argv。`parseSitesList()`/`normalizeSites()` 负责解析与去重。
   - `validateInput` 逐站 `getSiteConfig(site)` 校验站点、以 `nextCronDelay(cronExpr)` 校验每站 cron；`SITES` 多值下占位/未知站点 warn 跳过（保留有效站点继续运行），单站点下仍 fail-fast；`require.main===module` 守卫避免 `require` 时自启动。

3. **持久化：bind mount > named volume（多站点共享）**
   - `docker-compose.yml` 单服务 `crawler` 采用 `./file:/app/file`、`./logs:/app/logs`，`file/<site>/`、`logs/<site>/` 人可直读、可备份、按站点隔离；`state-<site>.json` 按站点隔离，默认不挂载（随容器生命周期，正常完成即删），需崩溃续跑可按站点显式挂载 `./state-yfbzb.json:/app/state-yfbzb.json` `./state-ceb.json:/app/state-ceb.json`。一容器内多站点并发写不同子目录，不冲突。

4. **镜像与时区**
   - `Dockerfile`: `node:20-alpine` + `tzdata`/`ca-certificates`/`ttf-freefont`/`su-exec` + `ENV TZ=Asia/Shanghai` + `WORKDIR /app` + `EXPOSE 8080` + `ENTRYPOINT ["node","index.js"]`。未固定时区会导致 `readRecentIds()`/`publishTime` 分区按 UTC 错一天。
   - 代理实现（`ceb`）：`package.json` 声明 `http-proxy-agent`/`https-proxy-agent`，`crawler.js` 使用 `resolveProxyUrl`/`getProxyAgents`/`isNoProxy` 注入 `axios`（`proxy:false + httpAgent/httpsAgent`），Compose 透传 `CEB_PROXY_URL` 并由 easy_proxies sidecar 提供独立端口。

5. **GHCR 发布**
   - `.github/workflows/docker-build.yml`: `push main` / `tag v*` / `workflow_dispatch` 触发，`setup-qemu`+`setup-buildx` 多架构 `linux/amd64,linux/arm64`，`docker/metadata-action` 生成 `latest`（仅 main）+ `sha` + `semver`/`major.minor`，`gha` 缓存，`npm ci`+`npm test` 门禁，推送至 `ghcr.io/<owner>/crawler`（需 `Settings > Actions > Workflow permissions: Read and write`）。

6. **多站点：配置对象 + 策略钩子（2026-08-20 修订，2026-08-21 增 `proxy`）**
   - `sites/yfbzb.js` 实站（`linkPrefix`，`axios`）、`sites/ceb.js` 实站（`axios` + easy_proxies 代理换 IP，`buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize:1`/`requestDelay`/`headers`/`proxy`/`fallbackOn405`）、`sites/index.js` 注册表（仅 `yfbzb`/`ceb`）；默认策略 `defaultBuildUrl`/`defaultParse`/`defaultExtractId`/`defaultIsBoundary` 内联于 `crawler.js`。新增站点只需加配置对象（`sites/<site>.js`）并在 `SITES` 中列出；`proxy` 使 `ceb` 等固定 IP 被 WAF 拦的站点可独立换 IP，而不影响直连站点。
   - 贯穿站点化：`crawler.js#fileDir(site)`→`file/<site>/`、`stateFile(site)`→`state-<site>.json`、`readRecentIds(site)`、`crawl({site})`/`crawlPage(pageNo, siteConfig, …)` 委托站点策略（`buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`timeout`/`headers`，缺省走 `selectors`）；`log.js#log(msg,{site})`/`logDir(site)`/`pruneOldLogs(site)`（并发下必须显式传 `site`，`setSite` 保留兼容但会竞态）；`report.js#fileDir(site)`/`scanFiles(site)`/`generateReport(site)`/`generateAllReports(sites)`（后者 `Promise.all` 并发）。旧 `(baseUrl, urlSuffix)` / `(totalPages, interval)` 签名保留以兼容 `test/*.test.js`。
   - 调度：`index.js#scheduleLoop` 每站一 `scheduleLoopForSite` 并发（`Promise.all`），`SITES` 逗号分隔，`CRON_<SITE>` 每站独立定时（`nextCronDelay` 仍仅 `m h * * *`），`sleepInterruptible` 1s 轮询 `isStopping()`。无 cron 时各站并发单次后常驻；有 cron 时各站独立定时循环。

7. **存放隔离与旧数据**
   - 产出 `file/<site>/YYYY-MM-DD.xlsx`、`logs/<site>/crawler-YYYY-MM-DD.jsonl`、`state-<site>.json` 全量按站点隔离；日志 `event`/`site` 可 grep，控制台 `[site]` 前缀便于 `docker logs` 按站点区分。一容器并发多站点时各站独立子目录，`SITES` 多值下未注册站点 warn 跳过不落脏文件，单站点 `SITE=<未知>` 仍 fail-fast 不得创建对应 `file/<site>/`/`logs/<site>/`。历史扁平 `file/*.xlsx` 保留不迁移，`readRecentIds(site)` 仅读 `file/<site>/`。

## 修订 2026-08-20 — 一容器多站点并发与策略化

- **背景**: 用户要求一容器爬多个站点且每站逻辑不同、每站独立定时、容器内并发；先做扩展位（钩子打通，不一次性实现所有重逻辑）。
- **变更**: `SITES` 逗号分隔 + `CRON_<SITE>`/`TOTAL_PAGES_<SITE>`/`SITES_CONFIG` 每站覆盖；`index.js` 每站 `scheduleLoopForSite` 并发（`Promise.all`）；`crawler.js` 委托 `sites/<site>.js` 策略（`buildUrl`/`parse`/`extractId`/`isBoundary`/`linkPrefix`/`batchSize`/`failureThreshold`/`timeout`/`headers`，默认内联于 `crawler.js`）；`log.js` 要求 `log(msg,{site})` 显式传 `site` 以避免 `currentSite` 并发竞态；`report.js` `generateAllReports` 改 `Promise.all`；`docker-compose.yml` 单服务 `crawler` 替代一服务一站点。
- **兼容**: `SITE` 单站点、`CRON_EXPR` 全局、`crawl({site})` 旧签名均保留；`yfbzb` 现有行为不变。

## 修订 2026-08-20 — 总导航与静态服务（含进阶探针）

- **背景**: 用户要求“导航页，显示 yfbzb 和 ceb 的入口”且“通过域名访问”，需在不引入前端构建的前提下提供可被外部反代的入口页。
- **变更**:
  - `sites/yfbzb.js`/`sites/ceb.js` 新增 `displayName`/`description`/`originUrl` 供导航卡片展示；
  - `report.js` 新增 `collectSiteStats(site)`/`buildNavHtml(sitesData)`/`generateNav(sites)`（动态发现 `parseSitesList()`，`yfbzb`/`ceb` 置顶，缺失站点报告自动补空占位，`NAV_CSS`+`COMMON_CSS` 自适应，`file/index.html`+`file/tokens.css`）与 `generateAllReports(sites)` 末尾刷新导航，每站 `runOnce` 内 `crawl → generateReport → generateNav`；
  - 新增 `server.js`（零依赖 `http`，`createServer`/`startServer`/`buildHealthPayload`，托管 `file/` 于 `HTTP_PORT` 默认 8080，`EXPOSE 8080`，路由 `/`→总导航、`/<site>/`→站点报告、`safeJoin` 防穿越、`HEAD` 支持，`GET /health|/healthz|/api/health` 进阶探针 `no-store` 返回 `{status,timestamp,uptime,navExists,navGeneratedAt,totals,sites[]}`）；
  - `index.js` 启动时 `startServer()`+`generateNav(env.sites)` 预生成并在 `SIGINT`/`SIGTERM` 时关闭 HTTP 服务；
  - `Dockerfile` 加 `EXPOSE 8080`，`docker-compose.yml` 加 `ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"` + `healthcheck`（`node require('http').get(.../health)`，`interval 30s`）与 `HTTP_PORT`/`HTTP_ENABLED` env，`.env.example` 同步；
  - 意图由外部反代承载 `80/443` 与 HTTPS，本容器仅暴露 `8080`，域名 `your.domain.com/`→总导航、`/<site>/`→报告、`/health`→探针。
- **兼容**: `HTTP_ENABLED=false` 可禁用服务，`SITES` 单站点与旧 `file/<site>/` 报告路径不变；纯静态 `file/index.html` 仍可 `file://` 打开。

## 修订 2026-08-21 — ceb 代理换 IP 根治 WAF 405

- **背景**: `ceb` 在容器内固定出口 IP 下 `GET 405 → fallback POST 仍 405` 空转 100 页（宿主机同 URL `axios` 200），根因系阿里云 WAF 按 IP 段拦截，与指纹无关；`requestDelay`/`batchSize:1`/`fallbackOn405` 仅止损，不根治。`puppeteer-core + chromium` 治错方向（+~150MB、内存 800m），应以换 IP 根治。
- **变更**:
  - 移除 `puppeteer-core`/`chromium` 全链路（`package.json`/`Dockerfile`/`docker-compose.yml` 回调至轻量 400m/`cpus 0.5`）；`crawler.js` 新增 `resolveProxyUrl`/`getProxyAgents`/`isNoProxy`/`desensitizeProxyUrl`（优先级 `PROXY_<SITE>/CEB_PROXY_URL/PROXY_URL/HTTP_PROXY` + `NO_PROXY` 白名单，`axios` 注入 `proxy:false + httpAgent/httpsAgent`，事件 `proxy_enabled/bypassed/invalid`），保留双 405 快败与连续 405 熔断（代理下 405 仍触发）；
  - `sites/ceb.js` 删 `engine:'browser'`，回归 `axios` + `fallbackOn405` + 代理注释（`HTTP_PROXY=http://easy_proxies:24000`），`requestDelay/batchSize:1` 保留防风控；
  - 当时的代理 sidecar 配置为实验性方案；该配置模型已在 2026-08-28 迁移中废弃，当前配置契约见下方 easy_proxies multi-port 修订，不再使用旧的 `mixed-port`/代理组字段；
  - `package.json` 改为 `http-proxy-agent`/`https-proxy-agent`，文档全量脱敏（`xxx.xxx.xxx.xxx` 占位）。
- **权衡**: 镜像回到轻量、无 `chromium` 体积/内存负担；换 IP 才是对 IP 段封禁的根治，代理仅 `ceb` 按需启用，不影响 `yfbzb` 直连。
- **验证**: 代理解析/白名单/脱敏单测；`mockAxios` 双 405 快败 `calls=4` 与熔断；当时已有测试通过，当前完整回归以 2026-08-28 修订中的 8 套件结果为准。

## 修订 2026-08-28 — 迁移到 easy_proxies multi-port

- **背景**: `ceb` 需要在固定出口被 WAF 拦截时快速换 IP；原控制面实现已由备份分支保留，本分支统一采用 easy_proxies 的独立端口模式。
- **变更**:
  - `docker-compose.yml` 默认启动 `ghcr.io/jasonwong1991/easy_proxies:latest`，挂载 `./easy_proxies:/etc/easy_proxies`，管理 API 使用 `9091`，业务端口暴露 `24000-24200`。
  - `easy_proxies/config.yaml.example` 使用 `mode: multi-port`、`multi_port.base_port: 24000`、`management.listen: 0.0.0.0:9091`、`subscription_refresh` 和 `subscriptions`。
  - `sites/_easy_proxies.js` 读取 `/api/nodes` 的健康节点，按 `port` 轮换；`POST /api/auth` 仅在配置密码时使用，订阅通过 `POST /api/subscription/refresh` 刷新。
  - `crawler.js` 只保留 easy_proxies provider 选择、运行时端口切换、本站 Agent 重建、轮尽短路和第一页探针；旧 provider 与配置文件已删除。
  - `test/easy_proxies.test.js` 与 `test/dual405.test.js` 覆盖节点契约、认证降级、端口轮换、双 405 当前页重试、节点轮尽和第一页 gateAbort。
- **权衡**: easy_proxies 管理面或节点池不可用时，爬虫安全降级为当前代理/直连；真实镜像启动与 CEB 线上请求需在具备 Docker 和可用订阅的环境补验。
- **验证**: `npm test`、聚焦 easy_proxies/第一页测试和 JS 语法检查已通过；本机未安装 Docker，`docker compose config/pull/up` 尚未执行。

## 后果

- 正面：换机器/重装可通过 `docker compose up -d` 常驻、`ghcr.io` 拉取、宿主机 `file/`/`logs/` 可审计；新站点接入成本为“一配置对象（`sites/<site>.js` 策略） + `SITES` 加名”，无需新增 compose 服务；各站可独立定制抓取/解析/边界与定时。
- 负面/权衡：`nextCronDelay` 仅支持 `m h * * *`，复杂 cron 需另引依赖；多架构构建在 x86 runner 上 QEMU 较慢（需要时可先单架构）；一容器内 `N*batchSize` 并发可能对目标站限流敏感，可通过站点 `batchSize` 自降并发或后续加站间错峰/全局限流。

## 备选方案（已否决）

- `supercronic`/`crond` 常驻：额外进程与信号/时区复杂度，不采纳。
- Named volume：宿主机不可直读、站点隔离不直观，不采纳。
- 策略类/插件抽象：第二站点完全未知，过度抽象，不采纳。

## 验证

- `npm test` / `node test/run.js` 当前 8 套件全绿（`withTempCwd` 按 `file/<site>/`/`logs/<site>/`/`state-<site>.json` 隔离）。
- `SITE=<未知>` 单站点启动即 `getSiteConfig` 抛错、exit 1，不落脏文件；`SITES=yfbzb,<未知>` 多站点下未知站点 warn 跳过、`yfbzb` 正常运行（对应 `file/<site>/`/`logs/<site>/` 不创建）。
- 策略钩子：`buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`linkPrefix` 均有单测/冒烟覆盖；`SITES=yfbzb,ceb` 并发冒烟 `file/yfbzb/` 与 `file/ceb/`、`logs/yfbzb/` 与 `logs/ceb/` 隔离且 `site` 前缀正确。
- 每站独立定时：`CRON_YFBZB`/`CRON_CEB`/`SITES_CONFIG` 解析与 `nextCronDelay` 逐站校验。
- 导航与静态服务已有代码/回归覆盖：`generateNav()` 生成 `file/index.html`（卡片 `yfbzb`/`ceb` 置顶，`displayName`+统计+`↗ 原站`，缺失报告自动补空），`server.js` 提供 `/`、`/<site>/` 与 `/health` 路由；完整 Docker 启动、healthcheck、`docker stop` 优雅退出及真实 CEB 代理请求仍需在具备 Docker 和可用订阅的环境补验。
- 本机未安装 Docker，因此 `docker build`、`docker compose config/pull/up`、容器日志/健康检查和真实 CEB 请求尚未执行；不能把上述手工验证标记为已完成。
