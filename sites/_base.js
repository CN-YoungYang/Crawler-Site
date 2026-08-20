// 策略基座：常用默认实现，供各站点按需覆盖
// 不直接作为注册表站点，仅导出默认行为

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

// 默认 cheerio 解析：基于 selectors 抽取 id/title/link/noticeType/area/publishTime
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

module.exports = {
  defaultExtractId,
  defaultIsBoundary,
  defaultBuildUrl,
  defaultParse
};
