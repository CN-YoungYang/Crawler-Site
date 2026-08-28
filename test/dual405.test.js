// Seam: crawlPage 405 降级 / 双 405 快败 / 网络级连败与 easy_proxies 第一页探针。
// (a) 末次重试遇 GET 405 → 必须真正发出 POST 并返回结果对象，绝不隐式 undefined
// (b) GET 405 → POST 仍 405 → 双 405 快败 failed:true status:405（不空转重试）
// (c) 连续无 status 失败（ECONNRESET/超时）达熔断阈值 → crawl 提前结束，不再爬满 totalPages
// (d) easy_proxies 独立端口换点：第一页失败时按序切换节点，成功或节点池轮尽即停止
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, ROW_NEW } = require('./fixtures');

function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function mainBase() {
  const previousRandom = Math.random;
  Math.random = () => 0;
  try {
    // ---- (a) 前两次超时耗尽重试额度，第三次 GET 405 触发降级：POST 必须真发出去 ----
    {
      const seen = [];
      const restore = mockAxios((url, config) => {
        const method = (config && config.data !== undefined) ? 'POST' : 'GET';
        if (method === 'GET') {
          seen.push('GET');
          if (seen.filter(m => m === 'GET').length <= 2) {
            const error = new Error('timeout of 30000ms exceeded');
            error.code = 'ECONNABORTED';
            throw error;
          }
          const error = new Error('Request failed with status code 405');
          error.response = { status: 405, data: '<html>waf</html>' };
          throw error;
        }
        seen.push('POST');
        return { data: '<table id="treeTable"><tbody></tbody></table>', status: 200 };
      });
      const { crawlPage } = freshCrawler();
      const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
      try {
        const result = await withTempCwd(() => crawlPage(23, siteConfig, new Set(), 3));
        assert.ok(result && typeof result === 'object', '返回值必须是结果对象，不能是 undefined');
        assert.strictEqual(result.failed, false, '降级 POST 成功后不算失败');
        assert.strictEqual(seen.filter(m => m === 'GET').length, 3, 'GET 应发出 3 次（2 超时 + 1 次 405）');
        assert.strictEqual(seen.filter(m => m === 'POST').length, 1, '降级 POST 必须真正发出');
      } finally {
        restore();
      }
    }

    // ---- (b) GET 405 → POST 仍 405：双 405 快败 ----
    {
      let getCalls = 0;
      let postCalls = 0;
      const restore = mockAxios((url, config) => {
        const method = (config && config.data !== undefined) ? 'POST' : 'GET';
        if (method === 'POST') postCalls++;
        else getCalls++;
        const error = new Error('Request failed with status code 405');
        error.response = { status: 405, data: '<html>blocked</html>' };
        throw error;
      });
      const { crawlPage } = freshCrawler();
      const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
      try {
        const result = await withTempCwd(() => crawlPage(1, siteConfig, new Set(), 3));
        assert.strictEqual(getCalls, 1, 'GET 仅一次');
        assert.strictEqual(postCalls, 1, 'POST 仅一次（快败不重试）');
        assert.strictEqual(result.failed, true, '双 405 应标记失败');
        assert.strictEqual(result.status, 405, 'status 应为 405（供 crawl 熔断计数）');
        assert.strictEqual(result.pageData.length, 0);
      } finally {
        restore();
      }
    }

    // ---- (c) 网络级连败熔断：无 status 的失败达 NET_FAIL_BREAK_THRESHOLD 即提前结束 ----
    {
      let calls = 0;
      const restoreProxy = [
        'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'PROXY_URL'
      ].map(name => setEnv(name, undefined));
      const restore = mockAxios(() => {
        calls++;
        const error = new Error('Client network socket disconnected before secure TLS connection was established');
        error.code = 'ECONNRESET';
        throw error;
      });
      const { crawl, NET_FAIL_BREAK_THRESHOLD } = freshCrawler();
      try {
        await withTempCwd(() => crawl({ site: 'yfbzb', totalPages: 100, interval: 0 }));
        assert.strictEqual(calls, NET_FAIL_BREAK_THRESHOLD * 10, `应恰好在 ${NET_FAIL_BREAK_THRESHOLD} 页 × batchSize(10) 时熔断`);
      } finally {
        restore();
        restoreProxy.reverse().forEach(fn => fn());
      }
    }
  } finally {
    Math.random = previousRandom;
  }
  console.log('crawlPage 405 降级/双 405 快败/网络连败熔断: OK');
}

