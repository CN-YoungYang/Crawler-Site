const assert = require('assert');
const path = require('path');
const { parseArguments } = require('../index');
const { safeJoin } = require('../server');

function withArgv(args, fn) {
  const original = process.argv;
  process.argv = [process.execPath, 'index.js', ...args];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

function main() {
  assert.deepStrictEqual(
    withArgv(['10', '5000', '0', '0'], () => parseArguments()),
    { totalPages: 10, interval: 5000, minDelay: 0, maxDelay: 0 },
    '命令行显式传入的 0 不应被默认值替换'
  );
  assert.deepStrictEqual(
    withArgv([], () => parseArguments()),
    { totalPages: 100, interval: 5000, minDelay: 0, maxDelay: 300 }
  );

  const root = path.join(process.cwd(), 'file');
  assert.strictEqual(safeJoin(root, '/%ZZ'), null, 'URL 编码损坏时应返回 404 路径');
  assert.strictEqual(safeJoin(root, '/../secret'), null, '必须拒绝路径穿越');

  console.log('命令行参数与静态路径：通过');
}
main();
