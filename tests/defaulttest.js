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
    await p.addInitScript(() => { window.__pcCfgs = []; const R = window.RTCPeerConnection; window.RTCPeerConnection = function (c) { window.__pcCfgs.push(JSON.parse(JSON.stringify(c || {}))); return new R(c); }; window.RTCPeerConnection.prototype = R.prototype; });
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

  await A.click('#chat-back').catch(() => {}); await sleep(200); await A.click('.app-nav button[data-tab=me]'); await sleep(1700);
  const dg = await A.textContent('#diag');
  ok(/中转服务器：ExpressTURN、Metered（来自内置）/.test(dg), '数据库没有配置时，用内置默认：' + dg.split('\n').pop());
  ok((await A.textContent('#btn-relaysave')).includes('关'), '“中转省流量”默认关');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(300);
  await A.click('#btn-voice-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 5000 }); await B.click('#btn-answer');
  await A.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
  const cfg = await A.evaluate(() => window.__pcCfgs[window.__pcCfgs.length - 1]);
  const stun = [].concat(cfg.iceServers[0].urls);
  ok(stun.join() === 'stun:stun.miwifi.com:3478,stun:stun.hitv.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302', 'STUN 是实测能用的 5 个，没有 stun.qq.com');
  const ex = cfg.iceServers[1], me = cfg.iceServers[2];
  ok(ex.username === '000000002109207283' && ex.credential === 'F2O3wiOhufam3ieQHr7cTrp77u0=' && [].concat(ex.urls).join() === 'turn:free.expressturn.com:3478?transport=udp,turn:free.expressturn.com:3478?transport=tcp', 'ExpressTURN 排第一：地址、用户名、密码都对');
  ok([].concat(me.urls).join() === 'turns:global.relay.metered.ca:443?transport=tcp', 'Metered 排第二（备用），只有 TLS 443，没有 UDP 80（UDP 优先级更高，会抢走 ExpressTURN 的流量）');
  ok(cfg.iceServers.length === 3 && !JSON.stringify(cfg.iceServers).includes('metered.ca:80'), '中转列表里没有任何 Metered 的 UDP 地址');
  await A.click('#btn-hangup'); await sleep(800);
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
