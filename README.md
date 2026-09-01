# Crawler-Site

Node.js 爬虫，抓取 `yfbzb.com`（乙方宝官网）的招标信息公告（`invitedBidSearch` 查询接口）与 `ceb`（中国招标投标公共服务平台·湖北），按站点与发布日期去重后写入 Excel 文件。支持多站点隔离（`file/<site>/YYYY-MM-DD.xlsx` / `logs/<site>/` / `state-<site>.json`），一容器并发多站点、各站独立定时与逻辑（策略化），以 Docker 常驻容器运行并通过 GHCR 自动发布。内置轻量静态服务托管 `file/`，根 `/` 为总导航（动态发现 `yfbzb`/`ceb` 入口），每站报告在 `/<site>/`，`GET /health` 提供进阶探针供反代/监控与 `docker healthcheck` 使用，适合通过外部反代以域名对外暴露。

> ⚠️ 本爬虫仅用于合规的数据获取场景。请遵守目标站点的爬虫协议与访问频率限制，自行承担使用风险。查询条件与抓取逻辑按站点配置在 `sites/<site>.js`（`baseUrl`/`urlSuffix`/`selectors` + 可选策略钩子 `buildUrl`/`parse`/`extractId`/`isBoundary`/`batchSize`/`headers`，默认值内联于 `crawler.js` 的 `defaultBuildUrl`/`defaultParse`/`defaultExtractId`/`defaultIsBoundary`），`sites/yfbzb.js` 与 `sites/ceb.js` 为当前实站，注册表 `sites/index.js` 仅含这两站。

## 功能

- 分页抓取招标信息：标题、链接、公告类型、地区、发布时间
- 按 `id` 去重，避免重复入库（内存 + 落盘合并双重去重）
- 按站点与发布日期分区存储为 Excel：`file/<site>/YYYY-MM-DD.xlsx`（如 `file/yfbzb/2026-08-19.xlsx`），历史扁平 `file/*.xlsx` 保留不迁移
- 总导航 + 站点报告：`file/index.html` 总导航（动态发现 `sites/*`，`yfbzb`/`ceb` 置顶，卡片含统计 `总计天数 · 总记录 · 最近更新`、主入口 `→ file/<site>/index.html`、副链 `↗ 原站`）与每站 `file/<site>/index.html`/`tokens.css`/`<date>.html`（`report.js#generateNav`/`generateReport`，`NAV_CSS`/`TOKENS_CSS`/`COMMON_CSS` 自适应），随每次爬取与启动自动刷新，缺失站点报告自动补空占位避免 404
- 轻量静态服务：`server.js`（零依赖 `http`）托管 `file/` 于 `HTTP_PORT`（默认 8080，`EXPOSE 8080`），路由 `/` → 总导航、`/yfbzb/`/`/ceb/` → 各站报告、`HEAD` 支持、`xlsx` 下载头、防路径穿越，`HTTP_ENABLED=false` 可禁用；`docker-compose.yml` 已配 `ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"` 与 `healthcheck`，适合由外部反代（Nginx/Caddy/Traefik）将 `80/443 → 8080` 以域名暴露
- 进阶健康探针：`GET /health`/`/healthz`/`/api/health` 返回 `{status, timestamp, uptime, navExists, navGeneratedAt, totals:{sites,dates,records}, sites:[{site,displayName,description,totalDates,totalRecords,latestUpdate,hasReport}]}`（`no-store`），供 `docker healthcheck`、反代后端摘除与监控告警使用
- 失败页与“数据到底”分离识别，越界页（403）不再误判为加载失败、不会因单页失败而提前终止整次爬取
- 失败日志带 `error.code` / HTTP `status`，便于诊断
- 断点续跑：按站点 `state-<site>.json`（`currentPage` + `existingIds`），中途崩溃后下次从断点继续，不重抓已完成的页；正常跑完即删，不跨天残留
- 优雅退出：捕获 `SIGINT`/`SIGTERM`，等当前批次完成后落盘再退出（二次 Ctrl+C 强制退出），`docker stop` 可中断定时等待
- 双通道日志：控制台中文（`[site]` 前缀，`docker logs` 可区分）+ 结构化 JSONL，按站点按日分割 `logs/<site>/crawler-YYYY-MM-DD.jsonl`、30 天保留，`pruneOldLogs(site)` 与报告同窗口清理
- Docker 常驻：一容器并发多站点（`SITES=yfbzb,ceb`，`Promise.all` 站点并发、每站独立 `CRON_<SITE>` 定时），各站逻辑可通过 `sites/<site>.js` 策略钩子独立定制，Node 内置 `CRON_EXPR` 定时（`m h * * *`），`TZ=Asia/Shanghai`，bind mount 持久化 `file/`/`logs/`

