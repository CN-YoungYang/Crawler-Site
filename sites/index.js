const yfbzb = require('./yfbzb');
const ceb = require('./ceb');

const registry = { yfbzb, ceb };

function normalizeSite(site) {
  return String(site || process.env.SITE || 'yfbzb').trim().toLowerCase();
}

function normalizeSites(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof input === 'string') {
    return [...new Set(input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  }
  return [];
}

function parseSitesList(raw) {
  const src = raw !== undefined ? raw : (process.env.SITES || process.env.SITES_LIST || process.env.SITE || process.env.CRAWLER_SITE || 'yfbzb');
  return normalizeSites(src);
}

function getSiteConfig(site) {
  const key = normalizeSite(site);
  const cfg = registry[key];
  if (!cfg) throw new Error(`未知站点 SITE=${site}，可选: ${Object.keys(registry).join(', ')}`);
  if (!cfg.baseUrl && typeof cfg.buildUrl !== 'function') throw new Error(`站点 ${key} 未实现：${cfg.disabledReason || 'baseUrl 为空'}`);
  return cfg;
}

function listEnabledSites() {
  return Object.keys(registry);
}

module.exports = { getSiteConfig, listEnabledSites, registry, normalizeSite, parseSitesList };
