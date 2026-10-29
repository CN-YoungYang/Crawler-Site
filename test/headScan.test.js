// 接缝：crawl() 公开接口 + 请求轨迹（哪些页真的被发了请求）+ head_scan_done 事件。
//
// 头部补扫是「续跑不漏新增」的唯一救命索：续跑时游标在尾部，新增却全在头部。
// 期望值来自规格：
//   - 续跑时从第 1 页起补扫，最多 HEAD_SCAN_MAX_PAGES 页
//   - 连续 2 页整页无新增就判定追平（批次边界上生效）
//   - 补扫结束后直接跳到尾部游标，中间空档不重复请求
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, setEnv, checkpointPath } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

const SITE = 'yfbzb';

function writeCheckpoint(currentPage) {
  fs.mkdirSync(path.dirname(checkpointPath(SITE)), { recursive: true });
  fs.writeFileSync(checkpointPath(SITE), JSON.stringify({
    v: 2,
    currentPage,
    sweepId: 1,
    visited: [],
    pending: []
  }), 'utf8');
}

function writeLedger(pages) {
  fs.mkdirSync(path.join('state', SITE), { recursive: true });
  const entries = {};
  for (const page of pages) entries[rowId(page)] = '2026-10-29';
  fs.writeFileSync(path.join('state', SITE, 'ids.json'), JSON.stringify({ v: 1, ids: entries }), 'utf8');
}

function rowId(page) {
  return `20261029${String(page).padStart(5, '0')}`;
}

function lastHeadDone(site) {
  return readEvents(site).filter(e => e.event === 'head_scan_done').pop();
}

async function main() {
  // ---- (a) 补扫完跳到尾部游标，中间空档不重复请求 ----
  await withNoJitter(() => withTempCwd(async () => {
    const restoreEnv = setEnv('HEAD_SCAN_MAX_PAGES', '3');
    const requested = [];
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      requested.push(page);
      return { status: 200, data: pageHtml([yfbzbRow(rowId(page))]) };
    });
    try {
      writeCheckpoint(10);
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 12, interval: 0, maxRetries: 1 });
      assert.deepStrictEqual(
        [...new Set(requested)].sort((a, b) => a - b),
        [1, 2, 3, 10, 11, 12],
        '续跑必须先补扫头部 1-3，再跳到尾部游标 10，中间的 4-9 不应重复请求'
      );
      const headDone = lastHeadDone(SITE);
      assert.ok(headDone, '补扫结束要留下 head_scan_done 事件（运维看的就是它）');
      assert.strictEqual(headDone.headPagesFetched, 3, '补扫页数应等于上限');
      assert.strictEqual(headDone.jumpTo, 10, '补扫结束后应跳到尾部游标');
      // 只断言请求轨迹还不够：补扫的真正价值是头部新增真的入库了
      const ledgerIds = require('./helper').readLedgerIds(SITE);
      assert.ok(
        ledgerIds.includes(rowId(1)) && ledgerIds.includes(rowId(3)),
        '头部补扫抓到的行必须落进台账，否则下一轮还会当新数据重写'
      );
    } finally { restore(); restoreEnv(); }
  }));

  // ---- (b) 头部整页无新增 = 追平：停在上限之前，不烧满配额 ----
  await withNoJitter(() => withTempCwd(async () => {
    const restoreEnv = setEnv('HEAD_SCAN_MAX_PAGES', '15');
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      return { status: 200, data: pageHtml([yfbzbRow(rowId(page))]) };
    });
    try {
      writeCheckpoint(10);
      // 台账里已有第 1-10 页的全部 id → 这一批解析出来全是零新增
      writeLedger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 30, interval: 0, maxRetries: 1 });
      const headDone = lastHeadDone(SITE);
      assert.ok(headDone, '必须留下补扫结束事件');
      assert.strictEqual(headDone.headPagesFetched, 10, '零新增时应在第 10 页（一个批次）就收手，而不是扫满 15 页');
      assert.ok(headDone.headPagesFetched < 15, '早停必须真的省下配额');
      assert.strictEqual(headDone.headZeroStreak, 10, '连续零新增页数应如实记录');
    } finally { restore(); restoreEnv(); }
  }));

  // ---- (c) 头部全是新增：补扫严格停在上限，剩下配额留给尾部 ----
  await withNoJitter(() => withTempCwd(async () => {
    const restoreEnv = setEnv('HEAD_SCAN_MAX_PAGES', '15');
    const requested = [];
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      requested.push(page);
      return { status: 200, data: pageHtml([yfbzbRow(rowId(page))]) };
    });
    try {
      writeCheckpoint(10);
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 40, interval: 0, maxRetries: 1 });
      const headDone = lastHeadDone(SITE);
      assert.strictEqual(headDone.headPagesFetched, 15, '补扫必须停在 15 页上限');
      assert.strictEqual(headDone.jumpTo, 16, '补扫越过尾部游标后，续扫应从补扫末页+1 开始');
      const unique = [...new Set(requested)];
      assert.ok(unique.includes(16), '补扫结束后必须继续推进尾部，不能只扫头部就收工');
    } finally { restore(); restoreEnv(); }
  }));

  console.log('headScan.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
