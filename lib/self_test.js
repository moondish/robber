// lib/self_test.js — 纯逻辑单元测试（match / schedule / params），不依赖网络
'use strict';
var match = require('./match');
var schedule = require('./schedule');
var params = require('./params');
var api = require('./api');
var capture = require('./capture');
var config = require('./config');
var supervisor = require('./supervisor');
var path = require('path');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '  [' + a + '] === [' + b + ']'); }

console.log('--- match ---');
(function () {
  eq(match.isKch('207786'), true, 'isKch 纯数字');
  eq(match.isKch('20x786'), false, 'isKch 非数字');
  eq(match.isJxb('5706B5A0B5F80E52E0630B02FD0A792D'), true, 'isJxb 32位hex');
  eq(match.isJxb('5706'), false, 'isJxb 长度不足');
  var b1 = match.buildTargets({ kch: '207786', jxb: '5706b5a0b5f80e52e0630b02fd0a792d', kw: '摄影', njdm_id: '2025' });
  eq(b1.list.length, 3, 'buildTargets 三字段');
  eq(b1.njdm.join(','), '2025', 'njdm_id 解析');
  eq(b1.list[0].type, 'kch', '字段1=kch');
  eq(b1.list[1].type, 'jxb', '字段2=jxb');
  eq(b1.list[1].value, '5706B5A0B5F80E52E0630B02FD0A792D', 'jxb 转大写');
  eq(b1.list[2].type, 'kw', '字段3=关键词');
  eq(match.buildTargets({ kw: '摄影' }).list.length, 1, '只填关键词也生效');
  eq(match.buildTargets({ kw: '摄影' }).njdm.length, 0, '不填 njdm_id 则不过滤');
  eq(match.buildTargets({ kch: '207786,207787' }).list.length, 2, 'kch 逗号多值');
  eq(match.buildTargets({ kch: '207786\n207787' }).list.length, 2, 'kch 换行多值');
  eq(match.buildTargets({ jxb: ['A'.repeat(32), 'B'.repeat(32)] }).list.length, 2, 'jxb 数组多值');
  eq(match.buildTargets({}).list.length, 0, '全空=0');
  eq(match.splitList('  a ，b, c ').length, 3, 'splitList 中英逗号+空格');
  ok(match.matchTarget([{ type: 'kch', value: '207786' }], { kch: '207786', kcmc: '风光摄影' }), 'kch 命中');
  ok(!match.matchTarget([{ type: 'kch', value: '207786' }], { kch: '207787', kcmc: '风光摄影' }), 'kch 未命中');
  ok(match.matchTarget([{ type: 'jxb', value: 'A'.repeat(32) }], { jxb_id: 'a'.repeat(32), kcmc: 'x' }), 'jxb 命中(忽略大小写)');
  ok(match.matchTarget([{ type: 'kw', value: '摄影' }], { jxbmc: '摄影一班' }), '关键词命中 jxbmc');
  ok(match.matchTarget([{ type: 'kw', value: '摄影' }], { kcmc: '风光摄影' }), '关键词命中 kcmc');
  ok(!match.matchTarget([{ type: 'kw', value: '摄影' }], { kcmc: '数据结构' }), '关键词未命中');
  // 年级过滤（宽松：课程无年级字段时不挡）
  var tg = [{ type: 'kch', value: '207786' }];
  ok(match.matchTarget(tg, { kch: '207786', njdm_id: '2025' }, ['2025']), '年级命中');
  ok(!match.matchTarget(tg, { kch: '207786', njdm_id: '2024' }, ['2025']), '年级不匹配');
  ok(match.matchTarget(tg, { kch: '207786' }, ['2025']), '课程无年级字段则不过滤');
  ok(match.matchTarget(tg, { kch: '207786', njdm_id: '2024' }, []), '未配置年级过滤则不过滤');
})();

