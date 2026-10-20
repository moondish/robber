// lib/supervisor.js — 多账号并发调度
//
// 每个账号跑一个独立子进程，拥有自己的 cfg / state / templates / cookies。
// 这样不会出现多个账号共用 JSESSIONID、互相覆盖 state.json 的问题。

'use strict';

var spawn = require('child_process').spawn;

function childArgs(options) {
  var args = [options.script, '--account', options.accountId];
  if (options.prepare) args.push('--prepare');
  if (options.forceLogin) args.push('--force-login');
  if (options.configFile) args.push('--config', options.configFile);
  return args;
}

function run(resolved, cli, options) {
  options = options || {};
  var accounts = (resolved.accounts || []).filter(function (a) { return a.enabled !== false; });
  var prepare = !!cli.prepare;
  var concurrency = prepare ? 1 : Math.max(1, Math.min(resolved.concurrency || accounts.length, accounts.length));
  var restartDelayMs = Math.max(1000, Number(resolved.restartDelaySec || 15) * 1000);
  var maxRestarts = Number(resolved.maxRestarts == null ? 5 : resolved.maxRestarts);
  var queue = accounts.slice();
  var running = {};
  var restarts = {};
  var pendingRestarts = 0;
  var shuttingDown = false;
  var failed = false;
  var resolveDone;

  function log(msg) {
    console.log('[supervisor] ' + msg);
  }

  function runningCount() { return Object.keys(running).length; }

  function finishIfIdle() {
    if (shuttingDown || queue.length || runningCount() || pendingRestarts) return;
    if (resolveDone) resolveDone(failed ? 1 : 0);
  }

  function pump() {
    if (shuttingDown) return;
    while (queue.length && runningCount() < concurrency) {
      start(queue.shift());
    }
    finishIfIdle();
  }

  function start(account) {
    var id = account.id;
    var args = childArgs({
      script: options.script,
      accountId: id,
      prepare: prepare,
      forceLogin: !!cli.forceLogin,
      configFile: options.configFile
    });
    log((prepare ? '准备账号 ' : '启动账号 ') + id);
    var child = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: Object.assign({}, process.env, { GRABBER_ACCOUNT: id }),
      stdio: 'inherit'
    });
    running[id] = child;

    child.on('error', function (e) {
      if (!running[id]) return;
      log('账号 ' + id + ' 启动失败: ' + e.message);
      failed = true;
      delete running[id];
      pump();
    });

    child.on('exit', function (code, signal) {
      if (!running[id]) return;
      delete running[id];
      if (shuttingDown) return;
      if (prepare) {
        if (code !== 0) {
          failed = true;
          log('账号 ' + id + ' 准备失败 (code=' + code + (signal ? ', signal=' + signal : '') + ')');
        } else {
          log('账号 ' + id + ' 准备完成');
        }
        pump();
        return;
      }
      if (code === 0) {
        log('账号 ' + id + ' 已正常结束');
      } else if (code === 2) {
        failed = true;
        log('账号 ' + id + ' 会话过期，已停止；请先对该账号执行 --prepare');
      } else if (code === 3) {
        failed = true;
        log('账号 ' + id + ' 配置不完整（例如缺少 targets），已停止，不会自动重启');
      } else if ((restarts[id] || 0) < maxRestarts) {
        restarts[id] = (restarts[id] || 0) + 1;
        pendingRestarts++;
        log('账号 ' + id + ' 异常退出 (code=' + code + ')，' + (restartDelayMs / 1000) + 's 后第 ' + restarts[id] + ' 次重启');
        setTimeout(function () {
          pendingRestarts--;
          if (shuttingDown) return;
          queue.push(account);
          pump();
        }, restartDelayMs);
      } else {
        failed = true;
        log('账号 ' + id + ' 连续异常，达到最大重启次数，停止');
      }
      pump();
    });
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('收到 ' + signal + '，停止所有账号…');
    Object.keys(running).forEach(function (id) {
      try { running[id].kill('SIGTERM'); } catch (e) {}
    });
    // 子进程使用 stdio inherit，这里只需要结束 supervisor。
    setTimeout(function () { if (resolveDone) resolveDone(0); }, 1500);
  }

  return new Promise(function (resolve) {
    resolveDone = resolve;
    if (!accounts.length) {
      log('没有启用的账号');
      resolve(1);
      return;
    }
    process.once('SIGINT', function () { shutdown('SIGINT'); });
    process.once('SIGTERM', function () { shutdown('SIGTERM'); });
    pump();
  });
}

module.exports = { run: run, childArgs: childArgs };
