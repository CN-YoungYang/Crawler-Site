// HTML 报告生成：file/<site>/ 下生成轻量索引页 + 每日明细页。
// index.html：报头 + 统计带 + 日期索引。
// <date>.html：该日明细表（标题搜索 + 排序）。
// 展示层、尽力而为：坏文件跳过、目录不存在兜底、生成失败由 index.js 捕获不中断爬取。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const xlsx = require('xlsx');
const { log, pruneOldLogs } = require('./log');
const { normalizeSite, listSites } = require('./sites');

const RETENTION_DAYS = 30;

function fileDir(site) {
  return path.join('file', normalizeSite(site));
}
function indexHtmlPath(site) {
  return path.join(fileDir(site), 'index.html');
}
function tokensCssPath(site) {
  return path.join(fileDir(site), 'tokens.css');
}
function navHtmlPath() {
  return path.join('file', 'index.html');
}
function navTokensCssPath() {
  return path.join('file', 'tokens.css');
}
function defaultSite() {
  return normalizeSite(process.env.SITE || 'yfbzb');
}

// 站点展示元信息：优先取站点配置中的 displayName/description/originUrl，否则回退
function siteMeta(site) {
  const key = normalizeSite(site);
  try {
    const cfg = require('./sites').getSiteConfig(key);
    return {
      key,
      displayName: cfg.displayName || cfg.name || key,
      description: cfg.description || '',
      originUrl: cfg.originUrl || cfg.baseUrl || '',
      // 供卡片副标题
      subtitle: cfg.description || (cfg.baseUrl ? new URL(cfg.baseUrl).hostname : key),
    };
  } catch (_) {
    return { key, displayName: key, description: '', originUrl: '', subtitle: key };
  }
}

function collectSiteStats(site) {
  const key = normalizeSite(site);
  const files = scanFiles(key);
  const totalDates = files.length;
  const totalRecords = files.reduce((n, f) => n + f.rows.length, 0);
  const latestUpdate = totalDates ? files[0].date : '-';
  // 文件系统 mtime 作为“最后更新”兜底
  let mtimeLabel = '-';
  try {
    if (files[0]) {
      const dir = fileDir(key);
      const stat = fs.statSync(path.join(dir, files[0].fileName));
      if (stat && stat.mtime) mtimeLabel = stat.mtime.toLocaleString('zh-CN', { hour12: false });
    }
  } catch (_) {}
  return { site: key, files, totalDates, totalRecords, latestUpdate, mtimeLabel, meta: siteMeta(key) };
}

function getReportWindow(now = new Date()) {
  const shanghaiMs = now.getTime() + 8 * 3600000;
  const y = new Date(shanghaiMs).getUTCFullYear();
  const m = new Date(shanghaiMs).getUTCMonth();
  const d = new Date(shanghaiMs).getUTCDate();
  const end = new Date(Date.UTC(y, m, d));
  const start = new Date(end.getTime() - (RETENTION_DAYS - 1) * 86400000);
  return { start, end };
}

function parseFileDate(fileName) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.xlsx$/.exec(fileName);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null;
  return date;
}

function formatDateForFile(date) {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
}

// .xlsx 是 zip 包（魔数 PK\x03\x04）。先验魔数：xlsx 库对非 zip 内容会静默返回空表，
function readRows(filePath) {
  let fd;
  try {
    const head = Buffer.alloc(4);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, head, 0, 4, 0);
    if (bytesRead < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
      throw new Error('不是有效的 xlsx（zip）文件');
    }
  } catch (error) {
    log(`读取 ${filePath} 失败，已跳过：${error.message}`, { site: path.basename(path.dirname(filePath)) });
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  try {
    const wb = xlsx.readFile(filePath);
    const sheetName = wb.SheetNames && wb.SheetNames[0];
    if (!sheetName || !wb.Sheets[sheetName]) return [];
    return xlsx.utils.sheet_to_json(wb.Sheets[sheetName]);
  } catch (error) {
    log(`读取 ${filePath} 失败，已跳过：${error.message}`, { site: path.basename(path.dirname(filePath)) });
    return null;
  }
}

function scanFiles(site) {
  const siteName = site ? normalizeSite(site) : defaultSite();
  const dir = fileDir(siteName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }

  const { start, end } = getReportWindow();
  const entries = fs.readdirSync(dir)
    .filter(fileName => fileName.endsWith('.xlsx'))
    .map(fileName => {
      const fileDate = parseFileDate(fileName);
      if (!fileDate) return null;

      const filePath = path.join(dir, fileName);
      if (fileDate < start) {
        fs.unlinkSync(filePath);
        const detailPath = path.join(dir, `${fileName.replace(/\.xlsx$/, '')}.html`);
        if (fs.existsSync(detailPath)) fs.unlinkSync(detailPath);
        log(`已清理过期源数据：${fileName}`, { context: { site: siteName }, site: siteName });
        return null;
      }
      if (fileDate > end) return null;

      const rows = readRows(filePath);
      if (!rows) return null;
      return { date: fileName.replace(/\.xlsx$/, ''), fileName, rows };
    })
    .filter(Boolean);

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries;
}

function inlineJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

const TOKENS_CSS = `/* Taste Skill: Clean Utility & High-Density Data
 * theme: system-adaptive (light/dark)
 * typography: system sans + mono for data
 */
:root {
  color-scheme: light dark;

  --bg: #f8f6f3;
  --bg-subtle: #ffffff;
  --bg-hover: #f1ece8;
  --bg-muted: #ede9e3;

  --fg: #1c1c1a;
  --fg-muted: #7a7670;
  --fg-faint: #9a9590;

  --border: #e8e2d9;
  --border-strong: #c8bdb0;

  --accent: #b4532d;
  --accent-hover: #8f3f24;
  --accent-soft: rgba(180, 83, 45, 0.09);
  --accent-line: #b4532d;

  --font-sans: "Aptos", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;

  --radius-sm: 6px;
  --radius: 12px;
  --radius-pill: 999px;

  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --nav-max: 72rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e10;
    --bg-subtle: #1a1a1e;
    --bg-hover: #252529;
    --bg-muted: #1f1f23;

    --fg: #f5f4f1;
    --fg-muted: #a1a1aa;
    --fg-faint: #71717a;

    --border: #27272a;
    --border-strong: #3f3f46;

    --accent: #e86a33;
    --accent-hover: #ff7d45;
    --accent-soft: rgba(232, 106, 51, 0.13);
    --accent-line: #e86a33;
  }
}
`;

const COMMON_CSS = `
  * { box-sizing: border-box; }
  body::before { content: ""; display: block; height: 0.35rem; margin: 0 calc(var(--space-md) * -1) 3.25rem; background: var(--accent); }
  html { overflow-x: hidden; }
  body { overflow-x: clip; }
  body {
    margin: 0;
    padding: 0 var(--space-md) 4rem;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: 0.875rem;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    width: 100%;
    max-width: 72rem;
    margin: 0 auto;
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: none; }

  /* Focus States */
  button:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }

  /* Header */
  .header { margin-bottom: var(--space-xl); }
  .page-title {
    margin: 0 0 var(--space-xs) 0;
    font-size: clamp(2rem, 4vw, 3.5rem);
    font-weight: 600;
    letter-spacing: 0;
    color: var(--fg);
  }
  .page-meta {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.875rem;
  }

  /* Top Navigation (Detail page) */
  .top-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-xl);
    padding-bottom: var(--space-md);
    border-bottom: 1px solid var(--border);
  }
  .nav-link {
    display: inline-flex;
    align-items: center;
    color: var(--fg-muted);
    font-weight: 500;
  }
  .nav-link:hover { color: var(--fg); text-decoration: none; }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: 1.1fr 1.1fr 1fr 1.5fr;
    gap: var(--space-md);
    padding: var(--space-lg);
    margin-bottom: var(--space-xl);
    border: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .stat-item { display: flex; flex-direction: column; gap: 0.25rem; }
  .stat-label { font-size: 0.75rem; color: var(--fg-muted); font-weight: 500; }
  .stat-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 1.25rem; font-weight: 600; color: var(--fg); }

  /* Filters */
  .filter-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--space-sm);
  }
  .section-title { margin: 0; font-family: Georgia, "Songti SC", serif; font-size: 1.45rem; font-weight: 700; }
  .filter-status { color: var(--fg-muted); font-family: var(--font-mono); font-size: 0.75rem; }

  .filter-controls {
    display: flex;
    gap: var(--space-sm);
    margin-bottom: var(--space-lg);
  }
  .search-input {
    flex: 1;
    max-width: 24rem;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-family: inherit;
    font-size: 0.875rem;
  }
  .search-input::placeholder { color: var(--fg-muted); }
  .search-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-color: transparent;
  }

  .btn-secondary {
    padding: 0.5rem 1rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  /* Tables */
  .table-container { width: 100%; overscroll-behavior-x: contain; scrollbar-color: var(--border-strong) transparent; scrollbar-width: thin; }
  .table-container:has(.data-table) { overflow: auto; }
  .data-table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    white-space: nowrap;
  }
  .data-table th {
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--border-strong);
    color: var(--fg-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-align: left;
  }
  .data-table td {
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .data-table tr:last-child td { border-bottom: none; }

  .date-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    width: 100%;
  }
  .date-item {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: 1.25rem;
    min-height: 7.25rem;
    padding: 1rem 1.05rem 0.9rem;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--fg);
    text-decoration: none;
    transition: background-color 180ms ease, border-color 180ms ease, transform 180ms ease;
  }
  .date-item:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
    transform: translateY(-2px);
  }
  .date-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .date-item-date { min-width: 0; overflow: hidden; color: var(--accent-hover); font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
  .date-item-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    color: var(--fg-muted);
    font-size: 0.75rem;
  }
  .date-item-count { font-size: 0.75rem; }
  .date-item-count strong { color: var(--fg); font-size: 0.95rem; font-weight: 600; }
  .date-item-arrow { color: var(--fg-muted); font-size: 1rem; transition: transform 180ms ease, color 180ms ease; }
  .date-item:hover .date-item-arrow { transform: translateX(0.2rem); color: var(--accent); }
  .date-item:active { transform: translateY(0) scale(0.99); }
  .detail-table { min-width: 42rem; }
  .detail-table th:first-child,
  .detail-table td:first-child { width: auto; min-width: 30rem; text-align: left; }
  .detail-table th:last-child,
  .detail-table td:last-child { width: 11rem; text-align: left; }
  .detail-table .cell-wrap { white-space: normal; line-height: 1.55; }
  .data-table tbody tr { transition: background 180ms ease; }
  .data-table tbody tr:hover td { background-color: var(--bg-hover); }
  .btn-secondary, .search-input { transition: background 180ms ease, border-color 180ms ease, transform 180ms ease; }
  .btn-secondary:active { transform: translateY(1px) scale(0.98); }

  /* Specific Column Styles */
  .cell-mono { font-family: var(--font-mono); }
  .cell-actions { display: flex; gap: var(--space-md); }
  .cell-wrap { white-space: normal; min-width: 20rem; }

  /* Sort Buttons */
  .sort-button {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    font-weight: inherit;
    color: inherit;
  }

  /* Badges */
  .badge {
    display: inline-flex;
    padding: 0.125rem 0.375rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--fg-muted);
  }

  /* Empty States */
  .empty-state {
    padding: var(--space-xl);
    text-align: left;
    color: var(--fg-muted);
    border: 1px solid var(--border);
  }
  .empty-state strong { display: block; color: var(--fg); font-size: 1rem; margin-bottom: 0.25rem; }
  .empty-state p { margin: 0; }

  .stat-value-small { font-size: 0.95rem; }
  .section-note { margin: 0.25rem 0 0; color: var(--fg-muted); font-size: 0.8125rem; }
  .retention-banner {
    display: grid;
    grid-template-columns: auto auto auto 1fr;
    gap: 0.7rem;
    align-items: center;
    margin: -1.75rem 0 2.5rem;
    padding: 0.85rem 1rem;
    border-left: 3px solid var(--accent);
    background: var(--bg-subtle);
    color: var(--fg-muted);
    font-size: 0.8125rem;
  }
  .retention-banner strong { color: var(--fg); font-size: 0.9rem; }
  .retention-range { color: var(--accent-hover); font-size: 0.8rem; }
  .retention-copy { justify-self: end; text-align: right; }

  [hidden] { display: none !important; }
  .row-hidden { display: none !important; }

  @media (min-width: 641px) and (max-width: 980px) {
    .date-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  @media (max-width: 640px) {
    .stats-grid { grid-template-columns: 1fr; gap: var(--space-lg); }
    .retention-banner { grid-template-columns: 1fr; gap: 0.25rem; margin-top: -1rem; }
    .retention-copy { justify-self: start; text-align: left; }
    .filter-controls { flex-direction: column; }
    .search-input { max-width: 100%; }
    .date-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .date-item { min-height: 6.5rem; padding: 0.85rem; }
    .data-table th, .data-table td { padding-right: var(--space-sm); }
    .index-table { width: 100%; }
  }
`;

