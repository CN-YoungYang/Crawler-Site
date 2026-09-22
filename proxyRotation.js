// 换点状态机（proxy rotation）——把原先散落在 crawler.js 的五个模块级可变 Map
// 收敛为一个与「一轮 crawl()」同生命周期的深模块。
//
// 收敛前的病灶（crawler.js 历史注释「审查 #1/#2/#3」）：
// - 五个 Map（_proxyRotate / _proxySwitchQueue / _leafCache / _cache / _proxySharedExit）
//   分散在模块顶层，谁负责清无法从任何接口看出来；
// - 清理点重复出现在 crawl() 开头、批次循环内、trySwitchProxy 成功分支三处，
//   且各清各的子集；
// - 键从「两个不同源对象」求值（siteConfig.name 与 crawl() 的 site 参数），
//   靠约定而非不变量维持一致，已致过「永久残留 → 静默 exhausted」的线上缺陷。
//
// 深化后：接口只有 switch / reset / dispose / currentProxyUrl，
// 记账、互斥、快照、隧道销毁全部成为实现的内部 seam。
//
// 注意：跨站点的共用出口登记（原 _proxySharedExit）**不在此模块内**——它的键是
// 代理 URL、值是站点集合，本质是进程级跨站点状态，不属于单站每轮实例。

const { log } = require('./log');
const { normalizeSite } = require('./sites');

// 站点键的单一来源：统一走 normalizeSite 后再小写，消除「name 与参数两个源」。
function rotationKey(site) {
  return String(normalizeSite(site) || '').trim().toLowerCase();
}

function makeSwitchResult(overrides) {
  return { ok: false, from: '', to: '', exhausted: false, ...overrides };
}

function desensitizeProxyUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const hasAuth = !!(u.username || u.password);
    const hasQuery = !!u.search;
    const hasHash = !!u.hash;
    if (hasAuth || hasQuery || hasHash) {
      const auth = hasAuth ? '***:***@' : '';
      const q = hasQuery ? '?***' : '';
      const h = hasHash ? '#***' : '';
      return `${u.protocol}//${auth}${u.host}${u.pathname}${q}${h}`;
    }
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch (_) { return url.replace(/:\/\/[^@]+@/, '://***:***@').replace(/\?.*$/, '?***').replace(/#.*$/, '#***'); }
}

// 代理 Agent 缓存：进程级、跨轮复用（复用 keepAlive 隧道避免 socket 泄漏）。
// 键含站点：全局 HTTP_PROXY 配法下多站解析出同一 proxyUrl，若共用条目，
// 一站换点 destroy 会打断兄弟站在途请求（审查 #1）——各站独立隧道。
const agentCache = new Map();

// 隧道销毁：只清本站条目（审查 #1）。
// 键前缀统一由 rotationKey 求得，避免与记账键不同源导致「静默不清」（原 crawler.js:143
// 未包 normalizeSite，空 name 时键为 ''，与记账键 'yfbzb' 不一致，清扫变空操作）。
function destroySiteAgents(key) {
  for (const [cacheKey, entry] of agentCache) {
    if (!cacheKey.startsWith(`${key}|`)) continue;
    try { entry.httpAgent.destroy(); } catch (_) {}
    try { entry.httpsAgent.destroy(); } catch (_) {}
    agentCache.delete(cacheKey);
  }
}

function getProxyAgentEntry(key, proxyUrl, agentFactory) {
  const cacheKey = `${key}|${proxyUrl}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;
  const entry = agentFactory(proxyUrl);
  if (!entry) return null;
  agentCache.set(cacheKey, entry);
  return entry;
}

// 一轮 crawl() 的换点状态机。
// site      —— 站点名（唯一键来源，不再读 siteConfig.name）
// siteConfig—— 站点策略对象，仅用于读取 proxy / proxyProvider / switchProxy 等策略字段
function createRotation(site, siteConfig, deps = {}) {
  const key = rotationKey(site);
  // 本轮已试节点 tag（原 _proxyRotate）
  let tried = [];
  // 节点快照，轮尽后可零请求短路（原 _leafCache）
  let leafSnapshot = null;
  // 同站换点互斥链（原 _proxySwitchQueue）。作用域收窄到「本轮」：
  // 原先按站点全局互斥会让不同轮互相排队，而不同轮本就不该互斥（审查 #3 的真实意图
  // 是「同一批内多个双 405 页并发进入时不重复选点」）。
  let queue = Promise.resolve();
  const logFn = deps.log || log;
  const resolveProxyUrl = deps.resolveProxyUrl;
  const getProxyProvider = deps.getProxyProvider;
  const buildAgentEntry = deps.buildAgentEntry;

  function withLock(fn) {
    const next = queue.catch(() => {}).then(fn);
    queue = next.catch(() => {});
    return next;
  }

  function reset() {
    tried = [];
    leafSnapshot = null;
  }

  function dispose() {
    reset();
    destroySiteAgents(key);
  }

  // 本轮生效的代理地址：换点成功后被覆写，是本实例唯一的状态出口。
  // 原先它被写回共享的 siteConfig.runtimeProxyUrl（registry 单例），
  // 使「每轮可变状态」寄居在跨轮共享对象上；改为实例字段后随实例同生共死。
  let activeProxyUrl = null;

  function currentProxyUrl() {
    if (activeProxyUrl) return activeProxyUrl;
    return resolveProxyUrl ? resolveProxyUrl(siteConfig) : '';
  }

  async function doSwitch(reason) {
    const proxyUrl = currentProxyUrl();
    if (!proxyUrl) return makeSwitchResult();
    const provider = getProxyProvider ? getProxyProvider(siteConfig, proxyUrl) : null;
    const switcher = (siteConfig && typeof siteConfig.switchProxy === 'function')
      ? siteConfig.switchProxy
      : provider && provider.switchNode;
    if (typeof switcher !== 'function') return makeSwitchResult();

    let out;
    try {
      out = await switcher.call(siteConfig, siteConfig, {
        reason,
        proxyUrl,
        tried: [...tried],
        cached: leafSnapshot
      });
    } catch (e) {
      logFn(`代理切换异常 [${key}] ${reason}：${e.message}`, { level: 'warn', event: 'proxy_switch_failed', context: { site: key, reason, error: e.message }, site: key });
      return makeSwitchResult();
    }
    if (!out || out.noop) return makeSwitchResult();
    if (out.exhausted) return makeSwitchResult({ from: out.from || '', exhausted: true });

    // 换点成功：记下新出口地址，使后续请求真的走新节点端口
    if (typeof out.proxyUrl === 'string' && out.proxyUrl.trim()) {
      activeProxyUrl = out.proxyUrl.trim();
    }
    // 记账：仅在提供方返回成功后
    tried = Array.isArray(out.tried) ? out.tried : [];
    leafSnapshot = {
      groupName: out.groupName,
      leaves: out.leaves,
      nodes: out.nodes,
      currentTag: out.currentTag,
      controller: out.controller
    };
    // 换点后废弃本站旧隧道长连接：keepAlive 的代理 socket 仍指向旧出口，
    // 不复位会继续用旧 IP 请求
    destroySiteAgents(key);
    return makeSwitchResult({ ok: true, from: out.from || '', to: out.to || '' });
  }

  return {
    key,
    switch: reason => withLock(() => doSwitch(reason)),
    reset,
    dispose,
    currentProxyUrl
  };
}

module.exports = {
  createRotation,
  rotationKey,
  desensitizeProxyUrl,
  getProxyAgentEntry,
  destroySiteAgents,
  makeSwitchResult
};
