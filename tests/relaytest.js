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
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [], app_config: [{ key: 'ice', value: { turn: [ { name: 'TestTURN', username: 'u1', credential: 'p1', urls: ['turn:ok.test:3478?transport=udp', 'turn:bad.test:3478?transport=tcp'] }, { name: 'Bad', username: '<用户名>', credential: '<密码>', urls: ['turn:x.test:3478'] }, { name: 'Metered', username: 'm', credential: 'n', urls: ['turn:global.relay.metered.ca:80'] } ] } }] };
  const errors = [];
  async function mk(acc) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc = (window.__osc || 0) + 1; return o.apply(this, arguments); }; } });
    await p.addInitScript(() => { window.__wl = { req: 0, rel: 0 }; Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wl.req++; return { release: async () => { window.__wl.rel++; }, addEventListener() {} }; } } }); });

    await p.addInitScript(() => {
      window.__pcCfgs = []; window.__toasts = [];
      const RPC = window.RTCPeerConnection;
      function Fake(cfg) {   // 中转测试用：按服务器地址假装拿到/拿不到候选
        const self = this; this.onicecandidate = null; const s = cfg.iceServers[0]; const u = [].concat(s.urls).join(',');
        this.createDataChannel = () => ({}); this.close = () => {};
        this.createOffer = async () => ({ type: 'offer', sdp: 'v=0' });
        this.setLocalDescription = async () => { setTimeout(() => {
          const cand = c => self.onicecandidate && self.onicecandidate({ candidate: { candidate: c } });
          if (cfg.iceTransportPolicy === 'relay') { if (/ok\.test/.test(u) && /udp/.test(u)) cand('candidate:1 1 udp 1 1.2.3.4 5000 typ relay'); else cand(null); }
          else { cand('candidate:2 1 udp 2 10.0.0.2 5000 typ host'); cand('candidate:3 1 udp 3 9.9.9.9 5000 typ srflx'); }
          if (self.onicecandidate) self.onicecandidate({ candidate: null });
        }, 120); };
      }
      window.RTCPeerConnection = function (cfg) {
        if (window.__probeMode && cfg && cfg.iceServers && cfg.iceServers.length === 1) return new Fake(cfg);
        window.__pcCfgs.push(JSON.parse(JSON.stringify(cfg || {}))); return new RPC(cfg);
      };
      window.RTCPeerConnection.prototype = RPC.prototype;
      const gs = RPC.prototype.getStats;
      RPC.prototype.getStats = async function () {
        const rep = await gs.apply(this, arguments); if (!window.__fakeRelay) return rep;
        const m = new Map(); rep.forEach((v, k) => m.set(k, v.type === 'local-candidate' ? Object.assign({}, v, { candidateType: 'relay' }) : v)); return m;
      };
      document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); }))).observe(document.body, { childList: true, subtree: true }));
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
  ok((await A.textContent('#me-acc')).includes('alice'), '登录并通过 bootstrap 显示账号');

  // 打开会话：好友列表 -> 聊天
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat');
  await sleep(200);

  const params = P => P.evaluate(() => {
    const cfg = window.__pcCfgs; return null;
  });
  // ---- 1. 配置来自数据库，占位符项被忽略 ----
  await A.click('#chat-back').catch(() => {}); await sleep(200); await A.click('.app-nav button[data-tab=me]'); await sleep(1700);
  const dg = await A.textContent('#diag');
  ok(/中转服务器：TestTURN、Metered（来自数据库）/.test(dg), '中转服务器配置从数据库读取，占位符没填的项被忽略：' + dg.split('\n').pop());
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(300);
  // ---- 2. 通话：直连时不限码率 ----
  await A.click('#btn-video-call'); await B.waitForSelector('#incoming-ui.active', { timeout: 5000 }); await B.click('#btn-answer');
  for (const P of [A, B]) await P.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('call-status').textContent), null, { timeout: 15000 });
  const cfg = await A.evaluate(() => window.__pcCfgs[window.__pcCfgs.length - 1]);
  const urls = cfg.iceServers.map(s => [].concat(s.urls).join('|'));
  ok(/stun:/.test(urls[0]) && /ok\.test/.test(urls[1]) && /metered/.test(urls[2]) && urls.length === 3, '通话用的服务器顺序：STUN → TestTURN（主力）→ Metered（备用）');
  const sp = P => P.evaluate(() => {   // 读出当前发送参数（通过页面里的 RTCPeerConnection 找不到时返回空）
    const v = document.getElementById('local-video'); return window.__lastParams || null;
  });
  await A.evaluate(() => {   // 找到本页正在用的 PC：包一层 setParameters 记录最后一次设置
    const RS = RTCRtpSender.prototype, sp = RS.setParameters; window.__setp = { audio: null, video: null };
    RS.setParameters = function (pr) { if (this.track) window.__setp[this.track.kind] = JSON.parse(JSON.stringify(pr.encodings && pr.encodings[0] || {})); return sp.apply(this, arguments); };
  });
  await sleep(4800);
  await A.evaluate(() => { const b = document.getElementById('btn-relaysave'); b.click(); b.click(); });   // 触发一次重新设置参数
  await A.waitForFunction(() => window.__setp.video && window.__setp.audio, null, { timeout: 4000 });
  const d0 = await A.evaluate(() => window.__setp);
  ok(d0.video.maxBitrate === 2500000 && d0.video.scaleResolutionDownBy === 1 && !('maxBitrate' in d0.audio), '直连时：视频按“清晰”2.5Mbps、分辨率不减半，语音不限');
  // ---- 3. 走中转、省流量默认关：画质不变 ----
  ok((await A.evaluate(() => document.getElementById('btn-relaysave').textContent)).includes('关'), '“中转省流量”默认是关的');
  await A.evaluate(() => { window.__fakeRelay = true; window.__setp = { audio: null, video: null }; });
  await sleep(6000);
  const r0 = await A.evaluate(() => window.__setp);
  ok(!r0.video || r0.video.maxBitrate === 2500000, '走中转但没开省流量：不会自动降画质（' + (r0.video ? r0.video.maxBitrate : '没有改动') + '）');
  ok(!(await A.evaluate(() => window.__toasts.join('|'))).includes('正在走中转服务器'), '没开省流量时不会弹“正在走中转、已自动降低码率”');
  await A.click('#btn-info'); await sleep(2300);
  ok(/保持你选的画质/.test(await A.textContent('#call-stats')), '通话信息里写明“走中转：保持你选的画质”');
  await A.click('#btn-info');
  const q0 = await A.textContent('#btn-q'); await A.click('#btn-q'); await sleep(500); const q1 = await A.textContent('#btn-q');
  ok(q0 !== q1, '走中转时画质照样可以自己选（' + q0 + ' → ' + q1 + '）');
  await A.click('#btn-q'); await sleep(300); await A.click('#btn-q'); await sleep(500);   // 换回“清晰”
  // ---- 4. 用户自己打开省流量：才限制 ----
  await A.evaluate(() => document.getElementById('btn-relaysave').click());
  await A.waitForFunction(() => window.__setp.video && window.__setp.video.maxBitrate === 300000, null, { timeout: 5000 });
  const d1 = await A.evaluate(() => window.__setp);
  ok(d1.video.scaleResolutionDownBy === 2 && d1.audio && d1.audio.maxBitrate === 24000, '自己打开省流量后：视频 300kbps、分辨率减半，语音 24kbps');
  await A.click('#btn-info'); await sleep(2300);
  ok(/中转省流量中/.test(await A.textContent('#call-stats')), '通话信息里显示“中转省流量中”');
  await A.click('#btn-info');
  await A.click('#btn-q'); await sleep(200);
  ok((await A.evaluate(() => window.__toasts.slice(-1)[0] || '')).includes('省流量画质'), '开着省流量时点画质：提示可以去关掉');
  // ---- 5. 关掉：立刻恢复 ----
  await A.evaluate(() => document.getElementById('btn-relaysave').click());
  await A.waitForFunction(() => window.__setp.video && window.__setp.video.maxBitrate >= 2000000, null, { timeout: 5000 });
  const d2 = await A.evaluate(() => window.__setp);
  ok(d2.video.scaleResolutionDownBy === 1 && !('maxBitrate' in (d2.audio || {})), '关掉省流量后：立刻恢复原画质，语音不限');
  // ---- 6. 开着省流量、恢复直连：自动解除 ----
  await A.evaluate(() => document.getElementById('btn-relaysave').click());
  await A.waitForFunction(() => window.__setp.video && window.__setp.video.maxBitrate === 300000, null, { timeout: 5000 });
  await A.evaluate(() => { window.__fakeRelay = false; });
  await A.waitForFunction(() => window.__setp.video && window.__setp.video.maxBitrate >= 2000000, null, { timeout: 7000 });
  ok(await A.evaluate(() => window.__setp.audio && !('maxBitrate' in window.__setp.audio)), '开着省流量但恢复直连：4 秒内自动解除限制');
  await A.evaluate(() => document.getElementById('btn-relaysave').click());   // 测完关回默认
  await A.click('#btn-hangup'); await B.waitForFunction(() => !document.getElementById('call-ui').classList.contains('active'), null, { timeout: 6000 });
  // ---- 6. 中转测试 ----
  await A.click('#chat-back'); await sleep(200); await A.click('.app-nav button[data-tab=me]');
  await A.evaluate(() => { window.__probeMode = true; });
  await A.click('#btn-relaytest');
  await A.waitForFunction(() => /能连上的中转|所有中转都连不上/.test(document.getElementById('relay-res').textContent), null, { timeout: 12000 });
  const rr = await A.textContent('#relay-res');
  ok(/STUN · stun\.miwifi\.com:3478：✅/.test(rr) && /STUN · stun\.hitv\.com:3478：✅/.test(rr) && !/stun\.qq\.com/.test(rr), '中转测试：5 个 STUN 逐个测试（含 hitv，不含 qq）');
  ok(/TestTURN · UDP 3478：✅/.test(rr) && /TestTURN · TCP 3478：❌/.test(rr) && /Metered · UDP 80：❌/.test(rr), '中转测试：每家每个地址单独显示结果');
  ok(/能连上的中转：TestTURN/.test(rr) && !/Metered/.test((rr.split('能连上的中转：')[1] || '').split('\n')[0]) && /账号正确/.test(rr), '中转测试：结论只列出能连上的那家，并说明只代表服务器连得上');
  await A.evaluate(() => { window.__probeMode = false; });

  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
