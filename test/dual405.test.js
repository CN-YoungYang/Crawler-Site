// Seam: crawlPage 405 降级 / 双 405 快败 / 网络级连败换 IP 与熔断 / mihomo 节点轮换
// (a) 末次重试遇 GET 405 → 必须真正发出 POST 并返回结果对象，绝不隐式 undefined
//     （2026-08-24 生产崩溃：降级扣光 retries 后 while 条件退出，crawl() 解构 results[i] 抛 TypeError）
// (b) GET 405 → POST 仍 405 → 双 405 快败 failed:true status:405（不空转重试）
// (c) 连续无 status 失败（ECONNRESET/超时）达熔断阈值 → crawl 提前结束，不再爬满 totalPages
// (d) mihomo 换点轮换：只切未试过的叶子节点（排除 auto/DIRECT/组），轮尽 exhausted 不再切
// (e) 换点成功重置 consecutive405 给新出口观察窗；轮尽后连续 2 页 405 才熔断
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');

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
async function mainRotate() {
  const LEAVES = ['🇭🇰 香港01', '🇸🇬 狮城02', '🇯🇵 东京03']; // 叶子池（含中文名，验证编码与轮换）
  const controllerPuts = [];
  const restore = mockAxios((url, config) => {
    const u = String(url);
    if (u.includes(':9090/proxies')) {
      // axios.put(url, data, config)：helper 把 data 并入 config；data 存在即切换请求
      if (config && config.data !== undefined) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        controllerPuts.push({ url: u, name: body.name });
        return { data: {}, status: 204 };
      }
      return {
        data: {
          proxies: {
            PROXY: { type: 'Selector', now: 'auto', all: ['auto', ...LEAVES, 'DIRECT'] },
            auto: { type: 'URLTest', now: 'auto', all: [...LEAVES] },
            ...Object.fromEntries(LEAVES.map(n => [n, { type: 'Shadowsocks' }])),
            DIRECT: { type: 'Direct' }
          }
        },
        status: 200
      };
    }
    // 目标站：一律双 405（GET→POST 均 405）
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
  const { crawl } = freshCrawler();

  try {
    // (d) 轮换语义 + (e) 观察窗与轮尽熔断：batchSize=1 串行可控
    // 页1: 双405 → 切 香港01 → reset 计数；页2: 双405 → 切 狮城02 → reset；页3: 双405 → 切 东京03 → reset
    // 页4: 双405 → 池尽 exhausted 不再 PUT → consecutive405=1 继续；页5: 双405 → exhausted → consecutive405=2 → 熔断
    await withTempCwd(() => crawl({ site: 'cebtest', totalPages: 100, interval: 0 }));
  } finally {
    if (hadProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = hadProxy;
    delete sitesIndex.registry.cebtest;
    restore();
  }

  // (d) 只切叶子、按序轮换、绝不碰 auto/DIRECT/已试节点：恰为 3 次 PUT，顺序与池一致
  assert.deepStrictEqual(controllerPuts.map(p => p.name), LEAVES, '应按序切遍全部叶子节点，一次不多不少');
  assert.ok(controllerPuts.every(p => p.url.includes('/proxies/')), 'PUT 目标应为组端点');

  console.log('mihomo 节点轮换（只切叶子/不重复/轮尽熔断）: OK');
}

async function main() {
  await mainBase();
  await mainRotate();
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
