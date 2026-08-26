// 测试辅助：在 require.cache 里替换 axios 模块，并还原。
// crawler.js 直接 require('axios')、无注入点，所以用 require.cache 这条缝做 mock。
// 不动生产代码、不引入测试运行器。

const Module = require('module');

const AXIOS_PATH = require.resolve('axios');
const CRAWLER_PATH = require('path').resolve(__dirname, '..', 'crawler.js');

function mockAxios(handler) {
  // handler: (url, config) => { data, status } | throws (网络错误则抛 axios 风格对象)
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
  return require('../crawler');
}

// crawl() / readRecentIds() / log / report 均用 cwd 相对的 file/<site>/、logs/<site>/、state-<site>.json，
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

module.exports = { mockAxios, freshCrawler, withTempCwd };
