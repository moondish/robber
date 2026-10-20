// grab.js — 选课抢课独立工具主流程
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
    else if (a === '--account') out.account = argv[++i] || '';
    else if (a.indexOf('--account=') === 0) out.account = a.slice('--account='.length);
    else if (a === '--config') out.configFile = argv[++i] || '';
    else if (a.indexOf('--config=') === 0) out.configFile = a.slice('--config='.length);
    else if (a === '--import-har') out.har = argv[++i] || '';
    else if (a.indexOf('--import-har=') === 0) out.har = a.slice('--import-har='.length);
  }
  return out;
}

var cli = parseCli(process.argv.slice(2));
var configFile = configLib.resolvePath(cli.configFile || 'config.json', __dirname);
var resolved;
try {
  resolved = configLib.resolveConfig(configLib.loadRaw(configFile));
} catch (e) {
  console.error('无法读取/解析 ' + configFile + ': ' + e.message);
  process.exit(1);
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
  dryRun: !!cfg.dryRun,
  interval: cfg.intervalSec >= 1 ? cfg.intervalSec : 2.5,
  kklxdm: String(cfg.kklxdm || '10'),
  claim: {},      // kch -> true（已抢成，永久停）
  cooldown: {}    // kch -> 时间戳（冷却到点后再试）
} : null;

function SessionError(message) { this.name = 'SessionError'; this.message = message || '会话失效'; }
SessionError.prototype = Object.create(Error.prototype);
SessionError.prototype.constructor = SessionError;

function NoClassError(message) { this.name = 'NoClassError'; this.message = message || '无可用教学班'; }
NoClassError.prototype = Object.create(Error.prototype);
NoClassError.prototype.constructor = NoClassError;

/* ---------------------------- 配置/状态读写 ---------------------------- */

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(configLib.resolvePath(file, __dirname), 'utf8')); } catch (e) { return null; }
}

function saveJson(file, obj) {
  try {
    var full = configLib.resolvePath(file, __dirname);
    configLib.ensureParent(full);
    fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    if (log) log('写入文件失败: ' + file + ' - ' + e.message, 'warn');
  }
}

function saveTemplates() {
  var out = params.deepCopy(templates);
  delete out.pendingRequests;
  delete out.warnings;
  saveJson(cfg.templatesFile || 'templates.json', out);
}

function hasCapturedTemplates() {
  var learned = Object.keys(templates.api || {}).some(function (k) { return k !== 'index'; });
  return !!(templates.ctx || templates.query || templates.detail || templates.submit || templates.drop || learned);
}

function loadState() { return loadJson(cfg.stateFile || 'state.json'); }

function indexPath() {
  return (cfg.api && cfg.api.index) || cfg.indexPath || (templates.api && templates.api.index) || apiLib.DEFAULTS.index;
}

function refererUrl() {
  var url = apiLib.resolveUrl(cfg.base, indexPath());
  return apiLib.withGnmkdm(url, cfg.gnmkdm, cfg.appendGnmkdm);
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
    opts.storageState = configLib.resolvePath(cfg.stateFile || 'state.json', __dirname);
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
  return parseRes(t);
}

/* ---------------------------- 模板采集（网络层） ---------------------------- */

var captureNotified = {};
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

// 用 config 里 login.username/password 预填登录表单。
// 正方登录框常见选择器：#yhm 用户名 / #mm 密码 / #dl 登录按钮；有验证码(#yzm)则停手等用户补。
async function autoFillLogin(page) {
  var user = cfg.login && cfg.login.username;
  var pass = cfg.login && cfg.login.password;
  if (!user && !pass) return;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    var filled = await page.evaluate(function (u, p) {
      function find(selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el) return el;
        }
        return null;
      }
      function setVal(el, v) {
        el.value = v;
        try {
          var evt = document.createEvent('HTMLEvents');
          evt.initEvent('input', true, true);
          el.dispatchEvent(evt);
        } catch (e) {}
      }
      var un = find(['#yhm', 'input[name*="yhm"]', 'input[placeholder*="用户名"]', 'input[placeholder*="账号"]']);
      var pw = find(['#mm', 'input[type="password"]']);
      if (u && un) setVal(un, u);
      if (p && pw) setVal(pw, p);
      return { user: !!(u && un), pass: !!(p && pw) };
    }, user || '', pass || '');
    log('登录表单自动填充: 用户名' + (filled.user ? '✓' : '✗') + ' 密码' + (filled.pass ? '✓' : '✗'),
        filled.user && filled.pass ? 'ok' : 'warn');
    var hasCap = await page.evaluate(function () {
      return !!document.querySelector('#yzm, input[name*="yzm"], input[placeholder*="验证码"]');
    });
    if (hasCap) {
      log('检测到验证码，请在浏览器里填验证码后点登录', 'warn');
    } else if (filled.user && filled.pass) {
      var clicked = await page.evaluate(function () {
        var el = document.querySelector('#dl, button:has-text("登录"), input[value*="登录"], a:has-text("登 录")');
        if (!el) return false;
        el.click();
        return true;
      });
      if (clicked) log('已自动点击登录按钮（若后续停在验证码页，补一下验证码即可）', 'info');
      else log('找不到登录按钮，请手动点登录', 'warn');
    }
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

