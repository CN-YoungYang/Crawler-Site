// 回归：陈旧快照换点必须显式标注（stale），不得伪装成「换点成功」。
//
// 背景：easy_proxies 提供方在管理面不可达时会退用上一轮节点快照（零请求短路），
// 此时仍会打印「已切换节点」并换端口号——但出口可用性完全未经确认。
// 该形态与真实换点在日志上几乎一致，会掩盖「管理面其实早已不可达」这一故障。
//
// 本用例锁定提供方契约：switchNode 必须回报 source（'api' | 'snapshot'），
// 供调用方把 stale 透出到日志与 context。
//
// 接缝：sites/_easy_proxies.js#switchNode 的返回值（提供方与编排层之间的契约）。
const assert = require('assert');
const { mockAxios, freshCrawler } = require('./helper');

const NODES = [
  { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
  { tag: 'N2', name: '节点二', port: 24001, available: true, initial_check_done: true },
  { tag: 'N3', name: '节点三', port: 24002, available: true, initial_check_done: true }
];

function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function main() {
  // 管理 API 始终不可达，逼出「退用快照」这条路径。
  let apiCalls = 0;
  const restoreAxios = mockAxios(url => {
    const target = String(url);
    if (target.endsWith('/api/nodes')) {
      apiCalls++;
      const error = new Error('management unavailable');
      error.response = { status: 503, data: {} };
      throw error;
    }
    throw new Error('unexpected ' + target);
  });
  const restores = [
    setEnv('EASY_PROXIES_CONTROLLER', 'http://controller.test:9091'),
    setEnv('EASY_PROXIES_PASSWORD', undefined)
  ];

  try {
    // 必须先 freshCrawler()：_easy_proxies.js 顶层 require('axios') 把引用钉在闭包里，
    // 仅 mockAxios 换 cache 项动不了已加载的模块。
    freshCrawler();
    const easy = require('../sites/_easy_proxies');
    easy._resetRefreshCooldown();
    const config = { name: 'ceb', easyProxiesController: 'http://controller.test:9091' };
    const proxyUrl = 'http://easy_proxies:24000';

    // ---- (a) 无 cached：必须真查管理 API，失败即 noop ----
    {
      apiCalls = 0;
      const out = await easy.switchNode(config, { reason: 'test', proxyUrl, tried: [] });
      assert.strictEqual(out.noop, true, '管理面不可达且无快照时应 noop（安全降级）');
      assert.ok(apiCalls > 0, '无快照时必须真的尝试查询管理 API');
    }

    // ---- (b) 有 cached：跳过 API，且必须标注 source='snapshot' ----
    {
      apiCalls = 0;
      const cached = { nodes: NODES.map(n => ({ ...n })), controller: 'http://controller.test:9091' };
      const out = await easy.switchNode(config, { reason: 'test', proxyUrl, tried: [], cached });
      assert.strictEqual(apiCalls, 0, '有快照时应零请求短路（不查管理 API）');
      assert.strictEqual(out.switched, true, '有快照时应能切换');
      assert.strictEqual(
        out.source, 'snapshot',
        '退用快照时 switchNode 必须回报 source=snapshot，供调用方标注 stale；' +
        '缺失该字段会使陈旧快照与真实换点在日志上不可区分'
      );
    }
    // ---- (c) 真查 API 成功：source='api' ----
    // 需要换 mock，故重新 mockAxios + freshCrawler 让模块重新捕获 axios。
    {
      const restoreOk = mockAxios(url => {
        const target = String(url);
        if (target.endsWith('/api/nodes')) return { data: { nodes: NODES.map(n => ({ ...n })) }, status: 200 };
        throw new Error('unexpected ' + target);
      });
      try {
        freshCrawler();
        const easyOk = require('../sites/_easy_proxies');
        easyOk._resetRefreshCooldown();
        const out = await easyOk.switchNode(config, { reason: 'test', proxyUrl, tried: [] });
        assert.strictEqual(out.switched, true, '管理面可用时应切换成功');
        assert.strictEqual(out.source, 'api', '真实查询成功时应回报 source=api（非 stale）');
      } finally {
        restoreOk();
      }
    }

    // ---- (d) 轮尽路径同样带 source ----
    {
      const cached = { nodes: NODES.map(n => ({ ...n })), controller: '' };
      const allTried = NODES.map(n => n.tag);
      const out = await easy.switchNode(config, { reason: 'test', proxyUrl, tried: allTried, cached });
      assert.strictEqual(out.exhausted, true, '全部试过应轮尽');
      assert.strictEqual(out.source, 'snapshot', '轮尽路径也必须回报 source，否则调用方无法标注');
    }

    console.log('陈旧快照换点标注（source=snapshot）：通过');
  } finally {
    restoreAxios();
    restores.reverse().forEach(fn => fn());
  }
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
