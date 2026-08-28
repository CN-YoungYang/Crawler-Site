// easy_proxies multi-port 管理 API 适配器。
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

async function fetchNodes(siteConfig, proxyUrl, cached) {
  if (cached && Array.isArray(cached.nodes) && cached.nodes.length) {
    return {
      nodes: normalizeNodes(cached.nodes),
      controller: cached.controller || ''
    };
  }

  let lastError;
  for (const base of controllerBases(siteConfig, proxyUrl)) {
    try {
      const response = await request(base, 'GET', '/api/nodes');
      const nodes = response && response.data && response.data.nodes;
      if (!Array.isArray(nodes)) throw new Error('easy_proxies /api/nodes 响应缺少 nodes 数组');
      return { nodes: normalizeNodes(nodes), controller: base };
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
  if (!nodes.length) {
    log(`easy_proxies 没有可用 multi-port 节点 [${site}] ${reason}`, {
      level: 'warn',
      event: 'proxy_pool_empty',
      context: { site, reason },
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
      context: { site, reason, leaves: nodes.length, tried: triedNames.length },
      site
    });
    return {
      exhausted: true,
      from: nodeLabel(current) || (currentPort ? `port:${currentPort}` : ''),
      tried: triedNames,
      leaves,
      nodes,
      controller: snapshot.controller
    };
  }

  const newTried = [...triedNames, next.tag];
  const nextProxyUrl = proxyUrlForPort(proxyUrl, next.port);
  log(`easy_proxies 已切换节点 [${site}] ${reason}：${nodeLabel(current) || `port:${currentPort || '?'}`} → ${nodeLabel(next)}（本轮已试 ${newTried.length}/${nodes.length}）`, {
    event: 'proxy_switched',
    context: { site, reason, from: nodeLabel(current), to: nodeLabel(next), port: next.port, tried: newTried.length, leaves: nodes.length },
    site
  });
  return {
    switched: true,
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
        log(`已触发 easy_proxies 订阅刷新 [${site}] ${reason}`, {
          event: 'proxy_provider_refresh',
          context: { site, reason, endpoint: `${base}/api/subscription/refresh` },
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
