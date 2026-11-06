const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (const noWS of [false, true]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(100) }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [], stickers: [] };
  async function mk(acc) { const p = await ctx.newPage(); pages[acc] = p; p.on('pageerror', e => console.log('ERR', e.message)); if (noWS) await p.addInitScript(() => { window.__noWS = true; }); await p.goto('https://app.test/'); await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed); await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); return p; }
  const A = await mk('alice'), B = await mk('bob');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(300);
  await A.fill('#chat-input', 'hi'); await A.click('#btn-send'); await sleep(1500);
  await A.setInputFiles('#file-input', [{ name: 'v.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(3000, 1) }]); await sleep(3000);
  await A.click('#chat-back'); await A.click('.app-nav button[data-tab=convs]'); await B.click('.app-nav button[data-tab=convs]'); await sleep(3500);
  console.log(noWS ? '国内模式' : '普通', 'A:', await A.textContent('.conv-item .preview'), '| B:', await B.textContent('.conv-item .preview'));
  await A.reload(); await B.reload(); await sleep(2500);
  console.log('  刷新后', 'A:', await A.textContent('.conv-item .preview').catch(() => '?'), '| B:', await B.textContent('.conv-item .preview').catch(() => '?'));
  await browser.close(); }
})();
