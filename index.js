const { crawl, isStopping } = require('./crawler');
const { generateReport, generateNav } = require('./report');
const { log } = require('./log');
const { startServer } = require('./server');
const { getSiteConfig, normalizeSite, normalizeSites, parseSitesList } = require('./sites');

function parseArguments() {
  const args = process.argv.slice(2);
  const totalPages = parseInt(args[0]) || 100;
  const interval = parseInt(args[1]) || 5000;
  const minDelay = parseInt(args[2]) || 0;
  const maxDelay = parseInt(args[3]) || 300;
  return { totalPages, interval, minDelay, maxDelay };
}

function parsePerSiteOverrides(sites, globalDefaults) {
  let sitesConfigJson = null;
  if (process.env.SITES_CONFIG) {
    try {
      sitesConfigJson = JSON.parse(process.env.SITES_CONFIG);
    } catch (e) {
      console.warn(`SITES_CONFIG JSON 解析失败，已忽略: ${e.message}`);
    }
  }
  const perSite = {};
  for (const site of sites) {
    const upper = site.toUpperCase();
    const tpSite = parseInt(process.env[`TOTAL_PAGES_${upper}`] || process.env[`PAGES_${upper}`] || '', 10);
    const ivSite = parseInt(process.env[`INTERVAL_MS_${upper}`] || process.env[`INTERVAL_${upper}`] || '', 10);
    const mindSite = parseInt(process.env[`MIN_DELAY_S_${upper}`] || process.env[`MIN_DELAY_${upper}`] || '', 10);
    const maxdSite = parseInt(process.env[`MAX_DELAY_S_${upper}`] || process.env[`MAX_DELAY_${upper}`] || '', 10);
    const cronSite = (process.env[`CRON_${upper}`] || process.env[`CRON_EXPR_${upper}`] || '').trim();
    const jsonSite = sitesConfigJson ? (sitesConfigJson[site] || sitesConfigJson[upper] || sitesConfigJson[site.toLowerCase()] || {}) : {};
    perSite[site] = {
      totalPages: Number.isFinite(tpSite) ? tpSite : (jsonSite.totalPages ?? jsonSite.TOTAL_PAGES ?? jsonSite.pages ?? globalDefaults.totalPages),
      interval: Number.isFinite(ivSite) ? ivSite : (jsonSite.interval ?? jsonSite.INTERVAL_MS ?? jsonSite.INTERVAL ?? globalDefaults.interval),
      minDelay: Number.isFinite(mindSite) ? mindSite : (jsonSite.minDelay ?? jsonSite.MIN_DELAY_S ?? jsonSite.MIN_DELAY ?? globalDefaults.minDelay),
      maxDelay: Number.isFinite(maxdSite) ? maxdSite : (jsonSite.maxDelay ?? jsonSite.MAX_DELAY_S ?? jsonSite.MAX_DELAY ?? globalDefaults.maxDelay),
      cronExpr: cronSite || jsonSite.cron || jsonSite.CRON_EXPR || jsonSite.cronExpr || globalDefaults.cronExpr
    };
  }
  return perSite;
}

function parseEnv() {
  const argv = parseArguments();
  const sites = parseSitesList();
  const tp = parseInt(process.env.TOTAL_PAGES || process.env.PAGES || '', 10);
  const iv = parseInt(process.env.INTERVAL_MS || process.env.INTERVAL || '', 10);
  const mind = parseInt(process.env.MIN_DELAY_S || process.env.MIN_DELAY || '', 10);
  const maxd = parseInt(process.env.MAX_DELAY_S || process.env.MAX_DELAY || '', 10);
  const cronExpr = (process.env.CRON_EXPR || process.env.CRON || '').trim();
  const globalDefaults = {
    totalPages: Number.isFinite(tp) ? tp : argv.totalPages,
    interval: Number.isFinite(iv) ? iv : argv.interval,
    minDelay: Number.isFinite(mind) ? mind : argv.minDelay,
    maxDelay: Number.isFinite(maxd) ? maxd : argv.maxDelay,
    cronExpr
  };
  const perSite = parsePerSiteOverrides(sites, globalDefaults);
  return {
    sites,
    site: sites[0] || 'yfbzb',
    ...globalDefaults,
    perSite
  };
}

