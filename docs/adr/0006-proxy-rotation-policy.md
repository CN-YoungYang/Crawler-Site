# ADR 0006 — 代理主动轮换、首页探针限次与 405 节点冷却

- **日期**: 2026-10-28
- **状态**: 已采纳
- **上下文**: CEB 在 2026-10-28 两轮定时任务中，第一页的 19/21 个 easy_proxies 节点全部返回 HTTP 405（约 2.6KB 的 405 页），判定为出口 IP 被目标站 WAF 封禁。此前 CEB 在固定出口上曾出现同样的 405；easy_proxies 的 `blacklist_duration` 只处理代理连接失败，不会把 HTTP 405 当成坏节点。

## 背景

1. 原实现只有遇到 405 才换点：一轮里的所有页面都压在当前出口 IP 上。CEB 每页是「冷请求 + 解盾重放」两发，100 页就是 200 发，单 IP 很快触发 WAF。
2. 每轮 `crawl()` 都从基础端口 `24000` 开始；成功页后 `rotation.reset()` 清空本轮已试节点，导致后续换点容易回到刚被 405 的节点。
3. 第一页探针会一路换到节点池轮尽；一次失败就把整池节点各打一到两发，扩大封禁面。
4. 节点被封后，下一轮仍从同一出口开始，缺少跨轮的节点冷却记忆。

## 决策

1. **主动按页轮换**：站点可声明 `rotateEveryPages`。`crawl()` 每成功 N 页调用一次 `rotation.switch('scheduled')`；成功后用 `rotation.reset({ keepTried: true })` 保留本轮已用节点，避免反复在节点一/节点二之间打转。CEB 配置 `rotateEveryPages: 10`。
2. **405 节点冷却**：`sites/_easy_proxies.js#switchNode` 在 `reason === 'dual405'` 时把当前节点按 `站点|tag` 记入冷却表，默认 12 小时，可用 `EASY_PROXIES_NODE_COOLDOWN_MS` 覆盖。`fetchNodes` 过滤冷却节点；全部节点都在冷却时返回 `exhausted: true, allCooled: true`，上层暂停本轮。轮首由 `crawl()` 调用 `rotation.switch('round_start', { keepCurrentIfHealthy: true })`：基础端口仍在冷却期时先切到健康节点，当前出口健康时保持不动。只有全部原始节点都处于冷却期才算 `allCooled`；节点全部不可用/未完成探测/被拉黑时返回 `allCooled: false, unavailable: true`，不冒充冷却。
3. **首页探针限次**：站点可声明 `firstPageProbeLimit`。第一页 405 或网络失败探针最多尝试 N 个节点（初始节点计 1 个），达到上限返回 `probeLimitReached: true, gateAbort: true`，不继续请求后续页，剩余节点留到下一轮。CEB 配置 `firstPageProbeLimit: 3`。
4. `crawl()` 的汇总日志区分三种收尾：探针轮尽、探针限次、全部节点冷却；对应 `crawl_end` 事件带 `gateAborted/probeLimited/allNodesCooled`。非首页换点发现全部节点冷却时以 `all_nodes_cooled` 立即暂停；主动轮换遇到全冷却以 `proxy_rotation_all_cooled` 暂停本轮并保留断点。

## 取舍

- 主动轮换会增加管理 API 调用与少量切点开销；CEB 每 10 页一次，远小于被封后整轮失败的成本。
- 12 小时冷却可能暂时缩小可用池；可调 `EASY_PROXIES_NODE_COOLDOWN_MS`（例如 6 小时）平衡池容量与恢复速度。
- 首页探针限次可能在剩余节点中错过一个干净出口（405 或网络失败场景）；下一轮会继续尝试，符合「先保护 IP 池」的目标。
- 轮首换点依赖管理面 `/api/nodes`：管理面不可达时保持当前出口，不会因为冷却表而阻塞整轮。

## 影响

- `proxyRotation.js`：`makeSwitchResult` 透出 `allCooled`；`reset({keepTried})` 支持主动轮换；`switch(reason, options)` 透传 `keepCurrentIfHealthy`。
- `sites/_easy_proxies.js`：节点冷却表、过滤、`proxy_pool_all_cooled` / `proxy_pool_unavailable` / `proxy_node_cooling` 日志；`_resetNodeCooldown` 测试钩子；`switchNode` 支持轮首保持健康出口。
- `crawler.js`：`rotateEveryPages`、`firstPageProbeLimit` 接线；`first_page_probe_limited`、`first_page_all_cooled`、`all_nodes_cooled`、`proxy_initial_switch`、`proxy_rotation_all_cooled` 事件。
- `sites/ceb.js`：启用 `rotateEveryPages: 10` 与 `firstPageProbeLimit: 3`。
- 测试：`test/proxySchedule.test.js`、`test/firstPageProbeLimit.test.js`、`test/nodeCooldown.test.js`。
