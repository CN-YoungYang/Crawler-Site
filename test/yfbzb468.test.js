// yfbzb HTTP 468：站点风控拦截页，不是数据边界，也不能逐页重试。
//
// 2026-10-28 生产日志：第 61-99 页连续返回 468，原实现把它当普通失败页，
// 每页重试 3 次且 breaker 不计数，空转 4 批后第 100 页 SafeLine 403 被当作边界，
// 汇总行仍写「触达站点边界」——41 页真实数据被掩盖。
//
// 接缝：crawlPage() 的返回值 + crawl() 的 circuit_break_waf / 断点。
const assert = require('assert');
require('./helper').useLegacyYfbzb(); // 本文件测通用机制，用旧扫描策略的 yfbzb
const fs = require('fs');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, readCheckpoint } = require('./helper');
const { pageHtml, yfbzbRow, yfbzbPagination } = require('./fixtures');
const sitesIndex = require('../sites');

function http468() {
  const err = new Error('Request failed with status code 468');
  err.response = { status: 468, data: '<html><head><title>468</title></head><body></body></html>' };
  return err;
}

function pageOf(url) {
  return Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
}

async function main() {
  const yfbzb = sitesIndex.getSiteConfig('yfbzb');

  // ---- (a) 468 是拦截页：快败、记 shieldType，不能当边界 ----
  {
    let calls = 0;
    const restore = mockAxios(() => { calls++; throw http468(); });
    let res;
    try {
      const { crawlPage } = freshCrawler();
      res = await withTempCwd(() => crawlPage(50, yfbzb, new Set(), 3));
    } finally {
      restore();
    }
    assert.strictEqual(res.failed, true, '468 应记为失败页');
    assert.strictEqual(res.status, 468, '应保留 HTTP 468 状态');
    assert.strictEqual(res.shieldType, 'http468', '应标记 http468，供 breaker 按盾页规则计数');
    assert.ok(!res.endReached, '468 不是数据边界');
    assert.strictEqual(calls, 1, '拦截页同一出口重试无意义，应快败（1 发）');
  }

  // ---- (b) 连续 2 页 468 熔断：不空转其余页面，断点停最早失败页 ----
  {
    const SITE = 'http468-mid';
    let calls = 0;
    const restore = mockAxios(url => {
      calls++;
      const page = pageOf(url);
      if (page >= 3) throw http468();
      return {
        status: 200,
        data: pageHtml([yfbzbRow(`20251028_${String(page).padStart(9, '0')}`)])
          + yfbzbPagination({ totalRecords: 300, pageSize: 30 })
      };
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 1 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 3 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, false, '中途 468 不能被当成数据边界');
        assert.strictEqual(end.totalFailed, 2, '连续 2 页 468 应计为 2 个失败页');
        assert.ok(
          events.some(e => e.event === 'circuit_break_waf' && e.shieldType === 'http468'),
          '连续 2 页 468 应触发盾页熔断，且日志能区分 http468'
        );
        assert.strictEqual(calls, 4, '第 3、4 页各 1 发即熔断，不应按 maxRetries 反复重试');
        const state = readCheckpoint(SITE);
        assert.strictEqual(state.currentPage, 3, '断点应指向最早失败的页 3');
      })));
    } finally {
      restore();
    }
  }

  // ---- (c) 468 打在站点末页也不是边界：与 SafeLine 的末页位置判别不同 ----
  {
    const SITE = 'http468-last';
    const restore = mockAxios(url => {
      const page = pageOf(url);
      if (page >= 3) throw http468();
      return {
        status: 200,
        data: pageHtml([yfbzbRow(`20251028_${String(page).padStart(9, '0')}`)])
          + yfbzbPagination({ totalRecords: 90, pageSize: 30 })
      };
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 1 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 3, interval: 0, maxRetries: 1 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, false, '468 不是数据边界，不能删断点');
        assert.strictEqual(end.totalFailed, 1, '末页 468 应如实计失败');
        const state = readCheckpoint(SITE);
        assert.strictEqual(state.currentPage, 3, '断点应保留在末页');
      })));
    } finally {
      restore();
    }
  }

  console.log('yfbzb HTTP 468 风控：通过');
}

function withSite(site, overrides, fn) {
  sitesIndex.registry[site] = { ...sitesIndex.registry.yfbzb, name: site, ...overrides };
  return Promise.resolve(fn()).finally(() => { delete sitesIndex.registry[site]; });
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
