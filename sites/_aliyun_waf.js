// 阿里云 WAF acw 挑战识别与求解。
//
// 站点背景（2026-10 起）：干净出口 IP 首次请求 ceb 搜索页会收到 HTTP 200 的挑战页
// （`<textarea id="renderData">{"_waf_...":"..."}` + 混淆脚本），脚本以 URL 重写方式
// 把签名参数（如 `time__2652=...`）写回 `location.href`。不求解就重试，出口 IP 会被
// 打成 405 阻断页并冷却数十分钟。求解后带 `acw_tc` cookie 重放签名 URL 即可通过。
//
// 安全约束：挑战脚本来自外部站点，只在 vm 沙箱内执行——不暴露 require/process/fs/网络，
// 超时 5 秒。注意 vm 不是硬安全边界（Node 官方说明），这里用于防止脚本误触宿主能力，
// 不用于抵御恶意代码；启用站点必须显式声明 challenge 钩子（当前仅 ceb）。
const vm = require('vm');

const SOLVE_TIMEOUT_MS = 5000;

function safeString(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

// 200 + 盾页特征才算挑战；405 是阻断页，交回现有 405 流程处理。
function isChallenge(response) {
  if (!response || response.status !== 200) return false;
  const headers = response.headers || {};
  const punish = String(headers['punish-type'] || headers['Punish-Type'] || headers['punish-Type'] || '').toLowerCase();
  if (punish.includes('sigchl') || punish.includes('acw')) return true;
  const body = safeString(response.data);
  if (!body) return false;
  return body.includes('acw_sc__v2') || (body.includes('_waf_') && body.includes('renderData'));
}

function parseAcwTc(headers) {
  const raw = headers && (headers['set-cookie'] || headers['Set-Cookie']);
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const cookie of list) {
    const m = String(cookie).match(/(?:^|[;,\s])acw_tc=([^;,\s]+)/);
    if (m) return m[1];
  }
  return '';
}

function pickScript(html) {
  const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .sort((a, b) => b.length - a.length);
  return scripts[0] || '';
}

function extractRenderData(html) {
  const textarea = String(html).match(/<textarea[^>]*id=["']renderData["'][^>]*>([\s\S]*?)<\/textarea>/i);
  if (textarea) return textarea[1].trim();
  const inline = String(html).match(/["'](_waf_[^"']+)["']\s*:\s*["']([^"']+)["']/);
  return inline ? `{"${inline[1]}":"${inline[2]}"}` : '';
}

function makeAnchor(base) {
  const u = new URL(base || 'about:blank');
  return {
    get href() { return u.href; },
    set href(v) { try { u.href = v; } catch (_) {} },
    get protocol() { return u.protocol; },
    get host() { return u.host; },
    get hostname() { return u.hostname; },
    get port() { return u.port; },
    get pathname() { return u.pathname; },
    get search() { return u.search; },
    get hash() { return u.hash; },
  };
}

// 沙箱内定时器必须回收：vm 的 timeout 只约束同步执行，脚本若埋了 setInterval
// 会在求解返回后继续在宿主事件循环里空转，拖住整个爬虫进程。
function createSandboxTimers() {
  const pending = new Map();
  let disposed = false;
  const set = kind => (fn, ms, ...args) => {
    if (disposed || typeof fn !== 'function') return 0;
    const id = kind === 'interval'
      ? setInterval(() => fn(...args), ms)
      : setTimeout(() => { pending.delete(id); fn(...args); }, ms);
    pending.set(id, kind);
    return id;
  };
  const clear = kind => id => {
    pending.delete(id);
    if (kind === 'interval') clearInterval(id); else clearTimeout(id);
  };
  const dispose = () => {
    disposed = true;
    for (const [id, kind] of pending) {
      if (kind === 'interval') clearInterval(id); else clearTimeout(id);
    }
    pending.clear();
  };
  return {
    setTimeout: set('timeout'),
    setInterval: set('interval'),
    clearTimeout: clear('timeout'),
    clearInterval: clear('interval'),
    dispose,
  };
}

// 在沙箱内执行挑战脚本，返回 { url, acwSc }；拿不到签名则返回 null。
function runChallenge(script, url, renderData, acwTc) {
  let capturedUrl = null;
  let capturedAcw = null;
  const cookies = [];
  const timers = createSandboxTimers();

  const location = {
    _href: url,
    get href() { return this._href; },
    set href(v) { capturedUrl = v; this._href = v; },
    reload() {},
    replace(v) { capturedUrl = v; this._href = v; },
    assign(v) { capturedUrl = v; this._href = v; },
    toString() { return this._href; },
  };

  const document = {
    location,
    getElementById: (id) => (id === 'renderData'
      ? { value: renderData, innerHTML: renderData, textContent: renderData, innerText: renderData }
      : { value: '', innerHTML: '', textContent: '', innerText: '' }),
    createElement: () => ({
      _first: null,
      set innerHTML(_) { this._first = makeAnchor(url); },
      get innerHTML() { return '<a></a>'; },
      get firstChild() { return this._first || (this._first = makeAnchor(url)); },
      style: {},
      appendChild: () => {},
      setAttribute: () => {},
    }),
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { style: {}, getAttribute: () => null },
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
  };
  Object.defineProperty(document, 'cookie', {
    get() { return cookies.join('; '); },
    set(v) {
      const kv = String(v).split(';')[0].trim();
      if (kv.startsWith('acw_sc__v2=')) capturedAcw = kv.slice('acw_sc__v2='.length);
      cookies.push(kv);
    },
  });

  const noop = () => {};
  const window = {
    document,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    location,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
  const context = vm.createContext({
    window,
    document,
    navigator: window.navigator,
    location,
    console: { log: noop, error: noop, warn: noop, info: noop },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    Math, Date, RegExp, String, Number, Array, Object, JSON,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    escape, unescape, atob, btoa,
  });

  if (acwTc) document.cookie = `acw_tc=${acwTc}`;
  try {
    vm.runInContext(script, context, { timeout: SOLVE_TIMEOUT_MS });
    // 少数变体把逻辑挂在 window.onload 上；沙箱不会自动触发，这里补一次。
    if (typeof window.onload === 'function') window.onload();
  } catch (_) {
    return null;
  } finally {
    timers.dispose();
  }
  return { url: capturedUrl, acwSc: capturedAcw };
}

// 返回重放所需的 { url, headers }；求解失败返回 null。
function solve(response, url) {
  const html = safeString(response && response.data);
  const script = pickScript(html);
  if (!script || script.length < 100) return null;
  const acwTc = parseAcwTc(response.headers);
  const solved = runChallenge(script, url, extractRenderData(html), acwTc);
  if (!solved) return null;

  const cookie = [];
  if (acwTc) cookie.push(`acw_tc=${acwTc}`);

  if (solved.url && /^https?:\/\//i.test(solved.url)) {
    // URL 重写模式：签名在 URL 上，cookie 仍需带上 acw_tc。
    return {
      url: solved.url,
      headers: cookie.length ? { Cookie: cookie.join('; ') } : {},
    };
  }
  if (solved.acwSc) {
    // 旧 cookie 模式：签名写进 acw_sc__v2。
    cookie.push(`acw_sc__v2=${solved.acwSc}`);
    return { url, headers: { Cookie: cookie.join('; ') } };
  }
  return null;
}

module.exports = { isChallenge, parseAcwTc, solve, SOLVE_TIMEOUT_MS };
