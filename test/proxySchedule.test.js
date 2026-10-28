// 主动按页轮换：不要等 405 才换 IP。
//
// 真实事故边界：CEB 每页是「冷请求 + 解盾重放」两发；当前实现一轮 100 页
// 可能在同一个出口上打满 200 发，直到该 IP 被 WAF 封禁。站点策略可声明
// rotateEveryPages，让 crawl() 每 N 页主动换一个代理节点。
//
// 接缝：crawl({site,totalPages,interval,maxRetries}) 的公开行为 + 业务请求实际
// 使用的代理端口（与 test/easy_proxies.test.js 的 usedProxyPorts 同一观测方式）。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');
const sitesIndex = require('../sites');

function pageOf(url) {
  return Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
}

async function main() {
  const SITE = 'proxy-sched';
  const usedPorts = [];
  const restoreAxios = mockAxios((url, config) => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) {
      return {
        status: 200,
        data: {
          nodes: [
            { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
            { tag: 'N2', name: '节点二', port: 24001, available: true, initial_check_done: true },
            { tag: 'N3', name: '节点三', port: 24002, available: true, initial_check_done: true }
          ]
        }
      };
    }
    if (target.endsWith('/api/subscription/refresh')) return { status: 204, data: {} };
    if (target.endsWith('/api/subscription/status')) return { status: 200, data: { node_count: 3 } };
    // 业务请求：记录该页实际使用的代理端口
    const proxyHref = config && config.httpAgent && config.httpAgent.proxy && config.httpAgent.proxy.href;
    if (proxyHref) usedPorts.push(new URL(proxyHref).port);
    const page = pageOf(target);
    return {
      status: 200,
      data: pageHtml([yfbzbRow(`20251028_${String(page).padStart(9, '0')}`)])
    };
  });
  const restoreSite = withSite(SITE, {
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    batchSize: 1,
    rotateEveryPages: 2
  });

  try {
    await withNoJitter(() => withTempCwd(async () => {
      const { crawl } = freshCrawler();
      await crawl({ site: SITE, totalPages: 4, interval: 0, maxRetries: 1 });
    }));
  } finally {
    restoreSite();
    restoreAxios();
  }

  assert.deepStrictEqual(
    usedPorts,
    ['24000', '24000', '24001', '24001'],
    `每 2 页应主动换一个节点：前 2 页 24000，后 2 页 24001；实际 ${usedPorts.join(',')}`
  );
  console.log('主动按页轮换（rotateEveryPages）：通过');
}

function withSite(site, overrides) {
  sitesIndex.registry[site] = { ...sitesIndex.registry.yfbzb, name: site, ...overrides };
  return () => { delete sitesIndex.registry[site]; };
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
