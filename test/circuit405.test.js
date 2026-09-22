// 回归：双 405 熔断器（consecutive405）。
//
// 守卫的真实事故（ADR 0001 / crawler.js:62 注释）：ceb 在固定出口 IP 下
// GET 405 → 降级 POST 仍 405，曾空转 100 页、约 5 小时。
// crawler.js:766-774 累计连续 405，crawler.js:838-841 达 2 页即熔断提前结束。
//
// 该逻辑此前零覆盖：所有 405 fixture 都停在 crawlPage() 层，
// 唯一走到 crawl() 批次循环的失败用例用的是无 status 的 ECONNRESET（计 netFailStreak）。
//
// 接缝：crawl({site,totalPages,interval,maxRetries}) 公开接口 + HTTP 调用计数。
// 期望值来自独立真相源（ADR 0001 的事故记录 + consecutive405>=2 的阈值语义），
// 不是照抄实现：熔断生效 → 只跑完第 1 批；熔断失效 → 跑满 100 页。
const assert = require('assert');
const { mockAxios, freshCrawler, withTempCwd } = require('./helper');
const { pageHtml, yfbzbRow } = require('./fixtures');

async function main() {
  let calls = 0;
  let getCalls = 0;
  let postCalls = 0;

  const restore = mockAxios((url, config) => {
    calls++;
    // mockAxios 的 post 会把 data 合进 config；据此区分 GET/POST
    const isPost = config && config.data !== undefined;
    if (isPost) postCalls++;
    else getCalls++;

    // 一律返回 405：yfbzb 未开 fallbackOn405，故 GET 即 405（无 POST 降级）。
    // 每页在 crawlPage 内做 maxRetries 次重试后返回 failed:true status:405。
    const error = new Error('Request failed with status code 405');
    error.response = { status: 405, data: '<html>waf</html>' };
    throw error;
  });

  try {
    const { crawl } = freshCrawler();
    await withTempCwd(() => crawl({ site: 'yfbzb', totalPages: 100, interval: 0, maxRetries: 1 }));
  } finally {
    restore();
  }

  // batchSize 默认 10。熔断在第 1 批（10 页全部 405）后触发，故不应进入第 2 批。
  // maxRetries:1 → 每页恰好 1 次 GET，故总调用数 = 已尝试页数。
  assert.strictEqual(
    calls,
    10,
    `双 405 熔断后应只跑完第 1 批（10 页 / 10 次请求），实际 ${calls} 次` +
    `（若为 100 则熔断未生效，将空转全部 ${100} 页）`
  );
  assert.strictEqual(postCalls, 0, 'yfbzb 未开启 fallbackOn405，不得发出 POST');
  assert.strictEqual(getCalls, 10, '每页一次 GET');

  console.log('双 405 熔断（连续 2 页即提前结束）：通过');
}

main().catch(error => {
  console.error('失败', error.stack || error.message);
  process.exit(1);
});