console.log('--- schedule ---');
(function () {
  var w = schedule.parseWeeks('1-16');
  eq(w.has(1) && w.has(16) && w.has(8), true, 'parseWeeks 1-16');
  eq(w.has(17), false, '1-16 不含17');
  var odd = schedule.parseWeeks('1-15(单)');
  eq(odd.has(1) && odd.has(3) && odd.has(15), true, '单周');
  eq(odd.has(2), false, '单周不含2');
  var even = schedule.parseWeeks('2-16(双)');
  eq(even.has(2) && even.has(16), true, '双周');
  var every = schedule.parseWeeks('1-16(1-16)');
  eq(every.has(7), true, '每周');
  var s = schedule.parseSchedule('星期一第3-4节{1-8}<br/>星期三第5-6节{1-16}');
  ok(s && s.length === 2, 'parseSchedule 两段');
  eq(s[0].day, 1, '周一');
  eq(s[0].start, 3, 'start=3');
  eq(s[0].end, 4, 'end=4');
  var a = schedule.parseSchedule('星期一第3-4节{1-8}');
  var b = schedule.parseSchedule('星期一第1-4节{1-8}');
  var c = schedule.parseSchedule('星期一第7-8节{1-8}');
  var d = schedule.parseSchedule('星期二第3-4节{1-8}');
  ok(schedule.schedulesOverlap(a, b), '重叠(区间相交)');
  ok(!schedule.schedulesOverlap(a, c), '不重叠(区间分离)');
  ok(!schedule.schedulesOverlap(a, d), '不重叠(不同天)');
  var oddA = schedule.parseSchedule('星期一第3-4节{1-15(单)}');
  var evenB = schedule.parseSchedule('星期一第3-4节{2-16(双)}');
  ok(!schedule.schedulesOverlap(oddA, evenB), '不重叠(单双周交错)');
})();

