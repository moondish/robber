// lib/debug.js — 详细调试日志（--debug）
//
// 只记录结构、URL、字段名和错误；password/cookie/token/ticket 等值会被替换为 ***。

'use strict';

var fs = require('fs');
var path = require('path');

var SECRET_KEY = /pass(word|wd)?|pwd|cookie|authorization|token|ticket|session|jsessionid|captcha|验证码/i;

function sanitize(value, depth) {
  if (depth == null) depth = 0;
  if (depth > 6) return '[depth-limit]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 1200 ? value.slice(0, 1200) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 60).map(function (v) { return sanitize(v, depth + 1); });
  if (typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (k) {
      if (SECRET_KEY.test(k)) {
        var v = value[k];
        out[k] = (v == null || typeof v === 'boolean' || typeof v === 'number') ? v : '***';
      } else {
        out[k] = sanitize(value[k], depth + 1);
      }
    });
    return out;
  }
  return String(value);
}

function create(cfg, opts) {
  opts = opts || {};
  var enabled = !!(opts.enabled || cfg.debug);
  var file = cfg.debugFile || '';
  if (!file) {
    var logFile = cfg.logFile || 'grab.log';
    file = /\.log$/i.test(logFile) ? logFile.replace(/\.log$/i, '.debug.log') : logFile + '.debug.log';
  }
  var full = path.isAbsolute(file) ? file : path.join(opts.baseDir || process.cwd(), file);
  if (enabled) {
    try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch (e) {}
  }

  function log(msg, data) {
    if (!enabled) return;
    var line = '[' + new Date().toISOString() + '] ' + msg;
    if (data !== undefined) line += ' ' + JSON.stringify(sanitize(data));
    console.log('\x1b[90m[debug] ' + line + '\x1b[0m');
    try { fs.appendFileSync(full, line + '\n'); } catch (e) {}
  }

  return { enabled: enabled, file: full, log: log, sanitize: sanitize };
}

module.exports = { create: create, sanitize: sanitize };
