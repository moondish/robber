// rob.js — 选课抢课独立工具主流程
//
// 流程：载入配置/模板/会话 → （无会话则）弹出浏览器手动登录+网络层抓模板 →
// 保存会话 → 用纯 HTTP 请求（带 JSESSIONID/route cookie）跑抢课循环。
//
// 安全约束（用户确认）：绝不自动登录（登录偶发验证码，用户人手处理）；
// 冲突自动退选仅限 kklxdm=10 且 rwlx=2 的可退选修课，其余只告警不动手。
'use strict';
var fs = require('fs');
var path = require('path');
var playwright = null;
function getPlaywright() {
  if (!playwright) {
    try { playwright = require('playwright'); }
    catch (e) {
      console.error('缺少依赖 playwright。请在 grabber 目录运行: npm install');
      process.exit(1);
    }
  }
  return playwright;
}

var configLib = require('./lib/config');
var supervisor = require('./lib/supervisor');
var notifyMod = require('./lib/notify');
var params = require('./lib/params');
var matchLib = require('./lib/match');
var conflictLib = require('./lib/conflict');
var apiLib = require('./lib/api');
var captureLib = require('./lib/capture');

function parseCli(argv) {
  var out = {
    capture: false,
    har: null,
    help: false,
    listAccounts: false,
    prepare: false,
    forceLogin: false,
    debug: false,
    sso: null,
    dryRun: null,
    deleteAll: false,
    invalidArgs: [],
    account: null,
    configFile: null
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--capture' || a === '--capture-only') out.capture = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list-accounts') out.listAccounts = true;
    else if (a === '--prepare') out.prepare = true;
    else if (a === '--force-login') out.forceLogin = true;
    else if (a === '--debug' || a === '--verbose' || a === '-d') out.debug = true;
    else if (a === '--dryrun') {
      out.dryRun = true;
      if (argv[i + 1] && /^(true|false)$/i.test(argv[i + 1])) {
        out.invalidArgs.push(a + ' ' + argv[++i]);
      }
    }
    else if (a === '--prewarm' || a === '--dry-run' || /^--dry-?run=/.test(a) ||
      a === '--no-dryrun' || a === '--no-dry-run') {
      out.invalidArgs.push(a);
    }
    else if (a === '--delete' || a === '--delte') out.deleteAll = true;
    else if (a === '--sso') {
      var ssoValue = argv[i + 1];
      if (ssoValue && ssoValue.charAt(0) !== '-') {
        out.sso = ssoValue;
        i++;
      } else {
        out.sso = 'wengine';
      }
    }
    else if (a.indexOf('--sso=') === 0) out.sso = a.slice('--sso='.length);
    else if (a === '--account') out.account = argv[++i] || '';
    else if (a.indexOf('--account=') === 0) out.account = a.slice('--account='.length);
    else if (a === '--config') out.configFile = argv[++i] || '';
    else if (a.indexOf('--config=') === 0) out.configFile = a.slice('--config='.length);
    else if (a === '--import-har') out.har = argv[++i] || '';
    else if (a.indexOf('--import-har=') === 0) out.har = a.slice('--import-har='.length);
  }
  return out;
}

function normaliseSsoMode(value) {
  var v = String(value || '').trim().toLowerCase();
  if (!v) throw new Error('--sso 需要指定 zfsoft 或 wengine');
  if (v === 'zfsoft' || v === 'zf' || v === 'native' || v === '正方') return 'zfsoft';
  if (v === 'wengine' || v === 'proxy' || v === 'reverse' || v === '反代') return 'wengine';
  throw new Error('--sso 仅支持 zfsoft 或 wengine: ' + value);
}

function deleteAllGeneratedData() {
  var targets = [
    { label: '默认配置', file: path.join(__dirname, 'config', 'config.json') },
    { label: '会话与模板目录', file: path.join(__dirname, 'state') },
    { label: '日志目录', file: path.join(__dirname, 'logs') },
    { label: '旧版根配置', file: path.join(__dirname, 'config.json') },
    { label: '旧版根会话', file: path.join(__dirname, 'state.json') },
    { label: '旧版根模板', file: path.join(__dirname, 'templates.json') },
    { label: '旧版根日志', file: path.join(__dirname, 'grab.log') },
    { label: '旧版根调试日志', file: path.join(__dirname, 'grab.debug.log') }
  ];
  var removed = 0;
  var failed = 0;
  targets.forEach(function (target) {
    if (!fs.existsSync(target.file)) {
      console.log('跳过（不存在）: ' + target.file);
      return;
    }
    try {
      fs.rmSync(target.file, { recursive: true, force: true });
      removed++;
      console.log('已删除' + target.label + ': ' + target.file);
    } catch (e) {
      failed++;
      console.error('删除失败' + target.label + ': ' + target.file + ' - ' + e.message);
    }
  });
  console.log(failed ? ('清理未完成，失败 ' + failed + ' 项') : ('清理完成，共删除 ' + removed + ' 项'));
  return failed ? 1 : 0;
}

var cli = parseCli(process.argv.slice(2));
if (cli.invalidArgs.length) {
  console.error('已移除以下参数: ' + cli.invalidArgs.join(', ') +
    '。干跑请使用 --dryrun，实跑直接运行 node rob.js。');
  process.exit(1);
}
var defaultConfig = fs.existsSync(path.join(__dirname, 'config', 'config.json'))
  ? path.join('config', 'config.json')
  : 'config.json';

if (cli.deleteAll) {
  var conflicts = process.argv.slice(2).filter(function (arg) {
    return arg !== '--delete' && arg !== '--delte';
  });
  if (conflicts.length) {
    console.error('--delete 必须单独使用，不能与以下参数同时出现: ' + conflicts.join(', '));
    process.exit(1);
  }
  process.exit(deleteAllGeneratedData());
}

var configFile = configLib.resolvePath(cli.configFile || defaultConfig, __dirname);
var resolved;
try {
  resolved = configLib.resolveConfig(configLib.loadRaw(configFile));
} catch (e) {
  console.error('无法读取/解析 ' + configFile + ': ' + e.message);
  process.exit(1);
}

