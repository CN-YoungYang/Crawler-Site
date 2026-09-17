const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

async function testBatchIsPersistedBeforeNextBatch() {
  let secondBatchSawFile = false;
  const restore = mockAxios(url => {
    const match = /pageNo=(\d+)/.exec(String(url));
    const page = match ? Number(match[1]) : 1;
    if (page === 11) {
      secondBatchSawFile = fs.existsSync(path.join(process.cwd(), 'file', 'yfbzb', '2025-09-30.xlsx'));
    }
    return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
  });

  try {
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl({ site: 'yfbzb', totalPages: 11, interval: 0, maxRetries: 1 }));
  } finally {
    restore();
  }

  assert.strictEqual(secondBatchSawFile, true, '下一批开始前，上一批数据必须已经落盘');
}

async function testFailedPageIsRetainedForResume() {
  const restore = mockAxios(url => {
    const match = /pageNo=(\d+)/.exec(String(url));
    const page = match ? Number(match[1]) : 1;
    if (page === 2) {
      const error = new Error('simulated network failure');
      error.code = 'ECONNRESET';
      throw error;
    }
    return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) };
  });

  try {
    const { crawl } = freshCrawler();
    await withTempCwd(async dir => {
      await crawl({ site: 'yfbzb', totalPages: 10, interval: 0, maxRetries: 1 });
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state-yfbzb.json'), 'utf8'));
      assert.strictEqual(state.currentPage, 2, '失败页必须保留为下次续跑起点');
      assert.ok(!state.existingIds.includes('000000002'), '失败页的记录不能进入已处理 ID');
    });
  } finally {
    restore();
  }
}

async function testInvalidPublishTimeCannotEscapeSiteDirectory() {
  const maliciousRow = '<tr><td><a href="/inviteBid/detail/unsafe.html">异常日期</a></td>'
    + '<td>公告</td><td>湖北</td><td>../outside</td></tr>';
  const restore = mockAxios(() => ({ status: 200, data: pageHtml([maliciousRow]) }));

  try {
    const { crawl } = freshCrawler();
    await withTempCwd(async dir => {
      await crawl({ site: 'yfbzb', totalPages: 1, interval: 0, maxRetries: 1 });
      assert.ok(!fs.existsSync(path.join(dir, 'file', 'outside.xlsx')), '异常发布日期不能写出站点目录');
      assert.ok(!fs.existsSync(path.join(dir, 'file', 'yfbzb', 'outside.xlsx')), '异常发布日期不能生成伪造日期文件');
    });
  } finally {
    restore();
  }
}

async function main() {
  await testBatchIsPersistedBeforeNextBatch();
  await testFailedPageIsRetainedForResume();
  await testInvalidPublishTimeCannotEscapeSiteDirectory();
  console.log('可靠性回归：通过');
}

main().catch(error => {
  console.error('失败', error.message);
  process.exit(1);
});
