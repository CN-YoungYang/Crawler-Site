// 每站一个持久去重台账：断点不再背 id 集，2 天 xlsx 窗口只作兜底。
//
// 落盘形态：state/<site>/ids.json
//   { "v": 1, "ids": { "<id>": "YYYY-MM-DD" } }
//
// 为什么不是数组：裁剪要按发布日期，数组里存不下这个信息；为什么不引 sqlite：
// 运行时零依赖是这里的既有取向（量级 1-3 万条，< 2MB）。
// 写入走「临时文件 + rename」，避免进程在写一半时被杀导致台账半截。

const fs = require('fs');
const path = require('path');
const { shanghaiDateStr, writeJsonAtomic } = require('./utils');
const { log } = require('./log');

const LEDGER_VERSION = 1;
// 保留窗口：比 Excel 的 2 天去重窗口宽得多，覆盖一次完整扫描 + 断点续跑的跨度。
const RETENTION_DAYS = 35;

function normalizeSite(site) {
  return String(site || 'yfbzb').toLowerCase();
}

function stateDir(site) {
  return path.join('state', normalizeSite(site));
}

function ledgerFile(site) {
  return path.join(stateDir(site), 'ids.json');
}

// 与 crawler 的 publishTime 归一化保持同一口径：先认 YYYY-MM-DD / YYYY/MM/DD，
// 再退回 Date.parse。无法判定日期的行不入台账（crawler 侧同样会跳过并记 invalid_publish_date）。
function publishDateOf(value) {
  const text = String(value == null ? '' : value).trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (m) {
    const mm = m[2].padStart(2, '0');
    const dd = m[3].padStart(2, '0');
    return `${m[1]}-${mm}-${dd}`;
  }
  if (!text) return null;
  const ts = Date.parse(text);
  if (Number.isNaN(ts)) return null;
  return shanghaiDateStr(0, ts);
}

function loadLedger(site) {
  const file = ledgerFile(site);
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log(`台账读取失败，按空表继续：${error.message}`, {
      level: 'warn', event: 'ledger_load_failed',
      context: { error: error.message, file, site: normalizeSite(site) }, site: normalizeSite(site)
    });
    return map;
  }
  const ids = raw && typeof raw === 'object' ? (raw.ids || raw) : null;
  if (!ids || typeof ids !== 'object') return map;
  for (const [id, date] of Object.entries(ids)) {
    if (typeof id !== 'string' || !id) continue;
    const normalized = publishDateOf(date);
    if (normalized) map.set(id, normalized);
  }
  return map;
}

function saveLedger(site, map) {
  writeJsonAtomic(ledgerFile(site), { v: LEDGER_VERSION, ids: Object.fromEntries(map) });
}

// 返回真正新增的条数。已存在的 id 保留原发布日期——台账记的是「首次见到」，
// 同一公告在后续扫描里重复出现不该把日期往后推（否则裁剪永远删不掉它）。
function addRows(map, rows) {
  let added = 0;
  for (const row of rows || []) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    if (map.has(id)) continue;
    const date = publishDateOf(row.publishDate || row.publishTime);
    if (!date) continue;
    map.set(id, date);
    added++;
  }
  return added;
}

// 保留 publishDate >= 截止日的条目。返回删除条数。
function pruneLedger(map, nowMs = Date.now(), days = RETENTION_DAYS) {
  const cutoff = shanghaiDateStr(-days, nowMs);
  let removed = 0;
  for (const [id, date] of [...map]) {
    if (date < cutoff) { map.delete(id); removed++; }
  }
  return removed;
}

function ledgerIds(map) {
  return new Set(map.keys());
}

module.exports = {
  LEDGER_VERSION,
  RETENTION_DAYS,
  stateDir,
  ledgerFile,
  loadLedger,
  saveLedger,
  addRows,
  pruneLedger,
  ledgerIds,
  publishDateOf
};
