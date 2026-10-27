// 回归：easy_proxies 管理面故障必须指向真实原因，而不是最后一个兜底地址。
//
// 守卫的真实事故（2026-10-27 生产日志）：管理面 /api/nodes 全程可用（15 秒后
// 还从 easy_proxies:9091 返回了节点），只有 POST /api/subscription/refresh 失败；
// 但 refreshProviders 遍历候选地址只保留最后一个 error，日志永远是
// 「connect ECONNREFUSED 127.0.0.1:9091」——排在最后的本机兜底地址。
// 真实原因（上游 500 {"error":"no subscription URLs configured"}）从未出现过，
// 排查被引向「管理面掉线」这个错误方向。
//
// 接缝：refreshProviders / fetchNodes 的公开返回值 + logs/<site>/*.jsonl 的
// proxy_provider_refresh_failed 事件（对外承诺的可 grep 观测面）。
// 期望值来自独立真相源：easy_proxies 的 HTTP handler 在刷新失败时返回
// 500 {"error": "<reason>"}（internal/monitor/server.go），不是照抄实现。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, setEnv, readEvents } = require('./helper');

function eventOf(events, name) {
  const found = events.filter(e => e.event === name);
  assert.strictEqual(found.length, 1, `应恰好记录 1 条 ${name}，实际 ${found.length}`);
  return found[0];
}

