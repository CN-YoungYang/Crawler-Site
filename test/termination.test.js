// Seam 4: crawl 终止条件（三条分支）
// (a) 首批含 403 → endReached，当前批并发发完后不进下一批
// (b) 一批无新数据且失败 ≤ threshold → 早停，不爬下一批
// (c) 每页有新数据 → 爬满 totalPages
// 每个用例都套 withTempCwd，避免 crawl 把 Excel 写回仓库 file/ 污染真实数据。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, ROW_NEW } = require('./fixtures');

async function main() {
  // ---- (a) 首批 403 endReached：当前批并发发起后不应进入下一批 ----
  {
    let calls = 0;
    const restore = mockAxios(() => {
      calls++;
      const err = new Error('403');
      err.response = { status: 403 };
      throw err;
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(100, 0));
    restore();
    assert.strictEqual(calls, 10, '首批 10 页全 403 → 仅发首批 10 页，不爬第二批');
  }

  // ---- (b) 一批（10页）全无新数据 + 0 失败 → 早停 ----
  {
    let calls = 0;
    const restore = mockAxios(() => {
      calls++;
      return { data: pageHtml([]), status: 200 };
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(100, 0));
    restore();
    assert.strictEqual(calls, 10, '首批 10 页全空且无失败 → 早停，不应爬第二批');
  }

  // ---- (c) 每页有新数据 → 爬满 totalPages ----
  {
    let calls = 0;
    const restore = mockAxios(() => {
      calls++;
      return { data: pageHtml([ROW_NEW]), status: 200 };
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(3, 0));
    restore();
    assert.strictEqual(calls, 3, '每页有新数据时应爬满 totalPages=3');
  }

  console.log('crawl 终止条件: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
