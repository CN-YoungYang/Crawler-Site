# Crawler-Site 部署手册

本文专门说明 Docker Compose 部署，配置以仓库当前的 `docker-compose.yml` 为准。

部署后包含两个服务：

- `easy_proxies`：为 `ceb` 提供 multi-port 代理。管理 API 使用容器网络内的 `9091`，代理端口范围为 `24000-24200`，默认不暴露到宿主机。
- `crawler`：由本地 `Dockerfile` 构建，抓取 `yfbzb`/`ceb`，生成 Excel 和 HTML 报告，并在 `HTTP_PORT`（默认 `8080`）提供静态访问。

## 1. 准备环境

部署机需要：

- Docker Engine；
- Docker Compose v2（当前 Compose 使用了可选 `env_file` 配置）；
- 能访问目标站点、Docker Hub 和 GHCR 的网络；
- 宿主机没有占用 `8080` 端口。

检查安装：

```bash
docker version
docker compose version
```

主机不需要安装 Node.js，Node.js 和 npm 依赖会在 crawler 镜像中安装。

## 2. 获取项目

```bash
git clone <仓库地址> crawler
cd crawler
```

已有项目则更新代码：

```bash
cd crawler
git pull
```

## 3. 准备本地配置

### 3.1 创建 `.env`

`.env` 是本机配置文件，不提交 Git。复制示例：

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

首次联调建议关闭随机启动等待并减少页数：

```dotenv
SITES=yfbzb,ceb
TOTAL_PAGES=3
TOTAL_PAGES_CEB=3
INTERVAL_MS=5000
INTERVAL_MS_CEB=8000
MIN_DELAY_S=0
MAX_DELAY_S=0
CRON_EXPR=
TZ=Asia/Shanghai
HTTP_PORT=8080
HTTP_ENABLED=true
```

`CRON_EXPR` 为空时，启动后执行一次并保持容器运行。生产环境可设置每天定时，例如：

```dotenv
CRON_EXPR=0 2 * * *
```

时间按 `TZ=Asia/Shanghai` 解释，只支持 `分 时 * * *` 格式。

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `SITES` | 站点列表，默认 `yfbzb,ceb`；只部署 yfbzb 时设为 `yfbzb`。 |
| `TOTAL_PAGES` | 全局页数硬上限。 |
| `TOTAL_PAGES_CEB` | 仅覆盖 ceb 页数。其他站点可使用相同的 `<SITE>` 后缀规则。 |
| `INTERVAL_MS` | 批次间隔，单位毫秒。 |
| `CRON_EXPR` | 全局每日调度；为空表示单次运行后常驻。 |
| `CRON_YFBZB` / `CRON_CEB` | 每站独立调度，优先级高于全局 cron。 |
| `HTTP_PORT` | 报告服务端口，默认 `8080`。 |
| `HTTP_ENABLED` | 是否启用报告服务；Compose healthcheck 要求为 `true`。 |
| `TZ` | 必须保持 `Asia/Shanghai`，否则日期分区可能偏移。 |

### 3.2 创建 easy_proxies 配置

```bash
cp easy_proxies/config.yaml.example easy_proxies/config.yaml
```

PowerShell：

```powershell
Copy-Item easy_proxies/config.yaml.example easy_proxies/config.yaml
```

编辑 `easy_proxies/config.yaml`，至少完成以下一项：

- 在 `subscriptions` 中填写真实代理订阅地址；或
- 准备 `nodes.txt`，每行写一个代理 URI，并保留 `nodes_file: nodes.txt`。

默认关键配置如下，通常不需要修改：

```yaml
mode: multi-port
multi_port:
  address: 0.0.0.0
  base_port: 24000
management:
  enabled: true
  listen: 0.0.0.0:9091
```

如果 easy_proxies 管理面设置了密码，在 `.env` 中填写相同密码：

```dotenv
EASY_PROXIES_PASSWORD=你的管理面密码
```

crawler 使用：

```dotenv
CEB_PROXY_URL=http://easy_proxies:24000
EASY_PROXIES_CONTROLLER=http://easy_proxies:9091
EASY_PROXIES_REFRESH_COOLDOWN=600
```

