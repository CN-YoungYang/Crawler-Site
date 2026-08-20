// Seam 1: crawlPage 去重（Set 化改动的核心）
// 行为：已存在 id 被跳过；新 id 进入 pageData 且被补进 existingIds（跨批次去重）。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { ROW_KNOWN, ROW_NEW, KNOWN_ID, NEW_ID, pageHtml } = require('./fixtures');

async function main() {
  // crawlPage 现写 JSONL 日志（文件副作用），套 withTempCwd 隔离日志落盘。
  // ---- case A: 单条已知 id → 全部跳过 ----
  {
    const restore = mockAxios(() => ({ data: pageHtml([ROW_KNOWN]), status: 200 }));
    const { crawlPage } = freshCrawler();
    const existingIds = new Set([KNOWN_ID]);
    const res = await withTempCwd(() => crawlPage(1, 'base', 'suffix', existingIds, 3));
    restore();
    assert.strictEqual(res.pageData.length, 0, '已知 id 应被跳过，pageData 为空');
    assert.strictEqual(res.failed, false, '已知 id 全跳过不算失败');
    assert.ok(!res.endReached, '已知 id 跳过不是站点边界');
  }

  // ---- case B: 一新一旧 → 只留新，新 id 补进 existingIds ----
  {
    const restore = mockAxios(() => ({ data: pageHtml([ROW_KNOWN, ROW_NEW]), status: 200 }));
    const { crawlPage } = freshCrawler();
    const existingIds = new Set([KNOWN_ID]);
    const res = await withTempCwd(() => crawlPage(1, 'base', 'suffix', existingIds, 3));
    restore();
    assert.strictEqual(res.pageData.length, 1, '只有新 id 进入 pageData');
    assert.strictEqual(res.pageData[0].id, NEW_ID, '留下的应是新记录');
    // 注：existingIds 的补充发生在 crawl() 批量循环里，不在 crawlPage，故不在此 seam 断言。
  }

  console.log('crawlPage 去重: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
