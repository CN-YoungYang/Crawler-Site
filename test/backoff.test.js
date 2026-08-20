// Seam: crawlPage 重试退避（紧贴 boundary403 seam 的 catch 分支扩展）
// 行为：网络错误重试时退避为指数 + 全量抖动，而非原固定 5s。
// 测纯函数 backoffDelay(attempt, base, cap) 的语义，不等待真实定时器。
const assert = require('assert');
const { backoffDelay } = require('../crawler');

function main() {
  const base = 2000, cap = 60000;

  // 指数：attempt 0/1/2 的上界应为 base*2^attempt（封顶前）
  // attempt 0 → [0, 2000)，attempt 1 → [0, 4000)，attempt 2 → [0, 8000)
  for (const attempt of [0, 1, 2]) {
    const upper = Math.min(base * Math.pow(2, attempt), cap);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(attempt, base, cap);
      assert.ok(d >= 0 && d < upper, `attempt ${attempt} 退避 ${d} 应在 [0, ${upper}) 内`);
    }
  }

  // 封顶：大 attempt 不超过 cap
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(20, base, cap); // 2^20 远超 cap
    assert.ok(d < cap, `封顶后退避 ${d} 应 < cap=${cap}`);
  }

  // 抖动性：多次调用不全相同（全量抖动应产生分散值）
  const samples = new Set();
  for (let i = 0; i < 50; i++) samples.add(backoffDelay(2, base, cap));
  assert.ok(samples.size > 1, '抖动应产生多个不同值，而非固定值');

  console.log('crawlPage 重试退避: OK');
}

try { main(); } catch (e) { console.error('FAIL', e.message); process.exit(1); }
