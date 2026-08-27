// Seam: crawlPage 405 降级 / 双 405 快败 / 网络级连败换 IP 与熔断 / mihomo 节点轮换
// (a) 末次重试遇 GET 405 → 必须真正发出 POST 并返回结果对象，绝不隐式 undefined
//     （2026-08-24 生产崩溃：降级扣光 retries 后 while 条件退出，crawl() 解构 results[i] 抛 TypeError）
// (b) GET 405 → POST 仍 405 → 双 405 快败 failed:true status:405（不空转重试）
// (c) 连续无 status 失败（ECONNRESET/超时）达熔断阈值 → crawl 提前结束，不再爬满 totalPages
// (d) mihomo 换点轮换：只切未试过的叶子节点（排除 auto/DIRECT/组），轮尽 exhausted 不再切
// (e) 换点成功重置 consecutive405 给新出口观察窗；轮尽后连续 2 页 405 才熔断
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, ROW_NEW } = require('./fixtures');

// 从 GET URL 的 query 或 POST 表单体提取页号（crawler 的 POST 降级把 query 放 data）
function pageOf(url, config) {
  const u = String(url);
  let m = /[?&]page=(\d+)/.exec(u);
  if (m) return parseInt(m[1], 10);
  const data = config && config.data;
  if (typeof data === 'string') {
    m = /[?&]page=(\d+)/.exec(data);
    if (m) return parseInt(m[1], 10);
  }
  return NaN;
}

