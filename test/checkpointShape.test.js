// 接缝：crawl() 公开接口 + state/<site>/checkpoint.json 的对外语义。
//
// 断点已从「游标 + id 集」改成纯游标：id 归台账，断点只记扫到哪、扫过哪些页、
// 哪些页被 468 跳过，以及上一次完整扫描什么时候完成。
// 期望值来自规格（计划页里的三条行为），不照抄实现：
//   - 扫满 1..有效总页数 = 一次完整扫描 → 游标回 1、sweepId+1、visited 清空、留时间戳
//   - 468 熔断 → 游标停在首个被拦页、visited 只含成功页
//   - 老 state-<site>.json 不兼容 → 删除并记 warn，不当断点用
const assert = require('assert');
require('./helper').useLegacyYfbzb(); // 本文件测通用机制，用旧扫描策略的 yfbzb
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, readCheckpoint } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

const SITE = 'yfbzb';

function http468() {
  const error = new Error('Request failed with status code 468');
  error.response = { status: 468, data: '<html>blocked</html>' };
  return error;
}

function okPage(pageNo) {
  return { status: 200, data: pageHtml([yfbzbRow(`2026${String(pageNo).padStart(2, '0')}` + '0001')]) };
}

async function main() {
  // ---- (a) 扫满全部页 = 一次完整扫描：游标回 1、sweepId 递增、visited 清空 ----
  {
    const restore = mockAxios((url) => okPage(Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1)));
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 3, interval: 0, maxRetries: 1 });
        const cp = readCheckpoint(SITE);
        assert.strictEqual(cp.currentPage, 1, '完整扫完后游标必须回到第 1 页');
        assert.strictEqual(cp.sweepId, 1, '完整扫描一次后 sweepId 应为 1');
        assert.deepStrictEqual(cp.visited, [], '新一轮从头开始，visited 应为空');
        assert.ok(cp.lastSweepCompletedAt, '必须记下完成时间，否则 /status 永远没有基线');
        assert.strictEqual(cp.consecutiveIncompleteRounds, 0, '完整扫描应把连续未完成轮数清零');
      }));
    } finally { restore(); }
  }

  // ---- (b) 468 熔断：游标停在首个被拦页，visited 只覆盖已成功页 ----
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page >= 4) throw http468();
      return okPage(page);
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 6, interval: 0, maxRetries: 1 });
        const cp = readCheckpoint(SITE);
        assert.strictEqual(cp.currentPage, 4, '468 熔断后游标应停在首个被拦页 4');
        assert.deepStrictEqual(cp.visited, [[1, 3]], 'visited 只应覆盖成功返回的第 1-3 页');
        assert.deepStrictEqual(cp.pending, [], '第一轮命中 468 还不该把页面记为待补');
        assert.strictEqual(cp.consecutiveIncompleteRounds, 1, '没扫满应计一次未完成轮');
        assert.ok(cp.lastSweepCompletedAt === null || cp.lastSweepCompletedAt === undefined, '未完成扫描不得写完成时间');
      }));
    } finally { restore(); }
  }

  // ---- (c) 老断点不兼容：删除 + warn，本轮按全新开始 ----
  {
    const restore = mockAxios((url) => okPage(Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1)));
    try {
      await withNoJitter(() => withTempCwd(async () => {
        fs.writeFileSync('state-yfbzb.json', JSON.stringify({ currentPage: 31, existingIds: ['old1', 'old2'] }));
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 2, interval: 0, maxRetries: 1 });
        assert.strictEqual(fs.existsSync('state-yfbzb.json'), false, '老断点文件必须被删除');
        const events = readEvents(SITE).filter(e => e.event === 'checkpoint_legacy_ignored');
        assert.strictEqual(events.length, 1, '删除老断点要留下一条可追溯的 warn 事件');
        const cp = readCheckpoint(SITE);
        assert.strictEqual(cp.currentPage, 1, '不兼容即从头开始');
      }));
    } finally { restore(); }
  }

  console.log('checkpointShape.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