const EASY_NODES = [
  { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
  { tag: 'N2', name: '节点二', port: 24001, available: true, initial_check_done: true },
  { tag: 'N3', name: '节点三', port: 24002, available: true, initial_check_done: true }
];

function makeEasyHarness(targetHandler) {
  const state = { nodeCalls: 0, targetCalls: 0, targetUrls: [] };
  const restores = [
    setEnv('PROXY_CEBTEST', 'http://easy_proxies:24000'),
    setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
    setEnv('EASY_PROXIES_PASSWORD', undefined)
  ];
  const restoreAxios = mockAxios((url, config) => {
    const target = String(url);
    if (target.includes('/api/')) assert.strictEqual(config.proxy, false, '管理 API 必须绕过业务代理');
    if (target.endsWith('/api/nodes')) {
      state.nodeCalls++;
      return { data: { nodes: EASY_NODES.map(node => ({ ...node })) }, status: 200 };
    }
    if (target.endsWith('/api/subscription/refresh')) return { data: {}, status: 204 };
    state.targetCalls++;
    state.targetUrls.push(target);
    return targetHandler(state, target, config);
  });
  const crawler = freshCrawler();
  const config = {
    name: 'cebtest',
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    baseUrl: 'http://ceb.test/bulletin',
    fallbackOn405: true,
    batchSize: 1,
    buildUrl: page => `http://ceb.test/bulletin?page=${page}`
  };
  return {
    crawler,
    config,
    state,
    done() {
      restoreAxios();
      restores.reverse().forEach(fn => fn());
    }
  };
}

function networkError() {
  const error = new Error('Client network socket disconnected before secure TLS connection was established');
  error.code = 'ECONNRESET';
  throw error;
}

async function mainGate() {
  const previousRandom = Math.random;
  Math.random = () => 0;
  try {
    // (d1) 页 1 在前两个端口网络失败，切到第三个端口后成功。
    {
      const harness = makeEasyHarness(state => {
        if (state.targetCalls === 3) return { data: pageHtml([ROW_NEW]), status: 200 };
        networkError();
      });
      try {
        const result = await withTempCwd(() => harness.crawler.crawlPage(1, harness.config, new Set(), 1));
        assert.strictEqual(result.failed, false, '第三个 easy_proxies 端口成功后不应标记失败');
        assert.strictEqual(harness.state.targetCalls, 3, '三个端口各尝试一次');
        assert.strictEqual(harness.state.nodeCalls, 1, '节点列表只需查询一次');
        assert.strictEqual(harness.config.runtimeProxyUrl, 'http://easy_proxies:24002/');
      } finally {
        harness.done();
      }
    }

    // (d2) 页 1 全部端口网络失败 → gateAbort，不再让 crawl 继续请求后续页。
    {
      const harness = makeEasyHarness(() => networkError());
      const result = await withTempCwd(() => harness.crawler.crawlPage(1, harness.config, new Set(), 1));
      harness.done();
      assert.strictEqual(result.failed, true);
      assert.strictEqual(result.gateAbort, true, '节点池轮尽后应置 gateAbort');
      assert.strictEqual(harness.state.targetCalls, 3, '轮尽后不应重复请求');
    }

    // (d3) crawl 层收到 gateAbort 后只请求第一页。
    {
      const sitesIndex = require('../sites');
      const harness = makeEasyHarness(() => networkError());
      sitesIndex.registry.cebtest = { ...harness.config };
      try {
        await withTempCwd(() => harness.crawler.crawl({ site: 'cebtest', totalPages: 100, interval: 0 }));
      } finally {
        delete sitesIndex.registry.cebtest;
        harness.done();
      }
      assert.strictEqual(harness.state.targetCalls, 9, '第一页轮尽后不应发页 2+ 请求（3 个端口各重试 3 次）');
    }

    // (d4) 页 1 双 405 也应按端口轮尽并 gateAbort。
    {
      const harness = makeEasyHarness(() => {
        const error = new Error('Request failed with status code 405');
        error.response = { status: 405, data: '<html>waf</html>' };
        throw error;
      });
      try {
        const result = await withTempCwd(() => harness.crawler.crawlPage(1, harness.config, new Set(), 1));
        assert.strictEqual(result.failed, true);
        assert.strictEqual(result.gateAbort, true, '双 405 轮尽后应置 gateAbort');
        assert.strictEqual(result.status, 405);
        assert.strictEqual(harness.state.targetCalls, 4, '初始 GET/POST + 两个新端口的 POST');
      } finally {
        harness.done();
      }
    }
  } finally {
    Math.random = previousRandom;
  }
  console.log('easy_proxies 第一页探针（端口轮换/轮尽取消抓取）: OK');
}

async function main() {
  await mainBase();
  await mainGate();
}

main().catch(error => {
  console.error('FAIL', error.stack || error.message);
  process.exit(1);
});