const NAV_CSS = `
  /* Nav utility bar */
  .nav-utility {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.7rem 0 0.95rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .nav-utility-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 650;
    color: var(--fg);
    letter-spacing: 0.06em;
  }
  .nav-utility-kicker::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .nav-utility-meta {
    display: flex;
    align-items: center;
    gap: 1rem;
    white-space: nowrap;
  }
  .nav-utility-meta a {
    color: var(--fg-muted);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    padding-bottom: 1px;
  }
  .nav-utility-meta a:hover { color: var(--fg); border-bottom-color: var(--border-strong); }

  /* Hero: asymmetric split */
  .nav-hero {
    display: grid;
    grid-template-columns: 1.35fr 0.9fr;
    gap: 2rem;
    align-items: end;
    padding-bottom: 2rem;
    margin-bottom: 2rem;
    border-bottom: 1px solid var(--border);
  }
  .nav-hero-title {
    margin: 0 0 0.7rem;
    font-size: clamp(2rem, 4.2vw, 3.25rem);
    font-weight: 750;
    line-height: 0.95;
    letter-spacing: -0.03em;
    color: var(--fg);
  }
  .nav-hero-desc {
    margin: 0;
    max-width: 34rem;
    color: var(--fg-muted);
    font-size: 0.94rem;
    line-height: 1.65;
  }
  .nav-hero-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    overflow: hidden;
  }
  .nav-hero-stat {
    padding: 1rem 1.1rem;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
  }
  .nav-hero-stat:nth-child(2n) { border-right: none; }
  .nav-hero-stat:nth-last-child(-n+2) { border-bottom: none; }
  .nav-hero-stat-label {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
    font-weight: 600;
  }
  .nav-hero-stat-value {
    font-family: var(--font-mono);
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1;
    color: var(--fg);
    letter-spacing: -0.02em;
  }
  .nav-hero-stat-value.small {
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nav-hero-stat--accent { background: var(--accent-soft); }

  /* Section head */
  .nav-section-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.9rem;
  }
  .nav-section-title { margin: 0; font-size: 1.02rem; font-weight: 700; letter-spacing: -0.01em; color: var(--fg); }
  .nav-section-note { font-family: var(--font-mono); font-size: 0.72rem; color: var(--fg-muted); }

  /* Site list: editorial rows */
  .site-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    margin-bottom: 1.5rem;
  }
  .site-row {
    display: grid;
    grid-template-columns: 3.4rem 1fr auto;
    gap: 1.2rem;
    align-items: center;
    padding: 1.3rem 1.2rem;
    border-bottom: 1px solid var(--border);
    text-decoration: none;
    color: inherit;
    transition: background 160ms ease;
    cursor: pointer;
  }
  .site-row:last-child { border-bottom: none; }
  .site-row:hover { background: var(--bg-hover); }
  .site-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .site-row:focus-within { background: var(--bg-hover); }
  .site-row-index {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--border);
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--fg-faint);
  }
  .site-row:hover .site-row-index { border-color: var(--accent); color: var(--accent); }
  .site-row-main { min-width: 0; display: flex; flex-direction: column; gap: 0.42rem; }
  .site-row-header { display: flex; align-items: baseline; gap: 0.65rem; flex-wrap: wrap; }
  .site-row-title { margin: 0; font-size: 1.07rem; font-weight: 750; letter-spacing: -0.015em; color: var(--fg); line-height: 1.25; }
  .site-row-key {
    display: inline-flex;
    align-items: center;
    padding: 0.14rem 0.42rem;
    background: var(--bg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .site-row-desc {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.84rem;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .site-row-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    padding-top: 0.3rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--fg-muted);
  }
  .site-row-stats strong { color: var(--fg); font-weight: 700; font-size: 0.81rem; }
  .site-row-stats span { display: inline-flex; align-items: center; gap: 0.32rem; }
  .site-row-stats .sep { width: 1px; height: 0.85em; background: var(--border); display: inline-block; }
  .site-row-action { display: flex; align-items: center; justify-content: center; min-width: 2.5rem; }
  .site-row-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg-faint);
    font-size: 0.85rem;
    line-height: 1;
    text-decoration: none;
    transition: border-color 160ms ease, color 160ms ease, background 160ms ease, transform 160ms ease;
  }
  .site-row:hover .site-row-arrow { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .site-row-arrow:active { transform: scale(0.96); }
  .site-row-origin {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.03em;
    color: var(--fg-faint);
    text-decoration: none;
    opacity: 0.9;
    border-bottom: 1px dashed transparent;
    padding-bottom: 1px;
    transition: color 150ms ease, border-color 150ms ease, opacity 150ms ease;
  }
  .site-row-origin:hover { color: var(--fg-muted); border-bottom-color: var(--border-strong); opacity: 1; }
  .site-row-origin:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .site-row-origin-icon { font-size: 0.72em; opacity: 0.5; transform: translateY(-0.5px); }
  .site-row-origin-wrap { display: flex; margin-top: 0.15rem; }
  .site-row--empty .site-row-stats { color: var(--fg-faint); }
  .site-row--empty .site-row-stats strong { color: var(--fg-muted); }

  .nav-footer {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 0.71rem;
    color: var(--fg-faint);
  }
  .nav-footer a { color: var(--fg-muted); text-decoration: none; }
  .nav-footer a:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }

  @media (max-width: 860px) {
    .nav-hero { grid-template-columns: 1fr; gap: 1.25rem; }
    .site-row { grid-template-columns: 3rem 1fr 2.2rem; }
  }
  @media (max-width: 640px) {
    .nav-utility { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
    .nav-hero-stats { border-left: none; border-right: none; }
    .site-row { padding: 1rem; gap: 0.9rem; }
    .site-row-desc { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .site-row-stats { gap: 0.35rem 0.7rem; }
    .nav-footer { flex-direction: column; gap: 0.4rem; }
  }
`;

