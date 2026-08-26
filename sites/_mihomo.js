// mihomo external-controller 换点 provider（crawler.js#trySwitchProxy 的默认实现，
// 可经 siteConfig.switchProxy 按站覆盖）。mihomo 专属知识收敛于此文件：
// 主机嗅探、控制器发现、组定位、叶子判定、PUT 切换；核心爬虫只做轮换记账与隧道重建。
//
// provider 契约：switchNode(siteConfig, { reason, proxyUrl, tried, cached }) 返回：
//   { noop: true }                                         非 mihomo / 控制器均不可达
//   { exhausted: true, from, tried, groupName, leaves }    本轮无可切节点（PUT 未发生）
//   { switched: true, from, to, tried, groupName, leaves } PUT 成功（tried 已追加 to）
// switched 结果必须带 groupName+leaves 快照：编排层据此做轮尽零请求短路与单组端点省 I/O。
const axios = require('axios');
const { log } = require('../log');

// 仅识别 mihomo 形态的代理地址：容器服务名或本机回环（常见 7890 mixed-port）
function isMihomoProxyUrl(proxyUrl) {
  let host = '';
  try { host = new URL(proxyUrl).hostname.toLowerCase(); } catch (_) { return false; }
  return host === 'mihomo' || host === '127.0.0.1' || host === 'localhost' || proxyUrl.includes('mihomo:7890') || proxyUrl.includes('127.0.0.1:7890');
}

function controllerBases() {
  const bases = [];
  if (process.env.MIHOMO_CONTROLLER) bases.push(process.env.MIHOMO_CONTROLLER);
  bases.push('http://mihomo:9090', 'http://127.0.0.1:9090');
  return bases;
}

