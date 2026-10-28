// 首页探针限次：第一页遇到 405 时只试有限个节点就暂停，不把整池节点一次打一遍。
//
// 背景：CEB 的 405 是 IP 级封禁；第一页探针若把 19 个节点各打 2 发，
// 既延长本轮失败时间，也可能把原本可用的节点一起打进黑名单。
//
// 接缝：crawlPage(1, siteConfig, existingIds, maxRetries) 的返回值与真实请求次数。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents } = require('./helper');
const sitesIndex = require('../sites');

function http405() {
  const err = new Error('Request failed with status code 405');
  err.response = { status: 405, data: '<html>waf</html>' };
  return err;
}

async function main() {
  let businessCalls = 0;
  let nodeCalls = 0;
  const restoreAxios = mockAxios(url => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) {
      nodeCalls++;
      return {
        status: 200,
        data: {
          nodes: [24000, 24001, 24002, 24003, 24004].map((port, i) => ({
            tag: `N${i + 1}`, name: `节点${i + 1}`, port, available: true, initial_check_done: true
          }))
        }
      };
    }
    businessCalls++;
    throw http405();
  });

  const config = {
    name: 'probe-limit',
    baseUrl: 'http://probe.test/list?page=',
    urlSuffix: '',
    buildUrl: page => `http://probe.test/list?page=${page}`,
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    fallbackOn405: true,
    firstPageProbeLimit: 3
  };

  let res;
  try {
    const { crawlPage } = freshCrawler();
    res = await withNoJitter(() => withTempCwd(() => crawlPage(1, config, new Set(), 1)));
  } finally {
    restoreAxios();
  }

  assert.strictEqual(res.failed, true, '全部节点 405 时第一页应失败');
  assert.strictEqual(res.probeLimitReached, true, '应标记「探针达到上限」，区别于节点池轮尽');
  assert.strictEqual(res.gateAbort, true, '探针达到上限应取消本轮，不再继续后续页');
  assert.strictEqual(businessCalls, 4, '首节点 GET→POST 2 发，后续节点沿用 POST 各 1 发（3 个节点共 4 发）；不应打到第 4 个节点');
  assert.ok(nodeCalls >= 1, '换点应查询节点列表');
  console.log('首页探针限次（firstPageProbeLimit）：通过');
}

// crawl() 集成：探针达到上限应立即取消本轮，不请求第 2 页，并写可 grep 的事件。
async function testCrawlIntegration() {
  const SITE = 'probe-limit-crawl';
  let businessCalls = 0;
  const restoreAxios = mockAxios(url => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) {
      return {
        status: 200,
        data: {
          nodes: [24000, 24001, 24002, 24003].map((port, i) => ({
            tag: `N${i + 1}`, name: `节点${i + 1}`, port, available: true, initial_check_done: true
          }))
        }
      };
    }
    if (target.endsWith('/api/subscription/refresh')) return { status: 204, data: {} };
    if (target.endsWith('/api/subscription/status')) return { status: 200, data: { node_count: 4 } };
    businessCalls++;
    throw http405();
  });
  const restoreSite = withSite(SITE, {
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    fallbackOn405: true,
    firstPageProbeLimit: 2,
    batchSize: 1
  });
  let events = [];
  let end;
  try {
    await withNoJitter(() => withTempCwd(async () => {
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 10, interval: 0, maxRetries: 1 });
      events = readEvents(SITE);
      end = events.filter(e => e.event === 'crawl_end').pop();
    }));
  } finally {
    restoreSite();
    restoreAxios();
  }
  assert.ok(events.some(e => e.event === 'first_page_probe_limited'), '应有 first_page_probe_limited 事件');
  assert.strictEqual(end.totalFailed, 1, '只应记录第 1 页失败');
  assert.strictEqual(end.gateAborted, true, '汇总应标记第一页探针取消');
  assert.strictEqual(businessCalls, 3, '首节点 GET→POST 2 发，第 2 个节点 POST 1 发后达到上限；不应请求第 2 页');
}

function withSite(site, overrides) {
  sitesIndex.registry[site] = { ...sitesIndex.registry.yfbzb, name: site, ...overrides };
  return () => { delete sitesIndex.registry[site]; };
}

main().then(testCrawlIntegration).then(() => {
  console.log('首页探针限次 crawl 集成：通过');
}).catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