console.log('--- params ---');
(function () {
  var q = params.qsParse('njdm_id_list[0]=2023&njdm_id_list[1]=2022&bh_id=01&kklxdm=10');
  eq(q.bh_id, '01', 'qsParse 普通键');
  ok(Array.isArray(q.njdm_id_list) && q.njdm_id_list[0] === '2023' && q.njdm_id_list[1] === '2022', 'qsParse 数组键');
  var flat = params.flatten({ a: '1', arr: ['x', 'y'], nested: { b: '2' } });
  eq(flat['a'], '1', 'flatten 普通');
  eq(flat['arr[0]'], 'x', 'flatten 数组[0]');
  eq(flat['arr[1]'], 'y', 'flatten 数组[1]');
  eq(flat['nested[b]'], '2', 'flatten 嵌套对象');
  var f2 = params.flatten({ njdm_id_list: ['2023', '2022'] });
  eq(f2['njdm_id_list[0]'], '2023', 'flatten 学生列表[0]');

  var tpl = {
    ctx: { jg_id: '1', zyh_id: '2', bh_id: '01', njdm_id: '2023', xkxnm: '2023', xkxqm: '12', njdm_id_list: ['2023'], jg_id_list: ['1'] },
    query: { kklxdm: '10', rwlx: '2', xkly: '0', kspage: '1', jspage: '20' },
    submit: null,
    xkkz: 'XKZ123'
  };
  var qp = params.buildQueryParams(tpl, '10');
  eq(qp.bh_id, '01', 'buildQueryParams 用 query 模板');
  eq(qp.jspage, '50', 'buildQueryParams 覆盖分页 jspage=50');
  eq(qp.kklxdm, '10', 'buildQueryParams 覆盖类别');

  var course = { kch: '207786', kch_id: '207786', kcmc: '风光摄影', xf: '2.0', jxb_id: 'A'.repeat(32) };
  var detail = { do_jxb_id: '0b0771813105bb91168840266facf99a'.padEnd(128, '0'), sksj: '星期一第3-4节{1-8}', xf: '2' };
  var jp = params.fetchJxbParams(tpl, course, '10');
  eq(jp.xkkz_id, 'XKZ123', 'fetchJxbParams 带 xkkz_id');
  eq(jp.kch_id, '207786', 'fetchJxbParams kch_id');
  var sp = params.buildSubmitParams(tpl, course, detail, '10');
  eq(sp.jxb_ids, detail.do_jxb_id, 'buildSubmitParams jxb_ids=加密串');
  eq(sp.kcmc, '(207786)风光摄影 - 2 学分', 'buildSubmitParams kcmc 格式');
  eq(sp.xkkz_id, 'XKZ123', 'buildSubmitParams xkkz_id');
  eq(sp.xkxnm, '2023', 'buildSubmitParams ctx 补齐 xkxnm');
  // 兜底字段（无 submit 模板时）
  ok(sp.rwlx === '2' && sp.sxbj === '0' && sp.xklc === '2', 'buildSubmitParams 兜底字段');

  eq(params.pickXkkzFromObj({ xkkz_id: 'X1' }), 'X1', 'pickXkkz 直取');
  eq(params.pickXkkzFromObj({ xkgz: '1~0~0~1~X2~0~0' }), 'X2', 'pickXkkz 从 xkgz');
  eq(params.pickXkkzFromObj({}), null, 'pickXkkz 无');

  var tpl2 = {
    ctx: { bh_id: '01', xkxnm: '2025', xkxqm: '12', njdm_id: '2025' },
    query: { bh_id: '01', kspage: '1', kklxdm: '10' },
    detail: { bh_id: '01', kch_id: 'OLD', xkkz_id: 'OLD', jxbzcxskg: '0' },
    drop: { kch_id: 'OLD', jxb_ids: 'OLD', txbsfrl: '9', keep_me: '1' },
    title: { bh_id: '01', kch_id: 'OLD', jxb_ids: 'OLD', xkkz_id: 'OLD' },
    batch: { bh_id: '01', xkxnm: '2024', xkxqm: '11', kklxdm: '10' },
    xkkz: 'XKZ123'
  };
  var jp2 = params.fetchJxbParams(tpl2, course, '10');
  eq(jp2.keep_me, undefined, 'fetchJxbParams 优先用 detail 模板');
  eq(jp2.kch_id, '207786', 'fetchJxbParams 覆盖 detail 的 kch_id');
  eq(jp2.xkkz_id, 'XKZ123', 'fetchJxbParams 覆盖 xkkz_id');
  var dp = params.dropCourseParams(tpl2, { kch: '207786', do_jxb_id: 'secret', kklxdm: '10', rwlx: '2' });
  eq(dp.keep_me, '1', 'dropCourseParams 保留真实退选模板字段');
  eq(dp.jxb_ids, 'secret', 'dropCourseParams 覆盖加密 ID');
  eq(dp.txbsfrl, '9', 'dropCourseParams 保留模板里的 txbsfrl');
  var tp = params.buildTitleParams(tpl2, course, detail, '10');
  eq(tp.jxb_ids, detail.do_jxb_id, 'buildTitleParams 使用加密 ID');
  eq(tp.xkkz_id, 'XKZ123', 'buildTitleParams 带 xkkz_id');
  eq(params.buildSubmitParams(tpl2, course, { jxb_ids: 'ALT' }, '10').jxb_ids, 'ALT',
     'buildSubmitParams 兼容 jxb_ids 字段');
  var sp3 = params.buildSubmitParams({ ctx: {} }, course,
    { do_jxb_id: 'D3', jxbzls: '01', xkkz_id: 'X3', rwlx: '2', kklxdm: '10' }, '10');
  eq(sp3.jxbzls, '01', 'buildSubmitParams 补 jxbzls');
  eq(sp3.xkkz_id, 'X3', 'buildSubmitParams 从详情补 xkkz_id');
  eq(params.dropCourseParams({ ctx: { xkxnm: '2025', xkxqm: '12' } },
    { kch: '1', do_jxb_id: 'D4', jxbzls: '02' }).jxbzls, '02', 'dropCourseParams 补 jxbzls');
  var bp = params.buildBatchParams(tpl2, '10');
  eq(bp.xkxnm, '2025', 'buildBatchParams 用 ctx 覆盖学年');

  eq(params.extractList({ tmpList: [1] }).length, 1, 'extractList tmpList');
  eq(params.extractList({ data: { rows: [1, 2] } }).length, 2, 'extractList data.rows');
  eq(params.extractList({ data: [1] }).length, 1, 'extractList data 数组');
  var qpDisplay = params.buildQueryParams({
    display: { kklxdm: '10', kspage: '0', jspage: '0' },
    ctx: { bh_id: '01', xkxnm: '2025' }
  }, '10');
  eq(qpDisplay.bh_id, '01', 'buildQueryParams display 模板兜底');

  var choosedHtml = '' +
    '<div class="outer_xkxx_list">' +
    '<input type="hidden" name="right_jxb_id" value="J1"/>' +
    '<input type="hidden" name="right_kchid" value="K1"/>' +
    '<input type="hidden" name="right_kcmc" value="课程&amp;一"/>' +
    '<input type="hidden" name="right_xf" value="2"/>' +
    '<input type="hidden" name="right_do_jxb_id" value="D1"/>' +
    '<input type="hidden" name="right_sksj" value="星期一第3-4节{1-16}"/>' +
    '</div>' +
    '<div class="outer_xkxx_list">' +
    '<input type="hidden" name="right_jxb_id" value="J2"/>' +
    '<input type="hidden" name="right_kchid" value="K2"/>' +
    '<input type="hidden" name="right_do_jxb_id" value="D2"/>' +
    '</div>';
  var parsedChoosed = params.parseChoosedHtml(choosedHtml);
  eq(parsedChoosed.length, 2, 'parseChoosedHtml 解析两门已选课');
  eq(parsedChoosed[0].jxb_id, 'J1', 'parseChoosedHtml jxb_id');
  eq(parsedChoosed[0].kch_id, 'K1', 'parseChoosedHtml kch_id');
  eq(parsedChoosed[0].do_jxb_id, 'D1', 'parseChoosedHtml do_jxb_id');
  eq(parsedChoosed[0].sksj, '星期一第3-4节{1-16}', 'parseChoosedHtml sksj');
  eq(parsedChoosed[0].kcmc, '课程&一', 'parseChoosedHtml HTML 实体');
  eq(params.normaliseChoosed({ __html: choosedHtml }).length, 2, 'normaliseChoosed HTML');
})();

