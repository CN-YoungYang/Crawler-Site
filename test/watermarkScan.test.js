// 回归：yfbzb 的「追水位」扫描策略。
//
// 2026-10-30 定稿的策略：每 15 分钟一轮，从第 1 页起扫，**连续 2 页零新增**才收工。
// 站点按发布时间倒序，新增永远落在头部；一页里全是被台账挡住的旧 id 是常态
// （分页边界切在一批同时间公告中间），所以「第一页零新增就停」会直接丢掉下一页的新公告。
//
// 接缝：crawl() 公开接口 + logs/<site>/*.jsonl 的 page_done / crawl_end 事件，
// 以及 state/<site>/checkpoint.json 的 currentPage（下轮从哪页起，对外承诺）。
const assert = require('assert');
const fs = require('fs');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, checkpointPath, ledgerPath } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

// 增量轮次的前提：台账非空 + 24h 内刚做过全量。否则 crawler 会按「首次部署」跑全量播种。
function seedIncrementalState(site = 'yfbzb') {
  const path = require('path');
  fs.mkdirSync(path.dirname(ledgerPath(site)), { recursive: true });
  fs.writeFileSync(ledgerPath(site), JSON.stringify({ v: 1, ids: { seed_id: '2026-10-30' } }), 'utf8');
  fs.writeFileSync(checkpointPath(site), JSON.stringify({
    v: 2, currentPage: 1, realTotalPages: null, sweepId: 0, visited: [], pending: [],
    blockCounts: {}, headScannedAt: null, lastSweepCompletedAt: null,
    lastFullSweepAt: new Date().toISOString(), consecutiveIncompleteRounds: 0, watermarkMissRounds: 0
  }), 'utf8');
}

// 按页号路由的假站点：pages 是 { 页码: [id...] }，未列出的页返回空表。
function siteFrom(pages) {
  const requested = [];
  const handler = (url) => {
    const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
    requested.push(page);
    const ids = pages[page] || [];
    return { status: 200, data: pageHtml(ids.map(id => yfbzbRow(id))) };
  };
  return { requested, handler };
}

function eventsOf(site) {
  return readEvents(site);
}

function requestedPages(events) {
  return events.filter(e => e.event === 'page_done').map(e => e.page).sort((a, b) => a - b);
}

