// lib/params.js — 参数解析/序列化/模板拼装（从 选课助手.user.js 移植，纯逻辑）
//
// 正方系统数组参数用 key[0]=x 格式（不是 key[]=x）。本文件提供 flatten() 把对象
// 拍平成 {'njdm_id_list[0]': '..', ...} 交给 Playwright 的 form 选项编码提交。

function deepCopy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 解析 application/x-www-form-urlencoded 字符串为对象（支持 key[0] 数组键）
function qsParse(str) {
  var obj = {};
  if (!str) return obj;
  var pairs = String(str).split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var eq = pairs[i].indexOf('=');
    var k = eq < 0 ? pairs[i] : pairs[i].slice(0, eq);
    var v = eq < 0 ? '' : pairs[i].slice(eq + 1);
    try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch (e) {}
    var m = k.match(/^([^\[]+)\[(\d+)\]$/);
    if (m) {
      var arr = obj[m[1]] || (obj[m[1]] = []);
      arr[Number(m[2])] = v;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

// 把对象拍平成 {'key[0]': val, 'key[1]': val, 'obj[sub]': val} 的扁平 form
function flatten(o) {
  var out = {};
  function walk(v, prefix) {
    if (v == null) return;
    if (Array.isArray(v)) {
      v.forEach(function (x, i) { walk(x, prefix + '[' + i + ']'); });
    } else if (typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        var key = prefix ? prefix + '[' + k + ']' : k;
        walk(v[k], key);
      });
    } else {
      out[prefix] = v;
    }
  }
  walk(o, '');
  return out;
}

function val() {
  for (var i = 0; i < arguments.length - 1; i++) { if (arguments[i] != null) return arguments[i]; }
  return arguments[arguments.length - 1];
}

function fmtXf(xf) { return String(xf == null ? '' : xf).replace(/\.0+$/, ''); }

// 从不同版本的响应外壳里取数组：tmpList / list / rows / items / data。
function extractList(res, keys) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== 'object') return [];
  var names = keys || ['tmpList', 'list', 'rows', 'items', 'data'];
  for (var i = 0; i < names.length; i++) {
    var k = names[i];
    if (Array.isArray(res[k])) return res[k];
    if (res.data && Array.isArray(res.data[k])) return res.data[k];
  }
  if (Array.isArray(res.data)) return res.data;
  return [];
}

function decodeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
}

function parseAttrs(tag) {
  var out = {};
  var re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  var m;
  while ((m = re.exec(tag))) {
    out[String(m[1]).toLowerCase()] = decodeHtml(m[3] != null ? m[3] : (m[4] != null ? m[4] : m[5]));
  }
  return out;
}

