const axios = require('axios');
const cheerio = require('cheerio');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { getSiteConfig, normalizeSite } = require('./sites');
const easyProxies = require('./sites/_easy_proxies');
const { shanghaiDateStr, hasValidXlsxHeader } = require('./utils');

// 默认站点策略（原 sites/_base.js，已内联避免单实现抽象层）
function defaultExtractId(link) {
  if (!link) return '';
  return String(link).split('/').pop().split('.')[0];
}
function defaultIsBoundary(error) {
  return error && error.response && error.response.status === 403;
}
function defaultBuildUrl(pageNo, siteConfig) {
  const base = siteConfig.baseUrl || '';
  const suffix = siteConfig.urlSuffix || '';
  return `${base}${pageNo}${suffix}`;
}
function defaultParse($, html, existingIds, siteConfig) {
  const selectors = siteConfig.selectors || {};
  const linkPrefix = siteConfig.linkPrefix || '';
  const extractId = siteConfig.extractId || defaultExtractId;
  const rows = $(selectors.rows);
  const pageData = [];
  rows.each((index, element) => {
    const $el = $(element);
    const title = $el.find(selectors.titleLink).text().trim();
    const link = $el.find(selectors.titleLink).attr('href');
    if (!link) return;
    const id = extractId(link, $el);
    if (!id) return;
    if (existingIds && existingIds.has(id)) return;
    const fullLink = link.startsWith('http://') || link.startsWith('https://') ? link : `${linkPrefix}${link}`;
    pageData.push({
      id,
      title,
      link: fullLink,
      noticeType: $el.find(selectors.noticeType).text().trim(),
      area: $el.find(selectors.area).text().trim(),
      publishTime: $el.find(selectors.publishTime).text().trim()
    });
  });
  return pageData;
}

// 失败容忍上限：一批中失败页数 > 此值 则不触发"无新数据"早停（避免失败页伪装无新数据导致误停）
const FAILURE_STOP_THRESHOLD = 2;
// 批次并发页数（原为散落字面量 10，提为命名常量）
const BATCH_SIZE = 10;
// axios 超时（毫秒）
const REQUEST_TIMEOUT = 30000;
// 重试退避：指数 base*2^attempt，封顶 cap，全量抖动 random(0, delay)
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60000;
// 网络级失败（无 HTTP status，如 ECONNRESET/TLS 握手断开）换 IP 阈值：距上次成功页连续 N 页失败即切节点（仅代理站点生效）
const NET_FAIL_SWITCH_THRESHOLD = 2;
// 网络级失败熔断：换 IP 后仍连败至 N 页，判定代理出口不可用，提前结束（避免 100 页 × 全量重试空转数小时，2026-08-24 曾空转约 5 小时）
const NET_FAIL_BREAK_THRESHOLD = 6;
// 真实浏览器 UA，避免默认 axios UA 被站点日志一眼识别为爬虫
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- 代理（ceb 换 IP 绕过 WAF，轻量替代浏览器引擎） ----
// 优先级：PROXY_<SITE> / <SITE>_PROXY_URL > PROXY_URL > HTTPS_PROXY/HTTP_PROXY > siteConfig.proxyUrl
// 值形如 http://easy_proxies:24000 或 http://user:pass@host:port；NO_PROXY 直连白名单
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

function isNoProxy(targetUrl, siteConfig) {
  const raw = (siteConfig && siteConfig.noProxy) || process.env.NO_PROXY || process.env.no_proxy || '';
  if (!raw || !raw.trim()) return false;
  let hostname = '';
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch (_) { return false; }
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const entry of list) {
    const pat = entry.replace(/^\./, '');
    if (!pat) continue;
    if (pat === '*' || hostname === pat || hostname.endsWith(`.${pat}`)) return true;
  }
  return false;
}

function resolveProxyUrl(siteConfig) {
  if (siteConfig && siteConfig.proxy === false) return '';
  if (siteConfig && typeof siteConfig.runtimeProxyUrl === 'string' && siteConfig.runtimeProxyUrl.trim()) {
    return siteConfig.runtimeProxyUrl.trim();
  }
  const site = String((siteConfig && siteConfig.name) || '').toUpperCase();
  const candidates = [];
  if (site) {
    if (process.env[`PROXY_${site}`]) candidates.push(process.env[`PROXY_${site}`]);
    if (process.env[`${site}_PROXY_URL`]) candidates.push(process.env[`${site}_PROXY_URL`]);
    if (process.env[`${site}_PROXY`]) candidates.push(process.env[`${site}_PROXY`]);
  }
  if (process.env.PROXY_URL) candidates.push(process.env.PROXY_URL);
  if (process.env.HTTPS_PROXY) candidates.push(process.env.HTTPS_PROXY);
  if (process.env.HTTP_PROXY) candidates.push(process.env.HTTP_PROXY);
  if (process.env.https_proxy) candidates.push(process.env.https_proxy);
  if (process.env.http_proxy) candidates.push(process.env.http_proxy);
  if (siteConfig && siteConfig.proxyUrl) candidates.push(siteConfig.proxyUrl);
  if (siteConfig && typeof siteConfig.proxy === 'string' && siteConfig.proxy) candidates.push(siteConfig.proxy);
  const raw = candidates.find(v => typeof v === 'string' && v.trim());
  return raw ? raw.trim() : '';
}

function getProxyProvider(siteConfig, proxyUrl) {
  const configured = String((siteConfig && siteConfig.proxyProvider) || '').trim().toLowerCase();
  if (easyProxies.isEasyProxiesProxyUrl(proxyUrl)) return easyProxies;
  if (configured === 'easy_proxies' || configured === 'easy-proxies') return easyProxies;
  return null;
}

