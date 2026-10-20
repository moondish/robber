// lib/config.js — 单账号/多账号配置解析
//
// 设计目标：
//   - 仓库面向任意正方系统，不写死学校 URL；
//   - 只接受 accounts[]；即使是单账号也使用一个 account；
//   - 每个账号使用独立的 state/templates/log 文件，避免串会话。
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

function accountDefaults(id) {
  return {
    stateFile: path.join('state', id + '.state.json'),
    templatesFile: path.join('state', id + '.templates.json'),
    logFile: path.join('logs', id + '.log')
  };
}

function resolveAccount(accountRaw, top, index) {
  var raw = isPlainObject(accountRaw) ? accountRaw : {};
  var merged = deepMerge(top, raw);
  var id = normaliseId(raw.id, index);
  var defaults = accountDefaults(id);

  // 多账号模式默认每号独立文件；账号显式写的路径优先。
  if (!raw.stateFile) merged.stateFile = defaults.stateFile;
  if (!raw.templatesFile) merged.templatesFile = defaults.templatesFile;
  if (!raw.logFile) merged.logFile = defaults.logFile;

  merged.id = id;
  merged.accountId = id;
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
  if (!hasAccounts) {
    throw new Error('已弃用单账号配置，请在 config/config.json 中使用 accounts[]（即使是单账号也建立一个 account）');
  }
  var mode = 'multi';
  var accounts = raw.accounts.map(function (a, i) { return resolveAccount(a, top, i); });
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