function buildNavHtml(sitesData) {
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const totalSites = sitesData.length;
  const totalRecords = sitesData.reduce((n, s) => n + s.totalRecords, 0);
  const totalDates = sitesData.reduce((n, s) => n + s.totalDates, 0);

  const rowsHtml = sitesData.map((s, idx) => {
    const hasData = s.totalDates > 0;
    const num = String(idx + 1).padStart(2, '0');
    const statsHtml = hasData
      ? `<div class="site-row-stats"><span>总计 <strong>${s.totalDates.toLocaleString('zh-CN')}</strong> 天</span><span class="sep" aria-hidden="true"></span><span>共 <strong>${s.totalRecords.toLocaleString('zh-CN')}</strong> 条</span><span class="sep" aria-hidden="true"></span><span>最近 <strong class="cell-mono">${s.latestUpdate}</strong></span></div>`
      : `<div class="site-row-stats"><span>暂无数据，完成首次爬取后显示</span></div>`;
    let originLink = '';
    if (s.meta.originUrl) {
      let host = s.meta.originUrl;
      try { host = new URL(s.meta.originUrl).hostname.replace(/^www\./, ''); } catch (_) {}
      originLink = `<a class="site-row-origin" href="${s.meta.originUrl}" target="_blank" rel="noopener noreferrer" title="前往原站 ${host}">原站 <span class="site-row-origin-icon" aria-hidden="true">↗</span></a>`;
    }
    const href = `${encodeURIComponent(s.site)}/index.html`;
    const emptyClass = hasData ? '' : ' site-row--empty';
    return `<div class="site-row${emptyClass}" data-href="${href}" role="link" tabindex="0" aria-label="${s.meta.displayName}" onclick="if(!event.target.closest('a')) location.href=this.dataset.href" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();location.href=this.dataset.href}">
      <span class="site-row-index">${num}</span>
      <span class="site-row-main">
        <span class="site-row-header">
          <span class="site-row-title">${s.meta.displayName}</span>
          <span class="site-row-key">${s.site}</span>
        </span>
        <span class="site-row-desc">${s.meta.description || s.meta.subtitle || ''}</span>
        ${statsHtml}
        ${originLink ? `<span class="site-row-origin-wrap">${originLink}</span>` : ''}
      </span>
      <span class="site-row-action" aria-hidden="true">
        <span class="site-row-arrow">→</span>
      </span>
    </div>`;
  }).join('\n');

  const emptyHtml = totalSites === 0
    ? `<div class="empty-state"><strong>暂无可用站点</strong><p>请检查 SITES 配置与 sites/ 注册表。</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>招标数据导航</title>
<link rel="stylesheet" href="tokens.css">
<style>${COMMON_CSS}${NAV_CSS}</style>
</head>
<body>
<div class="container">
  <div class="nav-utility">
    <span class="nav-utility-kicker">Crawler 导航</span>
    <span class="nav-utility-meta"><span>生成于 ${generatedAt}</span><a href="/health">健康检查</a></span>
  </div>

  <header class="nav-hero">
    <div>
      <h1 class="nav-hero-title">招标数据导航</h1>
      <p class="nav-hero-desc">汇聚多源招标公告，按发布日期分区归档，保留最近 30 天。选择站点进入对应报告，或前往原站核验原文。</p>
    </div>
    <div class="nav-hero-stats" aria-label="汇总统计">
      <div class="nav-hero-stat"><span class="nav-hero-stat-label">站点</span><span class="nav-hero-stat-value">${totalSites.toLocaleString('zh-CN')}</span></div>
      <div class="nav-hero-stat"><span class="nav-hero-stat-label">日期</span><span class="nav-hero-stat-value">${totalDates.toLocaleString('zh-CN')}</span></div>
      <div class="nav-hero-stat"><span class="nav-hero-stat-label">记录</span><span class="nav-hero-stat-value">${totalRecords.toLocaleString('zh-CN')}</span></div>
      <div class="nav-hero-stat nav-hero-stat--accent"><span class="nav-hero-stat-label">生成时间</span><span class="nav-hero-stat-value small">${generatedAt}</span></div>
    </div>
  </header>

  <main>
    <div class="nav-section-head">
      <h2 class="nav-section-title">全部站点</h2>
      <span class="nav-section-note">${totalSites ? `共 ${totalSites} 个站点` : '暂无站点'}</span>
    </div>
    ${totalSites ? `<div class="site-list">${rowsHtml}</div>` : emptyHtml}
  </main>

  <footer class="nav-footer">
    <span>保留 30 天，过期自动清理，数据每日定时更新</span>
    <span>生成于 ${generatedAt} <span style="opacity:.4; margin:0 0.35rem;">|</span> <a href="/health">/health</a></span>
  </footer>
</div>
</body>
</html>`;
}