function authHeaders() {
  const secret = process.env.MIHOMO_SECRET || '';
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

// 订阅刷新限频：避免 0 叶子/连败风暴中每页都打 PUT
let _providerRefreshAt = 0;
function refreshCooldownMs() {
  const v = Number(process.env.MIHOMO_REFRESH_COOLDOWN);
  return (Number.isFinite(v) && v >= 0 ? v : 600) * 1000;
}
async function refreshProviders({ site = '', reason = '' } = {}) {
  const now = Date.now();
  const cd = refreshCooldownMs();
  if (now - _providerRefreshAt < cd) return false;
  _providerRefreshAt = now;
  const headers = authHeaders();
  const bases = controllerBases();
  const paths = ['/providers/proxy/remote', '/providers/proxies/remote'];
  for (const base of bases) {
    for (const p of paths) {
      try {
        await axios.put(`${base}${p}`, {}, { timeout: 2000, headers, proxy: false });
        log(`已触发订阅刷新 [${site}] ${reason} → PUT ${base}${p}`, { event: 'proxy_provider_refresh', context: { site, reason, endpoint: `${base}${p}` }, site });
        return true;
      } catch (_) { /* try next endpoint */ }
    }
  }
  log(`订阅刷新失败 [${site}] ${reason}，将等待下次周期或下次触发`, { level: 'warn', event: 'proxy_provider_refresh_failed', context: { site, reason }, site });
  return false;
}

// 组定位：有缓存走单组端点 /proxies/{group} 取最新 now（小响应）；
// 无缓存或单组端点异常（组被删/改名）则全量 /proxies 重发现并分类叶子。
async function locateGroup(base, headers, cached) {
  if (cached && cached.groupName) {
    try {
      const r = await axios.get(`${base}/proxies/${encodeURIComponent(cached.groupName)}`, { timeout: 2000, headers, proxy: false });
      const g = r.data;
      if (g && Array.isArray(g.all)) {
        return { groupName: cached.groupName, now: g.now || '', leaves: cached.leaves || [] };
      }
    } catch (_) { /* 缓存失效 → 全量重发现 */ }
  }
  const listRes = await axios.get(`${base}/proxies`, { timeout: 2000, headers, proxy: false });
  const proxies = listRes.data && listRes.data.proxies ? listRes.data.proxies : {};
  const groupName = Object.keys(proxies).find(k => k.toUpperCase() === 'PROXY') || '';
  const group = groupName ? proxies[groupName] : null;
  if (!group || !Array.isArray(group.all)) return null;
  const leaves = group.all.filter(n => {
    const lower = String(n).toLowerCase();
    if (lower === 'direct' || lower.startsWith('reject')) return false;
    if (proxies[n] === undefined) {
      log(`代理叶子缺失字典条目 [${groupName}] ${n}，视为叶子尝试`, { level: 'warn', event: 'proxy_leaf_missing', context: { group: groupName, leaf: n } });
      return true;
    }
    return isLeafNode(proxies[n]);
  });
  return { groupName, now: group.now || '', leaves };
}

// 叶子判定用结构而非类型名单：成员对象带 all 数组即「组」（Selector/URLTest/Fallback/
// LoadBalance/Relay 及未来新组型如 Smart 一律命中——切组等于把出口选择权交还组，
// 可能立刻回到被封节点）；无 all 的真实协议节点才是叶子。（2026-08-26 审查 #4）
// #1: 调用方已处理 undefined，此处仅处理已存在的 member 对象
function isLeafNode(member) {
  if (member === undefined || member === null) return true;
  return !!(typeof member === 'object' && !Array.isArray(member.all));
}

async function switchNode(siteConfig, { reason, proxyUrl, tried, cached }) {
  if (!proxyUrl || !isMihomoProxyUrl(proxyUrl)) return { noop: true };
  const site = (siteConfig && siteConfig.name) || '';
  const headers = authHeaders();
  // #7: 轮尽零请求短路——stale 快照可能导致假轮尽（订阅新增叶子但 tried 已覆盖旧快照），
  // 但额外 GET 会破坏轮尽后零控制器请求的性能保证（测试 dual405 断言 <=3 GETs）。
  // 权衡：短路仍直接判轮尽，stale 场景由下一轮 crawl() 重置 _leafCache 或下一页的全量兜底发现。
  // 若需强一致，可在外部定期失效缓存，而非每次轮尽都多一次 GET。
  const snapLeaves = cached && cached.leaves;
  if (Array.isArray(snapLeaves) && snapLeaves.length > 0 && snapLeaves.every(n => tried.includes(n))) {
    const fromVal = (cached && cached.now) || (snapLeaves.includes(tried[tried.length - 1]) ? tried[tried.length - 1] : '');
    log(`代理节点池本轮已轮尽 [${site}] ${reason}（叶子 ${snapLeaves.length} 个，本轮已试 ${tried.length}），不再换点`, { level: 'warn', event: 'proxy_pool_exhausted', context: { site, reason, leaves: snapLeaves.length, tried: tried.length }, site });
    return { exhausted: true, from: fromVal, tried: [...tried], groupName: cached.groupName, leaves: snapLeaves };
  }
  for (const base of controllerBases()) {
    for (const cacheAttempt of (cached && cached.groupName ? [cached, null] : [null])) {
      try {
        const loc = await locateGroup(base, headers, cacheAttempt);
        if (!loc) break;
        // 叶子池为空时直接视为 noop（订阅未加载/过滤后无可用节点），避免 0 叶子判轮尽误导
        if (loc.leaves.length === 0) {
          if (cacheAttempt) continue;
          log(`代理叶子池为空 [${site}] ${reason}，无法换点`, { level: 'warn', event: 'proxy_pool_empty', context: { site, reason, group: loc.groupName }, site });
          try { await refreshProviders({ site, reason: `pool_empty:${reason}` }); } catch (_) {}
          return { noop: true };
        }
        const pool = loc.leaves.filter(n => n !== loc.now && !tried.includes(n));
        if (pool.length === 0) {
          if (cacheAttempt) continue;
          log(`代理节点池本轮已轮尽 [${site}] ${reason}（叶子 ${loc.leaves.length} 个，本轮已试 ${tried.length}），不再换点`, { level: 'warn', event: 'proxy_pool_exhausted', context: { site, reason, leaves: loc.leaves.length, tried: tried.length }, site });
          return { exhausted: true, from: loc.now, tried: [...tried], groupName: loc.groupName, leaves: loc.leaves };
        }
        const next = pool[0];
        await axios.put(`${base}/proxies/${encodeURIComponent(loc.groupName)}`, { name: next }, { timeout: 2000, headers, proxy: false });
        const newTried = [...tried, next];
        log(`代理已切换 [${site}] ${reason}：${loc.now || 'unknown'} → ${next}（本轮已试 ${newTried.length}/${loc.leaves.length}）`, { event: 'proxy_switched', context: { site, from: loc.now, to: next, reason, controller: base, tried: newTried.length, leaves: loc.leaves.length }, site });
        return { switched: true, from: loc.now, to: next, tried: newTried, groupName: loc.groupName, leaves: loc.leaves, now: loc.now };
      } catch (_) {
        continue;
      }
    }
  }
  log(`代理切换失败 [${site}] ${reason}`, { level: 'warn', event: 'proxy_switch_failed', context: { site, reason }, site });
  return { noop: true };
}

module.exports = { switchNode, isMihomoProxyUrl, isLeafNode, refreshProviders, _refreshCooldown: () => _providerRefreshAt, _resetRefreshCooldown: () => { _providerRefreshAt = 0; } };
