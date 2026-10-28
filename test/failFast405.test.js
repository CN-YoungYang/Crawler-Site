// failFast405：CEB 的 405 是出口 IP 级封禁，GET 405 直接冷却节点并换 IP，
// 不再在同一 IP 上发 POST。
//
// 守卫的行为：
// - GET 405 只发一次，然后换点；不得出现 fallback_post；
// - 首页仍受 firstPageProbeLimit 限制；
// - 非首页第二次 405 不得报 proxySwitched:true——否则 breaker 的连续 405
//   会被无限清零，逐页烧节点却永远不熔断。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, setEnv } = require('./helper');
const { pageHtml, ROW_NEW } = require('./fixtures');

function http405() {
  const error = new Error('Request failed with status code 405');
  error.response = { status: 405, data: '<html>waf</html>' };
  throw error;
}

function activeNodes(count) {
  return Array.from({ length: count }, (_, i) => ({
    tag: `N${i + 1}`,
    name: `节点${i + 1}`,
    port: 24000 + i,
    available: true,
    initial_check_done: true
  }));
}

function makeHarness(count, handler) {
  const state = { businessCalls: 0, postCalls: 0, ports: [], nodeCalls: 0 };
  const restoreAxios = mockAxios((url, config) => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) {
      state.nodeCalls++;
      return { status: 200, data: { nodes: activeNodes(count) } };
    }
    if (target.endsWith('/api/subscription/refresh')) return { status: 204, data: {} };
    if (target.endsWith('/api/subscription/status')) return { status: 200, data: { node_count: count } };
    state.businessCalls++;
    if (config && config.data !== undefined) state.postCalls++;
    const agentProxyUrl = config && config.httpAgent && config.httpAgent.proxy && config.httpAgent.proxy.href;
    if (agentProxyUrl) state.ports.push(new URL(agentProxyUrl).port);
    return handler(state, target, config);
  });
  return { state, restoreAxios };
}

function makeConfig(overrides = {}) {
  return {
    name: 'failfast',
    baseUrl: 'http://failfast.test/list',
    buildUrl: page => `http://failfast.test/list?page=${page}`,
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    failFast405: true,
    fallbackOn405: false,
    batchSize: 1,
    ...overrides
  };
}

async function testSingle405SwitchesWithoutPost() {
  const { state, restoreAxios } = makeHarness(3, s => {
    if (s.businessCalls === 1) http405();
    return { status: 200, data: pageHtml([ROW_NEW]) };
  });
  const restoreEnv = setEnv('EASY_PROXIES_NODE_COOLDOWN_MS', undefined);
  try {
    let events = [];
    const result = await withNoJitter(() => withTempCwd(async () => {
      const { crawlPage } = freshCrawler();
      const res = await crawlPage(1, makeConfig(), new Set(), 1);
      events = readEvents('failfast');
      return res;
    }));
    assert.strictEqual(result.failed, false, '换到干净节点后应成功');
    assert.strictEqual(state.businessCalls, 2, '应只发两次 GET：原节点 405 + 新节点成功');
    assert.strictEqual(state.postCalls, 0, 'failFast405 不得发 POST');
    assert.deepStrictEqual(state.ports, ['24000', '24001'], '应换到节点二');
    assert.ok(events.some(e => e.event === 'page_failed_405_fastfail'), '应有 405 快败事件');
    assert.ok(!events.some(e => e.event === 'fallback_post'), '不得降级 POST');
  } finally {
    restoreEnv();
    restoreAxios();
  }
}

async function testFirstPageProbeLimitWithoutPost() {
  const { state, restoreAxios } = makeHarness(3, () => http405());
  const restoreEnv = setEnv('EASY_PROXIES_NODE_COOLDOWN_MS', undefined);
  try {
    const result = await withNoJitter(() => withTempCwd(async () => {
      const { crawlPage } = freshCrawler();
      return crawlPage(1, makeConfig({ firstPageProbeLimit: 2 }), new Set(), 1);
    }));
    assert.strictEqual(result.failed, true, '全部节点 405 时第一页应失败');
    assert.strictEqual(result.probeLimitReached, true, '应标记探针达到上限');
    assert.strictEqual(result.gateAbort, true, '探针达到上限应取消本轮');
    assert.strictEqual(state.businessCalls, 2, 'limit=2：首节点 + 一个换点，各一发 GET');
    assert.strictEqual(state.postCalls, 0, 'failFast405 不得发 POST');
    assert.deepStrictEqual(state.ports, ['24000', '24001']);
  } finally {
    restoreEnv();
    restoreAxios();
  }
}

