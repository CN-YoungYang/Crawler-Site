// 回归：熔断/中止路径不得把断点推到更晚的页。
//
// 守卫的真实事故（2026-10-27 生产日志）：ceb 熔断断点为 6 → 11 → 16 → … → 76，
// 每轮 +5，而每轮是「前几页失败后熔断」——第 6 页起的失败页永远不再重爬。
//
// 根因：crawler.js 逐页取 min 记录最早失败页（失败处理分支），
// 但三个熔断分支（WAF 求解失败 / 连续 405 / 网络连败）随后写 retryFromPage = batchStartPage，
// 把它「抬高」到熔断批次的起始页。ceb 的 batchSize=1 才每轮只漂移 1 页，
// yfbzb 的 batchSize=10 时单轮吞掉最多 9 页。
//
// 接缝：crawl({site,totalPages,interval,maxRetries}) 公开接口 + state-<site>.json 内容。
// 期望值来自独立真相源（生产日志的断点轨迹 + 「断点必须指向最早未成功页」的语义），
// 不是照抄实现：修复前断言失败（断点被抬到熔断批次起始页），修复后为最早失败页。
const assert = require('assert');
const fs = require('fs');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');
const sitesIndex = require('../sites');

// 单批 2 页：用少量请求精确构造「早批有失败页 → 后批熔断」。
// 注册一个独立站点而不是改写共享的 yfbzb 配置对象——后者是进程级可变夹具，
// 用例失败时还原可能被跳过，污染同文件后续用例。yfbzb 的解析规则原样继承，
// 只透传本用例需要的 batchSize/timeout。
const SMALL_BATCH_SITE = 'yfbzbsmallbatch';
function withSmallBatch(fn) {
  sitesIndex.registry[SMALL_BATCH_SITE] = {
    ...sitesIndex.registry.yfbzb,
    name: SMALL_BATCH_SITE,
    batchSize: 2,
    timeout: 5000
  };
  return Promise.resolve(fn()).finally(() => { delete sitesIndex.registry[SMALL_BATCH_SITE]; });
}

function http405() {
  const error = new Error('Request failed with status code 405');
  error.response = { status: 405, data: '<html>waf</html>' };
  return error;
}

function netReset() {
  const error = new Error('socket hang up');
  error.code = 'ECONNRESET';
  return error;
}

function readCheckpoint() {
  return JSON.parse(fs.readFileSync(`state-${SMALL_BATCH_SITE}.json`, 'utf8'));
}

async function main() {
  // ---- (a) 连续 405 熔断发生在第 2 批，断点必须保持第 1 批的失败页 1 ----
  // 批1（页 1-2）：页 1 405 失败，页 2 成功且有新数据 → 继续，retryFromPage=1
  // 批2（页 3-4）：两页都 405 → consecutive405=2 熔断，旧实现会把断点改成 3
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 1 || page >= 3) throw http405();
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
    });
    try {
      await withNoJitter(() => withSmallBatch(async () => {
        const { crawl } = freshCrawler();
        await withTempCwd(async () => {
          await crawl({ site: SMALL_BATCH_SITE, totalPages: 8, interval: 0, maxRetries: 1 });
          const checkpoint = readCheckpoint();
          assert.strictEqual(
            checkpoint.currentPage,
            1,
            '连续 405 熔断后断点应仍指向第 1 批的失败页 1，而不是熔断批次起始页 3'
          );
        });
      }));
    } finally {
      restore();
    }
  }

  // ---- (b) 网络连败熔断发生在第 3 批，断点必须保持最早失败的页 1 ----
  // 批1-3（页 1-6）全部 ECONNRESET：达到 NET_FAIL_BREAK_THRESHOLD=6 后熔断，
  // 旧实现写 retryFromPage=batchStartPage=5，把页 1-4 的失败页全部吞掉。
  {
    const restore = mockAxios(() => { throw netReset(); });
    try {
      await withNoJitter(() => withSmallBatch(async () => {
        const { crawl } = freshCrawler();
        await withTempCwd(async () => {
          await crawl({ site: SMALL_BATCH_SITE, totalPages: 20, interval: 0, maxRetries: 1 });
          const checkpoint = readCheckpoint();
          assert.strictEqual(
            checkpoint.currentPage,
            1,
            '网络连败熔断后断点应仍指向最早失败的页 1，而不是熔断批次起始页 5'
          );
        });
      }));
    } finally {
      restore();
    }
  }

  // ---- (c) batchSize 10（yfbzb 线上形状）：批1 页1 失败，批2 全 405 触发熔断 ----
  // 与 (a) 的区别只在批次大小：这里熔断批次起始页是 11，旧实现会把断点写成 11，
  // 把批1 里的页 1 连同批2 之前的全部失败一起吞掉（单轮丢 10 页）。
  // 线上 ceb 的 batchSize 是 1、yfbzb 是 10，两种粒度都必须成立。
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 1 || page >= 11) throw http405();
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        // 用 yfbzb 默认 batchSize（10）：批1 页 1-10、批2 页 11-20
        await crawl({ site: 'yfbzb', totalPages: 20, interval: 0, maxRetries: 1 });
        const checkpoint = JSON.parse(fs.readFileSync('state-yfbzb.json', 'utf8'));
        assert.strictEqual(
          checkpoint.currentPage,
          1,
          'batchSize 10 时熔断断点仍须指向批1 的失败页 1，而不是熔断批次起始页 11'
        );
      }));
    } finally {
      restore();
    }
  }

  console.log('断点不越过失败页（熔断/中止路径）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
