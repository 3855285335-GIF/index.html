const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  for (const noWS of [false, true]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const U = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/';
  const msgs = []; const t0 = Date.now() - 3600e3;
  for (let i = 0; i < 60; i++) { const type = ['text', 'image', 'sticker', 'video', 'text', 'voice'][i % 6]; const body = type === 'text' ? '消息 ' + i + ' https://example.com/' + i : type === 'sticker' ? 't:ok' : U + i + '_x.' + (type === 'voice' ? 'wav' : type === 'video' ? 'mov' : 'png');
    msgs.push({ id: 'm' + i, conv_key: 'alice::bob', from_acc: i % 2 ? 'alice' : 'bob', to_acc: i % 2 ? 'bob' : 'alice', type, body, dur: 5, created_at: new Date(t0 + i * 60e3).toISOString() }); }
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: msgs,
    conversations: [{ owner_acc: 'alice', conv_key: 'alice::bob', peer_acc: 'bob', last_body: '[语音]', last_ts: msgs[59].created_at, unread: 0 }, { owner_acc: 'bob', conv_key: 'alice::bob', peer_acc: 'alice', last_body: '[语音]', last_ts: msgs[59].created_at, unread: 0 }], friend_requests: [], stickers: [] };
  const p = await ctx.newPage(); pages.alice = p; p.on('pageerror', e => console.log('ERR', e.message));
  if (noWS) await p.addInitScript(() => { window.__noWS = true; });
  await p.addInitScript(() => { window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    window.__mut = { list: 0, msgs: 0, other: 0 }; document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => { const t = m.target; if (t.closest && t.closest('#conv-list')) window.__mut.list++; else if (t.closest && t.closest('#messages')) window.__mut.msgs++; else window.__mut.other++; })).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })); });
  await p.goto('https://app.test/'); await p.evaluate(s => localStorage.setItem('fakedb', JSON.stringify(s)), seed); await p.reload();
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await p.fill('#login-acc', 'alice'); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app-view.active'); await sleep(2500);
  await p.click('.conv-item'); await sleep(2500);
  await p.evaluate(() => { window.__lt = []; window.__mut = { list: 0, msgs: 0, other: 0 }; });
  await sleep(20000);
  const idle = await p.evaluate(() => ({ lt: window.__lt.slice(), mut: Object.assign({}, window.__mut) }));
  console.log(noWS ? '国内模式' : '普通模式', '停在聊天里 20 秒：长任务', idle.lt.length, '个，最长', Math.max(0, ...idle.lt), 'ms；DOM 变化', JSON.stringify(idle.mut));
  await p.evaluate(() => { window.__lt = []; });
  const t1 = Date.now(); await p.type('#chat-input', '测试打字速度一二三四五六七八九十', { delay: 30 }); const typed = Date.now() - t1;
  const ty = await p.evaluate(() => window.__lt.slice());
  console.log('   打字 16 个字：', typed, 'ms，长任务', ty.length, '个，最长', Math.max(0, ...ty), 'ms');
  await p.evaluate(() => { window.__lt = []; }); await p.click('#chat-back'); await sleep(300); const t2 = Date.now(); await p.click('.conv-item'); await p.waitForSelector('.msg'); const op = Date.now() - t2; await sleep(500);
  const oc = await p.evaluate(() => window.__lt.slice());
  console.log('   重新进聊天：', op, 'ms，长任务', oc.length, '个，最长', Math.max(0, ...oc), 'ms');
  await browser.close(); }
})();
