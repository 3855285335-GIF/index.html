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
    await p.addInitScript(() => { window.__noWS = true; }); await p.goto('https://app.test/');
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
  await sleep(1500);
  ok(!(await A.isVisible('#banner')) || !/未授权|没有权限/.test(await A.textContent('#banner')), '实时通道被拦时，不再弹出“未授权/去运行 setup.sql”的误导提示');
  // ---- 消息延迟 ----
  const lat = [];
  for (let i = 0; i < 5; i++) {
    const txt = '国内消息' + i, t0 = Date.now();
    await A.fill('#chat-input', txt); await A.click('#btn-send');
    await B.waitForSelector('.bubble:has-text("' + txt + '")', { timeout: 6000 });
    lat.push(Date.now() - t0); await sleep(300);
  }
  ok(Math.max(...lat) < 1500, '实时通道被拦：消息靠长轮询到达，5 次延迟 ' + lat.join('/') + ' ms（都小于 1.5 秒）');
  ok(await B.locator('.bubble', { hasText: '国内消息0' }).count() === 1, '同一条消息不会重复显示');
  // ---- 对方回复 ----
  const t1 = Date.now(); await B.fill('#chat-input', '收到了'); await B.click('#btn-send');
  await A.waitForSelector('.bubble:has-text("收到了")', { timeout: 6000 });
  ok(true, '反方向也正常，延迟 ' + (Date.now() - t1) + ' ms');
  // ---- 正在输入 ----
  await A.type('#chat-input', 'abc', { delay: 40 });
  await B.waitForFunction(() => /正在输入/.test(document.getElementById('chat-title').textContent), null, { timeout: 4000 });
  ok(true, '“对方正在输入…”改走数据库也能显示'); await A.fill('#chat-input', '');
  // ---- 已读 ----
  await A.fill('#chat-input', '看到请回'); await A.click('#btn-send'); await B.waitForSelector('.bubble:has-text("看到请回")', { timeout: 5000 });
  await A.waitForFunction(() => /已读/.test(document.querySelector('.msg.mine:last-child .msg-time').textContent), null, { timeout: 8000 });
  ok(true, '已读回执在国内模式下也能显示');
  // ---- 在线状态 ----
  await A.waitForFunction(() => /在线/.test(document.getElementById('chat-title').textContent), null, { timeout: 4000 }).catch(() => {});
  ok(/在线/.test(await A.textContent('#chat-title')), '在线状态改走数据库：显示对方“在线”');
  // ---- 诊断页 ----
  await A.click('#chat-back'); await sleep(200); await A.click('.app-nav button[data-tab=me]'); await sleep(1700);
  const dg = await A.textContent('#diag');
  ok(/国内模式/.test(dg) && !/❌ 实时/.test(dg), '诊断页显示“已切换国内模式”，不再是红叉：' + dg.split('\n').slice(-2).join(' / '));
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(300);
  // ---- 视频通话 ----
  const c0 = Date.now();
  await A.click('#btn-video-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 5000 });
  ok(Date.now() - c0 < 2500, '来电在 ' + (Date.now() - c0) + ' ms 内响铃');
  await B.click('#btn-answer');
  try {
    for (const P of [A, B]) await P.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 20000 });
    ok(true, '通话接通，从拨号到接通 ' + (Date.now() - c0) + ' ms');
  } catch (e) { ok(false, '通话没接通：A=' + await A.textContent('#call-status') + ' B=' + await B.textContent('#call-status')); }
  await sleep(1500);
  ok((await B.evaluate(() => { const v = document.getElementById('remote-video'); return v.srcObject ? v.srcObject.getTracks().length : 0; })) >= 1, '对方收到了音视频');
  await A.click('#btn-flip'); await sleep(1200);
  ok(await A.evaluate(() => document.getElementById('local-video').srcObject.getVideoTracks()[0].readyState === 'live'), '国内模式下翻转摄像头正常');
  await B.click('#btn-hangup');
  await A.waitForFunction(() => !document.getElementById('call-ui').classList.contains('active'), null, { timeout: 6000 });
  ok(true, '对方挂断，本方界面也关闭（挂断信号走数据库）');
  await sleep(3000);
  ok(!(await B.isVisible('#incoming-ui.active')) && !(await A.isVisible('#incoming-ui.active')), '挂断后不会出现幽灵来电');
  // ---- 拒接 ----
  await A.click('#btn-voice-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 5000 });
  await B.click('#btn-decline');
  await A.waitForFunction(() => !document.getElementById('call-ui').classList.contains('active'), null, { timeout: 6000 });
  ok(true, '拒接信号也能送达');
  // ---- 主叫取消 ----
  await sleep(500);
  await A.click('#btn-voice-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 5000 });
  await A.click('#btn-hangup');
  await B.waitForFunction(() => !document.getElementById('incoming-ui').classList.contains('active'), null, { timeout: 6000 });
  ok(true, '主叫取消后，对方的来电界面自动消失');
  // ---- 撤回 ----
  await sleep(500);
  await A.fill('#chat-input', '要撤回的'); await A.click('#btn-send'); await B.waitForSelector('.bubble:has-text("要撤回的")', { timeout: 5000 });
  await A.locator('.msg.mine .bubble', { hasText: '要撤回的' }).click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400); await A.click('#msg-menu-recall');
  await B.waitForFunction(() => document.querySelectorAll('.bubble.recalled').length > 0, null, { timeout: 8000 }).catch(() => {});
  ok(await B.locator('.bubble.recalled').count() >= 1, '撤回在国内模式下也能同步');
  // ---- 流量：空闲时请求不多 ----
  const c1 = await B.evaluate(() => window.__inboxCalls || 0); await sleep(10000); const c2 = await B.evaluate(() => window.__inboxCalls || 0);
  ok(c2 - c1 <= 6, '空闲 10 秒只发了 ' + (c2 - c1) + ' 次长轮询请求（省流量）');
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