if (cli.sso) {
  try {
    cli.sso = normaliseSsoMode(cli.sso);
    resolved.accounts.forEach(function (account) {
      account.authMode = cli.sso;
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
if (cli.help) {
  printHelp();
  process.exit(0);
}
if (cli.listAccounts) {
  printAccounts(resolved);
  process.exit(0);
}
if (resolved.mode === 'multi' && !cli.account && (cli.capture || cli.har)) {
  console.error('多账号模式请用 --account <id> 指定要抓包/导入的账号');
  printAccounts(resolved);
  process.exit(1);
}

// 多账号配置未指定 --account 时，由父进程做并发调度。
var runAsSupervisor = resolved.mode === 'multi' && !cli.account && !cli.har && !cli.capture;
var cfg = null;
if (!runAsSupervisor) {
  cfg = cli.account ? resolved.byId[cli.account] : resolved.accounts[0];
  if (!cfg) {
    console.error('找不到账号: ' + (cli.account || '(default)'));
    printAccounts(resolved);
    process.exit(1);
  }
}

var logger = cfg ? notifyMod.makeLogger(cfg) : null;
var log = logger ? logger.log : function () {};
var notify = logger ? logger.notify : function () {};
var beep = notifyMod.beep;
var debug = require('./lib/debug').create(cfg || {}, {
  enabled: !!(cfg && (cli.debug || cfg.debug)),
  baseDir: __dirname
});
if (debug.enabled) log('调试日志: ' + debug.file, 'info');

var templates = {
  ctx: null,
  display: null,
  query: null,
  detail: null,
  submit: null,
  drop: null,
  choosed: null,
  xkkz: null,
  api: {},
  meta: {},
  responses: {},
  warnings: []
};
var state = cfg ? {
  targets: [],
  njdm: [],      // 年级过滤（来自 targets.njdm_id）
  querying: false,
  dryRun: !!cli.dryRun,
  interval: cfg.intervalSec >= 1 ? cfg.intervalSec : 2.5,
  kklxdm: String(cfg.kklxdm || '10'),
  succeeded: false,
  claim: {},      // kch -> true（已抢成，永久停）
  cooldown: {}    // kch -> 时间戳（冷却到点后再试）
} : null;

function SessionError(message) { this.name = 'SessionError'; this.message = message || '会话失效'; }
SessionError.prototype = Object.create(Error.prototype);
SessionError.prototype.constructor = SessionError;

function NotPreparedError(message) { this.name = 'NotPreparedError'; this.message = message || '尚未准备登录会话'; }
NotPreparedError.prototype = Object.create(Error.prototype);
NotPreparedError.prototype.constructor = NotPreparedError;

function NoClassError(message) { this.name = 'NoClassError'; this.message = message || '无可用教学班'; }
NoClassError.prototype = Object.create(Error.prototype);
NoClassError.prototype.constructor = NoClassError;

/* ---------------------------- 配置/状态读写 ---------------------------- */

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(configLib.resolvePath(file, __dirname), 'utf8')); } catch (e) { return null; }
}

function saveJson(file, obj, secure) {
  try {
    var full = configLib.resolvePath(file, __dirname);
    configLib.ensureParent(full);
    fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');
    if (secure) {
      try { fs.chmodSync(full, 0o600); } catch (e) {}
    }
  } catch (e) {
    if (log) log('写入文件失败: ' + file + ' - ' + e.message, 'warn');
  }
}

var sessionCaptured = false;
async function saveSession(context, statePath, reason) {
  if (sessionCaptured) return false;
  try {
    var state = await context.storageState();
    var cookies = state && Array.isArray(state.cookies) ? state.cookies : [];
    if (!cookies.length) return false;

    configLib.ensureParent(statePath);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    try { fs.chmodSync(statePath, 0o600); } catch (e) {}
    sessionCaptured = true;
    var names = cookies.map(function (c) { return c.name; }).filter(function (v, i, all) {
      return v && all.indexOf(v) === i;
    });
    log('✓ 登录会话已保存一次: ' + statePath + ' (' + cookies.length + ' 个 Cookie: ' + names.join(', ') + ')' +
      (reason ? ' [' + reason + ']' : ''), 'ok');
    return true;
  } catch (e) {
    log('保存登录会话失败: ' + e.message, 'warn');
    return false;
  }
}

function saveTemplates() {
  var out = params.deepCopy(templates);
  delete out.pendingRequests;
  delete out.warnings;
  saveJson(cfg.templatesFile || path.join('state', 'templates.json'), out, true);
}

function hasCapturedTemplates() {
  var learned = Object.keys(templates.api || {}).some(function (k) { return k !== 'index'; });
  return !!(templates.ctx || templates.query || templates.detail || templates.submit || templates.drop || learned);
}

function loadState() { return loadJson(cfg.stateFile || path.join('state', 'state.json')); }

// indexPath 在旧配置里指选课首页；有些学校把登录入口放在门户页，
// 这时用 loginPath 登录，登录后再跳到 selectionPath。
function selectionPath() {
  if (cfg.selectionPath) return cfg.selectionPath;
  if (cfg.api && cfg.api.index) return cfg.api.index;
  if (cfg.indexPath && apiLib.isSelectionPath(cfg.indexPath)) return cfg.indexPath;
  if (templates.api && templates.api.index && apiLib.isSelectionPath(templates.api.index)) return templates.api.index;
  return apiLib.DEFAULTS.index;
}

function loginPath() {
  var mode = String(cfg.authMode || '').toLowerCase();
  if (mode === 'zfsoft') {
    return cfg.zfsoftLoginPath || '/xtgl/login_slogin.html';
  }
  if (cfg.ssoPath) return cfg.ssoPath;
  if (cfg.loginPath) return cfg.loginPath;
  // WEngine 反代不能回退到选课首页，否则会直接触发正方二段登录。
  if (mode === 'wengine') {
    try { return new URL(cfg.base).origin + '/sso/lyiotlogin'; } catch (e) { return '/sso/lyiotlogin'; }
  }
  return cfg.loginPath || cfg.indexPath || selectionPath();
}

function pageUrl(p, addLayout) {
  var url = apiLib.resolveUrl(cfg.base, p);
  if (addLayout === false) return url;
  url = apiLib.withGnmkdm(url, cfg.gnmkdm, cfg.appendGnmkdm);
  if (!/[?&]layout=/.test(url)) url += (url.indexOf('?') < 0 ? '?' : '&') + 'layout=default';
  return url;
}

function refererUrl() {
  return pageUrl(selectionPath());
}

function loginUrl() {
  return apiLib.resolveUrl(cfg.base, loginPath());
}

function ssoUrl() {
  var pathValue = cfg.ssoPath || cfg.loginPath;
  if (!pathValue && String(cfg.authMode || '').toLowerCase() === 'wengine') {
    try { pathValue = new URL(cfg.base).origin + '/sso/lyiotlogin'; } catch (e) { pathValue = '/sso/lyiotlogin'; }
  }
  return pathValue ? apiLib.resolveUrl(cfg.base, pathValue) : '';
}

function selectionUrl() {
  return pageUrl(selectionPath());
}

function originUrl() {
  try { return new URL(cfg.base).origin; } catch (e) { return cfg.base; }
}

// 请求头优先级：默认 < config.headers < 抓包时看到的安全头（不含 Cookie）。
// Content-Type 交给 Playwright 的 form/json 选项生成，避免重复。
function apiHeaders(key) {
  var headers = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originUrl(),
    'Referer': refererUrl()
  };
  if (cfg.headers && typeof cfg.headers === 'object') {
    Object.keys(cfg.headers).forEach(function (k) {
      var lk = String(k).toLowerCase();
      if (lk === 'content-type' || lk === 'content-length' || lk === 'cookie' || lk === 'host') return;
      headers[k] = String(cfg.headers[k]);
    });
  }
  var meta = key && templates.meta && templates.meta[key];
  if (meta && meta.headers) {
    ['accept', 'x-requested-with', 'x-csrf-token', 'x-token'].forEach(function (k) {
      if (meta.headers[k]) headers[k] = meta.headers[k];
    });
  }
  return headers;
}

// 用会话 cookie 建一个独立的请求上下文（抢课循环走纯 HTTP，不依赖页面）
// 用 storageState 选项加载 state.json 的 cookie（APIRequestContext 无 addCookies）
async function makeRequestContext() {
  var opts = { extraHTTPHeaders: apiHeaders() };
  var st = loadState();
  if (st && Array.isArray(st.cookies) && st.cookies.length) {
    opts.storageState = configLib.resolvePath(cfg.stateFile || path.join('state', 'state.json'), __dirname);
  }
  return await getPlaywright().request.newContext(opts);
}

/* ---------------------------- 请求与响应解析 ---------------------------- */

function parseRes(text) {
  var t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return t; }
}

// endpoint 可以是 'query'/'detail'/'submit' 这类逻辑名，也可以是 /xsxk/xxx.html
// 这种显式路径（兼容旧调用），还可以是完整 URL。
function endpointUrl(endpoint) {
  var key = String(endpoint || '');
  if (apiLib.KEYS.indexOf(key) > -1) key = apiLib.endpointPath(cfg, key, templates);
  return apiLib.withGnmkdm(apiLib.resolveUrl(cfg.base, key), cfg.gnmkdm, cfg.appendGnmkdm);
}

async function apiPost(rc, endpoint, obj, opts) {
  var key = String(endpoint || '');
  var url = endpointUrl(key);
  var meta = templates.meta && templates.meta[key];
  var headers = apiHeaders(key);
  var timeout = Math.max(1000, Number(cfg.requestTimeoutSec || 30) * 1000);
  var res;
  var method = String((meta && meta.method) || 'POST').toUpperCase();

  if (method === 'GET') {
    res = await rc.get(url, { headers: headers, params: params.flatten(obj || {}), timeout: timeout });
  } else if (meta && /json/i.test(meta.contentType || '')) {
    res = await rc.post(url, { headers: headers, data: obj || {}, timeout: timeout });
  } else {
    res = await rc.post(url, { headers: headers, form: params.flatten(obj || {}), timeout: timeout });
  }
  var status = res.status();
  var text = await res.text();
  if (status < 200 || status >= 300) throw new Error('HTTP ' + status);
  var t = String(text || '').trim();
  if (t.charAt(0) === '<') {
    if (/系统升级维护中|系统维护页面/i.test(t)) {
      throw new Error('教务系统维护中或当前不在选课时间（返回维护页面）');
    }
    var looksLikeLogin = /<title[^>]*>[^<]*(登录|login)/i.test(t) ||
      /name=["'](yhm|mm)["']/i.test(t) || /id=["'](yhm|mm)["']/i.test(t) ||
      /login_slogin/i.test(t) || /非法访问|请先登录|未登录/.test(t);
    if (looksLikeLogin) throw new SessionError('收到登录页 HTML（会话已过期）');
    if (opts && opts.allowHtml) return { __html: t };
    var tail = t.length > 120 ? t.slice(0, 120).replace(/\s+/g, ' ') : t;
    throw new SessionError('收到HTML响应（可能登录失效/会话过期），长度' + t.length + '，开头: ' + tail);
  }
  var parsed = parseRes(t);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    var code = String(parsed.code != null ? parsed.code : (parsed.statusCode != null ? parsed.statusCode : (parsed.status != null ? parsed.status : '')));
    var apiMsg = String(parsed.msg || parsed.message || '');
    if (code === '901' || code === '910' || /用户登录|请先登录|未登录/.test(apiMsg)) {
      throw new SessionError('接口返回会话失效' + (code ? '（' + code + '）' : ''));
    }
  }
  return parsed;
}

