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
  // isBoundary(error) { return error?.response?.status === 403; },
  // parse($, html, existingIds) { /* 接管整页解析，返回 pageData[] */ },
  // batchSize: 10,
  // failureThreshold: 2,
  // timeout: 30000,
  // headers: { 'User-Agent': '...' },
  parseTotalPages
};
