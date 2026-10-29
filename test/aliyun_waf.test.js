// 回归：ceb 的阿里云 WAF acw 挑战。
// (a) 盾页识别与沙箱求解（URL 重写模式）
// (b) crawlPage 解盾后带 acw_tc 重放签名 URL，返回真实数据
// (c) 求解失败必须记为失败页（shieldType），不得退化成「0 行成功」的静默失败
// (d) 连续 2 页求解失败熔断，不空转烧掉整池出口
const assert = require('assert');
const fs = require('fs');
const { mockAxios, freshCrawler, withTempCwd, readEvents, readCheckpoint } = require('./helper');

const waf = require('../sites/_aliyun_waf');
const ceb = require('../sites/ceb');

// 合成挑战页：脚本以 URL 重写方式追加签名参数。
// 结构仿真真实盾页（renderData + document.location.href 回写），但不执行公网脚本。
const CHALLENGE_HTML = `<!doctype html><html><head><script>
(function () {
  var rd = JSON.parse(document.getElementById('renderData').innerHTML);
  var url = document.location.href;
  document.location.href = url + '&time__9999=' + encodeURIComponent(rd._waf_test);
})();
</script></head><body><textarea id="renderData">{"_waf_test":"token-abc"}</textarea></body></html>`;

// 同样命中盾页特征，但没有可执行脚本 → 求解必须失败。
const UNSOLVABLE_HTML = `<!doctype html><html><body><textarea id="renderData">{"_waf_test":"token-abc"}</textarea></body></html>`;

function cebRow(id, title, date) {
  return `<tr><td name="imgShow"><a href="javascript:urlOpen('${id}')" title="${title}">${title}</a></td>`
    + `<td>工程建设</td><td>【湖北】</td><td>某媒介</td><td>${date}</td><td>3天</td></tr>`;
}

function cebPage(rows) {
  return `<table class="table_text"><tbody>${rows.join('')}</tbody></table>`
    + '<div class="pagination">共1页 当前页是第1页</div>';
}

const REQUEST_URL = 'http://ceb.test/bulletin?page=1';

function cebTestConfig(extra = {}) {
  return {
    name: 'cebtest',
    baseUrl: 'http://ceb.test/bulletin',
    buildUrl: page => `http://ceb.test/bulletin?page=${page}`,
    parse: ceb.parse,
    challenge: ceb.challenge,
    timeout: 1000,
    ...extra
  };
}

async function testDetectAndSolve() {
  assert.strictEqual(waf.isChallenge({ status: 200, headers: {}, data: CHALLENGE_HTML }), true, '盾页应被识别');
  assert.strictEqual(
    waf.isChallenge({ status: 200, headers: {}, data: cebPage([cebRow('a1', '正常公告', '2026-10-25')]) }),
    false,
    '正常列表页不得误判为盾页'
  );
  assert.strictEqual(waf.isChallenge({ status: 405, headers: {}, data: CHALLENGE_HTML }), false, '405 阻断页仍走现有流程');

  const solved = waf.solve(
    { status: 200, headers: { 'set-cookie': ['acw_tc=abc123; path=/'] }, data: CHALLENGE_HTML },
    REQUEST_URL
  );
  assert.ok(solved && solved.url, '应解出签名 URL');
  assert.ok(solved.url.startsWith(REQUEST_URL), '签名 URL 应基于原 URL');
  assert.ok(solved.url.includes('time__9999=token-abc'), '签名参数应写回 URL');
  assert.strictEqual(solved.headers.Cookie, 'acw_tc=abc123', '重放必须带 acw_tc');

  assert.strictEqual(
    waf.solve({ status: 200, headers: {}, data: UNSOLVABLE_HTML }, REQUEST_URL),
    null,
    '无脚本时求解必须返回 null'
  );
}

async function testCrawlPageReplaysAfterSolve() {
  const calls = [];
  const restore = mockAxios((url, config) => {
    calls.push({ url: String(url), headers: config.headers || {} });
    if (calls.length === 1) {
      return { data: CHALLENGE_HTML, status: 200, headers: { 'set-cookie': ['acw_tc=abc123; path=/'] } };
    }
    return { data: cebPage([cebRow('a1', '湖北某项目招标公告', '2026-10-25')]), status: 200, headers: {} };
  });
  try {
    const { crawlPage } = freshCrawler();
    const result = await withTempCwd(() => crawlPage(1, cebTestConfig(), new Set(), 1));
    assert.strictEqual(result.failed, false, '解盾重放成功后不应记失败');
    assert.strictEqual(result.pageData.length, 1, '应解析出 1 条公告');
    assert.strictEqual(calls.length, 2, '应为「原请求 + 签名重放」两次');
    assert.ok(calls[1].url.includes('time__9999=token-abc'), '重放应使用签名 URL');
    assert.ok(String(calls[1].headers.Cookie || '').includes('acw_tc=abc123'), '重放必须带 acw_tc');
  } finally {
    restore();
  }
}

