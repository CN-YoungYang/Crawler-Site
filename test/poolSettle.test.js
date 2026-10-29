// 回归：订阅刷新返回后，不能立刻拿「重建中的半池」去换点。
//
// 守卫的真实事故（2026-10-28 08:37 生产日志）：
//   08:37:53.894  easy_proxies 订阅刷新 [ceb] crawl_start，节点 58 个
//   08:37:54.320  轮首换点 → 已试 1/5
// 刷新返回 0.43 秒后就查 /api/nodes，58 个订阅节点里只有 5 个探测完成，其余被
// normalizeNodes 当成「未完成探测」过滤掉。第一页探针从这 5 个里连试 3 个都是 405，
// 整轮 0 条，剩下五十多个节点一次都没被看到。
//
// 接缝：refreshProviders(...) 的返回值（布尔契约不变）+ logs/<site>/*.jsonl 的
// proxy_pool_settled 事件（这一轮池子到底从几个收敛到几个，只有它能回答）。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd, setEnv, readEvents } = require('./helper');

const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };
const refreshArgs = {
  site: 'ceb',
  reason: 'crawl_start',
  siteConfig: config,
  proxyUrl: 'http://easy_proxies:24000'
};

function pool(count) {
  return Array.from({ length: count }, (_, i) => ({
    tag: `N${i + 1}`,
    name: `节点${i + 1}`,
    port: 24000 + i,
    available: true,
    initial_check_done: true
  }));
}

function settledEvent(events) {
  const found = events.filter(e => e.event === 'proxy_pool_settled');
  assert.strictEqual(found.length, 1, `应恰好记录 1 条 proxy_pool_settled，实际 ${found.length}`);
  return found[0];
}

async function main() {
  // ---- (a) 池子从 2 涨到 5：等到收敛再返回，事件记下增长过程 ----
  {
    let nodeCalls = 0;
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功' }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 5, last_error: '', refresh_count: 1 }, status: 200 };
      }
      if (target.endsWith('/api/nodes')) {
        nodeCalls++;
        return { status: 200, data: { nodes: pool(nodeCalls === 1 ? 2 : 5) } };
      }
      throw new Error(`unexpected management URL: ${target}`);
    });
    const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          const ok = await provider.refreshProviders(refreshArgs);
          assert.strictEqual(ok, true, '刷新仍返回 true，收敛等待不改变布尔契约');
          const event = settledEvent(readEvents('ceb'));
          assert.strictEqual(event.before, 2, '首个采样点应是刷新刚返回时的半池');
          assert.strictEqual(event.after, 5, '收敛后应看到完整可用节点数');
          assert.strictEqual(event.nodeCount, 5, '事件带出订阅自报节点数，便于对照池子是否真的补齐');
          assert.strictEqual(nodeCalls, 2, '达到订阅节点数即停止采样，不做无谓轮询');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (b) 池子始终不补齐（节点真的不可用）：按静默次数收敛，不等到超时 ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功' }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 5, last_error: '', refresh_count: 1 }, status: 200 };
      }
      if (target.endsWith('/api/nodes')) return { status: 200, data: { nodes: pool(3) } };
      throw new Error(`unexpected management URL: ${target}`);
    });
    const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          await provider.refreshProviders(refreshArgs);
          const event = settledEvent(readEvents('ceb'));
          assert.strictEqual(event.before, 3);
          assert.strictEqual(event.after, 3, '池子不增长时如实记 3 → 3，不伪装成收敛到 5');
          assert.strictEqual(event.polls, 4, '首次采样 + 连续 3 次无新增即收敛');
          assert.ok(event.elapsedMs >= 2000, '静默收敛要走完采样间隔，不能零等待冒充');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (c) 管理面在采样中途不可达：刷新仍算成功，不留半截事件 ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功' }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 5, last_error: '', refresh_count: 1 }, status: 200 };
      }
      if (target.endsWith('/api/nodes')) {
        const error = new Error('connect ECONNREFUSED');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      throw new Error(`unexpected management URL: ${target}`);
    });
    const restoreController = setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091');
    try {
      await withTempCwd(async () => {
        freshCrawler();
        const provider = require('../sites/_easy_proxies');
        provider._resetRefreshCooldown();
        try {
          const ok = await provider.refreshProviders(refreshArgs);
          assert.strictEqual(ok, true, '采样失败不得把刷新判成失败');
          const events = readEvents('ceb');
          assert.strictEqual(events.filter(e => e.event === 'proxy_pool_settled').length, 0,
            '一个采样点都没拿到时不应写下 0 → 0 这种伪事件');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  console.log('刷新后节点池收敛等待：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
