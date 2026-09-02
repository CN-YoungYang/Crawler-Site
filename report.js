// HTML 报告生成：file/<site>/ 下生成轻量索引页 + 每日明细页。
// index.html：报头 + 统计带 + 日期索引。
// <date>.html：该日明细表（标题搜索 + 排序）。
// 展示层、尽力而为：坏文件跳过、目录不存在兜底、生成失败由 index.js 捕获不中断爬取。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const xlsx = require('xlsx');
const { log, pruneOldLogs } = require('./log');
const { normalizeSite } = require('./sites');
const { hasValidXlsxHeader } = require('./utils');

const RETENTION_DAYS = 30;
// 索引页「最新公告」预览条数：仅内联最新一天前 N 条（{title,link,area}），其余日期保持轻量不内联
const LATEST_PREVIEW_COUNT = 10;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileDir(site) {
  return path.join('file', normalizeSite(site));
}
function indexHtmlPath(site) {
  return path.join(fileDir(site), 'index.html');
}
function tokensCssPath(site) {
  return path.join(fileDir(site), 'tokens.css');
}
function commonCssPath(site) {
  return path.join(fileDir(site), 'common.css');
}
function navHtmlPath() {
  return path.join('file', 'index.html');
}
function navTokensCssPath() {
  return path.join('file', 'tokens.css');
}
function navCommonCssPath() {
  return path.join('file', 'common.css');
}
function navCssPath() {
  return path.join('file', 'nav.css');
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

function collectSiteStats(site, opts = {}) {
  const key = normalizeSite(site);
  const files = scanFiles(key, opts);
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
  if (!hasValidXlsxHeader(filePath)) {
    log(`读取 ${filePath} 失败，已跳过：不是有效的 xlsx（zip）文件`, { site: path.basename(path.dirname(filePath)) });
    return null;
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

const warnedMkdirDirs = new Set();
function scanFiles(site, opts = {}) {
  const siteName = site ? normalizeSite(site) : defaultSite();
  const dir = fileDir(siteName);
  const createIfMissing = opts.createDir !== false;
  if (!fs.existsSync(dir)) {
    if (!createIfMissing) return [];
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      const code = e.code || e.errno || 'UNKNOWN';
      if (!warnedMkdirDirs.has(dir)) {
        warnedMkdirDirs.add(dir);
        log(`创建报告目录失败 ${dir}: ${e.message} code=${code}（仅首次告警，后续静默避免刷屏；请在宿主机执行 chown -R 1000:1000 file）`, { level: 'warn', event: 'report_mkdir_failed', context: { site: siteName, dir, error: e.message, code }, site: siteName });
      }
      return [];
    }
    return [];
  }

  const { start, end } = getReportWindow();
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dir);
  } catch (e) {
    const code = e.code || e.errno || 'UNKNOWN';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      log(`读取报告目录失败 ${dir}: ${e.message} code=${code}，已跳过`, { level: 'warn', event: 'report_readdir_failed', context: { site: siteName, dir, error: e.message, code }, site: siteName });
      return [];
    }
    throw e;
  }
  const entries = dirEntries
    .filter(fileName => fileName.endsWith('.xlsx'))
    .map(fileName => {
      const fileDate = parseFileDate(fileName);
      if (!fileDate) return null;

      const filePath = path.join(dir, fileName);
      if (fileDate < start) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          const code = e.code || e.errno || 'UNKNOWN';
          log(`清理过期文件失败 ${fileName}: ${e.message} code=${code}`, { level: 'warn', event: 'report_prune_failed', context: { site: siteName, file: fileName, error: e.message, code }, site: siteName });
          return null;
        }
        const detailPath = path.join(dir, `${fileName.replace(/\.xlsx$/, '')}.html`);
        if (fs.existsSync(detailPath)) {
          try { fs.unlinkSync(detailPath); } catch (e) {
            const code = e.code || e.errno || 'UNKNOWN';
            log(`清理过期明细页失败 ${detailPath}: ${e.message} code=${code}`, { level: 'warn', event: 'report_prune_detail_failed', context: { site: siteName, file: detailPath, error: e.message, code }, site: siteName });
          }
        }
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
  --fg-faint: #7a7670;

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
    --fg-faint: #a1a1aa;

    --border: #27272a;
    --border-strong: #3f3f46;

    --accent: #e86a33;
    --accent-hover: #ff7d45;
    --accent-soft: rgba(232, 106, 51, 0.13);
    --accent-line: #e86a33;
  }
}
`;

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

const COMMON_CSS = normalizeEol(fs.readFileSync(path.join(__dirname, 'assets/common.css'), 'utf8'));

const NAV_CSS = normalizeEol(fs.readFileSync(path.join(__dirname, 'assets/nav.css'), 'utf8'));

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
<link rel="stylesheet" href="common.css">
<link rel="stylesheet" href="nav.css">
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
  // 跨全部日期取最新 N 条（files 按日期降序，逐日累加至取满），索引页保持轻量
  const previewRows = [];
  for (const f of files) {
    for (const r of f.rows) {
      if (previewRows.length >= LATEST_PREVIEW_COUNT) break;
      previewRows.push({ title: r.title || '', link: r.link || '', area: r.area || '', date: f.date });
    }
    if (previewRows.length >= LATEST_PREVIEW_COUNT) break;
  }
  const newestDate = previewRows.length ? previewRows[0].date : null;
  const previewJson = inlineJson({ newestDate, rows: previewRows });
  const filterHidden = totalDates ? '' : ' hidden';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>招标公告数据索引</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="common.css">
</head>
<body>
<div class="container">
  <nav class="top-nav">
    <a class="nav-link" href="../index.html">← 返回导航</a>
  </nav>

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

  <div id="latest-section"${filterHidden}>
    <div class="filter-header">
      <div><h2 class="section-title">最新公告</h2><p class="section-note" id="latest-note">最新 ${LATEST_PREVIEW_COUNT} 条公告</p></div>
      <a id="latest-more" class="btn-secondary latest-more-link" href="#">查看全部 →</a>
    </div>
    <div id="latest-list" class="table-container"></div>
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
    document.getElementById('latest-section').hidden = true;
    content.innerHTML = '<div class="empty-state"><strong>暂无数据</strong><p>完成首次爬取后，这里将显示日期列表。</p></div>';
  } else {
    // 最新公告预览：跨全部日期取最新的前 N 条（生成时内联）
    var preview = ${previewJson};
    (function() {
      var section = document.getElementById('latest-section');
      if (!preview.rows.length) { section.hidden = true; return; }
      var noteEl = document.getElementById('latest-note');
      var moreEl = document.getElementById('latest-more');
      var listEl = document.getElementById('latest-list');
      noteEl.textContent = '最新 ' + preview.rows.length.toLocaleString('zh-CN') + ' 条公告';
      moreEl.href = preview.newestDate + '.html';
      var table = document.createElement('table');
      table.className = 'data-table detail-table';
      var thead = document.createElement('thead');
      var headTr = document.createElement('tr');
      ['标题', '地区', '日期'].forEach(function(label) {
        var th = document.createElement('th');
        th.scope = 'col';
        th.textContent = label;
        headTr.appendChild(th);
      });
      thead.appendChild(headTr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      preview.rows.forEach(function(r) {
        var tr = document.createElement('tr');
        var tdTitle = document.createElement('td');
        tdTitle.className = 'cell-wrap';
        if (r.link && (r.link.indexOf('http://') === 0 || r.link.indexOf('https://') === 0)) {
          var a = document.createElement('a');
          a.href = r.link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = r.title || '未命名公告';
          a.title = r.title || '未命名公告';
          tdTitle.appendChild(a);
        } else {
          tdTitle.textContent = r.title || '未命名公告';
        }
        tr.appendChild(tdTitle);
        var tdArea = document.createElement('td');
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = r.area || '未知';
        badge.title = r.area || '未知';
        tdArea.appendChild(badge);
        tr.appendChild(tdArea);
        var tdDate = document.createElement('td');
        tdDate.className = 'cell-mono';
        tdDate.textContent = r.date;
        tr.appendChild(tdDate);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      listEl.appendChild(table);
    })();

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
<link rel="stylesheet" href="common.css">
</head>
<body>
<div class="container">
  <nav class="top-nav">
    <a class="nav-link" href="index.html">← 返回索引</a>
    <a class="nav-link" href="../index.html">导航页</a>
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
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const code = e.code || e.errno || 'UNKNOWN';
    log(`创建报告目录失败 ${dir}: ${e.message} code=${code}，跳过报告生成`, { level: 'error', event: 'report_mkdir_failed', context: { site: siteName, dir, error: e.message, code }, site: siteName });
    throw e;
  }
  await Promise.all([
    fsp.writeFile(indexHtmlPath(siteName), buildIndexHtml(files), 'utf8'),
    fsp.writeFile(tokensCssPath(siteName), TOKENS_CSS, 'utf8'),
    fsp.writeFile(commonCssPath(siteName), COMMON_CSS, 'utf8'),
    ...files.map(f => fsp.writeFile(path.join(dir, `${f.date}.html`), buildDetailHtml(f), 'utf8'))
  ]);
  log(`已生成报告 [${siteName}]：索引 ${indexHtmlPath(siteName)} + ${files.length} 个明细页（${files.reduce((n, f) => n + f.rows.length, 0)} 条记录）`, { event: 'report_generated', context: { site: siteName, files: files.length, records: files.reduce((n, f) => n + f.rows.length, 0) }, site: siteName });
}

async function generateNav(sites) {
  let targets;
  if (sites && sites.length) {
    targets = sites.map(normalizeSite);
  } else {
    try {
      const { parseSitesList } = require('./sites');
      const envSites = parseSitesList();
      targets = envSites.length ? envSites : require('./sites').listEnabledSites();
    } catch (_) {
      targets = require('./sites').listEnabledSites();
    }
  }
  const { getSiteConfig } = require('./sites');
  const valid = [];
  for (const s of targets) {
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
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        const code = e.code || e.errno || 'UNKNOWN';
        log(`创建站点目录失败 ${dir}: ${e.message} code=${code}，跳过占位报告`, { level: 'warn', event: 'nav_mkdir_site_failed', context: { site: s.site, dir, error: e.message, code } });
        continue;
      }
      try {
        await fsp.writeFile(idxPath, buildIndexHtml(s.files), 'utf8');
        await fsp.writeFile(tokensCssPath(s.site), TOKENS_CSS, 'utf8');
        await fsp.writeFile(commonCssPath(s.site), COMMON_CSS, 'utf8');
      } catch (e) {
        const code = e.code || e.errno || 'UNKNOWN';
        log(`写入占位报告失败 [${s.site}]: ${e.message} code=${code}`, { level: 'warn', event: 'nav_write_placeholder_failed', context: { site: s.site, error: e.message, code } });
      }
    }
  }
  const html = buildNavHtml(sitesData);
  const fileRoot = path.join(process.cwd(), 'file');
  try {
    if (!fs.existsSync(fileRoot)) fs.mkdirSync(fileRoot, { recursive: true });
  } catch (e) {
    const code = e.code || e.errno || 'UNKNOWN';
    log(`创建导航根目录失败 ${fileRoot}: ${e.message} code=${code}`, { level: 'error', event: 'nav_mkdir_root_failed', context: { error: e.message, code } });
    throw e;
  }
  await Promise.all([
    fsp.writeFile(navHtmlPath(), html, 'utf8'),
    fsp.writeFile(navTokensCssPath(), TOKENS_CSS, 'utf8'),
    fsp.writeFile(navCommonCssPath(), COMMON_CSS, 'utf8'),
    fsp.writeFile(navCssPath(), NAV_CSS, 'utf8'),
  ]);
  log(`已生成导航页：${navHtmlPath()}（${valid.length} 个站点）`, { event: 'nav_generated', context: { sites: valid.join(','), count: valid.length } });
  return { sitesData, html };
}

module.exports = { generateReport, generateNav, buildNavHtml, collectSiteStats, siteMeta, navHtmlPath, navTokensCssPath, scanFiles, buildIndexHtml, buildDetailHtml, getReportWindow, parseFileDate, fileDir, TOKENS_CSS, COMMON_CSS, NAV_CSS, LATEST_PREVIEW_COUNT };