不要把订阅地址、密码、节点文件提交到仓库。`.env`、`config.yaml`、`nodes.txt` 和运行时节点文件已加入忽略规则。

## 4. 启动前检查

先只检查 Compose 配置，不启动服务：

```bash
docker compose config --quiet
```

如果失败，优先检查 Docker Compose 版本、`.env` 格式、YAML 缩进和 `HTTP_PORT` 是否被占用。配置展开结果可能包含密码，不要直接公开粘贴完整输出。

## 5. 首次启动

先拉取代理 sidecar，再构建并启动 crawler：

```bash
docker compose pull easy_proxies
docker compose up -d --build
docker compose ps
```

当前 Compose 对 crawler 同时声明了 `build` 和 `image`：执行 `docker compose up -d --build` 时以本地 `Dockerfile` 构建为准，并按 Compose 的 `image` 字段标记为 `rxyoungyang/crawler:latest`；CI 发布地址由 `DOCKERHUB_USERNAME` secret 决定，如用户名不同需同步修改 `docker-compose.yml` 的 `image`。

查看启动日志：

```bash
docker compose logs --tail=100 easy_proxies
docker compose logs --tail=100 crawler
```

持续跟踪 crawler：

```bash
docker compose logs -f crawler
```

## 6. 验证部署

### 6.1 健康检查

```bash
curl -fsS http://127.0.0.1:8080/health
```

正常响应类似：

```json
{
  "status": "ok",
  "navExists": true,
  "totals": { "sites": 0, "dates": 0, "records": 0 },
  "sites": []
}
```

`/health` 是轻量存活探针，不扫描 xlsx，因此 `totals` 和 `sites` 为空是设计行为，不代表没有抓取数据。数据和报告请通过页面、宿主机文件或日志确认。

### 6.2 访问报告

浏览器访问：

```text
http://服务器IP:8080/
http://服务器IP:8080/yfbzb/
http://服务器IP:8080/ceb/
```

路由含义：

- `/`：总导航页；
- `/yfbzb/`：乙方宝报告；
- `/ceb/`：中国招标公共服务平台湖北报告；
- `/health`：健康探针。

### 6.3 检查宿主机产物

抓取数据和日志会保存在项目目录：

```text
file/yfbzb/*.xlsx
file/ceb/*.xlsx
file/index.html
logs/yfbzb/crawler-YYYY-MM-DD.jsonl
logs/ceb/crawler-YYYY-MM-DD.jsonl
```

`file/` 和 `logs/` 是 bind mount，删除容器不会删除其中的数据。

## 7. 生产环境建议

建议使用以下起点，再按目标站点访问量调整：

```dotenv
SITES=yfbzb,ceb
TOTAL_PAGES=100
TOTAL_PAGES_CEB=30
INTERVAL_MS=5000
INTERVAL_MS_CEB=8000
MIN_DELAY_S=0
MAX_DELAY_S=300
CRON_EXPR=0 2 * * *
TZ=Asia/Shanghai
HTTP_PORT=8080
HTTP_ENABLED=true
CEB_PROXY_URL=http://easy_proxies:24000
EASY_PROXIES_CONTROLLER=http://easy_proxies:9091
EASY_PROXIES_REFRESH_COOLDOWN=600
```

`ceb` 已内置单页串行和 2.5–5.5 秒请求延迟，不建议删除限速。需要分开调度时使用：

```dotenv
CRON_EXPR=
CRON_YFBZB=0 2 * * *
CRON_CEB=0 3 * * *
```

只部署 yfbzb 时：

```dotenv
SITES=yfbzb
```

## 8. 域名和 HTTPS

Compose 默认只把 crawler 的 `HTTP_PORT` 暴露到宿主机；easy_proxies 的 `9091` 和 `24000-24200` 只在 Compose 内部网络开放。

生产环境建议防火墙只开放 `80/443`，由 Nginx、Caddy 或 Traefik 反向代理到 `127.0.0.1:8080`。Nginx 最小示例：