## 环境要求

- Node.js（建议 18+）；容器运行需 Docker / Docker Compose
- 依赖已在 `package.json` 声明：`axios`、`cheerio`、`xlsx`、`http-proxy-agent`/`https-proxy-agent`（全站 `axios` 静态抓取，`ceb` 默认经 Compose 的 `easy_proxies` multi-port 代理换 IP）

安装依赖：

```bash
npm install
```

## 使用方法

### 本地（宿主机）

```bash
node index.js [页数] [间隔时间(毫秒)] [最小延迟(秒)] [最大延迟(秒)]
```

| 位置 | 参数 | 默认值 | 说明 |
|------|------|--------|------|
| 1 | 页数 | 100 | 页数硬上限；站点分页自报真实总页数更小时按较小者提前停止 |
| 2 | 间隔时间 | 5000 | 相邻批次之间的等待毫秒数 |
| 3 | 最小延迟 | 0 | 爬取开始前的随机等待区间下限（秒） |
| 4 | 最大延迟 | 300 | 爬取开始前的随机等待区间上限（秒） |

参数 3、4 仅用于**爬取开始前**的随机延迟，不影响逐批间隔。

```bash
# 爬 10 页，批次间隔 5 秒，立即开始
node index.js 10 5000 0 0

# 默认：100 页，批次间隔 5 秒，开始前随机等待 0~300 秒
node index.js
```

### 环境变量（容器推荐，优先级高于位置参数）

| 变量 | 默认 | 说明 |
|------|------|------|
| `SITES` / `SITE` / `CRAWLER_SITE` | `yfbzb,ceb` | 站点列表，逗号分隔，容器内并发，如 `SITES=yfbzb,ceb`；`SITE` 单站点兼容；未在 `sites/index.js` 注册的站点在多站点模式下 warn 跳过、单站点下 fail-fast |
| `TOTAL_PAGES` / `PAGES` | 100 | 同位置参数 1（硬上限；站点分页自报真实总页数更小时自动提前停止）；支持每站覆盖 `TOTAL_PAGES_<SITE>`（如 `TOTAL_PAGES_CEB=50`） |
| `INTERVAL_MS` / `INTERVAL` | 5000 | 同位置参数 2；支持每站覆盖 `INTERVAL_MS_<SITE>` |
| `MIN_DELAY_S` / `MIN_DELAY` | 0 | 同位置参数 3；支持每站覆盖 `MIN_DELAY_S_<SITE>` |
| `MAX_DELAY_S` / `MAX_DELAY` | 300 | 同位置参数 4；支持每站覆盖 `MAX_DELAY_S_<SITE>` |
| `CRON_EXPR` / `CRON` | 空 | 定时表达式，仅支持 `m h * * *`（如 `0 2 * * *` 表每日 02:00）；为空则单次运行后常驻等待；支持每站独立 `CRON_<SITE>`（如 `CRON_YFBZB="0 2 * * *"` `CRON_CEB="0 3 * * *"`）或 `SITES_CONFIG` JSON |
| `HTTP_PORT` / `PORT` | 8080 | 静态服务监听端口（托管 `file/`，`EXPOSE 8080`，`ports: "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"`）；由外部反代将 `80/443 → HTTP_PORT` 以域名暴露 |
| `HTTP_ENABLED` | true | 设为 `false` 禁用内置静态服务（仅保留爬取与报告生成） |
| `TZ` | `Asia/Shanghai` | 容器时区，必须与 `Dockerfile` `ENV TZ` 一致，否则日期分区错一天 |
| `CEB_PROXY_URL` / `PROXY_CEB` | Compose 中为 `http://easy_proxies:24000` | CEB 的代理入口；未设置时本地运行直连，换点时 crawler 会按健康节点改用其他业务端口 |
| `EASY_PROXIES_CONTROLLER` | Compose 中为 `http://easy_proxies:9091` | easy_proxies 管理地址，用于 `/api/nodes`、可选 `/api/auth` 与 `/api/subscription/refresh` |
| `EASY_PROXIES_PASSWORD` | 空 | 仅当 easy_proxies 管理面设置密码时填写；不要提交到仓库 |
| `EASY_PROXIES_REFRESH_COOLDOWN` | 600 秒 | 订阅刷新成功后的限频窗口；失败不会写入冷却时间 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 空 | 通用代理与直连白名单；站点专用 `CEB_PROXY_URL` / `PROXY_CEB` 优先级更高 |

