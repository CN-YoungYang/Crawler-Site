// 示例站点：演示策略钩子用法（JSON/自定义解析）
// 本文件展示如何通过 parse/buildUrl/extractId/isBoundary 等钩子接管逻辑
// 实际新站点可复制此模板后填入真实 URL 与解析

module.exports = {
  name: 'demo',
  // 演示用：不真实请求，仅用于单元测试中被 mock
  baseUrl: 'https://example.com/api/list?pageNo=',
  urlSuffix: '&pageSize=20',
  linkPrefix: 'https://example.com',
  selectors: {
    rows: '.item',
    titleLink: '.title a',
    noticeType: '.type',
    area: '.area',
    publishTime: '.date'
  },
  // 可选：自定义 URL 构建
  // buildUrl(pageNo) { return `${this.baseUrl}${pageNo}${this.urlSuffix}`; },
  // 可选：自定义边界判定
  // isBoundary(error) { return error?.response?.status === 404; },
  // 可选：自定义 ID 抽取
  // extractId(link) { return new URL(link, this.linkPrefix).searchParams.get('id') || link.split('/').pop(); },
  // 可选：完全接管解析（例如 JSON API）
  // async parse($, html, existingIds, siteConfig) {
  //   const data = JSON.parse(html);
  //   return data.items.map(row => ({
  //     id: row.id,
  //     title: row.title,
  //     link: `${siteConfig.linkPrefix}/detail/${row.id}`,
  //     noticeType: row.type,
  //     area: row.area,
  //     publishTime: row.publishTime // 格式需为 YYYY/MM/DD 或 YYYY-MM-DD，最终会按 publishTime 分区写盘
  //   }));
  // },
  batchSize: 5,
  failureThreshold: 1,
  timeout: 15000
};