console.log('--- api ---');
(function () {
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html'), 'query', 'classify 查询接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbDisplay.html'), 'display', 'classify 初始展示接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbChoosed.html'), 'choosed', 'classify 已选 HTML 接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html'), 'detail', 'classify 详情接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html'), 'submit', 'classify 提交接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_xkBcZypx.html'), 'batch', 'classify 批次刷新（不能误判成 submit）');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_tuikBcZzxkYzb.html'), 'drop', 'classify 退选接口');
  eq(api.classify('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html'), 'choosed', 'classify 已选接口');
  ok(api.isSelectionPath('/xsxk/zzxkyzb_cxZzxkYzbIndex.html'), 'isSelectionPath 选课页');
  ok(!api.isSelectionPath('/xtgl/index_initMenu.html'), 'isSelectionPath 门户页');
  ok(api.isReverseProxyAuthUrl('https://webauth.example.edu.cn/wengine-auth/login?id=1'), '识别反代认证 URL');
  ok(!api.isReverseProxyAuthUrl('https://jwglxt.example.edu.cn/jwglxt/xsxk/index.html'), '普通正方 URL 不算反代');
  ok(api.isLoginUrl('https://jwglxt.example.edu.cn/jwglxt/xtgl/login_slogin.html'), '识别正方二段登录 URL');
  ok(api.isLoginUrl('https://cas.example.edu.cn/lyuapServer/login?service=x'), '识别 CAS 登录 URL');
  ok(!api.isLoginUrl('https://jwglxt.example.edu.cn/jwglxt/xtgl/index_initMenu.html'), '门户页不算登录 URL');
  eq(api.pathFromUrl('https://x/jwglxt/xsxk/a.html?gnmkdm=N1&nd=123&time=0', 'https://x/jwglxt'),
     '/xsxk/a.html?gnmkdm=N1', 'pathFromUrl 去掉易变参数');
  eq(api.withGnmkdm('http://x/jwglxt/xsxk/a.html', 'N253512', true),
     'http://x/jwglxt/xsxk/a.html?gnmkdm=N253512', 'withGnmkdm 追加模块号');
  eq(api.withGnmkdm('http://x/jwglxt/xsxk/a.html?gnmkdm=N1', 'N253512', true),
     'http://x/jwglxt/xsxk/a.html?gnmkdm=N1', 'withGnmkdm 不重复追加');
  var ep = api.buildEndpoints(
    { indexPath: '/xsxk/oldIndex.html', api: { query: '/xsxk/configQuery.html' } },
    { api: { detail: '/xsxk/capturedDetail.html?gnmkdm=N253512' } }
  );
  eq(ep.index, '/xsxk/oldIndex.html', 'buildEndpoints 保留 indexPath');
  eq(ep.query, '/xsxk/configQuery.html', 'buildEndpoints 支持 config.api');
  eq(ep.detail, '/xsxk/capturedDetail.html?gnmkdm=N253512', 'buildEndpoints 使用抓包路径');
  var ep2 = api.buildEndpoints(
    { api: { query: '/xsxk/manualQuery.html' } },
    { api: { query: '/xsxk/capturedQuery.html' } }
  );
  eq(ep2.query, '/xsxk/manualQuery.html', 'config.api 显式覆盖优先于抓包');
})();

