# ADR 0005 — yfbzb HTTP 468：按风控拦截页快败并熔断，绝不判为数据边界

- **日期**: 2026-10-28
- **状态**: 已采纳
- **上下文**: 2026-10-28 生产日志（05:14-05:17 UTC）中，yfbzb 第 61-99 页连续返回 HTTP 468，每页按普通失败重试 3 次仍失败；breaker 没有对应规则，4 个批次空转后，第 100 页的 SafeLine 403 按末页边界收尾，汇总行仍写「新增 713 条，失败 41 页（成功 58 页），触达站点边界」。

## 背景

1. 468 不是标准 HTTP 状态码，常见于 WAF/风控拦截（阿里云等）。
2. 原实现只有 `blockType` 的 403 SafeLine 分支会快败；468 走通用重试：每页 3 发、每批 10 页并发，反而扩大封禁面。
3. `breaker` 只累计 405、`shieldType` 与网络连败。468 没有 `status` 以外的信号，连续 41 页失败也不会触发熔断。
4. `crawl()` 的有失败页时不早停，本意是避免掩盖数据；但没有熔断规则时会把「整页被风控」误当成「可能只是个别失败页」。
5. 末页 SafeLine 403 的位置判别只对 `safeline` 生效，这是对的：468 是访问被拦，不是页尾。

## 决策

1. `sites/yfbzb.js#blockType` 对 HTTP 468 返回 `'http468'`；SafeLine 403 仍返回 `'safeline'`。
2. `crawlPage()` 收取站点 `blockType` 时不再硬编码 `status === 403`：站点声明命中即快败为失败页（`shieldType`），不重试、不降级 POST。
3. `breaker` 把 `http468` 与 `acw`/`safeline` 一样计入连续 `shield`：连续 2 页熔断并保留最早失败页断点；`crawl()` 的 `circuit_break_waf` 日志区分三种类型。
4. 468 永不参与末页边界改写：只有 `shieldType === 'safeline'` 且页号 >= 已知末页时才按边界收尾。

## 取舍

- 不把 468 当边界是硬约束：把 468 当「到底了」会删断点并永久漏掉后续真实数据。
- 熔断后本轮不再尝试剩余页，下一轮从最早失败页续跑；相比逐页重试，少打几十倍请求，让风控冷却更快。
- 不因 468 自动调整 `BATCH_SIZE`/`INTERVAL_MS`：节奏是部署参数，代码只保证「遇到拦截不空转、不误报成功」。

## 影响

- `sites/yfbzb.js`：新增 `RATE_LIMIT_STATUS = 468` 与 `isRateLimitBlock`，`blockType` 返回 `http468`。
- `crawler.js`：`blockType` 不再限定 403；`circuit_break_waf` 增加 HTTP 468 文案。
- `breaker.js`：`record` 契约补充 `http468`（逻辑复用现有 `consecutiveShield`）。
- 测试：`test/yfbzb468.test.js` 覆盖单页快败、连续 2 页熔断保留断点、末页 468 不判边界。
