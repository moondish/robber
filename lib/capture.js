// lib/capture.js — 网络层采集 / HAR 导入 / 接口自动识别
//
// 采集内容刻意只保留“重放请求需要的东西”：
//   - 请求 URL、method、content-type、少量安全请求头
//   - 表单/JSON 请求体（后续会作为模板）
//   - 响应 JSON（默认每个接口最多保留 3 条记录，避免 templates.json 膨胀）
//
// 不保存 Cookie / Authorization / Set-Cookie；会话由 state.json 单独管理。

'use strict';

var api = require('./api');
var params = require('./params');

function createStore() {
  return {
    ctx: null,       // 学生上下文（bh_id/jg_id/zyh_id/...）
    query: null,     // 列表查询模板
    detail: null,    // 教学班详情模板
    submit: null,    // 真实提交模板
    drop: null,      // 真实退选模板
    choosed: null,   // 已选列表请求模板（可能为空）
    xkkz: null,      // 选课控制 ID
    api: {},         // 抓到的接口路径
    meta: {},        // 每个接口的 method/content-type/安全请求头
    responses: {},   // 每个接口最近一次响应（裁剪后）
    pendingRequests: {}, // 按 URL 暂存请求体，用于响应识别出接口后回填模板
    warnings: []
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  var target = String(name).toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === target) return String(headers[keys[i]] || '');
  }
  return '';
}

function parseBody(text, headers) {
  var t = String(text || '').trim();
  if (!t) return null;
  var ct = headerValue(headers, 'content-type');
  if (/json/i.test(ct) || t.charAt(0) === '{' || t.charAt(0) === '[') {
    try { return JSON.parse(t); } catch (e) {}
  }
  if (/x-www-form-urlencoded/i.test(ct) || /^[^=&\s]+=[^&]*(&|$)/.test(t)) {
    var obj = params.qsParse(t);
    return Object.keys(obj).length ? obj : null;
  }
  return null;
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o || {}, k);
}

function findXkkz(obj) {
  if (!obj) return null;
  var direct = params.pickXkkzFromObj(obj);
  if (direct) return direct;
  var list = Array.isArray(obj.tmpList) ? obj.tmpList : (Array.isArray(obj) ? obj : []);
  for (var i = 0; i < list.length; i++) {
    var x = params.pickXkkzFromObj(list[i]);
    if (x) return x;
  }
  return null;
}

function inferKindFromBody(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && (hasOwn(obj[0], 'do_jxb_id') || hasOwn(obj[0], 'jxb_id'))) return 'choosed';
    return null;
  }
  if (Array.isArray(obj.tmpList)) return 'query';
  if (hasOwn(obj, 'flag') && (hasOwn(obj, 'msg') || hasOwn(obj, 'message'))) return 'submit';
  if (hasOwn(obj, 'success')) return 'submit';
  if (hasOwn(obj, 'do_jxb_id') || hasOwn(obj, 'jxb_ids')) return 'detail';
  return null;
}

function inferKindFromRequestBody(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.txbsfrl != null) return 'drop';
  if (obj.jxb_ids && obj.kch_id) {
    if (obj.kcmc || obj.rwlx || obj.sxbj || obj.xxkbj || obj.xklc) return 'submit';
    return 'title';
  }
  if (obj.kspage != null || obj.jspage != null) return 'query';
  if (obj.kch_id && (obj.xkkz_id || obj.jxbzcxskg)) return 'detail';
  return null;
}

function applyBodyTemplate(store, key, body) {
  if (!key || !body || typeof body !== 'object' || Array.isArray(body)) return;
  function richer(existing) {
    if (!existing) return true;
    return Object.keys(body).length > Object.keys(existing).length;
  }
  if (body.bh_id && richer(store.ctx)) store.ctx = params.deepCopy(body);
  if (key === 'query' && richer(store.query)) store.query = params.deepCopy(body);
  if (key === 'display' && richer(store.display)) store.display = params.deepCopy(body);
  if (key === 'detail' && richer(store.detail)) store.detail = params.deepCopy(body);
  if (key === 'submit' && richer(store.submit)) store.submit = params.deepCopy(body);
  if (key === 'drop' && richer(store.drop)) store.drop = params.deepCopy(body);
  if (key === 'choosed' && richer(store.choosed)) store.choosed = params.deepCopy(body);
  var xk = findXkkz(body);
  if (xk && !store.xkkz) store.xkkz = String(xk);
}