async function testUnsolvedChallengeIsFailure() {
  const restore = mockAxios(() => ({ data: UNSOLVABLE_HTML, status: 200, headers: {} }));
  try {
    const { crawlPage } = freshCrawler();
    const result = await withTempCwd(() => crawlPage(1, cebTestConfig(), new Set(), 1));
    assert.strictEqual(result.failed, true, '盾页不可解必须记为失败页，不能当成 0 行成功');
    assert.strictEqual(result.shieldType, 'acw');
    assert.deepStrictEqual(result.pageData, []);
  } finally {
    restore();
  }
}

async function testReplayBlockedIsShieldFailure() {
  let calls = 0;
  const restore = mockAxios(() => {
    calls++;
    if (calls === 1) {
      return { data: CHALLENGE_HTML, status: 200, headers: { 'set-cookie': ['acw_tc=abc123; path=/'] } };
    }
    const err = new Error('Request failed with status code 405');
    err.response = { status: 405, data: 'blocked' };
    throw err;
  });
  try {
    const { crawlPage } = freshCrawler();
    const result = await withTempCwd(() => crawlPage(1, cebTestConfig(), new Set(), 1));
    assert.strictEqual(result.failed, true, '重放被 405 拦截必须记为失败页');
    assert.strictEqual(result.shieldType, 'acw');
    assert.strictEqual(result.status, 405);
    assert.strictEqual(calls, 2, '重放 405 后不得再走 GET→POST 降级，多打一发只会延长封禁');
  } finally {
    restore();
  }
}

// (f) 重放请求同样受站点 requestDelay 节流：每页两发之间必须有间隔。
// 冷请求前的节流只覆盖第一发；若重放直发，ceb 每页实际是两次背靠背请求。
async function testReplayIsThrottled() {
  const calls = [];
  const restore = mockAxios(() => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return { data: CHALLENGE_HTML, status: 200, headers: { 'set-cookie': ['acw_tc=abc123; path=/'] } };
    }
    return { data: cebPage([cebRow('a1', '湖北某项目招标公告', '2026-10-25')]), status: 200, headers: {} };
  });
  try {
    const { crawlPage } = freshCrawler();
    const config = cebTestConfig({ requestDelay: { min: 100, max: 100 } });
    const result = await withTempCwd(() => crawlPage(1, config, new Set(), 1));
    assert.strictEqual(result.failed, false, '解盾重放成功后不应记失败');
    assert.strictEqual(calls.length, 2, '应为「原请求 + 签名重放」两次');
    const gap = calls[1] - calls[0];
    assert.ok(gap >= 80, `重放前应按 requestDelay 节流，实际间隔 ${gap}ms`);
  } finally {
    restore();
  }
}

async function testCircuitBreaksAfterTwoShieldFailures() {
  let calls = 0;
  const restore = mockAxios(() => {
    calls++;
    return { data: UNSOLVABLE_HTML, status: 200, headers: {} };
  });
  const sitesIndex = require('../sites');
  sitesIndex.registry.cebtest = { ...cebTestConfig(), batchSize: 1 };
  try {
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl({ site: 'cebtest', totalPages: 100, interval: 0, maxRetries: 1 }));
    assert.strictEqual(calls, 2, '连续 2 页求解失败应熔断，不得继续请求 100 页');
  } finally {
    delete sitesIndex.registry.cebtest;
    restore();
  }
}

// (e) 末页求解失败不得被 SafeLine 的末页边界规则吞掉：仍记失败页并保留断点。
// 位置规则只适用于 shieldType=safeline（yfbzb 的确定性页码上限）；acw 是求解失败，
// 末页被吞会删断点并永久漏掉该页数据。
async function testLastPageUnsolvedChallengeKeepsCheckpoint() {
  const SITE = 'ceblast';
  const restore = mockAxios(() => ({ data: UNSOLVABLE_HTML, status: 200, headers: {} }));
  const sitesIndex = require('../sites');
  sitesIndex.registry[SITE] = { ...cebTestConfig(), name: SITE, batchSize: 1 };
  try {
    const { crawl } = freshCrawler();
    await withTempCwd(async () => {
      await crawl({ site: SITE, totalPages: 1, interval: 0, maxRetries: 1 });
      const events = readEvents(SITE);
      const end = events.filter(e => e.event === 'crawl_end').pop();
      assert.strictEqual(end.endReached, false, '末页求解失败不是数据边界');
      assert.strictEqual(end.totalFailed, 1, '末页求解失败必须计入失败页');
      assert.ok(
        !events.some(e => e.event === 'boundary_blocked_last_page'),
        'acw 不适用 SafeLine 的末页边界规则'
      );
      const state = readCheckpoint(SITE);
      assert.strictEqual(state.currentPage, 1, '断点应保留在失败页，供下轮续跑');
    });
  } finally {
    delete sitesIndex.registry[SITE];
    restore();
  }
}

async function main() {
  await testDetectAndSolve();
  await testCrawlPageReplaysAfterSolve();
  await testUnsolvedChallengeIsFailure();
  await testReplayBlockedIsShieldFailure();
  await testReplayIsThrottled();
  await testCircuitBreaksAfterTwoShieldFailures();
  await testLastPageUnsolvedChallengeKeepsCheckpoint();
  console.log('阿里云 WAF 挑战（识别/求解/重放/失败与熔断）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
