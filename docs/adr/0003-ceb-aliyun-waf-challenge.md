# ADR 0003 — ceb 旧源启用阿里云 WAF acw 挑战求解

- **日期**: 2026-10-26
- **状态**: 已采纳
- **上下文**: ceb 旧源 `bulletin.cebpubservice.com` 的反爬形态从「直接 405 阻断」变为「先下发可解 JS 挑战，未解再 405」。原实现只处理 405，导致挑战页被当成空页，出现「新增 0 条」的静默失败。

## 背景

2026-10-26 实测（干净出口 IP）：

1. 首次请求搜索页返回 `HTTP 200` 挑战页（约 27 KB）：混淆脚本 + `<textarea id="renderData">{"_waf_...":"..."}</textarea>`，响应头带 `Set-Cookie: acw_tc=...`。
2. 脚本以 **URL 重写模式**工作：解析 `document.location.href`，追加签名参数（本次为 `time__2652=...`）后写回 `location.href`，**不写** `acw_sc__v2` cookie。
3. 未解挑战就重试，同一出口 IP 的搜索页会返回 `405` 阻断页（约 2.6 KB）并冷却数十分钟；首页 `/` 不受影响。
4. 在 vm 沙箱内执行挑战脚本可解出签名 URL；带 `acw_tc` 重放后 WAF 放行（在 `www.cebpubservice.com` 上验证到源站 404，说明已越过 WAF）。
5. 冷却于 2026-10-26 16:12 解除后完成闭环复验：`bulletin` 搜索页首次返回 `200` 盾页（26913 字节，`acw_tc=yes`），沙箱解出 `time__2652` 签名 URL，重放返回 `200` 真实列表页（32301 字节，`challenge=false`）。
6. 用仓库真实代码路径（`crawler.crawlPage(1, sites/ceb.js, new Set(), 1)`）验证：日志 `waf_challenge_solved` → `page_fetched`，解析出 **20 条**公告，`failed=false`、`shieldType` 未触发，耗时 5.7s（含站点抖动）。证明「识别 → 求解 → 重放 → parse」全链路成立。

原实现的失败路径：

- `sites/ceb.js#parse` 在挑战页上找不到 `table.table_text`，返回 `[]`。
- `crawler.js#crawlPage` 的站点自定义 `parse` 分支返回 `{ pageData: [], failed: false }`。
- `crawler.js#crawl` 命中 `!hasNewDataInBatch && failedCount === 0`，执行 `early_stop`。
- 结果：不报错、不换 IP、不保留断点，日志写「新增 0 条」。

## 决策

1. 新增 `sites/_aliyun_waf.js`：识别盾页（`200` + `_waf_`/`renderData`/`acw_sc__v2`/`punish-type`），在 vm 沙箱内执行挑战脚本（超时 5 秒，沙箱不暴露 `require`/`process`/文件系统/网络），产出签名 URL 与重放 cookie（`acw_tc`；旧式 `acw_sc__v2` 兼容）。
2. `sites/ceb.js` 声明 `challenge: { detect, solve }` 钩子，仅 ceb 启用。
3. `crawler.js#crawlPage` 在 HTTP 响应之后、`parse` 之前处理挑战：求解并重放一次；求解失败返回 `failed: true, shieldType: 'acw'`，不再交给 `parse`。
4. `crawl()` 增加连续挑战失败熔断（≥2 页）：盾页不可解时换 IP 只会拿到同样的盾，提前结束避免烧掉整池出口。
5. 挑战脚本来自外部站点。**vm 不是硬安全边界**（Node 官方说明），本决策只用它隔离宿主能力、限制执行时间；更强的隔离应改为独立进程。新站点启用 `challenge` 前必须显式评估。

## 影响

- 站点策略新增可选 `challenge` 钩子；`crawler.js` 的站点配置清单与文档同步。
- ceb 的每页抓取多一次请求（原请求 + 签名重放）；求解成功后同一响应继续走 `parse`。
- `405` 仍是阻断页语义，继续走既有 `GET→POST`、换点与连续 405 熔断流程；挑战求解失败不再进入 405 降级（重放拿到的 HTTP 状态直接记为盾页失败），两类失败分别累计，盾页熔断优先判定。（2026-10-28 由 ADR 0007 修订：ceb 改为 `failFast405`，GET 405 不再降级 POST。）
- 测试：`test/aliyun_waf.test.js` 覆盖识别、求解、重放、求解失败与熔断；`test/easy_proxies.test.js` / `test/staleSnapshot.test.js` 改用 `withTempCwd()`，测试日志不再写进仓库真实 `logs/<site>/`（此前的假 405 日志即由此产生）。
