'use strict';

// Exercise the actual rob.js functions against browser fixtures without running
// the course-selection loop or changing the application's startup behavior.
var assert = require('node:assert/strict');
var fs = require('node:fs');
var http = require('node:http');
var path = require('node:path');
var vm = require('node:vm');
var createRequire = require('node:module').createRequire;
var test = require('node:test');
var playwright = require('playwright');

var root = path.resolve(__dirname, '..');
var sourceFile = path.join(root, 'rob.js');
var source = fs.readFileSync(sourceFile, 'utf8');
var startup = source.lastIndexOf('\nif (runAsSupervisor) {');
assert.ok(startup > 0, 'rob.js startup boundary must exist');
source = source.slice(0, startup);
var localRequire = createRequire(sourceFile);
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
var artifacts = fs.mkdtempSync(path.join(root, 'logs', 'login-test-'));
var executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
var edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!executablePath && process.platform === 'win32' && fs.existsSync(edge)) executablePath = edge;
var launchOptions = { headless: true };
if (executablePath) launchOptions.executablePath = executablePath;
var browser;
var server;
var origin;
var fixture;
var counter = 0;
var USER = 'fixture-student';
var PASS = 'fixture-Pa$&<>"\'\\!2026';
var selection = '/jwglxt/xsxk/zzxkyzb_cxZzxkYzbIndex.html';

function html(body) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>' +
    body + '</body></html>';
}

function form(options) {
  options = options || {};
  var native = options.native !== false;
  return '<form method="post" action="' + (native ? '/native-submit' : '/cas-submit') + '">' +
    '<input id="' + (native ? 'yhm' : 'username') + '" name="username">' +
    '<input id="' + (native ? 'mm' : 'password') + '" name="password" type="password">' +
    (options.captcha ? '<input id="yzm" name="yzm">' : '') +
    '<button id="' + (native ? 'dl' : 'login') + '" type="submit">Login</button></form>';
}

function send(res, body, headers) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers));
  res.end(html(body));
}

