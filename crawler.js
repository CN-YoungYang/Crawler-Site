const axios = require('axios');
const cheerio = require('cheerio');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { getSiteConfig, normalizeSite } = require('./sites');
const easyProxies = require('./sites/_easy_proxies');
const { shanghaiDateStr, hasValidXlsxHeader, writeJsonAtomic } = require('./utils');
const proxyRotation = require('./proxyRotation');
const ledger = require('./ledger');
const { createBreaker, NET_FAIL_SWITCH_THRESHOLD, NET_FAIL_BREAK_THRESHOLD } = require('./breaker');

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
// 真实浏览器 UA，避免默认 axios UA 被站点日志一眼识别为爬虫
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- 头部补扫（只在续跑时启用：尾部游标 > 1）----
// 每轮最多补扫的头部页数。取值依据：站点每轮只放行约 30 页（05:09 实测 1-30 通过、31-40 全 468），
// 补扫吃掉一半配额、剩一半推进尾部。默认 15 页，验尸结论出来前不做自适应。
const HEAD_SCAN_MAX_PAGES = Math.max(1, Math.floor(Number(process.env.HEAD_SCAN_MAX_PAGES) || 15));
// 连续几页整页无新增才判定「追平了」。单页不足为凭：页面会漂移，新公告可能正好跨页。
const HEAD_SCAN_ZERO_STREAK = 2;
// 每轮总页数预算：站点每轮只放行约 30 页（2026-10-29 实测 1-30 通过、31-40 全 468），
// 超出部分只会换来一段 468。头部补扫最多吃一半，剩下的留给尾部推进。
const SCAN_PAGE_BUDGET = Math.max(1, Math.floor(Number(process.env.SCAN_PAGE_BUDGET) || 30));
// 同一页连续几轮命中 468 才允许跳过。468 是 IP 级风控，不是数据边界。
const BLOCK_SKIP_ROUNDS = 2;
// 跳过之后最多再复活探测几轮，超过就放弃并升级日志级别。
const PENDING_GIVE_UP_ROUNDS = 3;

// ---- 代理（ceb 换 IP 绕过 WAF，轻量替代浏览器引擎） ----
// 优先级：PROXY_<SITE> / <SITE>_PROXY_URL > PROXY_URL > HTTPS_PROXY/HTTP_PROXY > siteConfig.proxyUrl
// 值形如 http://easy_proxies:24000 或 http://user:pass@host:port；NO_PROXY 直连白名单
// desensitizeProxyUrl 收敛于 proxyRotation.js（单一实现，避免两处逐字重复）
const desensitizeProxyUrl = proxyRotation.desensitizeProxyUrl;

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
  // 本轮换点后的地址由 proxyRotation 实例持有（activeProxyUrl），
  // 不再写回 siteConfig.runtimeProxyUrl——避免每轮可变状态寄居在 registry 单例上。
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

