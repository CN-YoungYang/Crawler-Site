// 日志：双通道。控制台中文给人看（定时任务 stdout 重定向），JSONL 给程序 grep。
// 两者并存、不互替。JSONL 按日分割 logs/<site>/crawler-YYYY-MM-DD.jsonl，复用 report.js 的 30 天保留窗口清理。

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;

let currentSite = (process.env.SITE || process.env.SITES || 'yfbzb').split(',')[0].trim().toLowerCase() || 'yfbzb';

function getSite() {
  return currentSite;
}

function setSite(site) {
  if (site) currentSite = String(site).toLowerCase();
}

function normalizeSite(site) {
  return String(site || currentSite || 'yfbzb').toLowerCase();
}

// 日志目录相对 cwd（与 file/ 输出同源），每次调用时解析，保证 withTempCwd 测试隔离
// 与定时任务从项目根运行一致。不在模块加载时冻结，避免 cwd 变更后路径失效。
// 按站点隔离：logs/<site>/，一容器多站点（并发）时靠显式 site 参数隔离，避免 currentSite 全局竞态。
function logDir(site) {
  return path.join(process.cwd(), 'logs', normalizeSite(site));
}

// 控制台一行：ISO 时间戳 + PID + 站点 + 中文消息
function consoleLine(ts, pid, message, site) {
  const s = normalizeSite(site);
  console.log(`[${ts}] [PID: ${pid}] [${s}] ${message}`);
}

// JSONL 一行：结构化字段，event 可 grep。上下文字段按需附加，不固定 schema。
function jsonlLine(ts, level, event, message, context, site) {
  const entry = { ts, level, event, msg: message, site: normalizeSite(site) };
  if (context) Object.assign(entry, context);
  return JSON.stringify(entry);
}

function todayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// 按日写 JSONL：首次写时建目录。文件名含日期，天然按日分割。
function appendJsonl(line, site) {
  const dir = logDir(site);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = path.join(dir, `crawler-${todayStamp()}.jsonl`);
  fs.appendFileSync(fileName, line + '\n', 'utf8');
}

// 保留窗口清理：删掉早于 RETENTION_DAYS 天的日志文件。
function pruneOldLogs(site) {
  const dir = logDir(site);
  if (!fs.existsSync(dir)) return;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));
  for (const name of fs.readdirSync(dir)) {
    const m = /^crawler-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    const fileDate = new Date(m[1] + 'T00:00:00Z');
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
}

// 主入口：同时写控制台 + JSONL。
// level: 'info' | 'warn' | 'error'；event: 结构化事件名；context: 可选附加字段；site: 可选站点覆写。
// 多站点并发时务必显式传 site，避免依赖全局 currentSite（setSite 在并发下会竞态）。
function log(message, { level = 'info', event = 'log', context, site } = {}) {
  const ts = new Date().toISOString();
  const pid = process.pid;
  const effectiveSite = normalizeSite(site);
  consoleLine(ts, pid, message, effectiveSite);
  appendJsonl(jsonlLine(ts, level, event, message, context, effectiveSite), effectiveSite);
}

module.exports = { log, pruneOldLogs, RETENTION_DAYS, setSite, getSite, logDir };
