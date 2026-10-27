// easy_proxies 多端口管理 API 适配器。
// crawler 负责发现健康节点、轮换独立端口并重建代理隧道；easy_proxies 负责节点拨号、健康检查和订阅管理。
const axios = require('axios');
const { log } = require('../log');

const REQUEST_TIMEOUT = 2000;
const DEFAULT_CONTROLLER = 'http://easy_proxies:9091';
let refreshAt = 0;
let refreshPromise = null;
const authTokens = new Map();

function normalizeSite(site) {
  return String(site || '').trim().toLowerCase();
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function addBase(bases, value) {
  const base = normalizeBase(value);
  if (!base || bases.includes(base)) return;
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    bases.push(base);
  } catch (_) {}
}

function controllerBases(siteConfig, proxyUrl) {
  const bases = [];
  addBase(bases, siteConfig && siteConfig.easyProxiesController);
  addBase(bases, process.env.EASY_PROXIES_CONTROLLER);
  addBase(bases, process.env.EASY_PROXIES_API);

  // 允许本地运行时仅设置 CEB_PROXY_URL=http://127.0.0.1:24000。
  try {
    const proxy = new URL(proxyUrl || '');
    const host = proxy.hostname.includes(':') && !proxy.hostname.startsWith('[')
      ? `[${proxy.hostname}]`
      : proxy.hostname;
    addBase(bases, `${proxy.protocol}//${host}:9091`);
  } catch (_) {}

  addBase(bases, DEFAULT_CONTROLLER);
  addBase(bases, 'http://127.0.0.1:9091');
  return bases;
}

function isEasyProxiesProxyUrl(proxyUrl) {
  try {
    const host = new URL(proxyUrl).hostname.toLowerCase();
    const configuredHost = String(process.env.EASY_PROXIES_HOST || '').trim().toLowerCase();
    return host === 'easy_proxies' || host === 'easy-proxies' || host === 'easyproxies' ||
      (configuredHost && host === configuredHost);
  } catch (_) {
    return false;
  }
}

function password() {
  return String(process.env.EASY_PROXIES_PASSWORD || '').trim();
}

async function login(base) {
  const response = await axios.post(`${base}/api/auth`, { password: password() }, {
    timeout: REQUEST_TIMEOUT,
    proxy: false
  });
  const token = response && response.data && response.data.token;
  if (!token) throw new Error('easy_proxies 管理 API 登录未返回 token');
  authTokens.set(base, token);
  return token;
}

async function request(base, method, endpoint, data) {
  const url = `${base}${endpoint}`;
  const send = async () => {
    const token = authTokens.get(base);
    const config = {
      timeout: REQUEST_TIMEOUT,
      proxy: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    };
    if (method === 'GET') return axios.get(url, config);
    if (method === 'POST') return axios.post(url, data, config);
    throw new Error(`不支持 easy_proxies API 方法 ${method}`);
  };

  try {
    return await send();
  } catch (error) {
    if (error && error.response && error.response.status === 401 && password()) {
      authTokens.delete(base);
      await login(base);
      return send();
    }
    throw error;
  }
}

function normalizeNodes(rawNodes) {
  if (!Array.isArray(rawNodes)) return [];
  const seen = new Set();
  return rawNodes.map((raw, index) => {
    const node = raw && typeof raw === 'object' ? raw : {};
    const port = Number(node.port);
    const tag = String(node.tag || node.name || `node-${port || index + 1}`).trim();
    if (!tag || !Number.isInteger(port) || port <= 0) return null;
    if (node.blacklisted === true || node.available === false || node.initial_check_done === false) return null;
    if (seen.has(tag)) return null;
    seen.add(tag);
    return {
      tag,
      name: String(node.name || node.tag || tag).trim(),
      port,
      available: node.available,
      blacklisted: node.blacklisted,
      initial_check_done: node.initial_check_done
    };
  }).filter(Boolean);
}