/* ---------------------------- 登录与会话 ---------------------------- */

async function ensureLogin() {
  // 1) 已有模板 + 会话 → 先探测是否仍有效
  var savedTpl = loadJson(cfg.templatesFile || 'templates.json');
  if (savedTpl) {
    ['ctx', 'display', 'query', 'detail', 'submit', 'drop', 'choosed', 'xkkz', 'api', 'meta', 'responses'].forEach(function (k) {
      if (savedTpl[k]) templates[k] = params.deepCopy(savedTpl[k]);
    });
  }
  if (!cli.forceLogin && !cli.capture && templates.ctx && templates.query && loadState()) {
    log('发现已保存模板与会话，探测会话有效性…', 'info');
    var rc = await makeRequestContext();
    try {
      await apiPost(rc, 'choosed', params.fetchChoosedParams(templates), { allowHtml: true });
      log('✓ 会话有效，直接进入抢课循环', 'ok');
      return rc;
    } catch (e) {
      log(e instanceof SessionError ? '会话已过期，需要重新登录' : '会话复用探测失败: ' + e.message, 'warn');
      try { await rc.dispose(); } catch (e2) {}
    }
  }
  return doLogin();
}

async function doLogin() {
  log('== 需要登录 ==', 'info');
  log('即将弹出浏览器打开选课页。', 'info');
  if (cfg.login && cfg.login.username) {
    log('已配置账号 ' + cfg.login.username + '，将自动填充登录表单。', 'info');
  } else {
    log('未配置账号（config.json 的 login），请手动登录。', 'info');
  }
  log('若登录页有验证码，请在浏览器里补上并点登录。', 'info');
  log('登录后页面会自动发初始化请求，脚本在后台采集请求参数。', 'info');
  log('检测到模板就绪后，本工具自动进入抢课循环。', 'info');

  var browser = await getPlaywright().chromium.launch({ headless: cli.capture ? false : !!cfg.headless });
  var st = loadState();
  var statePath = configLib.resolvePath(cfg.stateFile || 'state.json', __dirname);
  var context = await browser.newContext(st && st.cookies && st.cookies.length ? { storageState: statePath } : {});
  var page = await context.newPage();
  attachCapture(page);
  try {
    var entry = refererUrl();
    if (!/[?&]layout=/.test(entry)) entry += (entry.indexOf('?') < 0 ? '?' : '&') + 'layout=default';
    await page.goto(entry, { timeout: 60000 });
  } catch (e) {
    log('打开选课页异常（可能网络/会话问题，请在浏览器里处理并刷新）: ' + e.message, 'warn');
  }
  await autoFillLogin(page);

  if (cli.capture) {
    log('抓包模式：请在浏览器里登录 → 进入选课页 → 查询一次 → 展开一门课 → （可选）提交/退选。', 'warn');
    log('完成后回到终端按 Enter；程序会把接口路径、请求模板和响应样例写入 ' + (cfg.templatesFile || 'templates.json'), 'warn');
    await waitForEnter('完成后按 Enter 保存抓包结果… ');
    // 给尚未完成的 response.text() 一点时间落盘。
    await params.sleep(1000);
  }

  var deadline = Date.now() + (cfg.loginTimeoutMin || 5) * 60000;
  var triggered = 0;
  while (!cli.capture && Date.now() < deadline) {
    if (templates.ctx && templates.query) break;
    if (templates.ctx && !templates.query && triggered < 3) {
      await tryTriggerQuery(page);
      triggered++;
    }
    await params.sleep(1000);
  }

  if (!cli.capture && (!templates.ctx || !templates.query)) {
    log('超时未检测到模板：请确认已登录并进入选课页、页面能正常加载选课数据。', 'err');
    log('已抓到的接口: ' + JSON.stringify(templates.api || {}), 'warn');
    log('排查建议：用 node grab.js --capture 抓一次，或导出 HAR 后运行 node grab.js --import-har 文件.har', 'warn');
    await browser.close();
    process.exit(1);
  }
  log(cli.capture ? '抓包结束，保存结果…' : '模板已就绪，保存会话…', 'ok');
  var stNow = await context.storageState();
  if (stNow && Array.isArray(stNow.cookies) && stNow.cookies.length) {
    configLib.ensureParent(statePath);
    await context.storageState({ path: statePath });
  } else {
    log('未检测到登录 cookie，保留原有 ' + (cfg.stateFile || 'state.json') + '，避免覆盖有效会话', 'warn');
  }
  if (hasCapturedTemplates()) saveTemplates();
  else log('没有抓到任何接口，保留原有 ' + (cfg.templatesFile || 'templates.json'), 'warn');
  printCaptureSummary();
  var rc = cli.capture ? null : await makeRequestContext();
  await browser.close();
  if (cli.capture) {
    log('抓包完成。把 ' + (cfg.templatesFile || 'templates.json') + ' 发回来即可继续适配。', 'ok');
    process.exit(0);
  }
  log('会话已保存（' + (cfg.stateFile || 'state.json') + '）。下次运行可跳过登录直接复用。', 'ok');
  return rc;
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

async function doQuery(rc) {
  var p = params.buildQueryParams(templates, state.kklxdm);
  var res = await apiPost(rc, 'query', p);
  return params.extractList(res, ['tmpList', 'list', 'rows', 'items']);
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
  var ok = flag === '1' || res === 1 || res === '1' || (res && res.success === true);
  if (ok) {
    log('[成功] 抢课成功: ' + desc, 'ok');
    notify('抢课成功', course.kcmc + ' 已选上');
    beep();
    state.claim[kchKey] = true;
    state.cooldown[kchKey] = 0;
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
    ? '服务器场景：请在本机重跑一次登录生成新的 ' + (cfg.stateFile || 'state.json') + ' 后传回服务器。'
    : '请重新运行本工具并手动登录（会话会自动复用已保存模板）。', 'warn');
  notify('选课工具会话过期', '需要重新登录');
  process.exitCode = 2;
}

async function runLoop(rc) {
  var built = matchLib.buildTargets(cfg.targets || {});
  state.targets = built.list;
  state.njdm = built.njdm;
  if (!state.targets.length) {
    log('没有配置目标课程：请编辑 config.json 的 targets（kch 课程号 / jxb 教学班ID / kw 关键词，至少填一个；njdm_id 年级过滤可选）', 'err');
    process.exitCode = 3;
    return;
  }
  log('======================================', 'info');
  log('开始' + (state.dryRun ? '干跑' : '实跑') + '：间隔 ' + state.interval + 's | 类别 kklxdm=' + state.kklxdm + ' | 目标 ' + state.targets.length + ' 条' + (state.dryRun ? '（只监控，不提交）' : ''), 'info');
  log('使用接口: ' + JSON.stringify(apiLib.buildEndpoints(cfg, templates)), 'dim');

  while (true) {
    try {
      await scanOnce(rc);
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
    '  node grab.js                         单账号运行；多账号时并发启动全部账号',
    '  node grab.js --prepare               逐账号登录/采集模板，完成后退出',
    '  node grab.js --account <id>          只运行指定账号',
    '  node grab.js --capture [--account]   打开浏览器抓包，按 Enter 保存',
    '  node grab.js --import-har FILE       从 HAR 导入指定账号的模板',
    '  node grab.js --list-accounts         列出配置中的账号',
    '  node grab.js --config FILE           使用指定配置文件',
    '  node grab.js --force-login           忽略已保存会话，强制重新登录',
    '  node grab.js --help                  显示本帮助',
    '',
    '接口路径可在 config.json 的 api 字段覆盖，例如:',
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
  log('已写入 ' + (cfg.templatesFile || 'templates.json'), 'ok');
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
  var rc = await ensureLogin();
  if (cli.prepare) {
    log('账号准备完成：会话和模板已保存，可以开始并发运行。', 'ok');
    try { await rc.dispose(); } catch (e) {}
    return;
  }
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
  process.exit(1);
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
