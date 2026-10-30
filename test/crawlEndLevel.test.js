// 回归：一轮结束的汇总日志必须按「这次到底成没成」分级。
//
// 守卫的真实事故（2026-10-27 生产日志）：yfbzb 两轮 99/100 页失败、0 条新增，
// 汇总行仍是 info，紧挨着「触达站点边界」，读起来像「正常到底了」；
// ceb 连续 15 轮 0 条也全部落在 info，事后翻日志才发现整段时间没有产出。
//
// 接缝：crawl() 公开接口 + logs/<site>/*.jsonl 的 crawl_end 事件（对外承诺的可 grep 观测面）。
// 期望值来自独立真相源：失败页数与新增条数是规格里已有的语义，
// 「全部页面都失败 → 这次运行无效」不依赖实现细节。
const assert = require('assert');
require('./helper').useLegacyYfbzb(); // 本文件测通用机制，用旧扫描策略的 yfbzb
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

function readCrawlEnd(site) {
  const dir = path.join(process.cwd(), 'logs', site);
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'));
  assert.strictEqual(files.length, 1, `logs/${site}/ 应有且仅有 1 个 JSONL 日志文件，实际 ${files.length}`);
  const events = fs.readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const ends = events.filter(e => e.event === 'crawl_end');
  assert.strictEqual(ends.length, 1, `应恰好记录 1 条 crawl_end，实际 ${ends.length}`);
  return ends[0];
}

function http405() {
  const error = new Error('Request failed with status code 405');
  error.response = { status: 405, data: '<html>waf</html>' };
  return error;
}

async function main() {
  // ---- (a) 全部页面失败、0 新增 → crawl_end 必须 warn ----
  {
    const restore = mockAxios(() => { throw http405(); });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 4, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd('yfbzb');
        assert.strictEqual(end.level, 'warn', '整轮没有任何成功页时必须记为 warn');
        assert.ok(end.totalFailed > 0, '事件需带出失败页数供告警判定');
        assert.strictEqual(end.totalNew, 0);
      }));
    } finally {
      restore();
    }
  }

  // ---- (a2) 99 页失败 + 最后一页 403 边界 → 仍是 warn ----
  // 生产日志 2026-10-26T21:10 的真实形状：失败 99 页、触达站点边界、新增 0 条。
  // 边界页只是站点应答「到底了」，不能把它当作「出口可用」的证据——
  // 否则整轮唯一「成功」是那个 403，事故仍然落在 info。
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page === 4) {
        const error = new Error('Request failed with status code 403');
        error.response = { status: 403 };
        throw error;
      }
      throw http405();
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 4, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd('yfbzb');
        assert.strictEqual(end.level, 'warn', '只有边界页应答时仍属整轮无产出，必须 warn');
        assert.strictEqual(end.endReached, true, '边界仍应如实记录，只是不再决定日志级别');
      }));
    } finally {
      restore();
    }
  }

  // ---- (a3) 200 但零行（未识别的盾页/风控页）不算成功 ----
  // yfbzb 没有 challenge 钩子，WAF 若换一种返回方式给回 200 + 空列表，
  // 按「有响应即成功」会把静默失败记成 info——这正是本次要消灭的那类事故。
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page <= 2) throw http405();
      return { status: 200, data: pageHtml([]) }; // 200 + 零行，无 rows
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 4, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd('yfbzb');
        assert.strictEqual(end.level, 'warn', '有失败页且其余页全是零行时必须 warn，零行不能当作出口可用');
        assert.strictEqual(end.pagesSucceeded, 0, '零行页不计入成功页数');
      }));
    } finally {
      restore();
    }
  }

  // ---- (a4) 大量失败 + 唯一成功页全是旧数据 → 汇总行必须点明「只有 1 页成功」----
  // 2026-10-26T21:10 真实形状的另一半：99 页失败、第 100 页返回的全是已知 id。
  // 该页确实成功返回了内容（出口可用），故级别保持 info；但汇总行只写「失败 99 页」
  // 会让读者以为剩下 1 页产出了数据。必须把「成功页数」写进汇总行。
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      if (page < 4) throw http405();
      // 末页返回一条已存在的 id → 解析成功但零新增
      return { status: 200, data: pageHtml([yfbzbRow('20250930_542694266')]) };
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        // 台账里已记录该 id，模拟「这一天前面已经抓过，末页全是旧数据」
        fs.mkdirSync(path.dirname(require('./helper').ledgerPath('yfbzb')), { recursive: true });
        fs.writeFileSync(require('./helper').ledgerPath('yfbzb'), JSON.stringify({
          v: 1,
          // 发布日期用「今天」：台账按 publishDate 保留 35 天，写死 2025 年的日期会被轮前裁剪掉
          ids: { '20250930_542694266': require('../utils').shanghaiDateStr(0) }
        }), 'utf8');
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 4, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd('yfbzb');
        assert.strictEqual(end.pagesSucceeded, 1, '唯一成功的末页只有旧数据，仍算「解析到内容」');
        assert.strictEqual(end.totalNew, 0);
        assert.ok(
          /成功\s*1\s*页/.test(end.msg || ''),
          `汇总行必须点明只有 1 页成功，否则「失败 99 页」读起来像其余页都有产出。实际：${end.msg}`
        );
      }));
    } finally {
      restore();
    }
  }

  // ---- (b) 正常有产出且无失败 → crawl_end 保持 info（不制造噪声）----
  {
    const restore = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
    });
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const { crawl } = freshCrawler();
        await crawl({ site: 'yfbzb', totalPages: 2, interval: 0, maxRetries: 1 });
        const end = readCrawlEnd('yfbzb');
        assert.strictEqual(end.level, 'info', '有产出且无失败时保持 info');
        assert.ok(end.totalNew > 0);
      }));
    } finally {
      restore();
    }
  }

  console.log('crawl_end 汇总分级（整轮全失败 → warn）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