// 新版页面的“已选课程”是 HTML 片段（zzxkyzb_cxZzxkYzbChoosed.html），
// 不是旧版的 JSON ChoosedDisplay。这里把常见的 right_* 隐藏字段提取成课程对象。
function parseChoosedHtml(html) {
  var text = String(html || '').trim();
  if (!text || text.charAt(0) !== '<') return [];
  var blocks = text.split(/<div[^>]*class=["'][^"']*outer_xkxx_list[^"']*["'][^>]*>/i);
  if (blocks.length <= 1) blocks = [text];
  var out = [];
  var seen = {};
  blocks.forEach(function (block) {
    var inputs = block.match(/<input\b[^>]*>/gi) || [];
    if (!inputs.length) return;
    var fields = {};
    inputs.forEach(function (tag) {
      var a = parseAttrs(tag);
      var name = a.name || '';
      if (!name) return;
      fields[name] = a.value || '';
      if (name.indexOf('right_') === 0) fields[name.slice(6)] = a.value || '';
    });
    var c = {
      jxb_id: fields.jxb_id || fields.right_jxb_id || '',
      kch_id: fields.kch_id || fields.right_kchid || fields.right_sub_kchid || '',
      kch: fields.kch || fields.right_kch || fields.right_kchid || '',
      kcmc: fields.kcmc || fields.right_kcmc || '',
      do_jxb_id: fields.do_jxb_id || fields.right_do_jxb_id || fields.right_jxb_ids || '',
      sksj: fields.sksj || fields.right_sksj || '',
      xf: fields.xf || fields.right_xf || '',
      kklxdm: fields.kklxdm || fields.right_kklxdm || '',
      rwlx: fields.rwlx || fields.right_rwlx || ''
    };
    if (!c.jxb_id && !c.kch_id && !c.do_jxb_id) return;
    var key = c.jxb_id || c.kch_id || c.do_jxb_id;
    if (seen[key]) return;
    seen[key] = true;
    out.push(c);
  });
  return out;
}

// 统一处理 JSON 数组、{tmpList:...} 外壳和 HTML 片段。
function normaliseChoosed(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (typeof res === 'string') return parseChoosedHtml(res);
  if (res.__html) return parseChoosedHtml(res.__html);
  var list = extractList(res, ['tmpList', 'list', 'rows', 'items']);
  if (list.length) return list;
  return parseChoosedHtml(res.html || res.body || '');
}

// 从列表/详情对象里取 xkkz_id（直取，或从 xkgz 规则串第5段取）
function pickXkkzFromObj(obj) {
  if (!obj) return null;
  if (obj.xkkz_id) return String(obj.xkkz_id);
  if (typeof obj.xkgz === 'string' && obj.xkgz.indexOf('~') > -1) {
    var parts = obj.xkgz.split('~');
    if (parts.length >= 5) return parts[4];
  }
  return null;
}

// PartDisplay 查询参数：query 模板为准，缺的用 ctx 兜底，覆盖类别/分页
function buildQueryParams(templates, kklxdm) {
  var store = templates || {};
  var base = store.query ? deepCopy(store.query)
    : (store.display ? deepCopy(store.display) : (store.ctx ? deepCopy(store.ctx) : {}));
  var ctx = store.ctx;
  if (ctx) {
    var need = ['jg_id', 'zyh_id', 'zyfx_id', 'bh_id', 'njdm_id', 'xz', 'ccdm', 'xbm', 'mzm', 'xslbdm', 'xsbj', 'xkxnm', 'xkxqm'];
    for (var i = 0; i < need.length; i++) {
      if (base[need[i]] == null && ctx[need[i]] != null) base[need[i]] = ctx[need[i]];
    }
    if (base.njdm_id_list == null && ctx.njdm_id_list) base.njdm_id_list = ctx.njdm_id_list;
    if (base.jg_id_list == null && ctx.jg_id_list) base.jg_id_list = ctx.jg_id_list;
  }
  if (kklxdm) base.kklxdm = kklxdm;
  if (base.rwlx == null) base.rwlx = '2';
  if (base.xkly == null) base.xkly = '0';
  base.kspage = '1';
  base.jspage = '50';
  // 少数新版/定制版分页字段不同；只在模板里本来就有该字段时才覆盖。
  if (base.pageNum != null) base.pageNum = '1';
  if (base.pageSize != null) base.pageSize = '50';
  if (base.page != null) base.page = '1';
  if (base.limit != null) base.limit = '50';
  if (base.jxbzb == null) base.jxbzb = '';
  return base;
}

// 展开教学班详情（拿 do_jxb_id）的参数
// 服务端做全上下文校验：参数不全就返回 "0"（无可用教学班）。必须带完整学生上下文
// （query 模板最全），只去掉查询专用的分页字段。已由 diag3 实测验证。
function fetchJxbParams(templates, course, kklxdm) {
  var store = templates || {};
  // 优先复用页面真实发出的详情请求；不同学校/版本的详情接口字段差异很大。
  // 没有详情模板时退回 query 模板（旧版行为）。
  var base = store.detail ? deepCopy(store.detail)
    : (store.query ? deepCopy(store.query)
      : (store.display ? deepCopy(store.display) : (store.ctx ? deepCopy(store.ctx) : {})));
  ['kspage', 'jspage', 'jxbzb', 'bhjzckb'].forEach(function (k) { delete base[k]; });
  Object.assign(base, {
    xkxskcgskg: '1',
    kklxdm: course.kklxdm || kklxdm || base.kklxdm || '10',
    kch_id: course.kch_id || course.kch,
    jxbzcxskg: '0',
    xkkz_id: store.xkkz || '',
    cxbj: '0',
    fxbj: '0'
  });
  return base;
}

// 提交选课参数：优先用真实提交模板 submit，缺的字段用兜底逻辑
function buildSubmitParams(templates, course, detail, kklxdm) {
  var store = templates || {};
  var p = store.submit ? deepCopy(store.submit) : {};
  p.jxb_ids = detail.do_jxb_id || detail.jxb_ids || p.jxb_ids;
  p.kch_id = course.kch_id || course.kch;
  var xf = fmtXf(course.xf != null ? course.xf : detail.xf);
  p.kcmc = '(' + (course.kch || course.kch_id) + ')' + course.kcmc + ' - ' + xf + ' 学分';
  if (store.xkkz) p.xkkz_id = store.xkkz;
  var ctx = store.ctx;
  if (ctx) {
    if (ctx.xkxnm) p.xkxnm = ctx.xkxnm;
    if (ctx.xkxqm) p.xkxqm = ctx.xkxqm;
    if (ctx.njdm_id) p.njdm_id = ctx.njdm_id;
    if (ctx.zyh_id) p.zyh_id = ctx.zyh_id;
  }
  p.kklxdm = course.kklxdm || p.kklxdm || kklxdm || '10';
  // zzxkYzb.js 的 chooseCourseZzxk(jxb_id, do_jxb_id, kch_id, jxbzls)
  // 会把 jxbzls 一起提交；详情响应里通常有这个字段。
  if (p.jxbzls == null) p.jxbzls = detail.jxbzls != null ? detail.jxbzls : (course.jxbzls || '');
  if (!p.xkkz_id) p.xkkz_id = detail.xkkz_id || store.xkkz || '';
  ['rwlx', 'rlkz', 'rlzlkz', 'sxbj', 'xxkbj', 'qz', 'cxbj', 'fxbj', 'kklxdm'].forEach(function (k) {
    if (p[k] == null && detail[k] != null) p[k] = detail[k];
  });
  if (!store.submit) {
    // 没有真实提交模板时的兜底字段（尽力而为）
    p.rwlx = val(course.rwlx, detail.rwlx, '2');
    p.rlkz = val(course.rlkz, detail.rlkz, '0');
    p.rlzlkz = val(course.rlzlkz, detail.rlzlkz, '1');
    p.sxbj = val(course.sxbj, detail.sxbj, '0');
    p.xxkbj = val(course.xxkbj, detail.xxkbj, '0');
    p.qz = val(course.qz, detail.qz, '0');
    p.cxbj = '0';
    p.xklc = val(course.xklc, detail.xklc, '2');
    p.xkly = val(course.xkly, detail.xkly, ctx && ctx.xkly, '0');
  }
  return p;
}

// 前置探针：有些版本在真正提交前先调 cxXkTitleMsg 判断本轮是否可操作。
// 只在抓到了 title 模板时才调用（见 grab.js），避免对没有这个接口的学校乱发请求。
function buildTitleParams(templates, course, detail, kklxdm) {
  var store = templates || {};
  var p = store.title ? deepCopy(store.title) : {};
  if (!store.title) return null;
  p.kch_id = course.kch_id || course.kch;
  p.jxb_ids = detail.do_jxb_id || detail.jxb_ids || p.jxb_ids;
  p.xkkz_id = detail.xkkz_id || store.xkkz || p.xkkz_id || '';
  p.kklxdm = course.kklxdm || p.kklxdm || kklxdm || '10';
  if (p.jxbzls == null) p.jxbzls = detail.jxbzls != null ? detail.jxbzls : '';
  var ctx = store.ctx;
  if (ctx) {
    if (ctx.xkxnm) p.xkxnm = ctx.xkxnm;
    if (ctx.xkxqm) p.xkxqm = ctx.xkxqm;
    if (ctx.njdm_id) p.njdm_id = ctx.njdm_id;
  }
  return p;
}

// 退选后的批次刷新：抓到了 xkBcZypx 模板才会调用。
function buildBatchParams(templates, kklxdm) {
  var store = templates || {};
  if (!store.batch) return null;
  var p = deepCopy(store.batch);
  var ctx = store.ctx;
  if (ctx) {
    if (ctx.xkxnm) p.xkxnm = ctx.xkxnm;
    if (ctx.xkxqm) p.xkxqm = ctx.xkxqm;
    if (ctx.njdm_id) p.njdm_id = ctx.njdm_id;
    if (ctx.jg_id) p.jg_id = ctx.jg_id;
  }
  if (store.xkkz) p.xkkz_id = store.xkkz;
  p.kklxdm = kklxdm || p.kklxdm || '10';
  return p;
}

function fetchChoosedParams(templates) {
  return deepCopy(templates.choosed || templates.ctx || {});
}

function dropCourseParams(templates, c) {
  var store = templates || {};
  var p = store.drop ? deepCopy(store.drop) : {};
  p.kch_id = c.kch_id || c.kch;
  p.jxb_ids = c.do_jxb_id || c.jxb_ids || p.jxb_ids;
  if (p.jxbzls == null) p.jxbzls = c.jxbzls != null ? c.jxbzls : '';
  if (store.ctx) {
    if (store.ctx.xkxnm) p.xkxnm = store.ctx.xkxnm;
    if (store.ctx.xkxqm) p.xkxqm = store.ctx.xkxqm;
  }
  if (store.xkkz) p.xkkz_id = store.xkkz;
  if (c.kklxdm) p.kklxdm = c.kklxdm;
  if (c.rwlx) p.rwlx = c.rwlx;
  if (p.txbsfrl == null) p.txbsfrl = '0';
  return p;
}

module.exports = {
  deepCopy: deepCopy,
  sleep: sleep,
  qsParse: qsParse,
  flatten: flatten,
  val: val,
  fmtXf: fmtXf,
  extractList: extractList,
  parseChoosedHtml: parseChoosedHtml,
  normaliseChoosed: normaliseChoosed,
  pickXkkzFromObj: pickXkkzFromObj,
  buildQueryParams: buildQueryParams,
  fetchJxbParams: fetchJxbParams,
  buildSubmitParams: buildSubmitParams,
  buildTitleParams: buildTitleParams,
  buildBatchParams: buildBatchParams,
  fetchChoosedParams: fetchChoosedParams,
  dropCourseParams: dropCourseParams
};
