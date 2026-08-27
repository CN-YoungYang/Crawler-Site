// Seam: HTML 报告生成边界
// 行为：(1) file/<site>/ 不存在 → 创建目录 + 生成含"暂无数据"的 index.html；
//      (2) 损坏 xlsx → 跳过该文件、其余正常生成、log 警告；
//      (3) 按日期分片：index.html 轻量（仅日期/记录数/链接 + 跨日期最新 N 条预览），明细落 <date>.html。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { withTempCwd } = require('./helper');

const REPORT_PATH = require.resolve('../report');
const SITE = 'yfbzb';

function freshReport() {
  delete require.cache[REPORT_PATH];
  return require('../report');
}

async function main() {
  // (1) 空目录 → "暂无数据"
  await withTempCwd(async (dir) => {
    const { generateReport, LATEST_PREVIEW_COUNT } = freshReport();
    await generateReport(SITE);

    const html = fs.readFileSync(path.join(dir, 'file', SITE, 'index.html'), 'utf8');
    const tokens = fs.readFileSync(path.join(dir, 'file', SITE, 'tokens.css'), 'utf8');
    assert.ok(html.includes('暂无数据'), '空目录应渲染"暂无数据"');
    assert.ok(html.includes("document.getElementById('latest-section').hidden = true"), '空目录应隐藏最新公告预览');
    assert.ok(!html.includes('正常标题'), '索引页不应内联明细数据');
    assert.ok(html.includes('href="tokens.css"'), '报告页应加载共享设计 token');
    assert.ok(tokens.includes('Taste Skill: Clean Utility & High-Density Data'), 'token 文件应记录 Taste Skill 设计');
    assert.ok(tokens.includes('--bg'), 'token 文件应定义背景色');
    assert.strictEqual(LATEST_PREVIEW_COUNT, 10, '最新公告预览默认 10 条');
  });

  // (2) 损坏 xlsx 跳过、正常 xlsx 保留 + 分片明细
  await withTempCwd(async (dir) => {
    const fileDir = path.join(dir, 'file', SITE);
    fs.mkdirSync(fileDir, { recursive: true });

    fs.writeFileSync(path.join(fileDir, 'BAD.xlsx'), '不是 xlsx');

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([
      { id: '1', title: '正常标题', link: 'https://x', noticeType: 'T', area: 'A', publishTime: '2026/08/17' }
    ]), 'Sheet1');
    xlsx.writeFile(wb, path.join(fileDir, '2026-08-17.xlsx'));

    const { generateReport } = freshReport();
    await generateReport(SITE);

    const indexHtml = fs.readFileSync(path.join(fileDir, 'index.html'), 'utf8');
    assert.ok(!indexHtml.includes('BAD'), '坏文件不应出现在索引页');
    // 最新公告预览：跨全部日期取最新 N 条
    assert.ok(indexHtml.includes('正常标题'), '索引页应内联最新公告预览标题');
    assert.ok(indexHtml.includes('最新公告'), '索引页应有最新公告预览区');
    assert.ok(indexHtml.includes("preview.newestDate + '.html'"), '查看全部应跳最新一天明细页');
    assert.ok(indexHtml.includes("'noopener noreferrer'"), '预览外链应隔离新窗口上下文');
    const previewMatch = indexHtml.match(/var preview = (.*);/);
    assert.ok(previewMatch, '索引页应内联预览 JSON');
    const preview = JSON.parse(previewMatch[1]);
    assert.ok(Array.isArray(preview.rows) && preview.rows.length === 1, '单日数据预览应含该日记录');
    assert.strictEqual(preview.rows[0].date, '2026-08-17', '预览行应携带日期');
    assert.ok(indexHtml.includes('2026-08-17.xlsx'), '索引页应有下载链接');
    assert.ok(indexHtml.includes('"2026-08-17"'), '索引页 JSON 应含日期');
    assert.ok(indexHtml.includes("f.date + '.html'"), '索引页 JS 应拼明细页链接');
    assert.ok(indexHtml.includes('<span class="stat-label">总计日期</span><span class="stat-value">1</span>'), '统计应只计好文件');
    assert.ok(indexHtml.includes('stats-grid'), '索引页应有紧凑统计带');
    assert.ok(indexHtml.includes('date-search-status'), '索引页日期搜索应反馈结果数');
    assert.ok(indexHtml.includes('../index.html'), '索引页应有返回导航入口');

    const detailHtml = fs.readFileSync(path.join(fileDir, '2026-08-17.html'), 'utf8');
    assert.ok(detailHtml.includes('正常标题'), '明细页应含该日标题');
    assert.ok(detailHtml.includes('返回索引'), '明细页应有返回链接');
    assert.ok(detailHtml.includes('下载本日 XLSX'), '明细页应能直接下载当天数据');
    assert.ok(detailHtml.includes('th'), '明细页表头应可排序');
    assert.ok(detailHtml.includes('natCompare'), '明细页应含自然排序逻辑');
    assert.ok(detailHtml.includes('th'), '明细表头应声明列语义');
    assert.ok(detailHtml.includes('sort-arrow'), '排序状态应暴露给读屏器');
    assert.ok(detailHtml.includes('search-status'), '标题搜索应反馈匹配数量');
    assert.ok(detailHtml.includes('filtered-empty'), '零条搜索结果应有专用空状态');
    assert.ok(detailHtml.includes("rel = 'noopener noreferrer'"), '外链应隔离新窗口上下文');
    assert.ok(detailHtml.includes('href="common.css"'), '明细页应外链 common.css');
    const commonCss = fs.readFileSync(path.join(fileDir, 'common.css'), 'utf8');
    assert.ok(commonCss.includes('@media (max-width: 640px)'), 'common.css 应含移动布局');
    assert.ok(!detailHtml.includes("label: '类型'"), '明细页表头不应含类型列');
    assert.ok(!detailHtml.includes("label: '发布时间'"), '明细页表头不应含发布时间列');
    assert.ok(!detailHtml.includes("'noticeType'"), '明细页渲染逻辑不应引用 noticeType');
    assert.ok(!detailHtml.includes("'publishTime'"), '明细页渲染逻辑不应引用 publishTime');
  });

  console.log('HTML 报告生成: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
