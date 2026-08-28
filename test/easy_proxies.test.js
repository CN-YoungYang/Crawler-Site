// Seam: easy_proxies 管理 API 契约、健康节点端口轮换与 CEB 双 405 重试。
const assert = require('assert');
const { mockAxios, freshCrawler } = require('./helper');

function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function activeNodes() {
  return [
    { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
    { tag: 'N2', name: '节点二', port: '24001', available: true, initial_check_done: true },
    { tag: 'N3', name: '节点三', port: 24002, available: true, initial_check_done: true },
    { tag: 'dead', name: '不可用', port: 24003, available: false, initial_check_done: true },
    { tag: 'unchecked', name: '未探测', port: 24004, available: true, initial_check_done: false },
    { tag: 'blacklisted', name: '已拉黑', port: 24005, available: true, initial_check_done: true, blacklisted: true },
    { tag: 'N2', name: '重复节点', port: 24006, available: true, initial_check_done: true }
  ];
}

async function testNodeParsingAndRotation() {
  let nodeCalls = 0;
  const restoreAxios = mockAxios((url, config) => {
    assert.strictEqual(config.proxy, false, '管理 API 必须直连，不能再套业务代理');
    assert.ok(String(url).endsWith('/api/nodes'));
    nodeCalls++;
    return { data: { nodes: activeNodes() }, status: 200 };
  });
  const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
  const restorePassword = setEnv('EASY_PROXIES_PASSWORD', undefined);
  const restoreCebProxy = setEnv('PROXY_CEB', 'http://easy_proxies:24000');
  const crawler = freshCrawler();
  const provider = require('../sites/_easy_proxies');
  provider._resetRefreshCooldown();
  const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };

  try {
    const first = await provider.switchNode(config, {
      reason: 'dual405',
      proxyUrl: 'http://easy_proxies:24000'
    });
    assert.strictEqual(first.switched, true);
    assert.strictEqual(first.from, '节点一');
    assert.strictEqual(first.to, '节点二');
    assert.strictEqual(first.proxyUrl, 'http://easy_proxies:24001/');
    assert.deepStrictEqual(first.leaves, ['N1', 'N2', 'N3']);
    assert.deepStrictEqual(first.tried, ['N1', 'N2']);
    assert.deepStrictEqual(first.nodes.map(node => node.port), [24000, 24001, 24002]);

    const second = await provider.switchNode(config, {
      reason: 'dual405',
      proxyUrl: first.proxyUrl,
      tried: first.tried,
      cached: first
    });
    assert.strictEqual(second.to, '节点三');
    assert.strictEqual(second.proxyUrl, 'http://easy_proxies:24002/');
    assert.deepStrictEqual(second.tried, ['N1', 'N2', 'N3']);

    const exhausted = await provider.switchNode(config, {
      reason: 'dual405',
      proxyUrl: second.proxyUrl,
      tried: second.tried,
      cached: second
    });
    assert.strictEqual(exhausted.exhausted, true);
    assert.deepStrictEqual(exhausted.tried, ['N1', 'N2', 'N3']);
    assert.strictEqual(nodeCalls, 1, '缓存轮换和轮尽都不应再次请求管理 API');
  } finally {
    restorePassword();
    restoreController();
    restoreCebProxy();
    restoreAxios();
    void crawler;
  }
}

async function testAuthenticationAndRefresh() {
  let nodeCalls = 0;
  let authCalls = 0;
  let refreshCalls = 0;
  const restoreAxios = mockAxios((url, config) => {
    assert.strictEqual(config.proxy, false);
    const target = String(url);
    if (target.endsWith('/api/auth')) {
      authCalls++;
      assert.deepStrictEqual(config.data, { password: 'secret' });
      return { data: { token: 'session-token' }, status: 200 };
    }
    if (target.endsWith('/api/nodes')) {
      nodeCalls++;
      if (!config.headers || config.headers.Authorization !== 'Bearer session-token') {
        const error = new Error('unauthorized');
        error.response = { status: 401 };
        throw error;
      }
      return { data: { nodes: activeNodes().slice(0, 1) }, status: 200 };
    }
    if (target.endsWith('/api/subscription/refresh')) {
      refreshCalls++;
      assert.strictEqual(config.headers.Authorization, 'Bearer session-token');
      return { data: {}, status: 204 };
    }
    throw new Error(`unexpected management URL: ${target}`);
  });
  const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
  const restorePassword = setEnv('EASY_PROXIES_PASSWORD', 'secret');
  const restoreCebProxy = setEnv('PROXY_CEB', 'http://easy_proxies:24000');
  const crawler = freshCrawler();
  const provider = require('../sites/_easy_proxies');
  provider._resetRefreshCooldown();
  const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };

  try {
    const nodes = await provider.fetchNodes(config, 'http://easy_proxies:24000');
    assert.deepStrictEqual(nodes.nodes.map(node => node.tag), ['N1']);
    assert.strictEqual(authCalls, 1);
    assert.strictEqual(nodeCalls, 2, '管理 API 应在登录后重放原请求');

    assert.strictEqual(await provider.refreshProviders({
      site: 'ceb',
      reason: 'test',
      siteConfig: config,
      proxyUrl: 'http://easy_proxies:24000'
    }), true);
    assert.strictEqual(await provider.refreshProviders({
      site: 'ceb',
      reason: 'cooldown',
      siteConfig: config,
      proxyUrl: 'http://easy_proxies:24000'
    }), false);
    assert.strictEqual(refreshCalls, 1, '订阅刷新应遵守冷却时间');
  } finally {
    provider._resetRefreshCooldown();
    restorePassword();
    restoreController();
    restoreCebProxy();
    restoreAxios();
    void crawler;
  }
}

