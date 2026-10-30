// 回归：state/<site>/ 不可写时，日志必须说实话。
//
// 守卫的真实事故（2026-10-29 生产日志，yfbzb 连续 5 轮 + ceb 1 轮）：
//   更新文件 file/yfbzb/2026-10-30.xlsx，新增 24 条记录
//   台账写入失败：EACCES: permission denied, mkdir 'state/yfbzb'
//   爬取过程中出现错误: EACCES: permission denied, mkdir 'state/yfbzb'
// 以及零新增那轮更糟的形状：
//   已保留断点（起始页 11），下次将续跑      ← 断点文件根本没写出来
//   爬取过程中出现错误: EACCES ...
// 这条「已保留断点」是日志在撒谎：saveCheckpoint() 在它之后才执行，失败后直接抛出。
// 后果是运维按日志读成「断点还在，下轮会续跑」，实际每小时都从第 1 页重来。
//
// 接缝：crawl() 公开接口 + logs/<site>/*.jsonl 的 msg 字段（对外承诺的可 grep 观测面），
// 真相源是「state/<site>/checkpoint.json 是否存在」——不依赖任何实现细节。
//
// 故障注入：把 fs.mkdirSync 在 state/ 下的调用改成抛 EACCES。这不是模拟，
// 就是把宿主机上的真实 errno 搬到测试里：writeJsonAtomic() 走的正是这一次 mkdir。
const assert = require('assert');
const fs = require('fs');
const { mockAxios, freshCrawler, withTempCwd, withNoJitter, readEvents, checkpointPath } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

const STATE_HINT = /chown|1000:1000|不可写|属主/;

// 让 state/ 下的 mkdirSync 抛 EACCES，其余目录照常。
function denyStateDir() {
  const fsm = require('fs');
  const original = fsm.mkdirSync;
  fsm.mkdirSync = function patchedMkdirSync(target, options) {
    const text = String(target);
    const normalized = text.replace(/\\/g, '/');
    const underState = normalized === 'state' || normalized.startsWith('state/') || /(^|\/)state\//.test(normalized);
    if (underState) {
      const error = new Error(`EACCES: permission denied, mkdir '${normalized}'`);
      error.code = 'EACCES';
      error.errno = -4092;
      error.syscall = 'mkdir';
      error.path = text;
      throw error;
    }
    return original.call(fsm, target, options);
  };
  return () => { fsm.mkdirSync = original; };
}

function allMessages(events) {
  return events.map(e => e.msg || '').join('\n');
}

async function crawlExpectingThrow(crawlArgs) {
  const { crawl } = freshCrawler();
  try {
    await crawl(crawlArgs);
  } catch (error) {
    return error;
  }
  return null;
}

async function main() {
  // ---- (a) 零新增轮：不许声称「已保留断点」，且要说清为什么 + 怎么修 ----
  {
    const restoreAxios = mockAxios(() => ({ status: 200, data: pageHtml([]) }));
    const restoreFs = denyStateDir();
    try {
      await withNoJitter(() => withTempCwd(async () => {
        // 总页数必须大于首批，否则「本轮扫完 = 整轮扫完」，走的是完成扫描分支，
        // 撞不上生产那条「起始页 11 / 共 100 页」的保留断点分支。
        const error = await crawlExpectingThrow({ site: 'yfbzb', totalPages: 100, interval: 0, maxRetries: 1 });
        assert.ok(error, 'state 不可写时本轮不得静默成功');
        assert.ok(!fs.existsSync(checkpointPath('yfbzb')), '前提：断点确实没写出来');

        const text = allMessages(readEvents('yfbzb'));
        assert.ok(
          !/已保留断点/.test(text),
          `断点文件不存在，日志不得声称「已保留断点」。实际日志：\n${text}`
        );
        assert.ok(
          STATE_HINT.test(text),
          `日志必须点明 state/<site>/ 不可写及修复办法，否则运维只能看到裸 EACCES。实际日志：\n${text}`
        );
      }));
    } finally {
      restoreFs();
      restoreAxios();
    }
  }

  // ---- (b) 有新数据轮：Excel 已落盘，随后断点写失败 ----
  // 生产日志的确切顺序：更新文件 → 台账写入失败 → 爬取过程中出现错误。
  {
    const restoreAxios = mockAxios((url) => {
      const page = Number((/pageNo=(\d+)/.exec(url) || [])[1] || 1);
      return { status: 200, data: pageHtml([yfbzbRow(`20250930_00000000${page}`)]) };
    });
    const restoreFs = denyStateDir();
    try {
      await withNoJitter(() => withTempCwd(async () => {
        const error = await crawlExpectingThrow({ site: 'yfbzb', totalPages: 2, interval: 0, maxRetries: 1 });
        assert.ok(error, '断点写不出来时本轮必须失败退出，不能假装已保存');
        const text = allMessages(readEvents('yfbzb'));

        // 数据交付面不能因为 state 坏了而回滚：这一轮的行已经进了 xlsx。
        const xlsxDir = 'file/yfbzb';
        assert.ok(fs.existsSync(xlsxDir), 'state 坏了不该阻止 Excel 落盘');
        assert.ok(fs.readdirSync(xlsxDir).some(name => name.endsWith('.xlsx')), '应至少写出一个 xlsx');

        assert.ok(
          STATE_HINT.test(text) || STATE_HINT.test(String(error.message)),
          `失败原因必须可操作（state/<site>/ 不可写 + chown 提示）。实际日志：\n${text}\n实际异常：${error.message}`
        );
      }));
    } finally {
      restoreFs();
      restoreAxios();
    }
  }

  console.log('state 目录不可写：日志不撒谎且可操作：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
