module.exports = {
  name: 'site2',
  // TODO: 接入真实站点后填 baseUrl/urlSuffix/selectors，移除占位校验
  baseUrl: '',
  urlSuffix: '',
  selectors: {
    rows: '#treeTable tbody tr',
    titleLink: 'td:first-child a',
    noticeType: 'td:nth-child(2)',
    area: 'td:nth-child(3)',
    publishTime: 'td:nth-child(4)'
  },
  get disabledReason() {
    return 'site2 尚未实现：请填入 baseUrl/urlSuffix 后移除此占位';
  }
};