function getProxyAgents(siteConfig, targetUrl, site, overrideProxyUrl) {
  const proxyUrl = overrideProxyUrl || resolveProxyUrl(siteConfig);
  if (!proxyUrl) return null;
  if (targetUrl && isNoProxy(targetUrl, siteConfig)) return null;
  try { new URL(proxyUrl); } catch (e) {
    log(`代理地址无效，已回退直连：${desensitizeProxyUrl(proxyUrl)} (${e.message})`, { level: 'warn', event: 'proxy_invalid', context: { proxy: desensitizeProxyUrl(proxyUrl), site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
  // 复用 Agent，避免每页新建导致 socket 泄漏（尤其 batchSize 并发）。
  // 隧道按站隔离（审查 #1），键与换点记账同源，见 proxyRotation.rotationKey。
  const siteKey = proxyRotation.rotationKey(site || (siteConfig && siteConfig.name) || '');
  try {
    return proxyRotation.getProxyAgentEntry(siteKey, proxyUrl, url => {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { HttpProxyAgent } = require('http-proxy-agent');
      return {
        proxyUrl: url,
        httpAgent: new HttpProxyAgent(url, { keepAlive: true }),
        httpsAgent: new HttpsProxyAgent(url, { keepAlive: true })
      };
    });
  } catch (e) {
    log(`代理组件加载失败，已回退直连：${e.message}`, { level: 'warn', event: 'proxy_agent_failed', context: { error: e.message, site: (siteConfig && siteConfig.name) || '' }, site: (siteConfig && siteConfig.name) || '' });
    return null;
  }
}

// makeSwitchResult / staleNote 收敛于 proxyRotation.js（与换点结果同源，避免多处重复）
const makeSwitchResult = proxyRotation.makeSwitchResult;
const staleNote = proxyRotation.staleNote;

// 双 405/网络连败的秒级换 IP：通过 easy_proxies 控制面切换多端口节点，
// 也可经 siteConfig.switchProxy 按站覆盖；easy_proxies 知识收敛于 sites/_easy_proxies.js。
// 轮换语义、互斥、记账、快照、隧道销毁均已收敛至 proxyRotation 模块（与一轮 crawl() 同生命周期）。
//
// 跨站点的共用出口登记（原 _proxySharedExit）留在本文件：它的键是代理 URL、值是站点集合，
// 是进程级跨站点状态，不属于单站每轮实例。
const _proxySharedExit = new Map();

// 每轮的 rotation 注册表：键为站点名，值为本轮实例。
// 供 crawlPage 在未显式传入 switchProxy 时回退查找（旧签名兼容路径）。
const _rotations = new Map();

function registerRotation(site, rotation) {
  _rotations.set(proxyRotation.rotationKey(site), rotation);
}

function unregisterRotation(site) {
  _rotations.delete(proxyRotation.rotationKey(site));
}

function getRotation(site) {
  return _rotations.get(proxyRotation.rotationKey(site)) || null;
}

async function trySwitchProxy(siteConfig, reason) {
  const site = (siteConfig && siteConfig.name) || '';
  const rotation = getRotation(site);
  if (!rotation) return { ok: false, from: '', to: '', exhausted: false };
  return rotation.switch(reason);
}

// 轮前池子可用数低于这个值才值得整池刷新；高于它说明池子本来就能干活，
// 刷新只会重建隧道、把节点打回「探测中」（ADR 0008）。
const MIN_USABLE_POOL = 3;

// 启动时刷新代理订阅（easy_proxies 读取订阅并生成多端口节点）。
// 供 index.js 程序启动时调用。
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

// 站点是否真的配了可刷新的代理提供方（不是「解析到 HTTP_PROXY」就算）：
// index.js 的启动刷新计数要用它做分母，否则没有代理的站点会把比例算成 1/2。
function hasProxyProvider(site) {
  try {
    const siteConfig = getSiteConfig(site);
    const proxyUrl = resolveProxyUrl(siteConfig);
    return !!proxyUrl && !!getProxyProvider(siteConfig, proxyUrl);
  } catch (_) { return false; }
}

// 轮前准备代理池（ADR 0008）：先读一次 /api/nodes 判断池子状态，再决定要不要整池刷新。
//   - 全部节点在冷却期 → 原样返回，让 crawl() 直接暂停（刷新清不掉冷却表）；
//   - 可用 >= MIN_USABLE_POOL → 跳过刷新，省掉一次隧道重建与 20 秒收敛等待；
//   - 可用不足或管理面查不到 → 刷新（失败不阻塞本轮，沿用现有出口）。
async function prepareProxyPool(siteConfig, site) {
  const proxyUrl = resolveProxyUrl(siteConfig);
  const provider = getProxyProvider(siteConfig, proxyUrl);
  if (!proxyUrl || !provider) return null;
  let status = null;
  try {
    if (typeof provider.poolStatus === 'function') status = await provider.poolStatus(siteConfig, proxyUrl);
  } catch (_) { status = null; }
  if (status && status.allCooled) {
    log(`节点池全部在冷却期（${status.rawCount} 个），跳过轮前刷新 [${site}]`, { level: 'warn', event: 'proxy_pool_all_cooled_at_start', context: { site, rawCount: status.rawCount }, site });
    return status;
  }
  if (status && status.usable >= MIN_USABLE_POOL) {
    log(`节点池可用 ${status.usable} 个（>= ${MIN_USABLE_POOL}），跳过轮前刷新 [${site}]`, { event: 'proxy_pool_ready', context: { site, usable: status.usable, rawCount: status.rawCount }, site });
    return status;
  }
  if (typeof provider.refreshProviders === 'function') {
    await provider.refreshProviders({ site, reason: 'crawl_start', siteConfig, proxyUrl });
    try {
      if (typeof provider.poolStatus === 'function') status = await provider.poolStatus(siteConfig, proxyUrl);
    } catch (_) {}
  }
  return status;
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
// 兼容旧导出名：stateFile() 现在指向 state/<site>/checkpoint.json。
function stateFile(site) {
  return checkpointFile(site);
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

async function crawlPage(pageNo, siteOrBaseUrl, urlSuffixOrExistingIds, existingIdsOrMaxRetries, maxRetriesArg, switchProxyArg) {
  // 兼容旧签名 crawlPage(pageNo, baseUrl, urlSuffix, existingIds, maxRetries)
  // 新签名 crawlPage(pageNo, siteConfig|site, existingIds, maxRetries, switchProxy)
  //
  // switchProxy: async (reason) => { ok, from, to, exhausted }
  // crawlPage 对「换点」的全部需求就是失败时叫一下；试过哪些节点、缓存了什么、
  // 何时销毁隧道都属于 proxyRotation 的实现，不在本函数的接口里。
  let siteConfig;
  let existingIds;
  let maxRetries = 3;
  let switchProxy = switchProxyArg;
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
    // 新签名：第 4 参为 maxRetries，第 5 参为 switchProxy（已由 switchProxyArg 接收）。
    // 不可再用 maxRetriesArg 覆盖 maxRetries——新签名下它会传入回调函数，
    // 使 while (retries < maxRetries) 立即为假、零请求返回 EXHAUSTED。
    if (existingIdsOrMaxRetries !== undefined) maxRetries = existingIdsOrMaxRetries;
  }

  if (!existingIds) existingIds = new Set();
  // 未显式传入 rotation/switchProxy 时的回退（旧签名，或直接调用 crawlPage 的路径）：
  // 优先复用本轮 crawl() 注册的实例；没有则按本站惰性建一个临时实例，
  // 使「直接调 crawlPage」与「经 crawl() 调用」的换点行为一致。
  // 第 5 参可直接传 rotation 实例（新用法），或传 switchProxy 回调（兼容）。
  let rotation = null;
  if (switchProxyArg && typeof switchProxyArg.switch === 'function') {
    rotation = switchProxyArg;
    switchProxy = reason => rotation.switch(reason);
  } else if (typeof switchProxyArg === 'function') {
    switchProxy = switchProxyArg;
  } else {
    rotation = getRotation(siteConfig && siteConfig.name)
      || proxyRotation.createRotation(siteConfig && siteConfig.name, siteConfig, { resolveProxyUrl, getProxyProvider });
    switchProxy = reason => rotation.switch(reason);
  }
  const siteName = siteConfig.name || normalizeSite(siteConfig.name);
  // 第一页探针：pageNo===1 时若当前出口失败则一路换点，直到成功或节点池轮尽（见下方失败处理）。
  // firstPageProbeLimit：站点可限制第一页最多尝试多少个节点；0 = 不设次数上限（ceb，ADR 0008）。
  const isFirstPage = pageNo === 1;
  const firstPageProbeLimit = isFirstPage && Number(siteConfig.firstPageProbeLimit) > 0
    ? Math.max(1, Math.floor(Number(siteConfig.firstPageProbeLimit)))
    : 0;
  let firstPageNodesTried = isFirstPage ? 1 : 0;
  // firstPageProbeTimeoutMs：首页探针的时间上限（ADR 0008）。ceb 不限节点数，
  // 用时间兜底：池子异常大或管理面变慢时，整轮不会卡在首页十几分钟。
  const firstPageProbeTimeoutMs = isFirstPage && Number(siteConfig.firstPageProbeTimeoutMs) > 0
    ? Math.max(1000, Math.floor(Number(siteConfig.firstPageProbeTimeoutMs)))
    : 0;
  const firstPageProbeStartedAt = Date.now();
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
  // WAF 挑战只解一次：求解失败直接按失败页返回，避免未解盾重试把出口 IP 打成 405
  let challengeTried = false;

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

  function firstPageProbeTimedOut() {
    return firstPageProbeTimeoutMs > 0 && Date.now() - firstPageProbeStartedAt >= firstPageProbeTimeoutMs;
  }

  function canTryAnotherFirstPageNode() {
    if (firstPageProbeTimedOut()) return false;
    return !firstPageProbeLimit || firstPageNodesTried < firstPageProbeLimit;
  }

  function noteFirstPageNodeTried() {
    if (isFirstPage) firstPageNodesTried++;
  }

  function firstPageProbeLimitResult(status) {
    log(`第 1 页探针达到上限（已试 ${firstPageNodesTried} 个节点，上限 ${firstPageProbeLimit}），暂停本轮以保护剩余出口 [${siteName}]`, { level: 'warn', event: 'first_page_probe_limited', context: { page: pageNo, status, triedNodes: firstPageNodesTried, limit: firstPageProbeLimit, site: siteName }, site: siteName });
    return { pageData: [], failed: true, status, probeLimitReached: true, gateAbort: true };
  }

  function firstPageProbeTimeoutResult(status) {
    log(`第 1 页探针超过时间上限（${Math.round(firstPageProbeTimeoutMs / 1000)}s，已试 ${firstPageNodesTried} 个节点），暂停本轮 [${siteName}]`, { level: 'warn', event: 'first_page_probe_timeout', context: { page: pageNo, status, triedNodes: firstPageNodesTried, timeoutMs: firstPageProbeTimeoutMs, site: siteName }, site: siteName });
    return { pageData: [], failed: true, status, probeTimeoutReached: true, gateAbort: true };
  }

  // 预算用尽有两种原因（次数上限 / 时间上限），日志与结果字段必须能区分，
  // 否则池子大时会写成「达到上限（已试 N 个节点，上限 0）」这种读不通的话。
  function firstPageBudgetResult(status) {
    return firstPageProbeTimedOut() ? firstPageProbeTimeoutResult(status) : firstPageProbeLimitResult(status);
  }

  function firstPageAllCooledResult(status) {
    log(`第 1 页所有代理节点均在冷却期，暂停本轮以保护出口 [${siteName}]`, { level: 'warn', event: 'first_page_all_cooled', context: { page: pageNo, status, site: siteName }, site: siteName });
    return { pageData: [], failed: true, status, proxyExhausted: true, allCooled: true, gateAbort: true };
  }

  // 405 换点：failFast405（GET 405 直接换）与 GET→POST 双 405 共用。
  // 返回 { retry: true } 表示已换到新出口，调用方 continue 重试当前页；
  // 返回 { result } 表示不再重试（探针限次/节点轮尽/非首页已换过一次）。
  async function switchAfter405(status) {
    // 非首页每页只重试一次：第二次 405 说明新出口也已被拦，不再用第三个节点重试；
    // 并且必须报 proxySwitched:false——否则 breaker 的连续 405 会被无限清零，
    // 逐页烧节点却永远不熔断。仍调用一次 switchNode，把刚被 405 的当前节点
    // 记入冷却；选出的下一个节点留给下一页使用（本页不再请求，故不算换点成功）。
    if (!isFirstPage && triedSwitch) {
      let sw = makeSwitchResult();
      try { sw = await switchProxy('dual405'); } catch (_) {}
      // 本页已经换过一次（重试仍 405），这次换点只用于冷却当前节点、给下一页选出口；
      // 换点次数单独回报，供熔断日志写「换了几次仍被拦」，但不得重置连续 405。
      return { result: { pageData: [], failed: true, status, proxySwitched: false, proxySwitchCount: 1 + (sw.ok ? 1 : 0), proxyExhausted: !!sw.exhausted, allCooled: !!sw.allCooled } };
    }
    // 预算已用尽时仍要冷却当前节点（它确实被 405 拦了），但不能再选一个新出口：
    // 否则日志会先写「已切换节点 X → Y」，下一毫秒又写「探针达到上限」，
    // 读者会以为第 N+1 个节点被试过——实际只有端口被切过去，请求一发没发。
    const budgetLeft = !isFirstPage || canTryAnotherFirstPageNode();
    let sw = makeSwitchResult();
    try { sw = await switchProxy('dual405', { coolOnly: !budgetLeft }); } catch (_) {}
    if (isFirstPage && !budgetLeft) return { result: firstPageBudgetResult(status) };
    if (isFirstPage && (sw.ok || sw.exhausted)) {
      if (sw.exhausted) {
        if (sw.allCooled) return { result: firstPageAllCooledResult(status) };
        log(`第 1 页在所有节点上均被拦（405），判定出口全被拦截，取消本次抓取 [${siteName}]`, { level: 'error', event: 'first_page_gate_exhausted', context: { page: pageNo, status, site: siteName }, site: siteName });
        return { result: { pageData: [], failed: true, status, proxyExhausted: true, gateAbort: true } };
      }
      if (!canTryAnotherFirstPageNode()) return { result: firstPageBudgetResult(status) };
      noteFirstPageNodeTried();
      log(`第 1 页 405 已换 IP（${sw.from} → ${sw.to}）${staleNote(sw.stale)}，继续探针重试`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw.from, to: sw.to, site: siteName, stale: !!sw.stale }, site: siteName });
      await new Promise(r => setTimeout(r, backoffDelay(0)));
      return { retry: true };
    }
    if (sw.ok && !triedSwitch) {
      triedSwitch = true;
      log(`第 ${pageNo} 页 405 已换 IP，立即重试该页${staleNote(sw.stale)}`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw.from, to: sw.to, site: siteName, stale: !!sw.stale }, site: siteName });
      await new Promise(r => setTimeout(r, backoffDelay(0)));
      return { retry: true };
    }
    return { result: { pageData: [], failed: true, status, proxySwitched: false, proxySwitchCount: sw.ok ? 1 : 0, proxyExhausted: !!sw.exhausted, allCooled: !!sw.allCooled } };
  }

  while (retries < maxRetries) {
    try {
      await maybeThrottle();
      // 换点后必须用实例记录的当前出口地址建/取隧道，否则换了节点仍走旧端口
      const proxyAgents = getProxyAgents(siteConfig, url, siteName, rotation ? rotation.currentProxyUrl() : undefined);
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

      // 站点声明的 WAF 挑战（如阿里云 acw）：在沙箱内求解签名 URL 后带 cookie 重放一次。
      // 关键：求解失败必须记为失败页——否则盾页会被 parse 成「0 行」，
      // crawl() 走 !hasNewDataInBatch 早停，表现为「新增 0 条」的静默失败。
      if (!challengeTried && siteConfig.challenge &&
          typeof siteConfig.challenge.detect === 'function' &&
          siteConfig.challenge.detect(response)) {
        challengeTried = true;
        let solved = null;
        try {
          solved = await siteConfig.challenge.solve(response, { url });
        } catch (e) {
          log(`第 ${pageNo} 页 WAF 挑战求解异常：${e.message}`, { level: 'error', event: 'waf_challenge_error', context: { page: pageNo, site: siteName, error: e.message }, site: siteName });
        }
        if (!solved || !solved.url) {
          log(`第 ${pageNo} 页触发 WAF 挑战，求解失败`, { level: 'error', event: 'waf_challenge_unsolved', context: { page: pageNo, site: siteName, status: response.status }, site: siteName });
          return { pageData: [], failed: true, status: response.status, shieldType: 'acw' };
        }
        const replayHeaders = { ...headers, ...(solved.headers || {}) };
        try {
          // 重放也是一发真实请求：与冷请求同样受站点 requestDelay 节流，
          // 否则 ceb 每页两发背靠背，WAF 压力翻倍。
          await maybeThrottle();
          response = await axios.get(solved.url, { timeout, headers: replayHeaders, ...axiosProxyOpts });
        } catch (e) {
          // 重放拿到 HTTP 状态（尤其 405）= 盾未通过；交回 405/POST 流程只会多打一发并延长封禁。
          // 无 status 的网络错误仍抛回外层，走既有的重试/换点/网络连败熔断。
          const replayStatus = e.response && e.response.status;
          if (replayStatus === undefined || replayStatus === null) throw e;
          log(`第 ${pageNo} 页 WAF 挑战重放失败（status=${replayStatus}）`, { level: 'error', event: 'waf_challenge_replay_failed', context: { page: pageNo, site: siteName, status: replayStatus }, site: siteName });
          return { pageData: [], failed: true, status: replayStatus, shieldType: 'acw' };
        }
        if (siteConfig.challenge.detect(response)) {
          log(`第 ${pageNo} 页 WAF 挑战重放后仍被拦截`, { level: 'error', event: 'waf_challenge_blocked', context: { page: pageNo, site: siteName, status: response.status }, site: siteName });
          return { pageData: [], failed: true, status: response.status, shieldType: 'acw' };
        }
        log(`第 ${pageNo} 页已解 WAF 挑战并重放`, { event: 'waf_challenge_solved', context: { page: pageNo, site: siteName }, site: siteName });
      }

      // 优先使用站点自定义 parse 接管整页解析
      if (typeof siteConfig.parse === 'function') {
        const $loaded = cheerio.load(response.data);
        const pageData = await siteConfig.parse($loaded, response.data, existingIds, siteConfig);
        const filtered = Array.isArray(pageData) ? pageData.filter(item => !existingIds.has(item.id)) : [];
        log(`爬取完成第 ${pageNo} 页，共找到 ${filtered.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: filtered.length, site: siteName }, site: siteName });
        const realTotalPages = await extractRealTotalPages(siteConfig, $loaded, response.data);
        // 这里刻意不设 emptyPage：自定义 parse 返回的是「去重后的新行」，零行既可能是
        // 空页也可能是正常的一天没新数据。ceb 的风控页由 challenge 钩子单独识别
        // （shieldType），不依赖这条信号，不能为了统一形状把正常去重误判成出口故障。
        return { pageData: filtered, failed: false, realTotalPages };
      }

      const $ = cheerio.load(response.data);
      const realTotalPages = await extractRealTotalPages(siteConfig, $, response.data);
      const selectors = siteConfig.selectors || require('./sites/yfbzb').selectors;
      const rows = $(selectors.rows);

      if (rows.length === 0) {
        log(`第 ${pageNo} 页没有找到任何数据`, { event: 'page_empty', context: { page: pageNo, site: siteName }, site: siteName });
        // emptyPage：HTTP 200 但零行。没有 challenge 钩子的站点（如 yfbzb）若被换成
        // 另一种 200 形态的风控页，这里就是唯一能看见的信号，不能计入「成功页」。
        return { pageData: [], failed: false, realTotalPages, emptyPage: true };
      }

      // 走默认 selectors 解析（crawler.js 内联 defaultParse）；显式传入解析后的 selectors（含 yfbzb 兜底），
      // 否则缺 selectors 的站点（如旧签名/测试站点）行数检查通过但解析拿到空行
      const pageData = defaultParse($, response.data, existingIds, { ...siteConfig, selectors, linkPrefix, extractId: siteConfig.extractId || defaultExtractId });

      log(`爬取完成第 ${pageNo} 页，共找到 ${pageData.length} 条新数据`, { event: 'page_fetched', context: { page: pageNo, newCount: pageData.length, site: siteName }, site: siteName });
      return { pageData, failed: false, realTotalPages };
    } catch (error) {
      const errStatus = error.response?.status;
      // 站点声明的拦截页（如 yfbzb 的 SafeLine 403 / 468 风控）：命中时不能当边界，
      // 先快败为失败页——同一出口重试只会再吃一发拦截页，连续页数交给 breaker 判定熔断。
      // 是否最终按边界收尾由 crawl() 的末页位置判别决定（仅 safeline 且已知末页，见下方）。
      const blockType = typeof siteConfig.blockType === 'function'
        ? siteConfig.blockType(error)
        : null;
      if (blockType) {
        const blockName = blockType === 'http468' ? 'HTTP 468 站点风控' : blockType;
        log(`第 ${pageNo} 页被拦截（${blockName}，status=${errStatus}），按拦截页处理，跳过重试`, { level: 'warn', event: 'page_blocked', context: { page: pageNo, shieldType: blockType, status: errStatus, site: siteName }, site: siteName });
        return { pageData: [], failed: true, status: errStatus, shieldType: blockType };
      }
      if (isBoundary(error, siteConfig)) {
        log(`第 ${pageNo} 页无新增数据（站点边界），已爬至当日末尾`, { event: 'boundary_403', context: { page: pageNo, site: siteName }, site: siteName });
        return { pageData: [], failed: false, endReached: true };
      }
      // 405 快败优先于 GET→POST 降级：站点声明 failFast405 时，GET 405 直接冷却
      // 当前节点并换 IP。2026-09-22 日志中每一次 fallback_post 都紧跟
      // page_failed_dual405，POST 从未成功；405 是出口 IP 级封禁，同一 IP 上换
      // 方法只会多打一发、延长封禁。
      // 降级分支不消耗 retries：triedFallback 已保证仅降级一次。若在此扣减最后一次
      // 重试额度，循环条件 (retries < maxRetries) 直接为假退出且无返回值（隐式
      // undefined），曾致 crawl() 解构 results[i] 崩溃（2026-08-24 17:23 生产日志复现）。
      function formatSnippet(data) {
        if (data == null) return '';
        if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 300);
        if (typeof data === 'object') {
          try { return JSON.stringify(data).slice(0, 300); } catch (_) { return String(data).slice(0, 300); }
        }
        return String(data).slice(0, 300);
      }
      const isFastFail405 = errStatus === 405 && !!siteConfig.failFast405;
      const isDual405 = errStatus === 405 && triedFallback && method === 'POST';
      if (isFastFail405 || isDual405) {
        const snippet405 = formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim();
        const extra405 = snippet405 ? ` snippet=${snippet405.slice(0, 80)}` : '';
        if (isFastFail405) {
          log(`第 ${pageNo} 页 405（站点声明 failFast405，跳过 POST 降级），冷却当前节点并换点 [code=${error.code} status=${errStatus} method=${method}${extra405}]`, { level: 'error', event: 'page_failed_405_fastfail', context: { page: pageNo, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
        } else {
          log(`第 ${pageNo} 页 POST 仍 405（GET→POST 双 405），不再重试直接跳过 [code=${error.code} status=${errStatus} method=${method}${extra405}]`, { level: 'error', event: 'page_failed_dual405', context: { page: pageNo, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
        }
        const switched = await switchAfter405(errStatus);
        if (switched.retry) continue;
        return switched.result;
      }
      if (errStatus === 405 && method === 'GET' && !triedFallback && siteConfig.fallbackOn405) {
        triedFallback = true;
        method = 'POST';
        const snippet = formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim();
        log(`第 ${pageNo} 页 GET 405，自动降级为 POST 重试 [snippet=${snippet.slice(0, 120) || '空'}]`, { level: 'warn', event: 'fallback_post', context: { page: pageNo, status: errStatus, snippet: snippet.slice(0, 120), site: siteName }, site: siteName });
        await new Promise(resolve => setTimeout(resolve, backoffDelay(retries)));
        continue;
      }
      retries++;
      const backoff = backoffDelay(retries - 1);
      const snippet405 = errStatus === 405 ? formatSnippet(error.response?.data).replace(/\s+/g, ' ').trim() : '';
      const extra405 = snippet405 ? ` snippet=${snippet405.slice(0, 80)}` : '';
      log(`第 ${pageNo} 页加载失败 [code=${error.code} status=${errStatus} method=${method}${extra405}]：${error.message}，正在进行第 ${retries} 次重试，${backoff}ms 后...`, { level: 'warn', event: 'retry', context: { page: pageNo, attempt: retries, backoffMs: backoff, code: error.code, status: errStatus, method, site: siteName }, site: siteName });
      if (retries >= maxRetries) {
        // 换点重置：网络失败（无 status）达上限后，尝试换 IP 重试
        if (errStatus === undefined || errStatus === null) {
          // 网络失败也要先看预算：用尽时只换点做「冷却/记账」没有意义（网络失败不冷却节点），
          // 直接按预算结果收尾，不再选一个用不上的新出口。
          const netBudgetLeft = !isFirstPage || canTryAnotherFirstPageNode();
          let sw2 = makeSwitchResult();
          try { sw2 = await switchProxy(isFirstPage ? 'first_page_net_fail' : 'net_fail', { coolOnly: !netBudgetLeft }); } catch (_) {}
          if (isFirstPage && !netBudgetLeft) return firstPageBudgetResult(errStatus);
          // 第一页探针：当前出口网络不通就一直换，直到成功或节点池轮尽（轮尽=后续页同样不通，取消本次抓取）
          if (isFirstPage && (sw2.ok || sw2.exhausted)) {
            if (sw2.exhausted) {
              if (sw2.allCooled) return firstPageAllCooledResult(errStatus);
              log(`第 1 页在所有节点上均网络失败，判定出口全部不可用，取消本次抓取 [${siteName}]`, { level: 'error', event: 'first_page_gate_exhausted', context: { page: pageNo, site: siteName }, site: siteName });
              return { pageData: [], failed: true, gateAbort: true };
            }
            if (!canTryAnotherFirstPageNode()) return firstPageBudgetResult(errStatus);
            noteFirstPageNodeTried();
            log(`第 1 页网络失败已换 IP（${sw2.from} → ${sw2.to}）${staleNote(sw2.stale)}，继续探针重试`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw2.from, to: sw2.to, site: siteName, stale: !!sw2.stale }, site: siteName });
            retries = 0;
            triedFallback = false;
            method = String(siteConfig.method || 'GET').toUpperCase();
            await new Promise(r => setTimeout(r, backoffDelay(0)));
            continue;
          }
          // 非首页：换一次仍失败即跳过该页（不限于第1页，避免数据丢失）
          if (sw2.ok && !triedSwitch) {
            triedSwitch = true;
            log(`第 ${pageNo} 页网络失败已换 IP，立即重试该页${staleNote(sw2.stale)}`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw2.from, to: sw2.to, site: siteName, stale: !!sw2.stale }, site: siteName });
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
    try { sw3 = await switchProxy(pageNo === 1 ? 'first_page_exhausted' : 'exhausted'); } catch (_) {}
    if (sw3.ok && !(isFirstPage && !canTryAnotherFirstPageNode())) {
      noteFirstPageNodeTried();
      log(`第 ${pageNo} 页重试额度耗尽后已换 IP，立即重试该页${staleNote(sw3.stale)}`, { level: 'warn', event: 'page_retry_after_switch', context: { page: pageNo, from: sw3.from, to: sw3.to, site: siteName, stale: !!sw3.stale }, site: siteName });
      // 必须把本轮 rotation 一并传入：省略第 5 参会退化为 getRotation 回退，
      // 该回退在未注册时新建实例，使递归重试与本轮换点状态脱钩（换点记账丢失）。
      return crawlPage(pageNo, siteConfig, existingIds, maxRetries, rotation || switchProxy);
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

// ---- 断点（v2：纯游标）----
// v1 里断点同时背 `existingIds`（去重集）和游标，导致两个职责互相拖累：
// 断点清了去重集就退回 2 天 Excel 窗口，断点留着去重集又只增不减。
// v2 把 id 交给 ledger.js，断点只回答四个问题：扫到哪、扫过哪些页、哪些页被风控跳过、
// 上一次完整扫描是什么时候。文件名也从 state-<site>.json 换成 state/<site>/checkpoint.json，
// 这样整个 state/ 可以作为一个卷挂进容器（旧路径在可写层里，重建即丢）。
const CHECKPOINT_VERSION = 2;

// 全量扫描节奏：每 24h 一次，且只在 02:00-06:00（Asia/Shanghai）放行。
// 全量是唯一会深翻 100 页的操作，也是 468 的主要来源（2026-10-28 第 61-99 页连续命中）；
// 放在站点最闲的时段，本身就能少一大截风控。台账为空的首次部署是例外——必须立刻播种。
const FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FULL_SWEEP_START_HOUR = 2;
const FULL_SWEEP_END_HOUR = 6;

function shanghaiHour(nowMs) {
  // en-GB + h23 避免午夜被格式化成 "24"
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
  }).format(new Date(nowMs));
  return Number(text);
}

function isInFullSweepWindow(nowMs) {
  const hour = shanghaiHour(nowMs);
  return hour >= FULL_SWEEP_START_HOUR && hour < FULL_SWEEP_END_HOUR;
}

function isFullSweepDue(lastFullSweepAt, nowMs, ledgerEmpty) {
  if (ledgerEmpty) return true;
  if (!lastFullSweepAt) return true;
  const last = Date.parse(lastFullSweepAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= FULL_SWEEP_INTERVAL_MS;
}

function checkpointFile(site) {
  return path.join('state', normalizeSite(site), 'checkpoint.json');
}

function legacyCheckpointFile(site) {
  return path.join(`state-${normalizeSite(site)}.json`);
}

function newCheckpoint() {
  return {
    v: CHECKPOINT_VERSION,
    currentPage: 1,
    realTotalPages: null,
    sweepId: 0,
    visited: [],
    pending: [],
    blockCounts: {},
    headScannedAt: null,
    lastSweepCompletedAt: null,
    lastFullSweepAt: null,
    consecutiveIncompleteRounds: 0,
    watermarkMissRounds: 0
  };
}

function normalizeRanges(list) {
  if (!Array.isArray(list)) return [];
  const pairs = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const start = Math.floor(Number(entry[0]));
    const end = Math.floor(Number(entry[1]));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    pairs.push([start, end]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of pairs) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function markVisited(ranges, page) {
  return markRange(ranges, page, page);
}

// 把 [start, end] 整段标为已访问：撞到边界时用它把「边界及其之后」一次性记平——
// 那些页本来就不存在，留着缺口会让游标永远回退到一个取不到数据的地方。
function markRange(ranges, start, end) {
  const from = Math.floor(Number(start));
  const to = Math.floor(Number(end));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return ranges;
  const merged = normalizeRanges([...ranges, [from, to]]);
  ranges.length = 0;
  ranges.push(...merged);
  return ranges;
}

function visitedCount(ranges) {
  return ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}

// 最老的「还欠着」的页：既没访问过、也不在待补清单里。
// 游标就该停在这里——跳过 pending 是为了不被一个永远打不开的页钉死，
// 反之「跳过的页要留在 pending 里」也是同一个不变量的一半。
function oldestUnvisited(ranges, total, pendingPages) {
  const merged = normalizeRanges(ranges);
  const pending = pendingPages instanceof Set ? pendingPages : new Set(pendingPages || []);
  let cursor = 1;
  for (const [start, end] of merged) {
    while (cursor < start) {
      if (!pending.has(cursor)) return cursor;
      cursor++;
    }
    if (cursor < end + 1) cursor = end + 1;
  }
  while (cursor <= total) {
    if (!pending.has(cursor)) return cursor;
    cursor++;
  }
  return null;
}

function loadCheckpoint(site) {
  // v1 断点不兼容：里面有 existingIds，语义和 v2 冲突。留着只会误导续跑，
  // 所以见到就删、并留一条 warn——重装环境里本来也不该存在。
  const legacy = legacyCheckpointFile(site);
  if (fs.existsSync(legacy)) {
    try { fs.unlinkSync(legacy); } catch (_) {}
    log('检测到 v1 断点（含 existingIds），结构不兼容，已删除并从头开始', {
      level: 'warn', event: 'checkpoint_legacy_ignored',
      context: { file: legacy, site: normalizeSite(site) }, site: normalizeSite(site)
    });
  }
  const file = checkpointFile(site);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log(`断点读取失败，从头开始：${error.message}`, { level: 'warn', event: 'checkpoint_load_failed', context: { error: error.message, site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
  if (!raw || Number(raw.v) !== CHECKPOINT_VERSION) {
    log(`断点版本不匹配（v=${String(raw && raw.v)}），已丢弃重跑`, { level: 'warn', event: 'checkpoint_invalid', context: { raw: String(raw && raw.v), site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
  const page = Number(raw.currentPage);
  if (!Number.isInteger(page) || page < 1) {
    log(`断点 currentPage 非法 (${String(raw.currentPage)})，已丢弃重跑`, { level: 'warn', event: 'checkpoint_invalid', context: { raw: String(raw.currentPage), site: normalizeSite(site) }, site: normalizeSite(site) });
    return null;
  }
  const observed = Number(raw.realTotalPages);
  const cp = newCheckpoint();
  cp.currentPage = page;
  cp.realTotalPages = Number.isInteger(observed) && observed > 0 ? observed : null;
  cp.sweepId = Number.isInteger(Number(raw.sweepId)) && Number(raw.sweepId) >= 0 ? Number(raw.sweepId) : 0;
  cp.visited = normalizeRanges(raw.visited);
  cp.pending = Array.isArray(raw.pending)
    ? raw.pending
      .map(entry => ({
        page: Math.floor(Number(entry && entry.page)),
        rounds: Math.max(0, Math.floor(Number(entry && entry.rounds) || 0)),
        gaveUp: !!(entry && entry.gaveUp)
      }))
      .filter(entry => Number.isInteger(entry.page) && entry.page >= 1)
    : [];
  cp.blockCounts = (raw.blockCounts && typeof raw.blockCounts === 'object') ? { ...raw.blockCounts } : {};
  cp.headScannedAt = typeof raw.headScannedAt === 'string' ? raw.headScannedAt : null;
  cp.lastSweepCompletedAt = typeof raw.lastSweepCompletedAt === 'string' ? raw.lastSweepCompletedAt : null;
  cp.lastFullSweepAt = typeof raw.lastFullSweepAt === 'string' ? raw.lastFullSweepAt : null;
  cp.consecutiveIncompleteRounds = Number.isInteger(Number(raw.consecutiveIncompleteRounds)) ? Number(raw.consecutiveIncompleteRounds) : 0;
  cp.watermarkMissRounds = Number.isInteger(Number(raw.watermarkMissRounds)) ? Number(raw.watermarkMissRounds) : 0;
  return cp;
}

function saveCheckpoint(site, cp) {
  const file = checkpointFile(site);
  const payload = {
    v: CHECKPOINT_VERSION,
    currentPage: cp.currentPage,
    realTotalPages: Number.isInteger(cp.realTotalPages) && cp.realTotalPages > 0 ? cp.realTotalPages : null,
    sweepId: cp.sweepId,
    visited: normalizeRanges(cp.visited),
    pending: cp.pending,
    blockCounts: cp.blockCounts,
    headScannedAt: cp.headScannedAt,
    lastSweepCompletedAt: cp.lastSweepCompletedAt,
    lastFullSweepAt: cp.lastFullSweepAt,
    consecutiveIncompleteRounds: cp.consecutiveIncompleteRounds,
    watermarkMissRounds: cp.watermarkMissRounds,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(file, payload);
}

// 断点/台账写不进去时，别让运维对着裸 EACCES 猜该动哪。
// 2026-10-29 生产日志里「台账写入失败：EACCES ... mkdir 'state/yfbzb'」连着 5 轮，
// 没人接：消息说了错，没说这是宿主机属主问题、也没说怎么修。
// 成因固定——容器内以降权后的 node(1000) 跑，绑定挂载进来的 ./state 若是 root 属主
// （Docker 首次创建绑定源目录时就是），node 在其下 mkdir 必然 EACCES。
function stateWriteHint(site) {
  const dir = path.join('state', normalizeSite(site));
  return `${dir} 不可写（容器内以 node/1000 运行，宿主机绑定挂载的 state 目录通常被 root 建过）。`
    + `宿主机执行 chown -R 1000:1000 state 后下一轮即恢复；重建容器时 docker-entrypoint.sh 会自动 chown。`;
}

function logStateWriteFailure(site, error) {
  const normalized = normalizeSite(site);
  log(`断点写入失败，本轮进度未保存 [${normalized}]：${error.message}。${stateWriteHint(normalized)}`, {
    level: 'error',
    event: 'checkpoint_save_failed',
    context: { error: error.message, code: error.code || null, dir: path.join('state', normalized), site: normalized },
    site: normalized
  });
}

// /status 的落盘端：crawler 只写，server 只读。两边界之间没有函数调用，
// 所以静态服务不必依赖 crawler 的任何内部结构（也就不会被爬虫重构牵连）。
function writeStatus(site, payload) {
  const file = path.join('state', normalizeSite(site), 'status.json');
  try {
    writeJsonAtomic(file, payload);
  } catch (error) {
    log(`状态文件写入失败：${error.message}`, { level: 'warn', event: 'status_write_failed', context: { error: error.message, site: normalizeSite(site) }, site: normalizeSite(site) });
  }
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

// 多站共用同一代理出口的登记见文件上方 _proxySharedExit（进程级，跨站点）。

async function crawl(a, b, c, d) {
  const { site, totalPages, interval, maxRetries } = normalizeCrawlArgs(a, b, c, d);
  const siteConfig = getSiteConfig(site);
  // 站点配置对象由 registry 复用；换点地址现由本轮 rotation 实例持有，
  // 不再需要手动清理 siteConfig 上的残留字段——跨轮状态随实例自然消失。
  // 每轮一个换点状态机实例：上轮试过的节点本轮允许重新尝试（WAF 封禁状态随时间变化），
  // 快照只在本轮内被信任，防订阅变更后被旧快照锁死于假轮尽。
  // 原三处分散的 _proxyRotate/_leafCache/_proxySwitchQueue 清理已收敛为实例生命周期。
  const rotation = proxyRotation.createRotation(site, siteConfig, {
    resolveProxyUrl,
    getProxyProvider
  });
  registerRotation(site, rotation);
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
  // 追水位扫描（站点级）：每轮从第 1 页起，连续 2 页零新增即收工，不维护尾部游标。
  // 站点按发布时间倒序，新公告永远落在头部；把 100 页拆成几十轮去「推进尾部」只是
  // 在没有新数据的地方消耗配额与风控额度（2026-10-29 日志：10 页全 0 新增仍扫满）。
  const watermarkMode = siteConfig.scanMode === 'watermark';
  // 468 即停（站点级）：468 是站点在说「你太快了」，不是「这页坏了」。
  // 继续翻页只会把风控越踩越深（2026-10-28 第 61-99 页连续 468 的成因）。
  const stopOn468 = siteConfig.stopOn468 === true;
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
        const siteKey = proxyRotation.rotationKey(site);
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
  // 轮前代理池准备（ADR 0008）：池子够用就跳过整池刷新，只有不足时才刷。
  // easy_proxies 自己每 30 分钟刷一次；轮前再刷一次只会重建隧道、把池子打回「探测中」，
  // 2026-10-28 08:37 的「58 个节点只看到 5 个可用」就是这么来的。
  let poolStatus = null;
  try {
    poolStatus = await prepareProxyPool(siteConfig, site);
  } catch (_) {}

  const checkpoint = loadCheckpoint(site);
  const cp = checkpoint || newCheckpoint();
  // 去重真相源是台账；台账为空（新环境首次运行）才退回最近两天 Excel。
  const ledgerMap = ledger.loadLedger(site);
  // 台账保留 35 天：每轮开头裁一次，避免 ids.json 只增不减（每批写盘都全量重写，体积会拖慢）。
  try {
    const pruned = ledger.pruneLedger(ledgerMap);
    if (pruned) {
      ledger.saveLedger(site, ledgerMap);
      log(`台账清理过期记录 ${pruned} 条（保留 ${ledger.RETENTION_DAYS} 天）`, { event: 'ledger_pruned', context: { site, removed: pruned, remaining: ledgerMap.size }, site });
    }
  } catch (error) {
    log(`台账清理失败，继续本轮：${error.message}`, { level: 'warn', event: 'ledger_prune_failed', context: { error: error.message, site }, site });
  }
  let existingIds = ledger.ledgerIds(ledgerMap);
  if (existingIds.size === 0) {
    existingIds = readRecentIds(site);
    if (existingIds.size) {
      log(`台账为空，回退到最近两天 Excel 去重（${existingIds.size} 个 id）`, { event: 'ledger_fallback_excel', context: { site, knownIds: existingIds.size }, site });
    }
  }
  // 全量判定用「台账」而不是 existingIds：后者可能被两天 Excel 兜底填满，
  // 但那不是持久台账，首次部署仍然需要一次全量播种。
  const ledgerEmpty = ledgerMap.size === 0;
  const roundNowMs = Date.now();
  const fullSweepMode = watermarkMode
    && isFullSweepDue(cp.lastFullSweepAt, roundNowMs, ledgerEmpty)
    && (ledgerEmpty || isInFullSweepWindow(roundNowMs));
  // 尾部游标 = 断点记的那个页。头部补扫每轮都从第 1 页起，只影响本轮，不推进尾部游标——
  // 两段交替写同一个字段就会回到「谁后写谁赢」，2026-10-27 的 6→11→16 就是这么来的。
  const tailStartPage = watermarkMode ? 1 : cp.currentPage;
  // 头部最多吃掉本轮预算的一半：预算被调小时（SCAN_PAGE_BUDGET < 2×HEAD_SCAN_MAX_PAGES）
  // 也要保证尾部还能前进，否则「补扫」会把整轮配额吃光、游标原地不动。
  // 追水位模式没有尾部，整轮额度都归头部（最坏情况要能在一轮里追完整个 100 页窗口）。
  const roundPageBudget = watermarkMode ? Math.max(totalPages, SCAN_PAGE_BUDGET) : SCAN_PAGE_BUDGET;
  const headScanMaxPages = watermarkMode
    ? roundPageBudget
    : Math.min(HEAD_SCAN_MAX_PAGES, Math.max(1, Math.floor(SCAN_PAGE_BUDGET / 2)));
  let headPhase = watermarkMode ? !fullSweepMode : tailStartPage > 1;
  let headPagesFetched = 0;
  // 本轮还剩多少页额度（含待补页复活那一发）
  let pagesBudgetLeft = Math.max(0, roundPageBudget - (cp.pending.length ? 1 : 0));
  let headZeroStreak = 0;
  let headScanEndPage = null;
  let tailCursor = tailStartPage;
  let currentPage = 1;
  if (headPhase) {
    log(`从断点续跑 [${site}]，尾部游标 ${tailStartPage}，本轮先补扫头部最多 ${headScanMaxPages} 页，已记录 ${existingIds.size} 个 id`, { event: 'checkpoint_resume', context: { site, tailPage: tailStartPage, headScanMaxPages, knownIds: existingIds.size }, site });
  } else {
    log(`从头开始 [${site}]，已记录 ${existingIds.size} 个 id`, { event: 'crawl_from_start', context: { site, knownIds: existingIds.size }, site });
  }
  const runStartPage = tailStartPage;
  // 主动按页轮换：站点可声明 rotateEveryPages，避免一轮所有页都压在同一个出口 IP 上。
  const rotateEveryPages = Number(siteConfig.rotateEveryPages) > 0
    ? Math.max(1, Math.floor(Number(siteConfig.rotateEveryPages)))
    : 0;
  let lastProxyRotatePage = runStartPage;

  let shouldStopCrawling = false;
  let stoppedBySignal = false;
  let totalNew = 0;
  let totalFailed = 0;
  // 本轮 468 命中次数：用于判断「是不是又被风控盯上了」，写入 /status 与 crawl_end。
  let rateLimitedHits = 0;
  // 因 468 收手：不能用「追平」或「出口不可用」的话术去描述它。
  let stoppedBy468 = false;
  // 本轮见到的最旧发布时间：window 被追穿时用它量化「可能丢到哪一天」。
  let oldestSeenPublishDate = null;
  // 熔断判定收在 breaker 内：405 连击、盾页不可解、网络连败三条规则及其换点观察窗
  // 都只在 breaker.js 里，这里只负责喂页面结果、批末问一次 trip()（边界批次跳过）。
  // 内容成功页数也由它持有（边界页与零行页不算，见 breaker.record 注释）。
  const breaker = createBreaker({
    switchProxy: reason => rotation.switch(reason)
  });
  let fileWriteFailed = 0;
  let fileWriteSucceeded = 0;
  const failedIds = new Set();
  let endReached = false;
  // 第一页探针轮尽/限次/全冷却：判定出口不可用，取消本次抓取
  let gateAborted = false;
  let probeLimited = false;
  let probeTimedOut = false;
  let allNodesCooled = false;
  let retryFromPage = null;
  // 本批首个「该重爬」的页（被跳过的 468 页不算），批级重试点的取值依据
  let batchFirstFailedPage = null;
  // 断点唯一的不变量：只前移，不越过失败页。
  // 页面级失败、三个熔断分支（WAF/405/网络连败）、写盘失败、第一页探针轮尽
  // 都必须经由它记录，否则后发生的事件会把断点推到更晚的页，更早的失败页
  // 从此不再重爬（2026-10-27 ceb 断点 6→11→16… 每轮 +5，前 5 页永久丢失）。
  function noteRetryPage(page) {
    if (!Number.isInteger(page) || page < 1) return;
    retryFromPage = retryFromPage === null ? page : Math.min(retryFromPage, page);
  }
  // 468 逃逸：同一页连续 BLOCK_SKIP_ROUNDS 轮命中才允许跳过。
  // 返回 true 表示「本轮跳过它」——调用方据此不再 noteRetryPage，游标得以前移；
  // 被跳过的页进 pending，轮首有一次复活探测（见 revivePendingPage）。
  // 只看 http468：safeline / acw 的语义是「页尾」或「求解失败」，跳过去就是丢数据。
  // 批级重试点：优先用本批真实失败页，而不是批次起始页。
  // 旧写法（noteRetryPage(batchStartPage)）在「第 1-3 页成功、第 4-6 页被拦」时
  // 会把游标拉回第 1 页——整窗重扫，正是「续跑追不上新增」的一半成因。
  // 本批失败页若全是被跳过的 468 页，就一个字都不记，让游标真的前进。
  function noteBatchRetry() {
    if (batchFirstFailedPage !== null) noteRetryPage(batchFirstFailedPage);
  }
  function registerBlockedPage(page, shieldType) {
    if (shieldType !== 'http468') return false;
    const key = String(page);
    const rounds = Number(cp.blockCounts[key] || 0) + 1;
    cp.blockCounts[key] = rounds;
    if (rounds < BLOCK_SKIP_ROUNDS) return false;
    // rounds 记的是「复活探测失败了几次」，不是被拦了几轮：放弃条件是探测 3 次仍失败。
    if (!cp.pending.some(entry => entry.page === page)) cp.pending.push({ page, rounds: 0 });
    log(`第 ${page} 页连续 ${rounds} 轮被 HTTP 468 拦截，本轮跳过并记入待补清单（共 ${cp.pending.length} 页待补）`, { level: 'warn', event: 'blocked_page_skipped', context: { page, rounds, pendingPages: cp.pending.length, site }, site });
    return true;
  }
  // 单页行入库：去重 → 归日期 → 计数。头部补扫、尾部批次、待补页复活三条路径共用。
  function collectPageRows(pageData, pageNo, batchData) {
    let batchNew = 0;
    for (const item of pageData) {
      if (existingIds.has(item.id)) continue;
      const publishDate = normalizePublishDateSafe(item.publishTime);
      if (!publishDate) {
        log(`发布日期无效，跳过公告：${String(item.publishTime)}`, {
          level: 'error', event: 'invalid_publish_date',
          context: { page: pageNo, id: item.id, publishTime: String(item.publishTime), site }, site
        });
        continue;
      }
      if (!oldestSeenPublishDate || publishDate < oldestSeenPublishDate) oldestSeenPublishDate = publishDate;
      if (!batchData[publishDate]) batchData[publishDate] = [];
      batchData[publishDate].push(item);
      existingIds.add(item.id);
      totalNew++;
      batchNew++;
    }
    return batchNew;
  }
  // 落盘 + 台账跟进。台账只收真正落盘的行：写盘失败的行已经回滚出 existingIds，
  // 若此时仍记进台账，下一轮会把它们当「已知」直接跳过，等于永久丢数据。
  function commitBatch(batchData) {
    const batchPersist = persistDataFiles(site, batchData);
    fileWriteFailed += batchPersist.fileWriteFailed;
    fileWriteSucceeded += batchPersist.fileWriteSucceeded;
    const failedSet = new Set(batchPersist.failedIds);
    for (const id of failedSet) { failedIds.add(id); existingIds.delete(id); ledgerMap.delete(id); }
    const rows = Object.values(batchData).flat().filter(item => !failedSet.has(item.id));
    if (rows.length) {
      try {
        ledger.addRows(ledgerMap, rows);
        ledger.saveLedger(site, ledgerMap);
      } catch (error) {
        // 台账写失败不阻塞抓取，但必须留痕：下次运行会重复写这一批。
        log(`台账写入失败，下一轮会重复写这一批：${error.message}。${stateWriteHint(site)}`, { level: 'error', event: 'ledger_save_failed', context: { error: error.message, code: error.code || null, rows: rows.length, site }, site });
      }
    }
    return batchPersist;
  }
  // /status 的观测面：把断点的外部语义直接摊平成可读字段，避免读的人自己算区间。
  function publishStatus() {
    writeStatus(site, {
      site,
      updatedAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      checkpointPage: cp.currentPage,
      realTotalPages: cp.realTotalPages ?? null,
      effectiveTotalPages,
      sweepId: cp.sweepId,
      visitedPages: visitedCount(cp.visited),
      oldestUnvisitedPage: oldestUnvisited(cp.visited, effectiveTotalPages, new Set(cp.pending.map(entry => entry.page))),
      pendingPages: cp.pending.filter(entry => !entry.gaveUp).map(entry => entry.page),
      givenUpPages: cp.pending.filter(entry => entry.gaveUp).map(entry => entry.page),
      headScannedAt: cp.headScannedAt,
      lastSweepCompletedAt: cp.lastSweepCompletedAt,
      lastFullSweepAt: cp.lastFullSweepAt,
      consecutiveIncompleteRounds: cp.consecutiveIncompleteRounds,
      watermarkMissRounds: cp.watermarkMissRounds || 0,
      lastRound: {
        totalNew,
        totalFailed,
        endReached,
        fileWriteFailed,
        fileWriteSucceeded,
        failedIds: failedIds.size,
        rateLimitedHits,
        oldestSeenPublishDate
      }
    });
  }
  // 轮首池子已全部冷却：刷新清不掉 crawler 侧的冷却表，直接暂停本轮——
  // 不刷新、不换点、不发第一发请求。ADR 0008 的「全冷却不白刷」。
  if (poolStatus && poolStatus.allCooled) {
    allNodesCooled = true;
    gateAborted = true;
    shouldStopCrawling = true;
    noteRetryPage(tailStartPage);
    log(`轮首所有代理节点均在冷却期，暂停本轮 [${site}]`, { level: 'warn', event: 'all_nodes_cooled', context: { site, page: tailStartPage, rawCount: poolStatus.rawCount }, site });
  }
  // 站点分页自报的真实总页数（后观测覆盖前观测，总量可能随发布增长）；
  // 实际生效上限 = min(配置 totalPages, 观测值)，未观测到时等于配置。
  // 断点里带上轮观测值：恢复轮可能只从末页起跑，没有成功页可以重新观测。
  let realTotalPagesObserved = checkpoint && Number.isInteger(checkpoint.realTotalPages)
    ? checkpoint.realTotalPages
    : undefined;
  let effectiveTotalPages = Number.isInteger(realTotalPagesObserved)
    ? Math.min(totalPages, realTotalPagesObserved)
    : totalPages;

  // 轮首出口选择：405 冷却表跨轮保留，基础端口若正好在冷却期，
  // 先切到健康节点再发第一条请求，避免每轮开头又打一次已被封的 IP。
  // 当前出口健康时 keepCurrentIfHealthy 返回 noop；直连站/管理面不可达同样 noop。
  // 池子已全部冷却时上面已置 shouldStopCrawling，这里连换点都不试。
  if (!shouldStopCrawling) {
    try {
      const startSwitch = await rotation.switch('round_start', { keepCurrentIfHealthy: true });
      if (startSwitch.allCooled) {
        allNodesCooled = true;
        gateAborted = true;
        shouldStopCrawling = true;
        noteRetryPage(tailStartPage);
        log(`轮首所有代理节点均在冷却期，暂停本轮 [${site}]`, { level: 'warn', event: 'all_nodes_cooled', context: { site, page: tailStartPage }, site });
      } else if (startSwitch.ok) {
        log(`轮首当前出口不可用，已切换代理节点：${startSwitch.from || '当前节点'} → ${startSwitch.to}${staleNote(startSwitch.stale)}`, { event: 'proxy_initial_switch', context: { site, from: startSwitch.from, to: startSwitch.to, stale: !!startSwitch.stale }, site });
      }
    } catch (_) {}
  }

  // 轮首复活探测：上一轮被 468 跳过的页里最早那一页，用 1 页配额试一次。
  // 站点风控是时间窗口的，跳过不等于放弃；但也不能让一个死页每轮都把配额吃掉——
  // 连续 PENDING_GIVE_UP_ROUNDS 轮探测失败才真正移除。
  // 只探测「还没放弃」的首项：放弃了就彻底不碰，避免每轮为它白烧一发配额。
  const reviveTarget = cp.pending.find(entry => !entry.gaveUp);
  if (reviveTarget && !shouldStopCrawling && !stopping) {
    const target = reviveTarget;
    let probe = null;
    try { probe = await crawlPage(target.page, siteConfig, existingIds, maxRetries, rotation); } catch (_) { probe = null; }
    if (probe && !probe.failed) {
      markVisited(cp.visited, target.page);
      delete cp.blockCounts[String(target.page)];
      cp.pending = cp.pending.filter(entry => entry !== target);
      const reviveBatch = Object.create(null);
      const revivedNew = probe.pageData && probe.pageData.length
        ? collectPageRows(probe.pageData, target.page, reviveBatch)
        : 0;
      if (Object.keys(reviveBatch).length) commitBatch(reviveBatch);
      log(`待补页第 ${target.page} 页复活成功（新增 ${revivedNew} 条），已移出待补清单`, { event: 'pending_page_revived', context: { page: target.page, newCount: revivedNew, pendingPages: cp.pending.length, site }, site });
    } else {
      target.rounds = (target.rounds || 0) + 1;
      if (target.rounds >= PENDING_GIVE_UP_ROUNDS) {
        // 标记而不是删除：页仍然「不算欠账」（不会被游标拉回），但状态里看得见，
        // 事故复盘时能回答「到底哪几页没拿到」。
        target.gaveUp = true;
        log(`待补页第 ${target.page} 页连续 ${target.rounds} 轮探测失败，放弃重试（该页数据确认缺失）`, { level: 'error', event: 'pending_page_given_up', context: { page: target.page, rounds: target.rounds, pendingPages: cp.pending.length, site }, site });
      } else {
        log(`待补页第 ${target.page} 页仍不可用（第 ${target.rounds} 次探测），保留在待补清单`, { level: 'warn', event: 'pending_page_still_blocked', context: { page: target.page, rounds: target.rounds, site }, site });
      }
    }
  }

  while (currentPage <= effectiveTotalPages && !shouldStopCrawling) {
    const batchStartPage = currentPage;
    const wasHeadBatch = headPhase;
    const batchData = Object.create(null);
    if (stopping) {
      stoppedBySignal = true;
      break;
    }
    // 一道闸门管三件事：batchSize、头部补扫配额（15 页 → 第一批 1-10、第二批 11-15）、
    // 以及本轮总页数预算。预算耗尽就收工，剩下的页留给下一轮。
    const headRemaining = headPhase ? Math.max(0, headScanMaxPages - headPagesFetched) : Number.POSITIVE_INFINITY;
    const pagesToCrawl = Math.min(batchSize, headRemaining, pagesBudgetLeft, effectiveTotalPages - currentPage + 1);
    batchFirstFailedPage = null;
    if (pagesToCrawl <= 0) {
      if (headPhase && pagesBudgetLeft > 0) {
        headPhase = false;
        cp.headScannedAt = new Date().toISOString();
        const jumpTo = Math.max(currentPage, tailStartPage);
        log(`头部补扫配额用尽 [${site}]：已扫 ${headPagesFetched} 页，续扫从第 ${jumpTo} 页开始`, { event: 'head_scan_done', context: { site, headPagesFetched, headScanEndPage: currentPage - 1, headZeroStreak, jumpTo, tailStartPage, reason: 'quota' }, site });
        currentPage = jumpTo;
        tailCursor = jumpTo;
        continue;
      }
      log(`本轮页数预算（${SCAN_PAGE_BUDGET} 页）已用尽 [${site}]，剩余页留给下一轮`, { level: 'warn', event: 'page_budget_exhausted', context: { site, pageBudget: SCAN_PAGE_BUDGET, page: tailCursor }, site });
      noteRetryPage(tailCursor);
      shouldStopCrawling = true;
      break;
    }
    pagesBudgetLeft -= pagesToCrawl;
    if (headPhase) headPagesFetched += pagesToCrawl;
    const proxyUrlAtBatchStart = rotation.currentProxyUrl();
    const crawlPromises = [];

    for (let i = 0; i < pagesToCrawl; i++) {
      crawlPromises.push(crawlPage(batchStartPage + i, siteConfig, existingIds, maxRetries, rotation));
    }

    const results = await Promise.all(crawlPromises);
    if (stopping) stoppedBySignal = true;
    let hasNewDataInBatch = false;
    let failedCount = 0;
    let batchEndReached = false;

    // 站点自报真实总页数先于逐页判定合并：后观测覆盖前观测，每批重算有效上限；
    // 收窄到低于当前页时由循环条件自然退出（等价于「已到底」）。
    // 必须在逐页判定之前——同一批里第 99 页的观测要先于第 100 页生效，
    // 否则配置 totalPages 大于真实页数时，末页的 SafeLine 拦截会被误判为中途失败，
    // 断点卡在末页，下一轮不再从第 1 页抓新数据。
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

    for (let i = 0; i < results.length; i++) {
      const pageNo = batchStartPage + i;
      let result = results[i];
      // 拦截页打在站点自报的最后一页：其后再无数据，按数据边界收尾。
      // 否则真实页尾（yfbzb 第 100 页的 SafeLine 403）每轮都会变成失败页并卡住断点。
      // 这是位置判别，不是指纹判别——指纹本身分不出页尾和临时封禁。
      // 只限 safeline：acw 挑战求解失败是访问故障，末页被吞会删断点并永久漏数据。
      // 基准优先用站点自报的总页数，不能用 effectiveTotalPages（含配置上限）：
      // 配置小于真实页数时，上限处的拦截是真实页被拦，不是「已到底」。
      // 断点没有总页数（旧文件，或上轮从未成功观测）时退化为配置上限：
      // 恢复轮从末页起跑时没有成功页可重新观测，若仍按失败处理，断点会永停末页。
      const lastKnownPage = Number.isInteger(realTotalPagesObserved) ? realTotalPagesObserved : totalPages;
      if (result.failed && result.shieldType === 'safeline' && pageNo >= lastKnownPage) {
        log(`第 ${pageNo} 页已是站点最后一个有效页，被 ${result.shieldType} 拦截，按数据边界收尾`, { level: 'warn', event: 'boundary_blocked_last_page', context: { page: pageNo, shieldType: result.shieldType, status: result.status, site }, site });
        result = { pageData: [], failed: false, endReached: true };
      }
      const { pageData, failed, endReached: ended, status } = result;

      // 先把页面结果交给 breaker 记账，它内部维护 405 连击/盾页/网络连败与内容成功页数。
      // 直接传整页结果：record 的契约就是「读哪些字段」，多带的字段它不看。
      const proxy405Switches = breaker.record(result);

      if (failed) {
        failedCount++;
        totalFailed++;
        if (stopOn468 && result.shieldType === 'http468') {
          rateLimitedHits++;
          stoppedBy468 = true;
          log(`第 ${pageNo} 页命中 HTTP 468 站点风控，立即收手 [${site}]（不重试、不翻下一页，15 分钟后下一轮再追）`, { level: 'error', event: 'rate_limited_stop', context: { page: pageNo, site }, site });
          shouldStopCrawling = true;
          noteRetryPage(pageNo);
          continue;
        }
        // 头部补扫段不写尾部游标：它每轮都从第 1 页重来，若在这里 noteRetryPage，
        // 一个头部失败页会把尾部游标拉回页首。头部失败由「下一轮重新补扫」兜底。
        // 非头部段：468 连续命中同一页才允许跳过（见 registerBlockedPage），其余照旧钉住游标。
        // 头部段也要登记 468：否则 oldestUnvisited 会把这页当成「还欠着」，
        // 游标被拉回一个永远打不开的页，逃逸恰好失效在它该生效的场景。
        // 但头部段不写尾部游标——它每轮都从第 1 页重来。
        // 追水位模式下第 1 页是唯一必须成功的页：失败即收工，不跳到第 2 页。
        // 「跳过它、继续抓第 2 页」等于这一轮的新公告一条都没拿到，日志却只写「已跳过」。
        if (watermarkMode && pageNo === 1) {
          log(`第 1 页失败，本轮终止 [${site}]：追水位策略只有第 1 页是必成功的单点，跳过它等于这一轮没抓到新公告`, { level: 'error', event: 'first_page_failed', context: { page: pageNo, status, site }, site });
          shouldStopCrawling = true;
          noteRetryPage(1);
          continue;
        }
        const skippedBlockedPage = registerBlockedPage(pageNo, result.shieldType);
        if (!headPhase && !skippedBlockedPage) {
          noteRetryPage(pageNo);
          if (batchFirstFailedPage === null) batchFirstFailedPage = pageNo;
        }
        // 第一页探针轮尽：所有代理节点均失败，后续页必然同样被拦/不通，取消本次抓取
        if (result.gateAbort) {
          gateAborted = true;
          if (result.probeTimeoutReached) {
            probeTimedOut = true;
            log(`第一页探针超过时间上限，暂停本轮 [${site}]`, { level: 'warn', event: 'first_page_probe_timeout', context: { site, page: pageNo, status }, site });
          } else if (result.probeLimitReached) {
            probeLimited = true;
            log(`第一页探针达到节点上限，暂停本轮以保护剩余出口 [${site}]`, { level: 'warn', event: 'first_page_probe_limited', context: { site, page: pageNo, status }, site });
          } else if (result.allCooled) {
            allNodesCooled = true;
            log(`第一页所有代理节点均在冷却期，暂停本轮 [${site}]`, { level: 'warn', event: 'first_page_all_cooled', context: { site, page: pageNo }, site });
          } else {
            log(`第一页在所有代理节点上均失败，判定出口全部不可用，取消本次抓取 [${site}]`, { level: 'error', event: 'first_page_gate_abort', context: { site, page: pageNo }, site });
          }
          shouldStopCrawling = true;
          noteRetryPage(batchFirstFailedPage !== null ? batchFirstFailedPage : batchStartPage);
          continue;
        }
        // 非首页换点时也可能发现全部节点都在冷却期：后续页没有可用出口，
        // 无须再请求一页去触发熔断，直接暂停本轮并保留断点。
        if (result.allCooled) {
          allNodesCooled = true;
          gateAborted = true;
          shouldStopCrawling = true;
          log(`第 ${pageNo} 页换点时所有代理节点均在冷却期，暂停本轮 [${site}]`, { level: 'warn', event: 'all_nodes_cooled', context: { site, page: pageNo, status }, site });
          continue;
        }
        // 换点成功即时回报（计数早已在 breaker 里重置；record() 把累计次数带回来）
        if (status === 405 && result.proxySwitched) {
          log(`第 ${pageNo} 页 405 但已换 IP，重置连续拦截计数，新出口观察中（本轮已换 ${proxy405Switches} 次）`, { level: 'warn', event: 'proxy_switched_reset_405', context: { page: pageNo, site, switches: proxy405Switches }, site });
        }
        log(`第 ${pageNo} 页爬取失败，已跳过`, { level: 'warn', event: 'page_skipped', context: { page: pageNo, site, status, proxySwitched: !!result.proxySwitched, proxySwitchCount: result.proxySwitchCount || 0, proxyExhausted: !!result.proxyExhausted, shield: !!result.shieldType }, site });
        continue;
      }

      // 站点真实应答：出口活着，清空本轮换点记忆与节点快照
      // （下一批可从头再试各节点、按最新订阅重发现）。
      // 主动按页轮换的站点必须保留 tried：否则每次成功页都从头选点，
      // 只会反复用节点一/节点二，且刚被 405 拦过的节点会重新进入候选。
      // 熔断计数由 breaker.record 内部清零。
      rotation.reset({ keepTried: rotateEveryPages > 0 });

      if (ended) {
        batchEndReached = true;
        // 边界页本身不是数据，但它是「到此为止」的锚点：把边界及其之后整段记平，
        // 否则这些页永远是「缺口」，游标会被一直拉回一个取不到数据的位置。
        markRange(cp.visited, pageNo, Math.max(pageNo, effectiveTotalPages));
        continue;
      }

      // 成功返回的页（含边界页）计入本轮覆盖：sweep 完成与否只看 1..有效总页数是否全覆盖。
      // 同时清掉它的 468 连击计数——连续命中要「连续」，中间成功一次就该归零。
      markVisited(cp.visited, pageNo);
      if (cp.blockCounts[String(pageNo)] !== undefined) delete cp.blockCounts[String(pageNo)];
      let pageNew = 0;
      if (pageData.length) {
        pageNew = collectPageRows(pageData, pageNo, batchData);
        if (pageNew) hasNewDataInBatch = true;
      }
      log(`第 ${pageNo} 页爬取完成，${pageNew ? '有' : '没有'}新数据`, { event: 'page_done', context: { page: pageNo, newCount: pageNew, site }, site });
      // 头部补扫的收敛条件：连续 HEAD_SCAN_ZERO_STREAK 页整页无新增即视为追平。
      if (headPhase) {
        headZeroStreak = pageNew > 0 ? 0 : headZeroStreak + 1;
      }
    }

    currentPage = batchStartPage + pagesToCrawl;
    // 本批内若因 405 换过点，把主动轮换的页数窗口也重新起算。
    if (rotation.currentProxyUrl() !== proxyUrlAtBatchStart) lastProxyRotatePage = currentPage;

    // 只在「本批没到底」时才问熔断器：trip() 可能真的去换 IP（网络连败阈值），
    // 而触达边界的批次已经在收尾，换点既用不上也没人再验证新出口——
    // 白白烧掉一次换点预算，日志里还只字不提。边界优先，连问都不问。
    // trip() 把计数一并带回，调用方不必再问一次 snapshot()。
    const trip = batchEndReached ? {} : await breaker.trip();
    // 边界优先于熔断：边界页语义是「这是今天最后一条数据」，它之后的页本来就不存在；
    // 那些页的 405 是在请求不存在的数据，不能反过来盖掉「已经到底」这个事实。
    // 顺序颠倒过（熔断在前）时，batchSize 10 的整批并发会让第 1 页的 403 被其余页的
    // 405 吞掉：既不记 endReached，还会 noteRetryPage 保留断点让下一轮重爬同一批。
    if (batchEndReached) {
      endReached = true;
      shouldStopCrawling = true;
    } else if (trip.reason === 'shield') {
      // 盾页连续不可解 / 拦截页连续命中：换 IP 也只会拿到同样的页，避免烧掉整池出口
      const shieldLabels = {
        safeline: `连续 ${trip.consecutiveShield} 页被 SafeLine 拦截`,
        http468: `连续 ${trip.consecutiveShield} 页被站点风控拦截（HTTP 468）`,
        acw: `连续 ${trip.consecutiveShield} 页 WAF 挑战求解失败`
      };
      const shieldSummary = shieldLabels[trip.lastShieldType] || `连续 ${trip.consecutiveShield} 页被拦截`;
      log(`${shieldSummary}，判定访问被拦截，提前结束 [${site}]（已试 ${currentPage - 1}/${effectiveTotalPages} 页，剩余 ${Math.max(0, effectiveTotalPages - currentPage + 1)} 页不再尝试）`, { level: 'error', event: 'circuit_break_waf', context: { site, consecutiveShield: trip.consecutiveShield, shieldType: trip.lastShieldType || null, triedPages: currentPage - 1, totalPages, effectiveTotalPages, realTotalPages: realTotalPagesObserved ?? null }, site });
      shouldStopCrawling = true;
      noteBatchRetry();
    } else if (trip.reason === '405') {
      log(`连续 ${trip.consecutive405} 页 405（本轮已换 IP ${trip.proxy405Switches} 次），判定为站点级拦截，提前结束 [${site}]（已试 ${currentPage - 1}/${effectiveTotalPages} 页，剩余 ${Math.max(0, effectiveTotalPages - currentPage + 1)} 页不再尝试）`, { level: 'error', event: 'circuit_break_405', context: { site, consecutive405: trip.consecutive405, proxySwitches405: trip.proxy405Switches, triedPages: currentPage - 1, totalPages, effectiveTotalPages, realTotalPages: realTotalPagesObserved ?? null }, site });
      shouldStopCrawling = true;
      noteBatchRetry();
    } else if (trip.switched) {
      // 网络连败换 IP：仅配置了可切换代理提供方的代理站点生效，直连站为 no-op。
      // 每轮连败只切一次并给新节点观察窗口（继续失败至熔断阈值才停），避免逐批反复切点打转
      const sw = trip.switched;
      log(`连续 ${trip.netFailStreak} 页网络级失败（ECONNRESET/超时）${sw.ok ? `，已切换代理节点 → ${sw.to}${staleNote(sw.stale)}` : '，未配置可切换代理或节点池已轮尽'}，继续爬取 [${site}]`, { level: 'warn', event: 'proxy_switch_net_fail', context: { site, netFailStreak: trip.netFailStreak, switched: !!sw.ok, stale: !!sw.stale }, site });
    } else if (trip.reason === 'net_fail') {
      // 换 IP 后仍连败：出口节点整体不可用，熔断避免空转（2026-08-24 曾 5 轮 × ~67 分钟全页失败）
      log(`连续 ${trip.netFailStreak} 页网络级失败且已尝试换 IP 仍失败，判定代理出口不可用，提前结束 [${site}]（已试 ${currentPage - 1}/${effectiveTotalPages} 页）`, { level: 'error', event: 'circuit_break_net_fail', context: { site, netFailStreak: trip.netFailStreak, triedPages: currentPage - 1, totalPages, effectiveTotalPages, realTotalPages: realTotalPagesObserved ?? null }, site });
      shouldStopCrawling = true;
      noteBatchRetry();
    } else if (!wasHeadBatch && !hasNewDataInBatch && failedCount === 0 && !fullSweepMode) {
      // 只对尾部批次生效：头部补扫的「零新增」是收敛信号，不是收工信号——
      // 在这里早停会让续跑轮永远走不到尾部（头部安静 = 新增已经追平，尾部还得推进）。
      log(`当前批次（第 ${currentPage - pagesToCrawl} 到第 ${currentPage - 1} 页）无新数据，停止爬取`, { event: 'early_stop', context: { failedCount, threshold: failureThreshold, site }, site });
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount > 0 && !gateAborted) {
      // 有失败页时不早停，避免掩盖数据；原阈值仅用于分级（batchSize=1 时单次失败曾误触发早停）
      // gateAborted 已由第一页探针轮尽置位并取消抓取，无需再提示"继续爬取下一批"
      log(`当前批次无新数据，但失败 ${failedCount} 页（阈值 ${failureThreshold}），失败页可能掩盖新数据，继续爬取下一批`, { level: 'warn', event: 'continue_despite_failures', context: { failedCount, threshold: failureThreshold, site }, site });
    }

    const batchPersist = commitBatch(batchData);
    if (batchPersist.fileWriteFailed > 0) {
      if (!headPhase) noteRetryPage(batchStartPage);
      shouldStopCrawling = true;
    }

    // 主动按页轮换：每次成功批次后检查是否到了站点配置的页数预算。
    // 放在落盘之后：换点失败不能影响本批数据写入。
    if (!shouldStopCrawling && rotateEveryPages > 0 && currentPage <= effectiveTotalPages &&
        currentPage - lastProxyRotatePage >= rotateEveryPages) {
      let sw = makeSwitchResult();
      try { sw = await rotation.switch('scheduled'); } catch (_) {}
      // 池内节点本轮都用过：先清空 tried 开新一轮循环，而不是整轮死守最后一个出口。
      if (sw.exhausted && !sw.allCooled) {
        rotation.reset();
        try { sw = await rotation.switch('scheduled_cycle'); } catch (_) {}
      }
      if (sw.ok) {
        lastProxyRotatePage = currentPage;
        log(`已按计划轮换代理出口（每 ${rotateEveryPages} 页）：${sw.from || '当前节点'} → ${sw.to}${staleNote(sw.stale)}`, { event: 'proxy_rotated_scheduled', context: { site, pages: rotateEveryPages, from: sw.from, to: sw.to, stale: !!sw.stale }, site });
      } else {
        // 本轮不再反复尝试轮换，避免每个批次都打管理面；下轮重新开始。
        lastProxyRotatePage = currentPage;
        if (sw.allCooled) {
          // 全部节点冷却时没有下一个健康出口；继续压在当前 IP 上只会把它也打脏。
          // 暂停本轮，断点留在下一页，等节点冷却后再续跑。
          log(`代理节点池全部在冷却期，暂停本轮以保护当前出口 [${site}]`, { level: 'warn', event: 'proxy_rotation_all_cooled', context: { site }, site });
          shouldStopCrawling = true;
          noteRetryPage(currentPage);
        } else if (sw.exhausted) {
          log(`代理节点池本轮已全部使用，暂停主动轮换，继续使用当前出口 [${site}]`, { level: 'warn', event: 'proxy_rotation_exhausted', context: { site }, site });
        }
      }
    }

    // 头部补扫收尾：配额到顶 / 连续 2 页整页无新增 / 撞边界 / 本轮被叫停。
    // 收尾后把本轮位置跳到尾部游标（补扫已经覆盖过的页不重复请求）。
    if (wasHeadBatch) {
      headScanEndPage = Math.max(headScanEndPage || 0, currentPage - 1);
      const headDone = headPagesFetched >= headScanMaxPages
        || headZeroStreak >= HEAD_SCAN_ZERO_STREAK
        || batchEndReached
        || shouldStopCrawling;
      if (headDone) {
        headPhase = false;
        cp.headScannedAt = new Date().toISOString();
        const jumpTo = Math.max(currentPage, tailStartPage);
        if (watermarkMode && !stoppedBy468) {
          log(`追水位收工 [${site}]：本轮扫到第 ${headScanEndPage} 页（${headPagesFetched} 页，连续 ${headZeroStreak} 页无新增）`, { event: 'watermark_caught_up', context: { site, pagesFetched: headPagesFetched, lastPage: headScanEndPage, zeroStreak: headZeroStreak }, site });
        } else if (!watermarkMode) {
          log(`头部补扫结束 [${site}]：扫到第 ${headScanEndPage} 页（${headPagesFetched} 页，连续 ${headZeroStreak} 页无新增），续扫从第 ${jumpTo} 页开始`, { event: 'head_scan_done', context: { site, headPagesFetched, headScanEndPage, headZeroStreak, jumpTo, tailStartPage }, site });
        }
        currentPage = jumpTo;
        tailCursor = jumpTo;
        // 追水位模式：追平即收工，不存在「跳到尾部继续扫」的下一段。
        if (watermarkMode) shouldStopCrawling = true;
      }
    } else {
      tailCursor = currentPage;
    }

    if (!shouldStopCrawling) {
      cp.currentPage = tailCursor;
      cp.realTotalPages = Number.isInteger(realTotalPagesObserved) ? realTotalPagesObserved : null;
      try {
        saveCheckpoint(site, cp);
      } catch (error) {
        logStateWriteFailure(site, error);
        throw error;
      }
      publishStatus();
    }

    if (stopping) {
      shouldStopCrawling = true;
    }

    if (!shouldStopCrawling) {
      const ok = await sleepInterruptible(interval);
      if (!ok || stopping) {
        stoppedBySignal = true;
        shouldStopCrawling = true;
      }
    }
  }

  // 追水位收口：整轮跑满窗口（100 页）仍未出现「连续 2 页零新增」= 没追到水位。
  // 这一轮就是没追平，窗口可能正在翻过去；记下最旧一条的发布时间，连续两轮升级告警。
  if (watermarkMode && !stoppedBy468 && !endReached) {
    const caughtUp = headZeroStreak >= HEAD_SCAN_ZERO_STREAK;
    if (caughtUp) {
      cp.watermarkMissRounds = 0;
    } else if (headPagesFetched >= Math.min(headScanMaxPages, effectiveTotalPages)) {
      cp.watermarkMissRounds = (cp.watermarkMissRounds || 0) + 1;
      log(`本轮扫满 ${headPagesFetched} 页仍未追到水位 [${site}]：窗口（${effectiveTotalPages} 页 ≈ 站点全部可见公告）已经追穿，最旧一条到 ${oldestSeenPublishDate || '未知'}，更早的可能已从站点翻页区间掉出`, { level: 'error', event: 'watermark_not_reached', context: { site, pagesFetched: headPagesFetched, totalPages: effectiveTotalPages, oldestPublishTime: oldestSeenPublishDate, missRounds: cp.watermarkMissRounds }, site });
      if (cp.watermarkMissRounds >= 2) {
        log(`连续 ${cp.watermarkMissRounds} 轮未追平 [${site}]：正在持续丢数据，需要人工介入（提高轮次频率或拆查询）`, { level: 'error', event: 'watermark_still_behind', context: { site, missRounds: cp.watermarkMissRounds, oldestPublishTime: oldestSeenPublishDate }, site });
      }
    }
  }

  if (totalNew === 0) {
    log('没有爬取到任何新数据', { event: 'no_new_data', context: { site }, site });
  }

  // 落盘失败的 id 回滚出 existingIds，避免断点将未落盘数据标记为已爬
  if (failedIds.size) {
    for (const id of failedIds) existingIds.delete(id);
  }

  if (stopping) stoppedBySignal = true;
  // 尾部游标：写盘失败时原地不动（数据没落盘，重爬同一段）；
  // 其余情况停在最早失败页（不越过失败页），没有失败页就是本轮扫到的位置。
  // 尾部游标候选：写盘失败原地不动（数据没落盘），否则停在最早失败页，
  // 没有失败页就是本轮扫到的位置。
  const scannedPage = fileWriteFailed > 0
    ? tailStartPage
    : (retryFromPage === null ? tailCursor : Math.min(retryFromPage, tailCursor));
  // 完成口径：每一页要么访问过，要么在待补清单里——没有第三种状态。
  // 撞边界的页、以及边界之后的页都已由 markRange 记平，不会制造假缺口。
  const pendingSet = new Set(cp.pending.map(entry => entry.page));
  // 全量模式：跑满 1..有效总页数且零失败才算数；否则下一轮再来。
  const fullSweepComplete = fullSweepMode
    && currentPage > effectiveTotalPages
    && totalFailed === 0
    && fileWriteFailed === 0
    && !stoppedBySignal
    && !stoppedBy468;
  if (fullSweepComplete) {
    cp.lastFullSweepAt = new Date().toISOString();
    // 追水位站点的「完整扫描」就是这次全量：sweepId / 时间戳继续在 /status 上可读。
    cp.sweepId += 1;
    cp.lastSweepCompletedAt = cp.lastFullSweepAt;
    cp.visited = [];
    log(`完成一次全量扫描 [${site}]：第 1-${effectiveTotalPages} 页全部成功（sweepId=${cp.sweepId}）`, { event: 'full_sweep_completed', context: { site, pages: effectiveTotalPages, sweepId: cp.sweepId, durationMs: Date.now() - startedAt }, site });
  } else if (fullSweepMode) {
    log(`全量扫描未完成 [${site}]：已扫到第 ${Math.min(currentPage, effectiveTotalPages)}/${effectiveTotalPages} 页（失败 ${totalFailed} 页，468 ${rateLimitedHits} 次），下一轮继续`, { level: 'warn', event: 'full_sweep_incomplete', context: { site, scanned: Math.min(currentPage, effectiveTotalPages), totalPages: effectiveTotalPages, totalFailed, rateLimitedHits }, site });
  }
  if (watermarkMode) {
    // 追水位模式没有尾部游标：每轮都从第 1 页起。visited 是「一次完整扫描覆盖了哪些页」
    // 的账本，只服务全量模式；清空它，下面的 owedPage 才会算出 1，游标自然停在页首。
    cp.visited = [];
  }
  const owedPage = oldestUnvisited(cp.visited, effectiveTotalPages, pendingSet);
  const visitedBefore = visitedCount(cp.visited);
  let retainedNotice = null;
  cp.realTotalPages = Number.isInteger(realTotalPagesObserved) ? realTotalPagesObserved : null;
  if (owedPage === null && fileWriteFailed === 0 && !stoppedBySignal) {
    // 一次完整扫描 = 1..有效总页数全覆盖。断点不再删除：sweepId / visited /
    // lastSweepCompletedAt 必须跨轮存活，否则 /status 永远没有基线。
    cp.sweepId += 1;
    cp.visited = [];
    cp.consecutiveIncompleteRounds = 0;
    cp.currentPage = 1;
    cp.lastSweepCompletedAt = new Date().toISOString();
    log(`完成一次完整扫描 [${site}]：第 1-${effectiveTotalPages} 页全部访问过（sweepId=${cp.sweepId}），下轮从第 1 页开始`, { event: 'sweep_completed', context: { site, sweepId: cp.sweepId, effectiveTotalPages, visitedPages: visitedBefore, pendingPages: cp.pending.length }, site });
  } else {
    if (!watermarkMode) cp.consecutiveIncompleteRounds += 1;
    // 游标停在「最老欠账页」，上限是本轮扫到的位置（不越过它）。
    // owedPage 可能比本轮位置更靠前——头部补扫跳过的空档要靠它填平，
    // 这不算 2026-10-27 那类回退 bug：方向相反，且重复抓到的行由台账去重。
    const ceiling = Math.max(1, Math.min(scannedPage, effectiveTotalPages));
    cp.currentPage = owedPage === null ? ceiling : Math.max(1, Math.min(owedPage, ceiling));
    const checkpointLevel = fileWriteFailed > 0 ? 'error' : 'warn';
    const checkpointEvent = fileWriteFailed > 0
      ? 'checkpoint_retained_on_file_error'
      : stoppedBySignal ? 'graceful_exit' : 'checkpoint_retained';
    retainedNotice = {
      msg: watermarkMode
        ? `本轮结束（已扫到第 ${headScanEndPage || Math.max(1, currentPage - 1)} 页），下轮仍从第 1 页起`
        : `已保留断点（起始页 ${cp.currentPage}），下次将续跑`,
      opts: { level: checkpointLevel, event: checkpointEvent, context: { currentPage: cp.currentPage, site, fileWriteFailed, fileWriteSucceeded, failedIds: failedIds.size, retryFromPage, oldestUnvisitedPage: owedPage, pendingPages: cp.pending.length }, site }
    };
  }
  try {
    saveCheckpoint(site, cp);
  } catch (error) {
    logStateWriteFailure(site, error);
    throw error;
  }
  // 先写盘、后宣称：这句「已保留断点」原先在写盘之前打印，EACCES 时照样输出，
  // 读日志的人只能确定「断点还在」，实际每小时从第 1 页重来（2026-10-29 连续 5 轮）。
  if (retainedNotice) log(retainedNotice.msg, retainedNotice.opts);
  publishStatus();

  // 本轮结束：注销并销毁换点状态机（含本站 keepAlive 隧道），
  // 下轮以全新实例开始，不存在跨轮残留
  unregisterRotation(site);
  rotation.dispose();

  const durationMs = Date.now() - startedAt;
  const totalPersisted = totalNew - failedIds.size;
  const pagesSucceeded = breaker.snapshot().contentPages;
  // 整轮没有一页成功返回：出口被封/代理全挂/站点级拦截。这类轮次与「今天没新数据」
  // 在汇总行里必须能区分开——2026-10-27 yfbzb 99/100 页失败、ceb 连续 15 轮 0 条，
  // 当时全部是 info，事后翻日志才发现（详见 test/crawlEndLevel.test.js）。
  const nothingSucceeded = pagesSucceeded === 0 && totalFailed > 0 && rateLimitedHits === 0;
  const crawlLevel = fileWriteFailed > 0 || nothingSucceeded ? 'warn' : 'info';
  const allFailedSuffix = nothingSucceeded ? '，本轮无任何页成功返回（疑似出口不可用）' : '';
  // 有失败时点明成功页数：只写「失败 99 页」会让读者以为其余页都有产出，
  // 而 99 失败 + 1 页全是旧数据同样是「这一轮几乎什么都没拿到」。
  const successSuffix = totalFailed > 0 && !nothingSucceeded ? `（成功 ${pagesSucceeded} 页）` : '';
  const narrowedSuffix = realTotalPagesObserved !== undefined && effectiveTotalPages < totalPages ? `，站点总页数 ${realTotalPagesObserved}，按 ${effectiveTotalPages} 页停止` : '';
  const gateSuffix = gateAborted
    ? (probeTimedOut ? '，第一页探针超时已暂停' : probeLimited ? '，第一页探针达到上限已暂停' : allNodesCooled ? '，全部代理节点仍在冷却期' : '，第一页探针轮尽已取消抓取')
    : '';
  log(`爬取任务完成 [${site}]：新增 ${totalNew} 条（已落盘 ${totalPersisted} 条，失败 ${failedIds.size} 条），失败 ${totalFailed} 页${successSuffix}，${endReached ? '触达站点边界' : '未触达边界'}，耗时 ${(durationMs / 1000).toFixed(1)}s${fileWriteFailed ? `，文件失败 ${fileWriteFailed} 个日期` : ''}${allFailedSuffix}${narrowedSuffix}${gateSuffix}${rateLimitedHits ? `，468 命中 ${rateLimitedHits} 次` : ''}`, { level: crawlLevel, event: 'crawl_end', context: { totalNew, totalPersisted, fileWriteFailed, fileWriteSucceeded, failedIds: failedIds.size, totalFailed, pagesSucceeded, nothingSucceeded, endReached, durationMs, stoppedBySignal, gateAborted, probeLimited, probeTimedOut, allNodesCooled, rateLimitedHits, configuredTotalPages: totalPages, realTotalPages: realTotalPagesObserved ?? null, effectiveTotalPages, site }, site });
  // 返回值给调度层用：只有真的新增了数据才值得重生成 HTML（15 分钟一轮，否则一天重写 96 次）。
  return { totalNew, totalPersisted, totalFailed, fileWriteFailed, endReached, rateLimitedHits };
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

module.exports = { crawl, crawlPage, backoffDelay, readRecentIds, fileDir, stateFile, checkpointFile, isStopping, sleepInterruptible, extractRealTotalPages, resolveProxyUrl, getProxyAgents, desensitizeProxyUrl, isNoProxy, trySwitchProxy, refreshProxyProviders, hasProxyProvider, prepareProxyPool, getRotation, BATCH_SIZE, FAILURE_STOP_THRESHOLD, REQUEST_TIMEOUT, USER_AGENT, NET_FAIL_SWITCH_THRESHOLD, NET_FAIL_BREAK_THRESHOLD, MIN_USABLE_POOL };


function normalizePublishDateSafe(value) {
  const raw = String(value == null ? '' : value).trim();
  const datePart = raw.slice(0, 10).split('/').join('-');
  if (datePart.length !== 10 || datePart[4] !== '-' || datePart[7] !== '-') return null;
  const parts = [datePart.slice(0, 4), datePart.slice(5, 7), datePart.slice(8, 10)];
  if (parts.some(part => !part || part.split('').some(ch => ch < '0' || ch > '9'))) return null;
  if (raw.length > 10 && raw[10] !== ' ' && raw[10] !== '\t') return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return datePart;
}

function persistDataFiles(site, dataByDate) {
  let fileWriteFailed = 0;
  let fileWriteSucceeded = 0;
  const failedIds = new Set();

  for (const [publishTime, data] of Object.entries(dataByDate)) {
    const publishDate = normalizePublishDateSafe(publishTime);
    if (!publishDate) {
      fileWriteFailed++;
      for (const item of data) failedIds.add(item.id);
      log(`发布日期无效，跳过写盘：${String(publishTime)}`, {
        level: 'error',
        event: 'invalid_publish_date',
        context: { site, publishTime: String(publishTime) },
        site
      });
      continue;
    }

    const fileName = path.join(fileDir(site), `${publishDate}.xlsx`);
    const dirName = path.dirname(fileName);
    try {
      fs.mkdirSync(dirName, { recursive: true });
    } catch (e) {
      const code = e.code || e.errno || 'UNKNOWN';
      fileWriteFailed++;
      for (const item of data) failedIds.add(item.id);
      log(`创建目录失败 ${dirName}: ${e.message} code=${code}，本批 ${data.length} 条数据暂无法落盘`, {
        level: 'error',
        event: 'file_mkdir_failed',
        context: { file: fileName, error: e.message, code, site },
        site
      });
      continue;
    }

    try {
      let existingFileData = [];
      if (fs.existsSync(fileName)) {
        const rows = readXlsxRowsSafe(fileName, site, 'merge_read_failed');
        if (rows === null) {
          const bak = `${fileName}.corrupt.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
          try {
            fs.renameSync(fileName, bak);
            log(`已备份损坏文件 ${fileName} → ${bak}`, {
              level: 'warn',
              event: 'corrupt_backed_up',
              context: { file: fileName, bak, site },
              site
            });
          } catch (renameErr) {
            const code = renameErr.code || renameErr.errno || 'UNKNOWN';
            log(`备份损坏文件失败 ${fileName}: ${renameErr.message} code=${code}`, {
              level: 'warn',
              event: 'corrupt_backup_failed',
              context: { file: fileName, error: renameErr.message, code, site },
              site
            });
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
      log(`更新文件 ${fileName}，新增 ${data.length} 条记录`, {
        event: 'file_written',
        context: { file: fileName, newCount: data.length, site },
        site
      });
    } catch (e) {
      const code = e.code || e.errno || 'UNKNOWN';
      fileWriteFailed++;
      for (const item of data) failedIds.add(item.id);
      log(`写入文件失败 ${fileName}: ${e.message} code=${code}，本批 ${data.length} 条数据暂未落盘，将随断点重试`, {
        level: 'error',
        event: 'file_write_failed',
        context: { file: fileName, error: e.message, code, site },
        site
      });
    }
  }

  return { fileWriteFailed, fileWriteSucceeded, failedIds };
}