/* ---------------------------- 模板采集（网络层） ---------------------------- */

var captureNotified = {};
var selectionNavigated = false;
var selectionRetryAt = 0;
var ssoAttempts = 0;
var ssoRetryAt = 0;
function attachCapture(page) {
  captureLib.attach(page, templates, {
    base: cfg.base,
    onEvent: function (ev) {
      var kind = ev.kind;
      if (!kind) return;
      if (ev.learned) {
        log('✓ 接口已识别: ' + kind + ' -> ' + ev.learned, 'ok');
      }
      var flag = ev.type + ':' + kind;
      if (captureNotified[flag]) return;
      captureNotified[flag] = true;
      if (kind === 'query') log('✓ 查询模板已采集', 'ok');
      if (kind === 'detail') log('✓ 教学班详情模板已采集', 'ok');
      if (kind === 'submit') log('✓ 提交模板已采集（真实选课参数）', 'ok');
      if (kind === 'drop') log('✓ 退选模板已采集', 'ok');
      if (kind === 'title') log('✓ 前置探针模板已采集', 'ok');
      if (kind === 'batch') log('✓ 批次刷新模板已采集', 'ok');
      if (templates.ctx && !captureNotified.ctx) {
        captureNotified.ctx = true;
        log('✓ 上下文 ctx 已采集', 'ok');
      }
      if (templates.xkkz && !captureNotified.xkkz) {
        captureNotified.xkkz = true;
        log('✓ xkkz_id 已采集', 'ok');
      }
    }
  });
}

function waitForEnter(promptText) {
  return new Promise(function (resolve) {
    if (!process.stdin || !process.stdin.isTTY) {
      setTimeout(resolve, 30000);
      return;
    }
    process.stdout.write(promptText || '按 Enter 继续… ');
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', function () {
      process.stdin.pause();
      resolve();
    });
  });
}

function printCaptureSummary() {
  var s = captureLib.summary(templates);
  log('接口映射: ' + JSON.stringify(s.api || {}), 'info');
  if (s.missing.length) {
    log('尚未采集: ' + s.missing.join(', ') + '（已有接口照常工作；提交/退选会使用兜底参数）', 'warn');
  }
}

function attachDebug(page) {
  if (!debug.enabled) return;
  page.on('framenavigated', function (frame) {
    debug.log('navigate', {
      url: frame.url(),
      main: frame === page.mainFrame(),
      name: frame.name()
    });
  });
  page.on('console', function (msg) {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      debug.log('console', { type: msg.type(), text: String(msg.text() || '').slice(0, 800) });
    }
  });
  page.on('pageerror', function (e) {
    debug.log('pageerror', { message: e.message, stack: String(e.stack || '').slice(0, 1200) });
  });
  page.on('requestfailed', function (req) {
    debug.log('requestfailed', {
      url: req.url(),
      method: req.method(),
      failure: req.failure()
    });
  });
  page.on('response', function (res) {
    var url = res.url();
    if (res.status() >= 300 || /webauth|wengine|login|cas|auth/i.test(url)) {
      debug.log('response', {
        url: url,
        status: res.status(),
        location: res.headers()['location'] || ''
      });
    }
  });
}

// 某些反代会把静态资源改写成：
//   https://webauth.../wengine-auth/login?...&from=https://jwglxt.../login.js
// 导致 CSP 把 JS 当成 HTML 拦截。这里只把静态资源还原到原始 jwglxt 地址。
function installProxyAssetRewrite(context) {
  if (cfg.rewriteProxyAssets === false) return;
  var attempted = {};
  context.route('**/wengine-auth/login**', function (route) {
    var req = route.request();
    var from = '';
    try {
      from = new URL(req.url()).searchParams.get('from') || '';
    } catch (e) {}
    var isAsset = /^https?:\/\/[^/]+\/jwglxt\//i.test(from) &&
      /\.(js|css|png|jpe?g|gif|woff2?|svg|ico)(\?|$)/i.test(from);
    if (!isAsset || attempted[from]) return route.continue();
    attempted[from] = true;
    debug.log('proxy-asset-rewrite', { from: req.url(), to: from });
    return route.continue({ url: from });
  });
}

async function logFormInventory(page, label) {
  if (!debug.enabled) return;
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    try {
      var info = await frame.evaluate(function () {
        function visible(el) {
          return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        }
        var fields = [];
        var nodes = document.querySelectorAll('input, button, a');
        for (var i = 0; i < nodes.length && fields.length < 60; i++) {
          var el = nodes[i];
          fields.push({
            tag: el.tagName,
            type: el.type || '',
            id: el.id || '',
            name: el.getAttribute('name') || '',
            text: el.tagName === 'INPUT' ? '' : String(el.textContent || '').slice(0, 60),
            visible: visible(el)
          });
        }
        return {
          url: location.href,
          title: document.title || '',
          readyState: document.readyState,
          body: String(document.body ? document.body.innerText : '').slice(0, 1200),
          fields: fields
        };
      });
      debug.log('form-inventory ' + label, { frame: frame.url(), name: frame.name(), info: info });
    } catch (e) {
      debug.log('form-inventory ' + label, { frame: frame.url(), error: e.message });
    }
  }
}

async function pageSnapshot(page) {
  var frames = [];
  var list = page.frames();
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var info;
    try {
      info = await f.evaluate(function () {
        return {
          url: location.href,
          title: document.title || '',
          readyState: document.readyState,
          hasPassword: !!document.querySelector('input[type="password"]'),
          qr: !!document.querySelector('#qrcode, .qrcode, canvas.qrcode, img[src*="qr"]'),
          text: String(document.body ? document.body.innerText : '').slice(0, 1500)
        };
      });
    } catch (e) {
      info = { url: f.url(), error: e.message };
    }
    info.name = f.name();
    frames.push(info);
  }
  var cookies = [];
  try {
    cookies = (await page.context().cookies()).map(function (c) {
      return { name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure };
    });
  } catch (e) {}
  return { pageUrl: page.url(), frames: frames, jar: cookies };
}

// 用 config 里 login.username/password 预填登录表单。
// 正方登录框常见选择器：#yhm 用户名 / #mm 密码 / #dl 登录按钮；有验证码(#yzm)则停手等用户补。
async function findFormFrame(page) {
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    try {
      var probe = await frame.evaluate(function () {
        function visible(el) {
          return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        }
        return {
          hasPassword: visible(document.querySelector('input[type="password"]')),
          username: visible(document.querySelector('#username, #yhm, #un, input[name="username"], input[name*="yhm"]')),
          login: visible(document.querySelector('#login, #dl, button[type="submit"], input[type="submit"]'))
        };
      });
      debug.log('frame-probe', { url: frame.url(), name: frame.name(), probe: probe });
      if (probe.hasPassword || probe.username || probe.login) return frame;
    } catch (e) {
      debug.log('frame-probe', { url: frame.url(), name: frame.name(), error: e.message });
    }
  }
  return null;
}

async function waitForFormFrame(page, timeoutMs) {
  var deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    var frame = await findFormFrame(page);
    if (frame) return frame;
    if (Date.now() >= deadline) break;
    await params.sleep(500);
  } while (Date.now() < deadline);
  return null;
}

