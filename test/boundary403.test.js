// Seam 2: crawlPage 403 边界语义
// 行为：403 → endReached:true / failed:false / 不重试（handler 仅被调一次）。
// axios 的 403 会以 error.response.status=403 抛出，crawlPage 在 catch 里识别。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');

async function main() {
  let calls = 0;
  const restore = mockAxios(() => {
    calls++;
    const err = new Error('Request failed with status code 403');
    err.response = { status: 403 };
    throw err;
  });
  const { crawlPage } = freshCrawler();
  // crawlPage 现写 JSONL 日志（文件副作用），套 withTempCwd 隔离日志落盘。
  const res = await withTempCwd(() => crawlPage(99, 'base', 'suffix', new Set(), 3));
  restore();

  assert.strictEqual(res.endReached, true, '403 应标记 endReached');
  assert.strictEqual(res.failed, false, '403 是边界不是故障');
  assert.strictEqual(res.pageData.length, 0, '403 不产生数据');
  assert.strictEqual(calls, 1, '403 不应重试');

  console.log('crawlPage 403 边界: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
