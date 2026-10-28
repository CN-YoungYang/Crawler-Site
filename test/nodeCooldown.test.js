// 405 节点冷却：被 CEB 405 的出口不能下一轮立刻重用。
//
// CEB 的 405 是 IP 级封禁（实测冷却可达数小时）。easy_proxies 的
// blacklist_duration 只处理代理连接失败，不会把 HTTP 405 当成坏节点；
// 因此 crawler 侧必须记住「这个节点刚被 405」，在冷却期内跳过它。
//
// 接缝：sites/_easy_proxies.js#switchNode 的公开返回值 + /api/nodes 输入。
const assert = require('assert');
const { mockAxios, setEnv, withTempCwd } = require('./helper');

function activeNodes() {
  return [
    { tag: 'N1', name: '节点一', port: 24000, available: true, initial_check_done: true },
    { tag: 'N2', name: '节点二', port: 24001, available: true, initial_check_done: true },
    { tag: 'N3', name: '节点三', port: 24002, available: true, initial_check_done: true }
  ];
}

async function main() {
  const restoreAxios = mockAxios(url => {
    assert.ok(String(url).endsWith('/api/nodes'), '只应查询节点管理接口');
    return { status: 200, data: { nodes: activeNodes() } };
  });
  const restoreEnv = setEnv('EASY_PROXIES_NODE_COOLDOWN_MS', undefined);
  const provider = require('../sites/_easy_proxies');
  provider._resetNodeCooldown();
  const config = { name: 'cooldown-site', easyProxiesController: 'http://controller.test:9091' };

  try {
    // switchNode 会写日志；不切 cwd 会把 logs/cooldown-site 落到仓库目录。
    await withTempCwd(async () => {
      // 轮首出口选择：当前出口健康时保持不动，不为了换点而换点。
      const keep = await provider.switchNode(config, {
        reason: 'round_start',
        proxyUrl: 'http://easy_proxies:24000',
        keepCurrentIfHealthy: true
      });
      assert.strictEqual(keep.noop, true, '当前出口健康时轮首不应换点');

      // 节点一在 405 后应进入冷却。
      const first = await provider.switchNode(config, {
        reason: 'dual405',
        proxyUrl: 'http://easy_proxies:24000'
      });
      assert.strictEqual(first.switched, true, '首次换点应成功');
      assert.strictEqual(first.to, '节点二');

      // 轮首发现基础端口仍在冷却期时，应主动切到健康节点，而不是先打一发再换。
      const move = await provider.switchNode(config, {
        reason: 'round_start',
        proxyUrl: 'http://easy_proxies:24000',
        keepCurrentIfHealthy: true
      });
      assert.strictEqual(move.to, '节点二', '轮首应跳过冷却中的节点一');

      // 新的一轮从节点二开始（模拟本轮成功页后 reset）：节点一仍在冷却，
      // 不能像旧实现那样回到节点一，必须顺延到节点三。
      const second = await provider.switchNode(config, {
        reason: 'dual405',
        proxyUrl: 'http://easy_proxies:24001'
      });
      assert.strictEqual(second.to, '节点三', '节点一应在 405 冷却期内被跳过');

      // 节点二也进入冷却；节点三当前仍在用但已无其它候选，返回轮尽。
      const third = await provider.switchNode(config, {
        reason: 'dual405',
        proxyUrl: 'http://easy_proxies:24002'
      });
      assert.strictEqual(third.exhausted, true, '三个节点都试过后应返回轮尽');

      // 新的一轮回到基础端口：三个节点都在冷却期，应明确报 allCooled，
      // 而不是假装还有节点可用。
      const fourth = await provider.switchNode(config, {
        reason: 'scheduled',
        proxyUrl: 'http://easy_proxies:24000'
      });
      assert.strictEqual(fourth.exhausted, true);
      assert.strictEqual(fourth.allCooled, true, '全部节点冷却时应返回 allCooled，供上层暂停本轮');
    });
  } finally {
    provider._resetNodeCooldown();
    restoreEnv();
    restoreAxios();
  }

  console.log('easy_proxies 405 节点冷却：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
