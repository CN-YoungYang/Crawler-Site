# 任务进度：CEB 切换 ctbpsp.com JSON API（含阿里云 acw_sc__v2 盾求解）

> **最终状态（2026-08-25）：任务终止，回退旧源。**
> 决策：用户选择「B 回退旧源 bulletin.cebpubservice.com（代理换 IP）」。
> ctbpsp.com 成果已归档至 `jsreverse-yidun/`（gitignore，不入仓库），将来服务端放松可立即切回。

---

## 1. 任务背景与目标

**起因**：ceb 站点原抓 `bulletin.cebpubservice.com`（HTML+cheerio），依赖 mihomo 代理换 IP 绕 WAF。近期对代理链路连续 5 页 `ECONNRESET / timeout 30000ms` 全败，无数据空转。

**目标**：ceb 改抓 `https://ctbpsp.com/#/bulletinList` 背后的 JSON API（已放弃，见最终状态）。

---

## 2. 最终结论（三层证据闭环，2026-08-25）

ctbpsp.com 的 `necaptcha-validate` 票据（网易易盾）**纯协议无法自动获取**：

1. **协议还原 100% 完成**：vm 沙箱加载 core-optimi SDK（631KB 混淆）→ fp 自动生成 → getconf/get/check/collect 全自动请求链 → check 参数与真实 Chrome 逐项对比 16/21 一致（5 个 DIFF 全为动态值且结构一致）
2. **三种环境静默 check 全被拒**：我们的沙箱（300 unpass）、ruyipage 定制 Firefox 完整指纹（result:false）、用户真实 Chrome（弹窗死循环）→ **拦截层 = 服务端风控评分策略**，仅人工点选（type=9）放行
3. **票据单次消费**：同一 validate 第二次使用即「参数验证失败」→ 无法复用，每页需一票

**技术成果（全部验证过）**：
- acw_sc__v2 求解器：已攻破（签名与真实 SPA 前缀 14 字节一致），大陆 IP 下 200+sigchl 挑战可解
- DES-ECB 解密：键 `1qaz@wsx`，Node 需 `--openssl-legacy-provider`
- URL 必须带 `keyWords=` 参数
- 网易易盾完整协议：见 `jsreverse-yidun/case/notes/entry-chain.md`

## 3. 归档位置（不入仓库）

`jsreverse-yidun/`（.gitignore 排除）：
- `ctbpsp-implementation/ceb.ctbpsp.js` + `crawler.ctbpsp.js`：完整可用的 ctbpsp 实现（含三级盾处置+熔断），切回时直接覆盖 `sites/ceb.js` + `crawler.js`
- `case/`：完整取证（capture.json / target-hits.json / 23 个 JS 落盘 / RuyiTrace 24825 条）+ entry-chain.md + missing-env-priority.md
- `result/src/`：易盾纯协议实现（sdk-loader + browser-env + vm-context + client）
- `result/验证记录.json.md`：riskLayerDiagnosis 三对照闭环
- `case/阶段报告/REAL_VERIFY-结论.md`：最终结论

## 4. 回退执行记录（2026-08-25）

- [x] 归档 ctbpsp 实现 → `jsreverse-yidun/ctbpsp-implementation/`
- [x] `git checkout HEAD -- sites/ceb.js crawler.js .gitignore`（三文件回退）
- [x] `npm test` 全过（6/6 套件，旧源回归无损）
- [x] 清理临时产物（solve_*.js / fetch_*.js / acw.html / ctbpsp_app.js 等 20 个文件）
- [x] 保留 `docs/progress-ceb-ctbpsp.md`（本文件，记录最终结论）

## 5. 切回 ctbpsp 的条件（将来参考）

- 服务端对静默无感（type=5）放行（可用归档的 `result/src` 一键验证），或
- 接受打码平台成本（自动解 type=9 点选，每页一票）
- 届时：覆盖 ceb.js/crawler.js → 跑 `npm test` → 真机 3 页验证

## 6. 快速恢复上下文的命令

```bash
# 查看本文件
cat docs/progress-ceb-ctbpsp.md

# 验证归档实现仍可用（需大陆 IP + FlClash DIRECT 规则）
node --openssl-legacy-provider jsreverse-yidun/test-smoke.js

# 回归测试
npm test
```

## 7. 重要提醒（给下次会话的自己）

- 用户沟通语言：中文；回复中文
- **ctbpsp 卡点是服务端风控策略，不是技术**：协议已 100% 还原，勿再重复攻坚求解器/沙箱/指纹
- ctbpsp.com 对美国/代理 IP 全路径 405（连主页都拦），测试需大陆直连（FlClash 规则 `DOMAIN-SUFFIX,ctbpsp.com,DIRECT`）
- Windows 下无法非交互测 SIGINT/SIGTERM（memory）
- 网易易盾协议细节（getconf→/v4/j/up→get→check、fp/cb/dt/data 构造、AES key）全在 `jsreverse-yidun/case/notes/entry-chain.md` 与案例库 `yidun-intellisense-vm-env`
