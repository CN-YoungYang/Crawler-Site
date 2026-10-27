// breaker：一轮 crawl 的熔断判定。
//
// 守卫的真实事故（ADR 0001「修订 2026-08-21」+ 2026-08-24 生产日志）：ceb 固定出口下
// GET 405 → POST 仍 405，曾空转 100 页约 5 小时；网络连败 5 轮 × ~67 分钟全页失败。
// 在此之前这些规则以 6 个裸标志散在 crawl() 的声明/写/求值三个区段，
// 每加一条规则要三处同改，且读完三段才能回答「什么时候该停」。
//
// 接缝：createBreaker({switchProxy}) → record(页面结果) / trip() / snapshot()。
// 计数、阈值、换点观察窗、清零规则全部成为实现的内部 seam。
//
// record 的契约（调用方如实传整页结果，不得预先归一）：
// - failed        页面是否失败
// - status        HTTP 状态；undefined/null 表示没拿到应答（网络级失败）
// - shieldType    WAF 盾页求解失败标记
// - proxySwitched 该页双 405 后已换 IP
// - endReached    站点边界页（403 等）
// - emptyPage     HTTP 200 但零行
// 返回本轮累计的 405 换点数，供「本轮已换 N 次」那行日志用。

const NET_FAIL_SWITCH_THRESHOLD = 2;
const NET_FAIL_BREAK_THRESHOLD = 6;
const SHIELD_BREAK_THRESHOLD = 2;
const CONSECUTIVE_405_THRESHOLD = 2;

function createBreaker(deps = {}) {
  // 默认是「没有换点能力」的 null object（直连站点、单元测试）。
  // 不引 proxyRotation.makeSwitchResult：breaker 保持零依赖，
  // 换点结果的真来源仍是调用方注入的 switchProxy。
  const switchProxy = typeof deps.switchProxy === 'function'
    ? deps.switchProxy
    : async () => ({ ok: false });

  let consecutive405 = 0;
  let consecutiveShield = 0;
  let netFailStreak = 0;
  // 本轮连败是否已尝试过换 IP：保证熔断前至少真换一次，
  // 又不至于每批都切点打转（2026-08-24 曾 5 轮 × ~67 分钟全页失败）
  let netFailSwitched = false;
  let proxy405Switches = 0;
  let contentPages = 0;

  // 拿到任何应答（含 403 边界页与 200 零行页）都说明**传输链路**可用：
  // 连续计数一律清零，换点记忆也清空（下一批可从头再试各节点、按最新订阅重发现）。
  // 这与「解析到内容」是两件事，后者见 record() 里的 contentPages。
  function noteExitAlive() {
    consecutive405 = 0;
    consecutiveShield = 0;
    netFailStreak = 0;
    netFailSwitched = false;
  }

  function record(result) {
    const r = result || {};

    if (!r.failed) {
      noteExitAlive();
      // 边界页与零行页都不算「解析到内容」：
      // 边界页只证明站点应答了「到底了」；零行页可能是未识别的风控页。
      // 把二者当成功正是要消灭的静默失败（2026-10-26T21:10 yfbzb 99/100 页失败、
      // 唯一的「成功」就是第 100 页的 403）。
      if (!r.endReached && !r.emptyPage) contentPages++;
      return;
    }

    if (r.shieldType) consecutiveShield++;
    if (r.status === 405) {
      if (r.proxySwitched) {
        // 换点成功：给新出口一个完整请求的观察窗，避免未验证先熔断
        consecutive405 = 0;
        proxy405Switches++;
      } else {
        consecutive405++;
      }
    }
    // 无 status 的失败才是网络级（ECONNRESET/超时/TLS 断开）；
    // 有 status 的失败（403/405/500 等已到服务器）说明链路连通，不计入
    if (r.status === undefined || r.status === null) netFailStreak++;

    // 回给调用方记账用（「本轮已换 N 次」那行日志）。只在换点页上读它。
    return proxy405Switches;
  }

  // 批末求值。返回四选一，附带写日志要用的计数（调用方不必再问一次快照）：
  //   { reason: 'shield'|'405'|'net_fail', ...计数 }  熔断，调用方停止本轮
  //   { switched: {ok,to,stale}, ...计数 }            网络连败达换点阈值：已换一次 IP，继续观察
  //   { ...计数 }                                     继续爬下一批
  async function trip() {
    const counts = snapshot();
    if (consecutiveShield >= SHIELD_BREAK_THRESHOLD) return { reason: 'shield', ...counts };
    if (consecutive405 >= CONSECUTIVE_405_THRESHOLD) return { reason: '405', ...counts };
    if (netFailStreak >= NET_FAIL_SWITCH_THRESHOLD && !netFailSwitched) {
      let sw = { ok: false };
      try { sw = (await switchProxy('net_fail_streak')) || sw; } catch (_) {}
      netFailSwitched = true;
      return { switched: sw, ...counts };
    }
    if (netFailStreak >= NET_FAIL_BREAK_THRESHOLD && netFailSwitched) return { reason: 'net_fail', ...counts };
    return counts;
  }

  // 只放调用方真的会读的计数：`failedPages`/`netFailSwitched` 曾在此暴露却无人读，
  // 属于迟早被误用的死表面（失败页数由 crawl() 自己按页累加）。
  function snapshot() {
    return { consecutive405, consecutiveShield, netFailStreak, proxy405Switches, contentPages };
  }

  return { record, trip, snapshot };
}

module.exports = {
  createBreaker,
  NET_FAIL_SWITCH_THRESHOLD,
  NET_FAIL_BREAK_THRESHOLD,
  SHIELD_BREAK_THRESHOLD,
  CONSECUTIVE_405_THRESHOLD
};
