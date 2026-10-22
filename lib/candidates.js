// lib/candidates.js — 连续未命中后的候选排序与展示
'use strict';

function numberValue(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function capacityOf(course) {
  var capacity = numberValue(course && (course.jxbrl != null ? course.jxbrl : course.jxbrs));
  var enrolled = numberValue(course && (course.yxzrs != null ? course.yxzrs : course.jxbrs));
  var remaining = capacity != null && enrolled != null ? Math.max(0, capacity - enrolled) : null;
  return { capacity: capacity, enrolled: enrolled, remaining: remaining };
}

function rankCandidates(list, limit) {
  var seen = {};
  var rows = (Array.isArray(list) ? list : []).filter(function (c) {
    if (!c || (!c.kch_id && !c.kch)) return false;
    var key = [
      c.kch_id || c.kch || '',
      c.jxb_id || '',
      c.jxbmc || ''
    ].join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).map(function (c) {
    return { course: c, info: capacityOf(c) };
  });

  rows.sort(function (a, b) {
    var ar = a.info.remaining;
    var br = b.info.remaining;
    if (ar != null && br == null) return -1;
    if (ar == null && br != null) return 1;
    if (ar != null && br != null && ar !== br) return br - ar;
    var ae = a.info.enrolled;
    var be = b.info.enrolled;
    if (ae != null && be != null && ae !== be) return ae - be;
    return String(a.course.kcmc || '').localeCompare(String(b.course.kcmc || ''), 'zh-CN');
  });
  return rows.slice(0, Math.max(1, Number(limit) || 10));
}

function candidateLabel(course) {
  var info = capacityOf(course);
  var count = info.capacity != null || info.enrolled != null
    ? (info.enrolled != null ? '已选' + info.enrolled : '已选?') +
      (info.capacity != null ? '/' + info.capacity : '') +
      (info.remaining != null ? ' 剩余' + info.remaining : ' 容量未知')
    : '容量未知';
  return [
    '[' + (course.kch || course.kch_id) + ']',
    course.kcmc || '',
    course.jxbmc || '',
    course.jsxx || '',
    String(course.sksj || '').replace(/<br\s*\/?>/gi, '；'),
    count
  ].filter(Boolean).join(' | ');
}

module.exports = {
  capacityOf: capacityOf,
  rankCandidates: rankCandidates,
  candidateLabel: candidateLabel
};