function buildIndexHtml(files) {
  const totalDates = files.length;
  const totalRecords = files.reduce((n, f) => n + f.rows.length, 0);
  const latestUpdate = totalDates ? files[0].date : '-';
  const reportWindow = getReportWindow();
  const windowLabel = formatDateForFile(reportWindow.start) + ' 至 ' + formatDateForFile(reportWindow.end);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const rowsJson = inlineJson(files.map(f => ({ date: f.date, fileName: f.fileName, count: f.rows.length })));
  const filterHidden = totalDates ? '' : ' hidden';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>招标公告数据索引</title>
<link rel="stylesheet" href="tokens.css">
<style>${COMMON_CSS}</style>
</head>
<body>
<div class="container">
  <header class="header">
    <h1 class="page-title">招标公告数据索引</h1>
    <p class="page-meta">生成于 ${generatedAt} · 仅保留最近 ${RETENTION_DAYS} 天</p>
  </header>

  <div class="stats-grid">
    <div class="stat-item"><span class="stat-label">总计日期</span><span class="stat-value">${totalDates.toLocaleString('zh-CN')}</span></div>
    <div class="stat-item"><span class="stat-label">总计记录</span><span class="stat-value">${totalRecords.toLocaleString('zh-CN')}</span></div>
    <div class="stat-item"><span class="stat-label">最近更新</span><span class="stat-value cell-mono">${latestUpdate}</span></div>
    <div class="stat-item stat-window"><span class="stat-label">保留窗口</span><span class="stat-value stat-value-small cell-mono">${windowLabel}</span></div>
  </div>

  <div class="retention-banner" role="status">
    <span>数据保留</span>
    <strong>最近 ${RETENTION_DAYS} 天</strong>
    <span class="retention-range cell-mono">${windowLabel}</span>
    <span class="retention-copy">超过窗口的源文件会在生成报告时自动清理。</span>
  </div>
  <main>
    <div class="filter-header"${filterHidden}>
      <div><h2 class="section-title">近 ${RETENTION_DAYS} 天</h2><p class="section-note">${windowLabel} 的可用公告</p></div>
      <span id="date-search-status" class="filter-status">显示 ${totalDates.toLocaleString('zh-CN')} 个日期</span>
    </div>

    <div class="filter-controls"${filterHidden}>
      <input id="date-search" class="search-input" type="search" placeholder="输入日期筛选, 例如 2026-08" autocomplete="off">
      <button id="clear-date-search" class="btn-secondary" type="button" hidden>清除</button>
    </div>

    <div id="content" class="table-container"></div>
    <div id="date-empty" class="empty-state" hidden>
      <strong>无匹配日期</strong>
      <p>请尝试调整筛选内容。</p>
    </div>
  </main>
</div>
<script>
  var files = ${rowsJson};
  var content = document.getElementById('content');
  var statusEl = document.getElementById('date-search-status');
  var dateSearch = document.getElementById('date-search');
  var clearSearch = document.getElementById('clear-date-search');
  var filteredEmpty = document.getElementById('date-empty');
  var rowElements = [];

  if (!files.length) {
    content.innerHTML = '<div class="empty-state"><strong>暂无数据</strong><p>完成首次爬取后，这里将显示日期列表。</p></div>';
  } else {
    var list = document.createElement('div');
    list.className = 'date-grid';
    files.forEach(function(f) {
      var item = document.createElement('a');
      item.className = 'date-item';
      item.href = f.date + '.html';
      item.dataset.date = f.date.toLowerCase();
      item.setAttribute('aria-label', f.date + '，' + f.count.toLocaleString('zh-CN') + ' 条记录');

      var date = document.createElement('span');
      date.className = 'date-item-date cell-mono';
      date.textContent = f.date;
      item.appendChild(date);

      var count = document.createElement('span');
      count.className = 'date-item-count';
      count.innerHTML = '<strong>' + f.count.toLocaleString('zh-CN') + '</strong> 条记录';
      item.appendChild(count);

      var meta = document.createElement('span');
      meta.className = 'date-item-meta';

      var count = item.querySelector('.date-item-count');
      meta.appendChild(count);

      var arrow = document.createElement('span');
      arrow.className = 'date-item-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      meta.appendChild(arrow);
      item.appendChild(meta);

      list.appendChild(item);
      rowElements.push(item);
    });
    content.appendChild(list);

    function applyDateFilter() {
      var q = dateSearch.value.trim().toLowerCase();
      var visible = 0;
      rowElements.forEach(function(tr) {
        var matches = !q || tr.dataset.date.indexOf(q) !== -1;
        tr.classList.toggle('row-hidden', !matches);
        if (matches) visible++;
      });
      clearSearch.hidden = !q;
      filteredEmpty.hidden = visible !== 0;
      statusEl.textContent = q
        ? '找到 ' + visible.toLocaleString('zh-CN') + ' / ' + files.length.toLocaleString('zh-CN') + ' 个日期'
        : '显示 ' + files.length.toLocaleString('zh-CN') + ' 个日期';
    }

    var searchTimer = null;
    dateSearch.addEventListener('input', function() {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(applyDateFilter, 150);
    });
    clearSearch.addEventListener('click', function() {
      dateSearch.value = '';
      applyDateFilter();
      dateSearch.focus();
    });
  }
</script>
</body>
</html>`;
}

function buildDetailHtml(file) {
  const rowsJson = inlineJson(file.rows);
  const date = file.date;
  const downloadHref = encodeURIComponent(file.fileName);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const reportWindow = getReportWindow();
  const windowLabel = formatDateForFile(reportWindow.start) + ' 至 ' + formatDateForFile(reportWindow.end);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${date} 招标公告明细</title>
<link rel="stylesheet" href="tokens.css">
<style>${COMMON_CSS}</style>
</head>
<body>
<div class="container">
  <nav class="top-nav">
    <a class="nav-link" href="index.html">← 返回索引</a>
    <a class="nav-link" href="${downloadHref}" download>下载本日 XLSX</a>
  </nav>

  <header class="header">
    <h1 class="page-title">${date} 招标公告</h1>
    <p class="page-meta">共 ${file.rows.length.toLocaleString('zh-CN')} 条记录 / 生成于 ${generatedAt}</p>
  </header>

  <div class="retention-banner" role="status">
    <span>数据保留</span>
    <strong>最近 ${RETENTION_DAYS} 天</strong>
    <span class="retention-range cell-mono">${windowLabel}</span>
    <span class="retention-copy">超过窗口的源文件会在生成报告时自动清理。</span>
  </div>
  <main>
    <div class="filter-header">
      <h2 class="section-title">公告列表</h2>
      <span id="search-status" class="filter-status">共 ${file.rows.length.toLocaleString('zh-CN')} 条记录</span>
    </div>

    <div class="filter-controls">
      <input id="search" class="search-input" type="search" placeholder="搜索标题或地区" autocomplete="off">
      <button id="clear-search" class="btn-secondary" type="button" hidden>清除</button>
    </div>

    <div id="content" class="table-container"></div>
    <div id="filtered-empty" class="empty-state" hidden>
      <strong>无匹配记录</strong>
      <p>请尝试其他关键词。</p>
    </div>
  </main>
</div>
<script>
  var rows = ${rowsJson};
  var content = document.getElementById('content');
  var search = document.getElementById('search');
  var clearSearch = document.getElementById('clear-search');
  var statusEl = document.getElementById('search-status');
  var filteredEmpty = document.getElementById('filtered-empty');
  var rowElements = [];

  var table = document.createElement('table');
  table.className = 'data-table detail-table';
  var thead = document.createElement('thead');

  var columns = [
    { key: 'title', label: '标题' },
    { key: 'area', label: '地区' }
  ];

  var headTr = document.createElement('tr');
  var headButtons = [];

  columns.forEach(function(col) {
    var th = document.createElement('th');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-button';
    button.dataset.key = col.key;
    button.textContent = col.label;

    var arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    button.appendChild(arrow);

    th.appendChild(button);
    headTr.appendChild(th);
    headButtons.push({ th: th, button: button, arrow: arrow, label: col.label });
  });

  thead.appendChild(headTr);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');

  function buildTr(r) {
    var tr = document.createElement('tr');

    var tdTitle = document.createElement('td');
    tdTitle.className = 'cell-wrap';
    var href = r.link || '';
    if (href && (href.indexOf('http://') === 0 || href.indexOf('https://') === 0)) {
      var titleLink = document.createElement('a');
      titleLink.href = href;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = r.title || '未命名公告';
      titleLink.title = r.title || '未命名公告';
      tdTitle.appendChild(titleLink);
    } else {
      tdTitle.textContent = r.title || '未命名公告';
    }
    tr.appendChild(tdTitle);

    var tdArea = document.createElement('td');
    var areaBadge = document.createElement('span');
    areaBadge.className = 'badge';
    areaBadge.textContent = r.area || '未知';
    areaBadge.title = r.area || '未知';
    tdArea.appendChild(areaBadge);
    tr.appendChild(tdArea);

    tr.dataset.search = ((r.title || '') + ' ' + (r.area || '')).toLowerCase();
    return tr;
  }

  var frag = document.createDocumentFragment();
  rows.forEach(function(r) {
    var tr = buildTr(r);
    rowElements.push(tr);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
  table.appendChild(tbody);

  if (rows.length) {
    content.appendChild(table);
  } else {
    content.innerHTML = '<div class="empty-state"><strong>暂无记录</strong><p>该日期没有可显示的公告数据。</p></div>';
  }

  function applyFilter() {
    var q = search.value.trim().toLowerCase();
    var visible = 0;
    rowElements.forEach(function(tr) {
      var matches = !q || tr.dataset.search.indexOf(q) !== -1;
      tr.classList.toggle('row-hidden', !matches);
      if (matches) visible++;
    });
    clearSearch.hidden = !q;
    filteredEmpty.hidden = !q || visible !== 0;
    statusEl.textContent = q
      ? '找到 ' + visible.toLocaleString('zh-CN') + ' / ' + rows.length.toLocaleString('zh-CN') + ' 条记录'
      : '共 ' + rows.length.toLocaleString('zh-CN') + ' 条记录';
  }

  var searchTimer = null;
  search.addEventListener('input', function() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 150);
  });

  clearSearch.addEventListener('click', function() {
    search.value = '';
    applyFilter();
    search.focus();
  });

  // Basic sorting logic
  var originalOrder = Array.from(tbody.children);
  var sortKey = null, sortDir = null;
  var collator = typeof Intl !== 'undefined' && Intl.Collator
    ? new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
    : null;

  function natCompare(a, b) {
    return collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);
  }

  function refreshArrows() {
    headButtons.forEach(function(item) {
      var active = item.button.dataset.key === sortKey;
      item.arrow.textContent = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    });
  }

  headButtons.forEach(function(item, idx) {
    item.button.addEventListener('click', function() {
      var key = item.button.dataset.key;
      if (sortKey !== key) { sortKey = key; sortDir = 'asc'; }
      else if (sortDir === 'asc') { sortDir = 'desc'; }
      else { sortKey = null; sortDir = null; }

      if (!sortKey) {
        originalOrder.forEach(function(tr) { tbody.appendChild(tr); });
      } else {
        var cellIdx = idx;
        function cellText(tr) {
          return tr.children[cellIdx].textContent || '';
        }
        var items = Array.from(tbody.children);
        items.sort(function(a, b) {
          var av = cellText(a), bv = cellText(b);
          return sortDir === 'asc' ? natCompare(av, bv) : natCompare(bv, av);
        });
        items.forEach(function(tr) { tbody.appendChild(tr); });
      }
      refreshArrows();
    });
  });

  refreshArrows();
</script>
</body>
</html>`;
}