console.log('--- capture/HAR ---');
(function () {
  function entry(url, body, response) {
    return {
      request: {
        url: url,
        method: 'POST',
        headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        postData: { text: body }
      },
      response: {
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        content: { text: JSON.stringify(response) }
      }
    };
  }
  var har = {
    log: {
      entries: [
        entry('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=N253512&nd=1',
          'bh_id=01&njdm_id_list[0]=2025&kklxdm=10&kspage=1&jspage=50',
          { tmpList: [{ kch: '207786', jxb_id: 'A'.repeat(32), xkgz: '1~0~0~1~X1~0~0' }] }),
        entry('https://x/jwglxt/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html',
          'bh_id=01&kch_id=207786&xkkz_id=X1&kklxdm=10',
          [{ do_jxb_id: 'SECRET', jxb_id: 'A'.repeat(32), sksj: '星期一第3-4节{1-8}' }]),
        entry('https://x/jwglxt/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html',
          'bh_id=01&jxb_ids=SECRET&kch_id=207786&kcmc=test&xkkz_id=X1&rwlx=2',
          { flag: '1' }),
        entry('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html',
          'bh_id=01&xkxnm=2025&xkxqm=12',
          [{ kch: '1', kcmc: 'x', do_jxb_id: 'D1' }]),
        entry('https://x/jwglxt/xsxk/zzxkyzb_tuikBcZzxkYzb.html',
          'kch_id=1&jxb_ids=D1&xkxnm=2025&xkxqm=12&txbsfrl=0',
          '1')
      ]
    }
  };
  var store = capture.createStore();
  var counts = capture.importHar(store, har, { base: 'https://x/jwglxt' });
  eq(counts.entries, 5, 'HAR 条目数');
  eq(store.query.bh_id, '01', 'HAR 提取 query 模板');
  eq(store.detail.kch_id, '207786', 'HAR 提取 detail 模板');
  eq(store.submit.jxb_ids, 'SECRET', 'HAR 提取 submit 模板');
  eq(store.drop.txbsfrl, '0', 'HAR 提取 drop 模板');
  eq(store.xkkz, 'X1', 'HAR 提取 xkkz_id');
  eq(store.api.query, '/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=N253512', 'HAR 学习查询接口');
  eq(store.api.detail, '/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html', 'HAR 学习详情接口');
  eq(capture.missingKinds(store).length, 0, 'HAR 四类核心接口齐全');

  // 路径完全改名时，依靠请求体/响应体结构自动识别。
  var renamed = {
    log: {
      entries: [
        entry('https://x/jwglxt/xsxk/newQueryApi.do',
          'bh_id=01&kklxdm=10&kspage=1',
          { tmpList: [{ kch: '1', jxb_id: 'A'.repeat(32) }] }),
        entry('https://x/jwglxt/xsxk/newDetailApi.do',
          'bh_id=01&kch_id=1&xkkz_id=X9',
          [{ do_jxb_id: 'NEW', jxb_id: 'A'.repeat(32) }])
      ]
    }
  };
  var store2 = capture.createStore();
  capture.importHar(store2, renamed, { base: 'https://x/jwglxt' });
  eq(store2.api.query, '/xsxk/newQueryApi.do', '未知路径按 kspage 识别为 query');
  eq(store2.api.detail, '/xsxk/newDetailApi.do', '未知路径按 kch_id+xkkz_id 识别为 detail');
  eq(store2.detail.do_jxb_id, undefined, '请求模板不应混入响应字段');
  eq(store2.responses.detail.body[0].do_jxb_id, 'NEW', '响应样例保留 do_jxb_id');

  var displayAsQuery = {
    log: {
      entries: [
        entry('https://x/jwglxt/xsxk/zzxkyzb_cxZzxkYzbDisplay.html',
          'xkkz_id=X1&kklxdm=10&kspage=0&jspage=0',
          { tmpList: [{ kch: '1', jxb_id: 'A'.repeat(32) }] })
      ]
    }
  };
  var store3 = capture.createStore();
  capture.importHar(store3, displayAsQuery, { base: 'https://x/jwglxt' });
  eq(store3.api.display, '/xsxk/zzxkyzb_cxZzxkYzbDisplay.html', 'Display 接口被识别');
  eq(store3.api.query, '/xsxk/zzxkyzb_cxZzxkYzbDisplay.html', 'Display 返回 tmpList 时也作为 query');
  eq(store3.query.kklxdm, '10', 'Display 请求体回填 query 模板');
})();

