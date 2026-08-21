// 中国招标投标公共服务平台 - 湖北（ceb）
// 列表页: https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html
// 风控敏感：VAPTCHA 已在当前页面注释但仍有 JSESSIONID/acw_tc，禁止并发，必须串行+抖动

// 上海时区日期（与 crawler.js#shanghaiDateStr 同款，TZ 无关）
function shanghaiDateStr(offsetDays = 0, nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function formatDate(d) {
  // 兼容旧调用：若传入 Date，按上海时区格式化；否则按本地（保留但不再用于 buildUrl）
  if (d instanceof Date) {
    return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  }
  return String(d);
}

function searchDateForDates(dates, nowMs = Date.now()) {
  // 基于上海 wall-clock 计算，避免本地 TZ 漂移与 setMonth 回绕
  const shanghai = new Date(nowMs + 8 * 3600000);
  if (dates === 300) {
    shanghai.setUTCFullYear(shanghai.getUTCFullYear() - 25);
  } else if (dates === 30 || dates === 90) {
    // 修复：原 setMonth 回绕（3-31 减 1 月 → 3-03），改为按天减
    shanghai.setUTCDate(shanghai.getUTCDate() - dates);
  } else if ([0, 2, 3, 7].includes(dates)) {
    shanghai.setUTCDate(shanghai.getUTCDate() - dates);
  }
  return shanghai.toISOString().slice(0, 10);
}

function extractId(link) {
  if (!link) return '';
  const s = String(link);
  // javascript:urlOpen('hex32')
  const m = s.match(/urlOpen\('([^']+)'\)/);
  if (m) return m[1];
  // 已拼好的 detail 链接 ?uuid=hex
  try {
    const u = new URL(s, 'https://ctbpsp.com');
    const uuid = u.searchParams.get('uuid');
    if (uuid) return uuid;
  } catch (_) {}
  return s.split('/').pop().split('.')[0].split('?')[0].split('#')[0];
}

function isBoundary(error) {
  if (!error || !error.response) return false;
  const status = error.response.status;
  // 429 限频应重试而非判为边界；仅 403 视为数据边界
  if (status === 429) return false;
  return status === 403;
}

function buildUrl(pageNo) {
  const dates = this.dates ?? 300;
  const categoryId = this.categoryId ?? '88';
  const area = this.area ?? '420000';
  const page = Math.max(1, parseInt(pageNo, 10) || 1);

  const nowMs = Date.now();
  const searchDate = searchDateForDates(dates, nowMs);

  // 窗口：昨日 00:00:00 ~ 今日 23:59:59，与 yfbzb 的今/昨天去重语义一致（固定上海时区）
  const today = shanghaiDateStr(0, nowMs);
  const yesterday = shanghaiDateStr(-1, nowMs);

  const startcheckDate = yesterday;
  const endcheckDate = `${today} 23:59:59`;

  const base = 'https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html';
  const params = [
    `searchDate=${searchDate}`,
    `dates=${dates}`,
    `categoryId=${categoryId}`,
    `industryName=`,
    `area=${area}`,
    `status=`,
    `publishMedia=`,
    `sourceInfo=`,
    `showStatus=0`,
    `word=`,
    `startcheckDate=${startcheckDate}`,
    `endcheckDate=${encodeURIComponent(endcheckDate)}`,
    `page=${page}`
  ].join('&');

  return `${base}?${params}`;
}

async function parse($, html, existingIds, siteConfig) {
  const seen = existingIds instanceof Set ? existingIds : new Set();
  // 表头在第一行 th，数据行含 td[name="imgShow"] 或 javascript:urlOpen
  const rows = $('table.table_text tr').filter((_, el) => $(el).find('td').length > 0);
  if (rows.length === 0) return [];

  const pageData = [];
  rows.each((_, el) => {
    const $row = $(el);
    const $a = $row.find('td[name="imgShow"] a').first();
    const href = $a.attr('href') || '';
    // 兼容历史快照：部分行可能是无效展开行，无 a
    if (!href) return;
    const id = extractId(href);
    if (!id) return;
    if (seen.has(id)) return;

    const title = ($a.attr('title') || $a.text() || '').trim();
    if (!title) return;

    const tds = $row.find('td');
    // 列：0 标题 | 1 行业 | 2 地区 | 3 发布媒介 | 4 发布时间 | 5 距离开标
    const industry = tds.eq(1).text().trim();
    const area = tds.eq(2).text().trim().replace(/【|】/g, '');
    const publishTimeRaw = tds.eq(4).text().trim();
    // 发布时间形如 2026-08-20，已为 YYYY-MM-DD，可直接作分区键
    const publishTime = publishTimeRaw.replace(/\//g, '-');

    const link = `https://ctbpsp.com/#/bulletinDetail?uuid=${id}&inpvalue=&dataSource=0&tenderAgency=`;

    pageData.push({
      id,
      title,
      link,
      noticeType: industry,
      area,
      publishTime
    });
  });

  return pageData;
}

module.exports = {
  name: 'ceb',
  displayName: '中国招标公共服务平台·湖北',
  description: '中国招标投标公共服务平台 · 湖北地区招标公告',
  originUrl: 'https://bulletin.cebpubservice.com',
  baseUrl: 'https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html',
  // 供 buildUrl 使用的可覆盖项
  dates: 300,
  categoryId: '88',
  area: '420000',
  // 风控：串行 + 批次间已有 INTERVAL_MS，再叠加页内抖动
  batchSize: 1,
  failureThreshold: 2,
  timeout: 30000,
  // 发请求前随机抖动（crawler.js 识别此字段）
  requestDelay: { min: 2500, max: 5500 },
  // 405 容错：GET 被 WAF 拒时自动降级为 POST（crawler.js 识别）
  method: 'GET',
  fallbackOn405: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    // 精简指纹：移除 Sec-Fetch-* / Upgrade-Insecure-Requests，避免与 WAF 校验不一致触发 405
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://bulletin.cebpubservice.com/'
  },
  buildUrl,
  extractId,
  isBoundary,
  parse
};