async function mainBase() {
  // ---- (a) 前两次超时耗尽重试额度，第三次 GET 405 触发降级：POST 必须真发出去 ----
  {
    const seen = [];
    let calls = 0;
    const restore = mockAxios((url, config) => {
      calls++;
      const method = (config && config.data !== undefined) ? 'POST' : 'GET';
      if (method === 'GET') {
        seen.push('GET');
        if (seen.filter(m => m === 'GET').length <= 2) {
          // 前两次：超时类网络错误（无 response）
          const err = new Error('timeout of 30000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        // 第三次 GET：405
        const err405 = new Error('Request failed with status code 405');
        err405.response = { status: 405, data: '<html>waf</html>' };
        throw err405;
      }
      seen.push('POST');
      // 降级 POST 返回空表格页：模拟 WAF 放行后的正常响应
      return { data: '<table id="treeTable"><tbody></tbody></table>', status: 200 };
    });
    const { crawlPage } = freshCrawler();
    // buildUrl 带 query：crawler 的 POST 分支在无 query 时回退 GET 语义（见 crawler.js），mock 需借 data 字段区分方法
    const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
    const res = await withTempCwd(() => crawlPage(23, siteConfig, new Set(), 3));
    restore();
    assert.ok(res && typeof res === 'object', '返回值必须是结果对象，不能是 undefined');
    assert.strictEqual(res.failed, false, '降级 POST 成功后不算失败');
    assert.strictEqual(seen.filter(m => m === 'GET').length, 3, 'GET 应发出 3 次（2 超时 + 1 次 405）');
    assert.strictEqual(seen.filter(m => m === 'POST').length, 1, '降级 POST 必须真正发出（原 bug 在此被吞掉）');
  }

  // ---- (b) GET 405 → POST 仍 405：双 405 快败 ----
  {
    let getCalls = 0, postCalls = 0;
    const restore = mockAxios((url, config) => {
      const method = (config && config.data !== undefined) ? 'POST' : 'GET';
      if (method === 'POST') { postCalls++; }
      else { getCalls++; }
      const err = new Error('Request failed with status code 405');
      err.response = { status: 405, data: '<html>blocked</html>' };
      throw err;
    });
    const { crawlPage } = freshCrawler();
    const siteConfig = { name: 'cebtest', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` };
    const res = await withTempCwd(() => crawlPage(1, siteConfig, new Set(), 3));
    restore();
    assert.strictEqual(getCalls, 1, 'GET 仅一次');
    assert.strictEqual(postCalls, 1, 'POST 仅一次（快败不重试）');
    assert.strictEqual(res.failed, true, '双 405 应标记失败');
    assert.strictEqual(res.status, 405, 'status 应为 405（供 crawl 熔断计数）');
    assert.strictEqual(res.pageData.length, 0);
  }

  // ---- (c) 网络级连败熔断：无 status 的失败达 NET_FAIL_BREAK_THRESHOLD 即提前结束 ----
  {
    let calls = 0;
    // 顺序必须 mockAxios 先于 freshCrawler：crawler 顶层钉死 axios 引用，需在 mock 就位后重载捕获
    const restore = mockAxios(() => {
      calls++;
      const err = new Error('Client network socket disconnected before secure TLS connection was established');
      err.code = 'ECONNRESET';
      throw err;
    });
    const { crawl, NET_FAIL_BREAK_THRESHOLD } = freshCrawler();
    await withTempCwd(() => crawl({ site: 'yfbzb', totalPages: 100, interval: 0 }));
    restore();
    // batchSize=10：首批 10 页全网络失败 → netFailStreak=2 换 IP（直连站 no-op）→ 第二批再失败 → streak=4
    // 第三批后 streak≥6 熔断；若不熔断会爬满 100 页（1000 次调用）
    assert.strictEqual(calls, NET_FAIL_BREAK_THRESHOLD * 10, `应恰好在 ${NET_FAIL_BREAK_THRESHOLD} 页 × batchSize(10) 时熔断`);
  }

  console.log('crawlPage 405 降级/双 405 快败/网络连败熔断: OK');
}

// ---- (d)(e) mihomo 节点轮换语义（2026-08-25 生产教训回归锁）----
// (d) 双 405 触发换点必须轮换取「未试过的叶子节点」，绝不切回 auto/已试节点；
//     全池试尽后 proxyExhausted，且不再重复切换；成功页清空轮换记忆。
// (e) 换点成功重置 consecutive405 给新出口观察窗，轮尽后连续 2 页 405 才熔断。
// (f) 2026-08-26 审查回归锁：mock now 反映 PUT 生效（#10）、断言精确组端点与
//     控制器请求次数（#9）、轮尽后零控制器请求（#7 短路）、换点只废本站 Agent
//     缓存条目不碰兄弟站（#1）。
async function mainRotate() {
  const LEAVES = ['🇭🇰 香港01', '🇸🇬 狮城02', '🇯🇵 东京03']; // 叶子池（含中文名，验证编码与轮换）
  let controllerGets = 0;
  const controllerPuts = [];
  // now 维护为真实状态：初始 auto，每次 PUT 后指向被切节点——依赖「排除当前出口」
  // 语义的回归在此可被捕获（原 mock now 恒 'auto' 掩盖 n !== now 回归，审查 #10）
  let groupNow = 'auto';
  const groupSnapshot = () => ({ type: 'Selector', now: groupNow, all: ['auto', ...LEAVES, 'DIRECT'] });
  const restore = mockAxios((url, config) => {
    const u = String(url);
    if (u.includes(':9090/proxies')) {
      // axios.put(url, data, config)：helper 把 data 并入 config；data 存在即切换请求
      if (config && config.data !== undefined) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        controllerPuts.push({ url: u, name: body.name });
        groupNow = body.name;
        return { data: {}, status: 204 };
      }
      controllerGets++;
      // 单组端点 /proxies/{group} 返回组对象本体（mihomo 真实形态），全量端点才包 proxies
      if (/\/proxies\/[^/]+$/.test(u)) return { data: { name: 'PROXY', ...groupSnapshot() }, status: 200 };
      return {
        data: {
          proxies: {
            PROXY: groupSnapshot(),
            auto: { type: 'URLTest', now: 'auto', all: [...LEAVES] },
            ...Object.fromEntries(LEAVES.map(n => [n, { type: 'Shadowsocks' }])),
            DIRECT: { type: 'Direct' }
          }
        },
        status: 200
      };
    }
    // 目标站：第 1 页成功返回数据（第一页探针通过、爬虫继续），页 ≥2 一律双 405
    // → 在后续页验证换点轮换/轮尽短路/连续 405 熔断（若页1也 405，探针会先轮尽并取消抓取，轮换语义仍可断言但熔断路径失测）
    if (pageOf(url, config) === 1) return { data: pageHtml([ROW_NEW]), status: 200 };
    const err = new Error('Request failed with status code 405');
    err.response = { status: 405, data: '<html>waf</html>' };
    throw err;
  });
  // crawl() 经 getSiteConfig 校验站点名，测试站点注入注册表（与 require.cache mock 同思路）
  const sitesIndex = require('../sites');
  sitesIndex.registry.cebtest = {
    name: 'cebtest',
    displayName: '轮换测试',
    baseUrl: 'http://x/',
    urlSuffix: '',
    fallbackOn405: true,
    batchSize: 1,
    buildUrl: pageNo => `http://x/bulletin?page=${pageNo}`
  };
  // trySwitchProxy 需解析到 mihomo 形态的代理地址才会走控制器切点
  const hadProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://mihomo:7890';
  const { crawl, getProxyAgents } = freshCrawler();

  try {
    // (d) 轮换语义 + (e) 观察窗与轮尽熔断：batchSize=1 串行可控
    // 页1: 成功返回数据（探针通过、清空轮换记忆与叶子快照）；
    // 页2: 双405 → 切 香港01 → 重试仍 405 → 切 狮城02（triedSwitch 限一次，返回 failed+proxySwitched）→ reset 计数
    // 页3: 双405 → 切 东京03 → 重试仍 405 → 池尽 exhausted 不再 PUT → consecutive405=1
    // 页4: 双405 → exhausted → consecutive405=2 → 熔断
    await withTempCwd(() => crawl({ site: 'cebtest', totalPages: 100, interval: 0 }));
  } finally {
    if (hadProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = hadProxy;
    delete sitesIndex.registry.cebtest;
    restore();
  }

  // (d) 只切叶子、按序轮换、绝不碰 auto/DIRECT/已试节点：恰为 3 次 PUT，顺序与池一致
  assert.deepStrictEqual(controllerPuts.map(p => p.name), LEAVES, '应按序切遍全部叶子节点，一次不多不少');
  // (f/#9) 端点精确断言：PUT 必须打到 /proxies/{组名}（encodeURIComponent 后仍含组名），
  // 而非「URL 含 :9090/proxies 即过」的恒真判断
  for (const p of controllerPuts) {
    assert.ok(p.url.endsWith(`:${'9090'}/proxies/${encodeURIComponent('PROXY')}`), `PUT 应打组端点 /proxies/PROXY，实际 ${p.url}`);
  }
  // (f/#7) 轮尽短路：页4/页5 已试遍快照，不应再打控制器 GET（首轮 1 次 GET + 换点期缓存单组端点）
  // 精确次数随缓存路径浮动（首轮 fresh 发现 1 次 + 页2/页3 走 cached 单组端点），只锁上限：
  // 若无短路，每个失败页至少一次控制器 GET，5 页双 405 场景会 ≥5 次
  assert.ok(controllerGets <= 3, `轮尽后失败页应零控制器请求（实际 GET ${controllerGets} 次）`);

  // (f/#1) 换点 destroy 只清本站缓存条目：模拟兄弟站共用同一 proxyUrl 的独立隧道
  {
    // mockAxios 已 restore，需先恢复真实 axios 再重载 crawler（_mihomo 顶层 require axios）
    const { freshCrawler: fresh2 } = require('./helper');
    const c = fresh2();
    if (!c.getProxyAgents._cache) c.getProxyAgents._cache = new Map();
    c.getProxyAgents._cache.set('yfbzb|http://mihomo:7890', { proxyUrl: 'http://mihomo:7890', httpAgent: { destroyed: false, destroy() { this.destroyed = true; } }, httpsAgent: { destroyed: false, destroy() { this.destroyed = true; } } });
    c.getProxyAgents._cache.set('cebtest|http://mihomo:7890', { proxyUrl: 'http://mihomo:7890', httpAgent: { destroyed: false, destroy() { this.destroyed = true; } }, httpsAgent: { destroyed: false, destroy() { this.destroyed = true; } } });
    const swCfg = { name: 'cebtest', proxy: 'http://mihomo:7890', switchProxy: async () => ({ switched: true, from: 'a', to: 'b', tried: ['b'], groupName: 'PROXY', leaves: ['a', 'b'] }) };
    const out = await c.trySwitchProxy(swCfg, 'dual405');
    assert.strictEqual(out.ok, true, 'provider 返回 switched 时 ok=true');
    assert.strictEqual(c.getProxyAgents._cache.has('cebtest|http://mihomo:7890'), false, '本站缓存条目应被销毁移除');
    assert.strictEqual(c.getProxyAgents._cache.get('yfbzb|http://mihomo:7890').httpAgent.destroyed, false, '兄弟站 Agent 不得被本站换点破坏（审查 #1）');
  }

  // (f/#3) 同站并发换点互斥：batchSize>1 时同批多个双 405 页同时进 trySwitchProxy，
  // 读改写交错会重复选同一节点、tried 重复记账——串行化后每页拿到不同节点
  {
    let controllerCalls = 0;
    const putNames = [];
    // mockAxios 必须先于 freshCrawler：crawler/_mihomo 顶层钉死 axios 引用（见 mainBase (c) 注释）
    const restore3 = mockAxios((url, config) => {
      const u = String(url);
      if (u.includes(':9090/proxies')) {
        if (config && config.data !== undefined) {
          // 模拟真实控制器延迟，放大并发窗口
          return new Promise(resolve => setTimeout(() => {
            const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
            putNames.push(body.name);
            resolve({ data: {}, status: 204 });
          }, 10));
        }
        controllerCalls++;
        return Promise.resolve({
          data: {
            proxies: {
              PROXY: { type: 'Selector', now: 'auto', all: ['auto', 'N1', 'N2', 'N3', 'DIRECT'] },
              auto: { type: 'URLTest', now: 'auto', all: ['N1', 'N2', 'N3'] },
              N1: { type: 'Shadowsocks' }, N2: { type: 'Shadowsocks' }, N3: { type: 'Shadowsocks' },
              DIRECT: { type: 'Direct' }
            }
          },
          status: 200
        });
      }
      const err = new Error('x'); err.response = { status: 500, data: '' }; throw err;
    });
    try {
      const c = freshCrawler();
      const cfg = { name: 'cebtest2', proxy: 'http://mihomo:7890' };
      // 模拟同批 3 页双 405 并发换点
      const outs = await Promise.all([
        c.trySwitchProxy(cfg, 'dual405'),
        c.trySwitchProxy(cfg, 'dual405'),
        c.trySwitchProxy(cfg, 'dual405')
      ]);
      assert.deepStrictEqual(putNames.sort(), ['N1', 'N2', 'N3'], `并发换点应串行分派不同节点，实际 [${putNames.join(', ')}]`);
      assert.ok(outs.every(o => o.ok === true), '三个并发换点都应成功');
    } finally {
      restore3();
      delete sitesIndex.registry.cebtest2;
    }
  }

  console.log('mihomo 节点轮换（只切叶子/不重复/轮尽熔断/端点精确/跨站隔离/并发互斥）: OK');
}

// ---- (g) 第一页探针（2026-08-27）：当前出口不行就一路换点，直到成功或节点池轮尽（轮尽即取消本次抓取）----
// (g1) 网络失败一路换点直到某节点成功：页1 在 auto/N1/N2 上各重试 3 次后换点，N3 成功
// (g2) 全池轮尽：页1 在所有节点上均网络失败 → crawlPage 返回 gateAbort
// (g3) crawl 层面：页1 轮尽 → 取消本次抓取，不再爬页 2+（回归 2026-08-27 日志：页1-5 全败仍硬爬到页6）
// (g4) 双 405 轮尽：页1 在所有节点上均被 WAF 拦（GET→POST 均 405）→ 同样 gateAbort
async function mainGate() {
  const LEAVES = ['N1', 'N2', 'N3'];
  // 组装一套「控制器轮换 mock + mihomo 代理 env」探针夹具；订阅刷新 PUT（/providers/…）不计入目标站调用
  function makeHarness(targetHandler) {
    const st = { puts: [], gets: 0, targetCalls: 0 };
    let groupNow = 'auto';
    const restore = mockAxios((url, config) => {
      const u = String(url);
      if (u.includes(':9090/proxies')) {
        if (config && config.data !== undefined) {
          const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
          st.puts.push(body.name);
          groupNow = body.name;
          return { data: {}, status: 204 };
        }
        st.gets++;
        if (/\/proxies\/[^/]+$/.test(u)) {
          return { data: { name: 'PROXY', type: 'Selector', now: groupNow, all: ['auto', ...LEAVES, 'DIRECT'] }, status: 200 };
        }
        return {
          data: {
            proxies: {
              PROXY: { type: 'Selector', now: groupNow, all: ['auto', ...LEAVES, 'DIRECT'] },
              auto: { type: 'URLTest', now: 'auto', all: [...LEAVES] },
              ...Object.fromEntries(LEAVES.map(n => [n, { type: 'Shadowsocks' }])),
              DIRECT: { type: 'Direct' }
            }
          },
          status: 200
        };
      }
      // 订阅刷新 PUT（/providers/…）模拟控制器接受，不当作目标站请求
      if (u.includes('/providers/')) return { data: {}, status: 204 };
      st.targetCalls++;
      return targetHandler(groupNow, url, config);
    });
    const hadProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://mihomo:7890';
    const crawler = freshCrawler();
    return {
      st,
      crawler,
      cfg: { name: 'cebtest', proxy: 'http://mihomo:7890', baseUrl: 'http://x/', urlSuffix: '', fallbackOn405: true, batchSize: 1, buildUrl: pageNo => `http://x/bulletin?page=${pageNo}` },
      done: () => {
        restore();
        if (hadProxy === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = hadProxy;
      }
    };
  }
  const netErr = () => {
    const err = new Error('Client network socket disconnected before secure TLS connection was established');
    err.code = 'ECONNRESET';
    throw err;
  };

  // (g1) 一路换点直到成功：auto/N1/N2 网络失败（各 3 次重试），N3 成功
  {
    const h = makeHarness(now => {
      if (now === 'N3') return { data: pageHtml([ROW_NEW]), status: 200 };
      netErr();
    });
    const res = await withTempCwd(() => h.crawler.crawlPage(1, h.cfg, new Set(), 3));
    h.done();
    assert.strictEqual(res.failed, false, 'N3 成功后不算失败');
    assert.strictEqual(res.pageData.length, 1, '页1 应解析出 1 条数据');
    assert.deepStrictEqual(h.st.puts, LEAVES, '应依次切 N1→N2→N3，一次不多不少');
    assert.strictEqual(h.st.targetCalls, 10, 'auto/N1/N2 各 3 次重试 + N3 成功 1 次 = 10');
  }

  // (g2) 全池轮尽 → gateAbort：所有节点均网络失败，crawlPage 返回 gateAbort
  {
    const h = makeHarness(() => netErr());
    const res = await withTempCwd(() => h.crawler.crawlPage(1, h.cfg, new Set(), 3));
    h.done();
    assert.strictEqual(res.failed, true, '全池失败应标记失败');
    assert.strictEqual(res.gateAbort, true, '轮尽后应置 gateAbort 供 crawl 取消');
    assert.deepStrictEqual(h.st.puts, LEAVES, '应切遍全部叶子');
    assert.strictEqual(h.st.targetCalls, 12, 'auto+N1+N2+N3 各 3 次重试 = 12');
  }

  // (g3) crawl 层面：页1 轮尽 → 取消本次抓取，不再爬页 2+
  {
    const sitesIndex = require('../sites');
    sitesIndex.registry.cebtest = {
      name: 'cebtest',
      displayName: '探针测试',
      baseUrl: 'http://x/',
      urlSuffix: '',
      fallbackOn405: true,
      batchSize: 1,
      buildUrl: pageNo => `http://x/bulletin?page=${pageNo}`
    };
    const h = makeHarness(() => netErr());
    try {
      await withTempCwd(() => h.crawler.crawl({ site: 'cebtest', totalPages: 100, interval: 0 }));
    } finally {
      h.done();
      delete sitesIndex.registry.cebtest;
    }
    assert.strictEqual(h.st.targetCalls, 12, '只发页1（4 节点 × 3 重试），不应发页 2+');
    assert.deepStrictEqual(h.st.puts, LEAVES, '轮换记忆按序耗尽');
  }

  // (g4) 双 405 轮尽 → gateAbort：所有节点均被 WAF 拦
  {
    const h = makeHarness(() => {
      const err = new Error('Request failed with status code 405');
      err.response = { status: 405, data: '<html>waf</html>' };
      throw err;
    });
    const res = await withTempCwd(() => h.crawler.crawlPage(1, h.cfg, new Set(), 3));
    h.done();
    assert.strictEqual(res.failed, true, '全池 405 应标记失败');
    assert.strictEqual(res.gateAbort, true, '双 405 轮尽也应 gateAbort');
    assert.strictEqual(res.status, 405, 'status 保留 405 供 crawl 判断');
    assert.deepStrictEqual(h.st.puts, LEAVES, '双 405 也应切遍全部叶子');
    assert.strictEqual(h.st.targetCalls, 5, 'GET 1 次 + POST 4 次（N1/N2/N3 切换后各 1 次）');
  }

  console.log('第一页探针（一路换点/轮尽取消抓取）: OK');
}

async function main() {
  await mainBase();
  await mainRotate();
  await mainGate();
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