var loginHandledUrl = null;
var loginWaitNotice = {};
async function handleLoginPage(page) {
  var url = page.url();
  if (!apiLib.isLoginUrl(url)) return false;
  if (loginHandledUrl === url) return false;
  await logFormInventory(page, 'login-page');
  var frame = await findFormFrame(page);
  if (!frame) {
    // 页面可能还在加载资源。不要在这里写 loginHandledUrl，否则表单稍后出现时永远不再重试。
    if (!loginWaitNotice[url]) {
      loginWaitNotice[url] = true;
      log('登录页表单尚未出现，继续等待页面资源加载: ' + url, 'info');
    }
    return false;
  }
  loginHandledUrl = url;
  if (cfg.login && (cfg.login.username || cfg.login.password)) {
    log('检测到登录表单，尝试自动填充: ' + url, 'info');
    await autoFillLogin(page);
  } else {
    log('检测到登录页，请手动完成登录: ' + url, 'warn');
  }
  return true;
}

async function autoFillLogin(page) {
  var user = cfg.login && cfg.login.username;
  var pass = cfg.login && cfg.login.password;
  if (!user && !pass) {
    log('登录页: ' + page.url(), 'info');
    return;
  }
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(function () {});
    log('登录页: ' + page.url(), 'info');
    await logFormInventory(page, 'before-fill');
    var frame = await waitForFormFrame(page, 1500);
    if (!frame) {
      // CAS 默认可能是扫码页，先尝试切到账号/密码登录。
      var switched = false;
      try {
        switched = await page.evaluate(function () {
          var els = document.querySelectorAll('a, button, div, span');
          for (var i = 0; i < els.length; i++) {
            var txt = (els[i].textContent || '') + '';
            if (/返回账号登录|账号登录|密码登录|切换账号登录/.test(txt)) {
              els[i].click();
              return true;
            }
          }
          return false;
        });
      } catch (e) {}
      if (switched) {
        log('已尝试切换到账号/密码登录', 'info');
        frame = await waitForFormFrame(page, 5000);
      }
    }
    if (!frame) {
      log('没有找到可填写的登录表单，请手动完成登录', 'warn');
      return;
    }
    loginHandledUrl = page.url();
    debug.log('login-form-frame', { url: frame.url(), name: frame.name() });
    var filled = await frame.evaluate(function (args) {
      var u = args.u;
      var p = args.p;
      function find(selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return el;
        }
        return null;
      }
      function setVal(el, v) {
        el.value = v;
        try {
          var evt = document.createEvent('HTMLEvents');
          evt.initEvent('input', true, true);
          el.dispatchEvent(evt);
          var chg = document.createEvent('HTMLEvents');
          chg.initEvent('change', true, true);
          el.dispatchEvent(chg);
        } catch (e) {}
      }
      var un = find([
        '#yhm', '#username', '#un', 'input[name*="yhm"]', 'input[name="username"]',
        'input[name="userName"]', 'input[name="account"]', 'input[name="xh"]',
        'input[placeholder*="用户名"]', 'input[placeholder*="账号"]',
        'input[id*="user"]', 'input[id*="account"]'
      ]);
      var pw = find(['#mm', '#password', '#pd', 'input[name*="password"]', 'input[type="password"]']);
      if (u && un) setVal(un, u);
      if (p && pw) setVal(pw, p);
      return { user: !!(u && un), pass: !!(p && pw) };
    }, { u: user || '', p: pass || '' });
    log('登录表单自动填充: 用户名' + (filled.user ? '✓' : '✗') + ' 密码' + (filled.pass ? '✓' : '✗'),
        filled.user && filled.pass ? 'ok' : 'warn');
    var hasCap = await frame.evaluate(function () {
      var els = document.querySelectorAll('#yzm, #captcha, input[name*="yzm"], input[name*="captcha"], input[placeholder*="验证码"]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetWidth || els[i].offsetHeight || els[i].getClientRects().length) return true;
      }
      return false;
    });
    if (hasCap) {
      log('检测到验证码，请在浏览器里填验证码后点登录', 'warn');
    } else if (filled.user && filled.pass) {
      var clicked = await frame.evaluate(function () {
        var direct = document.querySelector('#dl, #login, button[type="submit"], input[type="submit"], button.login-btn, a.login-btn');
        if (direct) { direct.click(); return true; }
        var els = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
        for (var i = 0; i < els.length; i++) {
          var txt = (els[i].textContent || els[i].value || '') + '';
          if (/登录|登陆|login/i.test(txt)) { els[i].click(); return true; }
        }
        return false;
      });
      if (clicked) log('已自动点击登录按钮（若后续停在验证码页，补一下验证码即可）', 'info');
      else log('找不到登录按钮，请手动点登录', 'warn');
    }
    await params.sleep(1200);
    log('登录提交后页面: ' + page.url(), 'info');
  } catch (e) {
    log('自动填充登录表单失败（忽略，手动填即可）: ' + e.message, 'warn');
  }
}

// 登录后若页面没自动发查询请求，程序化点一次"查询"按钮逼出 PartDisplay
async function tryTriggerQuery(page) {
  try {
    // 这版页面把查询绑在 searchBox 上，不一定有可见的“查询”按钮。
    await page.evaluate(function () {
      try {
        if (window.jQuery && window.jQuery('#searchBox').length) {
          window.jQuery('#searchBox').trigger('searchResult');
        }
      } catch (e) {}
    });
    var found = await page.evaluate(function () {
      var els = document.querySelectorAll('button, a, input[type=button], input[type=submit]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var txt = (el.textContent || el.value || '') + '';
        if (txt.indexOf('查询') > -1) { el.click(); return true; }
      }
      return false;
    });
    if (found) log('已尝试触发页面查询', 'info');
  } catch (e) {}
}

async function capturePageContext(page) {
  if (templates.ctx) return;
  var keys = [
    'bh_id', 'jg_id', 'zyh_id', 'zyfx_id', 'njdm_id', 'xz', 'ccdm', 'xbm',
    'mzm', 'xslbdm', 'xsbj', 'xkxnm', 'xkxqm', 'xkly', 'xklc', 'rwlx',
    'kklxdm', 'xkkz_id'
  ];
  var frames = page.frames();
  for (var i = 0; i < frames.length && !templates.ctx; i++) {
    try {
      var found = await frames[i].evaluate(function (wanted) {
        var out = {};
        var inputs = document.querySelectorAll('input[name], select[name], textarea[name]');
        for (var i = 0; i < inputs.length; i++) {
          var name = inputs[i].getAttribute('name') || '';
          if (wanted.indexOf(name) > -1) out[name] = inputs[i].value || '';
        }
        wanted.forEach(function (key) {
          try {
            if (out[key] == null && window[key] != null && typeof window[key] !== 'object') {
              out[key] = String(window[key]);
            }
          } catch (e) {}
        });
        var sources = [];
        var marked = document.querySelectorAll('[onclick], [data-params], [data-url]');
        for (var j = 0; j < marked.length; j++) sources.push(marked[j].outerHTML || '');
        var scripts = document.querySelectorAll('script:not([src])');
        for (var k = 0; k < scripts.length; k++) sources.push(scripts[k].textContent || '');
        wanted.forEach(function (key) {
          if (out[key] != null) return;
          var re = new RegExp(key + '\\s*[:=]\\s*[\'"]?([^\'"?,;&}\\s]+)', 'i');
          for (var s = 0; s < sources.length; s++) {
            var match = sources[s].match(re);
            if (match) { out[key] = match[1]; break; }
          }
        });
        return out.bh_id ? out : null;
      }, keys);
      if (found) {
        templates.ctx = found;
        var xk = params.pickXkkzFromObj(found);
        if (xk && !templates.xkkz) templates.xkkz = String(xk);
        log('✓ 页面学生上下文已采集', 'ok');
        debug.log('page-context', found);
      }
    } catch (e) {}
  }
}

function looksLikeAuthUrl(url) {
  return apiLib.isLoginUrl(url);
}

async function detectAuthPage(page) {
  var url = page.url();
  var title = '';
  try { title = await page.title(); } catch (e) {}
  if (!title) {
    try { title = await page.evaluate(function () { return document.title || ''; }); } catch (e) {}
  }
  return {
    url: url,
    title: title,
    isReverseProxy: apiLib.isReverseProxyAuthUrl(url) || /应用认证平台/.test(title)
  };
}

