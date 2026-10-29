# ADR 0009 — 断点瘦成纯游标、去重改持久台账、续跑补扫头部

- **日期**: 2026-10-29
- **状态**: 已采纳
- **上下文**: 2026-10-29 生产日志中，yfbzb 04:07 轮 1-10 页全 468、05:09 轮 1-30 页通过后 31-40 页全 468，两轮断点分别停在 1 和 31；同时报告累计 12528 条，而断点里的去重集只有 4510 个 id。

## 背景

1. **续跑不看头部**：有断点时 `currentPage` 从断点页起、`existingIds` 取断点里的 id 集，既不读 Excel 也不回扫 1..N-1。站点的窗口是最新 3000 条（100 页 × 30），新增永远落在第 1 页，于是"续跑"这一轮必然看不到这一小时的新增。
2. **断点会被 468 钉死**：断点只前移、且停在最小失败页。468 是 IP 级风控，连续几轮命中同一段时，游标每轮从同一页重撞同一段拦截，头部永远等不到下一轮。
3. **去重集寿命错位**：断点清空后去重退回 `readRecentIds` 的"今日 + 昨日"两天 Excel 窗口；断点存在时又只认断点里那份只增不减的 id 集。两套临时物互相打架，才有 12528 条 vs 4510 个 id 的账。
4. **状态没挂卷**：`state-<site>.json` 落在容器可写层，`docker compose up --build` 一次就把断点和去重集一起抹掉。

## 决策

1. **断点只存游标**：`state/<site>/checkpoint.json`（`v:2`），字段 `currentPage`、`visited`（已访问页区间并集）、`pending`（被 468 跳过、待复活的页）、`blockCounts`、`sweepId`、`lastSweepCompletedAt`、`consecutiveIncompleteRounds`。id 不进断点。
2. **去重唯一真相源是台账**：`state/<site>/ids.json`（`id → publishDate`，原子写，35 天保留），由 `ledger.js` 独占。台账缺失/为空时才退回 `readRecentIds()` 的两天窗口。
3. **续跑先补扫头部**：`currentPage > 1` 时从第 1 页起扫，连续 2 页整页零新增即停，上限 `HEAD_SCAN_MAX_PAGES`（默认 15，占每轮约 30 页额度的一半）。补扫不推进尾部游标，结束后直接跳到尾部位置。
4. **468 逃逸**：同一页连续 2 轮命中才允许跳过并记入 `pending`；第 1 轮仍钉住游标。每轮开头用 1 页配额复活 `pending` 首项，连续 3 次探测失败标记 `gaveUp` 并记 `pending_page_given_up`（`error`）——标记而不删除，状态页仍能看到「哪几页没拿到」。
5. **每轮页数预算**：`SCAN_PAGE_BUDGET`（默认 30）页封顶，头部补扫最多吃一半（`min(HEAD_SCAN_MAX_PAGES=15, floor(预算/2))`），用尽即收工、断点留给下一轮。
6. **完整扫描用覆盖判定**：每页要么访问过、要么在 `pending` 里。`1..有效总页数` 全覆盖即一次完整扫描——`sweepId+1`、`visited` 清空、游标回 1、写 `lastSweepCompletedAt`。撞边界时边界及其之后的页一次性记平。**断点文件不再删除**（否则完成时间戳无处安放）。
7. **状态整目录挂卷**：Compose 增加 `./state:/app/state`，`.gitignore` 忽略 `state/`。
8. **v1 断点不兼容**：见到即删并记 `checkpoint_legacy_ignored`，不做字段迁移。

## 取舍

- **游标可以回退**：新游标停在"最老欠账页"（既没访问过、也不在 `pending` 的页），因此可能比本轮扫到的位置更靠前。这不是 2026-10-27 那类"断点越过失败页"的 bug——方向相反，是用来补空档的；重复抓到的行由台账去重。
- **头部补扫有上限，不追求一次扫完**：15 页之外的空档留给后续轮次填平，因为站点每轮只放行约 30 页。
- **早停不对头部批次生效**：头部的"零新增"是追平信号，不是收工信号；否则续跑轮会在头部收工、永远走不到尾部。
- **窗口淘汰仍会漏**：被新公告挤出站点 3000 条分页上限的记录，任何页码都取不到。这是站点可见性上限，不是本方案的漏抓，写进 README 已知限制。

## 影响

- `ledger.js`（新）：`loadLedger/addRows/saveLedger/pruneLedger/ledgerFile`。
- `crawler.js`：断点 v2 读写与区间运算；`crawl()` 增加台账去重、头部补扫、468 逃逸、`pending` 复活、覆盖记账；`noteBatchRetry()` 用本批真实失败页代替批次起始页（原先"1-3 页成功、4-6 页被拦"会把游标拉回第 1 页）；`writeStatus()` 落 `status.json`。
- `server.js`：新增 `GET /status`（`no-store`），只读 `state/*/status.json`；`/health` 保持轻量，不掺业务指标（否则业务告警会把容器判死）。
- `docker-compose.yml` / `.gitignore`：`./state` 挂卷与忽略。
- 测试：新增 `ledger.test.js`、`checkpointShape.test.js`、`headScan.test.js`、`blockEscape.test.js`、`statusEndpoint.test.js`；既有断点相关用例改读 `state/<site>/checkpoint.json`，"正常收尾不保留断点"改为"游标回第 1 页"。
