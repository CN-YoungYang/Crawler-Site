# ADR 0007 — CEB 405 快败：跳过 GET→POST 降级

- **日期**: 2026-10-28
- **状态**: 已采纳
- **上下文**: ADR 0001/0003 保留 `GET 405 → POST` 降级的依据是「WAF 可能按方法拦截」。2026-09-22 的 CEB 生产 JSONL 中，每一次 `fallback_post` 都紧跟 `page_failed_dual405`，POST 从未成功；换到新节点后的下一次 GET 才拿到结果。ADR 0006 已确认 CEB 的 405 是目标站按出口 IP 封禁，`easy_proxies` 的 `blacklist_duration` 只处理连接失败，不覆盖 HTTP 405。

## 决策

1. `sites/ceb.js` 声明 `failFast405: true`，并关闭 `fallbackOn405`。
2. `crawler.js` 在 `fallbackOn405` 降级之前处理 `failFast405`：GET 405 记 `page_failed_405_fastfail`，直接调用 `switchProxy('dual405')`（复用 ADR 0006 的节点冷却），换到新出口后重试当前页一次；不再向同一 IP 发 POST。
3. 第一页仍受 `firstPageProbeLimit` 限制；非首页每页最多换点后重试一次。换点后重试仍 405 时返回 `proxySwitched: false`，让 `breaker` 的连续 405 计数生效；第二次 405 只冷却当前节点并给下一页选出口，不再重试。换点次数通过 `proxySwitchCount` 单独累计，只用于熔断日志。旧实现会再换一次并报 `proxySwitched: true`，把连击无限清零。
4. `fallbackOn405` 代码路径保留，供其它可能按方法拦截的站点使用。

## 取舍

- 若未来 CEB 的 WAF 改为「仅 GET 405、POST 放行」，本决策会错过该路径；当前日志没有这种证据，且 405 后换 IP 是更通用的恢复手段。
- 每页少打一发 POST，降低封禁期对出口池的消耗；代价是 GET 405 后必须换点，节点池轮尽时本轮提前结束。
- 非首页第二次 405 不再「换点即重置观察窗」，而是计入连续 405；连续 2 页即熔断并保留断点，避免逐页烧节点。
- 解盾重放请求收到 405 时仍按 `shieldType: 'acw'` 记失败页并熔断，不冷却/换点；重放 405 可能来自签名失效而非出口封禁，需日志证据后再决定是否并入 `failFast405`。

## 影响

- `crawler.js`：新增 `switchAfter405()` 与 `failFast405` 分支；非首页第二次 405 不再报换点成功。
- `breaker.js`：`proxySwitchCount` 单独累计 405 换点次数，不参与连击清零。
- `sites/ceb.js`：`failFast405: true`、`fallbackOn405: false`。
- 测试：`test/failFast405.test.js` 覆盖单发换点、首页探针限次、非首页防连击清零与整轮熔断。
- 日志：新增 `page_failed_405_fastfail`；`circuit_break_405`/`proxy_switched_reset_405` 措辞去掉「双 405」的限定。