// WEngine 反代认证页的“统一认证”入口：进入 CAS 后复用通用登录表单填充。
async function clickCasLogin(page) {
  var clicked = false;
  var frames = page.frames();
  for (var i = 0; i < frames.length && !clicked; i++) {
    try {
      clicked = await frames[i].evaluate(function () {
        var direct = document.querySelector('#cas-login, a[href*="cas_login=true"], a.link-login');
        if (direct) { direct.click(); return true; }
        var nav = document.querySelector('#cas, [data-type="cas"]');
        if (nav) { nav.click(); return true; }
        return false;
      });
      if (clicked) debug.log('cas-click-frame', { url: frames[i].url(), name: frames[i].name() });
    } catch (e) {
      debug.log('cas-click-frame', { url: frames[i].url(), name: frames[i].name(), error: e.message });
    }
  }
  if (!clicked) return false;
  try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch (e) {}
  await params.sleep(1000);
  log('已进入统一认证登录，当前页面: ' + page.url(), 'info');
  return true;
}

// 登录入口可能是门户页/统一认证页；登录成功后主动跳到真正的选课页。
async function ensureSelectionPage(page) {
  var current = page.url();
  if (apiLib.isSelectionPath(current)) return true;
  // 上一次跳转如果停在 about:blank 或其它中间页，下一次轮询需要重新尝试。
  selectionNavigated = false;
  if (looksLikeAuthUrl(current)) return false;
  var title = '';
  try { title = await page.title(); } catch (e) {}
  if (!title) {
    try { title = await page.evaluate(function () { return document.title || ''; }); } catch (e) {}
  }
  debug.log('selection-check', { url: current, title: title });
  if (/应用认证平台|统一身份认证/.test(title)) return false;

  // iframe/弹窗里仍显示密码框或二维码时，说明登录还没完成，不要抢跳转。
  var challenge = { password: false, qr: false };
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    try {
      var found = await frames[i].evaluate(function () {
        function visible(el) {
          return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        }
        var passwords = document.querySelectorAll('input[type="password"]');
        for (var i = 0; i < passwords.length; i++) {
          if (visible(passwords[i])) return { password: true, qr: false };
        }
        var qrs = document.querySelectorAll('#qrcode, .qrcode, canvas.qrcode, canvas#qrcode, img[src*="qrcode"], img[src*="qr"]');
        for (var j = 0; j < qrs.length; j++) {
          if (visible(qrs[j])) return { password: false, qr: true };
        }
        return { password: false, qr: false };
      });
      challenge.password = challenge.password || found.password;
      challenge.qr = challenge.qr || found.qr;
    } catch (e) {}
  }
  debug.log('selection-check-challenge', { frame: current, challenge: challenge, title: title });
  if (challenge.password || challenge.qr) return false;
  if (Date.now() < selectionRetryAt) return false;

  var isPortal = /\/xtgl\/index|\/index_initMenu|\/home|\/main|\/portal/i.test(current) ||
    /教务|首页|门户|主页/.test(title);
  debug.log('selection-check-portal', { isPortal: isPortal, url: current, title: title });
  if (!isPortal && !/^about:blank/i.test(current)) return false;

  selectionNavigated = true;
  var target = selectionUrl();
  log('当前页面不是选课页，尝试跳转到: ' + target, 'info');
  try {
    await page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await params.sleep(800);
    log('跳转后页面: ' + page.url(), 'info');
  } catch (e) {
    selectionNavigated = false;
    selectionRetryAt = Date.now() + 5000;
    log('跳转选课页失败: ' + e.message, 'warn');
  }
  if (!apiLib.isSelectionPath(page.url())) {
    // about:blank、登录页或其它中间页都允许下一轮重新尝试。
    selectionNavigated = false;
    selectionRetryAt = Date.now() + 5000;
  }
  return apiLib.isSelectionPath(page.url());
}

async function isInAcademicSystem(page) {
  var current = page.url();
  if (!current || looksLikeAuthUrl(current)) return false;
  if (apiLib.isSelectionPath(current)) return true;

  var sameOrigin = false;
  try {
    sameOrigin = new URL(current).origin === new URL(cfg.base).origin;
  } catch (e) {}
  if (!sameOrigin) return false;

  var title = '';
  try { title = await page.title(); } catch (e) {}
  return /\/xtgl\/|\/jwglxt\//i.test(current) ||
    /教学管理信息服务平台|教务系统|教务管理/.test(title);
}

