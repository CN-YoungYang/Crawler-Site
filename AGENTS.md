# 仓库指南

## 项目结构与模块组织

这是一个面向公开招标公告的 Node.js 爬虫，当前支持 `yfbzb.com` 和 `ceb`，并支持在一个容器中并发抓取多个站点。运行流程应保持直接、易于维护。

- `index.js`：入口文件。解析 `SITES`（逗号分隔，兼容 `SITE`，默认 `yfbzb`）、`TOTAL_PAGES`、`INTERVAL_MS`、`MIN_DELAY_S`、`MAX_DELAY_S` 和 `CRON_EXPR`，以及 `TOTAL_PAGES_<SITE>`、`INTERVAL_MS_<SITE>`、`MIN_DELAY_S_<SITE>`、`MAX_DELAY_S_<SITE>`、`CRON_<SITE>` 和 `SITES_CONFIG` JSON 等每站覆盖；校验站点与 cron；启动 `server.js` 静态服务（默认 `HTTP_PORT=8080`，受 `HTTP_ENABLED` 控制，提供 `/health`）；预生成 `file/index.html` 总导航，并运行基于 `setTimeout` 的调度器。每个站点的 `scheduleLoopForSite` 通过 `Promise.all` 并发运行，`CRON_EXPR` 为空时单次运行后常驻，`m h * * *` 时按日调度；每次 `generateReport(site)` 后刷新导航。
- `crawler.js`：负责抓取、HTML 解析、重试、去重、断点续跑、优雅退出和 Excel 输出。通过 `sites/<site>.js` 的 `buildUrl`、`parse`、`extractId`、`isBoundary`、`linkPrefix`、`parseTotalPages`、`batchSize`、`headers`、`proxy`、`requestDelay` 和 `fallbackOn405` 实现站点策略；默认策略内联在本文件。使用 `file/<site>/` 和 `state-<site>.json` 做站点隔离，`crawl({site,…})`、`crawlPage(pageNo, siteConfig, …)` 为新签名，并保留旧的 `(baseUrl, urlSuffix)` 测试签名。代理通过 `HTTP_PROXY`、`CEB_PROXY_URL`、`PROXY_CEB` 和 `NO_PROXY` 注入 `axios`，使用 `http-proxy-agent`/`https-proxy-agent`、`proxy:false + httpAgent/httpsAgent`，支持双 405 快败、第一页探针、节点端口轮换和网络失败熔断。
- `log.js`：提供控制台中文日志与结构化 JSONL 双通道日志。日志按站点写入 `logs/<site>/crawler-YYYY-MM-DD.jsonl`；并发多站点时必须显式传递 `site`。保留 `currentSite`/`setSite()` 兼容旧调用，但它们在并发场景下可能竞态；`logDir(site)` 和 `pruneOldLogs(site)` 也按站点工作。
- `report.js`：按站点扫描 Excel、生成报告和导航。`scanFiles(site)`、`generateReport(site)` 生成 `file/<site>/index.html`、日期明细页和 `tokens.css`；索引页跨全部日期内联最新 `LATEST_PREVIEW_COUNT=10` 条预览。`generateAllReports(sites)` 通过 `Promise.all` 并发生成报告；`collectSiteStats(site)`、`buildNavHtml(sitesData)` 和 `generateNav(sites)` 动态发现 `sites/*`，将 `yfbzb`/`ceb` 置顶，生成 `file/index.html` 总导航，卡片链接到 `file/<site>/index.html` 并提供 `↗ 原站`，缺失报告时补空占位。
- `server.js`：零依赖静态服务，托管 `file/`，默认监听 `HTTP_PORT=8080`。`/` 返回 `file/index.html` 总导航，`/<site>/` 返回站点报告，`/file/...` 前缀兼容反向代理；使用 `safeJoin` 防路径穿越，支持 `HEAD` 和正确的 MIME 类型。`/health`、`/healthz` 和 `/api/health` 返回带 `no-store` 的轻量健康 JSON，不扫描 xlsx，并供 Compose 的 `healthcheck`（健康检查）使用。
- `sites/`：站点注册表与策略。当前注册 `yfbzb`、`ceb`；`sites/yfbzb.js` 和 `sites/ceb.js` 是实站配置，后者使用串行 `batchSize:1`、请求抖动、代理换 IP、405 熔断和 `displayName`/`originUrl` 等展示元数据。`sites/index.js` 提供 `getSiteConfig()`、`listEnabledSites()`、`normalizeSites()` 和 `parseSitesList()`；默认策略仍内联在 `crawler.js`。
- `test/`：零依赖 Node 测试套件与夹具。`test/run.js` 会加载全部 `*.test.js`，包含解析/去重、边界、退避、合并、终止、easy_proxies 节点契约和双 405 探针测试；测试通过 `require.cache` 模拟 `axios`。
- `file/`：运行时生成的 Excel、HTML 报告和总导航，按站点与发布日期分区，例如 `file/yfbzb/2026-08-14.xlsx`，并生成 `file/<site>/index.html`、`<date>.html`、`file/index.html` 和对应样式。不要手工编辑生成文件；旧的扁平 `file/*.xlsx` 保留，不迁移。
- `logs/`：运行时生成的按站点、按日期划分的 JSONL 日志，例如 `logs/yfbzb/crawler-YYYY-MM-DD.jsonl`；报告生成时按 30 天窗口清理。
- `state-<site>.json`：按站点保存的临时断点，批次写入；正常完成后删除，优雅中断、代理熔断或写盘失败时保留以便续跑。
- `Dockerfile`、`.dockerignore`、`docker-compose.yml`：Node 20 Alpine 镜像和双服务 Compose 配置。`easy_proxies` 默认提供 `9091` 管理 API 与 `24000-24200` 多端口；`crawler` 以 `SITES=yfbzb,ceb` 并发运行，挂载 `file/`、`logs/`，使用 `HTTP_PORT`、`HTTP_ENABLED`、`healthcheck`、`mem_limit=400m` 和 `cpus=0.5`；启动及每轮抓取前按 `EASY_PROXIES_REFRESH_COOLDOWN=600s` 限频刷新订阅，空池或管理面不可达时安全降级。
- `.github/workflows/docker-build.yml`：在推送 `main`、版本标签或手动触发时，先运行 `npm test`，使用 GHA 缓存构建并推送 amd64/arm64 镜像；需要 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 密钥。
- `docs/agents/`：工程技能的工作流、问题追踪和领域文档约定。
- `jsreverse-yidun/`：被 Git 忽略的 CEB 逆向归档。ctbpsp 迁移已于 2026-08-25 终止，结论见 `docs/progress-ceb-ctbpsp.md`；不要重复攻坚该求解器。
- `CLAUDE.md`：仓库专属 AI 助手指引，修改爬虫行为前必须阅读。
- `TODOLIST.md`：easy_proxies 契约工作与仍待 Docker 实机验证的清单。

