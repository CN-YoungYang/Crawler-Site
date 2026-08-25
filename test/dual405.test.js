// Seam: crawlPage 405 降级 / 双 405 快败 / 网络级连败换 IP 与熔断
// (a) 末次重试遇 GET 405 → 必须真正发出 POST 并返回结果对象，绝不隐式 undefined
//     （2026-08-24 生产崩溃：降级扣光 retries 后 while 条件退出，crawl() 解构 results[i] 抛 TypeError）
// (b) GET 405 → POST 仍 405 → 双 405 快败 failed:true status:405（不空转重试）
// (c) 连续无 status 失败（ECONNRESET/超时）达熔断阈值 → crawl 提前结束，不再爬满 totalPages
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');

async function main() {
  // ---- (a) 前两次超时耗尽重试额度，第三次 GET 405 触发降级：POST 必须真发出去 ----
  {
    const seen = [];
    let calls = 0;
    const restore = mockAxios((url, config) => {
      calls++;
      const method = (config && config.data !== undefined) ? 'POST' : 'GET';
      if (method === 'GET') {
        seen.push('GET');
        if (seen.filter(m => m === 'GET').length <= 2) {
          // 前两次：超时类网络错误（无 response）
          const err = new Error('timeout of 30000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        // 第三次 GET：405
        const err405 = new Error('Request failed with status code 405');
        err405.response = { status: 405, data: '<html>waf</html>' };
        throw err405;
      }
      seen.push('POST');
      // 降级 POST 返回空表格页：模拟 WAF 放行后的正常响应
      return { data: '<table id="treeTable"><tbody></tbody></table>', status: 200 };
    });
    const { crawlPage } = freshCrawler();
    // buildUrl 带 query：crawler 的 POST 分支在无 query 时回退 GET 语义（见 crawler.js），mock 需借 data 字段区分方法
    const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
    const res = await withTempCwd(() => crawlPage(23, siteConfig, new Set(), 3));
    restore();
    assert.ok(res && typeof res === 'object', '返回值必须是结果对象，不能是 undefined');
    assert.strictEqual(res.failed, false, '降级 POST 成功后不算失败');
    assert.strictEqual(seen.filter(m => m === 'GET').length, 3, 'GET 应发出 3 次（2 超时 + 1 次 405）');
    assert.strictEqual(seen.filter(m => m === 'POST').length, 1, '降级 POST 必须真正发出（原 bug 在此被吞掉）');
  }

  // ---- (b) GET 405 → POST 仍 405：双 405 快败 ----
  {
    let getCalls = 0, postCalls = 0;
    const restore = mockAxios((url, config) => {
      const method = (config && config.data !== undefined) ? 'POST' : 'GET';
      if (method === 'POST') { postCalls++; }
      else { getCalls++; }
      const err = new Error('Request failed with status code 405');
      err.response = { status: 405, data: '<html>blocked</html>' };
      throw err;
    });
    const { crawlPage } = freshCrawler();
    const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
    const res = await withTempCwd(() => crawlPage(1, siteConfig, new Set(), 3));
    restore();
    assert.strictEqual(getCalls, 1, 'GET 仅一次');
    assert.strictEqual(postCalls, 1, 'POST 仅一次（快败不重试）');
    assert.strictEqual(res.failed, true, '双 405 应标记失败');
    assert.strictEqual(res.status, 405, 'status 应为 405（供 crawl 熔断计数）');
    assert.strictEqual(res.pageData.length, 0);
  }

  // ---- (c) 网络级连败熔断：无 status 的失败达 NET_FAIL_BREAK_THRESHOLD 即提前结束 ----
  {
    let calls = 0;
    // 顺序必须 mockAxios 先于 freshCrawler：crawler 顶层钉死 axios 引用，需在 mock 就位后重载捕获
    const restore = mockAxios(() => {
      calls++;
      const err = new Error('Client network socket disconnected before secure TLS connection was established');
      err.code = 'ECONNRESET';
      throw err;
    });
    const { crawl, NET_FAIL_BREAK_THRESHOLD } = freshCrawler();
    await withTempCwd(() => crawl({ site: 'yfbzb', totalPages: 100, interval: 0 }));
    restore();
    // batchSize=10：首批 10 页全网络失败 → netFailStreak=2 换 IP（直连站 no-op）→ 第二批再失败 → streak=4
    // 第三批后 streak≥6 熔断；若不熔断会爬满 100 页（1000 次调用）
    assert.strictEqual(calls, NET_FAIL_BREAK_THRESHOLD * 10, `应恰好在 ${NET_FAIL_BREAK_THRESHOLD} 页 × batchSize(10) 时熔断`);
  }

  console.log('crawlPage 405 降级/双 405 快败/网络连败熔断: OK');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