// 部分 WEngine 站点在统一认证回跳后仍会落到正方 login_slogin.html；
// 再走一次学校提供的 SSO 接入口即可复用 WEngine 身份继续登录。
async function resumeViaSso(page) {
  if (String(cfg.authMode || '').toLowerCase() === 'zfsoft') return false;
  var target = ssoUrl();
  if (!target || ssoAttempts >= 2 || Date.now() < ssoRetryAt) return false;
  var current = page.url();
  if (!/login_slogin/i.test(current)) return false;
  if (target.replace(/#.*$/, '') === current.replace(/#.*$/, '')) return false;

  ssoAttempts++;
  log('WEngine 认证后仍在正方登录页，继续 SSO 接入口: ' + target, 'info');
  debug.log('sso-resume', { from: current, to: target, attempt: ssoAttempts });
  try {
    await page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await params.sleep(800);
    log('SSO 接入口跳转后页面: ' + page.url(), 'info');
  } catch (e) {
    log('SSO 接入口跳转失败: ' + e.message, 'warn');
  }
  if (/login_slogin/i.test(page.url()) && ssoAttempts < 2) {
    ssoRetryAt = Date.now() + 2000;
  }
  return !/login_slogin/i.test(page.url());
}

/* ---------------------------- 登录与会话 ---------------------------- */

async function ensureLogin() {
  // 普通运行只允许复用 --prepare 生成的结果，不再自动打开登录浏览器。
  var savedTpl = loadJson(cfg.templatesFile || path.join('state', 'templates.json'));
  if (savedTpl) {
    ['ctx', 'display', 'query', 'detail', 'submit', 'drop', 'choosed', 'xkkz', 'api', 'meta', 'responses'].forEach(function (k) {
      if (savedTpl[k]) templates[k] = params.deepCopy(savedTpl[k]);
    });
  }
  var savedState = loadState();
  var missing = [];
  if (!savedState || !Array.isArray(savedState.cookies) || !savedState.cookies.length) {
    missing.push('Cookie 会话 ' + (cfg.stateFile || path.join('state', 'state.json')));
  }
  if (missing.length) {
    throw new NotPreparedError('准备结果不完整，缺少: ' + missing.join('；') +
      '。请重新运行: node rob.js --prepare --sso zfsoft|wengine');
  }

  log('加载准备结果，探测会话有效性…', 'info');
  var rc = await makeRequestContext();
  if (!templates.ctx) {
    log('学生上下文将在选课开放后动态获取', 'info');
    return rc;
  }
  try {
    await apiPost(rc, 'choosed', params.fetchChoosedParams(templates), { allowHtml: true });
    log('✓ 已准备的会话有效，进入抢课循环', 'ok');
    return rc;
  } catch (e) {
    try { await rc.dispose(); } catch (e2) {}
    var detail = e instanceof SessionError ? '会话已过期' : ('会话探测失败: ' + e.message);
    throw new NotPreparedError(detail + '。请重新运行: node rob.js --prepare --sso zfsoft|wengine');
  }
}

async function doLogin() {
  log('== 需要登录 ==', 'info');
  log('即将弹出浏览器打开登录入口。', 'info');
  var loginModeLabel = String(cfg.authMode || '').toLowerCase() === 'zfsoft'
    ? '正方原生'
    : (String(cfg.authMode || '').toLowerCase() === 'wengine' ? '反向代理/WEngine' : '自动识别');
  log('登录方式: ' + loginModeLabel, 'info');
  if (cfg.login && cfg.login.username) {
    log('已配置账号 ' + cfg.login.username + '，将自动填充登录表单。', 'info');
  } else {
    log('未配置账号（config/config.json 的 login），请手动登录。', 'info');
  }
  log('若登录页有验证码，请在浏览器里补上并点登录。', 'info');
  log('登录后会自动跳到选课页，脚本在后台采集请求参数。', 'info');
  log(cli.capture
    ? '抓包完成后按 Enter 保存并退出。'
    : '登录 Cookie 只采集一次；模板就绪后关闭浏览器并退出 --prepare。', 'info');

  var browser = await getPlaywright().chromium.launch({ headless: cli.capture ? false : !!cfg.headless });
  var closingBrowser = false;
  browser.on('disconnected', function () {
    if (!closingBrowser) log('登录浏览器连接已断开（窗口被关闭或浏览器进程退出）', 'warn');
  });
  var st = cli.forceLogin ? null : loadState();
  var statePath = configLib.resolvePath(cfg.stateFile || path.join('state', 'state.json'), __dirname);
  var contextOptions = {
    // 反向代理会把正方登录页脚本改写到 webauth 域，页面自带 CSP 会拦截这些原站脚本，
    // 导致 body 一直 display:none、表单不出现。这里仅放宽浏览器端 CSP，服务器认证仍照常执行。
    bypassCSP: cfg.bypassProxyCSP !== false
  };
  if (st && st.cookies && st.cookies.length) contextOptions.storageState = statePath;
  var context = await browser.newContext(contextOptions);
  installProxyAssetRewrite(context);
  var page = await context.newPage();
  page.on('close', function () {
    if (!closingBrowser) log('登录浏览器页面已关闭；若关闭整个窗口，请重新运行并保持窗口打开', 'warn');
  });
  context.on('close', function () {
    if (!closingBrowser) log('登录浏览器上下文已关闭', 'warn');
  });
  attachCapture(page);
  attachDebug(page);
  context.on('page', function (p) {
    debug.log('new-page', { url: p.url() });
    attachCapture(p);
    attachDebug(p);
  });
  try {
    var entry = loginUrl();
    log('打开登录入口: ' + entry, 'info');
    debug.log('login-start', {
      entry: entry,
      loginPath: loginPath(),
      selectionPath: selectionPath(),
      authMode: cfg.authMode || 'auto',
      bypassProxyCSP: cfg.bypassProxyCSP !== false,
      headless: !!cfg.headless
    });
    await page.goto(entry, { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(function () {});
    await params.sleep(300);
    debug.log('goto-result', { url: page.url() });
    await logFormInventory(page, 'after-goto');
  } catch (e) {
    log('打开选课页异常（可能网络/会话问题，请在浏览器里处理并刷新）: ' + e.message, 'warn');
  }
  var authMode = String(cfg.authMode || 'auto').toLowerCase();
  var auth = await detectAuthPage(page);
  log('认证页: ' + (auth.title || '(无标题)') + ' @ ' + auth.url, 'info');
  var isProxyAuth = auth.isReverseProxy || authMode === 'wengine';
  if (authMode === 'manual') {
    log('authMode=manual：请在浏览器里完成登录。', 'warn');
  } else if (isProxyAuth && authMode !== 'zfsoft') {
    log('检测到反向代理认证页（应用认证平台/WEngine）', 'info');
    if (cfg.login && (cfg.login.username || cfg.login.password)) {
      log('尝试通过“统一认证”登录…', 'info');
      var enteredCas = await clickCasLogin(page);
      if (enteredCas) {
        log('CAS 登录页: ' + page.url(), 'info');
        await autoFillLogin(page);
      } else {
        log('未找到统一认证入口，请在浏览器里选择统一认证或企业微信完成登录。', 'warn');
      }
    } else {
      log('请在认证页选择“统一认证”或“企业微信”完成登录；脚本会等待反代回跳，不会关闭浏览器。', 'warn');
    }
  } else {
    await autoFillLogin(page);
  }
  log('当前页面: ' + page.url(), 'info');
  await resumeViaSso(page);
  await handleLoginPage(page);
  var academicReady = false;
  var initialSelection = await ensureSelectionPage(page);
  if (initialSelection || await isInAcademicSystem(page)) {
    academicReady = true;
    await saveSession(context, statePath, '进入教务系统');
    await capturePageContext(page);
  }

  if (cli.capture) {
    log('抓包模式：请在浏览器里登录 → 进入选课页 → 查询一次 → 展开一门课 → （可选）提交/退选。', 'warn');
    log('完成后回到终端按 Enter；程序会把接口路径、请求模板和响应样例写入 ' + (cfg.templatesFile || path.join('state', 'templates.json')), 'warn');
    await waitForEnter('完成后按 Enter 保存抓包结果… ');
    // 给尚未完成的 response.text() 一点时间落盘。
    await resumeViaSso(page);
    await handleLoginPage(page);
    var captureSelection = await ensureSelectionPage(page);
    if (captureSelection || await isInAcademicSystem(page)) {
      await saveSession(context, statePath, '教务系统会话');
    }
    await params.sleep(1000);
  }

  var deadline = Date.now() + (cfg.loginTimeoutMin || 5) * 60000;
  var triggered = 0;
  while (!cli.capture && Date.now() < deadline) {
    await resumeViaSso(page);
    await handleLoginPage(page);
    var loopSelection = await ensureSelectionPage(page);
    if (loopSelection || await isInAcademicSystem(page)) {
      academicReady = true;
      await saveSession(context, statePath, '教务系统会话更新');
      await capturePageContext(page);
    }
    if (academicReady && !templates.query && triggered < 3) {
      await tryTriggerQuery(page);
      triggered++;
      await params.sleep(1000);
      continue;
    }
    if (academicReady) break;
    await params.sleep(1000);
  }

  var preparationReady = academicReady && sessionCaptured;
  if (!cli.capture && !preparationReady) {
    log('超时未检测到可用的学生上下文/模板：请确认已登录并进入教务系统。', 'err');
    log('已抓到的接口: ' + JSON.stringify(templates.api || {}), 'warn');
    if (debug.enabled) {
      try { debug.log('login-timeout-snapshot', await pageSnapshot(page)); } catch (e) {}
      log('调试日志已写入: ' + debug.file, 'warn');
    }
    log('排查建议：用 node rob.js --capture 抓一次，或导出 HAR 后运行 node rob.js --import-har 文件.har', 'warn');
    if (await isInAcademicSystem(page)) {
      await saveSession(context, statePath, '超时前保留教务系统会话');
    }
    closingBrowser = true;
    await browser.close();
    process.exit(1);
  }
  log(cli.capture ? '抓包结束，保存结果…' : '当前可采集模板已收集，保存会话…', 'ok');
  if (await isInAcademicSystem(page)) {
    await saveSession(context, statePath, cli.capture ? '抓包完成' : '模板就绪');
  }
  if (hasCapturedTemplates()) saveTemplates();
  else log('没有抓到任何接口，保留原有 ' + (cfg.templatesFile || path.join('state', 'templates.json')), 'warn');
  printCaptureSummary();
  closingBrowser = true;
  await browser.close();
  if (cli.capture) {
    log('抓包完成。把 ' + (cfg.templatesFile || path.join('state', 'templates.json')) + ' 发回来即可继续适配。', 'ok');
    process.exit(0);
  }
  log('会话已保存（' + (cfg.stateFile || path.join('state', 'state.json')) + '）。下次运行可跳过登录直接复用。', 'ok');
  return null;
}

/* ---------------------------- 抢课循环 ---------------------------- */

function canAttempt(course) {
  var kch = String(course.kch || course.kch_id);
  if (state.claim[kch]) return false;
  var cd = state.cooldown[kch];
  if (cd && Date.now() < cd) return false;
  return true;
}

function markCooldown(course, ms) {
  var kch = String(course.kch || course.kch_id);
  state.cooldown[kch] = Date.now() + ms;
}

function extractSelectionContext(html) {
  var wanted = {
    bh_id: 1, jg_id: 1, zyh_id: 1, zyfx_id: 1, njdm_id: 1, xz: 1, ccdm: 1,
    xbm: 1, mzm: 1, xslbdm: 1, xsbj: 1, xqxnm: 1, xkxnm: 1, xkxqm: 1,
    xkly: 1, xklc: 1, rwlx: 1, kklxdm: 1, xkkz_id: 1
  };
  var out = {};
  var tagRe = /<input\b([^>]*)>/gi;
  var tag;
  while ((tag = tagRe.exec(String(html || '')))) {
    var attrs = tag[1] || '';
    var nameMatch = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!nameMatch) continue;
    var name = nameMatch[1] || nameMatch[2] || nameMatch[3] || '';
    if (!wanted[name]) continue;
    var valueMatch = attrs.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    out[name] = valueMatch ? (valueMatch[1] || valueMatch[2] || valueMatch[3] || '') : '';
  }
  Object.keys(wanted).forEach(function (key) {
    if (out[key] != null) return;
    var re = new RegExp(key + '\\s*[:=]\\s*[\'"]?([^\'"?,;&}\\s<]+)', 'i');
    var match = String(html || '').match(re);
    if (match) out[key] = match[1];
  });
  return out.bh_id ? out : null;
}

async function bootstrapRuntimeContext(rc) {
  if (templates.ctx) return true;
  var headers = apiHeaders('index');
  headers.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  var timeout = Math.max(1000, Number(cfg.requestTimeoutSec || 30) * 1000);
  var res = await rc.get(selectionUrl(), { headers: headers, timeout: timeout });
  var text = await res.text();
  if (looksLikeAuthUrl(res.url()) && !extractSelectionContext(text)) {
    throw new SessionError('选课页返回登录页面（会话已过期）');
  }
  var ctx = extractSelectionContext(text);
  if (!ctx) return false;
  templates.ctx = ctx;
  var xk = params.pickXkkzFromObj(ctx);
  if (xk) templates.xkkz = String(xk);
  saveTemplates();
  log('✓ 运行时学生上下文已获取', 'ok');
  if (templates.xkkz) log('✓ 运行时选课批次 xkkz_id 已更新: ' + templates.xkkz, 'ok');
  return true;
}

async function doQuery(rc) {
  var p = params.buildQueryParams(templates, state.kklxdm);
  var res = await apiPost(rc, 'query', p);
  var list = params.extractList(res, ['tmpList', 'list', 'rows', 'items']);
  var changed = false;
  if (!templates.query) {
    templates.query = params.deepCopy(p);
    changed = true;
    log('✓ 运行时查询模板已补齐', 'ok');
  }
  var responseXk = params.pickXkkzFromObj(res);
  if (responseXk && String(templates.xkkz || '') !== String(responseXk)) {
    templates.xkkz = String(responseXk);
    changed = true;
    log('✓ 运行时选课批次 xkkz_id 已更新: ' + templates.xkkz, 'ok');
  }
  for (var i = 0; i < list.length; i++) {
    var xk = params.pickXkkzFromObj(list[i]);
    if (xk) {
      if (String(templates.xkkz || '') !== String(xk)) {
        templates.xkkz = String(xk);
        changed = true;
        log('✓ 运行时选课批次 xkkz_id 已更新: ' + templates.xkkz, 'ok');
      }
      break;
    }
  }
  if (changed) saveTemplates();
  return list;
}

async function scanOnce(rc) {
  if (state.querying) return [];
  state.querying = true;
  try {
    var list = await doQuery(rc);
    log('[查询] 返回 ' + list.length + ' 门课', 'info');
    var hits = list.filter(function (c) { return matchLib.matchTarget(state.targets, c, state.njdm); });
    if (hits.length) {
      log('[命中] ' + hits.map(function (c) { return '[' + c.kch + ']' + c.kcmc; }).join(' / '), 'hit');
      for (var i = 0; i < hits.length; i++) {
        if (state.succeeded) break;
        if (!state.dryRun) await maybeAutoSelect(rc, hits[i]);
      }
    }
    return hits;
  } catch (e) {
    if (e instanceof SessionError) throw e;
    log('[查询] 失败: ' + e.message, 'err');
    return [];
  } finally {
    state.querying = false;
  }
}

async function maybeAutoSelect(rc, course) {
  var kch = String(course.kch || course.kch_id);
  if (!canAttempt(course)) return;
  var desc = '[' + kch + '] ' + course.kcmc;
  // 已选检测：目标已在已选课表中 → 明确提示并标记完成，不再反复抢
  try {
    var choosed = await apiPost(rc, 'choosed', params.fetchChoosedParams(templates), { allowHtml: true });
    choosed = params.normaliseChoosed(choosed);
    var already = Array.isArray(choosed) && choosed.some(function (c) {
      return String(c.kch || '') === String(course.kch || '') || String(c.kch_id || '') === String(course.kch_id || '');
    });
    if (already) {
      log('[已选] ' + desc + ' 已在你的已选课表中，无需重复抢，标记完成', 'ok');
      notify('已选课程', course.kcmc + ' 已在已选课表中');
      state.claim[kch] = true;
      state.cooldown[kch] = 0;
      state.succeeded = true;
      return;
    }
  } catch (e) {
    if (e instanceof SessionError) throw e;
    log('[已选检测] 查询已选课失败（忽略，继续尝试）: ' + e.message, 'warn');
  }
  state.claim[kch] = true; // 防并发重复进入
  try {
    await selectFlow(rc, course);
  } catch (e) {
    if (e instanceof SessionError) throw e;
    log('[选课] ' + desc + ' 流程异常: ' + e.message, 'err');
    markCooldown(course, 15000);
    state.claim[kch] = false;
  }
}

async function fetchJxb(rc, course) {
  if (course.do_jxb_id || course.jxb_ids) {
    log('[选课] 列表已包含加密教学班 ID，跳过详情请求', 'info');
    return course;
  }
  var p = params.fetchJxbParams(templates, course, state.kklxdm);
  var res = await apiPost(rc, 'detail', p);
  // 服务端对"无可用可选教学班"返回 "0"（字符串）或空数组
  if (res === '0' || res === 0) throw new NoClassError('教学班详情返回"0"：该课当前无可用可选教学班');
  if (res && !Array.isArray(res) && (res.do_jxb_id || res.jxb_ids)) return res;
  var arr = params.extractList(res, ['tmpList', 'list', 'rows', 'items']);
  if (!arr.length) throw new NoClassError('教学班详情为空：该课当前无可用可选教学班');
  for (var i = 0; i < arr.length; i++) {
    if (course.jxb_id && String(arr[i].jxb_id).toUpperCase() === String(course.jxb_id).toUpperCase()) return arr[i];
  }
  return arr[0];
}

async function submitSelect(rc, course, detail) {
  var p = params.buildSubmitParams(templates, course, detail, state.kklxdm);
  return await apiPost(rc, 'submit', p);
}

// 有些版本在提交前要求先过 cxXkTitleMsg 探针。只有抓到该接口模板时才调用。
async function probeTitle(rc, course, detail) {
  if (cfg.useTitleProbe === false) return { ok: true, skipped: true };
  var p = params.buildTitleParams(templates, course, detail, state.kklxdm);
  if (!p) return { ok: true, skipped: true };
  var res = await apiPost(rc, 'title', p);
  var flag = res && res.flag != null ? String(res.flag) : '';
  var msg = res && (res.msg || res.message) ? String(res.msg || res.message) : '';
  if (flag && flag !== '1') return { ok: false, msg: msg || ('flag=' + flag) };
  return { ok: true, skipped: false };
}

async function selectFlow(rc, course) {
  var kchKey = String(course.kch || course.kch_id);
  var desc = '[' + (course.kch || course.kch_id) + '] ' + course.kcmc;
  log('[选课] 开始处理: ' + desc, 'info');

  var detail;
  try {
    detail = await fetchJxb(rc, course);
  } catch (e) {
    if (e instanceof SessionError) throw e;
    if (e instanceof NoClassError) {
      log('[选课] ' + desc + '：' + e.message + '（名额满/限选/批次原因，已降频到 60s 自动重试）', 'warn');
      state.claim[kchKey] = false;
      markCooldown(course, 60000);
      return;
    }
    throw e;
  }
  if (!detail.do_jxb_id && !detail.jxb_ids) {
    log('[选课] 详情无 do_jxb_id: ' + desc, 'warn');
    state.claim[kchKey] = false;
    markCooldown(course, 15000);
    return;
  }

  var probe = await probeTitle(rc, course, detail);
  if (!probe.ok) {
    log('[选课] 前置探针未通过: ' + desc + (probe.msg ? ' - ' + probe.msg : ''), 'warn');
    state.claim[kchKey] = false;
    markCooldown(course, 30000);
    return;
  }

  log('[选课] 拿到加密ID，提交: ' + desc + ' @ ' + (detail.sksj || '') + ' ' + (detail.jxdd || ''), 'info');
  var res = await submitSelect(rc, course, detail);
  await handleSubmitResult(rc, course, detail, res);
}

async function handleSubmitResult(rc, course, detail, res) {
  var kchKey = String(course.kch || course.kch_id);
  var desc = '[' + (course.kch || course.kch_id) + '] ' + course.kcmc;
  var flag = res && (res.flag != null ? String(res.flag) : '');
  var msg = res && (res.msg || res.message || res.errmsg) ? String(res.msg || res.message || res.errmsg) : '';
  var ok = flag === '1' || res === 1 || res === '1' ||
    (res && res.success === true) ||
    (/成功/.test(msg) && !/失败|未成功/.test(msg));
  if (ok) {
    log('[成功] 抢课成功: ' + desc, 'ok');
    notify('抢课成功', course.kcmc + ' 已选上');
    beep();
    state.claim[kchKey] = true;
    state.cooldown[kchKey] = 0;
    state.succeeded = true;
  } else {
    log('[失败] ' + desc + (msg ? ' - ' + msg : ' - flag=' + flag + ' resp=' + JSON.stringify(res)), 'err');
    if (/冲突/.test(msg)) {
      await conflictLib.resolveConflict(deps(rc), course, detail, msg);
    } else {
      markCooldown(course, 30000);
      state.claim[kchKey] = false;
      notify('选课失败', msg || ('flag=' + flag));
    }
  }
}

function deps(rc) {
  return {
    api: {
      post: function (endpoint, obj, opts) { return apiPost(rc, endpoint, obj, opts); },
      submit: function (course, detail) { return submitSelect(rc, course, detail); },
      detail: function (course) { return fetchJxb(rc, course); },
      batch: function () {
        var p = params.buildBatchParams(templates, state.kklxdm);
        return p ? apiPost(rc, 'batch', p) : Promise.resolve(null);
      }
    },
    templates: templates,
    state: state,
    log: log,
    notify: notify,
    markCooldown: markCooldown,
    handleSubmitResult: function (c, d, r) { return handleSubmitResult(rc, c, d, r); },
    sleep: params.sleep
  };
}

function handleSessionExpired() {
  log('== 会话已过期 ==', 'err');
  log(cfg.headless
    ? '服务器场景：请在本机重跑一次 --prepare 生成新的 ' + (cfg.stateFile || path.join('state', 'state.json')) + ' 后传回服务器。'
    : '请重新运行: node rob.js --prepare --sso zfsoft|wengine', 'warn');
  notify('选课工具会话过期', '需要重新登录');
  process.exitCode = 2;
}

async function runLoop(rc) {
  var built = matchLib.buildTargets(cfg.targets || {});
  state.targets = built.list;
  state.njdm = built.njdm;
  if (!state.targets.length) {
    log('没有配置目标课程：请编辑 config/config.json 的 targets（kch 课程号 / jxb 教学班ID / kw 关键词，至少填一个；njdm_id 年级过滤可选）', 'err');
    process.exitCode = 3;
    return;
  }
  log('======================================', 'info');
  log('开始' + (state.dryRun ? '干跑' : '实跑') + '：间隔 ' + state.interval + 's | 类别 kklxdm=' + state.kklxdm + ' | 目标 ' + state.targets.length + ' 条' + (state.dryRun ? '（只监控，不提交）' : ''), 'info');
  log('使用接口: ' + JSON.stringify(apiLib.buildEndpoints(cfg, templates)), 'dim');
  var waitingForContext = false;

  while (true) {
    try {
      if (!templates.ctx) {
        var contextReady = await bootstrapRuntimeContext(rc);
        if (!contextReady) {
          if (!waitingForContext) {
            log('选课尚未开放或尚未返回学生上下文，持续轮询选课页…', 'info');
            waitingForContext = true;
          }
          await params.sleep(Math.round(state.interval * 1000));
          continue;
        }
        waitingForContext = false;
      }
      await scanOnce(rc);
      if (state.succeeded) {
        log('✓ 目标请求已返回成功，停止轮询', 'ok');
        break;
      }
    } catch (e) {
      if (e instanceof SessionError) { handleSessionExpired(); break; }
      log('[循环] 异常: ' + e.message, 'err');
    }
    await params.sleep(Math.round(state.interval * 1000));
  }
}

function printHelp() {
  console.log([
    '用法:',
    '  node rob.js --prepare --sso MODE    登录并采集 Cookie/模板，完成后退出',
    '  node rob.js                         使用已准备结果运行（不能自动登录）',
    '  node rob.js --account <id>          只运行指定账号',
    '  node rob.js --capture [--account]   打开浏览器抓包，按 Enter 保存',
    '  node rob.js --import-har FILE       从 HAR 导入指定账号的模板',
    '  node rob.js --list-accounts         列出配置中的账号',
    '  node rob.js --config FILE           使用指定配置文件',
    '  node rob.js --force-login           忽略已保存会话，强制重新登录',
    '  node rob.js --sso zfsoft            正方原生登录入口',
    '  node rob.js --sso wengine           反向代理/WEngine 登录入口',
    '  node rob.js --dryrun                强制干跑（只查询，不提交）',
    '  node rob.js --delete                清空配置、Cookie/模板和日志',
    '  node rob.js --debug                 输出详细登录/跳转/表单日志',
    '  node rob.js --help                  显示本帮助',
    '',
    '--sso 只能与 --prepare 或 --capture 一起使用。',
    '--dryrun 开启干跑；node rob.js 不带该参数时执行实跑。',
    '--delete 必须单独使用，不能与任何其他参数组合。',
    '接口路径可在 config/config.json 的 api 字段覆盖，例如:',
    '  "api": { "query": "/xsxk/xxx.html?gnmkdm=N253512" }'
  ].join('\n'));
}

function printAccounts(resolved) {
  console.log('账号列表（' + resolved.mode + '，并发 ' + resolved.concurrency + '）:');
  resolved.accounts.forEach(function (a) {
    var t = a.targets || {};
    var target = [t.kch ? 'kch=' + t.kch : '', t.jxb ? 'jxb=' + t.jxb : '', t.kw ? 'kw=' + t.kw : '']
      .filter(Boolean).join(', ') || '(未配置目标)';
    console.log('  - ' + a.id + '  ' + (a.enabled === false ? '[disabled] ' : '') + a.base);
    console.log('      ' + target + '  state=' + a.stateFile + '  templates=' + a.templatesFile);
  });
}

async function runHarImport(file) {
  var full = path.isAbsolute(file) ? file : path.join(__dirname, file);
  var har;
  try {
    har = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    log('读取 HAR 失败: ' + e.message, 'err');
    process.exit(1);
  }

  var store = captureLib.createStore();
  var counts = captureLib.importHar(store, har, { base: cfg.base });
  ['ctx', 'display', 'query', 'detail', 'submit', 'drop', 'choosed', 'xkkz', 'api', 'meta', 'responses'].forEach(function (k) {
    if (store[k] != null) templates[k] = store[k];
  });
  saveTemplates();

  log('HAR 导入完成: 共 ' + counts.entries + ' 条记录，识别 ' + JSON.stringify(counts.kinds), 'ok');
  log('已写入 ' + (cfg.templatesFile || path.join('state', 'templates.json')), 'ok');
  printCaptureSummary();
  if (captureLib.missingKinds(templates).length) {
    log('如果缺少 query/detail/submit：请在 HAR 里确认包含对应 XHR 的 Request Payload 和 Response。', 'warn');
  }
  if (!counts.kinds.query && !counts.kinds.detail && !counts.kinds.submit) {
    log('这份 HAR 只有首页/静态资源：抓包时请确认已登录、处于选课阶段，并实际点击“查询/展开/选课”。', 'warn');
  }
}

async function main() {
  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.har) {
    await runHarImport(cli.har);
    return;
  }
  if (cli.capture) {
    await doLogin();
    return;
  }
  if (cli.prepare) {
    await doLogin();
    log('账号准备完成：Cookie、学生上下文和当前可采集模板已保存；动态数据将在运行时获取。', 'ok');
    return;
  }
  if (cli.forceLogin) {
    throw new NotPreparedError('--force-login 只能与 --prepare 一起使用');
  }
  if (cli.sso) {
    throw new NotPreparedError('--sso 只能与 --prepare 或 --capture 一起使用');
  }
  var rc = await ensureLogin();
  await runLoop(rc);
}

function fatal(e) {
  var msg = '致命错误: ' + e.message;
  if (logger) log(msg, 'err');
  else console.error(msg);
  if (/Executable doesn't exist|playwright install/i.test(String(e.message || ''))) {
    var hint = '浏览器未安装：请在 grabber 目录运行 npx playwright install chromium';
    if (logger) log(hint, 'warn');
    else console.error(hint);
  }
  if (e.stack) {
    var stack = e.stack.split('\n').slice(0, 3).join(' | ');
    if (logger) log(stack, 'dim');
    else console.error(stack);
  }
  process.exit(e instanceof NotPreparedError ? 4 : 1);
}

if (runAsSupervisor) {
  supervisor.run(resolved, cli, {
    script: __filename,
    cwd: __dirname,
    configFile: cli.configFile ? configFile : null
  }).then(function (code) {
    process.exitCode = code;
  }).catch(fatal);
} else {
  main().catch(fatal);
}
