// easy_proxies 多端口管理 API 适配器。
// crawler 负责发现健康节点、轮换独立端口并重建代理隧道；easy_proxies 负责节点拨号、健康检查和订阅管理。
const axios = require('axios');
const { log } = require('../log');

const REQUEST_TIMEOUT = 2000;
const DEFAULT_REFRESH_TIMEOUT_MS = 60000;
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

  // 兜底只在「完全推导不出管理地址」时使用。
  // 曾经无条件追加 DEFAULT_CONTROLLER 与 127.0.0.1:9091，而失败日志只保留最后一个错误，
  // 于是真实原因（如 easy_proxies:9091 的 500）永远被「connect ECONNREFUSED 127.0.0.1:9091」
  // 盖掉——排查被引向「管理面掉线」，实际只有刷新接口失败（2026-10-27 生产日志）。
  if (!bases.length) addBase(bases, DEFAULT_CONTROLLER);
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

async function request(base, method, endpoint, data, { timeout = REQUEST_TIMEOUT } = {}) {
  const url = `${base}${endpoint}`;
  const send = async () => {
    const token = authTokens.get(base);
    const config = {
      timeout,
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
// - source: 'snapshot' 表示本次未查询管理 API，直接采用了本轮更早一次换点留下的节点快照（零请求短路）；
// - source: 'api'      表示本次真的查询了 /api/nodes。
// 区分两者是必要的：快照路径下「已切换节点」只说明端口号变了，
// 并不证明该端口背后有可用出口——这次换点根本没有向管理面核对过。
async function fetchNodes(siteConfig, proxyUrl, cached) {
  if (cached && Array.isArray(cached.nodes) && cached.nodes.length) {
    return {
      nodes: normalizeNodes(cached.nodes),
      controller: cached.controller || '',
      source: 'snapshot'
    };
  }

  const failures = [];
  for (const base of controllerBases(siteConfig, proxyUrl)) {
    try {
      const response = await request(base, 'GET', '/api/nodes');
      const nodes = response && response.data && response.data.nodes;
      if (!Array.isArray(nodes)) throw new Error('easy_proxies /api/nodes 响应缺少 nodes 数组');
      return { nodes: normalizeNodes(nodes), controller: base, source: 'api' };
    } catch (error) {
      failures.push(describeFailure(base, error));
    }
  }
  // 逐条透出而非只留最后一个：兜底地址的 ECONNREFUSED 会盖掉真实原因。
  const error = new Error(failures.length
    ? `easy_proxies 管理 API 不可达：${summarizeFailures(failures)}`
    : 'easy_proxies 管理 API 不可达（未配置可用的管理地址）');
  error.attempts = failures;
  throw error;
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
    const attempts = Array.isArray(error.attempts) ? error.attempts : [];
    log(`easy_proxies 节点查询失败 [${site}] ${reason}：${error.message}`, {
      level: 'warn',
      event: 'proxy_nodes_failed',
      context: { site, reason, error: error.message, attempts },
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
  // 快照路径下必须显式标注：本次换点未经验证，
  // 调用方据此提示「这只是端口号变了，不代表出口可用」。
  // 措辞两条硬约束：
  // 1) 必须写「本轮早先」：快照属于本轮 rotation 实例，成功页会 reset() 清空，
  //    不可能跨轮残留。写成「上一轮」会让人误判管理面早已不通（2026-10-27 生产日志实见）。
  // 2) 不得写「管理面未触达」：管理面通常是通的，只是这次没查；那句话会把人引向
  //    「管理面掉线」这个错误方向，与 stale 的真实语义（未核对、未验证）根本不是一回事。
  if (source === 'snapshot') {
    log(`easy_proxies 已切换节点（未验证，沿用本轮早先快照）[${site}] ${reason}：${nodeLabel(current) || `port:${currentPort || '?'}`} → ${nodeLabel(next)}，本次未再查询管理面，出口可用性未经确认`, {
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

// 订阅刷新超时：easy_proxies 的 RefreshNowContext 是同步等待（要等订阅拉取 + 健康检查
// 跑完，其配置默认 timeout 30s、health_check_timeout 60s），2s 的通用管理面超时永远等不到
// 结果，表现为「配了订阅却每轮刷新失败」。故单独放宽为 60s，可用环境变量覆盖。
// 与 refreshCooldownMs() 一样每次读取 env：便于测试与运行时改配置，不在模块加载时冻结。
function refreshTimeoutMs() {
  const raw = process.env.EASY_PROXIES_REFRESH_TIMEOUT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_REFRESH_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    log(`EASY_PROXIES_REFRESH_TIMEOUT=${raw} 非法（需正数秒），已回退 ${DEFAULT_REFRESH_TIMEOUT_MS / 1000}s`, {
      level: 'warn',
      event: 'proxy_refresh_timeout_invalid',
      context: { raw },
      site: 'easy_proxies'
    });
    return DEFAULT_REFRESH_TIMEOUT_MS;
  }
  return seconds * 1000;
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

// 管理地址本身也要脱敏：配置或环境变量里可能带 user:pass@ 与查询参数。
function sanitizeBase(base) {
  try {
    const url = new URL(base);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return String(base || '');
  }
}

// 把一次管理面失败归一成可逐条透出的结构 { base, status, code, detail }。
// 只读 error.message 会丢掉上游真正的原因：easy_proxies 在拒绝刷新时返回
// 500 {"error":"no subscription URLs configured"}，axios 的 message 只有「status code 500」。
// 响应体是自由文本，统一走 desensitizeErrorText（上游会内嵌订阅 URL 与节点 IP）。
function describeFailure(base, error) {
  const response = (error && error.response) || {};
  const body = response.data;
  const bodyError = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return {
    base: sanitizeBase(base),
    status: response.status,
    code: (error && error.code) || '',
    detail: desensitizeErrorText(bodyError || (error && error.message) || '未知错误')
  };
}

// 逐条列出所有候选地址的失败。只留最后一个 error 会让排在末尾的兜底地址
// 掩盖真实原因（见 controllerBases 注释）。
function summarizeFailures(failures) {
  return failures
    .map(a => `${a.base}（${[a.status ? `HTTP ${a.status}` : '', a.code, a.detail].filter(Boolean).join(' ')}）`)
    .join('；');
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
    const failures = [];
    for (const base of controllerBases(siteConfig, proxyUrl)) {
      try {
        await request(base, 'POST', '/api/subscription/refresh', undefined, { timeout: refreshTimeoutMs() });
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
        failures.push(describeFailure(base, error));
      }
    }
    // 冷却只给「真的可能已被受理」的失败：ECONNABORTED 说明 POST 已送达、服务端在跑；
    // 而 500/ECONNREFUSED 是明确拒绝或没连上，服务端什么都没做，写冷却反而会掩盖问题。
    // 判据按「是否存在至少一个超时」逐地址判断——曾经是任一地址超时就把整轮当受理，
    // 另一个地址明明回了 500（明确拒绝）也会被当成「可能仍在刷新」而进入冷却。
    const timedOut = failures.some(a => a.code === 'ECONNABORTED');
    if (timedOut) {
      refreshAt = Date.now();
      log(`easy_proxies 订阅刷新超时 [${site}] ${reason}（${refreshTimeoutMs() / 1000}s）：${summarizeFailures(failures)}；easy_proxies 侧可能仍在刷新，本轮沿用现有节点，${Math.round(refreshCooldownMs() / 1000)}s 内不再重试`, {
        level: 'warn',
        event: 'proxy_provider_refresh_timeout',
        context: { site, reason, timeoutMs: refreshTimeoutMs(), attempts: failures },
        site
      });
      return false;
    }
    log(`easy_proxies 订阅刷新失败 [${site}] ${reason}：${failures.length ? summarizeFailures(failures) : '未配置可用的管理地址'}`, {
      level: 'warn',
      event: 'proxy_provider_refresh_failed',
      context: { site, reason, attempts: failures },
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
