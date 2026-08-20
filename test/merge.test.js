// Seam 3: 文件合并去重（新数据优先）
// 行为：已存在 file/<site>/<publishTime>.xlsx 里同 id 旧行被新行覆盖、不同 id 旧行保留。
// 通过 crawl() 整段驱动：mock axios 返回新记录，预置含同 id 旧行 + 不同 id 旧行的 Excel。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { ROW_KNOWN, ROW_NEW, KNOWN_ID, NEW_ID, pageHtml } = require('./fixtures');

async function main() {
  await withTempCwd(async (dir) => {
    const publishTime = '2025/09/30';
    const site = 'yfbzb';
    const fileDir = path.join(dir, 'file', site);
    fs.mkdirSync(fileDir, { recursive: true });
    const oldSame = { id: KNOWN_ID, title: '旧标题应被覆盖', link: 'x', noticeType: '旧', area: '旧', publishTime };
    const oldKeep = { id: '20250930_OTHER', title: '不同 id 旧行应保留', link: 'y', noticeType: '旧', area: '旧', publishTime };
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([oldSame, oldKeep]), 'Sheet1');
    xlsx.writeFile(wb, path.join(fileDir, '2025-09-30.xlsx'));

    const restore = mockAxios(() => ({ data: pageHtml([ROW_KNOWN, ROW_NEW]), status: 200 }));
    const { crawl } = freshCrawler();
    await crawl({ site, totalPages: 1, interval: 0 });
    restore();

    const wb2 = xlsx.readFile(path.join(fileDir, '2025-09-30.xlsx'));
    const rows = xlsx.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]);
    const byId = new Map(rows.map(r => [r.id, r]));

    assert.ok(byId.has(NEW_ID), '新 id 行应写入');
    assert.ok(byId.has('20250930_OTHER'), '不同 id 旧行应保留');
    assert.strictEqual(byId.get(KNOWN_ID).title, '孝感市特殊教育学校2025年09政府采购意向',
      '同 id 旧行被新行覆盖（新数据优先）');
    assert.strictEqual(rows.length, 3, '最终 3 行：新2 + 保留旧1');
  });

  console.log('文件合并去重: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
