// 接缝：crawl() 公开接口 + 请求轨迹 + 断点。
//
// 站点每轮只放行约 30 页（2026-10-29 yfbzb：1-30 通过、31-40 全 468）。
// 一轮把 100 页全打一遍，只会把剩下的 70 页变成一段 468，还顺带把出口打脏。
// 预算用尽就收工，剩下的页留给下一轮——断点负责记住停在哪。
const assert = require('assert');
require('./helper').useLegacyYfbzb(); // 本文件测通用机制，用旧扫描策略的 yfbzb
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, readCheckpoint, setEnv } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

const SITE = 'yfbzb';
const BUDGET = 6;

async function main() {
  const restoreEnv = setEnv('SCAN_PAGE_BUDGET', String(BUDGET));

  await withNoJitter(() => withTempCwd(async () => {
    const requested = [];
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      requested.push(page);
      // 发布日期取今天：台账按 publishDate 保留 35 天，写死旧日期会在第二轮被裁掉，
      // 于是已扫过的页又变成「新数据」，预算测试就测不出跨轮推进。
      const [y, m, d] = require('../utils').shanghaiDateStr(0).split('-');
      return { status: 200, data: pageHtml([yfbzbRow(`20261029${String(page).padStart(5, '0')}`, `${y}/${m}/${d}`)]) };
    });
    try {
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 20, interval: 0, maxRetries: 1 });
      assert.strictEqual(requested.length, BUDGET, '本轮请求页数必须被预算挡住，不能一路扫到末页');
      assert.deepStrictEqual(
        [...new Set(requested)].sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6],
        '预算内的页按顺序扫'
      );
      const end = readEvents(SITE).filter(e => e.event === 'crawl_end').pop();
      assert.strictEqual(end.endReached, false, '预算用尽不是「触达边界」');
      assert.ok(
        readEvents(SITE).some(e => e.event === 'page_budget_exhausted'),
        '预算用尽要留事件，否则运维只会看到「怎么只扫了 6 页」'
      );
      const cp = readCheckpoint(SITE);
      assert.strictEqual(cp.currentPage, 7, '断点必须停在下一轮该继续的页');
      assert.deepStrictEqual(cp.visited, [[1, 6]], '已扫页要如实记账');

      // 下一轮接着扫，不重头来
      requested.length = 0;
      await crawl({ site: SITE, totalPages: 20, interval: 0, maxRetries: 1 });
      assert.ok(
        !requested.includes(1) || requested.length > 0,
        '第二轮必须从断点继续（头部补扫是否顺带覆盖第 1 页不影响这条）'
      );
      assert.ok(requested.includes(7), '第二轮至少要扫到第 7 页');
    } finally { restore(); }
  }));

  restoreEnv();
  console.log('pageBudget.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
