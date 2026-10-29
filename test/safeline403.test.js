// SafeLine 403：临时封禁 vs 数据边界。
//
// 实测（.scratch/yfbzb-live-probe/FINDINGS.md）：yfbzb 第 100 页（页码上限）返回
// 15671 B 的 SafeLine 拦截页，响应体引用 /.safeline/ 静态资源；临时封禁返回同一张页。
// 单看响应体分不出两者，判别只能结合页号位置：
// - 末页/之后：按边界收尾（正常跑完，不保留断点）
// - 中间页：按失败页处理，连续 2 页熔断（不静默截断，也不逐页打满）
//
// 接缝：crawlPage() 的返回值 + crawl() 的 crawl_end 事件与 state 文件。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, readCheckpoint, checkpointPath } = require('./helper');
const { pageHtml, yfbzbRow, yfbzbPagination } = require('./fixtures');
const sitesIndex = require('../sites');

// 取自实测拦截页（FINDINGS §2）：引用 SafeLine 静态资源，可见文本为空。
const SAFELINE_BODY = '<!DOCTYPE html><html><head><title></title></head>'
  + '<body><img src="/.safeline/static/favicon.png" alt=""></body></html>';

function safeLineError() {
  const err = new Error('Request failed with status code 403');
  err.response = { status: 403, data: SAFELINE_BODY };
  return err;
}

function plain403Error() {
  const err = new Error('Request failed with status code 403');
  err.response = { status: 403, data: '<html><body>Forbidden</body></html>' };
  return err;
}

function pageOf(url) {
  return Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
}

