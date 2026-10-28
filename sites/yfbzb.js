// 真实总页数：分页控件 li.controls 文本「当前 … / … 条，共 3000 条」÷ 自身 urlSuffix 的 pageSize。
// 必须限定在 .pagination 子树内匹配 —— 全页匹配会先撞上统计横幅「近1个月共76470条」（README 明令禁止采用）。
function parseTotalPages($, html, siteConfig) {
  const $pag = $('div.pagination').first();
  if ($pag.length === 0) return null;
  const controlsText = ($pag.find('li.controls').text() || '').replace(/\s+/g, '');
  const mRecords = /共(\d+)条/.exec(controlsText);
  if (mRecords) {
    const records = parseInt(mRecords[1], 10);
    const mSize = /pageSize=(\d+)/.exec((siteConfig && siteConfig.urlSuffix) || '');
    const pageSize = mSize ? parseInt(mSize[1], 10) : 0;
    if (records > 0 && pageSize > 0) return Math.max(1, Math.ceil(records / pageSize));
  }
  // 兜底：分页器中最大的数字页码链接（「上一页/下一页/…」均被 ^\d+$ 过滤）
  let maxPage = 0;
  $pag.find('a').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (/^\d+$/.test(t)) maxPage = Math.max(maxPage, parseInt(t, 10));
  });
  return maxPage > 0 ? maxPage : null;
}

// SafeLine（雷池 WAF）拦截页指纹。实测（.scratch/yfbzb-live-probe/FINDINGS.md）：
// 第 100 页的「页码上限」与临时封禁返回同一张拦截页，响应体引用 /.safeline/ 静态资源。
// 因此指纹只能说明「被 SafeLine 拦了」，分不出是页尾还是临时封禁；
// 二者只能由页号位置区分（末页按边界收尾、中间按失败页处理，见 crawler.js）。
const SAFELINE_FINGERPRINT = '/.safeline/';

// 2026-10-28 生产日志：yfbzb 第 61-99 页连续返回 468，重试期间持续命中；
// 第 100 页仍是 SafeLine 403。468 不是标准 HTTP 状态，常见于 WAF/风控拦截，
// 与 SafeLine 一样不能当普通失败页逐页重试——否则一批 10 页各打 3 次，
// 既扩大封禁又让 breaker 看不到「连续拦截」而空转到站点末页。
const RATE_LIMIT_STATUS = 468;

function responseBody(error) {
  const data = error && error.response && error.response.data;
  if (data == null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  try { return JSON.stringify(data); } catch (_) { return String(data); }
}

function isSafeLineBlock(error) {
  return !!(error && error.response && error.response.status === 403
    && responseBody(error).includes(SAFELINE_FINGERPRINT));
}

function isRateLimitBlock(error) {
  return !!(error && error.response && error.response.status === RATE_LIMIT_STATUS);
}

module.exports = {
  name: 'yfbzb',
  displayName: '乙方宝·湖北',
  description: '湖北省招标公告与邀请招标数据',
  originUrl: 'https://www.yfbzb.com',
  baseUrl: 'https://www.yfbzb.com/search/invitedBidSearch?type=0&defaultSearch=false&keyword=&pageNo=',
  urlSuffix: '&pageSize=30&provinceId=12&noticeType=3&invitedBidType=3&timeType=1&searchMode=1',
  linkPrefix: 'https://www.yfbzb.com',
  selectors: {
    rows: '#treeTable tbody tr',
    titleLink: 'td:first-child a',
    noticeType: 'td:nth-child(2)',
    area: 'td:nth-child(3)',
    publishTime: 'td:nth-child(4)'
  },
  // 可选策略钩子（全部可选，缺省走 crawler.js 内联默认行为）：
  // buildUrl(pageNo) { return `${this.baseUrl}${pageNo}${this.urlSuffix}`; },
  // extractId(link) { return link.split('/').pop().split('.')[0]; },
  // parse($, html, existingIds) { /* 接管整页解析，返回 pageData[] */ },
  // batchSize: 10,
  // failureThreshold: 2,
  // timeout: 30000,
  // headers: { 'User-Agent': '...' },
  // 403 默认是数据边界；命中 SafeLine 指纹时不能断定「到底了」——临时封禁也长这样。
  // 交回 crawler 按失败页处理，由页号位置决定是否按边界收尾。
  isBoundary(error) {
    if (!error || !error.response || error.response.status !== 403) return false;
    return !isSafeLineBlock(error);
  },
  // 拦截页类型：crawler 据此快败为失败页（shieldType），连续 2 页交给 breaker 熔断。
  // 468 是站点级风控拦截（不是页尾），绝不能被 isBoundary 当作数据边界。
  blockType(error) {
    if (isRateLimitBlock(error)) return 'http468';
    return isSafeLineBlock(error) ? 'safeline' : null;
  },
  parseTotalPages
};