async function run() {
  // ---- (a) 每个候选管理地址的失败都必须逐条透出，并带出上游响应体里的 error ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      const host = new URL(target).hostname;
      if (host === 'controller.test') {
        const error = new Error('Request failed with status code 500');
        error.response = { status: 500, data: { error: 'no subscription URLs configured' } };
        throw error;
      }
      const error = new Error(`connect ECONNREFUSED ${host}:9091`);
      error.code = 'ECONNREFUSED';
      throw error;
    });
    const restores = [
      setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
      setEnv('EASY_PROXIES_API', undefined),
      setEnv('EASY_PROXIES_PASSWORD', undefined)
    ];
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          const ok = await provider.refreshProviders({
            site: 'ceb',
            reason: 'crawl_start',
            siteConfig: { name: 'ceb' },
            proxyUrl: 'http://easy_proxies:24000'
          });
          assert.strictEqual(ok, false, '全部管理地址失败时应返回 false');
          const event = eventOf(readEvents('ceb'), 'proxy_provider_refresh_failed');
          assert.ok(Array.isArray(event.attempts), '事件必须逐条携带每个地址的失败，不能只留最后一个');
          assert.deepStrictEqual(
            event.attempts.map(a => a.base),
            ['http://controller.test:9091', 'http://easy_proxies:9091'],
            '应逐条列出真实尝试过的管理地址'
          );
          const byBase = Object.fromEntries(event.attempts.map(a => [a.base, a]));
          assert.strictEqual(byBase['http://controller.test:9091'].status, 500);
          assert.ok(
            String(byBase['http://controller.test:9091'].detail).includes('no subscription URLs configured'),
            '必须带出上游响应体里的 error 文本，否则刷新失败永远只有「500」没有原因'
          );
          assert.strictEqual(byBase['http://easy_proxies:9091'].code, 'ECONNREFUSED');
          assert.ok(String(event.msg).includes('no subscription URLs configured'), '控制台通道同样要能看到真实原因');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restores.reverse().forEach(fn => fn());
      restoreAxios();
    }
  }

  console.log('管理面失败逐条透出（含上游 error）：通过');

  // ---- (b) /api/nodes 同样逐条透出：换点失败的方向不能被兜底地址带偏 ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      const host = new URL(target).hostname;
      if (host === 'controller.test') {
        const error = new Error('Request failed with status code 503');
        error.response = { status: 503, data: { error: 'nodes unavailable' } };
        throw error;
      }
      const error = new Error(`connect ECONNREFUSED ${host}:9091`);
      error.code = 'ECONNREFUSED';
      throw error;
    });
    const restores = [
      setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
      setEnv('EASY_PROXIES_API', undefined),
      setEnv('EASY_PROXIES_PASSWORD', undefined)
    ];
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          const out = await provider.switchNode(
            { name: 'ceb' },
            { reason: 'dual405', proxyUrl: 'http://easy_proxies:24000' }
          );
          assert.strictEqual(out.noop, true, '管理面全挂时应安全降级为 noop');
          const event = eventOf(readEvents('ceb'), 'proxy_nodes_failed');
          assert.deepStrictEqual(
            event.attempts.map(a => a.base),
            ['http://controller.test:9091', 'http://easy_proxies:9091'],
            '/api/nodes 失败也必须逐条列出真实尝试过的地址'
          );
          assert.ok(
            String(event.error).includes('nodes unavailable'),
            '换点失败同样要带出上游原因，而不是只留最后一个兜底地址的错误'
          );
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restores.reverse().forEach(fn => fn());
      restoreAxios();
    }
  }

  console.log('/api/nodes 失败同样逐条透出：通过');

  // ---- (c) 刷新走独立长超时；超时后必须写冷却，避免下一轮再阻塞一次 ----
  // 独立真相源：easy_proxies 的 POST /api/subscription/refresh 是同步等待（RefreshNowContext
  // 等拉订阅 + 健康检查跑完才返回），2s 的通用管理面超时永远等不到结果，配好订阅后每轮必报失败。
  {
    const timeouts = {};
    const restoreAxios = mockAxios((url, config) => {
      const target = String(url);
      if (target.endsWith('/api/nodes')) {
        timeouts.nodes = config && config.timeout;
        return { data: { nodes: [] }, status: 200 };
      }
      if (target.endsWith('/api/subscription/refresh')) {
        timeouts.refresh = config && config.timeout;
        const error = new Error('timeout of 60000ms exceeded');
        error.code = 'ECONNABORTED';
        throw error;
      }
      throw new Error(`unexpected management URL: ${target}`);
    });
    const restores = [
      setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
      setEnv('EASY_PROXIES_API', undefined),
      setEnv('EASY_PROXIES_REFRESH_TIMEOUT', undefined),
      setEnv('EASY_PROXIES_REFRESH_COOLDOWN', undefined)
    ];
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        const args = { site: 'ceb', reason: 'crawl_start', siteConfig: { name: 'ceb' }, proxyUrl: 'http://easy_proxies:24000' };
        try {
          await provider.fetchNodes({ name: 'ceb' }, 'http://easy_proxies:24000');
          assert.strictEqual(timeouts.nodes, 2000, '/api/nodes 保持 2s 短超时，管理面掉线要快速降级');

          const first = await provider.refreshProviders(args);
          assert.strictEqual(first, false, '超时仍应返回 false（契约不变）');
          assert.strictEqual(timeouts.refresh, 60000, '订阅刷新必须用独立的长超时（默认 60s），不能借用 2s');

          const event = eventOf(readEvents('ceb'), 'proxy_provider_refresh_timeout');
          assert.strictEqual(event.level, 'warn');
          assert.ok(
            String(event.msg).includes('可能仍在刷新'),
            '超时语义要说清「服务端可能仍在执行」，否则会被读成「刷新没发生」'
          );
          assert.ok(
            String(event.msg).includes('沿用现有节点'),
            '超时后本轮如何继续必须写明白，否则读者不知道这算不算故障'
          );

          const second = await provider.refreshProviders({ ...args, reason: 'next_round' });
          assert.strictEqual(second, false, '冷却窗口内第二次调用应被拦住');
          const events = readEvents('ceb');
          assert.strictEqual(
            events.filter(e => e.event === 'proxy_provider_refresh_timeout').length,
            1,
            '超时后必须写冷却：否则每轮都再阻塞一次 60s，而服务端每次都会真的重跑刷新'
          );
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restores.reverse().forEach(fn => fn());
      restoreAxios();
    }
  }

  console.log('订阅刷新独立长超时 + 超时写冷却：通过');

  // ---- (c2) 混合失败：一个地址明确拒绝（500）、另一个超时 ----
  // 500 是服务端明确拒绝，不能算「已受理」；只要没有地址超时，就不该写冷却。
  // 反向同理：只要有一个地址超时（且没有成功），服务端很可能在跑，必须写冷却。
  {
    // 先测「全家都被明确拒绝」：不写冷却，第二次调用仍会真的再请求一次。
    let calls = 0;
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) {
        calls++;
        const error = new Error('Request failed with status code 500');
        error.response = { status: 500, data: { error: 'no subscription URLs configured' } };
        throw error;
      }
      throw new Error(`unexpected management URL: ${target}`);
    });
    const restores = [
      setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
      setEnv('EASY_PROXIES_API', undefined),
      setEnv('EASY_PROXIES_REFRESH_TIMEOUT', undefined),
      setEnv('EASY_PROXIES_REFRESH_COOLDOWN', undefined)
    ];
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        const args = { site: 'ceb', reason: 'crawl_start', siteConfig: { name: 'ceb' }, proxyUrl: 'http://easy_proxies:24000' };
        try {
          await provider.refreshProviders(args);
          const afterFirst = calls;
          await provider.refreshProviders({ ...args, reason: 'next_round' });
          assert.ok(calls > afterFirst, '明确拒绝（非超时）不得写冷却：下一轮应重新尝试，而不是静默跳过一整轮');
          assert.strictEqual(
            readEvents('ceb').filter(e => e.event === 'proxy_provider_refresh_timeout').length,
            0,
            '没有地址超时时不得记成 timeout 事件'
          );
          assert.ok(
            readEvents('ceb').some(e => e.event === 'proxy_provider_refresh_failed'),
            '明确拒绝应记为 failed'
          );
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restores.reverse().forEach(fn => fn());
      restoreAxios();
    }
  }

  console.log('明确拒绝不写冷却（区别于超时）：通过');

  // ---- (d) 快照措辞：只能是「本轮早先快照」，不能写成「上一轮」----
  // 真相：leafSnapshot 属于本轮 rotation 实例，成功页会 reset() 清空它，
  // 所以快照只可能来自本轮更早的一次成功换点，绝不跨轮残留。
  // 措辞写成「上一轮」会让人误判「管理面早就不通了」，把排查引向错误方向。
  {
    const NODES = [
      { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
      { tag: 'N2', name: '节点二', port: 24001, available: true, initial_check_done: true }
    ];
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/nodes')) {
        const error = new Error('management unavailable');
        error.response = { status: 503, data: {} };
        throw error;
      }
      throw new Error(`unexpected ${target}`);
    });
    const restores = [
      setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
      setEnv('EASY_PROXIES_PASSWORD', undefined)
    ];
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          const out = await provider.switchNode(
            { name: 'ceb', easyProxiesController: 'http://controller.test:9091' },
            {
              reason: 'dual405',
              proxyUrl: 'http://easy_proxies:24000',
              tried: [],
              cached: { nodes: NODES.map(n => ({ ...n })), controller: 'http://controller.test:9091' }
            }
          );
          assert.strictEqual(out.source, 'snapshot');
          const switches = readEvents('ceb').filter(e => e.event === 'proxy_switched_stale_snapshot');
          assert.strictEqual(switches.length, 1, '快照换点应记录 proxy_switched_stale_snapshot');
          const msg = String(switches[0].msg);
          assert.ok(msg.includes('本轮'), '措辞应说明快照来自本轮更早的换点');
          assert.ok(!msg.includes('上一轮'), '不得写成「上一轮快照」：快照不会跨轮残留');
          assert.ok(
            !msg.includes('管理面未触达'),
            '不得写「管理面未触达」：管理面通常可用，只是本次没查；这句话会把排查引向「管理面掉线」'
          );
          assert.ok(msg.includes('未再查询管理面'), '要说清「本次没有再查管理面」，而不是暗示管理面挂了');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restores.reverse().forEach(fn => fn());
      restoreAxios();
    }
  }

  console.log('快照措辞指向本轮早先换点：通过');
}

run().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
