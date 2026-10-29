// 接缝：crawl() 公开接口 + state/<site>/checkpoint.json + 事件流。
//
// 2026-10-29 生产形态：yfbzb 每轮只放行约 30 页（1-30 通过、31-40 全 468）。
// 老实现把 468 当普通失败页钉住断点，于是每轮从同一页重撞同一段拦截，
// 头部新增永远等不到补扫 —— 这是「断点续跑会漏新增」的第二半成因。
//
// 规格：
//   - 同一页连续 2 轮 468 才跳过；第 1 轮仍然钉住游标（换出口后很可能就通了）
//   - 跳过的页进 pending，游标绕过它继续前进
//   - 每轮开头用 1 页配额复活探测 pending 首项，成功即移出并计入覆盖
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, readCheckpoint, readLedgerIds } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');
const sitesIndex = require('../sites');

const SITE = 'yfbzbescape';

function http468() {
  const err = new Error('Request failed with status code 468');
  err.response = { status: 468, data: '<html>blocked</html>' };
  return err;
}

function pageOf(url) {
  return Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
}

// 发布日期取「今天」：台账按 publishDate 保留 35 天，写死成 2025 年的日期会在轮前被裁掉，
// 于是每轮都当成新数据，测不出「跨轮」的行为。
function todaySlash() {
  const [y, m, d] = require('../utils').shanghaiDateStr(0).split('-');
  return `${y}/${m}/${d}`;
}

function rowOf(page) {
  return yfbzbRow(`20261030${String(page).padStart(5, '0')}`, todaySlash());
}

async function withEscapeSite(fn) {
  sitesIndex.registry[SITE] = {
    ...sitesIndex.registry.yfbzb,
    name: SITE,
    batchSize: 1,
    timeout: 5000
  };
  try { return await fn(); } finally { delete sitesIndex.registry[SITE]; }
}

async function main() {
  // 第 4、5 页是「打不开的那一段」，第 6 页正常
  let blocked = true;
  const restore = mockAxios((url) => {
    const page = pageOf(url);
    if (blocked && (page === 4 || page === 5)) throw http468();
    return { status: 200, data: pageHtml([rowOf(page)]) };
  });
  try {
    await withNoJitter(() => withEscapeSite(() => withTempCwd(async () => {
      const { crawl } = freshCrawler();

      // ---- 第 1 轮：468 首次命中，游标钉在页 4，不跳 ----
      await crawl({ site: SITE, totalPages: 6, interval: 0, maxRetries: 1 });
      let cp = readCheckpoint(SITE);
      assert.strictEqual(cp.currentPage, 4, '第 1 轮命中 468 仍须钉住游标（换出口可能就通了）');
      assert.deepStrictEqual(cp.pending, [], '第 1 轮还不该把页 4/5 记成待补');
      assert.strictEqual(cp.blockCounts['4'], 1, '命中轮次要落盘，否则下一轮无从判断是否连续');

      // ---- 第 2 轮：连续 2 轮命中 → 跳页并记入待补，游标越过被拦段 ----
      await crawl({ site: SITE, totalPages: 6, interval: 0, maxRetries: 1 });
      cp = readCheckpoint(SITE);
      assert.deepStrictEqual(
        cp.pending.map(entry => entry.page).sort((a, b) => a - b),
        [4, 5],
        '连续 2 轮 468 的页必须进待补清单'
      );
      assert.strictEqual(cp.currentPage, 6, '被拦段跳过后，游标应停到仍欠账的第 6 页');
      assert.ok(
        readEvents(SITE).some(e => e.event === 'blocked_page_skipped' && e.page === 4),
        '跳页必须留一条可追溯事件（不能静默丢）'
      );

      // ---- 第 3 轮：风控放开，首项复活成功并从清单移除 ----
      blocked = false;
      await crawl({ site: SITE, totalPages: 6, interval: 0, maxRetries: 1 });
      cp = readCheckpoint(SITE);
      assert.ok(
        !cp.pending.some(entry => entry.page === 4),
        '复活成功后页 4 必须移出待补清单'
      );
      assert.ok(
        readEvents(SITE).some(e => e.event === 'pending_page_revived' && e.page === 4),
        '复活要留事件'
      );
      const ledgerIds = readLedgerIds(SITE);
      assert.ok(ledgerIds.includes('20261030' + '00004'), '复活页抓到的行必须进台账，否则下一轮又当新数据重写');
    })));

    // ---- 第 4-6 轮：仍然打不开 → 探测 3 次后放弃，并升级到 error ----
    blocked = true;
    await withNoJitter(() => withEscapeSite(() => withTempCwd(async () => {
      const { crawl } = freshCrawler();
      // 每轮只探测一页：页 4 探测 3 次后放弃，再轮到页 5 探测 3 次
      for (let round = 0; round < 6; round++) {
        await crawl({ site: SITE, totalPages: 6, interval: 0, maxRetries: 1 });
      }
      const cp = readCheckpoint(SITE);
      const entry = cp.pending.find(item => item.page === 4);
      assert.ok(entry, '放弃的页要留在清单里：状态页必须能回答「哪几页没拿到」');
      assert.strictEqual(entry.gaveUp, true, '连续 3 次复活探测失败后必须标记放弃');
      const givenUp = readEvents(SITE).filter(e => e.event === 'pending_page_given_up' && e.page === 4);
      assert.strictEqual(givenUp.length, 1, '每页放弃只留一条事件（不能每轮重复报）');
      assert.strictEqual(givenUp[0].level, 'error', '放弃是数据缺失，级别必须是 error');
    })));
  } finally {
    restore();
  }

  console.log('blockEscape.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
