// Seam 4: crawl 终止条件（六条分支）
// (a) 首批含 403 → endReached，当前批并发发完后不进下一批
// (b) 一批无新数据且失败 ≤ threshold → 早停，不爬下一批
// (c) 每页有新数据 → 爬满 totalPages（兼作 (f) 回归：夹具无分页信息 → 行为不变）
// (d) 站点分页自报真实总页数 < 配置 → 批间收窄，精确止步于 min(真实, 配置)
// (e) 站点自报 > 配置 → min 规则，配置仍为硬上限
// (g) 两站 parseTotalPages 钩子纯函数单测（直接 require sites/*，非新缝）
// (h) checkpoint 续跑 + 收窄低于当前页 → 一批后自然退出并清除 checkpoint
// 每个用例都套 withTempCwd，避免 crawl 把 Excel 写回仓库 file/ 污染真实数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, ROW_NEW, yfbzbRow, yfbzbPagination, cebPagination } = require('./fixtures');

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

  // ---- (c) 每页有新数据 → 爬满 totalPages（(f) 无分页信息回归同源：pageHtml 无 .pagination）----
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

  // ---- (d1) 站点自报少于配置：750条/30=25 页 < 配置 100 → 收窄精确止步 ----
  {
    const calls = [];
    const restore = mockAxios((url) => {
      const m = /pageNo=(\d+)/.exec(url);
      const page = m ? parseInt(m[1], 10) : 1;
      calls.push(page);
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) + yfbzbPagination({ totalRecords: 750, pageSize: 30 }) };
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(100, 0));
    restore();
    assert.strictEqual(calls.length, 25, '真实上限 25 页：批1 发 10（观测未落地）+批2 发 10 +批3 发 min(10,5)=5，第 26 页起不再请求');
    assert.strictEqual(Math.max(...calls), 25, '最大请求页码恰为 25');
  }

  // ---- (d2) 真实 12 页（360/30）→ 末批恰 2 页后条件退出 ----
  {
    const calls = [];
    const restore = mockAxios((url) => {
      const m = /pageNo=(\d+)/.exec(url);
      const page = m ? parseInt(m[1], 10) : 1;
      calls.push(page);
      return { status: 200, data: pageHtml([yfbzbRow(String(page).padStart(9, '0'))]) + yfbzbPagination({ totalRecords: 360, pageSize: 30 }) };
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(100, 0));
    restore();
    assert.strictEqual(calls.length, 12, '真实上限 12 页：批1 发 10 +批2 发 min(10,2)=2，共 12 次');
    assert.strictEqual(Math.max(...calls), 12);
  }

  // ---- (e) 站点自报多于配置：30000/30=1000 页 > 配置 3 → min 规则，配置为硬上限 ----
  {
    let calls = 0;
    const restore = mockAxios(() => {
      calls++;
      return { status: 200, data: pageHtml([ROW_NEW]) + yfbzbPagination({ totalRecords: 30000, pageSize: 30 }) };
    });
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl(3, 0));
    restore();
    assert.strictEqual(calls, 3, '站点报 1000 页但配置 3 → 恰爬 3 页（配置硬上限不被突破）');
  }

  // ---- (g) 两站 parseTotalPages 钩子纯函数单测（直接 require sites/*，纯函数测试非新缝）----
  {
    const cheerio = require('cheerio');
    const yfbzb = require('../sites/yfbzb');
    const ceb = require('../sites/ceb');

    // yfbzb：controls「共 3000 条」÷ urlSuffix pageSize=30 → 100
    const yfbzbHtml = yfbzbPagination({ totalRecords: 3000, pageSize: 30 });
    assert.strictEqual(yfbzb.parseTotalPages(cheerio.load(yfbzbHtml), yfbzbHtml, yfbzb), 100);

    // yfbzb：统计横幅污染（banner 在 .pagination 外）→ 仍取分页控件内 3000÷30=100，锁定子树限定
    const bannerPolluted =
      `<div class="count wrapper-content-left-count">已为您找到近1个月相关的招标信息76470条</div>`
      + yfbzbPagination({ totalRecords: 3000, pageSize: 30 });
    assert.strictEqual(yfbzb.parseTotalPages(cheerio.load(bannerPolluted), bannerPolluted, yfbzb), 100);

    // yfbzb 兜底：urlSuffix 无 pageSize 时回退分页器最大数字页码链接
    const noSuffixConfig = { ...yfbzb, urlSuffix: '&provinceId=12' };
    const pagerOnly = yfbzbPagination({ totalRecords: 9999, pageSize: 50, lastPage: 42 });
    assert.strictEqual(yfbzb.parseTotalPages(cheerio.load(pagerOnly), pagerOnly, noSuffixConfig), 42);

    // yfbzb：无分页控件 → null；垃圾记录数但有数字页码链接 → 兜底取最大页码（3000/30 夹具生成 1..100 链接）
    assert.strictEqual(yfbzb.parseTotalPages(cheerio.load('<html><body></body></html>'), '', yfbzb), null);
    const garbage = yfbzbPagination({ totalRecords: 3000, pageSize: 30 }).replace(/共 \d+ 条/, '共 xx 条');
    assert.strictEqual(yfbzb.parseTotalPages(cheerio.load(garbage), garbage, yfbzb), 100);

    // ceb：「共3页」优先，无视矛盾的 #pageTotal="50 "（含尾随空格）
    const cebHtml = cebPagination(3, '50');
    assert.strictEqual(ceb.parseTotalPages(cheerio.load(cebHtml)), 3);
    assert.strictEqual(ceb.parseTotalPages(cheerio.load(cebPagination(7))), 7);
    assert.strictEqual(ceb.parseTotalPages(cheerio.load('<html><body></body></html>')), null);
  }

  // ---- (h) checkpoint 续跑 + 立即收窄低于当前页：一批后退出并清除 checkpoint ----
  {
    await withTempCwd(() => {
      fs.mkdirSync(path.join(process.cwd(), '.crawler-test'), { recursive: true });
      process.chdir('.crawler-test');
      fs.writeFileSync('state-yfbzb.json', JSON.stringify({ currentPage: 5, existingIds: [] }));
      let calls = 0;
      const restore = mockAxios(() => {
        calls++;
        return { status: 200, data: pageHtml([yfbzbRow(String(calls).padStart(9, '0'))]) + yfbzbPagination({ totalRecords: 90, pageSize: 30 }) }; // real=3
      });
      const { crawl } = freshCrawler();
      return crawl(100, 0).then(() => {
        restore();
        assert.strictEqual(calls, 10, '续跑自页 5 起发一批 10 页（5–14），观测 real=3 < 当前页 15 后条件退出');
        assert.strictEqual(fs.existsSync('state-yfbzb.json'), false, '干净结束应清除 checkpoint');
      });
    });
  }

  console.log('crawl 终止条件: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
