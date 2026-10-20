// lib/config.js — 单账号/多账号配置解析
//
// 设计目标：
//   - 仓库面向任意正方系统，不写死学校 URL；
//   - 兼容旧版单账号 config.json；
//   - 多账号时每个账号默认使用独立的 state/templates/log 文件，避免串会话。
//
// 多账号配置：
//   {
//     "base": "https://<your-zfsoft-host>/jwglxt",
//     ... 公共默认值 ...
//     "accounts": [
//       { "id": "a1", "login": {...}, "targets": {...} },
//       { "id": "a2", "login": {...}, "targets": {...} }
//     ]
//   }

'use strict';

var fs = require('fs');
var path = require('path');
var api = require('./api');

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  var out = {};
  [base, extra].forEach(function (src) {
    if (!isPlainObject(src)) return;
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v === undefined) return;
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = isPlainObject(v) ? deepMerge({}, v) : v;
    });
  });
  return out;
}

function resolvePath(file, baseDir) {
  var f = String(file || '');
  return path.isAbsolute(f) ? f : path.join(baseDir || process.cwd(), f);
}

function ensureParent(file) {
  var full = String(file || '');
  if (!full) return full;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function loadRaw(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normaliseBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

function normaliseId(id, index) {
  var v = String(id || '').trim() || ('account' + (index + 1));
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new Error('账号 id 只能包含字母、数字、下划线和短横线: ' + v);
  }
  return v;
}

function accountDefaults(id, isMulti, top) {
  if (!isMulti) {
    return {
      stateFile: top.stateFile || 'state.json',
      templatesFile: top.templatesFile || 'templates.json',
      logFile: top.logFile || 'grab.log'
    };
  }
  return {
    stateFile: path.join('state', id + '.state.json'),
    templatesFile: path.join('state', id + '.templates.json'),
    logFile: path.join('logs', id + '.log')
  };
}

function resolveAccount(accountRaw, top, index, isMulti) {
  var raw = isPlainObject(accountRaw) ? accountRaw : {};
  var merged = deepMerge(top, raw);
  var id = normaliseId(raw.id, index);
  var defaults = accountDefaults(id, isMulti, top);

  // 多账号模式默认每号独立文件；账号显式写的路径优先。
  if (!raw.stateFile) merged.stateFile = defaults.stateFile;
  if (!raw.templatesFile) merged.templatesFile = defaults.templatesFile;
  if (!raw.logFile) merged.logFile = defaults.logFile;

  merged.id = id;
  merged.accountId = isMulti ? id : null;
  merged.base = normaliseBase(merged.base);
  if (!merged.base) {
    throw new Error('账号 ' + id + ' 缺少 base（例如 https://your-host/jwglxt）');
  }
  if (!merged.indexPath) {
    merged.indexPath = (merged.api && merged.api.index) || api.DEFAULTS.index;
  }
  merged.stateFile = merged.stateFile || defaults.stateFile;
  merged.templatesFile = merged.templatesFile || defaults.templatesFile;
  merged.logFile = merged.logFile || defaults.logFile;
  merged.targets = merged.targets || {};
  merged.login = merged.login || {};
  merged.notify = merged.notify || {};
  merged.api = merged.api || {};
  merged.enabled = merged.enabled !== false;
  return merged;
}

function resolveConfig(raw) {
  if (!isPlainObject(raw)) throw new Error('config.json 必须是 JSON 对象');
  var top = {};
  Object.keys(raw).forEach(function (k) {
    if (k !== 'accounts') top[k] = raw[k];
  });

  var hasAccounts = Array.isArray(raw.accounts) && raw.accounts.length > 0;
  var mode = hasAccounts ? 'multi' : 'single';
  var list = hasAccounts ? raw.accounts : [null];
  var accounts = list.map(function (a, i) { return resolveAccount(a, top, i, hasAccounts); });
  var byId = {};
  accounts.forEach(function (a) {
    if (byId[a.id]) throw new Error('账号 id 重复: ' + a.id);
    byId[a.id] = a;
  });

  var configuredConcurrency = Number(raw.concurrency);
  var concurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency : accounts.length;
  concurrency = Math.max(1, Math.min(accounts.length, Math.floor(concurrency)));

  return {
    mode: mode,
    accounts: accounts,
    byId: byId,
    concurrency: concurrency,
    restartDelaySec: Number(raw.restartDelaySec) > 0 ? Number(raw.restartDelaySec) : 15,
    maxRestarts: Number(raw.maxRestarts) >= 0 ? Number(raw.maxRestarts) : 5
  };
}

module.exports = {
  deepMerge: deepMerge,
  resolvePath: resolvePath,
  ensureParent: ensureParent,
  loadRaw: loadRaw,
  normaliseBase: normaliseBase,
  resolveConfig: resolveConfig
};
