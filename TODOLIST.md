# easy_proxies 迁移 TODO

更新时间：2026-08-28

## 当前已完成

- [x] 选用 `ghcr.io/jasonwong1991/easy_proxies:latest` 作为 Compose 代理 sidecar。
- [x] 新增 `easy_proxies/` 配置目录和 `config.yaml.example`，采用 `multi-port` 模式。
- [x] Compose 挂载 `./easy_proxies:/etc/easy_proxies`，crawler 默认使用 `easy_proxies:24000`。
- [x] 新增 `sites/_easy_proxies.js`，负责管理 API、节点发现、端口轮换、认证和订阅刷新。
- [x] crawler 支持代理 provider 选择和运行时代理端口切换。
- [x] CEB 配置为 `GET 405 → POST 405` 后切换 easy_proxies 节点，再重新请求当前页面。
- [x] 移除旧代理适配器、配置目录及 Compose/文档引用，运行链路仅保留 easy_proxies。
- [x] 增加真实配置、节点文件、运行时文件的 Git 忽略规则。

## 接下来必须完成

### 1. 确认 easy_proxies 实际接口契约

- [ ] 用实际镜像启动后确认管理地址和端口：`9091`。
- [x] 已按当前官方源码/文档确认 `GET /api/nodes` 的 `nodes[].port`、`tag/name` 和可用状态字段。
- [x] 已确认登录接口 `POST /api/auth` 的请求/响应格式；未启用密码时管理 API 无需 token。
- [x] 已确认订阅刷新接口为 `POST /api/subscription/refresh`。
- [x] 已确认 `config.yaml` 的 `multi_port`、`management`、`subscriptions` 配置键与当前镜像源码一致。
- [x] 已按上述契约对齐适配器和示例配置；实际镜像启动仍需在有 Docker 的环境验证。

### 2. 补测试

- [x] 增加 easy_proxies 节点列表解析和独立端口轮换测试。
- [x] 增加 CEB 双 405 后切换端口并重试当前页的测试。
- [x] 覆盖节点轮尽：返回 `exhausted`，不重复请求已尝试端口。
- [x] 覆盖管理 API 不可达、空节点池和认证失败的安全降级。
- [x] 确认旧 `crawlPage` 调用签名不受影响，并将旧代理轮换回归改为 easy_proxies 契约。

### 3. 文档与静态检查

- [x] 盘点仓库全部 Markdown：`README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`、`TODOLIST.md`、两份 ADR、进度记录，以及通用的 `docs/agents/` 文档。
- [x] 更新 `README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`、两份 ADR 和进度记录中的代理部署说明。
- [x] 修正 README Compose 示例缩进、第一页探针描述、easy_proxies 环境变量、配置准备步骤和当前 8 套件验证状态。
- [x] 清理 Markdown 中的旧代理名称、旧控制面端口/配置模型和过时的 6 套件/“只重试一次”描述；通用 `docs/agents/` 文档无需领域内容变更。
- [x] `crawler.js`、`sites/_easy_proxies.js` 语法检查通过；Compose 语法检查待 Docker 环境执行。
- [x] 执行 `git diff --check`，没有空白错误。

### 4. 本地验证

```powershell
Copy-Item easy_proxies/config.yaml.example easy_proxies/config.yaml
# 编辑 easy_proxies/config.yaml，至少填写 subscriptions
npm test
docker compose config
docker compose pull easy_proxies
docker compose up -d
docker compose ps
docker compose logs -f easy_proxies crawler
```

- [x] `npm test` 已通过（8 个测试套件）。
- [ ] Docker 未安装于当前环境，上述镜像启动、Compose 校验、健康检查和真实 CEB 请求尚未执行。

- [ ] 确认 `/health` 返回 `status: "ok"`。
- [ ] 确认 CEB 通过代理请求，且日志不泄露订阅地址、密码或节点 IP。
- [ ] 通过测试或真实日志确认：GET 405 → POST 405 → 换端口 → 当前页重新请求。
- [ ] 确认换端口后旧 keep-alive Agent 被销毁，不会继续复用旧出口。
- [ ] 确认节点池轮尽时本轮抓取停止，不会无限重试或跳过 405 页面。

## 接入前配置

1. 复制 `easy_proxies/config.yaml.example` 为 `easy_proxies/config.yaml`。
2. 在 `subscriptions` 中填写真实订阅地址。
3. 仅在自定义部署时按实际镜像版本调整 `management` 和 `multi_port` 配置；当前示例已按官方契约对齐。
4. 确认 `CEB_PROXY_URL` 使用 `http://easy_proxies:24000`，不要把管理端口 `9091` 当作代理端口。
5. 不要提交 `easy_proxies/config.yaml`、`nodes.txt`、`node_ports.json` 或密码。

## 恢复方案

- 本次变更已删除旧代理适配器与 Compose 配置；如需恢复旧部署，请从已备份的分支恢复，并重新执行 `npm test` 与 `docker compose config`。
