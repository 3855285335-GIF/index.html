// 弹出菜单的动画：从出现到停稳，整个过程都应该在屏幕正中（以前动画会盖掉居中，先在右下闪一下再跳到中间）
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [], stickers: [] };
  async function mk(acc) { const p = await ctx.newPage(); pages[acc] = p; await p.goto('https://app.test/'); await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed); await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); return p; }
  const A = await mk('alice'), B = await mk('bob');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(300);
  await B.fill('#chat-input', '长按我试试'); await B.click('#btn-send'); await sleep(800);
  // 在每一帧记录菜单中心点离屏幕中心有多远
  const track = sel => A.evaluate(sel => new Promise(res => {
    const el = document.querySelector(sel), out = []; const t0 = performance.now();
    const f = () => { const r = el.getBoundingClientRect(); if (r.width) out.push([Math.abs(r.left + r.width / 2 - innerWidth / 2), r.top + r.height / 2 - innerHeight / 2]); if (performance.now() - t0 < 600) requestAnimationFrame(f); else res(out); };
    requestAnimationFrame(f);
  }), sel);
  const cases = [
    ['对方消息的长按菜单', '#msg-menu', async () => A.locator('.msg.theirs .bubble').last().click({ button: 'right' }), async () => A.click('#msg-menu-backdrop', { position: { x: 10, y: 10 } })],
    ['自己消息的长按菜单', '#msg-menu', async () => A.locator('.msg.mine .bubble').last().click({ button: 'right' }), async () => A.click('#msg-menu-backdrop', { position: { x: 10, y: 10 } })],
    ['“⋯”聊天选项', '#act-sheet', async () => A.click('#btn-more'), async () => { await sleep(400); await A.click('#as-items button:text-is("取消")'); }],
  ];
  await A.fill('#chat-input', '我的消息'); await A.click('#btn-send'); await sleep(700);
  for (const [name, sel, open, close] of cases) {
    const p = track(sel); await sleep(16); await open(); const d = await p;
    const dx = Math.max(...d.map(v => v[0])), dyMax = Math.max(...d.map(v => v[1])), dyMin = Math.min(...d.map(v => v[1])), last = d[d.length - 1] || [99, 99];
    ok(d.length > 5 && dx <= 1 && dyMin >= -1 && dyMax <= 9 && Math.abs(last[0]) <= 1 && Math.abs(last[1]) <= 1,
       name + '：动画全程左右都在正中（最大左右偏离 ' + dx.toFixed(1) + ' 像素），只从下方 ' + dyMax.toFixed(1) + ' 像素轻轻升到正中，停稳后完全居中（' + d.length + ' 帧）');
    await sleep(400); await close(); await sleep(400);
  }
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
