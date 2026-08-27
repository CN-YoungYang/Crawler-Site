// 轻量静态文件服务：托管 file/ 目录，根路径为总导航页。
// 零依赖，仅 Node 原生 http/fs/path。
// 由 index.js 在启动时按需拉起，与爬虫调度并发运行。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { log } = require('./log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/json; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function resolveFileRoot() {
  return path.join(process.cwd(), 'file');
}

function safeJoin(root, urlPath) {
  // 去掉 query/hash，解码，防目录穿越
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const joined = path.join(root, clean);
  const relative = path.relative(root, joined);
  if (relative.startsWith('..') || path.isAbsolute(relative) && relative.includes('..')) {
    return null;
  }
  // 确保仍在 root 内
  if (!joined.startsWith(root)) return null;
  return joined;
}

function serveFile(res, filePath, stat) {
  const mime = mimeFor(filePath);
  const headers = {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': mime.includes('text/html') ? 'no-cache' : 'public, max-age=300',
  };
  // xlsx 下载友好
  if (mime.includes('spreadsheet') || mime.includes('ms-excel')) {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>404</title></head><body style="font-family:sans-serif;padding:2rem"><h1>404 Not Found</h1><p><a href="/">返回导航</a></p></body></html>');
}

function buildHealthPayload() {
  const now = new Date().toISOString();
  const uptime = Number(process.uptime().toFixed(1));
  let navGeneratedAt = null;
  let navExists = false;
  try {
    const navPath = path.join(resolveFileRoot(), 'index.html');
    if (fs.existsSync(navPath)) {
      navExists = true;
      navGeneratedAt = fs.statSync(navPath).mtime.toISOString();
    }
  } catch (_) {}
  // 精简探针：仅存活 + 导航时间，totals/sites 为兼容保留空值（原实现每次 scanFiles 读 xlsx，探针秒级开销）
  return { status: 'ok', timestamp: now, uptime, navExists, navGeneratedAt, totals: { sites: 0, dates: 0, records: 0 }, sites: [] };
}

function createServer({ port = 8080, root } = {}) {
  const fileRoot = root || resolveFileRoot();

  const server = http.createServer((req, res) => {
    if (!req.url) return notFound(res);
    // 仅处理 GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }

    let urlPath = req.url.split('?')[0];

    // 健康探针：机器检查用，返回 JSON（进阶：含站点统计与导航生成时间）
    if (urlPath === '/health' || urlPath === '/healthz' || urlPath === '/api/health') {
      const payload = buildHealthPayload();
      const body = JSON.stringify(payload);
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      return res.end(body);
    }

    // 根路径 -> file/index.html（总导航）
    if (urlPath === '/' || urlPath === '/index.html') {
      const navPath = path.join(fileRoot, 'index.html');
      if (fs.existsSync(navPath)) {
        const stat = fs.statSync(navPath);
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': stat.size });
          return res.end();
        }
        return serveFile(res, navPath, stat);
      }
      return notFound(res);
    }

    // 兼容：/yfbzb 或 /yfbzb/ -> file/yfbzb/index.html
    // 统一：/file/... 前缀也兼容（若反代透传）
    if (urlPath.startsWith('/file/')) {
      urlPath = urlPath.slice(5) || '/';
      if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;
    }

    let filePath = safeJoin(fileRoot, urlPath);
    if (!filePath) return notFound(res);

    try {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        return notFound(res);
      }

      // 目录 -> 尝试 index.html
      if (stat.isDirectory()) {
        const indexFile = path.join(filePath, 'index.html');
        if (fs.existsSync(indexFile)) {
          const idxStat = fs.statSync(indexFile);
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': idxStat.size });
            return res.end();
          }
          return serveFile(res, indexFile, idxStat);
        }
        return notFound(res);
      }

      if (stat.isFile()) {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': mimeFor(filePath), 'Content-Length': stat.size });
          return res.end();
        }
        return serveFile(res, filePath, stat);
      }

      return notFound(res);
    } catch (e) {
      log(`静态服务错误: ${e.message}`, { level: 'error', event: 'http_error', context: { url: req.url } });
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Internal Server Error');
    }
  });

  return server;
}

function startServer({ port } = {}) {
  const envPort = parseInt(process.env.HTTP_PORT || process.env.PORT || '', 10);
  const listenPort = port || (Number.isFinite(envPort) ? envPort : 8080);
  const enabled = (process.env.HTTP_ENABLED || 'true').toLowerCase() !== 'false';

  if (!enabled) {
    log('HTTP 静态服务已禁用（HTTP_ENABLED=false）', { event: 'http_disabled' });
    return null;
  }

  const server = createServer({ port: listenPort });
  server.listen(listenPort, () => {
    log(`HTTP 静态服务已启动：http://0.0.0.0:${listenPort}/  (托管 file/)`, { event: 'http_started', context: { port: listenPort } });
  });
  server.on('error', (err) => {
    log(`HTTP 服务启动失败: ${err.message}`, { level: 'error', event: 'http_failed', context: { port: listenPort, error: err.message } });
  });
  return server;
}

module.exports = { createServer, startServer, buildHealthPayload, mimeFor, safeJoin };
