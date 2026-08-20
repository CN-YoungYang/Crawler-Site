// 统一入口：跑 test/*.test.js 全部 → 一个 OK / 任何 FAIL 退出码非零。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'));
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
if (failed) {
  console.error(`\n${failed}/${files.length} 测试套件失败`);
  process.exit(1);
}
console.log(`\n全部 ${files.length} 个测试套件通过`);