async function generateReport(site) {
  const siteName = site ? normalizeSite(site) : defaultSite();
  const dir = fileDir(siteName);
  const files = scanFiles(siteName);
  pruneOldLogs(siteName);
  await Promise.all([
    fsp.writeFile(indexHtmlPath(siteName), buildIndexHtml(files), 'utf8'),
    fsp.writeFile(tokensCssPath(siteName), TOKENS_CSS, 'utf8'),
    ...files.map(f => fsp.writeFile(path.join(dir, `${f.date}.html`), buildDetailHtml(f), 'utf8'))
  ]);
  log(`已生成报告 [${siteName}]：索引 ${indexHtmlPath(siteName)} + ${files.length} 个明细页（${files.reduce((n, f) => n + f.rows.length, 0)} 条记录）`, { event: 'report_generated', context: { site: siteName, files: files.length, records: files.reduce((n, f) => n + f.rows.length, 0) }, site: siteName });
}

async function generateNav(sites) {
  let targets;
  if (sites && sites.length) {
    targets = sites.map(normalizeSite);
  } else {
    // 无显式列表时，优先尊重 SITES 环境变量，否则回退到已启用站点（排除示例站点 demo）
    try {
      const { parseSitesList } = require('./sites');
      const envSites = parseSitesList();
      targets = envSites.length ? envSites : require('./sites').listEnabledSites().filter(s => s !== 'demo');
    } catch (_) {
      targets = require('./sites').listEnabledSites().filter(s => s !== 'demo');
    }
  }
  const { getSiteConfig } = require('./sites');
  const valid = [];
  for (const s of targets) {
    if (s === 'demo') continue;
    try { getSiteConfig(s); valid.push(s); } catch { /* 跳过未实现站点 */ }
  }
  // yfbzb/ceb 置顶，其余按字母序
  const pinned = ['yfbzb', 'ceb'];
  valid.sort((a, b) => {
    const ai = pinned.indexOf(a), bi = pinned.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai !== -1 && bi !== -1) return ai - bi;
      return ai !== -1 ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  const sitesData = valid.map(collectSiteStats);
  // 确保各站点的报告索引存在（首次部署时 file/<site>/ 可能为空，避免导航卡片 404）
  for (const s of sitesData) {
    const idxPath = indexHtmlPath(s.site);
    const dir = fileDir(s.site);
    if (!fs.existsSync(idxPath)) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fsp.writeFile(idxPath, buildIndexHtml(s.files), 'utf8');
      await fsp.writeFile(tokensCssPath(s.site), TOKENS_CSS, 'utf8');
    }
  }
  const html = buildNavHtml(sitesData);
  const fileRoot = path.join(process.cwd(), 'file');
  if (!fs.existsSync(fileRoot)) fs.mkdirSync(fileRoot, { recursive: true });
  await Promise.all([
    fsp.writeFile(navHtmlPath(), html, 'utf8'),
    fsp.writeFile(navTokensCssPath(), TOKENS_CSS, 'utf8'),
  ]);
  log(`已生成导航页：${navHtmlPath()}（${valid.length} 个站点）`, { event: 'nav_generated', context: { sites: valid.join(','), count: valid.length } });
  return { sitesData, html };
}

async function generateAllReports(sites) {
  const targets = sites && sites.length ? sites.map(normalizeSite) : listSites().filter(s => {
    try { require('./sites')[s] || require(`./sites/${s}`); return true; } catch { return false; }
  });
  // 仅对已实现的站点生成报告
  const { getSiteConfig } = require('./sites');
  const valid = [];
  for (const s of targets) {
    try { getSiteConfig(s); valid.push(s); } catch { /* 跳过未实现站点 */ }
  }
  await Promise.all(valid.map(s => generateReport(s)));
  // 同步生成总导航
  try {
    await generateNav(valid);
  } catch (e) {
    log(`生成导航页失败: ${e.message}`, { level: 'error', event: 'nav_failed', context: { error: e.message } });
  }
}

module.exports = { generateReport, generateAllReports, generateNav, buildNavHtml, collectSiteStats, siteMeta, navHtmlPath, navTokensCssPath, scanFiles, buildIndexHtml, buildDetailHtml, getReportWindow, parseFileDate, fileDir, TOKENS_CSS, COMMON_CSS, NAV_CSS };
