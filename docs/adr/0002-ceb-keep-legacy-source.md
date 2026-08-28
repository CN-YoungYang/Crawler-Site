# ADR 0002 — ceb 维持旧源代理换 IP，否决切换 ctbpsp.com JSON API

- **日期**: 2026-08-25
- **状态**: 已采纳（否决性决策：ceb 不切换数据源）
- **上下文**: `ceb` 旧源 `bulletin.cebpubservice.com` 依赖代理换 IP 绕阿里云 WAF（ADR 0001 修订），代理链路曾连续 5 页全败。为根治提出切换 `ctbpsp.com` JSON API（`/cutominfoapi/recommand/...`，DES-ECB 加密响应）。经完整 JS 逆向攻坚（阿里云 acw_sc__v2 求解器、DES 解密、网易易盾协议还原），最终被服务端风控策略阻断。

## 调查结论（2026-08-25，证据归档 `jsreverse-yidun/`，gitignored）

1. **协议层 100% 还原成功**：
   - acw_sc__v2 签名求解器攻破（vm 沙箱执行 WAF 挑战脚本，签名与真实 Chrome SPA 前缀 14 字节一致；大陆 IP 下 200+sigchl 挑战可解，重放得 JSON）
   - DES-ECB 解密攻破（键 `1qaz@wsx`，Node 需 `--openssl-legacy-provider`）
   - URL 必须带 `keyWords=` 参数
   - 网易易盾完整协议还原（`getconf → /v4/j/up → api/v3/get → api/v3/check`，fp/cb/dt/data 构造与真实 Chrome 逐参数对比 16/21 一致，5 个 DIFF 全为动态值且结构一致）
2. **服务端风控为最终拦截层（三环境对照闭环）**：vm 沙箱（简化桩）、ruyipage 定制 Firefox（完整指纹+真实内核）、用户真实 Chrome 三种环境的静默无感验证（type=5）**全部被拒**（`300 unpass` / `result:false` / 弹窗死循环）；仅人工点选（type=9）放行。协议与真人已不可区分仍被拒 → 拦截在服务端风控评分策略，非技术可解。
3. **票据单次消费**：`necaptcha-validate` 头必须且同一票据第二次使用即「参数验证失败」→ 每页需一票，无打码平台则无法无人值守。

## 决策

1. **ceb 维持旧源** `bulletin.cebpubservice.com` + 代理换 IP（ADR 0001 方案不变）；当前 `sites/ceb.js`/`crawler.js` 保持旧源抓取，并由 easy_proxies multi-port 提供可切换出口；当前回归为 `npm test` 8/8 套件通过。
2. **ctbpsp 成果归档不入仓**：`jsreverse-yidun/`（`.gitignore` 排除）含可直接切回的 `ctbpsp-implementation/ceb.ctbpsp.js`+`crawler.ctbpsp.js`（三级盾处置+熔断）、易盾纯协议实现（`result/src/`）、完整取证与 trace 证据（`case/`）、协议文档（`case/notes/entry-chain.md`）。
3. **切回条件**（届时覆盖归档实现即可）：服务端对静默无感放行，或接受打码平台成本（自动解 type=9 点选，每页一票）。
4. **勿重复攻坚**：卡点是服务端策略，非求解器/沙箱/指纹技术问题；重复投入无收益。

## 影响

- `docs/progress-ceb-ctbpsp.md` 保留为最终结论记录；`CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`/`README.md` 已同步到当前 easy_proxies 部署。
- 旧源代理链路（`HTTP_PROXY/CEB_PROXY_URL` + `easy_proxies` sidecar）仍是 ceb 可用性的关键依赖，故障时表现为连续 `ECONNRESET/timeout`，处置见 ADR 0001。