async function testSafeDegradation() {
  const restoreAxios = mockAxios((url, config) => {
    assert.strictEqual(config.proxy, false);
    if (String(url).endsWith('/api/nodes')) return { data: { nodes: [] }, status: 200 };
    throw new Error(`unexpected management URL: ${url}`);
  });
  const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
  const restorePassword = setEnv('EASY_PROXIES_PASSWORD', undefined);
  const restoreCebProxy = setEnv('PROXY_CEB', 'http://easy_proxies:24000');
  const crawler = freshCrawler();
  const provider = require('../sites/_easy_proxies');
  const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };

  try {
    const result = await provider.switchNode(config, {
      reason: 'empty-pool',
      proxyUrl: 'http://easy_proxies:24000'
    });
    assert.strictEqual(result.noop, true, '空节点池应安全降级，不应伪造换点成功');
  } finally {
    provider._resetRefreshCooldown();
    restorePassword();
    restoreController();
    restoreCebProxy();
    restoreAxios();
    void crawler;
  }

  const restoreAxiosFailed = mockAxios((url, config) => {
    assert.strictEqual(config.proxy, false);
    const error = new Error('management unavailable');
    error.code = 'ECONNREFUSED';
    throw error;
  });
  const crawlerFailed = freshCrawler();
  const providerFailed = require('../sites/_easy_proxies');
  try {
    const result = await providerFailed.switchNode(config, {
      reason: 'api-down',
      proxyUrl: 'http://easy_proxies:24000'
    });
    assert.strictEqual(result.noop, true, '管理 API 不可达应安全降级');
  } finally {
    providerFailed._resetRefreshCooldown();
    restoreAxiosFailed();
    void crawlerFailed;
  }

  const restoreAxiosAuthFailed = mockAxios((url, config) => {
    assert.strictEqual(config.proxy, false);
    const error = new Error('unauthorized');
    error.response = { status: 401 };
    throw error;
  });
  const restorePasswordAuthFailed = setEnv('EASY_PROXIES_PASSWORD', 'wrong');
  const crawlerAuthFailed = freshCrawler();
  const providerAuthFailed = require('../sites/_easy_proxies');
  try {
    const result = await providerAuthFailed.switchNode(config, {
      reason: 'auth-failed',
      proxyUrl: 'http://easy_proxies:24000'
    });
    assert.strictEqual(result.noop, true, '管理 API 认证失败应安全降级');
  } finally {
    providerAuthFailed._resetRefreshCooldown();
    restorePasswordAuthFailed();
    restoreAxiosAuthFailed();
    void crawlerAuthFailed;
  }
}

async function testCebDouble405RetriesCurrentPage() {
  let targetCalls = 0;
  let nodeCalls = 0;
  const restoreAxios = mockAxios((url, config) => {
    const target = String(url);
    assert.strictEqual(config.proxy, false, '控制面与业务代理都应由 crawler 显式处理');
    if (target.endsWith('/api/nodes')) {
      nodeCalls++;
      return { data: { nodes: activeNodes().slice(0, 3) }, status: 200 };
    }
    targetCalls++;
    if (targetCalls <= 2) {
      const error = new Error('Request failed with status code 405');
      error.response = { status: 405, data: '<html>waf</html>' };
      throw error;
    }
    return { data: '<table id="treeTable"><tbody></tbody></table>', status: 200 };
  });
  const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
  const restorePassword = setEnv('EASY_PROXIES_PASSWORD', undefined);
  const restoreCebProxy = setEnv('PROXY_CEB', 'http://easy_proxies:24000');
  const previousRandom = Math.random;
  Math.random = () => 0;
  const crawler = freshCrawler();
  const config = {
    name: 'ceb',
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    baseUrl: 'http://ceb.test/bulletin',
    fallbackOn405: true,
    buildUrl: page => `http://ceb.test/bulletin?page=${page}`
  };

  try {
    const result = await crawler.crawlPage(2, config, new Set(), 3);
    assert.strictEqual(result.failed, false, '切换端口后当前页重试成功，不应标记失败');
    assert.strictEqual(targetCalls, 3, '应为 GET 405、POST 405、换端口后的当前页重试');
    assert.strictEqual(nodeCalls, 1, '首次换端口只需读取一次节点列表');
    assert.strictEqual(config.runtimeProxyUrl, 'http://easy_proxies:24001/');
  } finally {
    Math.random = previousRandom;
    restorePassword();
    restoreController();
    restoreCebProxy();
    restoreAxios();
    void crawler;
  }
}

async function main() {
  await testNodeParsingAndRotation();
  await testAuthenticationAndRefresh();
  await testSafeDegradation();
  await testCebDouble405RetriesCurrentPage();
  console.log('easy_proxies 节点契约/端口轮换/认证降级/CEB 双 405 重试: OK');
}

main().catch(error => {
  console.error('FAIL', error.stack || error.message);
  process.exit(1);
});
