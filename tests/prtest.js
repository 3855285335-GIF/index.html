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

  const restCalls = [];
  await ctx.route('**/rest/v1/rpc/**', async r => {
    const fn = r.request().url().split('/rpc/')[1], body = JSON.parse(r.request().postData() || '{}');
    const acc = (r.request().headers()['authorization'] || '').replace('Bearer tok-', '');
    restCalls.push(fn + ':' + acc + ':' + JSON.stringify(body));
    const any = Object.values(pages)[0];
    if (fn === 'heartbeat') await any.evaluate(([a, on]) => localStorage.setItem('fpres:' + a, on === false ? '0' : String(Date.now())), [acc, body.p_online]);
    if (fn === 'send_signal') await any.evaluate(([a, b]) => { const id = Date.now() * 1000 + Math.floor(Math.random() * 1000); localStorage.setItem('fsig:' + b.p_to + ':' + id, JSON.stringify({ id, from_acc: a, payload: b.p_payload, created_at: new Date().toISOString() })); }, [acc, body]);
    r.fulfill({ status: 204, body: '' });
  });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [] };
  const errors = [];
  async function mk(acc) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc = (window.__osc || 0) + 1; return o.apply(this, arguments); }; } });
    await p.addInitScript(() => { window.__wl = { req: 0, rel: 0 }; Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wl.req++; return { release: async () => { window.__wl.rel++; }, addEventListener() {} }; } } }); });
    if (process.env.NOWS) await p.addInitScript(() => { window.__noWS = true; });
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

  const mode = process.env.NOWS ? '【国内网络】' : '【正常网络】';
  const title = () => B.textContent('#chat-title');
  const hide = (P, v) => P.evaluate(v => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, v);
  await B.waitForFunction(() => /在线/.test(document.getElementById('chat-title').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/在线/.test(await title()), mode + '对方打开 App 后显示“在线”');
  let t0 = Date.now(); await hide(A, true);
  await B.waitForFunction(() => /离线/.test(document.getElementById('chat-title').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/离线/.test(await title()), mode + '对方切到后台：' + (Date.now() - t0) + ' ms 内变成“离线”（不用等 40 秒）');
  t0 = Date.now(); await hide(A, false);
  await B.waitForFunction(() => /在线/.test(document.getElementById('chat-title').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/在线/.test(await title()), mode + '对方回到前台：' + (Date.now() - t0) + ' ms 内变回“在线”');
  t0 = Date.now(); await A.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); window.dispatchEvent(new Event('pagehide')); });   // 真实关闭页面：先进后台再触发 pagehide
  await B.waitForFunction(() => /离线/.test(document.getElementById('chat-title').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/离线/.test(await title()), mode + '对方关闭页面：' + (Date.now() - t0) + ' ms 内变成“离线”，不会残留假在线');
  ok(restCalls.some(c => /^heartbeat:alice:\{"p_online":false\}/.test(c)), mode + '切后台 / 关闭页面时用 keepalive 请求报了离线');
  await sleep(45000);   // 等过一轮 40 秒的定时校对，确认不会被旧数据改回“在线”
  ok(/离线/.test(await title()), mode + '过了一轮定时校对，仍然是“离线”');
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