## 构建、测试与开发命令

- `npm install`：安装依赖。
- `node index.js [pages] [intervalMs] [minDelaySec] [maxDelaySec]`：运行爬虫，例如 `node index.js 10 5000 0 0`。
- `SITES=yfbzb,ceb TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR='0 2 * * *' node index.js`：使用环境变量运行多站点调度。
- `node test/run.js` 或 `npm test`：运行全部测试。
- `Copy-Item easy_proxies/config.yaml.example easy_proxies/config.yaml`：准备本地代理配置；填写订阅或 `nodes_file`，配置文件不得提交。
- `docker build -t crawler:local .`、`docker compose up -d --build`、`docker compose logs -f crawler`、`docker compose down`：构建、启动、查看日志和停止容器。

项目没有配置独立的构建、格式化或代码检查工具。使用当前受支持的 Node.js 版本，项目基线为 Node 18+。

## 编码风格与命名约定

- 使用 CommonJS（`require`/`module.exports`）、2 个空格缩进、分号和 `camelCase` 命名。
- 测试文件命名为 `test/<behavior>.test.js`。
- 命令行（CLI）用法、运行时日志和用户可见文案使用中文。
- 保持 `crawler.js` 的边界与失败语义清晰：403 或站点 `isBoundary` 表示数据边界，不应作为网络故障重试；`isBoundary`、`buildUrl`、`parse`、`extractId` 和 `parseTotalPages` 通过站点策略提供。
- 去重主键是站点策略 `extractId` 得到的 `id`。必须保留内存过滤和合并写盘两层保护。
- 断点文件为 `state-<site>.json`，按站点隔离；正常完成后删除，优雅中断或写盘失败时保留以便续跑。
- `backoffDelay()` 使用指数退避和全量随机抖动，基数 2 秒、上限 60 秒，并保持为纯函数。
- `GET 405 → POST` 降级、双 405 快败、节点端口轮换、第一页 `gateAbort`、网络失败换 IP 和熔断必须保持对 `axios` 全链路有效。
- 每站点可以覆盖 `batchSize`、`failureThreshold`、`timeout`、`headers`、`proxy` 和 `requestDelay`；没有覆盖时使用 `BATCH_SIZE`、`FAILURE_STOP_THRESHOLD`、`REQUEST_TIMEOUT` 和 `USER_AGENT` 默认值。