function validateInput(input) {
  // 兼容旧签名 {site, totalPages, ...} 与新签名 {sites, perSite, totalPages, ...}
  const sites = input.sites || (input.site ? [normalizeSite(input.site)] : parseSitesList());
  const perSite = input.perSite || null;

  // 校验全局或单站数值（用于兼容旧调用）
  const globalTotalPages = input.totalPages;
  const globalInterval = input.interval;
  const globalMinDelay = input.minDelay;
  const globalMaxDelay = input.maxDelay;
  const globalCron = input.cronExpr;

  if (globalTotalPages !== undefined && (globalTotalPages <= 0 || globalInterval <= 0 || globalMinDelay < 0 || globalMaxDelay < globalMinDelay)) {
    console.error('输入无效，请确保所有参数都是有效的正数，且最大延迟不小于最小延迟');
    console.log('使用方法: node index.js [页数] [间隔时间(毫秒)] [最小延迟(秒)] [最大延迟(秒)]');
    console.log('例如: node index.js 100 5000 0 300');
    console.log('或通过环境变量: SITES=yfbzb,site2 TOTAL_PAGES=100 INTERVAL_MS=5000 MIN_DELAY_S=0 MAX_DELAY_S=300 CRON_EXPR="0 2 * * *"');
    process.exit(1);
  }

  // 逐站校验
  const validSites = [];
  const invalid = [];
  for (const site of sites) {
    try {
      getSiteConfig(site);
      validSites.push(site);
    } catch (e) {
      invalid.push(`${site}: ${e.message}`);
    }
  }
  if (validSites.length === 0) {
    console.error(`站点校验失败: ${invalid.join('; ')}`);
    process.exit(1);
  }
  if (invalid.length) {
    console.warn(`部分站点校验失败，已跳过: ${invalid.join('; ')} —— 将仅运行有效站点: ${validSites.join(', ')}`);
    // 收窄 input.sites 供后续调度使用
    input.sites = validSites;
    if (input.perSite) {
      // 清理无效站点的 perSite 条目
      for (const k of Object.keys(input.perSite)) {
        if (!validSites.includes(k)) delete input.perSite[k];
      }
    }
  }

  // 校验每站 cron 与数值
  const toCheck = perSite ? Object.entries(perSite) : sites.map(s => [s, { cronExpr: globalCron, totalPages: globalTotalPages, interval: globalInterval, minDelay: globalMinDelay, maxDelay: globalMaxDelay }]);
  for (const [site, cfg] of toCheck) {
    if (!validSites.includes(site)) continue;
    const tp = cfg.totalPages ?? globalTotalPages;
    const iv = cfg.interval ?? globalInterval;
    const mind = cfg.minDelay ?? globalMinDelay;
    const maxd = cfg.maxDelay ?? globalMaxDelay;
    const cron = cfg.cronExpr ?? globalCron;
    if (tp !== undefined && (tp <= 0 || iv <= 0 || mind < 0 || maxd < mind)) {
      console.error(`站点 [${site}] 参数无效: totalPages=${tp} interval=${iv} minDelay=${mind} maxDelay=${maxd}`);
      process.exit(1);
    }
    if (cron) {
      try {
        nextCronDelay(cron);
      } catch (e) {
        console.error(`站点 [${site}] CRON 无效: ${e.message}（例如 "0 2 * * *" 每天02:00，"10,40 * * * *" 每小时10/40分）`);
        // 任何来源的非法 cron 均需 fail-fast（包括 SITES_CONFIG），避免静默放行后运行时崩溃
        if (cron === globalCron) {
          console.error(`CRON_EXPR 无效: ${e.message}（例如 "0 2 * * *" 每天02:00，"10,40 * * * *" 每小时10/40分）`);
        }
        process.exit(1);
      }
    }
  }
}

function getRandomDelay(minSeconds, maxSeconds) {
  return Math.floor(Math.random() * (maxSeconds - minSeconds + 1) + minSeconds) * 1000;
}