function recordEndpoint(store, key, url, base) {
  if (!key) return null;
  var path = api.pathFromUrl(url, base);
  if (!path) return null;
  // 同一逻辑接口同时存在 HTML/JSON 入口时，固定优先使用 JSON Display 版本，
  // 避免两个页面的自动请求让路径每轮来回切换。
  if (key === 'choosed' && store.api[key] &&
      /ChoosedDisplay/i.test(store.api[key]) && !/ChoosedDisplay/i.test(path)) return null;
  if (key === 'query' && store.api[key] &&
      /PartDisplay/i.test(store.api[key]) && !/PartDisplay/i.test(path)) return null;
  if (store.api[key] !== path) {
    store.api[key] = path;
    return path;
  }
  return null;
}

function recordRequest(store, info, options) {
  var base = (options && options.base) || '';
  var key = api.classify(info.url);
  var learned = recordEndpoint(store, key, info.url, base);
  var rawBody = info.postData;
  if (!rawBody && /get/i.test(String(info.method || ''))) {
    try { rawBody = new URL(info.url).search.replace(/^\?/, ''); } catch (e) {}
  }
  var body = parseBody(rawBody, info.headers);
  var inferred = null;

  if (!key) {
    inferred = inferKindFromRequestBody(body);
    key = inferred;
    if (key) learned = recordEndpoint(store, key, info.url, base) || learned;
  }

  if (body) {
    store.pendingRequests[info.url] = { body: params.deepCopy(body), method: info.method };
  }

  if (key) {
    var contentType = headerValue(info.headers, 'content-type');
    if (!contentType && rawBody && /^\s*[\[{]/.test(String(rawBody))) contentType = 'application/json';
    store.meta[key] = {
      method: String(info.method || 'POST').toUpperCase(),
      contentType: contentType,
      headers: api.safeHeaders(info.headers)
    };
  }

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (key === 'query' || key === 'display' || key === 'detail' || key === 'submit' || key === 'drop' || key === 'choosed') {
      applyBodyTemplate(store, key, body);
    } else if (body.bh_id && !store.ctx) {
      store.ctx = params.deepCopy(body);
    }
    var xk = findXkkz(body);
    if (xk && !store.xkkz) store.xkkz = String(xk);
  }

  return { kind: key, learned: learned, inferred: inferred, body: body };
}

function trimResponse(obj) {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 3);
  if (typeof obj === 'object' && Array.isArray(obj.tmpList)) {
    var copy = params.deepCopy(obj);
    copy.tmpList = copy.tmpList.slice(0, 3);
    return copy;
  }
  return params.deepCopy(obj);
}

var CONTEXT_FIELDS = {
  bh_id: 1, jg_id: 1, jg_id_1: 1, zyh_id: 1, zyh_id_1: 1, zyfx_id: 1,
  njdm_id: 1, njdm_id_1: 1, xz: 1, ccdm: 1, xbm: 1, mzm: 1, xslbdm: 1,
  xsbj: 1, xkxnm: 1, xkxqm: 1, xkly: 1, xklc: 1, rwlx: 1, kklxdm: 1,
  xqh_id: 1, xszxzt: 1, xkkz_id: 1, xkkz_xh: 1, firstKklxdm: 1,
  firstXkkzId: 1, firstXkkzXh: 1, bklx_id: 1, sfkxq: 1, sfkcfx: 1,
  sfkkjyxdxnxq: 1, kzkcgs: 1, gnjkxdnj: 1, xkzgbj: 1, rlkz: 1,
  rlzlkz: 1, sfkknj: 1, sfkkzy: 1, kzybkxy: 1, sfznkx: 1, zdkxms: 1,
  bhbcyxkjxb: 1, kkbk: 1, kkbkdj: 1, bklbkcj: 1, sfkgbcx: 1,
  sfrxtgkcxd: 1, tykczgxdcs: 1, bbhzxjxb: 1, zxgbxkkg: 1
};

