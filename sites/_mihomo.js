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
      // 结构异常 → 落到全量重发现
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
    return isLeafNode(proxies[n]);
  });
  return { groupName, now: group.now || '', leaves };
}

// 叶子判定用结构而非类型名单：成员对象带 all 数组即「组」（Selector/URLTest/Fallback/
// LoadBalance/Relay 及未来新组型如 Smart 一律命中——切组等于把出口选择权交还组，
// 可能立刻回到被封节点）；无 all 的真实协议节点才是叶子。（2026-08-26 审查 #4）
function isLeafNode(member) {
  return !!(member && typeof member === 'object' && !Array.isArray(member.all));
}

async function switchNode(siteConfig, { reason, proxyUrl, tried, cached }) {
  if (!proxyUrl || !isMihomoProxyUrl(proxyUrl)) return { noop: true };
  const site = (siteConfig && siteConfig.name) || '';
  const headers = authHeaders();
  // 轮尽零请求短路：本轮 PUT 已试遍快照全部叶子（成功页会清空轮换记忆，
  // 故 tried.length ≥ leaves.length 只可能发生在轮尽后），不再打控制器
  const snapLeaves = cached && cached.leaves;
  if (Array.isArray(snapLeaves) && snapLeaves.length > 0 && snapLeaves.every(n => tried.includes(n))) {
    log(`代理节点池本轮已轮尽 [${site}] ${reason}（叶子 ${snapLeaves.length} 个，本轮已试 ${tried.length}），不再换点`, { level: 'warn', event: 'proxy_pool_exhausted', context: { site, reason, leaves: snapLeaves.length, tried: tried.length }, site });
    return { exhausted: true, from: snapLeaves.includes(tried[tried.length - 1]) ? tried[tried.length - 1] : '', tried: [...tried], groupName: cached.groupName, leaves: snapLeaves };
  }
  for (const base of controllerBases()) {
    // 有缓存先走单组端点，任何异常（端点失效/PUT 失败）或缓存下轮尽，退回全量重发现兜底一次
    for (const cacheAttempt of (cached && cached.groupName ? [cached, null] : [null])) {
      try {
        const loc = await locateGroup(base, headers, cacheAttempt);
        if (!loc) break; // 此控制器没有 PROXY 组，试下一个控制器
        const pool = loc.leaves.filter(n => n !== loc.now && !tried.includes(n));
        if (pool.length === 0) {
          if (cacheAttempt) continue; // 缓存叶子快照可能过期（订阅变更），全量重发现后再判轮尽
          log(`代理节点池本轮已轮尽 [${site}] ${reason}（叶子 ${loc.leaves.length} 个，本轮已试 ${tried.length}），不再换点`, { level: 'warn', event: 'proxy_pool_exhausted', context: { site, reason, leaves: loc.leaves.length, tried: tried.length }, site });
          return { exhausted: true, from: loc.now, tried: [...tried], groupName: loc.groupName, leaves: loc.leaves };
        }
        const next = pool[0];
        await axios.put(`${base}/proxies/${encodeURIComponent(loc.groupName)}`, { name: next }, { timeout: 2000, headers, proxy: false });
        // PUT 成功才记账：控制器异常时下一个控制器可重选同名节点，不留幽灵占位
        const newTried = [...tried, next];
        log(`代理已切换 [${site}] ${reason}：${loc.now || 'unknown'} → ${next}（本轮已试 ${newTried.length}/${loc.leaves.length}）`, { event: 'proxy_switched', context: { site, from: loc.now, to: next, reason, controller: base, tried: newTried.length, leaves: loc.leaves.length }, site });
        return { switched: true, from: loc.now, to: next, tried: newTried, groupName: loc.groupName, leaves: loc.leaves };
      } catch (_) {
        // 还有全量兜底就重试，否则下一个控制器
        continue;
      }
    }
  }
  log(`代理切换失败 [${site}] ${reason}`, { level: 'warn', event: 'proxy_switch_failed', context: { site, reason }, site });
  return { noop: true };
}

module.exports = { switchNode, isMihomoProxyUrl };
