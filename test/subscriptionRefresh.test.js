// 回归：订阅刷新必须报告「实际拿到多少节点」，而不只是「HTTP 200」。
//
// 守卫的真实事故（2026-10-27 生产日志）：16 轮全部记录「已触发 easy_proxies 订阅刷新」，
// 但 easy_proxies 在「订阅拉取失败 → 回退旧缓存」时同样返回 200（见其
// internal/config/config.go 的 shouldUseCachedSubscriptionNodes），
// 于是刷新一直「成功」，节点列表却从未更新，整池 29 个节点过期后全部超时，
// ceb 连续 15 轮 0 条而日志里没有任何异常。
//
// 接缝：refreshProviders(...) 的返回值（布尔契约不变）+ logs/<site>/*.jsonl 的
// proxy_provider_refresh 事件（本项目对外承诺的可 grep 观测面）。
// 期望值来自独立真相源：easy_proxies 的 /api/subscription/status 字段语义
// （node_count / last_error / refresh_count），不是照抄实现。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mockAxios, freshCrawler, withTempCwd, setEnv, readEvents } = require('./helper');

function refreshEvent(events) {
  const found = events.filter(e => e.event === 'proxy_provider_refresh');
  assert.strictEqual(found.length, 1, `应恰好记录 1 条 proxy_provider_refresh，实际 ${found.length}`);
  return found[0];
}