console.log('--- conflict.isDroppable ---');
(function () {
  var c = require('./conflict');
  ok(c.isDroppable({ kklxdm: '10', rwlx: '2' }), '可退：通识选修');
  ok(!c.isDroppable({ kklxdm: '10', rwlx: '1' }), '不可退：rwlx=1');
  ok(!c.isDroppable({ kklxdm: '3', rwlx: '2' }), '不可退：kklxdm=3');
})();

console.log('--- config ---');
(function () {
  var single = config.resolveConfig({
    base: 'https://example.test/jwglxt/',
    targets: { kch: '207786' }
  });
  eq(single.mode, 'single', '单账号模式');
  eq(single.accounts.length, 1, '单账号数量');
  eq(single.accounts[0].base, 'https://example.test/jwglxt', 'base 去尾部斜杠');
  eq(single.accounts[0].stateFile, 'state.json', '单账号 state 路径');
  eq(single.byId.account1.targets.kch, '207786', '单账号 targets');

  var multi = config.resolveConfig({
    base: 'https://example.test/jwglxt',
    intervalSec: 2,
    login: { username: 'default-user' },
    targets: { njdm_id: '2025' },
    concurrency: 5,
    accounts: [
      { id: 'a1', login: { username: 'u1', password: 'p1' }, targets: { kch: '1' } },
      { id: 'a2', base: 'https://other.test/jwglxt', targets: { kw: '摄影' }, intervalSec: 3 }
    ]
  });
  eq(multi.mode, 'multi', '多账号模式');
  eq(multi.accounts.length, 2, '多账号数量');
  eq(multi.concurrency, 2, '并发数不超过账号数');
  eq(multi.byId.a1.base, 'https://example.test/jwglxt', '账号继承公共 base');
  eq(multi.byId.a2.base, 'https://other.test/jwglxt', '账号覆盖 base');
  eq(multi.byId.a1.login.username, 'u1', '账号覆盖登录用户');
  eq(multi.byId.a1.targets.njdm_id, '2025', '账号继承公共 targets');
  eq(multi.byId.a1.targets.kch, '1', '账号自己的 targets');
  eq(multi.byId.a2.intervalSec, 3, '账号覆盖间隔');
  eq(multi.byId.a1.stateFile, path.join('state', 'a1.state.json'), 'a1 独立 state');
  eq(multi.byId.a2.templatesFile, path.join('state', 'a2.templates.json'), 'a2 独立 templates');
  eq(multi.byId.a1.logFile, path.join('logs', 'a1.log'), 'a1 独立日志');

  var duplicateFailed = false;
  try {
    config.resolveConfig({
      base: 'https://example.test/jwglxt',
      accounts: [{ id: 'same' }, { id: 'same' }]
    });
  } catch (e) { duplicateFailed = /重复/.test(e.message); }
  ok(duplicateFailed, '重复 id 报错');

  var invalidIdFailed = false;
  try {
    config.resolveConfig({ base: 'https://example.test/jwglxt', accounts: [{ id: '../bad' }] });
  } catch (e) { invalidIdFailed = /只能包含/.test(e.message); }
  ok(invalidIdFailed, '非法 id 报错');

  var missingBaseFailed = false;
  try {
    config.resolveConfig({ accounts: [{ id: 'a1' }] });
  } catch (e) { missingBaseFailed = /缺少 base/.test(e.message); }
  ok(missingBaseFailed, '缺少 base 报错');

  eq(supervisor.childArgs({ script: 'grab.js', accountId: 'a1' }).join(' '),
     'grab.js --account a1', 'supervisor 子进程参数');
  eq(supervisor.childArgs({ script: 'grab.js', accountId: 'a1', prepare: true, configFile: '/tmp/c.json' }).join(' '),
     'grab.js --account a1 --prepare --config /tmp/c.json', 'supervisor prepare 参数');
  eq(supervisor.childArgs({ script: 'grab.js', accountId: 'a1', forceLogin: true }).join(' '),
     'grab.js --account a1 --force-login', 'supervisor 强制登录参数');
  eq(supervisor.childArgs({ script: 'grab.js', accountId: 'a1', debug: true }).join(' '),
     'grab.js --account a1 --debug', 'supervisor 调试参数');
})();

console.log('');
console.log('通过 ' + passed + '，失败 ' + failed);
process.exit(failed ? 1 : 0);