## 测试约定

- 测试使用 Node 内置断言，不引入测试框架。
- 需要重新加载带有新 `axios` 模拟的爬虫模块时，使用 `test/helper.js` 中的 `freshCrawler()`。
- 写入 Excel、日志或断点的测试使用 `withTempCwd()`，确保 `file/<site>/`、`logs/<site>/` 和 `state-<site>.json` 不污染真实工作区。
- 根据行为覆盖解析、去重、403 边界、重试退避、文件合并、抓取终止、真实总页数上限、easy_proxies 节点认证与轮换。
- 修改前后运行 `node test/run.js` 或 `npm test`。
- 多站点测试应验证 `file/<site>/`、`logs/<site>/` 和 `state-<site>.json` 互相隔离。`SITES` 中未注册的站点在多站点模式下警告并跳过，单站点模式下快速失败。
- 模拟代理提供方请求时，必须先安装 `axios` 模拟，再加载 `crawler.js` 或 `sites/_easy_proxies.js`。

## 提交与合并请求约定

- 使用 Conventional Commit 前缀，并附简洁的中文摘要，例如 `fix: 修正 403 边界处理`。
- 每次提交保持聚焦。
- 合并请求应说明行为变化、验证命令和结果；必要时附上能说明用户可见变化的输出或截图。

## 安全与配置

- 遵守目标站点的爬虫政策和访问频率限制。
- 查询条件、URL 和选择器属于站点配置，位于 `sites/<site>.js`，由 `crawler.js` 使用。
- CEB 固定出口被 WAF 拦截时，通过 `CEB_PROXY_URL` 使用 easy_proxies 多端口换 IP；默认代理入口为 `http://easy_proxies:24000`，管理 API 为 `9091`。管理面不可达或节点池为空时必须安全降级。
- 不记录订阅地址、密码或节点 IP，不提交凭据、运行时配置和生成产物。
- 一个容器可以并发运行多个站点，站点之间必须隔离 `file/<site>/`、`logs/<site>/` 和 `state-<site>.json`。
- `TZ=Asia/Shanghai` 必须在镜像和 Compose 中保持一致，否则日期分区会偏移。
- 修改抓取范围前先检查 `sites/index.js` 注册表和 `crawler.js` 中的默认策略；当前注册表只有 `yfbzb` 和 `ceb`。