function htmlInputFields(html) {
  var out = {};
  var tagRe = /<input\b([^>]*)>/gi;
  var tag;
  while ((tag = tagRe.exec(String(html || '')))) {
    var attrs = tag[1] || '';
    var nameMatch = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!nameMatch) continue;
    var name = nameMatch[1] || nameMatch[2] || nameMatch[3] || '';
    if (!CONTEXT_FIELDS[name]) continue;
    var valueMatch = attrs.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    out[name] = valueMatch ? (valueMatch[1] || valueMatch[2] || valueMatch[3] || '') : '';
  }
  return out;
}

function applyHtmlContext(store, body) {
  if (typeof body !== 'string' || body.indexOf('<input') < 0) return;
  var fields = htmlInputFields(body);
  if (!Object.keys(fields).length) return;
  var ctx = store.ctx ? params.deepCopy(store.ctx) : {};
  Object.keys(fields).forEach(function (k) { ctx[k] = fields[k]; });
  if (!ctx.jg_id && ctx.jg_id_1) ctx.jg_id = ctx.jg_id_1;
  if (!ctx.zyh_id && ctx.zyh_id_1) ctx.zyh_id = ctx.zyh_id_1;
  if (!ctx.njdm_id && ctx.njdm_id_1) ctx.njdm_id = ctx.njdm_id_1;
  if (ctx.firstKklxdm) ctx.kklxdm = ctx.firstKklxdm;
  if (ctx.firstXkkzId) ctx.xkkz_id = ctx.firstXkkzId;
  if (ctx.firstXkkzXh) ctx.xkkz_xh = ctx.firstXkkzXh;
  store.ctx = ctx;
  var xk = fields.firstXkkzId || fields.xkkz_id || params.pickXkkzFromObj(ctx);
  if (xk) store.xkkz = String(xk);
}

function recordResponse(store, info, options) {
  var base = (options && options.base) || '';
  var key = api.classify(info.url);
  var parsed = parseBody(info.body, info.headers);
  var inferred = null;

  if (!key) {
    var pending = store.pendingRequests && store.pendingRequests[info.url];
    if (pending) key = inferKindFromRequestBody(pending.body);
    inferred = inferKindFromBody(parsed);
    if (!key) key = inferred;
    // 数组响应既可能是已选列表，也可能是详情列表；请求里带 kch_id 时按详情处理。
    if (key === 'choosed' && pending && pending.body && pending.body.kch_id) key = 'detail';
  }
  if (!key) return { kind: null };

  applyHtmlContext(store, info.body);

  var learned = null;
  // 有些版本把列表查询也放在 cxZzxkYzbDisplay；如果它返回 tmpList，就当作 query。
  if (key === 'display' && inferKindFromBody(parsed) === 'query') {
    key = 'query';
    learned = recordEndpoint(store, 'query', info.url, base);
  }

  var nextLearned = recordEndpoint(store, key, info.url, base);
  if (nextLearned) learned = nextLearned;
  if (learned && inferred) {
    // 路径名不可识别，但响应结构可以识别：仍然把真实路径记下来。
    store.api[key] = learned;
  }
  // 路径名不可识别但响应结构可识别时，用暂存的请求体回填模板。
  var pendingReq = store.pendingRequests && store.pendingRequests[info.url];
  if (pendingReq && pendingReq.body) applyBodyTemplate(store, key, pendingReq.body);

  store.responses[key] = {
    url: api.pathFromUrl(info.url, base),
    status: info.status || 0,
    body: trimResponse(parsed)
  };

  var xk = findXkkz(parsed);
  if (xk && !store.xkkz) store.xkkz = String(xk);

  return { kind: key, learned: learned, inferred: inferred, body: parsed };
}

