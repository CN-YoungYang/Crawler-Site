// 回归：第一页探针的时间上限（ADR 0008）。
//
// ceb 已改成「不设节点次数上限，试到成功或池子轮尽」。次数没有上限，
// 就必须有时间上限兜底：池子异常大或管理面变慢时，整轮不能卡在首页十几分钟。
//
// 接缝：crawlPage(1, ...) 的返回值（probeTimeoutReached / gateAbort）与请求次数。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter } = require('./helper');

function pool(count) {
  return Array.from({ length: count }, (_, i) => ({
    tag: `N${i + 1}`,
    name: `节点${i + 1}`,
    port: 24000 + i,
    available: true,
    initial_check_done: true
  }));
}

async function main() {
  let businessCalls = 0;
  const restoreAxios = mockAxios((url) => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) return { status: 200, data: { nodes: pool(10) } };
    businessCalls++;
    // 每个节点都要真的花时间，否则 1 秒的上限一秒都走不到；
    // 250ms × 4 个节点 ≈ 1s，正好在预算用尽处停下。
    return new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error('Request failed with status code 405');
        error.response = { status: 405, data: '<html>waf</html>' };
        reject(error);
      }, 250);
    });
  });

  const config = {
    name: 'probe-timeout',
    baseUrl: 'http://probe.test/list?page=',
    buildUrl: page => `http://probe.test/list?page=${page}`,
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    failFast405: true,
    firstPageProbeLimit: 0,
    firstPageProbeTimeoutMs: 1000
  };

  let res;
  try {
    const { crawlPage } = freshCrawler();
    res = await withNoJitter(() => withTempCwd(() => crawlPage(1, config, new Set(), 1)));
  } finally {
    restoreAxios();
  }

  assert.strictEqual(res.failed, true, '全部节点 405 时第一页应失败');
  assert.strictEqual(res.probeTimeoutReached, true, '时间用尽应标记 probeTimeoutReached');
  assert.strictEqual(res.gateAbort, true, '超时应取消本轮');
  assert.ok(businessCalls >= 3 && businessCalls <= 5, `1000ms 内应只试 3-5 个节点，实际 ${businessCalls}`);
  console.log('第一页探针时间上限：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
