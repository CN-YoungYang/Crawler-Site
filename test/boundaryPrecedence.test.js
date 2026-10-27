// 回归：同批内出现站点边界页时，边界必须胜过熔断判定。
//
// 守卫的真实缺陷（2026-10-27 架构复核发现）：batchSize 10 时整批并发发出，
// 若第 1 页返回 403 边界、其余页返回 405，原来的求值顺序先问「连续 405 是否 ≥2」，
// 于是当批就熔断并报「未触达边界」，batchEndReached 永远轮不到。
// 后果不只是日志写错：熔断分支会 noteRetryPage(batchStartPage) 保留断点，
// 下一轮又从第 1 页开始，而站点每次都答「边界」——断点一直不清，反复重爬同一批。
//
// 边界页的语义是「这是今天最后一条数据」：它之后的页本来就不存在，
// 那些页的 405 是在请求不存在的数据，不能反过来盖掉「已经到底」这个事实。
//
// 接缝：crawl() 公开接口 + logs/<site>/*.jsonl 的 crawl_end 事件 + state 文件。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');
const sitesIndex = require('../sites');

const SITE = 'boundaryfirst';

function withBatchSize(size, fn) {
  sitesIndex.registry[SITE] = { ...sitesIndex.registry.yfbzb, name: SITE, batchSize: size };
  return Promise.resolve(fn()).finally(() => { delete sitesIndex.registry[SITE]; });
}

function readEvents() {
  const dir = path.join(process.cwd(), 'logs', SITE);
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'));
  return fs.readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function readCrawlEnd() {
  return readEvents().filter(e => e.event === 'crawl_end').pop();
}

async function main() {
  // ---- (a) 第 1 页 403 边界、其余 9 页 405：必须记触达边界，不得判 405 熔断 ----
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 1) {
        const e = new Error('403'); e.response = { status: 403 }; throw e;
      }
      const e = new Error('405'); e.response = { status: 405, data: 'x' }; throw e;
    });
    try {
      await withNoJitter(() => withBatchSize(10, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd();
        assert.strictEqual(end.endReached, true, '同批出现边界页时 endReached 必须为 true');
        assert.strictEqual(end.event, 'crawl_end');
      })));
    } finally {
      restore();
    }
  }

  // ---- (b) 边界页不能被写进断点：正常到底就是跑完，下次从头开始 ----
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 1) {
        const e = new Error('403'); e.response = { status: 403 }; throw e;
      }
      const e = new Error('405'); e.response = { status: 405, data: 'x' }; throw e;
    });
    try {
      await withNoJitter(() => withBatchSize(10, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 1 });
        assert.ok(
          !fs.existsSync(`state-${SITE}.json`),
          '已触达边界属于正常跑完，不应保留断点（否则下一轮从第 1 页重爬起来，反复重爬）'
        );
      })));
    } finally {
      restore();
    }
  }

  // ---- (c) 没有边界页时，405 熔断行为不变（别把修复做成「熔断失效」）----
  // 断言熔断事件本身，而不只是 endReached=false：后者在熔断被整个删掉时同样成立
  // （跑满 100 页也不会触达边界），所以只断言它等于没测。
  {
    let calls = 0;
    const restore = mockAxios(() => {
      calls++;
      const e = new Error('405'); e.response = { status: 405, data: 'x' }; throw e;
    });
    try {
      await withNoJitter(() => withBatchSize(10, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 100, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd();
        assert.strictEqual(end.endReached, false, '无边界页时 endReached 应为 false');
        assert.ok(end.totalFailed > 0);
        const broke = readEvents().some(e => e.event === 'circuit_break_405');
        assert.ok(broke, '连续 405 必须真的熔断（记 circuit_break_405），而不是跑满 100 页');
        assert.strictEqual(calls, 10, '熔断应在第 1 批（10 页）后生效，不该继续请求后续批次');
      })));
    } finally {
      restore();
    }
  }

  // ---- (d) 边界**之前**的失败仍要续跑：别让边界把整轮断点一起抹掉 ----
  // 边界页只抹掉「边界及其之后」的重试点。第 1 批页 1 失败、第 2 批页 11 触达边界时，
  // 页 1 是真实存在且没抓到的页，下一轮必须从第 1 页续跑。
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 1) {
        const e = new Error('ECONNRESET'); e.code = 'ECONNRESET'; throw e;
      }
      if (page === 11) {
        const e = new Error('403'); e.response = { status: 403 }; throw e;
      }
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
    });
    try {
      await withNoJitter(() => withBatchSize(10, () => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: SITE, totalPages: 20, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd();
        assert.strictEqual(end.endReached, true, '第 2 批触达边界');
        assert.ok(
          fs.existsSync(`state-${SITE}.json`),
          '边界之前的失败页（页 1）真实存在且未抓到，断点必须保留'
        );
        const state = JSON.parse(fs.readFileSync(`state-${SITE}.json`, 'utf8'));
        assert.strictEqual(state.currentPage, 1, '断点应指向最早失败的页 1');
      })));
    } finally {
      restore();
    }
  }

  console.log('边界优先于熔断（同批 403 + 405）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