// 把 Playwright 页面上的请求/响应接入采集器。
// onEvent({type:'request'|'response', kind, learned, inferred, store}) 可选。
function attach(page, store, options) {
  options = options || {};

  page.on('request', function (req) {
    try {
      if (!api.classify(req.url()) && !/\/xsxk\//i.test(req.url())) return;
      var ev = recordRequest(store, {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData()
      }, options);
      if (options.onEvent && (ev.kind || ev.learned)) {
        options.onEvent({ type: 'request', kind: ev.kind, learned: ev.learned, store: store });
      }
    } catch (e) {
      store.warnings.push('request capture: ' + e.message);
    }
  });

  page.on('response', function (res) {
    try {
      var headers = res.headers();
      var len = Number(headerValue(headers, 'content-length') || 0);
      // 采集只关心选课模块；跳过认证页、JS/CSS 和静态资源，降低登录卡顿。
      if (len > 1024 * 1024) return;
      if (!api.classify(res.url()) && !/\/xsxk\//i.test(res.url())) return;
      res.text().then(function (text) {
        try {
          var ev = recordResponse(store, {
            url: res.url(),
            status: res.status(),
            headers: headers,
            body: text
          }, options);
          if (options.onEvent && (ev.kind || ev.learned)) {
            options.onEvent({
              type: 'response',
              kind: ev.kind,
              learned: ev.learned,
              inferred: ev.inferred,
              store: store
            });
          }
        } catch (e) {
          store.warnings.push('response capture: ' + e.message);
        }
      }).catch(function (e) {
        store.warnings.push('response body: ' + e.message);
      });
    } catch (e) {
      store.warnings.push('response capture: ' + e.message);
    }
  });
}

function harHeaders(list) {
  var out = {};
  (list || []).forEach(function (h) {
    if (h && h.name) out[h.name] = h.value;
  });
  return out;
}

function harRequestBody(req) {
  var pd = req && req.postData;
  if (!pd) return '';
  if (typeof pd.text === 'string') return pd.text;
  if (Array.isArray(pd.params)) {
    return pd.params.map(function (p) {
      return encodeURIComponent(p.name) + '=' + encodeURIComponent(p.value == null ? '' : p.value);
    }).join('&');
  }
  return '';
}

function importHar(store, har, options) {
  var entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
  var counts = { entries: entries.length, requests: 0, responses: 0, kinds: {} };
  entries.forEach(function (entry) {
    if (!entry || !entry.request) return;
    var req = entry.request;
    var reqHeaders = harHeaders(req.headers);
    var reqInfo = {
      url: req.url,
      method: req.method,
      headers: reqHeaders,
      postData: harRequestBody(req)
    };
    var ev = recordRequest(store, reqInfo, options);
    counts.requests++;
    if (ev.kind && !counts.kinds[ev.kind]) counts.kinds[ev.kind] = 1;

    var resp = entry.response;
    if (!resp) return;
    var respHeaders = harHeaders(resp.headers);
    var body = resp.content && typeof resp.content.text === 'string' ? resp.content.text : '';
    if (!body) return;
    var ev2 = recordResponse(store, {
      url: req.url,
      status: resp.status,
      headers: respHeaders,
      body: body
    }, options);
    counts.responses++;
    if (ev2.kind && !counts.kinds[ev2.kind]) counts.kinds[ev2.kind] = 1;
  });
  return counts;
}

function missingKinds(store) {
  return ['query', 'detail', 'submit', 'choosed'].filter(function (k) {
    return !store || !store.api || !store.api[k];
  });
}

function summary(store) {
  return {
    api: (store && store.api) ? params.deepCopy(store.api) : {},
    hasCtx: !!(store && store.ctx),
    hasQuery: !!(store && store.query),
    hasDetail: !!(store && store.detail),
    hasSubmit: !!(store && store.submit),
    hasDrop: !!(store && store.drop),
    xkkz: store && store.xkkz ? String(store.xkkz) : '',
    missing: missingKinds(store)
  };
}

module.exports = {
  createStore: createStore,
  parseBody: parseBody,
  recordRequest: recordRequest,
  recordResponse: recordResponse,
  attach: attach,
  importHar: importHar,
  summary: summary,
  missingKinds: missingKinds
};