async function main() {
  const yfbzb = sitesIndex.getSiteConfig('yfbzb');

  // ---- (a) 有 SafeLine 指纹的 403 不是数据边界 ----
  // 同一出口重试只会再吃一发拦截页，因此快败为失败页，并带 shieldType 交给熔断器。
  {
    let calls = 0;
    const restore = mockAxios(() => { calls++; throw safeLineError(); });
    let res;
    try {
      const { crawlPage } = freshCrawler();
      res = await withTempCwd(() => crawlPage(50, yfbzb, new Set(), 3));
    } finally {
      restore();
    }
    assert.strictEqual(res.failed, true, 'SafeLine 403 应记为失败页，不能当数据边界');
    assert.strictEqual(res.shieldType, 'safeline', '应标记 safeline，供熔断器按盾页规则计数');
    assert.ok(!res.endReached, 'SafeLine 403 不得返回 endReached');
    assert.strictEqual(calls, 1, '同一出口重试无意义，应快败（1 发）');
  }

  // ---- (b) 没有 SafeLine 指纹的 403 仍是数据边界 ----
  // 防止把「所有 403」一并改成失败页。
  {
    let calls = 0;
    const restore = mockAxios(() => { calls++; throw plain403Error(); });
    let res;
    try {
      const { crawlPage } = freshCrawler();
      res = await withTempCwd(() => crawlPage(99, yfbzb, new Set(), 3));
    } finally {
      restore();
    }
    assert.strictEqual(res.endReached, true, '普通 403 应保持边界语义');
    assert.strictEqual(res.failed, false, '边界不是故障');
    assert.strictEqual(calls, 1, '边界不重试');
  }

  // ---- (c) 拦截页打在本轮最后一个有效页：按边界收尾，不保留断点 ----
  // 实测第 100 页就是这种形态。若按失败页处理，断点会永远卡在末页，
  // 下一轮不再从第 1 页抓新数据。
  {
    const SITE = 'safeline-last';
    const restore = mockAxios((url) => {
      const page = pageOf(url);
      if (page >= 3) throw safeLineError();
      return {
        status: 200,
        data: pageHtml([yfbzbRow(`20250930_${String(page).padStart(9, '0')}`)])
          + yfbzbPagination({ totalRecords: 90, pageSize: 30 })
      };
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 10 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 3, interval: 0, maxRetries: 3 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, true, '末页 SafeLine 拦截应按数据边界收尾');
        assert.strictEqual(end.totalFailed, 0, '末页拦截不应计为失败页');
        assert.ok(
          events.some(e => e.event === 'boundary_blocked_last_page' && e.page === 3 && e.shieldType === 'safeline'),
          '应留下可区分的边界事件（区别于普通 403 边界）'
        );
        assert.strictEqual(readCheckpoint(SITE).currentPage, 1, '正常收尾后下一轮必须从第 1 页开始');
      })));
    } finally {
      restore();
    }
  }

  // ---- (d) 同批观测到真实总页数时，末页判定必须立刻生效 ----
  // 配置 10 页、第 1 页自报「共 30 条 / pageSize=30」= 1 页。第 2..10 页在本批并发中
  // 已被请求并全部吃到 SafeLine；若等批末才合并观测值，它们会被误判为中途失败并保留断点。
  {
    const SITE = 'safeline-observed';
    const restore = mockAxios((url) => {
      const page = pageOf(url);
      if (page >= 2) throw safeLineError();
      return {
        status: 200,
        data: pageHtml([yfbzbRow('20250930_000000001')]) + yfbzbPagination({ totalRecords: 30, pageSize: 30 })
      };
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 10 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 3 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, true, '真实总页数之后的 SafeLine 页应按边界收尾');
        assert.strictEqual(end.totalFailed, 0, '不存在的页被拦截不算失败页');
        assert.strictEqual(end.effectiveTotalPages, 1, '同批观测到的真实总页数应立即收窄上限');
        assert.strictEqual(readCheckpoint(SITE).currentPage, 1, '不应把游标留在不存在的页上');
      })));
    } finally {
      restore();
    }
  }

  // ---- (e) 中间页 SafeLine：不静默截断，连续 2 页熔断并保留断点 ----
  // 这正是 FINDINGS §2 担心的场景：临时封禁若按边界收尾，会删断点、漏掉后续真实数据。
  {
    const SITE = 'safeline-mid';
    let calls = 0;
    const restore = mockAxios(() => { calls++; throw safeLineError(); });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 1 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 3 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, false, '中途 SafeLine 拦截不能被当成数据边界');
        assert.ok(events.some(e => e.event === 'circuit_break_waf'), '连续 2 页拦截应触发熔断');
        assert.strictEqual(calls, 2, '连续 2 页后熔断，不应逐页打满 10 页');
        const state = readCheckpoint(SITE);
        assert.strictEqual(state.currentPage, 1, '断点应指向最早失败的页 1');
      })));
    } finally {
      restore();
    }
  }

  // ---- (f) 配置上限小于站点真实页数：上限处的拦截不是数据边界 ----
  // TOTAL_PAGES=2、站点自报 3 页；第 2 页是真实数据页，被 SafeLine 拦时按失败页处理。
  // 若用 effectiveTotalPages（=min(配置,观测)）判末页，会把这次拦截当成「已到底」并删断点，
  // 第 2 页数据永久丢失。
  {
    const SITE = 'safeline-capped';
    const restore = mockAxios((url) => {
      const page = pageOf(url);
      if (page >= 2) throw safeLineError();
      return {
        status: 200,
        data: pageHtml([yfbzbRow(`20250930_${String(page).padStart(9, '0')}`)])
          + yfbzbPagination({ totalRecords: 90, pageSize: 30 })
      };
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 10 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 2, interval: 0, maxRetries: 3 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, false, '配置上限处的拦截不是数据边界');
        assert.strictEqual(end.totalFailed, 1, '真实页被拦应计入失败页');
        const state = readCheckpoint(SITE);
        assert.strictEqual(state.currentPage, 2, '断点应保留在第 2 页');
      })));
    } finally {
      restore();
    }
  }

  // ---- (g) 断点落在末页、恢复轮无成功页可观测：不得死锁 ----
  // run1：第 1 页成功并自报 2 页，第 2 页网络超时 → 断点=2（并记录自报总页数）。
  // run2：只剩第 2 页，直接吃 SafeLine，没有成功页可重新观测 → 仍须按站点末页收尾，
  // 否则断点永停第 2 页、每轮零新增。
  {
    const SITE = 'safeline-resume';
    let page2Blocked = false;
    const restore = mockAxios((url) => {
      const page = pageOf(url);
      if (page === 1) {
        return {
          status: 200,
          data: pageHtml([yfbzbRow('20250930_000000001')])
            + yfbzbPagination({ totalRecords: 60, pageSize: 30 })
        };
      }
      if (!page2Blocked) {
        const err = new Error('timeout of 1000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      throw safeLineError();
    });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 10 }, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 2, interval: 0, maxRetries: 1 });
        const state1 = readCheckpoint(SITE);
        assert.strictEqual(state1.currentPage, 2, 'run1 断点应停在第 2 页');
        assert.strictEqual(state1.realTotalPages, 2, '断点应记录上轮观测到的总页数');

        page2Blocked = true;
        await crawl({ site: SITE, totalPages: 2, interval: 0, maxRetries: 1 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, true, '恢复轮应在站点末页收尾');
        assert.strictEqual(readCheckpoint(SITE).currentPage, 1, '不得把游标永停末页');
      })));
    } finally {
      restore();
    }
  }

  // ---- (h) 旧断点没有 totalPages，恢复轮从末页起跑：退化为配置上限 ----
  // 兼容旧版 state 文件（只有 currentPage/existingIds）：没有成功页可观测时，
  // 若末页拦截仍按失败处理，断点会永停末页。配置上限是唯一可用的兜底。
  {
    const SITE = 'safeline-legacy';
    const restore = mockAxios(() => { throw safeLineError(); });
    try {
      await withNoJitter(() => withSite(SITE, { batchSize: 10 }, () => withTempCwd(async () => {
        fs.mkdirSync(path.dirname(checkpointPath(SITE)), { recursive: true });
        fs.writeFileSync(checkpointPath(SITE), JSON.stringify({ v: 2, currentPage: 2, sweepId: 0, visited: [], pending: [] }));
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 2, interval: 0, maxRetries: 1 });
        const events = readEvents(SITE);
        const end = events.filter(e => e.event === 'crawl_end').pop();
        assert.strictEqual(end.endReached, true, '无总页数可观测时应按配置上限收尾');
        assert.strictEqual(readCheckpoint(SITE).currentPage, 1, '不得把游标永停末页');
      })));
    } finally {
      restore();
    }
  }

  console.log('SafeLine 403 判定：通过');
}

function withSite(site, overrides, fn) {
  sitesIndex.registry[site] = { ...sitesIndex.registry.yfbzb, name: site, ...overrides };
  return Promise.resolve(fn()).finally(() => { delete sitesIndex.registry[site]; });
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
