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
    'CLI explicit zero values must not be replaced by defaults'
  );
  assert.deepStrictEqual(
    withArgv([], () => parseArguments()),
    { totalPages: 100, interval: 5000, minDelay: 0, maxDelay: 300 }
  );

  const root = path.join(process.cwd(), 'file');
  assert.strictEqual(safeJoin(root, '/%ZZ'), null, 'malformed URL encoding must return 404 path');
  assert.strictEqual(safeJoin(root, '/../secret'), null, 'path traversal must be rejected');

  console.log('CLI args and static paths: OK');
}
main();
