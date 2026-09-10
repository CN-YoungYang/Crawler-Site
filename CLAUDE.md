# CLAUDE.md

本文件是 Claude/Codex 等 AI 助手在本仓库工作的专属指引。修改爬虫行为前，先阅读本文件、`AGENTS.md`、`CONTEXT.md` 和相关 ADR。

## 项目概览

这是一个 Node.js 招标公告爬虫，抓取 `yfbzb.com` 的 `invitedBidSearch` 列表和 `ceb`（中国招标投标公共服务平台·湖北），按公告 `id` 去重后按发布日期写入 Excel。项目支持一个容器并发运行多个站点，每个站点具有独立调度、解析策略、日志、报告和断点文件。

`server.js` 提供零依赖静态服务，托管 `file/` 下的总导航与站点报告，默认监听 `HTTP_PORT=8080`。`/health` 是轻量存活探针，供反向代理、监控和 Compose 的 `healthcheck`（健康检查）使用。`ceb` 在固定出口被 WAF 拦截时通过 easy_proxies 多端口代理换 IP；订阅地址、密码和节点 IP 不得写入日志或提交仓库。

## 常用命令

```bash
# 本地运行：页数、批次间隔毫秒、启动前最小/最大随机延迟秒数
node index.js [页数] [间隔毫秒] [最小延迟秒] [最大延迟秒]
node index.js 100 5000 0 300

# 容器推荐配置
SITES=yfbzb,ceb TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR='0 2 * * *' node index.js

# 测试
npm test
node test/run.js

# Docker
docker build -t crawler:local .
docker compose up -d --build
docker compose logs -f crawler
curl http://127.0.0.1:8080/health | jq
docker compose down
```

环境变量优先于位置参数。`SITES` 为逗号分隔的站点列表，`SITE`/`CRAWLER_SITE` 保留单站点兼容；每站可使用 `TOTAL_PAGES_<SITE>`、`INTERVAL_MS_<SITE>`、`MIN_DELAY_S_<SITE>`、`MAX_DELAY_S_<SITE>`、`CRON_<SITE>` 覆盖全局值，也可以使用 `SITES_CONFIG` JSON。`CRON_EXPR` 为空时单次运行后常驻；只支持 `m h * * *` 格式时按日调度。

## 架构与数据流

数据流为：`index.js` → `crawler.js` + `log.js` + `sites/` → `report.js` → `server.js`。

1. **`index.js`**：解析并校验环境变量，验证 `getSiteConfig()` 和 `nextCronDelay()`，启动静态服务，预生成 `file/index.html`，刷新 easy_proxies 订阅，并为每个站点启动 `scheduleLoopForSite`。站点调度通过 `Promise.all` 并发；每轮执行 `crawl()` → `generateReport(site)` → `generateNav()`。收到 `SIGINT`/`SIGTERM` 时停止新批次并关闭 HTTP 服务。
2. **`crawler.js`**：按站点批次并发抓取。默认 `BATCH_SIZE=10`，`ceb` 使用 `batchSize:1` 和 `requestDelay` 串行限速。导出 `crawl()`、`crawlPage()`、`backoffDelay()`、`readRecentIds()`、`fileDir()`、`stateFile()`、`isStopping()` 和 `refreshProxyProviders()`。
3. **`log.js`**：同时写中文控制台日志和按站点、按日期划分的 JSONL 日志。并发调用 `log(msg, { site })` 时必须显式传站点。
4. **`report.js`**：扫描 `file/<site>/*.xlsx`，按站点生成索引、日期明细和共享样式，并生成 `file/index.html` 总导航。索引页内联跨日期最新 `LATEST_PREVIEW_COUNT=10` 条预览；`generateAllReports(sites)` 并发生成报告。
5. **`server.js`**：托管 `file/`，支持 `/`、`/<site>/`、`/file/...`、`/health`、`HEAD` 和 xlsx 下载。使用 `safeJoin` 防止路径穿越，健康探针不扫描 xlsx。

## 站点策略

站点配置位于 `sites/<site>.js`，可提供 `buildUrl`、`parse`、`extractId`、`isBoundary`、`parseTotalPages`、`linkPrefix`、`batchSize`、`failureThreshold`、`timeout`、`headers`、`proxy`、`requestDelay` 和 `fallbackOn405`。默认策略 `defaultBuildUrl`、`defaultParse`、`defaultExtractId`、`defaultIsBoundary` 内联在 `crawler.js`。注册表 `sites/index.js` 当前只包含 `yfbzb` 和 `ceb`。

`yfbzb` 直接使用 `axios`。`ceb` 使用 `axios` 加 `http-proxy-agent`/`https-proxy-agent`，代理优先级为 `PROXY_<SITE>`、`CEB_PROXY_URL`、`PROXY_URL`、`HTTP_PROXY`，并遵守 `NO_PROXY` 白名单。easy_proxies 代理提供方通过 `/api/nodes` 发现健康节点，通过端口轮换换 IP；`POST /api/subscription/refresh` 受冷却时间限制，失败时安全降级。

## 关键行为约定

- 403 或站点 `isBoundary(error)` 判定表示数据边界，不是网络失败，不重试、不计入失败数，并返回 `endReached`。
- 网络、超时和 405 才进入重试流程，使用指数退避加全量随机抖动；`backoffDelay()` 的基数为 2 秒，上限为 60 秒。
- `GET 405` 在 `fallbackOn405` 开启时降级为 `POST`；双 405 快败并尝试换端口，成功换点后重置连续 405 计数。第一页探针会持续换用未尝试节点，直到成功或返回 `gateAbort`；节点池轮尽时 `crawl()` 取消本轮。
- 连续无状态网络失败达到 `NET_FAIL_SWITCH_THRESHOLD=2` 时换 IP，换点后仍失败达到 `NET_FAIL_BREAK_THRESHOLD=6` 时熔断。
- 去重以 `id` 为主键：先与今日和昨日 Excel 中的 `readRecentIds(site)` 比较，再在合并写盘时用 `Set` 再次保护，新行优先。
- `state-<site>.json` 保存 `currentPage` 和 `existingIds`。正常完成时删除；优雅中断、代理熔断或写盘失败时保留，供下次续跑。
- 输出按 `publishTime` 分组写入 `file/<site>/<date>.xlsx`；历史扁平 `file/*.xlsx` 保留，不迁移。

## 测试与修改要求

测试使用 Node 内置断言和 `require.cache` 模拟 `axios`。加载新模拟时先调用 `mockAxios`，再调用 `freshCrawler()`；写入文件的测试使用 `withTempCwd()`。修改后运行 `npm test` 或 `node test/run.js`，当前应通过 9 个测试套件。

不要手工编辑 `file/`、`logs/` 或其他运行时生成文件。修改站点时同步检查 `sites/index.js`、`crawler.js`、`README.md` 和相关测试；修改领域术语或架构决策时阅读 `CONTEXT.md` 和相关 `docs/adr/`。

## 智能体技能

### 问题追踪器（Issue）

本仓库的问题单和规格说明记录在 GitHub Issues（CN-YoungYang/Crawler-Site）中，相关操作使用 `gh` 命令行工具。详见 `docs/agents/issue-tracker.md`。

### 领域文档

本仓库采用单一上下文（single-context）：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。