async function testNonFirstPageSecond405DoesNotResetBreaker() {
  const { state, restoreAxios } = makeHarness(3, () => http405());
  const restoreEnv = setEnv('EASY_PROXIES_NODE_COOLDOWN_MS', undefined);
  try {
    let provider;
    const result = await withNoJitter(() => withTempCwd(async () => {
      const { crawlPage } = freshCrawler();
      provider = require('../sites/_easy_proxies');
      return crawlPage(2, makeConfig(), new Set(), 1);
    }));
    assert.strictEqual(result.failed, true);
    assert.strictEqual(result.status, 405);
    assert.strictEqual(result.proxySwitched, false, '第二次 405 不得报换点成功，否则 405 连击被清零');
    assert.strictEqual(state.businessCalls, 2, '本页只在新旧两个节点各发一发 GET');
    assert.strictEqual(state.postCalls, 0, 'failFast405 不得发 POST');
    assert.deepStrictEqual(state.ports, ['24000', '24001']);

    // 刚被 405 的节点二也必须进入冷却：从节点一端口再换点应跳过一二直接到节点三。
    const sw = await provider.switchNode(makeConfig(), {
      reason: 'scheduled',
      proxyUrl: 'http://easy_proxies:24000'
    });
    assert.strictEqual(sw.to, '节点3', '节点1与节点2都应在 405 后冷却');
  } finally {
    restoreEnv();
    restoreAxios();
  }
}

async function testCrawlBreaksAfterTwo405Pages() {
  const SITE = 'fastfail-crawl';
  const { state, restoreAxios } = makeHarness(3, (s, url) => {
    if (String(url).includes('page=1')) return { status: 200, data: pageHtml([ROW_NEW]) };
    http405();
  });
  const restoreEnv = setEnv('EASY_PROXIES_NODE_COOLDOWN_MS', undefined);
  const sitesIndex = require('../sites');
  sitesIndex.registry[SITE] = { ...makeConfig(), name: SITE };
  try {
    let events = [];
    await withNoJitter(() => withTempCwd(async () => {
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 1 });
      events = readEvents(SITE);
    }));
    assert.strictEqual(state.postCalls, 0, '整轮不得发 POST');
    assert.strictEqual(state.businessCalls, 4, '页1成功 1 发；页2 新旧节点各 1 发；页3 新节点 1 发后熔断');
    const circuit = events.find(e => e.event === 'circuit_break_405');
    assert.ok(circuit, '连续 2 页 405 应熔断');
    assert.strictEqual(circuit.consecutive405, 2);
    assert.strictEqual(circuit.proxySwitches405, 2, '日志应如实记录 405 换点次数（不被清零语义吞掉）');
    assert.ok(events.some(e => e.event === 'all_nodes_cooled'), '非首页换点发现全部节点冷却应立即暂停本轮');
    const end = events.find(e => e.event === 'crawl_end');
    assert.strictEqual(end.gateAborted, true, '汇总应标记本轮已暂停');
    assert.strictEqual(end.allNodesCooled, true, '汇总应记录全部节点冷却');
  } finally {
    delete sitesIndex.registry[SITE];
    restoreEnv();
    restoreAxios();
  }
}

async function main() {
  const ceb = require('../sites/ceb');
  assert.strictEqual(ceb.failFast405, true, 'ceb 应启用 failFast405');
  assert.strictEqual(ceb.fallbackOn405, false, 'ceb 不应再做 GET→POST 降级');

  await testSingle405SwitchesWithoutPost();
  await testFirstPageProbeLimitWithoutPost();
  await testNonFirstPageSecond405DoesNotResetBreaker();
  await testCrawlBreaksAfterTwo405Pages();
  console.log('CEB 405 单发快败（换点/探针限次/防连击清零）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
