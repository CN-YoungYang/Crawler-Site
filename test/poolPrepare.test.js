// 回归：轮前代理池准备（ADR 0008）。
//
// 守卫的真实事故（2026-10-28 08:37 生产日志）：crawl_start 无条件刷新订阅，
// 刷新返回 0.43 秒后轮首换点只看到 5/58 个可用节点——刷新把池子打回「探测中」，
// 第一页探针在这 5 个里连试 3 个全 405，整轮 0 条。
//
// 决策：池子可用数 >= 3 就跳过轮前刷新；不足才刷；全部冷却时连刷都不刷，直接暂停。
// 接缝：crawl() 的 start 事件（proxy_pool_ready / proxy_pool_all_cooled_at_start）
// 与 /api/subscription/refresh 的实际调用次数。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, readEvents } = require('./helper');
const sitesIndex = require('../sites');

function pool(count) {
  return Array.from({ length: count }, (_, i) => ({
    tag: `N${i + 1}`,
    name: `节点${i + 1}`,
    port: 24000 + i,
    available: true,
    initial_check_done: true
  }));
}

function withSite(site, overrides) {
  sitesIndex.registry[site] = {
    name: site,
    baseUrl: 'http://site.test/list?page=',
    buildUrl: page => `http://site.test/list?page=${page}`,
    parse: () => [],
    batchSize: 1,
    proxy: 'http://easy_proxies:24000',
    proxyProvider: 'easy_proxies',
    easyProxiesController: 'http://controller.test:9091',
    ...overrides
  };
  return () => { delete sitesIndex.registry[site]; };
}

async function runCase({ site, nodeList, onNodes }) {
  let refreshCalls = 0;
  let businessCalls = 0;
  const restoreAxios = mockAxios((url) => {
    const target = String(url);
    if (target.endsWith('/api/subscription/refresh')) {
      refreshCalls++;
      return { status: 200, data: { message: '刷新成功' } };
    }
    if (target.endsWith('/api/subscription/status')) {
      return { status: 200, data: { enabled: true, node_count: nodeList.length, last_error: '', refresh_count: 1 } };
    }
    if (target.endsWith('/api/nodes')) {
      const list = onNodes ? onNodes(refreshCalls) : nodeList;
      return { status: 200, data: { nodes: list } };
    }
    businessCalls++;
    return { status: 200, data: '<html><body><table class="table_text"></table></body></html>' };
  });
  const restoreSite = withSite(site);
  let events = [];
  try {
    await withTempCwd(async () => {
      const { crawl } = freshCrawler();
      const provider = require('../sites/_easy_proxies');
      provider._resetRefreshCooldown();
      provider._resetNodeCooldown();
      try {
        await crawl({ site, totalPages: 1, interval: 0, maxRetries: 1 });
        events = readEvents(site);
      } finally {
        provider._resetRefreshCooldown();
        provider._resetNodeCooldown();
      }
    });
  } finally {
    restoreSite();
    restoreAxios();
  }
  return { refreshCalls, businessCalls, events };
}

async function main() {
  // (a) 池子够用：跳过轮前刷新，记 proxy_pool_ready
  {
    const { refreshCalls, businessCalls, events } = await runCase({
      site: 'pool-ready',
      nodeList: pool(5)
    });
    assert.strictEqual(refreshCalls, 0, '可用 5 个（>= 3）时不应触发整池刷新');
    assert.ok(businessCalls >= 1, '跳过刷新后应正常进入抓取');
    const ready = events.filter(e => e.event === 'proxy_pool_ready');
    assert.strictEqual(ready.length, 1, '应记录一条 proxy_pool_ready');
    assert.strictEqual(ready[0].usable, 5);
  }

  // (b) 池子不足：先刷新，刷新后池子补齐再抓
  {
    const { refreshCalls, events } = await runCase({
      site: 'pool-thin',
      nodeList: pool(5),
      onNodes: refreshCalls => (refreshCalls > 0 ? pool(5) : pool(1))
    });
    assert.strictEqual(refreshCalls, 1, '可用 1 个（< 3）时必须刷新一次');
    assert.strictEqual(events.filter(e => e.event === 'proxy_pool_ready').length, 0, '刷新分支不应记 ready');
  }

  // (c) 全部冷却：不刷新、不发请求，直接暂停本轮
  {
    const site = 'pool-all-cooled';
    let businessCalls = 0;
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/nodes')) return { status: 200, data: { nodes: pool(3) } };
      if (target.includes('/api/')) return { status: 200, data: {} };
      businessCalls++;
      return { status: 500, data: 'should not be called' };
    });
    const restoreSite = withSite(site);
    let events = [];
    try {
      await withTempCwd(async () => {
        const { crawl } = freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        provider._resetNodeCooldown();
        try {
          for (const node of pool(3)) provider._markNodeCooling(site, node.tag);
          await crawl({ site, totalPages: 1, interval: 0, maxRetries: 1 });
          events = readEvents(site);
        } finally {
          provider._resetRefreshCooldown();
          provider._resetNodeCooldown();
        }
      });
    } finally {
      restoreSite();
      restoreAxios();
    }
    assert.strictEqual(businessCalls, 0, '全部冷却时不应发出任何页面请求');
    assert.ok(events.some(e => e.event === 'proxy_pool_all_cooled_at_start'), '应记录轮前全冷却');
    const end = events.filter(e => e.event === 'crawl_end').pop();
    assert.strictEqual(end.allNodesCooled, true, 'crawl_end 应标记 allNodesCooled');
    assert.strictEqual(end.gateAborted, true, 'crawl_end 应标记 gateAborted');
  }

  console.log('轮前代理池准备（ADR 0008）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