```nginx
server {
    listen 80;
    server_name crawler.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

报告服务本身没有登录认证，如需限制访问，应在反向代理或防火墙层增加认证和访问控制。不要把 easy_proxies 管理端口或代理端口直接暴露到公网。

## 9. 更新、备份和回滚

更新前备份配置和产物。Linux/macOS 示例：

```bash
tar czf crawler-backup-$(date +%F).tar.gz .env easy_proxies file logs
```

PowerShell 示例：

```powershell
Compress-Archive -Path .env,easy_proxies,file,logs -DestinationPath (crawler-backup-{0}.zip -f (Get-Date -Format yyyy-MM-dd))
```

更新并重建：

```bash
git pull
docker compose pull easy_proxies
docker compose up -d --build
docker compose ps
```

只修改 `.env` 或代理配置时：

```bash
docker compose up -d --force-recreate crawler
```

回滚代码时切换到旧提交或标签后重建：

```bash
git checkout <旧提交或标签>
docker compose up -d --build
```

不要使用 `docker compose down -v` 作为常规更新命令；`file/` 和 `logs/` 是宿主机 bind mount。

## 10. checkpoint 续跑

正常完成、触达边界或达到页数上限后，`state-<site>.json` 会被删除。收到 `SIGTERM`、代理熔断或文件写入失败时会保留 checkpoint。

Compose 默认没有挂载 checkpoint。需要容器删除后仍能续跑时，在 crawler 的 `volumes` 中加入实际启用站点的挂载：

```yaml
volumes:
  - ./file:/app/file
  - ./logs:/app/logs
  - ./state-yfbzb.json:/app/state-yfbzb.json
  - ./state-ceb.json:/app/state-ceb.json
```

checkpoint 只是临时续跑状态，真正的归档对象是 `file/` 和 `logs/`。

## 11. 停止和清理

优雅停止：

```bash
docker compose stop
```

停止并删除容器/网络，但保留 bind mount 数据：

```bash
docker compose down
```

## 12. 常见故障

### Compose 报 `env_file` 或 `required` 不支持

升级 Docker Compose v2。当前 Compose 使用了可选 `.env` 配置，过旧版本无法识别 `required: false`。

### crawler 显示 unhealthy

确认 `HTTP_ENABLED=true`。Compose healthcheck 固定访问 `/health`，关闭 HTTP 服务会导致 crawler 被标记为 unhealthy。然后查看：

```bash
docker compose logs --tail=200 crawler
```

### easy_proxies 没有可用节点

检查 `easy_proxies/config.yaml` 是否存在、订阅地址是否可访问（或 `nodes_file` 是否存在）、管理监听是否为 `0.0.0.0:9091`，再查看：

```bash
docker compose logs --tail=200 easy_proxies
```

### CEB 持续 405

确认业务代理端口和管理端口没有写反：

```dotenv
CEB_PROXY_URL=http://easy_proxies:24000
EASY_PROXIES_CONTROLLER=http://easy_proxies:9091
```

管理面不可达或节点池为空时 crawler 会安全降级，但 CEB 可能无法取得数据。

### `file/` 或 `logs/` 权限错误

入口脚本会尝试把 bind mount 改为容器 `node` 用户所有。Linux 上仍失败时：

```bash
sudo chown -R 1000:1000 file logs
```

### 端口被占用

修改 `.env`：

```dotenv
HTTP_PORT=18080
```

然后：

```bash
docker compose up -d --force-recreate crawler
```

访问地址变为 `http://服务器IP:18080/`。

## 13. 上线检查清单

- [ ] `.env`、`easy_proxies/config.yaml`、`nodes.txt` 未提交 Git；
- [ ] `9091` 和 `24000-24200` 未暴露到公网；
- [ ] 防火墙只开放必要的 HTTP/HTTPS 端口；
- [ ] 订阅地址和管理密码没有写入日志、截图或工单；
- [ ] `file/`、`logs/` 已纳入备份；
- [ ] `HTTP_ENABLED=true`，`/health` 返回 200；
- [ ] `TZ=Asia/Shanghai` 未被覆盖；
- [ ] 首次上线已查看 crawler 和 easy_proxies 日志。
