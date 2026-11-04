const { chromium } = require('playwright');
const fs = require('fs');
const dir = __dirname;
const html = fs.readFileSync(require('path').join(dir, '..', 'site', 'index.html'), 'utf8');
let lib = fs.readFileSync(dir + '/fakelib.js', 'utf8');
while (lib.length < 21000) lib += '/* createClient */';
const results = [];
const ok = (c, t) => { results.push((c ? 'PASS ' : 'FAIL ') + t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => {
    const body = JSON.parse(r.request().postData());
    for (const m of body.messages) {
      const acc = m.topic.slice(2), p = pages[acc];
      if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {});
    }
    r.fulfill({ status: 202, body: '' });
  });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [] };
  const errors = [];
  async function mk(acc) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc = (window.__osc || 0) + 1; return o.apply(this, arguments); }; } });
    await p.addInitScript(() => { window.__wl = { req: 0, rel: 0 }; Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wl.req++; return { release: async () => { window.__wl.rel++; }, addEventListener() {} }; } } }); });
    await p.goto('https://app.test/');
    await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed);
    await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app-view.active');
    await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
    return p;
  }
  const A = await mk('alice'), B = await mk('bob');
  ok((await A.textContent('#me-acc')).includes('alice'), '登录并通过 bootstrap 显示账号');

  // 打开会话：好友列表 -> 聊天
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat');
  await sleep(200);
  ok(await A.isVisible('#chat-input'), '进入聊天界面');
  const call = async (quality) => {
    await A.click('#btn-video-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 4000 }); await B.click('#btn-answer');
    for (const P of [A, B]) await P.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
  };
  await call();
  ok(true, '视频通话接通');
  await sleep(2500);
  const info = await A.evaluate(async () => { const c = window.__T && window.__T.getCall ? window.__T.getCall() : null; return { has: !!c }; });
  // 本地采集分辨率 & 发送参数
  const cap = await A.evaluate(() => { const v = document.getElementById('local-video'); const t = v.srcObject.getVideoTracks()[0]; const s = t.getSettings(); return { w: s.width, h: s.height, hint: t.contentHint, facing: s.facingMode || null }; });
  ok(cap.w >= 1280 || cap.h >= 1280, '默认采集 720p 以上：' + cap.w + '×' + cap.h);
  ok(cap.hint === 'detail', 'contentHint=detail');
  ok(await A.evaluate(() => document.getElementById('local-video').classList.contains('mirror')), '前置摄像头本地预览镜像');
  // 统计面板
  await A.click('#btn-info'); await sleep(2600);
  const st = await A.textContent('#call-stats');
  ok(/收 .*fps/.test(st) && /延迟/.test(st), '通话信息面板：' + st.replace(/\n/g, ' | '));
  await A.click('#btn-info');
  ok(!(await A.evaluate(() => document.getElementById('call-stats').classList.contains('show'))), '通话信息面板可关闭');
  ok(await A.evaluate(() => document.getElementById('call-sig').className.startsWith('l')), '信号强度指示存在');
  // 画质切换 hd -> 1080 -> sd -> hd
  const seq = [];
  for (let i = 0; i < 3; i++) { await A.click('#btn-q'); await sleep(900); seq.push(await A.textContent('#btn-q')); }
  ok(seq.join(',') === '画质：超清,画质：流畅,画质：清晰', '画质循环切换 ' + seq.join(','));
  const cap2 = await A.evaluate(() => { const t = document.getElementById('local-video').srcObject.getVideoTracks()[0]; return t.readyState + ':' + t.getSettings().width; });
  ok(/^live:/.test(cap2), '切换画质后视频轨道仍然存活 ' + cap2);
  // 翻转摄像头
  const idBefore = await A.evaluate(() => document.getElementById('local-video').srcObject.getVideoTracks()[0].id);
  await A.click('#btn-flip'); await sleep(1500);
  const after = await A.evaluate(() => { const v = document.getElementById('local-video'); const ts = v.srcObject.getVideoTracks(); return { n: ts.length, id: ts[0].id, rs: ts[0].readyState, mirror: v.classList.contains('mirror') }; });
  ok(after.n === 1 && after.rs === 'live' && after.id !== idBefore, '翻转后换了新的视频轨道（' + after.n + ' 条, ' + after.rs + '）');
  ok(after.mirror === false, '后置摄像头不镜像');
  const rx = await B.evaluate(() => { const v = document.getElementById('remote-video'); return { w: v.videoWidth, paused: v.paused }; });
  await sleep(1500);
  const rx2 = await B.evaluate(() => { const v = document.getElementById('remote-video'); return { w: v.videoWidth, t: v.currentTime }; });
  ok(rx2.w > 0, '翻转后对方仍有画面 ' + rx2.w);
  await A.click('#btn-flip'); await sleep(1500);
  ok(await A.evaluate(() => document.getElementById('local-video').classList.contains('mirror')), '再翻回前置摄像头恢复镜像');
  // 连点翻转不崩
  await A.evaluate(() => { for (let i = 0; i < 5; i++) document.getElementById('btn-flip').click(); }); await sleep(3000);
  ok(await A.evaluate(() => { const ts = document.getElementById('local-video').srcObject.getVideoTracks(); return ts.length === 1 && ts[0].readyState === 'live'; }), '连点 5 次翻转后只有 1 条存活视频轨道');
  // 关摄像头状态下翻转，保持关闭
  await A.click('#btn-cam'); await A.click('#btn-flip'); await sleep(1500);
  ok(await A.evaluate(() => document.getElementById('local-video').srcObject.getVideoTracks()[0].enabled === false), '关闭摄像头后翻转，仍保持关闭');
  await A.click('#btn-cam');
  ok(await A.evaluate(() => document.getElementById('local-video').srcObject.getVideoTracks()[0].enabled === true), '重新打开摄像头恢复画面');
  // 小窗/大窗互换
  await A.click('#local-video');
  ok(await A.evaluate(() => document.getElementById('call-ui').classList.contains('swap')), '点小窗：大小画面互换');
  await A.click('#remote-video', { force: true });
  ok(await A.evaluate(() => !document.getElementById('call-ui').classList.contains('swap')), '再点小窗：换回');
  // 挂断后资源释放
  const tracksBefore = await A.evaluate(() => document.getElementById('local-video').srcObject.getTracks().length);
  await A.click('#btn-hangup'); await sleep(2500);
  ok(await A.evaluate(() => !document.getElementById('call-ui').classList.contains('active')), '挂断后界面关闭');
  ok(await A.evaluate(() => document.getElementById('local-video').srcObject === null), '挂断后释放本地视频流');
  // 再打一通（验证状态复位）
  await call(); await sleep(1500);
  ok(await A.evaluate(() => !document.getElementById('call-ui').classList.contains('swap') && !document.getElementById('call-stats').classList.contains('show')), '第二通通话界面状态已复位');
  await B.click('#btn-hangup'); await sleep(1500);
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