async function main() {
  // ---- 第 1 页有新、第 2 页全是旧 id、第 3 页又有新：不能在第 2 页收工 ----
  {
    const site = siteFrom({
      1: ['20261030_000000001'],
      2: ['20261030_000000001'],   // 与第 1 页同一条：本页零新增
      3: ['20261030_000000002'],   // 新的一条
      4: [],                        // 零新增
      5: [],                        // 零新增 → 连续两页，收工
      6: ['20261030_000000003']    // 诱饵：不该被请求
    });
    const restore = mockAxios(site.handler);
    try {
      await withNoJitter(() => withTempCwd(async () => {
        seedIncrementalState();
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 100, interval: 0, maxRetries: 1 });

        assert.deepStrictEqual(
          site.requested, [1, 2, 3, 4, 5],
          `应扫到「连续 2 页零新增」才停，实际请求页：${site.requested.join(',')}`
        );
        const end = eventsOf('yfbzb').find(e => e.event === 'crawl_end');
        assert.strictEqual(end.totalNew, 2, '第 1、3 页各一条新公告，不能因为第 2 页重复而漏掉第 3 页');
      }));
    } finally {
      restore();
    }
  }

  // ---- 撞上 468：立即收手，不重试、不翻下一页 ----
  // 468 是站点在说「你太快了」。继续翻只会把风控越踩越深（2026-10-28 第 61-99 页
  // 连续 468 就是这么来的）。15 分钟一轮的节奏下，收手的代价只有 15 分钟。
  {
    const requested = [];
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      requested.push(page);
      const error = new Error('Request failed with status code 468');
      error.response = { status: 468, data: '<html>rate limited</html>' };
      throw error;
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        seedIncrementalState();
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 100, interval: 0, maxRetries: 3 });

        assert.deepStrictEqual(requested, [1], `468 命中后不得继续翻页，实际请求：${requested.join(',')}`);
        const events = eventsOf('yfbzb');
        const stop = events.find(e => e.event === 'rate_limited_stop');
        assert.ok(stop, '必须记录 rate_limited_stop，运维才知道这一轮是被风控截断的');
        assert.strictEqual(stop.level, 'error', '被风控截断不是普通 warn');
        const end = events.find(e => e.event === 'crawl_end');
        assert.strictEqual(end.rateLimitedHits, 1, 'crawl_end 要带出本轮 468 命中次数');
      }));
    } finally {
      restore();
    }
  }

  // ---- 台账为空（首次部署）：整轮跑满 100 页做一次全量播种，不许早停 ----
  // 否则第一次部署时，10 页之后就以为「追平了」，第 11-100 页的历史公告一条也进不了台账。
  {
    const site = siteFrom({ 1: ['A'], 2: ['B'] }); // 3..10 页全空，仍必须被请求
    const restore = mockAxios(site.handler);
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 10, interval: 0, maxRetries: 1 });

        assert.deepStrictEqual(
          site.requested.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          `台账为空必须整轮全量播种，实际请求：${site.requested.join(',')}`
        );
        const events = eventsOf('yfbzb');
        assert.ok(events.some(e => e.event === 'full_sweep_completed'), '全量跑完要记 full_sweep_completed');
        const cp = JSON.parse(fs.readFileSync(checkpointPath('yfbzb'), 'utf8'));
        assert.ok(cp.lastFullSweepAt, '断点里必须落下 lastFullSweepAt，下一轮才知道 24h 内不用再全量');
        assert.strictEqual(cp.currentPage, 1, '全量结束后游标回第 1 页');
      }));
    } finally {
      restore();
    }
  }

  // ---- 第 1 页失败：本轮终止，不许「跳过它、去抓第 2 页」 ----
  // 追水位策略下第 1 页是唯一必须成功的页：跳过它 = 这一轮的新公告一条都没拿到，
  // 而日志还会写着「第 1 页爬取失败，已跳过」，读起来像没什么大事。
  {
    const requested = [];
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      requested.push(page);
      const error = new Error('timeout of 30000ms exceeded');
      error.code = 'ECONNABORTED';
      throw error;
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        seedIncrementalState();
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 100, interval: 0, maxRetries: 2 });

        assert.ok(!requested.includes(2), `第 1 页失败后不得去抓第 2 页，实际请求：${requested.join(',')}`);
        assert.ok(requested.filter(p => p === 1).length >= 2, '第 1 页必须重试过，不能一次失败就放弃');
        const events = eventsOf('yfbzb');
        const firstFailed = events.find(e => e.event === 'first_page_failed');
        assert.ok(firstFailed, '必须记录 first_page_failed');
        assert.strictEqual(firstFailed.level, 'error');
      }));
    } finally {
      restore();
    }
  }

  // ---- 扫满整轮预算仍没追到水位：这是「正在丢数据」，不是「今天没新公告」 ----
  // 站点窗口只有 3000 条 ≈ 1 天。扫满 100 页还有新数据，说明水位已经跑到窗口之外，
  // 再不喊就永远不知道丢了哪一段。连续两轮未追平升级为告警。
  {
    const pages = {};
    for (let i = 1; i <= 12; i++) pages[i] = [`20261030_${String(i).padStart(9, '0')}`];
    const site = siteFrom(pages);
    const restore = mockAxios(site.handler);
    try {
      await withNoJitter(() => withTempCwd(async () => {
        seedIncrementalState();
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 12, interval: 0, maxRetries: 1 });
        let events = eventsOf('yfbzb');
        const miss = events.find(e => e.event === 'watermark_not_reached');
        assert.ok(miss, '扫满 12 页仍有新数据，必须记 watermark_not_reached');
        assert.strictEqual(miss.level, 'error');
        assert.ok(miss.oldestPublishTime, '必须带出本轮见到的最旧发布时间，才能量化丢了多少');

        // 第二轮仍追不上：升级
        await crawl({ site: 'yfbzb', totalPages: 12, interval: 0, maxRetries: 1 });
        events = eventsOf('yfbzb');
        assert.ok(events.some(e => e.event === 'watermark_still_behind'), '连续两轮未追平必须升级为 watermark_still_behind');
        const cp = JSON.parse(fs.readFileSync(checkpointPath('yfbzb'), 'utf8'));
        assert.strictEqual(cp.watermarkMissRounds, 2, '未追平轮次要跨轮累计');
      }));
    } finally {
      restore();
    }
  }

  console.log('yfbzb 追水位扫描：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
