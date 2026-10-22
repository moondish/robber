// lib/api.js — 选课接口地址表、请求归类与路径解析
//
// 正方不同版本/不同学校的选课接口路径不完全一样。这里做三件事：
//   1. 给出一套常见的默认路径（保持旧版兼容）；
//   2. 允许 config.api 覆盖任意一个接口；
//   3. 从浏览器抓到的真实请求里自动学习路径，写进 templates.json 的 api 字段。
//
// 约定：api 里的值既可以写成相对 cfg.base 的路径（/xsxk/xxx.html），
// 也可以写完整 URL（http://host/jwglxt/xsxk/xxx.html）。

'use strict';

var DEFAULTS = {
  index: '/xsxk/zzxkyzb_cxZzxkYzbIndex.html',
  display: '/xsxk/zzxkyzb_cxZzxkYzbDisplay.html',
  query: '/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html',
  detail: '/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html',
  submit: '/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html',
  choosed: '/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html',
  drop: '/xsxk/zzxkyzb_tuikBcZzxkYzb.html',
  title: '/xsxk/zzxkyzb_cxXkTitleMsg.html',
  batch: '/xsxk/zzxkyzb_xkBcZypx.html',
  subdetail: '/xsxk/zzxkyzb_cxZkcZzxkYzb.html',
  notice: '/xsxk/zzxkyzb_cxXsXktsxx.html'
};

var KEYS = Object.keys(DEFAULTS);

// 顺序很重要：先匹配更具体的接口，避免 xkBcZypx 被 xkBcZy 吃掉。
var PATTERNS = [
  ['choosed', /cxZzxkYzbChoosed|ChoosedDisplay/i],
  ['subdetail', /cxZkcZzxkYzb/i],
  ['notice', /cxXsXktsxx/i],
  ['query', /cxZzxkYzbPartDisplay|PartDisplay/i],
  ['display', /cxZzxkYzbDisplay/i],
  ['detail', /cxJxbWithKchZzxkYzb|JxbWithKch/i],
  ['title', /cxXkTitleMsg|XkTitleMsg/i],
  ['batch', /xkBcZypx|BcZypx/i],
  ['drop', /tuikBc|TuiKBc|tuiKBc/i],
  ['submit', /xkBcZyZzxkYzb|xkBcZy(?!Zypx)/i],
  ['index', /cxZzxkYzbIndex|xsxk.*Index/i]
];

function isAbsolute(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isSelectionPath(p) {
  return /\/xsxk\/|zzxkyzb/i.test(String(p || ''));
}

function isReverseProxyAuthUrl(url) {
  return /webauth|wengine-auth/i.test(String(url || ''));
}

function isLoginUrl(url) {
  var u = String(url || '');
  return isReverseProxyAuthUrl(u) ||
    /\/login(?:_|\.|\/|\?|$)|login_slogin|\/cas(?:[/?]|$)|authserver|\/sso(?:[/?]|$)/i.test(u);
}

function classify(url) {
  var u = String(url || '');
  if (!u) return null;
  for (var i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i][1].test(u)) return PATTERNS[i][0];
  }
  return null;
}

function stripHash(url) {
  return String(url || '').split('#')[0];
}

// 去掉防缓存/随机参数，其余参数保留（有些学校会把 jsdm/xklc/xkxnm 放在 URL 上）。
function stableSearch(search) {
  var s = String(search || '').replace(/^\?/, '');
  if (!s) return '';
  var keep = [];
  var skip = { nd: 1, time: 1, _: 1, r: 1, t: 1, ts: 1, random: 1, timestamp: 1 };
  var pairs = s.split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var k = pairs[i].split('=')[0];
    if (!skip[k]) keep.push(pairs[i]);
  }
  return keep.length ? '?' + keep.join('&') : '';
}

function basePath(base) {
  try {
    var u = new URL(base);
    return u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// 把浏览器里的完整 URL 转成“相对 cfg.base”的路径；如果不在 base 下则保留完整路径。
function pathFromUrl(url, base) {
  var u = String(url || '');
  if (!u) return '';
  try {
    var parsed = new URL(u, base || undefined);
    var bp = basePath(base);
    var pathname = parsed.pathname || '/';
    if (bp && (pathname === bp || pathname.indexOf(bp + '/') === 0)) {
      pathname = pathname.slice(bp.length) || '/';
    }
    return pathname + stableSearch(parsed.search);
  } catch (e) {
    return u;
  }
}

function normaliseEndpoint(value) {
  var v = String(value || '').trim();
  if (!v) return '';
  if (isAbsolute(v)) {
    try {
      var u = new URL(v);
      return u.pathname + stableSearch(u.search);
    } catch (e) {
      return v;
    }
  }
  return v.charAt(0) === '/' ? v : '/' + v;
}

// 合并默认值、config.indexPath、抓包学到的路径、config.api。
// 优先级：config.api（显式覆盖）> 抓包 > config.indexPath > 默认值。
function buildEndpoints(cfg, captured) {
  var out = {};
  KEYS.forEach(function (k) { out[k] = DEFAULTS[k]; });
  cfg = cfg || {};
  captured = captured || {};

  if (cfg.indexPath) out.index = normaliseEndpoint(cfg.indexPath);
  if (captured.api && typeof captured.api === 'object') {
    KEYS.forEach(function (k) {
      if (captured.api[k]) out[k] = normaliseEndpoint(captured.api[k]);
    });
  }
  if (cfg.api && typeof cfg.api === 'object') {
    KEYS.forEach(function (k) {
      if (cfg.api[k]) out[k] = normaliseEndpoint(cfg.api[k]);
    });
  }
  return out;
}

function endpointPath(cfg, key, templates) {
  var endpoints = buildEndpoints(cfg, templates);
  return endpoints[key] || DEFAULTS[key] || '';
}

function resolveUrl(base, endpoint) {
  var e = String(endpoint || '');
  if (isAbsolute(e)) return e;
  return String(base || '').replace(/\/+$/, '') + (e.charAt(0) === '/' ? e : '/' + e);
}

function withGnmkdm(url, gnmkdm, enabled) {
  if (enabled === false || !gnmkdm || /[?&]gnmkdm=/.test(String(url || ''))) return url;
  var u = String(url || '');
  var hash = '';
  var hi = u.indexOf('#');
  if (hi > -1) {
    hash = u.slice(hi);
    u = u.slice(0, hi);
  }
  return u + (u.indexOf('?') < 0 ? '?' : '&') + 'gnmkdm=' + encodeURIComponent(gnmkdm) + hash;
}

function safeHeaders(headers) {
  var out = {};
  var src = headers || {};
  var allowed = {
    'accept': 1,
    'accept-language': 1,
    'content-type': 1,
    'origin': 1,
    'referer': 1,
    'x-requested-with': 1,
    'x-csrf-token': 1,
    'x-token': 1
  };
  Object.keys(src).forEach(function (k) {
    var lk = String(k).toLowerCase();
    if (allowed[lk] && src[k] != null) out[lk] = String(src[k]);
  });
  return out;
}

module.exports = {
  DEFAULTS: DEFAULTS,
  KEYS: KEYS,
  classify: classify,
  isAbsolute: isAbsolute,
  isSelectionPath: isSelectionPath,
  isReverseProxyAuthUrl: isReverseProxyAuthUrl,
  isLoginUrl: isLoginUrl,
  pathFromUrl: pathFromUrl,
  normaliseEndpoint: normaliseEndpoint,
  buildEndpoints: buildEndpoints,
  endpointPath: endpointPath,
  resolveUrl: resolveUrl,
  withGnmkdm: withGnmkdm,
  safeHeaders: safeHeaders
};