function redirect(res, target, cookies) {
  var headers = { Location: target };
  if (cookies) headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function serve(req, res) {
  var url = new URL(req.url, origin);
  var cookies = req.headers.cookie || '';
  fixture.requests.push({ method: req.method, path: url.pathname, cookies: cookies });
  if (req.method === 'POST') {
    var body = '';
    req.on('data', function (part) { body += part; });
    req.on('end', function () {
      var fields = new URLSearchParams(body);
      fixture.submissions.push({ user: fields.get('username'), pass: fields.get('password') });
      if (fields.get('username') !== USER || fields.get('password') !== PASS) {
        res.writeHead(403);
        res.end('Wrong fixture credentials');
        return;
      }
      if (url.pathname === '/native-submit') {
        redirect(res, '/jwglxt/xtgl/index_initMenu.html', ['JSESSIONID=native-session; Path=/; HttpOnly']);
      } else if (fixture.secondStage) {
        redirect(res, '/jwglxt/xtgl/login_slogin.html', ['proxy=proxy-session; Path=/; HttpOnly']);
      } else {
        redirect(res, '/jwglxt/xtgl/index_initMenu.html',
          ['proxy=proxy-session; Path=/; HttpOnly', 'JSESSIONID=cas-session; Path=/; HttpOnly']);
      }
    });
    return;
  }
  if (url.pathname === '/sso/lyiotlogin') {
    if (cookies.includes('proxy=proxy-session')) {
      redirect(res, '/jwglxt/xtgl/index_initMenu.html', ['JSESSIONID=resumed-session; Path=/; HttpOnly']);
    } else redirect(res, '/wengine-auth/login');
  } else if (url.pathname === '/wengine-auth/login') {
    var link = '<a id="cas-login" href="/cas/login"' +
      (fixture.popup ? ' target="_blank"' : '') + '>CAS Login</a>';
    send(res, fixture.iframe ? '<iframe src="/proxy-frame"></iframe>' : link);
  } else if (url.pathname === '/proxy-frame') {
    send(res, '<a id="cas-login" href="/cas/login" target="_top">CAS Login</a>');
  } else if (url.pathname === '/cas/login') {
    send(res, form({ native: false }));
  } else if (url.pathname === '/jwglxt/xtgl/login_slogin.html') {
    send(res, form());
  } else if (url.pathname === '/jwglxt/xtgl/index_initMenu.html') {
    send(res, '<title>Academic portal</title><p>Authenticated portal</p>');
  } else if (url.pathname === selection) {
    if (!cookies.includes('JSESSIONID=')) {
      redirect(res, '/jwglxt/xtgl/login_slogin.html');
    } else send(res, '<input name="bh_id" value="fixture-class">' +
      '<input name="xkxnm" value="2026"><input name="xkxqm" value="12">');
  } else {
    res.writeHead(404);
    res.end('No fixture');
  }
}

function harness(options) {
  options = options || {};
  var id = 'case' + (++counter);
  var logs = [];
  var launched = [];
  var account = {
    id: id,
    login: options.login || { username: USER, password: PASS },
    stateFile: path.join(artifacts, id + '.state.json'),
    templatesFile: path.join(artifacts, id + '.templates.json'),
    logFile: path.join(artifacts, id + '.log')
  };
  var raw = {
    base: origin + '/jwglxt', headless: true, loginTimeoutMin: 0.08,
    authMode: options.mode || 'zfsoft', accounts: [account], notify: { beep: false }
  };
  var context = {
    __dirname: root, __filename: sourceFile, URL: URL,
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    process: {
      argv: [process.execPath, sourceFile, '--prepare', '--account', id],
      stdin: process.stdin, stdout: process.stdout,
      exit: function (code) { throw new Error('ProcessExit:' + code); }
    },
    require: function (name) {
      if (name === './lib/config') {
        return Object.assign({}, localRequire(name), { loadRaw: function () { return raw; } });
      }
      if (name === './lib/notify') {
        return {
          makeLogger: function () {
            return { log: function (msg) { logs.push(msg); }, notify: function () {} };
          },
          beep: function () {}
        };
      }
      if (name === 'playwright') {
        return {
          chromium: {
            launch: async function () {
              var instance = await playwright.chromium.launch(launchOptions);
              launched.push(instance);
              return instance;
            }
          },
          request: playwright.request
        };
      }
      return localRequire(name);
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourceFile });
  return { app: context, logs: logs, account: account, launched: launched };
}

async function withPage(body, options, run) {
  var h = harness(options);
  var context = await browser.newContext();
  var page = await context.newPage();
  try {
    await page.setContent(html(body));
    return await run(h.app, page, h);
  } finally {
    await context.close();
  }
}

test.before(async function () {
  fixture = { requests: [], submissions: [] };
  server = http.createServer(serve);
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await playwright.chromium.launch(launchOptions);
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await new Promise(function (resolve) { server.close(resolve); });
  console.log('Fixture session artifacts: ' + artifacts);
});

test('zfsoft and wengine choose separate default entry URLs', function () {
  var native = harness().app;
  var proxy = harness({ mode: 'wengine' }).app;
  assert.equal(native.loginUrl(), origin + '/jwglxt/xtgl/login_slogin.html');
  assert.equal(proxy.loginUrl(), origin + '/sso/lyiotlogin');
  assert.equal(proxy.ssoUrl(), origin + '/sso/lyiotlogin');
});

test('configured entry URLs and CLI aliases are respected', function () {
  var app = harness({ mode: 'wengine' }).app;
  app.cfg.ssoPath = 'https://fixture.invalid/sso/custom';
  assert.equal(app.loginUrl(), app.cfg.ssoPath);
  app.cfg.authMode = 'zfsoft';
  app.cfg.zfsoftLoginPath = '/xtgl/custom-login.html';
  assert.equal(app.loginUrl(), origin + '/jwglxt/xtgl/custom-login.html');
  assert.equal(app.normaliseSsoMode('native'), 'zfsoft');
  assert.equal(app.normaliseSsoMode('proxy'), 'wengine');
  assert.throws(function () { app.normaliseSsoMode('invalid'); });
});

test('native prefill preserves special characters and emits input/change events', async function () {
  await withPage(form({ captcha: true }) +
    '<script>window.events=[];document.addEventListener("input",e=>events.push(e.target.id+":input"));' +
    'document.addEventListener("change",e=>events.push(e.target.id+":change"));</script>',
    {}, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.locator('#yhm').inputValue(), USER);
      assert.equal(await page.locator('#mm').inputValue(), PASS);
      assert.deepEqual(await page.evaluate(function () { return window.events; }),
        ['yhm:input', 'yhm:change', 'mm:input', 'mm:change']);
    });
});

test('visible CAPTCHA prevents automatic submit', async function () {
  await withPage(form({ captcha: true }) +
    '<script>window.submits=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();submits++}</script>',
    {}, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.evaluate(function () { return window.submits; }), 0);
    });
});

test('hidden CAPTCHA allows automatic submit', async function () {
  await withPage(form() + '<input id="yzm" style="display:none">' +
    '<script>window.submits=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();submits++}</script>',
    {}, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.evaluate(function () { return window.submits; }), 1);
    });
});

test('empty credentials leave manual fields untouched', async function () {
  await withPage(form({ captcha: true }), { login: {} }, async function (app, page) {
    await page.locator('#yhm').fill('manual-user');
    await page.locator('#mm').fill('manual-password');
    await app.autoFillLogin(page);
    assert.equal(await page.locator('#yhm').inputValue(), 'manual-user');
    assert.equal(await page.locator('#mm').inputValue(), 'manual-password');
  });
});

test('password-only configuration fills password without submitting', async function () {
  await withPage(form() +
    '<script>window.submits=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();submits++}</script>',
    { login: { password: PASS } }, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.locator('#mm').inputValue(), PASS);
      assert.equal(await page.locator('#yhm').inputValue(), '');
      assert.equal(await page.evaluate(function () { return window.submits; }), 0);
    });
});