```bash
SITES=yfbzb TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR="0 2 * * *" node index.js
# 每站独立定时与页数
SITES=yfbzb,ceb CRON_YFBZB="0 2 * * *" CRON_CEB="0 3 * * *" TOTAL_PAGES_CEB=50 node index.js
# 或 JSON 方式
SITES=yfbzb,ceb SITES_CONFIG='{"yfbzb":{"cron":"0 2 * * *"},"ceb":{"cron":"0 3 * * *","totalPages":50}}' node index.js
```

### Docker / Compose（推荐）

首次使用先准备 easy_proxies 配置（真实订阅地址只放在未跟踪的 `config.yaml` 中）：

```bash
cp easy_proxies/config.yaml.example easy_proxies/config.yaml
# 编辑 easy_proxies/config.yaml，填写 subscriptions，或准备 nodes.txt
```

配置字段和管理 API 以 [easy_proxies 官方 README](https://github.com/jasonwong1991/easy_proxies) 与[官方配置示例](https://github.com/jasonwong1991/easy_proxies/blob/main/config.example.yaml)为准。Compose 默认只在内部网络暴露管理端口 `9091` 和 multi-port 业务端口 `24000-24200`；需要宿主机直接访问时再在 `docker-compose.yml` 中显式取消 `ports` 注释。

```bash
docker build -t crawler:local .
docker compose up -d --build
docker compose logs -f crawler
curl http://127.0.0.1:8080/health | jq  # 进阶探针
docker compose down
```

`docker-compose.yml` 为双服务 `easy_proxies`（默认启用，multi-port 节点端口从 `24000` 开始，管理 API 为 `9091`）+ `crawler`，通过 `SITES=yfbzb,ceb` 一容器并发多站点，每站独立 `CRON_<SITE>` 与逻辑（`sites/<site>.js` 策略）。数据、日志与静态服务通过以下配置：

```yaml
services:
  easy_proxies:
    image: ghcr.io/jasonwong1991/easy_proxies:latest
    volumes: ["./easy_proxies:/etc/easy_proxies"]
    expose: ["9091", "24000-24200"]
  crawler:
    depends_on: { easy_proxies: { condition: service_started } }
    environment:
      - SITES=${SITES:-yfbzb,ceb}
      - HTTP_PORT=${HTTP_PORT:-8080}
      - HTTP_ENABLED=${HTTP_ENABLED:-true}
      - CEB_PROXY_URL=${CEB_PROXY_URL:-http://easy_proxies:24000}
      - EASY_PROXIES_CONTROLLER=${EASY_PROXIES_CONTROLLER:-http://easy_proxies:9091}
    ports:
      - "${HTTP_PORT:-8080}:${HTTP_PORT:-8080}"  # 宿主机:容器，意图由外部反代 80/443 → HTTP_PORT
    volumes:
      - ./file:/app/file
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
      interval: 30s
```

崩溃续跑如需保留 checkpoint，按站点分别挂载：`./state-yfbzb.json:/app/state-yfbzb.json` `./state-ceb.json:/app/state-ceb.json`。

**域名暴露**（推荐由外部反代承载 80/443 与 HTTPS，本容器仅暴露 8080）：

```nginx
# Nginx 示例：your.domain.com → 127.0.0.1:8080
server {
  listen 80; server_name your.domain.com;
  location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
# 访问：https://your.domain.com/ → 总导航，/yfbzb/ /ceb/ → 各站报告，/health → 探针
```

> 镜像 `TZ=Asia/Shanghai` 已在 `Dockerfile` 中固定（`tzdata` + `EXPOSE 8080`），否则 `readRecentIds()` / `publishTime` 分区会因 UTC 错一天。

## 输出

- **日志**：双通道。控制台中文实时输出（`[ISO] [PID: xxx] [yfbzb] ...`），`docker logs` 按站点可区分；同时写结构化 JSONL 到 `logs/<site>/crawler-YYYY-MM-DD.jsonl`（按站点按日分割，`event`/`site` 字段可 grep），供程序回溯。日志与 Excel 同享 30 天保留窗口，生成报告时一并清理过期日志。例如：

  ```
  [2026-08-14T06:35:01.358Z] [PID: 10572] [yfbzb] 爬取完成第 4 页，共找到 30 条新数据
  [2026-08-14T06:35:01.113Z] [PID: 10572] [yfbzb] 第 10 页无新增数据（站点边界），已爬至当日末尾
  ```

- **数据**：写入 `file/<site>/`，文件名按发布日期命名，如 `file/yfbzb/2026-08-14.xlsx`。每张表包含 `id`、`title`、`link`、`noticeType`、`area`、`publishTime` 等列；每站报告（`file/<site>/index.html`/`tokens.css`/`<date>.html`）与总导航 `file/index.html`/`file/tokens.css` 同落盘，由 `server.js` 以 `HTTP_PORT` 托管：`GET /` → 总导航（`yfbzb`/`ceb` 卡片，统计 + `↗ 原站`）、`GET /<site>/` → 站点报告、`GET /health` → 进阶探针、`GET /<site>/<date>.xlsx` → 下载。
- **Checkpoint**：`state-<site>.json`（cwd 相对，每批结束写入，正常完成即删）。

## 工作原理

整体数据流（`index.js` → `crawler.js` + `log.js` + `sites/` → `report.js` → `server.js`）：

1. **`index.js`**：解析环境变量（`SITES`/`TOTAL_PAGES`/`INTERVAL_MS`/`MIN_DELAY_S`/`MAX_DELAY_S`/`CRON_EXPR` + 每站覆盖 `TOTAL_PAGES_<SITE>`/`CRON_<SITE>`/`SITES_CONFIG` JSON、`HTTP_PORT`/`HTTP_ENABLED`，未设回退到位置参数）并校验（逐站 `getSiteConfig(site)` 与 `nextCronDelay(cronExpr)`，占位站点 warn 跳过），应用每站独立的启动前随机延迟，随后拉起 `server.js` 静态服务（`startServer()`，`HTTP_PORT` 默认 8080，`EXPOSE 8080`，`healthcheck` 在 `/health`）并预生成总导航 `generateNav()`，再进入 Node 内置调度器 `scheduleLoop`：每站一 `scheduleLoopForSite` 并发（`Promise.all`），`CRON_EXPR`/`CRON_<SITE>` 为空则单次运行后常驻等待，设为 `m h * * *` 则每站独立每日定时触发，等待可被 `SIGTERM`/`SIGINT` 按秒中断（`sleepInterruptible` 1s 轮询 `isStopping()`），退出时一并关闭 HTTP 服务；每站 `runOnce` 内 `crawl()` → `generateReport(site)` → `generateNav()` 保证导航统计新鲜。

2. **`crawler.js`**（日志经 `log.js` 双通道输出，站点隔离，显式 `log(msg,{site})` 避免并发竞态）：
   - **站点策略**：`sites/yfbzb.js` 实站（`axios`，含 `parseTotalPages` 真实总页数钩子）、`sites/ceb.js` 实站（`axios` + 代理换 IP，`batchSize:1`/`requestDelay`/`isBoundary` 区分）、`sites/index.js` 注册表 `getSiteConfig(site)`/`parseSitesList()`/`listEnabledSites()`（仅 `yfbzb`/`ceb`）；默认策略 `defaultBuildUrl`/`defaultParse`/`defaultExtractId`/`defaultIsBoundary` 内联于 `crawler.js`。`crawl({site,…})` / `crawlPage(pageNo, siteConfig, …)` 委托站点策略，缺省走 `selectors` + `linkPrefix` 默认解析。
   - **批次并发**：每批按站点 `batchSize`（默认 10）页并发抓取（`Promise.all`），批次间等待 `interval` 毫秒；`ceb` 为风控串行（`batchSize:1` + `requestDelay 2500-5500ms` + 代理换 IP）。
   - **逐页抓取**：`crawlPage()` 全站 `axios`（每站 `timeout`/`headers`/`method` 可覆写），`ceb` 默认经 `CEB_PROXY_URL` 使用 easy_proxies multi-port 代理换 IP（`http-proxy-agent`/`https-proxy-agent`，`NO_PROXY` 白名单；管理 API `9091`，订阅刷新 `POST /api/subscription/refresh`）。网络/超时/405 最多重试 3 次，退避指数 + 全量抖动（`base=2s`、封顶 60s）；`axios` 站点的 `GET 405` 在 `fallbackOn405:true` 时切 `POST`（不消耗 `retries`，有终局兜底），双 405 快败 + 连续 405 熔断（≥2 页 405 即停）避免空刷且换点成功重置观察窗；第一页遇到双 405 或网络失败会持续按序换用未试过的健康端口，每次换点重置该页重试额度，成功或节点池轮尽为止，轮尽返回 `gateAbort` 并取消本轮抓取。easy_proxies 空池/管理面不可达时安全降级；`isBoundary` 判定边界（默认 403，`ceb` 的 429 重试而非边界）。
   - **终止条件**（四者满足其一即停）：
     - 某批全部页无新数据 **且** 失败页数 ≤ `failureThreshold`（站点 `failureThreshold` 或 `FAILURE_STOP_THRESHOLD`=2）
     - 已爬到有效页数上限 `min(TOTAL_PAGES, 站点分页自报总页数)`（站点未报告或解析失败时退化为仅 `TOTAL_PAGES`；每批按最新观测重算，后观测覆盖前观测）
     - 任意页返回 `endReached` 标志（即 403 —— 见下文“关于 403”）
     - 第 1 页探针因节点池轮尽返回 `gateAbort`，本轮以 `first_page_gate_abort` 结束
   - **去重**：以 `id` 为主键做两次去重——内存中比对 `readRecentIds(site)`（读 `file/<site>/` 下今日与昨日的 Excel）筛掉已有条目，写盘时再次合并去重（新行优先）。
   - **分区写盘**：按 `publishTime` 分组，读已有 `file/<site>/<date>.xlsx` → 合并新行（新行优先）→ 整文件回写。
   - **断点续跑**：每批结束写 `state-<site>.json`（`currentPage` + `existingIds`），进程中途崩溃后下次从断点继续；正常跑完（触达边界或达 `totalPages`）后删除，不跨天残留。
   - **优雅退出**：捕获 `SIGINT`/`SIGTERM`，等当前批次完成后落盘再退出（二次 Ctrl+C 强制退出），`docker stop` 发送 `SIGTERM` 同理。

### 关于 403（重要）

**目标站点对 `pageNo` 超出“当日可访数据”的请求返回 403，这是正常的数据边界信号，不是加载失败。**

本爬虫据此做了专门处理：

- 收到 403 的页不会重试，会被标记为 `endReached`（已到末尾），爬虫据此干净停止；
- 失败日志中此类页显示为“无新增数据（站点边界），已爬至当日末尾”，而非报错；
- 真正的网络/超时错误才走重试与失败计数路径。

当日真实数据边界以实际 403 为准；不要把站点展示的近 1 个月存量总数当作当日可访问页数。真实总页数只取自分页控件（`.pagination` 子树内「共 N 条」÷ pageSize /「共 N 页」），绝不读统计横幅的存量总数（如 yfbzb「近1个月共76470条」）。

## GHCR 自动构建

`.github/workflows/docker-build.yml` 在 `push main` / `tag v*` / `workflow_dispatch` 时触发：

- `npm ci` + `npm test` 门禁
- `docker/build-push-action` 多架构 `linux/amd64,linux/arm64`（`setup-qemu` + `setup-buildx`），`gha` 缓存
- `docker/metadata-action` 生成标签：`latest`（仅 `main`）+ `sha` + `semver`/`major.minor`
- 推送至 `ghcr.io/<owner>/crawler`（需仓库 `Settings > Actions > Workflow permissions` 开 `Read and write`）

## 可调常量

`crawler.js` 顶部定义了可调常量，便于针对性优化：

| 常量 | 默认 | 作用 |
|------|------|------|
| `FAILURE_STOP_THRESHOLD` | 2 | 一批中失败页数超过此值则不触发“无新数据”早停，避免失败页伪装无新数据导致误停；可被站点 `failureThreshold` 覆盖 |
| `BATCH_SIZE` | 10 | 每批并发页数；可被站点 `batchSize` 覆盖（`ceb` 为风控串行设为 1） |
| `REQUEST_TIMEOUT` | 30000 | axios 单次请求超时（毫秒）；可被站点 `timeout` 覆盖 |
| `BACKOFF_BASE_MS` | 2000 | 重试退避指数基数（`base*2^attempt`） |
| `BACKOFF_CAP_MS` | 60000 | 退避封顶（毫秒） |
| `USER_AGENT` | Chrome 131 | 请求 UA，避免默认 axios UA 被一眼识别为爬虫；可被站点 `headers` 覆盖 |

> `ceb` 站串行（`batchSize:1`）+ `requestDelay: {min:2500, max:5500}` 随机抖动 + 双 405 快败/连续熔断 + easy_proxies multi-port 换 IP（`CEB_PROXY_URL`；管理 API 9091，节点端口从 24000 开始，轮尽零请求短路，成功页清空轮换记忆；Agent 隧道按站隔离），配合 `isBoundary` 的 429 重试语义降低限频与空刷风险；`yfbzb` 仍为 `axios` 并发。

## 目录结构

```
crawler/
├── index.js              # 入口：环境变量/参数解析、校验、静态服务拉起、调度（CRON/单次常驻，每批后刷新导航）
├── crawler.js            # 爬取核心：crawl() 编排（含真实总页数收窄上限）+ crawlPage() 逐页抓取 + checkpoint（按站点）
├── log.js                # 日志：控制台中文 + JSONL 双通道，按站点隔离，30 天保留清理
├── report.js             # 报告：scanFiles/generateReport 按站点生成 HTML，generateNav/buildNavHtml 生成总导航 file/index.html
├── server.js             # 静态服务：托管 file/ 于 HTTP_PORT，路由 / → 导航、/<site>/ → 站点报告、/health 进阶探针
├── sites/
│   ├── index.js          # 站点注册表：getSiteConfig(site)/parseSitesList()/listEnabledSites()（仅 yfbzb/ceb）
│   ├── _easy_proxies.js  # 默认 provider：管理 API、健康节点发现、multi-port 轮换与订阅刷新
│   ├── yfbzb.js          # 实站配置：baseUrl/urlSuffix/selectors/linkPrefix + displayName/description/originUrl（axios）
│   └── ceb.js            # 实站配置：axios + 代理换 IP/buildUrl/parse/extractId/isBoundary/batchSize:1/requestDelay/headers + displayName/originUrl
├── test/                 # 8 个零依赖 Node 测试套件与 fixtures
│   ├── easy_proxies.test.js # 节点契约、认证/刷新降级、端口轮换
│   └── dual405.test.js      # 双 405 当前页重试、第一页 gateAbort
├── Dockerfile            # node:20-alpine + tzdata/ca-certificates + TZ=Asia/Shanghai + EXPOSE 8080（轻量无 chromium）
├── docker-compose.yml    # 双服务 easy_proxies(默认启用，multi-port 24000+，管理 API 9091) + crawler 一容器多站点并发编排
├── .dockerignore
├── easy_proxies/
│   └── config.yaml.example  # multi-port 代理池与管理 API 示例
├── .github/workflows/docker-build.yml  # GHCR 构建推送（npm test 门禁，多架构）
├── CONTEXT.md            # 领域术语与边界（单上下文通用语言）
├── docs/
│   ├── adr/0001-docker-site-isolation.md  # Docker/GHCR/多站点隔离/导航静态服务决策
│   ├── adr/0002-ceb-keep-legacy-source.md # ceb 旧源与 ctbpsp 切换结论
│   ├── progress-ceb-ctbpsp.md              # ctbpsp 迁移终止与归档说明
│   └── agents/domain.md / issue-tracker.md
├── file/                 # 输出：file/index.html 总导航 + file/<site>/YYYY-MM-DD.xlsx + file/<site>/报告（bind mount 持久化，server.js 托管）
├── logs/                 # 日志：logs/<site>/crawler-YYYY-MM-DD.jsonl（bind mount 持久化）
├── state-<site>.json     # 按站点 checkpoint（每批写入，正常完成即删）
├── package.json
├── CLAUDE.md             # 给 AI 助手的代码库指引
├── AGENTS.md             # 贡献者指南
└── TODOLIST.md           # easy_proxies 接入与环境验证清单
```

## 已知限制

- 去重仅比对 `file/<site>/` 下今天与昨天的 Excel，跨日重复同一公告时不保证去重（按设计：跨日抓取本就期望重复入不同日期文件）。
- 历史扁平 `file/*.xlsx` 保留不迁移，`readRecentIds(site)` 仅读 `file/<site>/`，旧数据不会混入新站点。
- `CRON_EXPR`/`CRON_<SITE>` 仅支持 `m h * * *`（如 `0 2 * * *`），其他复杂表达式会在校验阶段报错；每站可独立定时。
- 若目标站点日后上更强反爬（`acw_sc__v2` JS 挑战升级等），`ceb` 已默认经 `CEB_PROXY_URL=http://easy_proxies:24000` 启用 multi-port 换 IP（管理 API `9091`，空节点池/管理面不可达时安全降级）；其余站点直连。
- 总导航 `file/index.html` 由 `report.js#generateNav` 动态发现站点（`SITES` 优先，`yfbzb`/`ceb` 置顶），缺失站点报告自动补空占位；健康探针 `GET /health` 每次实时 `scanFiles` 统计 `totalRecords`（读 xlsx），数据量极大时探针会有秒级开销。
- 测试使用 Node 内置断言，运行 `npm test` 或 `node test/run.js`；`SITES` 中列出未在 `sites/index.js` 注册的站点会 warn 跳过，单站点 `SITE=<未知>` 则 fail-fast。
- agent 工作流说明见 `AGENTS.md`，问题记录规则见 `docs/agents/issue-tracker.md`。
