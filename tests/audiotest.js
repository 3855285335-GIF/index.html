// 通话声音：两边都真的收到并在播放对方的声音（语音通话、视频通话、第二通、静音开关），提示音引擎通话中暂停
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
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME|Failed to load resource/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => {   // 记录提示音引擎的状态（暂停 / 恢复）
      const AC = window.AudioContext || window.webkitAudioContext; window.__acs = [];
      if (AC) { const Orig = AC; window.__OrigAC = Orig; window.AudioContext = function (...a) { const c = new Orig(...a); window.__acs.push(c); return c; }; window.AudioContext.prototype = Orig.prototype; window.webkitAudioContext = window.AudioContext; }
    });
    await p.goto('https://app.test/');
    await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed);
    await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app-view.active');
    await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
    return p;
  }
  const A = await mk('alice'), B = await mk('bob');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat');
  await sleep(300);
  await A.click('#btn-send').catch(() => {});   // 一次点击，解锁提示音引擎（和真人用手机一样）
  await B.click('#chat-input');
  const call = async video => {
    await A.click(video ? '#btn-video-call' : '#btn-voice-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 4000 }); await B.click('#btn-answer');
    for (const P of [A, B]) await P.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
  };
  // 在页面里测对方声音的音量（用分析器读 remote-audio 正在播放的流）
  const level = P => P.evaluate(() => new Promise(res => {
    const a = document.getElementById('remote-audio'), s = a.srcObject;
    if (!s || !s.getAudioTracks().length) { res({ rms: 0, why: '没有声音轨道' }); return; }
    const ctx = new (window.__OrigAC || AudioContext)();
    const src = ctx.createMediaStreamSource(s), an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
    const buf = new Float32Array(an.fftSize); let best = 0, n = 0;
    const t = setInterval(() => { an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; best = Math.max(best, Math.sqrt(sum / buf.length)); if (++n >= 25) { clearInterval(t); ctx.close(); res({ rms: best }); } }, 80);
  }));
  const state = P => P.evaluate(() => { const a = document.getElementById('remote-audio'), v = document.getElementById('remote-video'); const s = a.srcObject;
    return { aTracks: s ? s.getAudioTracks().filter(t => t.readyState === 'live' && t.enabled).length : 0, vInAudio: s ? s.getVideoTracks().length : -1, paused: a.paused, muted: a.muted, vol: a.volume, vMuted: v.muted, vVideo: v.srcObject ? v.srcObject.getVideoTracks().length : 0,
      sfx: (window.__acs || []).map(c => c.state).join(',') }; });

  for (const [name, video] of [['语音通话', false], ['视频通话', true], ['第二通视频通话', true]]) {
    await call(video); await sleep(2500);
    for (const [who, P] of [['拨打方', A], ['接听方', B]]) {
      const st = await state(P), lv = await level(P);
      ok(st.aTracks === 1 && st.vInAudio === 0 && !st.paused && !st.muted && st.vol === 1, name + '：' + who + '的声音元素在播放对方声音（1 条声音轨道、没静音、音量 100%）' + JSON.stringify({ a: st.aTracks, p: st.paused, m: st.muted }));
      ok(lv.rms > 0.01, name + '：' + who + '真的听得到对方（实测音量 ' + lv.rms.toFixed(3) + '）' + (lv.why || ''));
      if (video) ok(st.vMuted && st.vVideo === 1, name + '：' + who + '的画面元素静音、只负责显示画面（不会两个元素同时放声音）');
      ok(/suspended/.test(st.sfx), name + '：' + who + '通话中提示音引擎已暂停（' + st.sfx + '）');
    }
    if (name === '视频通话') {
      await A.click('#btn-mute'); await sleep(1200);
      const muted = await level(B);
      ok(muted.rms < 0.005, '拨打方点静音：接听方听不到声音（' + muted.rms.toFixed(4) + '）');
      await A.click('#btn-mute'); await sleep(1200);
      const back = await level(B);
      ok(back.rms > 0.01, '再点一次取消静音：接听方又听得到了（' + back.rms.toFixed(3) + '）');
    }
    await A.click('#btn-hangup'); await sleep(2000);
    const after = await A.evaluate(() => (window.__acs || []).map(c => c.state).join(','));
    ok(/running/.test(after), name + '：挂断后提示音引擎恢复（' + after + '）');
  }
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