async function run() {
  const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };
  const refreshArgs = { site: 'ceb', reason: 'crawl_start', siteConfig: config, proxyUrl: 'http://easy_proxies:24000' };

  // ---- (a) 刷新返回 200 但节点数为 0（订阅失效回退缓存）→ 必须记为 warn 并带上 0 ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功', node_count: 0 }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 0, last_error: 'no nodes fetched from subscriptions', refresh_count: 3 }, status: 200 };
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
          assert.strictEqual(ok, true, '刷新接口返回 200 时仍应返回 true（契约不变，由调用方按布尔判断）');
          const event = refreshEvent(readEvents('ceb'));
          assert.strictEqual(event.level, 'warn', '节点数为 0 的「成功」刷新必须降级为 warn，否则线上永远看不见');
          assert.strictEqual(event.nodeCount, 0, '事件必须携带实际节点数，便于 grep 判断刷新是否真的换了节点');
          assert.strictEqual(event.lastError, 'no nodes fetched from subscriptions', '事件必须带出订阅侧错误，这是唯一的失败线索');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (b) 正常刷新（节点数 > 0）→ info 且带节点数 ----
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功', node_count: 12 }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 12, last_error: '', refresh_count: 1 }, status: 200 };
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
          assert.strictEqual(ok, true);
          const event = refreshEvent(readEvents('ceb'));
          assert.strictEqual(event.level, 'info', '拿到节点时保持 info，不制造噪声');
          assert.strictEqual(event.nodeCount, 12);
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (b2) 节点数 > 0 但订阅侧有错误 → 必须 warn ----
  // 这正是本次事故的形态：easy_proxies 拉订阅失败后回退旧缓存，
  // 缓存里仍有节点（node_count > 0），只有 last_error 露出真相。
  // 只看 node_count 会把「正在用过期节点」记成 info，而整池过期正是 ceb 连续 15 轮 0 条的起因。
  {
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功', node_count: 12 }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 12, last_error: 'subscription A fetch failed; using cached nodes', refresh_count: 1 }, status: 200 };
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
          await provider.refreshProviders(refreshArgs);
          const event = refreshEvent(readEvents('ceb'));
          assert.strictEqual(event.level, 'warn', '订阅侧报错（即便仍有缓存节点）必须 warn，否则「用着过期节点」永远看不见');
          assert.strictEqual(event.nodeCount, 12, '节点数照实记录，便于区分「空池」与「用了缓存」');
          assert.strictEqual(event.lastError, 'subscription A fetch failed; using cached nodes');
          assert.strictEqual(event.refreshCount, 1, '刷新计数一并透出，便于对照 easy_proxies 侧是否真的在跑');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (c) 状态接口不可达不得影响刷新结果（旧版本/半死状态的管理面）----
  {
    let refreshCalls = 0;
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) {
        refreshCalls++;
        return { data: { message: '刷新成功' }, status: 200 };
      }
      if (target.endsWith('/api/subscription/status')) {
        const error = new Error('status unavailable');
        error.response = { status: 404 };
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
          assert.strictEqual(ok, true, '状态接口不可达不得让刷新被判为失败');
          assert.strictEqual(refreshCalls, 1, '刷新只发一次，状态查询失败不应触发重发');
          const event = refreshEvent(readEvents('ceb'));
          assert.strictEqual(event.level, 'info', '拿不到状态时按既有的「已触发」语义处理，保持 info');
          assert.strictEqual(event.nodeCount, undefined, '拿不到状态时不伪造节点数');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (d) 订阅错误文本内嵌订阅 URL（含密钥）→ 日志必须脱敏 ----
  // AGENTS.md「不记录订阅地址、密码或节点 IP」是硬约束；上游错误信息常带完整订阅 URL。
  {
    // 必须用假地址：拿真实订阅域名做夹具本身就会把订阅地址写进仓库
    const subKey = 'fakeSubKey42';
    const secretUrl = `https://sub.example.test/secret-feed/clash_fast.yaml?token=${subKey}`;
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功', node_count: 0 }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return { data: { enabled: true, node_count: 0, last_error: `fetch ${secretUrl}: 403 Forbidden`, refresh_count: 1 }, status: 200 };
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
          await provider.refreshProviders(refreshArgs);
          const event = refreshEvent(readEvents('ceb'));
          const serialized = JSON.stringify(event);
          assert.ok(!serialized.includes(subKey), '订阅密钥不得出现在日志里');
          assert.ok(!serialized.includes('/secret-feed/'), '订阅路径不得出现在日志里');
          assert.ok(!serialized.includes('sub.example.test'), '订阅主机不得出现在日志里');
          assert.ok(String(event.lastError).includes('403'), '脱敏后仍应保留可诊断的错误语义');
          const consoleOutput = fs.readFileSync(path.join(process.cwd(), 'logs', 'ceb', fs.readdirSync(path.join(process.cwd(), 'logs', 'ceb'))[0]), 'utf8');
          assert.ok(!consoleOutput.includes(subKey), '控制台通道同样不得泄露密钥');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  // ---- (e) 订阅错误里带节点 IP / 端口 → 日志同样不得出现 ----
  // last_error 是上游自由文本，实测形态是「dial tcp <节点IP>:<端口>: i/o timeout」。
  // AGENTS.md 禁止记录节点 IP，这条与订阅地址同等硬。
  {
    const nodeIp = '203.0.113.77';
    const restoreAxios = mockAxios((url) => {
      const target = String(url);
      if (target.endsWith('/api/subscription/refresh')) return { data: { message: '刷新成功', node_count: 5 }, status: 200 };
      if (target.endsWith('/api/subscription/status')) {
        return {
          data: {
            enabled: true,
            node_count: 5,
            last_error: `dial tcp ${nodeIp}:443: i/o timeout; keeping current nodes`,
            refresh_count: 2
          },
          status: 200
        };
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
          await provider.refreshProviders(refreshArgs);
          const event = refreshEvent(readEvents('ceb'));
          assert.ok(!JSON.stringify(event).includes(nodeIp), '节点 IP 不得出现在日志里');
          assert.ok(String(event.lastError).includes('i/o timeout'), '脱敏后仍应保留错误类型');
        } finally {
          provider._resetRefreshCooldown();
        }
      });
    } finally {
      restoreController();
      restoreAxios();
    }
  }

  console.log('订阅刷新可观测性（节点数/订阅错误透出）：通过');
}

run().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
