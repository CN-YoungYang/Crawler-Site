// 测试辅助：在 require.cache 里替换 axios 模块，并还原。
// crawler.js 直接 require('axios')、无注入点，所以用 require.cache 这条缝做 mock。
// 不动生产代码、不引入测试运行器。

const Module = require('module');

const AXIOS_PATH = require.resolve('axios');
const CRAWLER_PATH = require('path').resolve(__dirname, '..', 'crawler.js');
// sites/_easy_proxies.js 同样在顶层钉死 axios 引用（代理换点提供方），
// 需与 crawler 一并重载才能捕获当前 cache 里的 fake axios。
const EASY_PROXIES_PATH = require('path').resolve(__dirname, '..', 'sites', '_easy_proxies.js');

function mockAxios(handler) {
  // handler: (url, config) => { data, status } | 抛出异常（网络错误时抛出 axios 风格对象）
  // 支持 axios.get(url, config) / axios.post(url, data, config) / axios({url, ...})
  const fake = (url, config) => {
    if (typeof url === 'object') {
      // axios({url, ...}) 调用形式
      config = url;
      url = url.url;
    }
    return handler(url, config);
  };
  fake.get = (url, config) => handler(url, config);
  fake.post = (url, data, config) => {
    const merged = { ...(config || {}), data };
    return handler(url, merged);
  };
  fake.put = (url, data, config) => {
    const merged = { ...(config || {}), data };
    return handler(url, merged);
  };
  fake.request = (config) => handler(config.url, config);
  fake.create = () => fake;
  // 覆盖 require.cache
  const original = require.cache[AXIOS_PATH];
  require.cache[AXIOS_PATH] = Object.assign(Object.create(Module), {
    exports: fake,
    loaded: true,
    id: AXIOS_PATH,
    path: require('path').dirname(AXIOS_PATH),
    _cached: true
  });
  return () => {
    if (original) require.cache[AXIOS_PATH] = original;
    else delete require.cache[AXIOS_PATH];
  };
}

// crawler.js 顶层 `const axios = require('axios')` 把 axios 引用钉死在闭包里，
// mockAxios 换 cache 项动不了已 require 的 crawler。所以每个测试要 fresh crawler，
// 让它在当前 cache（含 fake axios）下重新求值、重新捕获 axios。
function freshCrawler() {
  delete require.cache[CRAWLER_PATH];
  delete require.cache[EASY_PROXIES_PATH];
  return require('../crawler');
}

// crawl() / readRecentIds() / log / report 均用 cwd 相对的 file/<site>/、logs/<site>/、state/<site>/，
// 与 withTempCwd 切 cwd 隔离一致（均在每次调用时解析 cwd，不在模块加载时冻结）。
// 把 cwd 切到临时目录，让写入落到隔离区；隔离区内无今日/昨日真实文件，readRecentIds 返回空 Set，不干扰断言。
// 用法：await withTempCwd(async dir => { ... })
function withTempCwd(fn) {
  const orig = process.cwd();
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'crawler-test-'));
  process.chdir(dir);
  return Promise.resolve(fn(dir)).finally(() => {
    process.chdir(orig);
    require('fs').rmSync(dir, { recursive: true, force: true });
  });
}

// 临时改一个环境变量，返回还原函数。代理/订阅相关用例都要改 env，四份拷贝没有意义。
function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

// 读取本站在隔离 cwd 里刚写下的 JSONL，返回事件数组（断言观测面的唯一入口）。
// 不自行推算文件名（避免照着实现重算期望值），只取 logs/<site>/ 下唯一的日志文件。
function readEvents(site) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(process.cwd(), 'logs', String(site).toLowerCase());
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'));
  if (files.length !== 1) {
    throw new Error(`logs/${site}/ 应有且仅有 1 个 JSONL 日志文件，实际 ${files.length}`);
  }
  return fs.readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// 退避抖动归零：backoffDelay() 取全量随机抖动，测试不归零就白等数秒，
// 且同一用例的耗时不可预测。归零后「重试次数」才是可断言的确定值。
async function withNoJitter(fn) {
  const previous = Math.random;
  Math.random = () => 0;
  try { return await fn(); } finally { Math.random = previous; }
}

// 旧扫描策略的 yfbzb：2026-10-30 起 yfbzb 改成「追水位」站点（scanMode/batchSize 1/468 即停）。
// 那批测通用机制的用例（批次大小、页数预算、熔断、续跑）测的不是 yfbzb 的站点策略，
// 不该被站点配置的改动牵连——在各自进程里把注册表覆盖回旧值即可。
// 只改内存里的 registry，不写文件；每个测试文件是独立进程，互不影响。
function useLegacyYfbzb() {
  const registry = require('../sites').registry;
  registry.yfbzb = {
    ...registry.yfbzb,
    scanMode: undefined,
    stopOn468: false,
    batchSize: 10,
    requestDelay: undefined
  };
}

// 断点路径：v2 起落在 state/<site>/checkpoint.json（整目录可挂卷）。
// 测试不自己拼路径，避免实现换布局时十几处一起漂。
function checkpointPath(site) {
  return require('path').join('state', String(site).toLowerCase(), 'checkpoint.json');
}

// 读断点并解析；文件不存在时抛 ENOENT，让「不该有断点」的断言保持直白。
function readCheckpoint(site) {
  return JSON.parse(require('fs').readFileSync(checkpointPath(site), 'utf8'));
}

// 去重台账路径：state/<site>/ids.json。同样只在这里拼一次。
function ledgerPath(site) {
  return require('path').join('state', String(site).toLowerCase(), 'ids.json');
}

function readLedgerIds(site) {
  const fs = require('fs');
  const file = ledgerPath(site);
  if (!fs.existsSync(file)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).ids || {});
}

module.exports = { mockAxios, freshCrawler, withTempCwd, setEnv, withNoJitter, readEvents, checkpointPath, readCheckpoint, ledgerPath, readLedgerIds, useLegacyYfbzb };
