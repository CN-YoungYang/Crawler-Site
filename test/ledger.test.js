// 接缝：ledger.js 的公开接口（loadLedger / saveLedger / addRows / pruneLedger）。
//
// 台账是去重的唯一真相源：断点不再背 id 集，2 天 xlsx 窗口只作兜底。
// 期望值来自规格（每站一个 state/<site>/ids.json、id → publishDate、保留 35 天），
// 不复算实现内部的日期换算：下面的日期字面量是手写的，固定 now 下算出来的。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { withTempCwd } = require('./helper');
const ledger = require('../ledger');

// 2026-10-29T04:00:00Z = 上海 12:00，35 天前 = 2026-09-24
const NOW = Date.parse('2026-10-29T04:00:00Z');

function rowsFrom(pairs) {
  return pairs.map(([id, publishTime]) => ({ id, publishTime, title: 't' + id }));
}

async function main() {
  // ---- (a) 写盘 → 读回：id 与发布日期一一对应 ----
  await withTempCwd(async () => {
    const map = new Map();
    const added = ledger.addRows(map, rowsFrom([
      ['2026102900001', '2026-10-29'],
      ['2026102800002', '2026-10-28']
    ]));
    assert.strictEqual(added, 2, '两条新 id 都应计入新增');
    ledger.saveLedger('yfbzb', map);

    const loaded = ledger.loadLedger('yfbzb');
    assert.strictEqual(loaded.size, 2, '读回应包含两条 id');
    assert.strictEqual(loaded.get('2026102900001'), '2026-10-29', '发布日期应原样保存');
    assert.strictEqual(loaded.get('2026102800002'), '2026-10-28');
    assert.strictEqual(loaded.has('不存在的 id'), false);
  });

  // ---- (b) 同一 id 重复入库：不重复计数，也不覆盖原发布日期 ----
  await withTempCwd(async () => {
    const map = new Map();
    ledger.addRows(map, rowsFrom([['A1', '2026-10-01']]));
    const added = ledger.addRows(map, rowsFrom([['A1', '2026-10-29'], ['A2', '2026-10-29']]));
    assert.strictEqual(added, 1, '只有 A2 是新的');
    assert.strictEqual(map.get('A1'), '2026-10-01', '已有 id 的发布日期不被后来的行改写');
    assert.strictEqual(map.size, 2);
  });

  // ---- (c) 没有发布日期的行不入台账（与 crawler 的 invalid_publish_date 跳过一致）----
  await withTempCwd(async () => {
    const map = new Map();
    const added = ledger.addRows(map, [
      { id: 'B1', publishTime: '' },
      { id: 'B2', publishTime: 'not-a-date' },
      { id: 'B3', publishTime: '2026-10-29' }
    ]);
    assert.strictEqual(added, 1, '只有日期可解析的行入库');
    assert.deepStrictEqual([...map.keys()], ['B3']);
  });

  // ---- (d) 35 天裁剪：边界日保留，早一天删除 ----
  await withTempCwd(async () => {
    const map = new Map(Object.entries({
      'OLD': '2026-09-23',   // 36 天前：删
      'EDGE': '2026-09-24',  // 恰好 35 天：留
      'NEW': '2026-10-29'    // 今天：留
    }));
    const removed = ledger.pruneLedger(map, NOW);
    assert.strictEqual(removed, 1, '只应删除 1 条超出保留期的 id');
    assert.deepStrictEqual([...map.keys()].sort(), ['EDGE', 'NEW']);
  });

  // ---- (e) 台账损坏：读回空表、不抛异常，崩溃不放大成整轮失败 ----
  await withTempCwd(async () => {
    fs.mkdirSync(path.join('state', 'yfbzb'), { recursive: true });
    fs.writeFileSync(ledger.ledgerFile('yfbzb'), '{ 坏掉的 json', 'utf8');
    const loaded = ledger.loadLedger('yfbzb');
    assert.strictEqual(loaded.size, 0, '损坏台账按空表处理');
  });

  // ---- (f) 落盘是原子的：目录里只留 ids.json，没有临时文件残留 ----
  await withTempCwd(async () => {
    const map = new Map([['C1', '2026-10-29']]);
    ledger.saveLedger('yfbzb', map);
    ledger.saveLedger('yfbzb', map);
    const names = fs.readdirSync(path.join('state', 'yfbzb'));
    assert.deepStrictEqual(names, ['ids.json'], '临时文件必须被 rename 消化掉');
  });

  console.log('ledger.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