// 返回 { nodes, controller, source }：
// - source: 'snapshot' 表示本次未触达管理 API，直接采用了上一轮的节点快照（零请求短路）；
// - source: 'api'      表示本次真的查询了 /api/nodes。
// 区分两者是必要的：快照路径下「已切换节点」只说明端口号变了，
// 并不证明该端口背后有可用出口——管理面可能早已不可达（陈旧快照）。
async function fetchNodes(siteConfig, proxyUrl, cached) {
  if (cached && Array.isArray(cached.nodes) && cached.nodes.length) {
    return {
      nodes: normalizeNodes(cached.nodes),
      controller: cached.controller || '',
      source: 'snapshot'
    };
  }

  let lastError;
  for (const base of controllerBases(siteConfig, proxyUrl)) {
    try {
      const response = await request(base, 'GET', '/api/nodes');
      const nodes = response && response.data && response.data.nodes;
      if (!Array.isArray(nodes)) throw new Error('easy_proxies /api/nodes 响应缺少 nodes 数组');
      return { nodes: normalizeNodes(nodes), controller: base, source: 'api' };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('easy_proxies 管理 API 不可达');
}

function portFromProxyUrl(proxyUrl) {
  try {
    const port = Number(new URL(proxyUrl).port);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch (_) {
    return 0;
  }
}

function proxyUrlForPort(proxyUrl, port) {
  const url = new URL(proxyUrl);
  url.port = String(port);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function nodeLabel(node) {
  return node ? (node.name || node.tag || `port:${node.port}`) : '';
}

async function switchNode(siteConfig, { reason = '', proxyUrl = '', tried = [], cached } = {}) {
  if (!proxyUrl) return { noop: true };
  const site = normalizeSite(siteConfig && siteConfig.name);
  let snapshot;
  try {
    snapshot = await fetchNodes(siteConfig, proxyUrl, cached);
  } catch (error) {
    log(`easy_proxies 节点查询失败 [${site}] ${reason}：${error.message}`, {
      level: 'warn',
      event: 'proxy_nodes_failed',
      context: { site, reason, error: error.message },
      site
    });
    return { noop: true };
  }

  const nodes = snapshot.nodes;
  const source = snapshot.source || 'api';
  if (!nodes.length) {
    log(`easy_proxies 没有可用多端口节点 [${site}] ${reason}`, {
      level: 'warn',
      event: 'proxy_pool_empty',
      context: { site, reason, source },
      site
    });
    return { noop: true };
  }

  const triedNames = [...new Set((Array.isArray(tried) ? tried : []).map(String).filter(Boolean))];
  const triedSet = new Set(triedNames);
  const currentPort = portFromProxyUrl(proxyUrl);
  const current = nodes.find(node => node.port === currentPort);
  if (current && !triedSet.has(current.tag)) {
    triedNames.push(current.tag);
    triedSet.add(current.tag);
  }

  const next = nodes.find(node => node.port !== currentPort && !triedSet.has(node.tag));
  const leaves = nodes.map(node => node.tag);
  if (!next) {
    log(`easy_proxies 节点池本轮已轮尽 [${site}] ${reason}（节点 ${nodes.length} 个，本轮已试 ${triedNames.length}）`, {
      level: 'warn',
      event: 'proxy_pool_exhausted',
      context: { site, reason, leaves: nodes.length, tried: triedNames.length, source },
      site
    });
    return {
      exhausted: true,
      source,
      from: nodeLabel(current) || (currentPort ? `port:${currentPort}` : ''),
      tried: triedNames,
      leaves,
      nodes,
      controller: snapshot.controller
    };
  }

  const newTried = [...triedNames, next.tag];
  const nextProxyUrl = proxyUrlForPort(proxyUrl, next.port);
  // 快照路径下必须显式标注：本次换点未经验证（管理面未触达），
  // 调用方据此提示「这只是端口号变了，不代表出口可用」。
  if (source === 'snapshot') {
    log(`easy_proxies 已切换节点（未验证，管理面未触达）[${site}] ${reason}：${nodeLabel(current) || `port:${currentPort || '?'}`} → ${nodeLabel(next)}，节点列表取自上一轮快照，出口可用性未经确认`, {
      level: 'warn',
      event: 'proxy_switched_stale_snapshot',
      context: { site, reason, from: nodeLabel(current), to: nodeLabel(next), port: next.port, tried: newTried.length, leaves: nodes.length },
      site
    });
  } else {
    log(`easy_proxies 已切换节点 [${site}] ${reason}：${nodeLabel(current) || `port:${currentPort || '?'}`} → ${nodeLabel(next)}（本轮已试 ${newTried.length}/${nodes.length}）`, {
      event: 'proxy_switched',
      context: { site, reason, from: nodeLabel(current), to: nodeLabel(next), port: next.port, tried: newTried.length, leaves: nodes.length },
      site
    });
  }
  return {
    switched: true,
    source,
    from: nodeLabel(current) || (currentPort ? `port:${currentPort}` : ''),
    to: nodeLabel(next),
    proxyUrl: nextProxyUrl,
    tried: newTried,
    leaves,
    nodes,
    currentTag: next.tag,
    controller: snapshot.controller
  };
}

function refreshCooldownMs() {
  const raw = process.env.EASY_PROXIES_REFRESH_COOLDOWN || process.env.PROXY_REFRESH_COOLDOWN;
  const value = Number(raw);
  return (Number.isFinite(value) && value >= 0 ? value : 600) * 1000;
}

// 订阅错误文本脱敏：上游错误信息是自由文本，实测会内嵌订阅 URL（含密钥）
// 和节点 IP（`dial tcp 1.2.3.4:443: i/o timeout`）。AGENTS.md/CLAUDE.md 禁止
// 把订阅地址和节点 IP 写进日志。保留错误类型与状态码，抹掉身份信息。
function desensitizeErrorText(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  return raw
    // 订阅地址整体不可见（主机、路径、查询都可能带订阅身份），只保留协议以示来源类型
    .replace(/https?:\/\/[^\s"'<>）)]+/gi, (u) => {
      try {
        return `${new URL(u).protocol}//***`;
      } catch (_) {
        return '***';
      }
    })
    // 节点 IP（含 IPv6、可选端口）：拨号错误里到处是它
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '***')
    .replace(/\[[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\](?::\d+)?/gi, '***');
}

// 读取订阅状态（节点数 / 订阅侧错误）。这是「刷新是否真的换了节点」的唯一线索：
// easy_proxies 在订阅拉取失败、回退旧缓存时同样返回 200，只看刷新接口的 200 会永久静默。
// 状态接口不可达（旧版本、管理面半死）时返回 null，绝不影响刷新本身的成败判定。
async function readSubscriptionStatus(base) {
  try {
    const response = await request(base, 'GET', '/api/subscription/status');
    const data = (response && response.data) || {};
    return {
      nodeCount: Number.isInteger(data.node_count) ? data.node_count : undefined,
      lastError: typeof data.last_error === 'string' ? desensitizeErrorText(data.last_error) : '',
      // 每次完成的刷新尝试都计数（含失败）。只作诊断线索、不参与分级：
      // 刷新在 easy_proxies 侧排队异步执行，我们 POST 后立刻读状态，
      // 此刻它可能还没被循环认领，refresh_count 尚未自增——拿它判成败会误报。
      refreshCount: Number.isInteger(data.refresh_count) ? data.refresh_count : undefined
    };
  } catch (_) {
    return null;
  }
}

async function refreshProviders({ site = '', reason = '', siteConfig, proxyUrl } = {}) {
  const now = Date.now();
  if (now - refreshAt < refreshCooldownMs()) return false;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    let lastError;
    for (const base of controllerBases(siteConfig, proxyUrl)) {
      try {
        await request(base, 'POST', '/api/subscription/refresh');
        refreshAt = Date.now();
        // 刷新返回 200 只说明接口被受理，不代表拿到新节点：读状态把「实际节点数」带进日志。
        const status = await readSubscriptionStatus(base);
        const nodeCount = status ? status.nodeCount : undefined;
        const subError = status ? status.lastError : '';
        const refreshCount = status ? status.refreshCount : undefined;
        const empty = nodeCount === 0;
        // last_error 非空时同样要 warn：订阅拉取失败但回退旧缓存时 node_count 仍 > 0，
        // 只看节点数会把「正在用过期节点」记成 info。缓存节点能撑多久全凭运气，
        // 整池过期后就是 ceb 连续 15 轮 0 条那种静默失败。
        const degraded = empty || !!subError;
        const detail = status
          ? `，节点 ${nodeCount === undefined ? '未知' : nodeCount} 个${subError ? `，订阅错误：${subError}` : ''}`
          : '（状态接口不可达，无法确认节点数）';
        log(`easy_proxies 订阅刷新 [${site}] ${reason}${detail}`, {
          // 空池或订阅报错必须 warn：否则会表现为「每轮刷新成功、每轮 0 条」的静默失败
          level: degraded ? 'warn' : 'info',
          event: 'proxy_provider_refresh',
          context: { site, reason, endpoint: `${base}/api/subscription/refresh`, nodeCount, refreshCount, lastError: subError },
          site
        });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    log(`easy_proxies 订阅刷新失败 [${site}] ${reason}：${lastError ? lastError.message : '管理 API 不可达'}`, {
      level: 'warn',
      event: 'proxy_provider_refresh_failed',
      context: { site, reason },
      site
    });
    return false;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

module.exports = {
  switchNode,
  refreshProviders,
  fetchNodes,
  isEasyProxiesProxyUrl,
  proxyUrlForPort,
  _resetRefreshCooldown: () => { refreshAt = 0; refreshPromise = null; authTokens.clear(); }
};
