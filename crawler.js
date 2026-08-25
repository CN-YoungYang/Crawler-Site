const axios = require('axios');
const cheerio = require('cheerio');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { getSiteConfig, normalizeSite } = require('./sites');
const { defaultBuildUrl, defaultIsBoundary, defaultParse, defaultExtractId } = require('./sites/_base');

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
// 值形如 http://127.0.0.1:7890 或 http://user:pass@host:port；NO_PROXY 直连白名单
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

function getProxyAgents(siteConfig, targetUrl) {
  const proxyUrl = resolveProxyUrl(siteConfig);
  if (!proxyUrl) return null;
  if (targetUrl && isNoProxy(targetUrl, siteConfig)) return null;
  try { new URL(proxyUrl); } catch (e) {
    log(`代理地址无效，已回退直连：${desensitizeProxyUrl(proxyUrl)} (${e.message})`, { level: 'warn', event: 'proxy_invalid', context: { proxy: desensitizeProxyUrl(proxyUrl), site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
  // 复用 Agent，避免每页新建导致 socket 泄漏（尤其 batchSize 并发）
  if (!getProxyAgents._cache) getProxyAgents._cache = new Map();
  const cached = getProxyAgents._cache.get(proxyUrl);
  if (cached) return cached;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { HttpProxyAgent } = require('http-proxy-agent');
    const entry = {
      proxyUrl,
      httpAgent: new HttpProxyAgent(proxyUrl, { keepAlive: true }),
      httpsAgent: new HttpsProxyAgent(proxyUrl, { keepAlive: true })
    };
    getProxyAgents._cache.set(proxyUrl, entry);
    return entry;
  } catch (e) {
    log(`代理组件加载失败，已回退直连：${e.message}`, { level: 'warn', event: 'proxy_agent_failed', context: { error: e.message, site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
}

// 单页双 405 秒级换 IP：仅 mihomo 场景，通过 external-controller 切节点
async function trySwitchProxy(siteConfig, reason) {
  const proxyUrl = resolveProxyUrl(siteConfig);
  if (!proxyUrl) return false;
  const siteName = (siteConfig && siteConfig.name) || '';
  let host = '';
  try { host = new URL(proxyUrl).hostname.toLowerCase(); } catch (_) { return false; }
  const isMihomo = host === 'mihomo' || host === '127.0.0.1' || host === 'localhost' || proxyUrl.includes('mihomo:7890') || proxyUrl.includes('127.0.0.1:7890');
  if (!isMihomo) return false;
  const controllers = [];
  if (process.env.MIHOMO_CONTROLLER) controllers.push(process.env.MIHOMO_CONTROLLER);
  controllers.push('http://mihomo:9090', 'http://127.0.0.1:9090');
  const secret = process.env.MIHOMO_SECRET || '';
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  for (const base of controllers) {
    try {
      // 取当前组与可用节点
      const listRes = await axios.get(`${base}/proxies`, { timeout: 2000, headers, proxy: false });
      const proxies = listRes.data && listRes.data.proxies ? listRes.data.proxies : {};
      const group = proxies.PROXY || proxies.proxy || null;
      if (!group) continue;
      const now = group.now || '';
      // 收集可切目标：优先同组 all，其次 remote 池
      const candidates = [];
      if (Array.isArray(group.all)) candidates.push(...group.all);
      // 从 providers/remote 也可枚举，但 all 已含 use: remote 的展开
      const next = candidates.find(n => n !== now && n !== 'DIRECT' && n.toLowerCase() !== 'direct') || candidates.find(n => n !== now);
      if (!next) continue;
      await axios.put(`${base}/proxies/PROXY`, { name: next }, { timeout: 2000, headers, proxy: false });
      log(`代理已切换 [${siteName}] ${reason}：${now || 'unknown'} → ${next}`, { event: 'proxy_switched', context: { site: siteName, from: now, to: next, reason, controller: base }, site: siteName });
      return true;
    } catch (e) {
      // 试下一个控制器
      continue;
    }
  }
  log(`代理切换失败 [${siteName}] ${reason}`, { level: 'warn', event: 'proxy_switch_failed', context: { site: siteName, reason }, site: siteName });
  return false;
}

// 上海时区日期（UTC+8，无夏令时），用同一 nowMs 避免跨午夜竞态
function shanghaiDateStr(offsetDays = 0, nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

// xlsx 魔数校验（zip PK\x03\x04），抽公用避免三处重复
function hasValidXlsxHeader(filePath) {
  let fd;
  try {
    const head = Buffer.alloc(4);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, head, 0, 4, 0);
    return bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

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
        const pageData = await siteConfig.parse(cheerio.load(response.data), response.data, existingIds, siteConfig);
        const filtered = Array.isArray(pageData) ? pageData.filter(item => !existingIds.has(item.id)) : [];
        log(`爬取完成第 ${pageNo} 页，共找到 ${filtered.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: filtered.length, site: siteName }, site: siteName });
        return { pageData: filtered, failed: false };
      }

      const $ = cheerio.load(response.data);
      const selectors = siteConfig.selectors || require('./sites/yfbzb').selectors;
      const rows = $(selectors.rows);

      if (rows.length === 0) {
        log(`第 ${pageNo} 页没有找到任何数据`, { event: 'page_empty', context: { page: pageNo, site: siteName }, site: siteName });
        return { pageData: [], failed: false };
      }

      // 走默认 selectors 解析（委托 _base）
      const pageData = defaultParse($, response.data, existingIds, { ...siteConfig, linkPrefix, extractId: siteConfig.extractId || defaultExtractId });

      log(`爬取完成第 ${pageNo} 页，共找到 ${pageData.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: pageData.length, site: siteName }, site: siteName });
      return { pageData, failed: false };
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
        // 单页即换 IP：mihomo 场景下秒级切节点，避免攒够 consecutive405 才熔断
        try { await trySwitchProxy(siteConfig, 'dual405'); } catch (_) {}
        return { pageData: [], failed: true, status: errStatus };
      }
      retries++;
      const backoff = backoffDelay(retries - 1);
      const snippet405 = errStatus === 405 ? formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim() : '';
      const extra405 = snippet405 ? ` snippet=${snippet405.slice(0, 80)}` : '';
      log(`第 ${pageNo} 页加载失败 [code=${error.code} status=${errStatus} method=${method}${extra405}]：${error.message}，正在进行第 ${retries} 次重试，${backoff}ms 后...`, { level: 'warn', event: 'retry', context: { page: pageNo, attempt: retries, backoffMs: backoff, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
      if (retries >= maxRetries) {
        log(`第 ${pageNo} 页加载失败，已达到最大重试次数，跳过此页 [code=${error.code} status=${errStatus} method=${method}]`, { level: 'error', event: 'page_failed', context: { page: pageNo, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
        return { pageData: [], failed: true, status: errStatus };
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  // 终局兜底：重试额度耗尽仍未返回（防御性），确保 crawlPage 永不隐式返回 undefined
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

// 本地可中断休眠（与 index.js#sleepInterruptible 同逻辑，避免 index↔crawler 循环依赖）
async function sleepInterruptibleLocal(ms) {
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

async function crawl(a, b, c, d) {
  const { site, totalPages, interval, maxRetries } = normalizeCrawlArgs(a, b, c, d);
  const siteConfig = getSiteConfig(site);
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
      } else {
        log(`站点 [${site}] 代理已配置但命中 NO_PROXY，直连`, { event: 'proxy_bypassed', context: { site, proxy: desensitizeProxyUrl(_proxyUrl) }, site });
      }
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
  // 网络级连败（ECONNRESET/超时等无 status 失败）：代理站点达阈值换 IP，再连败至翻倍熔断；成功/边界页清零。
  // netFailSwitched：本轮连败是否已尝试过换 IP（保证熔断前至少真换一次，批次站单批即可越过换 IP 阈值）
  let netFailStreak = 0;
  let netFailSwitched = false;

  while (currentPage <= totalPages && !shouldStopCrawling) {
    if (stopping) {
      stoppedBySignal = true;
      break;
    }
    const pagesToCrawl = Math.min(batchSize, totalPages - currentPage + 1);
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
        if (status === 405) consecutive405++;
        // 非 405 失败不重置，避免 405/超时交替时永不熔断
        log(`第 ${pageNo} 页爬取失败，已跳过`, { level: 'warn', event: 'page_skipped', context: { page: pageNo, site, status }, site });
        // 网络级失败（无 status：ECONNRESET/超时/TLS 断开）计数，代理站点达阈值换 IP、再连败熔断；
        // 有 status 的失败（403/405 等已到服务器）说明链路连通，不计入
        if (status === undefined || status === null) netFailStreak++;
        continue;
      }

      // 非失败页（成功或边界）重置 405 熔断计数与网络连败计数
      consecutive405 = 0;
      netFailStreak = 0;
      netFailSwitched = false;

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

    // 双 405 熔断：连续 2 页 GET→POST 均 405，判定为站点级拦截/配置失效，避免 100 页空转
    if (consecutive405 >= 2) {
      log(`连续 ${consecutive405} 页 405（GET→POST 双 405），判定为站点级拦截，提前结束 [${site}]（已试 ${currentPage - 1}/${totalPages} 页，剩余 ${Math.max(0, totalPages - currentPage + 1)} 页不再尝试）`, { level: 'error', event: 'circuit_break_405', context: { site, consecutive405, triedPages: currentPage - 1, totalPages }, site });
      shouldStopCrawling = true;
    } else if (netFailStreak >= NET_FAIL_SWITCH_THRESHOLD && !netFailSwitched) {
      // 网络连败换 IP：仅代理站点生效（trySwitchProxy 内部识别 mihomo，直连站为 no-op）。
      // 每轮连败只切一次并给新节点观察窗口（继续失败至熔断阈值才停），避免逐批反复切点打转
      let switched = false;
      try { switched = await trySwitchProxy(siteConfig, 'net_fail_streak'); } catch (_) {}
      netFailSwitched = true;
      log(`连续 ${netFailStreak} 页网络级失败（ECONNRESET/超时）${switched ? '，已切换代理节点' : '，未配置可切换代理'}，继续爬取 [${site}]`, { level: 'warn', event: 'proxy_switch_net_fail', context: { site, netFailStreak, switched }, site });
    } else if (netFailStreak >= NET_FAIL_BREAK_THRESHOLD && netFailSwitched) {
      // 换 IP 后仍连败：出口节点整体不可用，熔断避免空转（2026-08-24 曾 5 轮 × ~67 分钟全页失败）
      log(`连续 ${netFailStreak} 页网络级失败且已尝试换 IP 仍失败，判定代理出口不可用，提前结束 [${site}]（已试 ${currentPage - 1}/${totalPages} 页）`, { level: 'error', event: 'circuit_break_net_fail', context: { site, netFailStreak, triedPages: currentPage - 1, totalPages }, site });
      shouldStopCrawling = true;
    } else if (batchEndReached) {
      endReached = true;
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount === 0) {
      log(`当前批次（第 ${currentPage - pagesToCrawl} 到第 ${currentPage - 1} 页）无新数据，停止爬取`, { event: 'early_stop', context: { failedCount, threshold: failureThreshold, site }, site });
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount > 0) {
      // 有失败页时不早停，避免掩盖数据；原阈值仅用于分级（batchSize=1 时单次失败曾误触发早停）
      log(`当前批次无新数据，但失败 ${failedCount} 页（阈值 ${failureThreshold}），失败页可能掩盖新数据，继续爬取下一批`, { level: 'warn', event: 'continue_despite_failures', context: { failedCount, threshold: failureThreshold, site }, site });
    }

    if (!shouldStopCrawling) {
      saveCheckpoint(site, currentPage, existingIds);
    }

    if (stopping) {
      shouldStopCrawling = true;
    }

    if (!shouldStopCrawling) {
      const ok = await sleepInterruptibleLocal(interval);
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
  log(`爬取任务完成 [${site}]：新增 ${totalNew} 条（已落盘 ${totalPersisted} 条，失败 ${failedIds.size} 条），失败 ${totalFailed} 页，${endReached ? '触达站点边界' : '未触达边界'}，耗时 ${(durationMs / 1000).toFixed(1)}s${fileWriteFailed ? `，文件失败 ${fileWriteFailed} 个日期` : ''}`, { level: crawlLevel, event: 'crawl_end', context: { totalNew, totalPersisted, fileWriteFailed, fileWriteSucceeded, failedIds: failedIds.size, totalFailed, endReached, durationMs, stoppedBySignal, site }, site });
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

module.exports = { crawl, crawlPage, backoffDelay, readRecentIds, fileDir, stateFile, isStopping, resolveProxyUrl, getProxyAgents, desensitizeProxyUrl, isNoProxy, trySwitchProxy, BATCH_SIZE, FAILURE_STOP_THRESHOLD, REQUEST_TIMEOUT, USER_AGENT, NET_FAIL_SWITCH_THRESHOLD, NET_FAIL_BREAK_THRESHOLD };
