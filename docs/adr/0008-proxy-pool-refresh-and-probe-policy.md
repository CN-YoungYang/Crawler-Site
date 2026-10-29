# ADR 0008 — 轮前代理池准备、刷新收敛与首页探针策略

- **日期**: 2026-10-29
- **状态**: 已采纳；修订 ADR 0006 第 3 条（首页探针限次）

## 上下文

1. **2026-10-28 08:37 生产日志**：`crawl_start` 无条件刷新订阅，0.43 秒后轮首换点读 `/api/nodes`，58 个订阅节点里只有 5 个 `initial_check_done=true`，其余被 `normalizeNodes` 当「未完成探测」过滤。第一页探针从这 5 个里连试 3 个全 405，整轮 0 条。同一订阅在 10-28 白天的可用节点是 21 个（ADR 0006），5 个是异常值。
2. **成因**：easy_proxies 的 `min_available_nodes` 是「至少 N 个节点探测通过就继续」，不是「全部探测完」；`POST /api/subscription/refresh` 返回时池子仍在重建。而 easy_proxies 自己每 30 分钟刷一次（`subscription_refresh.interval: 30m`），crawler 每轮开头再刷一次既重复、又正好把池子打回「探测中」。
3. **首页限次的代价**：ADR 0006 的「第一页最多试 3 个节点」在 10-28「19/21 个节点全 405」的两轮里并没有换来数据，只是提前放弃；而任何池子都不保证每个节点有效，固定试 3 个等于把当轮结果押在运气上。

## 决策

1. **轮前池子检查**（`crawler.js#prepareProxyPool` + `sites/_easy_proxies.js#poolStatus`）：可用节点 ≥ `MIN_USABLE_POOL`（3）就跳过整池刷新；< 3 才刷新；全部节点在冷却期时**不刷新、不换点、第一发请求都不发**，直接暂停本轮并保留断点（刷新清不掉 crawler 侧冷却表，白重建一次隧道再等 20 秒没有意义）。
2. **刷新后收敛等待**（`sites/_easy_proxies.js#waitPoolSettled`）：刷新返回后按 700ms 采样 `/api/nodes`，连续 3 次无新增、或达到订阅自报 `node_count`、或超过 `EASY_PROXIES_SETTLE_TIMEOUT`（默认 20 秒）即返回，并记 `proxy_pool_settled`（可用 N → M）。管理面中途不可达立即放弃，不影响刷新本身的成败。`EASY_PROXIES_SETTLE_TIMEOUT=0` 关闭等待。
3. **首页探针**：`ceb` 改 `firstPageProbeLimit: 0`（不设次数上限），试到成功、节点池轮尽或全部冷却为止；新增 `firstPageProbeTimeoutMs: 300000`（5 分钟）兜底，超时返回 `probeTimeoutReached: true, gateAbort: true` 并记 `first_page_probe_timeout`。其它站点仍可用 `firstPageProbeLimit` 限次。
4. **预算用尽只冷却不选点**：达到次数/时间上限时仍冷却当前 405 节点，但通过 `switchNode({ coolOnly: true })` 只记账、不再选新出口——否则日志会先写「已切换节点 X → Y」、下一毫秒又写「探针达到上限」，读者会以为第 N+1 个节点被试过。
5. **启动刷新计数**：只统计真正配了代理提供方的站点（`crawler.js#hasProxyProvider`），不再用全部站点做分母（旧日志里的 `1/2 个代理站点` 就是这么来的）。

## 取舍

- **全试一遍会在整池被封时烧光当天可用节点**：21 个节点约 1.5–3 分钟、12 小时冷却，当天后续轮次会因全冷却跳过。这是有意选择：换取 p=0.9 时 89% 的首轮命中率，而不是「省着用」的 27%。
- **跳过轮前刷新依赖 easy_proxies 自己的 30 分钟定时刷新**（`subscription_refresh.enabled: true`，示例配置已注明必须开启）。该开关关掉时，池子会停留在启动时拉到的节点。
- **5 分钟上限**只在池子异常大或管理面变慢时触发；正常 21 个节点约 1.5–3 分钟。
- 池子真的只有 5 个可用时，收敛等待会如实记 5 → 5，不掩盖「订阅本身没有更多可用节点」这个事实。

## 影响

- `sites/_easy_proxies.js`：新增 `poolStatus`、`waitPoolSettled`、`switchNode` 的 `coolOnly` 选项。
- `crawler.js`：新增 `prepareProxyPool`、`MIN_USABLE_POOL`、`hasProxyProvider`；`firstPageProbeTimeoutMs` 与 `first_page_probe_timeout` 事件；`crawl_end` 增加 `probeTimedOut`。
- `sites/ceb.js`：`firstPageProbeLimit: 0`、`firstPageProbeTimeoutMs: 300000`。
- `index.js`：启动订阅刷新计数的分母。
- 测试：`test/poolSettle.test.js`、`test/poolPrepare.test.js`、`test/firstPageProbeTimeout.test.js`。

## 与 ADR 0006 的关系

ADR 0006 第 3 条（首页探针限次）与本条冲突之处，以本 ADR 为准；其第 1、2 条（主动按页轮换、405 节点冷却）与节点池轮尽/全冷却语义继续有效。
