// breaker：一轮 crawl 的熔断判定模块。
//
// 守卫的真实事故（ADR 0001「修订 2026-08-21」+ 2026-08-24 生产日志）：
// - ceb 固定出口下 GET 405 → POST 仍 405，曾空转 100 页约 5 小时；
// - 2026-08-24 网络连败 5 轮 × ~67 分钟全页失败。
// 在此之前这些规则以 6 个裸标志散在 crawl() 的声明/写/求值三个区段，
// 每加一条规则就要在三处各改一次。
//
// 接缝：breaker.js 的公开接口 createBreaker({switchProxy}) → record/trip。
// 期望值来自独立真相源（ADR 0001 的阈值语义 + 事故记录），不是照抄实现。
const assert = require('assert');
const { createBreaker } = require('../breaker');

const ok = () => ({ failed: false });
const fail = (status) => ({ failed: true, status });
const netFail = () => ({ failed: true });

async function main() {
  // ---- (a) 连续 405 达 2 页 → 熔断，reason 可区分 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(fail(405));
    assert.strictEqual((await b.trip()).reason, undefined, '1 页 405 不应熔断');
    b.record(fail(405));
    assert.strictEqual((await b.trip()).reason, '405', '连续 2 页 405 应熔断');
  }

  // ---- (a2) trip() 自带计数：调用方写日志不必再问一次 snapshot() ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(fail(405));
    b.record(fail(405));
    const t = await b.trip();
    assert.strictEqual(t.reason, '405');
    assert.strictEqual(t.consecutive405, 2, 'trip() 应带回用于日志的计数');
  }

  // ---- (a3) record() 回报本轮累计 405 换点数（供「本轮已换 N 次」日志） ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    assert.strictEqual(b.record(fail(405)), 0, '未换点时应为 0');
    assert.strictEqual(b.record({ failed: true, status: 405, proxySwitched: true }), 1, '换点页应回报 1');
  }

  // ---- (b) 成功页清零 405 计数 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(fail(405));
    b.record(ok());
    b.record(fail(405));
    assert.strictEqual((await b.trip()).reason, undefined, '中间隔一个成功页，连续计数应被打断');
  }

  // ---- (c) 双 405 换点成功即清零给新出口观察窗 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(fail(405));
    b.record({ failed: true, status: 405, proxySwitched: true });
    assert.strictEqual((await b.trip()).reason, undefined, '换点成功后应重新观察，不立即熔断');
    b.record(fail(405));
    assert.strictEqual((await b.trip()).reason, undefined, '换点后重新计数：此时仅 1 页');
    b.record(fail(405));
    assert.strictEqual((await b.trip()).reason, '405');
  }

  // ---- (d) WAF 盾页连续 2 页 → 熔断 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record({ failed: true, shieldType: 'acw' });
    assert.strictEqual((await b.trip()).reason, undefined);
    b.record({ failed: true, shieldType: 'acw' });
    assert.strictEqual((await b.trip()).reason, 'shield', '连续 2 页盾页不可解应熔断');
  }

  // ---- (e) 网络连败：先换 IP 再观察，仍连败才熔断（阈值不同） ----
  {
    let switches = 0;
    const b = createBreaker({ switchProxy: async () => { switches++; return { ok: true, to: 'N2' }; } });
    for (let i = 0; i < 2; i++) b.record(netFail());
    // 达到换点阈值：trip 此时不应熔断，而是触发换点
    const first = await b.trip();
    assert.strictEqual(first.reason, undefined, '2 页网络失败应先换 IP，不熔断');
    assert.ok(first.switched, 'trip 应回报换点结果供调用方写日志');
    assert.strictEqual(switches, 1, '应先换 IP 一次');
    for (let i = 0; i < 4; i++) b.record(netFail());
    assert.strictEqual((await b.trip()).reason, 'net_fail', '换点后仍连败至 6 页应熔断');
    assert.strictEqual(switches, 1, '熔断前只换一次 IP，不反复切点');
  }

  // ---- (f) 网络失败与非网络失败分离计数（有 status 说明链路通） ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(netFail());
    b.record(fail(500));
    b.record(netFail());
    assert.strictEqual((await b.trip()).reason, undefined, '500 有 status，不应计入网络连败');
  }

  // ---- (g) 边界页算「出口活着」：清零计数，但不计入内容成功 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record(fail(405));
    b.record({ failed: false, endReached: true });
    assert.strictEqual((await b.trip()).reason, undefined, '边界页是站点真实应答，应清零连续计数');
    assert.strictEqual(b.snapshot().contentPages, 0, '但边界页不算解析到内容');
  }

  // ---- (h) 空页（200 但零行）不算内容成功，但算出口活着 ----
  {
    const b = createBreaker({ switchProxy: async () => ({ ok: false }) });
    b.record({ failed: false, emptyPage: true });
    assert.strictEqual(b.snapshot().contentPages, 0, '零行页可能是未识别的风控页，不能算内容成功');
    b.record({ failed: false });
    assert.strictEqual(b.snapshot().contentPages, 1);
  }

  console.log('breaker 熔断判定（405/盾页/网络连败/边界语义）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
