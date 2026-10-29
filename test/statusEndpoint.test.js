// 接缝：HTTP 端点 GET /status 与 /health。
//
// /status 是「漏没漏」的观测面：crawler 只写 state/<site>/status.json，server 只读，
// 两边没有函数调用，所以静态服务不会被爬虫内部结构绑架。
// /health 是 compose 的 healthcheck 判据，业务指标绝不能混进去——否则站点一被 468 拦，
// 容器就被判死重启。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { withTempCwd } = require('./helper');
const { createServer } = require('../server');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  // ---- (a) /status 汇总各站状态文件，且不可缓存 ----
  await withTempCwd(async () => {
    fs.mkdirSync(path.join('state', 'yfbzb'), { recursive: true });
    fs.writeFileSync(path.join('state', 'yfbzb', 'status.json'), JSON.stringify({
      site: 'yfbzb',
      checkpointPage: 31,
      visitedPages: 30,
      oldestUnvisitedPage: 16,
      pendingPages: [4, 5],
      sweepId: 7,
      lastSweepCompletedAt: '2026-10-29T02:10:00.000Z',
      consecutiveIncompleteRounds: 2
    }), 'utf8');
    const server = createServer({});
    const port = await listen(server);
    try {
      const res = await get(port, '/status');
      assert.strictEqual(res.status, 200, '/status 必须可读');
      assert.strictEqual(res.headers['cache-control'], 'no-store', '状态页不能被缓存');
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.sites.yfbzb.checkpointPage, 31);
      assert.deepStrictEqual(payload.sites.yfbzb.pendingPages, [4, 5]);
      assert.strictEqual(payload.sites.yfbzb.oldestUnvisitedPage, 16);
    } finally {
      server.close();
    }
  });

  // ---- (b) 没有 state/ 时也要 200：新环境启动第一秒就该可读 ----
  await withTempCwd(async () => {
    const server = createServer({});
    const port = await listen(server);
    try {
      const res = await get(port, '/status');
      assert.strictEqual(res.status, 200, '还没有任何站点跑过时，/status 不能 500');
      assert.deepStrictEqual(JSON.parse(res.body).sites, {}, '没有状态文件时应返回空对象');
    } finally {
      server.close();
    }
  });

  // ---- (c) /health 保持轻量存活探针，不掺业务指标 ----
  await withTempCwd(async () => {
    fs.mkdirSync(path.join('state', 'yfbzb'), { recursive: true });
    fs.writeFileSync(path.join('state', 'yfbzb', 'status.json'), JSON.stringify({ site: 'yfbzb', checkpointPage: 31 }), 'utf8');
    const server = createServer({});
    const port = await listen(server);
    try {
      const res = await get(port, '/health');
      assert.strictEqual(res.status, 200, '有业务告警时 /health 仍须为 200，否则容器会被重启');
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.status, 'ok');
      assert.ok(!('sweepId' in payload) && !('checkpointPage' in payload), '/health 不得混入业务指标');
    } finally {
      server.close();
    }
  });

  console.log('statusEndpoint.test.js 通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