function getProxyAgents(siteConfig, targetUrl) {
  const proxyUrl = resolveProxyUrl(siteConfig);
  if (!proxyUrl) return null;
  if (targetUrl && isNoProxy(targetUrl, siteConfig)) return null;
  try { new URL(proxyUrl); } catch (e) {
    log(`代理地址无效，已回退直连：${desensitizeProxyUrl(proxyUrl)} (${e.message})`, { level: 'warn', event: 'proxy_invalid', context: { proxy: desensitizeProxyUrl(proxyUrl), site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
  // 复用 Agent，避免每页新建导致 socket 泄漏（尤其 batchSize 并发）。
  // 缓存键含站点：全局 HTTP_PROXY 配法下多站解析出同一 proxyUrl，若共用条目，
  // 一站换点 destroy 会打断兄弟站在途请求（2026-08-26 审查 #1）——各站独立隧道。
  if (!getProxyAgents._cache) getProxyAgents._cache = new Map();
  const siteKey = rotateKey((siteConfig && siteConfig.name) || '');
  const cacheKey = `${siteKey}|${proxyUrl}`;
  const cached = getProxyAgents._cache.get(cacheKey);
  if (cached) return cached;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { HttpProxyAgent } = require('http-proxy-agent');
    const entry = {
      proxyUrl,
      httpAgent: new HttpProxyAgent(proxyUrl, { keepAlive: true }),
      httpsAgent: new HttpsProxyAgent(proxyUrl, { keepAlive: true })
    };
    getProxyAgents._cache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    log(`代理组件加载失败，已回退直连：${e.message}`, { level: 'warn', event: 'proxy_agent_failed', context: { error: e.message, site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
}

// 双 405/网络连败的秒级换 IP：通过 easy_proxies 控制面切换 multi-port 节点，
// 也可经 siteConfig.switchProxy 按站覆盖；easy_proxies 知识收敛于 sites/_easy_proxies.js。
// 轮换语义：池中节点按管理 API 返回顺序轮换，避免当前端口和已试节点反复打转：
// - 只切真实节点端口：由 provider 过滤不可用节点并保留每轮已试记录；
// - 同一轮（两次成功页之间）不重复已试节点，按列表顺序依次轮换；
// - 轮尽不再切换并返回 exhausted（事件 proxy_pool_exhausted），由调用方累计失败自然熔断。
// 返回 {ok, from, to, exhausted}；ok=true 表示本次真的切换了节点。
const _proxyRotate = new Map(); // 轮换键 -> 本轮已试节点名数组
const rotateKey = site => String(site || '').trim().toLowerCase();

function makeSwitchResult(overrides) {
  return { ok: false, from: '', to: '', exhausted: false, ...overrides };
}

// 同站换点互斥：batchSize>1 时同批多个双 405 页并发进入 trySwitchProxy，
// get→filter→PUT→push 读改写交错会重复选同一节点、tried 重复记账假性耗尽
// （2026-08-26 审查 #3）。串行化后每页拿到不同的下一个未试节点。
const _proxySwitchQueue = new Map(); // 轮换键 -> Promise 链尾
function withProxySwitchLock(key, fn) {
  const prev = _proxySwitchQueue.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _proxySwitchQueue.set(key, next.catch(() => {}));
  return next;
}

async function trySwitchProxy(siteConfig, reason) {
  const proxyUrl = resolveProxyUrl(siteConfig);
  if (!proxyUrl) return makeSwitchResult();
  // 轮换记忆键与 crawl() 的删键统一归一（写侧原用原始 siteConfig.name，
  // 删侧用 normalizeSite 后的参数 site，两链不一致会永久残留致静默 exhausted——审查 #2）
  const key = rotateKey(normalizeSite((siteConfig && siteConfig.name) || ''));
  return withProxySwitchLock(key, async () => {
    const provider = getProxyProvider(siteConfig, proxyUrl);
    const switcher = (siteConfig && typeof siteConfig.switchProxy === 'function')
      ? siteConfig.switchProxy
      : provider && provider.switchNode;
    if (typeof switcher !== 'function') return makeSwitchResult();
    let out;
    try {
      out = await switcher.call(siteConfig, siteConfig, { reason, proxyUrl, tried: [...(_proxyRotate.get(key) || [])], cached: getProxyAgents._leafCache && getProxyAgents._leafCache.get(key) });
    } catch (e) {
      log(`代理切换异常 [${key}] ${reason}：${e.message}`, { level: 'warn', event: 'proxy_switch_failed', context: { site: key, reason, error: e.message }, site: key });
      return makeSwitchResult();
    }
    if (!out || out.noop) return makeSwitchResult();
    if (out.exhausted) return makeSwitchResult({ from: out.from || '', exhausted: true });
    if (typeof out.proxyUrl === 'string' && out.proxyUrl.trim()) {
      siteConfig.runtimeProxyUrl = out.proxyUrl.trim();
    }
    // provider 返回成功后才记账；缓存节点快照，轮尽后可零请求短路
    _proxyRotate.set(key, Array.isArray(out.tried) ? out.tried : []);
    if (!getProxyAgents._leafCache) getProxyAgents._leafCache = new Map();
    getProxyAgents._leafCache.set(key, {
      groupName: out.groupName,
      leaves: out.leaves,
      nodes: out.nodes,
      currentTag: out.currentTag,
      controller: out.controller
    });
    // 换点后废弃本站旧隧道长连接：keepAlive 的代理 socket 仍指向旧出口，不复位会继续用旧 IP 请求。
    // 只清本站条目——全局 HTTP_PROXY 下兄弟站共用同一 proxyUrl 但各有独立 Agent（审查 #1）
    if (getProxyAgents._cache) {
      for (const [cacheKey, entry] of getProxyAgents._cache) {
        if (!cacheKey.startsWith(`${key}|`)) continue;
        try { entry.httpAgent.destroy(); } catch (_) {}
        try { entry.httpsAgent.destroy(); } catch (_) {}
        getProxyAgents._cache.delete(cacheKey);
      }
    }
    return makeSwitchResult({ ok: true, from: out.from || '', to: out.to || '' });
  });
}

// 启动/每轮爬取前刷新代理订阅（easy_proxies 读取订阅并生成 multi-port 节点）。
// 供 index.js 程序启动时调用；crawl() 每轮也会先刷新一次（provider 内部限频）。
async function refreshProxyProviders(site) {
  let siteConfig;
  try { siteConfig = getSiteConfig(site); } catch (_) { return false; }
  const proxyUrl = resolveProxyUrl(siteConfig);
  const provider = getProxyProvider(siteConfig, proxyUrl);
  if (!proxyUrl || !provider || typeof provider.refreshProviders !== 'function') return false;
  try {
    return await provider.refreshProviders({ site: normalizeSite(site), reason: 'startup', siteConfig, proxyUrl });
  } catch (_) { return false; }
}

// shanghaiDateStr 已收敛至 utils.js（Intl 标准库）

// hasValidXlsxHeader 已收敛至 utils.js

function readXlsxRowsSafe(filePath, site, event = 'recent_read_failed') {
  if (!hasValidXlsxHeader(filePath)) {
    log(`读取 ${filePath} 失败，已跳过：非 xlsx`, { level: 'warn', event, context: { file: filePath, site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames && workbook.SheetNames[0];
    if (!sheetName || !workbook.Sheets[sheetName]) return [];
    return xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
  } catch (e) {
    log(`读取 ${filePath} 失败，已跳过：${e.message}`, { level: 'warn', event, context: { file: filePath, site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
}

// 站点化路径（cwd 相对，与 withTempCwd 测试隔离一致）
function fileDir(site) {
  return path.join('file', normalizeSite(site));
}
function stateFile(site) {
  return path.join(`state-${normalizeSite(site)}.json`);
}

// 退避延迟（纯函数，便于测试）：指数 base*2^attempt，封顶 cap，全量抖动 [0, delay)。
function backoffDelay(attempt, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS) {
  const exp = base * Math.pow(2, attempt);
  const capped = Math.min(exp, cap);
  return Math.floor(Math.random() * capped);
}

function resolveSiteConfig(siteOrConfig) {
  if (siteOrConfig && typeof siteOrConfig === 'object' && siteOrConfig.baseUrl !== undefined) {
    return siteOrConfig;
  }
  return getSiteConfig(siteOrConfig);
}

// 从成功页提取站点分页自报的真实总页数（可选钩子 parseTotalPages）。
// 缺钩子/解析失败/非法值一律返回 undefined，爬取行为退化为仅受配置 totalPages 约束；
// 钩子抛错只告警不致命（不得影响该页正常结果）。
async function extractRealTotalPages(siteConfig, $, html) {
  if (!siteConfig || typeof siteConfig.parseTotalPages !== 'function') return undefined;
  const siteName = siteConfig.name || '';
  try {
    const v = await siteConfig.parseTotalPages.call(siteConfig, $, html, siteConfig);
    return (Number.isInteger(v) && v > 0) ? v : undefined;
  } catch (e) {
    log(`站点 [${siteName}] parseTotalPages 钩子抛错，已忽略：${e.message}`, { level: 'warn', event: 'total_pages_hook_error', context: { site: siteName, error: e.message }, site: siteName });
    return undefined;
  }
}

async function crawlPage(pageNo, siteOrBaseUrl, urlSuffixOrExistingIds, existingIdsOrMaxRetries, maxRetriesArg) {
  // 兼容旧签名 crawlPage(pageNo, baseUrl, urlSuffix, existingIds, maxRetries)
  // 新签名 crawlPage(pageNo, siteConfig|site, existingIds, maxRetries)
  let siteConfig;
  let existingIds;
  let maxRetries = 3;
  let urlSuffixOverride = null;
  let baseUrlOverride = null;

  if (typeof siteOrBaseUrl === 'string') {
    // 旧签名：第二参为 baseUrl 字符串
    baseUrlOverride = siteOrBaseUrl;
    urlSuffixOverride = urlSuffixOrExistingIds;
    existingIds = existingIdsOrMaxRetries;
    if (maxRetriesArg !== undefined) maxRetries = maxRetriesArg;
    // 若 base/suffix 均为空，视为占位调用，直接抛错提示站点未实现
    if (!baseUrlOverride && !urlSuffixOverride) {
      throw new Error('crawlPage 旧签名 baseUrl/urlSuffix 为空，请改用站点配置');
    }
    siteConfig = { baseUrl: baseUrlOverride, urlSuffix: urlSuffixOverride, selectors: require('./sites/yfbzb').selectors };
  } else {
    siteConfig = resolveSiteConfig(siteOrBaseUrl);
    existingIds = urlSuffixOrExistingIds;
    if (existingIdsOrMaxRetries !== undefined) maxRetries = existingIdsOrMaxRetries;
    if (maxRetriesArg !== undefined) maxRetries = maxRetriesArg;
  }

  if (!existingIds) existingIds = new Set();
  const siteName = siteConfig.name || normalizeSite(siteConfig.name);
  // 第一页探针：pageNo===1 时若当前出口失败则一路换点，直到成功或节点池轮尽（见下方失败处理）
  const isFirstPage = pageNo === 1;
  const isBoundary = siteConfig.isBoundary || defaultIsBoundary;
  const linkPrefix = siteConfig.linkPrefix || '';
  const timeout = siteConfig.timeout ?? REQUEST_TIMEOUT;
  // 合并默认 UA，避免站点仅覆写部分头时丢失 UA 被 WAF 拦截
  const headers = { 'User-Agent': USER_AGENT, ...(siteConfig.headers || {}) };

  // 策略化 URL 构建
  const url = typeof siteConfig.buildUrl === 'function'
    ? siteConfig.buildUrl.call(siteConfig, pageNo)
    : defaultBuildUrl(pageNo, siteConfig);

  let retries = 0;
  // 方法容错：仅显式开启 fallbackOn405 的站点才降级（如 ceb），避免 yfbzb 等 GET 站点误发 POST
  let method = String(siteConfig.method || 'GET').toUpperCase();
  let triedFallback = false;
  let triedSwitch = false;

  // 站点级请求前抖动（风控敏感站如 ceb）：crawler 批次间隔为 batch 之间，页内再加随机延迟
  async function maybeThrottle() {
    const d = siteConfig.requestDelay;
    if (!d) return;
    const min = Number(d.min ?? d.minMs ?? 0);
    const max = Number(d.max ?? d.maxMs ?? min);
    if (!(max > 0)) return;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const delay = Math.floor(Math.random() * (hi - lo + 1) + lo);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }

  while (retries < maxRetries) {
    try {
      await maybeThrottle();
      const proxyAgents = getProxyAgents(siteConfig, url);
      const axiosProxyOpts = proxyAgents ? { proxy: false, httpAgent: proxyAgents.httpAgent, httpsAgent: proxyAgents.httpsAgent } : {};
      let response;
      if (method === 'POST') {
        // 用 URL API 稳健切分，避免手工 indexOf 误伤 hash/空查询
        let base = url;
        let query = '';
        try {
          const u = new URL(url);
          base = `${u.protocol}//${u.host}${u.pathname}`;
          query = u.search ? u.search.slice(1) : '';
          // hash 不应作为表单字段发送，已被 URL 丢弃
        } catch (_) {
          const qIdx = url.indexOf('?');
          base = qIdx >= 0 ? url.slice(0, qIdx).split('#')[0] : url.split('#')[0];
          query = qIdx >= 0 ? url.slice(qIdx + 1).split('#')[0] : '';
        }
        if (!query) {
          // 无 query 时不强制发空表单，避免必填参数丢失；回退为 GET 语义
          response = await axios.get(url, { timeout, headers, ...axiosProxyOpts });
        } else {
          const postHeaders = { ...headers };
          // 尊重站点已声明的 Content-Type，仅在未声明时默认 form
          const hasCT = Object.keys(postHeaders).some(k => k.toLowerCase() === 'content-type');
          if (!hasCT) postHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
          response = await axios.post(base, query, { timeout, headers: postHeaders, ...axiosProxyOpts });
        }
      } else {
        response = await axios.get(url, { timeout, headers, ...axiosProxyOpts });
      }

      // 优先使用站点自定义 parse 接管整页解析
      if (typeof siteConfig.parse === 'function') {
        const $loaded = cheerio.load(response.data);
        const pageData = await siteConfig.parse($loaded, response.data, existingIds, siteConfig);
        const filtered = Array.isArray(pageData) ? pageData.filter(item => !existingIds.has(item.id)) : [];
        log(`爬取完成第 ${pageNo} 页，共找到 ${filtered.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: filtered.length, site: siteName }, site: siteName });
        const realTotalPages = await extractRealTotalPages(siteConfig, $loaded, response.data);
        return { pageData: filtered, failed: false, realTotalPages };
      }

      const $ = cheerio.load(response.data);
      const realTotalPages = await extractRealTotalPages(siteConfig, $, response.data);
      const selectors = siteConfig.selectors || require('./sites/yfbzb').selectors;
      const rows = $(selectors.rows);

      if (rows.length === 0) {
        log(`第 ${pageNo} 页没有找到任何数据`, { event: 'page_empty', context: { page: pageNo, site: siteName }, site: siteName });
        return { pageData: [], failed: false, realTotalPages };
      }

      // 走默认 selectors 解析（委托 _base）；显式传入解析后的 selectors（含 yfbzb 兜底），
      // 否则缺 selectors 的站点（如旧签名/测试站点）行数检查通过但解析拿到空行
      const pageData = defaultParse($, response.data, existingIds, { ...siteConfig, selectors, linkPrefix, extractId: siteConfig.extractId || defaultExtractId });

      log(`爬取完成第 ${pageNo} 页，共找到 ${pageData.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: pageData.length, site: siteName }, site: siteName });
      return { pageData, failed: false, realTotalPages };
    } catch (error) {
      if (isBoundary(error, siteConfig)) {
        log(`第 ${pageNo} 页无新增数据（站点边界），已爬至当日末尾`, { event: 'boundary_403', context: { page: pageNo, site: siteName }, site: siteName });
        return { pageData: [], failed: false, endReached: true };
      }
      const errStatus = error.response?.status;
      // 405 自动降级：仅显式开启 fallbackOn405 的站点（如 ceb）才切 POST。
      // 降级不消耗 retries：triedFallback 已保证仅降级一次。若在此扣减最后一次重试额度，
      // 循环条件 (retries < maxRetries) 直接为假退出且无返回值（隐式 undefined），
      // 曾致 crawl() 解构 results[i] 崩溃（2026-08-24 17:23 生产日志复现）
      function formatSnippet(data) {
        if (data == null) return '';
        if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 300);
        if (typeof data === 'object') {
          try { return JSON.stringify(data).slice(0, 300); } catch (_) { return String(data).slice(0, 300); }
        }
        return String(data).slice(0, 300);
      }
      if (errStatus === 405 && method === 'GET' && !triedFallback && siteConfig.fallbackOn405) {
        // 降级不消耗 retries：triedFallback 已保证仅降级一次。若在此扣减最后一次重试额度，
        // 循环条件 (retries < maxRetries) 直接为假退出且无返回值（隐式 undefined），
        // 曾致 crawl() 解构 results[i] 崩溃（2026-08-24 17:23 生产日志复现）
        triedFallback = true;
        method = 'POST';
        const snippet = formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim();
        log(`第 ${pageNo} 页 GET 405，自动降级为 POST 重试 [snippet=${snippet.slice(0, 120) || 'empty'}]`, { level: 'warn', event: 'fallback_post', context: { page: pageNo, status: errStatus, snippet: snippet.slice(0, 120), site: siteName }, site: siteName });
        await new Promise(resolve => setTimeout(resolve, backoffDelay(retries)));
        continue;
      }
      // 双 405 快败：GET 已降级为 POST 仍 405，说明是 WAF/网关确定性拦截，重试无意义，直接跳过
      if (errStatus === 405 && triedFallback && method === 'POST') {
        const snippet405 = formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim();
        const extra405 = snippet405 ? ` snippet=${snippet405.slice(0, 80)}` : '';
        log(`第 ${pageNo} 页 POST 仍 405（GET→POST 双 405），不再重试直接跳过 [code=${error.code} status=${errStatus} method=${method}${extra405}]`, { level: 'error', event: 'page_failed_dual405', context: { page: pageNo, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
        // 单页即换 IP：easy_proxies 场景轮换取下一个未试节点，避免攒够 consecutive405 才熔断
        let sw = makeSwitchResult();
        try { sw = await trySwitchProxy(siteConfig, 'dual405'); } catch (_) {}
        // 第一页探针：当前出口被 WAF 拦就一路换点，直到成功或节点池轮尽（轮尽=后续页同样被拦，取消本次抓取）
        if (isFirstPage && (sw.ok || sw.exhausted)) {
          if (sw.exhausted) {
            log(`第 1 页在所有节点上均被拦（双 405），判定出口全被拦截，取消本次抓取 [${siteName}]`, { level: 'error', event: 'first_page_gate_exhausted', context: { page: pageNo, status: errStatus, site: siteName }, site: siteName });
            return { pageData: [], failed: true, status: errStatus, proxyExhausted: true, gateAbort: true };
          }
          log(`第 1 页双 405 已换 IP（${sw.from} → ${sw.to}），继续探针重试`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw.from, to: sw.to, site: siteName }, site: siteName });
          await new Promise(r => setTimeout(r, backoffDelay(0)));
          continue;
        }
        // 换点后重置重试该页（不限于第1页），避免数据丢失：成功换点立即重放当前页
        if (sw.ok && !triedSwitch) {
          triedSwitch = true;
          log(`第 ${pageNo} 页双 405 已换 IP，立即重试该页`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw.from, to: sw.to, site: siteName }, site: siteName });
          await new Promise(r => setTimeout(r, backoffDelay(0)));
          continue;
        }
        return { pageData: [], failed: true, status: errStatus, proxySwitched: !!sw.ok, proxyExhausted: !!sw.exhausted };
      }
      retries++;
      const backoff = backoffDelay(retries - 1);
      const snippet405 = errStatus === 405 ? formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim() : '';
      const extra405 = snippet405 ? ` snippet=${snippet405.slice(0, 80)}` : '';
      log(`第 ${pageNo} 页加载失败 [code=${error.code} status=${errStatus} method=${method}${extra405}]：${error.message}，正在进行第 ${retries} 次重试，${backoff}ms 后...`, { level: 'warn', event: 'retry', context: { page: pageNo, attempt: retries, backoffMs: backoff, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
      if (retries >= maxRetries) {
        // 换点重置：网络失败（无 status）达上限后，尝试换 IP 重试
        if (errStatus === undefined || errStatus === null) {
          let sw2 = makeSwitchResult();
          try { sw2 = await trySwitchProxy(siteConfig, isFirstPage ? 'first_page_net_fail' : 'net_fail'); } catch (_) {}
          // 第一页探针：当前出口网络不通就一直换，直到成功或节点池轮尽（轮尽=后续页同样不通，取消本次抓取）
          if (isFirstPage && (sw2.ok || sw2.exhausted)) {
            if (sw2.exhausted) {
              log(`第 1 页在所有节点上均网络失败，判定出口全部不可用，取消本次抓取 [${siteName}]`, { level: 'error', event: 'first_page_gate_exhausted', context: { page: pageNo, site: siteName }, site: siteName });
              return { pageData: [], failed: true, gateAbort: true };
            }
            log(`第 1 页网络失败已换 IP（${sw2.from} → ${sw2.to}），继续探针重试`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw2.from, to: sw2.to, site: siteName }, site: siteName });
            retries = 0;
            triedFallback = false;
            method = String(siteConfig.method || 'GET').toUpperCase();
            await new Promise(r => setTimeout(r, backoffDelay(0)));
            continue;
          }
          // 非首页：换一次仍失败即跳过该页（不限于第1页，避免数据丢失）
          if (sw2.ok && !triedSwitch) {
            triedSwitch = true;
            log(`第 ${pageNo} 页网络失败已换 IP，立即重试该页`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw2.from, to: sw2.to, site: siteName }, site: siteName });
            retries = 0;
            triedFallback = false;
            method = String(siteConfig.method || 'GET').toUpperCase();
            await new Promise(r => setTimeout(r, backoffDelay(0)));
            continue;
          }
        }
        log(`第 ${pageNo} 页加载失败，已达到最大重试次数，跳过此页 [code=${error.code} status=${errStatus} method=${method}]`, { level: 'error', event: 'page_failed', context: { page: pageNo, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
        return { pageData: [], failed: true, status: errStatus };
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  // 终局兜底：重试额度耗尽仍未返回（防御性），确保 crawlPage 永不隐式返回 undefined
  // 换点兜底：不限于第1页，换 IP 成功则递归重试一次（防数据丢失）
  if (!triedSwitch) {
    let sw3 = makeSwitchResult();
    try { sw3 = await trySwitchProxy(siteConfig, pageNo === 1 ? 'first_page_exhausted' : 'exhausted'); } catch (_) {}
    if (sw3.ok) {
      log(`第 ${pageNo} 页重试额度耗尽后已换 IP，立即重试该页`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw3.from, to: sw3.to, site: siteName }, site: siteName });
      return crawlPage(pageNo, siteConfig, existingIds, maxRetries);
    }
  }
  log(`第 ${pageNo} 页加载失败，重试额度耗尽 [code=EXHAUSTED method=${method}]`, { level: 'error', event: 'page_failed', context: { page: pageNo, method, site: siteName }, site: siteName });
  return { pageData: [], failed: true };
}

// 优雅退出标志：SIGINT/SIGTERM 置位后，主循环不再开下一批，等当前批自然完成。
let stopping = false;
let stopSignalCount = 0;
function handleStopSignal(sig) {
  stopSignalCount++;
  if (stopSignalCount >= 2) {
    console.error(`\n收到第二次 ${sig}，立即退出`);
    process.exit(1);
  }
  console.error(`\n收到 ${sig}，等待当前批次完成后优雅退出（再按一次 Ctrl+C 强制退出）...`);
  stopping = true;
}
process.on('SIGINT', () => handleStopSignal('SIGINT'));
process.on('SIGTERM', () => handleStopSignal('SIGTERM'));

function isStopping() {
  return stopping;
}

async function sleepInterruptible(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    if (!Number.isFinite(ms)) log(`sleepInterruptible 非法 ms=${String(ms)}，已跳过`, { level: 'warn', event: 'sleep_invalid', context: { ms: String(ms) } });
    return !stopping;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopping) return false;
    await new Promise(r => setTimeout(r, Math.min(1000, end - Date.now())));
  }
  return !stopping;
}

function loadCheckpoint(site) {
  const file = stateFile(site);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    let cp = Number(raw.currentPage);
    if (!Number.isFinite(cp) || !Number.isInteger(cp) || cp < 1) {
      log(`checkpoint currentPage 非法 (${String(raw.currentPage)})，已丢弃重跑`, { level: 'warn', event: 'checkpoint_invalid', context: { raw: String(raw.currentPage), site: normalizeSite(site) }, site: normalizeSite(site) });
      return null;
    }
    let ids = raw.existingIds;
    if (!Array.isArray(ids)) ids = [];
    ids = ids.filter(x => typeof x === 'string' && x);
    return {
      currentPage: cp,
      existingIds: new Set(ids)
    };
  } catch (error) {
    log(`checkpoint 读取失败，从头开始：${error.message}`, { level: 'warn', event: 'checkpoint_load_failed', context: { error: error.message, site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
}

function saveCheckpoint(site, currentPage, existingIds) {
  const file = stateFile(site);
  const state = { currentPage, existingIds: Array.from(existingIds) };
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
}

function clearCheckpoint(site) {
  const file = stateFile(site);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function normalizeCrawlArgs(a, b, c, d) {
  // 支持：
  // crawl({ site, totalPages, interval, maxRetries })
  // crawl(site, totalPages, interval, maxRetries)
  // crawl(totalPages, interval, maxRetries) 旧签名
  // crawl(totalPages, interval) 旧签名
  if (a && typeof a === 'object' && !Array.isArray(a) && (a.site !== undefined || a.totalPages !== undefined)) {
    return {
      site: normalizeSite(a.site || process.env.SITE || 'yfbzb'),
      totalPages: a.totalPages ?? 100,
      interval: a.interval ?? 5000,
      maxRetries: a.maxRetries ?? 3
    };
  }
  if (typeof a === 'string') {
    return {
      site: normalizeSite(a),
      totalPages: b ?? 100,
      interval: c ?? 5000,
      maxRetries: d ?? 3
    };
  }
  return {
    site: normalizeSite(process.env.SITE || 'yfbzb'),
    totalPages: a ?? 100,
    interval: b ?? 5000,
    maxRetries: c ?? 3
  };
}

// 多站共用同一代理出口的登记（proxyUrl -> 站点集合，crawl() 启动时写入）。
// Agent 隧道按站隔离，但同一入口的端口/出口池仍可能被多个站点共用，因此保留告警。
const _proxySharedExit = new Map();

async function crawl(a, b, c, d) {
  const { site, totalPages, interval, maxRetries } = normalizeCrawlArgs(a, b, c, d);
  const siteConfig = getSiteConfig(site);
  // 站点配置对象由 registry 复用；每轮从环境变量指定的初始端口开始，
  // 不把上轮 405 换点后的 runtimeProxyUrl 带入下一轮。
  delete siteConfig.runtimeProxyUrl;
  // 每轮运行清空换点轮换记忆与节点快照：上轮试过的节点本轮允许重新尝试（WAF 封禁状态
  // 随时间变化），快照只在构建它的一轮内被信任，防订阅变更后被旧快照锁死于假轮尽。
  // 键统一走 rotateKey，与 trySwitchProxy 写侧一致（原写原始名/删 normalizeSite 名两链会错位——审查 #2）
  _proxyRotate.delete(rotateKey(site));
  if (getProxyAgents._leafCache) getProxyAgents._leafCache.delete(rotateKey(site));
  _proxySwitchQueue.delete(rotateKey(site));
  // 清理 _proxySharedExit 中已不在启用列表的站点，避免已下线站点持续触发 proxy_shared_exit 告警（#6）
  try {
    const { parseSitesList } = require('./sites');
    const enabledSet = new Set(parseSitesList().map(s => s.toLowerCase()));
    for (const [pUrl, set] of _proxySharedExit) {
      for (const s of [...set]) { if (!enabledSet.has(s)) set.delete(s); }
      if (set.size === 0) _proxySharedExit.delete(pUrl);
    }
  } catch (_) {}
  const batchSize = siteConfig.batchSize ?? BATCH_SIZE;
  const failureThreshold = siteConfig.failureThreshold ?? FAILURE_STOP_THRESHOLD;
  const startedAt = Date.now();
  log(`开始爬取 [${site}]，总页数：${totalPages}，间隔时间：${interval}毫秒`, { event: 'crawl_start', context: { site, totalPages, interval, maxRetries }, site });
  // 代理状态（ceb 换 IP 绕过 WAF）：仅当解析到代理且非 NO_PROXY 时打印，便于排查
  try {
    const _proxyUrl = resolveProxyUrl(siteConfig);
    if (_proxyUrl) {
      const sampleUrl = typeof siteConfig.buildUrl === 'function' ? siteConfig.buildUrl.call(siteConfig, 1) : defaultBuildUrl(1, siteConfig);
      if (!isNoProxy(sampleUrl, siteConfig)) {
        log(`站点 [${site}] 已启用代理：${desensitizeProxyUrl(_proxyUrl)}`, { event: 'proxy_enabled', context: { site, proxy: desensitizeProxyUrl(_proxyUrl) }, site });
        // 多站共用同一代理出口时提示换点互踩风险：Agent 隧道已按站隔离，
        // 但共享入口的端口池可能使 A 站换点影响 B 站后续请求的出口。
        const siteKey = rotateKey(site);
        if (!_proxySharedExit.has(_proxyUrl)) _proxySharedExit.set(_proxyUrl, new Set());
        _proxySharedExit.get(_proxyUrl).add(siteKey);
        const siblings = [..._proxySharedExit.get(_proxyUrl)].filter(s => s !== siteKey);
        if (siblings.length) {
          log(`站点 [${site}] 与 [${siblings.join(', ')}] 共用同一代理出口，换点将互相影响对方出口`, { level: 'warn', event: 'proxy_shared_exit', context: { site, siblings }, site });
        }
      } else {
        log(`站点 [${site}] 代理已配置但命中 NO_PROXY，直连`, { event: 'proxy_bypassed', context: { site, proxy: desensitizeProxyUrl(_proxyUrl) }, site });
      }
    }
  } catch (_) {}
  // 每轮爬取前先刷新代理订阅：先刷新保证本轮换点（尤其第一页探针）拿到最新节点；
  // provider 内部限频，失败不阻塞本轮。
  try {
    const _refreshUrl = resolveProxyUrl(siteConfig);
    const _provider = getProxyProvider(siteConfig, _refreshUrl);
    if (_refreshUrl && _provider && typeof _provider.refreshProviders === 'function') {
      await _provider.refreshProviders({ site, reason: 'crawl_start', siteConfig, proxyUrl: _refreshUrl });
    }
  } catch (_) {}
  const allData = {};

  const checkpoint = loadCheckpoint(site);
  let currentPage;
  let existingIds;
  if (checkpoint) {
    currentPage = checkpoint.currentPage;
    existingIds = checkpoint.existingIds;
    log(`从 checkpoint 续跑 [${site}]，起始页 ${currentPage}，已记录 ${existingIds.size} 个 id`, { event: 'checkpoint_resume', context: { site, currentPage, knownIds: existingIds.size }, site });
  } else {
    currentPage = 1;
    existingIds = readRecentIds(site);
  }

  let shouldStopCrawling = false;
  let stoppedBySignal = false;
  let totalNew = 0;
  let totalFailed = 0;
  let endReached = false;
  let consecutive405 = 0;
  // 双 405 触发的成功换点次数（单轮运行内）：换点成功即重置 consecutive405 给新出口观察页
  let proxy405Switches = 0;
  // 网络级连败（ECONNRESET/超时等无 status 失败）：代理站点达阈值换 IP，再连败至翻倍熔断；成功/边界页清零。
  // netFailSwitched：本轮连败是否已尝试过换 IP（保证熔断前至少真换一次，批次站单批即可越过换 IP 阈值）
  let netFailStreak = 0;
  let netFailSwitched = false;
  // 第一页探针轮尽：所有代理节点均失败，判定出口不可用，取消本次抓取
  let gateAborted = false;
  // 站点分页自报的真实总页数（后观测覆盖前观测，总量可能随发布增长）；
  // 实际生效上限 = min(配置 totalPages, 观测值)，未观测到时等于配置
  let realTotalPagesObserved;
  let effectiveTotalPages = totalPages;

  while (currentPage <= effectiveTotalPages && !shouldStopCrawling) {
    if (stopping) {
      stoppedBySignal = true;
      break;
    }
    const pagesToCrawl = Math.min(batchSize, effectiveTotalPages - currentPage + 1);
    const crawlPromises = [];

    for (let i = 0; i < pagesToCrawl; i++) {
      crawlPromises.push(crawlPage(currentPage + i, siteConfig, existingIds, maxRetries));
    }

    const results = await Promise.all(crawlPromises);
    let hasNewDataInBatch = false;
    let failedCount = 0;
    let batchEndReached = false;

    for (let i = 0; i < results.length; i++) {
      const { pageData, failed, endReached: ended, status } = results[i];
      const pageNo = currentPage + i;

      if (failed) {
        failedCount++;
        totalFailed++;
        // 第一页探针轮尽：所有代理节点均失败，后续页必然同样被拦/不通，取消本次抓取
        if (results[i].gateAbort) {
          gateAborted = true;
          log(`第一页在所有代理节点上均失败，判定出口全部不可用，取消本次抓取 [${site}]`, { level: 'error', event: 'first_page_gate_abort', context: { site, page: pageNo }, site });
          shouldStopCrawling = true;
          continue;
        }
        // 405 连击：换点成功即清零（给新出口一个完整请求的观察窗，避免未验证先熔断），否则累计
        if (status === 405) {
          if (results[i].proxySwitched) {
            consecutive405 = 0;
            proxy405Switches++;
            log(`第 ${pageNo} 页双 405 但已换 IP，重置连续拦截计数，新出口观察中（本轮已换 ${proxy405Switches} 次）`, { level: 'warn', event: 'proxy_switched_reset_405', context: { page: pageNo, site, switches: proxy405Switches }, site });
          } else {
            consecutive405++;
          }
        }
        log(`第 ${pageNo} 页爬取失败，已跳过`, { level: 'warn', event: 'page_skipped', context: { page: pageNo, site, status, proxySwitched: !!results[i].proxySwitched, proxyExhausted: !!results[i].proxyExhausted }, site });
        // 网络级失败（无 status：ECONNRESET/超时/TLS 断开）计数，代理站点达阈值换 IP、再连败熔断；
        // 有 status 的失败（403/405 等已到服务器）说明链路连通，不计入
        if (status === undefined || status === null) netFailStreak++;
        continue;
      }

      // 非失败页（成功或边界）重置 405 熔断计数与网络连败计数，并清空换点轮换记忆
      // 与节点快照（下轮可从头再试各节点、按最新订阅重发现）
      consecutive405 = 0;
      netFailStreak = 0;
      netFailSwitched = false;
      _proxyRotate.delete(rotateKey(site));
      if (getProxyAgents._leafCache) getProxyAgents._leafCache.delete(rotateKey(site));
      _proxySwitchQueue.delete(rotateKey(site));

      if (ended) {
        batchEndReached = true;
        continue;
      }

      let pageNew = 0;
      if (pageData.length) {
        let batchNew = 0;
        for (const item of pageData) {
          if (existingIds.has(item.id)) continue;
          if (!allData[item.publishTime]) allData[item.publishTime] = [];
          allData[item.publishTime].push(item);
          existingIds.add(item.id);
          totalNew++;
          batchNew++;
        }
        if (batchNew) hasNewDataInBatch = true;
        pageNew = batchNew;
      }
      log(`第 ${pageNo} 页爬取完成，${pageNew ? '有' : '没有'}新数据`, { event: 'page_done', context: { page: pageNo, newCount: pageNew, site }, site });
    }

    currentPage += pagesToCrawl;

    // 站点自报真实总页数合并：后观测覆盖前观测，每批重算有效上限；
    // 收窄到低于当前页时由循环条件自然退出（等价于「已到底」）
    for (const r of results) {
      const rt = r && r.realTotalPages;
      if (Number.isInteger(rt) && rt > 0) realTotalPagesObserved = rt;
    }
    if (realTotalPagesObserved !== undefined) {
      const nextCap = Math.min(totalPages, realTotalPagesObserved);
      if (nextCap !== effectiveTotalPages) {
        effectiveTotalPages = nextCap;
        log(`站点 [${site}] 分页显示真实总页数 ${realTotalPagesObserved}，按 min(${realTotalPagesObserved}, 配置 ${totalPages})=${nextCap} 页爬取`, { event: 'real_total_pages', context: { site, realTotalPages: realTotalPagesObserved, configuredTotalPages: totalPages, effectiveTotalPages: nextCap }, site });
      }
    }

    // 双 405 熔断：换点轮换耗尽后仍连续 2 页 GET→POST 均 405，判定为站点级拦截，避免 100 页空转
    if (consecutive405 >= 2) {
      log(`连续 ${consecutive405} 页 405（GET→POST 双 405，本轮已换 IP ${proxy405Switches} 次），判定为站点级拦截，提前结束 [${site}]（已试 ${currentPage - 1}/${effectiveTotalPages} 页，剩余 ${Math.max(0, effectiveTotalPages - currentPage + 1)} 页不再尝试）`, { level: 'error', event: 'circuit_break_405', context: { site, consecutive405, proxySwitches405: proxy405Switches, triedPages: currentPage - 1, totalPages, effectiveTotalPages, realTotalPages: realTotalPagesObserved ?? null }, site });
      shouldStopCrawling = true;
    } else if (netFailStreak >= NET_FAIL_SWITCH_THRESHOLD && !netFailSwitched) {
      // 网络连败换 IP：仅配置了可切换 provider 的代理站点生效，直连站为 no-op。
      // 每轮连败只切一次并给新节点观察窗口（继续失败至熔断阈值才停），避免逐批反复切点打转
      let sw = makeSwitchResult();
      try { sw = await trySwitchProxy(siteConfig, 'net_fail_streak'); } catch (_) {}
      netFailSwitched = true;
      log(`连续 ${netFailStreak} 页网络级失败（ECONNRESET/超时）${sw.ok ? `，已切换代理节点 → ${sw.to}` : '，未配置可切换代理或节点池已轮尽'}，继续爬取 [${site}]`, { level: 'warn', event: 'proxy_switch_net_fail', context: { site, netFailStreak, switched: !!sw.ok }, site });
    } else if (netFailStreak >= NET_FAIL_BREAK_THRESHOLD && netFailSwitched) {
      // 换 IP 后仍连败：出口节点整体不可用，熔断避免空转（2026-08-24 曾 5 轮 × ~67 分钟全页失败）
      log(`连续 ${netFailStreak} 页网络级失败且已尝试换 IP 仍失败，判定代理出口不可用，提前结束 [${site}]（已试 ${currentPage - 1}/${effectiveTotalPages} 页）`, { level: 'error', event: 'circuit_break_net_fail', context: { site, netFailStreak, triedPages: currentPage - 1, totalPages, effectiveTotalPages, realTotalPages: realTotalPagesObserved ?? null }, site });
      shouldStopCrawling = true;
    } else if (batchEndReached) {
      endReached = true;
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount === 0) {
      log(`当前批次（第 ${currentPage - pagesToCrawl} 到第 ${currentPage - 1} 页）无新数据，停止爬取`, { event: 'early_stop', context: { failedCount, threshold: failureThreshold, site }, site });
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount > 0 && !gateAborted) {
      // 有失败页时不早停，避免掩盖数据；原阈值仅用于分级（batchSize=1 时单次失败曾误触发早停）
      // gateAborted 已由第一页探针轮尽置位并取消抓取，无需再提示"继续爬取下一批"
      log(`当前批次无新数据，但失败 ${failedCount} 页（阈值 ${failureThreshold}），失败页可能掩盖新数据，继续爬取下一批`, { level: 'warn', event: 'continue_despite_failures', context: { failedCount, threshold: failureThreshold, site }, site });
    }

    if (!shouldStopCrawling) {
      saveCheckpoint(site, currentPage, existingIds);
    }

    if (stopping) {
      shouldStopCrawling = true;
    }

    if (!shouldStopCrawling) {
      const ok = await sleepInterruptible(interval);
      if (!ok || stopping) shouldStopCrawling = true;
    }
  }

  let fileWriteFailed = 0;
  let fileWriteSucceeded = 0;
  const failedIds = new Set();
  const createdDirs = new Set();
  if (Object.keys(allData).length === 0) {
    log('没有爬取到任何新数据', { event: 'no_new_data', context: { site }, site });
  } else {
    for (const [publishTime, data] of Object.entries(allData)) {
      const fileName = path.join(fileDir(site), `${publishTime.replace(/\//g, '-')}.xlsx`);
      const dirName = path.dirname(fileName);
      // 同一批次同 site 目录相同，失败仅告警一次，避免刷屏
      try {
        if (!createdDirs.has(dirName)) {
          fs.mkdirSync(dirName, { recursive: true });
          createdDirs.add(dirName);
        }
      } catch (e) {
        const code = e.code || e.errno || 'UNKNOWN';
        if (!createdDirs.has(dirName)) {
          log(`创建目录失败 ${dirName}: ${e.message} code=${code}，本批 ${data.length} 条数据暂无法落盘`, { level: 'error', event: 'file_mkdir_failed', context: { file: fileName, error: e.message, code, site }, site });
          createdDirs.add(dirName);
        }
        fileWriteFailed++;
        for (const item of data) failedIds.add(item.id);
        continue;
      }

      try {
        let existingFileData = [];
        if (fs.existsSync(fileName)) {
          const rows = readXlsxRowsSafe(fileName, site, 'merge_read_failed');
          if (rows === null) {
            try {
              const bak = `${fileName}.corrupt.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
              fs.renameSync(fileName, bak);
              log(`已备份损坏文件 ${fileName} → ${bak}`, { level: 'warn', event: 'corrupt_backed_up', context: { file: fileName, bak, site }, site });
            } catch (renameErr) {
              const code = renameErr.code || renameErr.errno || 'UNKNOWN';
              log(`备份损坏文件失败 ${fileName}: ${renameErr.message} code=${code}`, { level: 'warn', event: 'corrupt_backup_failed', context: { file: fileName, error: renameErr.message, code, site }, site });
            }
          } else {
            existingFileData = rows;
          }
        }

        const newIds = new Set(data.map(item => item.id));
        const combinedData = [...data, ...existingFileData.filter(item => !newIds.has(item.id))];

        const ws = xlsx.utils.json_to_sheet(combinedData);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
        xlsx.writeFile(wb, fileName);

        fileWriteSucceeded++;
        log(`更新文件 ${fileName}，新增 ${data.length} 条记录`, { event: 'file_written', context: { file: fileName, newCount: data.length, site }, site });
      } catch (e) {
        const code = e.code || e.errno || 'UNKNOWN';
        fileWriteFailed++;
        for (const item of data) failedIds.add(item.id);
        log(`写入文件失败 ${fileName}: ${e.message} code=${code}，本批 ${data.length} 条数据暂未落盘，将随 checkpoint 重试`, { level: 'error', event: 'file_write_failed', context: { file: fileName, error: e.message, code, site }, site });
      }
    }
  }

  // 落盘失败的 id 回滚出 existingIds，避免 checkpoint 将未落盘数据标记为已爬
  if (failedIds.size) {
    for (const id of failedIds) existingIds.delete(id);
  }

  if (stoppedBySignal) {
    saveCheckpoint(site, currentPage, existingIds);
    log(`已优雅退出，checkpoint 已保存（起始页 ${currentPage}），下次将续跑`, { level: 'warn', event: 'graceful_exit', context: { currentPage, site }, site });
  } else if (fileWriteFailed > 0) {
    saveCheckpoint(site, currentPage, existingIds);
    log(`部分文件落盘失败 ${fileWriteFailed} 个日期（成功 ${fileWriteSucceeded} 个），已保留 checkpoint（起始页 ${currentPage}）待下次重试，未落盘数据不计入去重`, { level: 'error', event: 'checkpoint_retained_on_file_error', context: { site, fileWriteFailed, fileWriteSucceeded, currentPage, failedIds: failedIds.size }, site });
  } else {
    clearCheckpoint(site);
  }

  const durationMs = Date.now() - startedAt;
  const totalPersisted = totalNew - failedIds.size;
  const crawlLevel = fileWriteFailed > 0 ? 'warn' : 'info';
  const narrowedSuffix = realTotalPagesObserved !== undefined && effectiveTotalPages < totalPages ? `，站点总页数 ${realTotalPagesObserved}，按 ${effectiveTotalPages} 页停止` : '';
  const gateSuffix = gateAborted ? '，第一页探针轮尽已取消抓取' : '';
  log(`爬取任务完成 [${site}]：新增 ${totalNew} 条（已落盘 ${totalPersisted} 条，失败 ${failedIds.size} 条），失败 ${totalFailed} 页，${endReached ? '触达站点边界' : '未触达边界'}，耗时 ${(durationMs / 1000).toFixed(1)}s${fileWriteFailed ? `，文件失败 ${fileWriteFailed} 个日期` : ''}${narrowedSuffix}${gateSuffix}`, { level: crawlLevel, event: 'crawl_end', context: { totalNew, totalPersisted, fileWriteFailed, fileWriteSucceeded, failedIds: failedIds.size, totalFailed, endReached, durationMs, stoppedBySignal, gateAborted, configuredTotalPages: totalPages, realTotalPages: realTotalPagesObserved ?? null, effectiveTotalPages, site }, site });
}

function readRecentIds(site) {
  const ids = new Set();
  const dir = fileDir(site);

  if (fs.existsSync(dir)) {
    const nowMs = Date.now();
    const today = shanghaiDateStr(0, nowMs);
    const yesterday = shanghaiDateStr(-1, nowMs);
    for (const name of [`${today}.xlsx`, `${yesterday}.xlsx`]) {
      const filePath = path.join(dir, name);
      if (!fs.existsSync(filePath)) continue;
      const rows = readXlsxRowsSafe(filePath, site);
      if (!rows) continue;
      for (const row of rows) {
        if (row.id) ids.add(row.id);
      }
    }
  }

  return ids;
}

module.exports = { crawl, crawlPage, backoffDelay, readRecentIds, fileDir, stateFile, isStopping, sleepInterruptible, extractRealTotalPages, resolveProxyUrl, getProxyAgents, desensitizeProxyUrl, isNoProxy, trySwitchProxy, refreshProxyProviders, BATCH_SIZE, FAILURE_STOP_THRESHOLD, REQUEST_TIMEOUT, USER_AGENT, NET_FAIL_SWITCH_THRESHOLD, NET_FAIL_BREAK_THRESHOLD };
