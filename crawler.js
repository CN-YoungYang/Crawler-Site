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
// 真实浏览器 UA，避免默认 axios UA 被站点日志一眼识别为爬虫
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  const headers = siteConfig.headers || { 'User-Agent': USER_AGENT };

  // 策略化 URL 构建
  const url = typeof siteConfig.buildUrl === 'function'
    ? siteConfig.buildUrl.call(siteConfig, pageNo)
    : defaultBuildUrl(pageNo, siteConfig);

  let retries = 0;

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
      const response = await axios.get(url, { timeout, headers });

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
      retries++;
      const backoff = backoffDelay(retries - 1);
      log(`第 ${pageNo} 页加载失败 [code=${error.code} status=${error.response?.status}]：${error.message}，正在进行第 ${retries} 次重试，${backoff}ms 后...`, { level: 'warn', event: 'retry', context: { page: pageNo, attempt: retries, backoffMs: backoff, code: error.code, status: error.response?.status, site: siteName }, site: siteName });
      if (retries === maxRetries) {
        log(`第 ${pageNo} 页加载失败，已达到最大重试次数，跳过此页 [code=${error.code} status=${error.response?.status}]`, { level: 'error', event: 'page_failed', context: { page: pageNo, code: error.code, status: error.response?.status, site: siteName }, site: siteName });
        return { pageData: [], failed: true };
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
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
      const { pageData, failed, endReached: ended } = results[i];
      const pageNo = currentPage + i;

      if (failed) {
        failedCount++;
        totalFailed++;
        log(`第 ${pageNo} 页爬取失败，已跳过`, { level: 'warn', event: 'page_skipped', context: { page: pageNo, site }, site });
        continue;
      }

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

    if (batchEndReached) {
      endReached = true;
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount <= failureThreshold) {
      log(`当前批次（第 ${currentPage - pagesToCrawl} 到第 ${currentPage - 1} 页）无新数据且失败 ${failedCount} 页（≤ ${failureThreshold}），停止爬取`, { event: 'early_stop', context: { failedCount, threshold: failureThreshold, site }, site });
      shouldStopCrawling = true;
    } else if (!hasNewDataInBatch && failedCount > failureThreshold) {
      log(`当前批次无新数据，但失败 ${failedCount} 页（> ${failureThreshold}），失败页可能掩盖新数据，继续爬取下一批`, { level: 'warn', event: 'continue_despite_failures', context: { failedCount, threshold: failureThreshold, site }, site });
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

module.exports = { crawl, crawlPage, backoffDelay, readRecentIds, fileDir, stateFile, isStopping, BATCH_SIZE, FAILURE_STOP_THRESHOLD, REQUEST_TIMEOUT, USER_AGENT };
