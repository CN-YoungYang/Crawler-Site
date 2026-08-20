module.exports = {
  name: 'yfbzb',
  baseUrl: 'https://www.yfbzb.com/search/invitedBidSearch?type=0&defaultSearch=false&keyword=&pageNo=',
  urlSuffix: '&pageSize=30&provinceId=12&noticeType=3&invitedBidType=3&timeType=1&searchMode=1',
  linkPrefix: 'https://www.yfbzb.com',
  selectors: {
    rows: '#treeTable tbody tr',
    titleLink: 'td:first-child a',
    noticeType: 'td:nth-child(2)',
    area: 'td:nth-child(3)',
    publishTime: 'td:nth-child(4)'
  }
  // 可选策略钩子（全部可选，缺省走 _base.js 默认行为）：
  // buildUrl(pageNo) { return `${this.baseUrl}${pageNo}${this.urlSuffix}`; },
  // extractId(link) { return link.split('/').pop().split('.')[0]; },
  // isBoundary(error) { return error?.response?.status === 403; },
  // parse($, html, existingIds) { /* 接管整页解析，返回 pageData[] */ },
  // batchSize: 10,
  // failureThreshold: 2,
  // timeout: 30000,
  // headers: { 'User-Agent': '...' },
};