test('CAS credentials are filled inside an iframe', async function () {
  await withPage('<iframe></iframe>', {}, async function (app, page) {
    var frame = page.frames()[1];
    await frame.setContent(html(form({ native: false, captcha: true })));
    await app.autoFillLogin(page);
    assert.equal(await frame.locator('#username').inputValue(), USER);
    assert.equal(await frame.locator('#password').inputValue(), PASS);
  });
});

test('delayed login form is retried at the same URL', async function () {
  await withPage('', {}, async function (app, page) {
    await page.route('**/cas/login', function (route) { return route.fulfill({ body: html('') }); });
    await page.goto(origin + '/cas/login');
    assert.equal(await app.handleLoginPage(page), false);
    assert.equal(app.loginHandledUrl, null);
    await page.setContent(html(form({ native: false, captcha: true })));
    assert.equal(await app.handleLoginPage(page), true);
    assert.equal(await page.locator('#password').inputValue(), PASS);
  });
});

test('QR login switches to account login when the switch is in a container', async function () {
  await withPage('<div><div id="qrcode">QR</div>' +
    '<button type="button" onclick="document.getElementById(\'account\').style.display=\'block\'">' +
    '\u8d26\u53f7\u767b\u5f55</button></div>' +
    '<section id="account" style="display:none">' + form({ native: false, captcha: true }) + '</section>',
    {}, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.locator('#username').inputValue(), USER);
      assert.equal(await page.locator('#password').inputValue(), PASS);
    });
});

test('hidden first matches do not conceal a visible password form', async function () {
  await withPage('<input type="password" style="display:none"><input name="account">' +
    '<input type="password"><button type="button">Continue</button>',
    {}, async function (app, page) {
      await app.autoFillLogin(page);
      assert.equal(await page.locator('input[name=account]').inputValue(), USER);
      assert.equal(await page.locator('input[type=password]').nth(1).inputValue(), PASS);
    });
});

test('pending login challenges prevent navigation to selection', async function () {
  await withPage(form({ captcha: true }), {}, async function (app, page) {
    await page.route('**/portal', function (route) { return route.fulfill({ body: html(form()) }); });
    await page.goto(origin + '/portal');
    assert.equal(await app.ensureSelectionPage(page), false);
    assert.equal(page.url(), origin + '/portal');
  });
});

test('a login form served at the selection URL is not an authenticated session', async function () {
  await withPage('', {}, async function (app, page) {
    await page.route('**/*', function (route) { return route.fulfill({ body: html(form()) }); });
    await page.goto(origin + selection);
    assert.equal(await app.isInAcademicSystem(page), false);
  });
});

async function prepareCase(options) {
  fixture = Object.assign({ requests: [], submissions: [] }, options);
  var h = harness({ mode: options.mode });
  try {
    await h.app.doLogin();
    assert.equal(fixture.submissions.length, 1, 'credentials must be submitted exactly once');
    assert.equal(fixture.submissions[0].user, USER);
    assert.equal(fixture.submissions[0].pass, PASS);
    var state = JSON.parse(fs.readFileSync(h.account.stateFile, 'utf8'));
    var session = state.cookies.find(function (c) { return c.name === 'JSESSIONID'; });
    assert.ok(session, 'academic session must be persisted');
    assert.equal(session.value, options.session);
    var templates = JSON.parse(fs.readFileSync(h.account.templatesFile, 'utf8'));
    assert.equal(templates.ctx.bh_id, 'fixture-class');
    assert.ok(h.launched.every(function (instance) { return !instance.isConnected(); }),
      'preparation must close its browser');
    if (options.mode === 'wengine') {
      assert.equal(fixture.requests[0].path, '/sso/lyiotlogin');
      assert.ok(state.cookies.some(function (c) { return c.name === 'proxy'; }));
    } else assert.equal(fixture.requests[0].path, '/jwglxt/xtgl/login_slogin.html');
    if (options.secondStage) {
      assert.ok(fixture.requests.filter(function (r) { return r.path === '/sso/lyiotlogin'; }).length >= 2);
    }
  } catch (error) {
    error.message += '\nApplication log:\n' + h.logs.join('\n') +
      '\nFixture requests:\n' + fixture.requests.map(function (r) {
        return r.method + ' ' + r.path;
      }).join('\n');
    throw error;
  } finally {
    for (var instance of h.launched) {
      if (instance.isConnected()) await instance.close();
    }
  }
}

test('zfsoft prepare: fill, submit, navigate, save cookie/context, close browser', async function () {
  await prepareCase({ mode: 'zfsoft', session: 'native-session' });
});

test('wengine prepare: SSO, CAS prefill, save both sessions, close browser', async function () {
  await prepareCase({ mode: 'wengine', session: 'cas-session' });
});

test('wengine prepare handles the CAS link inside an iframe', async function () {
  await prepareCase({ mode: 'wengine', iframe: true, session: 'cas-session' });
});

test('wengine prepare resumes SSO after returning to the native login page', async function () {
  await prepareCase({ mode: 'wengine', secondStage: true, session: 'resumed-session' });
});

test('wengine prepare follows a CAS login opened in a new tab', async function () {
  await prepareCase({ mode: 'wengine', popup: true, session: 'cas-session' });
});
