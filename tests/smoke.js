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

  // 发文字：本地立即出现
  const t0 = Date.now();
  await A.fill('#chat-input', 'hello bob'); await A.click('#btn-send');
  ok(await A.locator('.msg.mine .bubble', { hasText: 'hello bob' }).count() === 1, '发送后本地立即显示');
  await B.waitForSelector('.msg.theirs .bubble:has-text("hello bob")', { timeout: 3000 });
  ok(true, '对方收到文字，耗时 ' + (Date.now() - t0) + 'ms');
  await sleep(400);
  ok(await B.locator('.msg.theirs .bubble:has-text("hello bob")').count() === 1, '对方只显示 1 条（快速通道+数据库不重复）');
  ok(await A.locator('.msg.mine .st').count() === 0, '发送完成后转圈消失');
  ok((await A.evaluate(() => window.__osc || 0)) > 0, '发送时播放音效');
  ok((await B.evaluate(() => window.__osc || 0)) > 0, '收到消息时播放音效');

  // 撤回
  await A.locator('.msg.mine .bubble', { hasText: 'hello bob' }).click({ button: 'right' });
  await A.waitForSelector('#msg-menu.active'); await A.click('#msg-menu-recall');
  await B.waitForSelector('.bubble.recalled', { timeout: 3000 });
  ok(true, '撤回同步到对方');

  // 发图片（本地预览 + 上传）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(require('os').tmpdir() + '/t.png', png);
  await A.setInputFiles('#file-input', require('os').tmpdir() + '/t.png');
  await A.waitForSelector('.bubble.img img');
  await B.waitForSelector('.bubble.img img', { timeout: 4000 });
  ok(true, '图片双向同步');

  // 语音：假麦克风 → WAV
  await A.click('#btn-audio-toggle');
  const box = await A.locator('#btn-audio').boundingBox();
  await A.mouse.move(box.x + 20, box.y + 20); await A.mouse.down();
  await sleep(1800);
  ok(await A.isVisible('#record-overlay'), '按住后显示录音浮层');
  await A.mouse.up();
  await A.waitForSelector('.bubble.voice', { timeout: 4000 });
  await B.waitForSelector('.bubble.voice', { timeout: 4000 });
  ok(true, '语音发送并同步（WAV 路径，无 MediaRecorder）');
  const wavInfo = await A.evaluate(() => { const T = window.__T; return !!T; });

  // 上滑取消
  await A.mouse.move(box.x + 20, box.y + 20); await A.mouse.down(); await sleep(1100); await A.mouse.move(box.x + 20, box.y - 120); await sleep(300);
  ok(await A.evaluate(() => document.getElementById('record-overlay').classList.contains('cancel')), '上滑显示取消状态');
  await A.mouse.up(); await sleep(400);
  ok(await A.locator('.bubble.voice').count() === 1, '上滑取消不发送');

  // 通话：真实 WebRTC 回环（两个页面、假摄像头/麦克风）
  await A.click('#chat-back'); await sleep(100);
  await A.click('.app-nav button[data-tab=contacts]');
  await A.click('.friend-item .act-chat'); await sleep(200);
  await A.click('#btn-video-call');
  await B.waitForSelector('#incoming-ui.active', { timeout: 4000 });
  ok(true, '对方收到来电弹窗');
  const r0 = await B.evaluate(() => window.__osc || 0); await sleep(3200);
  const r1 = await B.evaluate(() => window.__osc || 0);
  ok(r1 - r0 >= 8, '来电铃声循环播放（3.2 秒内新增音符 ' + (r1 - r0) + '）');
  await B.click('#btn-answer');
  try {
    await A.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
    await B.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
    ok(true, 'WebRTC 通话两端都已连通并计时');
  } catch (e) {
    ok(false, 'WebRTC 通话连通失败：A=' + await A.textContent('#call-status') + ' B=' + await B.textContent('#call-status'));
  }
  await sleep(1500);
  const q0 = await B.evaluate(() => window.__osc || 0); await sleep(3300);
  const q1 = await B.evaluate(() => window.__osc || 0);
  ok(q1 === q0, '接通后铃声已停止（3.3 秒内新增音符 ' + (q1 - q0) + '）');
  ok(await B.evaluate(() => document.getElementById('call-ui').classList.contains('connected')), '通话界面进入“已接通”样式');
  const vs = await B.evaluate(() => { const v = document.getElementById('remote-video'); return { w: v.videoWidth, tracks: v.srcObject ? v.srcObject.getTracks().length : 0 }; });
  ok(vs.tracks >= 1, '对方收到音视频轨道 tracks=' + vs.tracks + ' videoWidth=' + vs.w);
  await sleep(1200);
  await B.click('#btn-hangup');
  await A.waitForFunction(() => !document.getElementById('call-ui').classList.contains('active'), null, { timeout: 6000 });
  ok(true, '挂断后两端界面关闭');
  await sleep(300);
  const wA = await A.evaluate(() => window.__wl), wB = await B.evaluate(() => window.__wl);
  ok(wA.req >= 1 && wA.rel >= 1 && wB.req >= 1 && wB.rel >= 1, '通话期间请求屏幕常亮，挂断后释放 A=' + JSON.stringify(wA) + ' B=' + JSON.stringify(wB));
  await A.waitForSelector('.bubble.call', { timeout: 3000 });
  ok(true, '通话记录写入聊天');

  // 拒绝 / 忙线
  await A.click('#btn-voice-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 4000 });
  await B.click('#btn-decline');
  await A.waitForFunction(() => !document.getElementById('call-ui').classList.contains('active'), null, { timeout: 6000 });
  ok(true, '对方拒绝后主叫界面关闭');

  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 5).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