// 标准 5 段 cron：分 时 日 月 周，支持 *, 逗号, 区间, 步长（如 "10,40 * * * *" 每小时10/40分，"0 2 * * *" 每天02:00，"*/15 * * * *" 每15分钟）
// 时区固定为 Asia/Shanghai（与 TZ 环境一致）
function nextCronDelay(cronExpr) {
  // 兼容 "10, 40 * * * *" 这类逗号后带空格的写法
  const normalizedExpr = cronExpr.trim().replace(/\s*,\s*/g, ',');
  const parts = normalizedExpr.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 需 5 段， got ${parts.length}`);
  const [minStr, hourStr, domStr, monStr, dowStr] = parts;

  function parseField(field, min, max, name) {
    const values = new Set();
    const isStar = field === '*';
    if (isStar) {
      for (let i = min; i <= max; i++) values.add(i);
      return { values, isStar: true };
    }
    const segments = field.split(',').map(s => s.trim());
    for (let seg of segments) {
      if (!seg) throw new Error(`${name} 字段含空段 "${field}"`);
      let rangePart = seg;
      let step = 1;
      if (seg.includes('/')) {
        const idx = seg.indexOf('/');
        rangePart = seg.slice(0, idx).trim();
        const stepStr = seg.slice(idx + 1).trim();
        if (!/^\d+$/.test(stepStr)) throw new Error(`${name} 步长需正整数，got "${seg}"`);
        step = parseInt(stepStr, 10);
        if (step <= 0) throw new Error(`${name} 步长需正整数，got "${seg}"`);
        if (!rangePart) throw new Error(`${name} 字段格式错误 "${seg}"`);
      }
      rangePart = rangePart.trim();
      let start; let end;
      if (rangePart === '*') {
        start = min; end = max;
      } else if (rangePart.includes('-')) {
        const [aRaw, bRaw] = rangePart.split('-');
        const a = aRaw.trim(); const b = bRaw.trim();
        if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new Error(`${name} 区间需数字，got "${seg}"`);
        start = parseInt(a, 10); end = parseInt(b, 10);
        if (start < min || end > max || start > end) throw new Error(`${name} 需 ${min}-${max}，got "${seg}"`);
      } else {
        if (!/^\d+$/.test(rangePart)) throw new Error(`${name} 需数字或 *，got "${seg}"`);
        const v = parseInt(rangePart, 10);
        if (v < min || v > max) throw new Error(`${name} 需 ${min}-${max}，got "${seg}"`);
        if (seg.includes('/')) { start = v; end = max; } else { start = v; end = v; }
      }
      for (let v = start; v <= end; v += step) values.add(v);
    }
    if (values.size === 0) throw new Error(`${name} 字段无有效值 "${field}"`);
    return { values, isStar: false };
  }

  const minF = parseField(minStr, 0, 59, '分钟');
  const hourF = parseField(hourStr, 0, 23, '小时');
  const domF = parseField(domStr, 1, 31, '日');
  const monF = parseField(monStr, 1, 12, '月');
  const dowF = parseField(dowStr, 0, 7, '周');
  // 周日的 7 别名归一到 0
  if (dowF.values.has(7)) { dowF.values.delete(7); dowF.values.add(0); }

  const nowMs = Date.now();
  const shanghaiNowMs = nowMs + 8 * 3600000;
  // 对齐到分钟起点：若刚好在整分则立即匹配（与旧 daily 逻辑一致，delay=0），否则取下一分钟
  let candidateMs = shanghaiNowMs - (shanghaiNowMs % 60000);
  if (candidateMs < shanghaiNowMs) candidateMs += 60000;
  // 上限 4 年逐分钟扫描，覆盖闰年 2-29（"0 0 29 2 *" 距今约 1461 天）；非法日期如 2-30 仍会在穷尽后抛错
  const limit = candidateMs + 1461 * 24 * 60 * 60000;
  for (let t = candidateMs; t < limit; t += 60000) {
    const d = new Date(t);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const mon = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();
    if (!minF.values.has(minute)) continue;
    if (!hourF.values.has(hour)) continue;
    if (!monF.values.has(mon)) continue;
    const domMatch = domF.values.has(dom);
    const dowMatch = dowF.values.has(dow);
    let dayMatch;
    if (domF.isStar && dowF.isStar) dayMatch = true;
    else if (domF.isStar) dayMatch = dowMatch;
    else if (dowF.isStar) dayMatch = domMatch;
    else dayMatch = domMatch || dowMatch;
    if (!dayMatch) continue;
    return t - shanghaiNowMs;
  }
  throw new Error(`cron "${cronExpr}" 在 1461 天内无匹配时间`);
}

async function scheduleLoopForSite({ site, totalPages, interval, minDelay, maxDelay, cronExpr }) {
  const siteNorm = normalizeSite(site);
  async function runOnce() {
    const initialDelay = getRandomDelay(minDelay, maxDelay);
    log(`站点 [${siteNorm}] 将在 ${(initialDelay / 1000).toFixed(1)} 秒后开始运行`, { event: 'schedule_wait', context: { site: siteNorm, delayMs: initialDelay }, site: siteNorm });
    const slept = await sleepInterruptible(initialDelay);
    if (!slept || isStopping()) return;
    // 开始爬取由 crawler.js#crawl 的 crawl_start 事件记录，此处不再重复打点
    try {
      await crawl({ site: siteNorm, totalPages, interval });
      log('爬取任务已完成', { event: 'schedule_run_done', context: { site: siteNorm }, site: siteNorm });
    } catch (error) {
      log(`爬取过程中出现错误: ${error.message}`, { level: 'error', event: 'schedule_run_error', context: { site: siteNorm, error: error.message }, site: siteNorm });
    }
    try {
      await generateReport(siteNorm);
    } catch (error) {
      log(`生成 HTML 报告失败: ${error.message}`, { level: 'error', event: 'report_failed', context: { site: siteNorm, error: error.message }, site: siteNorm });
    }
    try {
      await generateNav();
    } catch (error) {
      log(`刷新导航页失败: ${error.message}`, { level: 'error', event: 'nav_failed', context: { site: siteNorm, error: error.message }, site: siteNorm });
    }
  }

  // 单次模式由外层统一 keepalive，此处仅跑一次即可
  if (!cronExpr) {
    await runOnce();
    return;
  }

  // 定时常驻：每站独立循环
  while (!isStopping()) {
    let delayMs;
    try {
      delayMs = nextCronDelay(cronExpr);
    } catch (e) {
      log(`站点 [${siteNorm}] CRON 运行时错误: ${e.message}（CRON="${cronExpr}"），60秒后重试`, { level: 'error', event: 'cron_runtime_error', context: { site: siteNorm, cronExpr, error: e.message }, site: siteNorm });
      const slept = await sleepInterruptible(60000);
      if (!slept || isStopping()) break;
      continue;
    }
    const nextAt = new Date(Date.now() + delayMs);
    log(`站点 [${siteNorm}] 下次运行于 ${nextAt.toLocaleString('zh-CN', { hour12: false })}（${(delayMs / 1000 / 60).toFixed(1)} 分钟后，CRON="${cronExpr}"）`, { event: 'schedule_next', context: { site: siteNorm, cronExpr, delayMs, nextAt: nextAt.toISOString() }, site: siteNorm });
    const slept = await sleepInterruptible(delayMs);
    if (!slept || isStopping()) break;
    try {
      await runOnce();
    } catch (error) {
      log(`定时任务失败: ${error.message}`, { level: 'error', event: 'scheduled_run_failed', context: { site: siteNorm, error: error.message }, site: siteNorm });
    }
  }
}

async function scheduleLoop(input) {
  // 兼容旧签名 {site,...} 与新签名 {sites, perSite, ...}
  const rawSites = input.sites || (input.site ? [normalizeSite(input.site)] : parseSitesList());
  const perSite = input.perSite || null;

  // 过滤有效站点（validateInput 已做，此处再兜底）
  const sites = [];
  for (const s of rawSites) {
    try { getSiteConfig(s); sites.push(s); } catch (e) { log(`跳过未实现站点 [${s}]: ${e.message}`, { level: 'warn', event: 'site_skip', context: { site: s }, site: s }); }
  }
  if (sites.length === 0) {
    console.error('无有效站点可运行');
    process.exit(1);
  }

  const siteConfigs = sites.map(site => {
    const ps = perSite ? (perSite[site] || {}) : {};
    return {
      site,
      totalPages: ps.totalPages ?? input.totalPages ?? 100,
      interval: ps.interval ?? input.interval ?? 5000,
      minDelay: ps.minDelay ?? input.minDelay ?? 0,
      maxDelay: ps.maxDelay ?? input.maxDelay ?? 300,
      cronExpr: ps.cronExpr ?? input.cronExpr ?? ''
    };
  });

  const hasAnyCron = siteConfigs.some(c => !!c.cronExpr);
  if (!hasAnyCron) {
    // 单次模式：并发跑所有站点一次，然后常驻等待
    await Promise.all(siteConfigs.map(cfg => scheduleLoopForSite(cfg)));
    if (isStopping()) process.exit(0);
    if (siteConfigs.length === 1) {
      log(`CRON_EXPR 未设，已完成单次运行，常驻等待（docker stop 将优雅退出）`, { event: 'single_run_done', context: { site: siteConfigs[0].site }, site: siteConfigs[0].site });
    } else {
      log(`CRON_EXPR 未设，已完成全部 ${siteConfigs.length} 个站点单次运行，常驻等待（docker stop 将优雅退出）`, { event: 'single_run_done', context: { sites: siteConfigs.map(c => c.site).join(',') }, site: siteConfigs[0].site });
    }
    while (!isStopping()) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.exit(0);
  }

  // 混合/定时模式：有 cron 的站点走独立定时循环，无 cron 的站点已在上方单次跑过，这里仅对有 cron 的并发常驻
  const cronSites = siteConfigs.filter(c => !!c.cronExpr);
  const onceSites = siteConfigs.filter(c => !c.cronExpr);
  if (onceSites.length) {
    await Promise.all(onceSites.map(cfg => scheduleLoopForSite(cfg)));
    if (onceSites.length && cronSites.length) {
      log(`已完成 ${onceSites.length} 个无定时站点单次运行，定时站点将继续常驻`, { event: 'single_run_done', context: { sites: onceSites.map(c => c.site).join(',') }, site: onceSites[0].site });
    }
  }
  if (cronSites.length) {
    await Promise.all(cronSites.map(cfg => scheduleLoopForSite(cfg)));
  }
  process.exit(0);
}

async function sleepInterruptible(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    if (!Number.isFinite(ms)) log(`sleepInterruptible 非法 ms=${String(ms)}，已跳过`, { level: 'warn', event: 'sleep_invalid', context: { ms: String(ms) } });
    return !isStopping();
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopping()) return false;
    await new Promise(r => setTimeout(r, Math.min(1000, end - Date.now())));
  }
  return !isStopping();
}

if (require.main === module) {
  const env = parseEnv();
  validateInput(env);
  // 启动静态文件服务（托管 file/，根路径为总导航）
  const httpServer = startServer();
  // 尽力预生成导航页，使域名访问立即可用（不阻塞爬取调度）
  generateNav(env.sites).catch(e => {
    log(`预生成导航页失败: ${e.message}`, { level: 'warn', event: 'nav_pre_failed', context: { error: e.message } });
  });
  // 优雅关闭：随爬虫 stopping 一并关闭 HTTP 服务
  if (httpServer) {
    const closeHttp = () => {
      try { httpServer.close(); } catch (_) {}
    };
    process.on('SIGINT', closeHttp);
    process.on('SIGTERM', closeHttp);
  }
  scheduleLoop(env);
}

module.exports = { parseEnv, nextCronDelay, validateInput, getRandomDelay, scheduleLoop, scheduleLoopForSite, sleepInterruptible, parsePerSiteOverrides: parsePerSiteOverrides };
