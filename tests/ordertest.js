// 手机时间不准时：消息顺序要对，收到新消息也不能整页重画（以前每来一条都整页重画，图片视频多时很卡，顺序还会错）
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
 for (const [label, aSkew, bSkew] of [['对方手机慢 8 秒', 0, 8000], ['对方手机快 8 秒', 0, -8000], ['自己手机慢 8 秒', 8000, 0], ['两边都不准（一个慢 6 秒、一个快 5 秒）', 6000, -5000]]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [], stickers: [] };
  async function mk(acc, slow) { const p = await ctx.newPage(); pages[acc] = p; if (slow) await p.addInitScript(ms => { const o = Date.now.bind(Date); Date.now = () => o() - ms; }, slow);
    await p.goto('https://app.test/'); await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed); await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); return p; }
  const A = await mk('alice', aSkew), B = await mk('bob', bSkew);
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(500);
  let rebuilt = 0;
  for (let i = 0; i < 8; i++) {
    await B.evaluate(() => document.querySelectorAll('#chat-messages .msg').forEach(e => { e.__old = 1; }));
    await A.fill('#chat-input', '第 ' + i + ' 条'); await A.click('#btn-send'); await sleep(1800);
    const r = await B.evaluate(() => { const all = [...document.querySelectorAll('#chat-messages .msg')]; return { n: all.length, kept: all.filter(e => e.__old).length }; });
    if (r.n > 1 && r.kept < r.n - 1) rebuilt++;
  }
  const order = await B.evaluate(() => [...document.querySelectorAll('#chat-messages .msg .bubble')].map(b => b.textContent.replace(/[^0-9]/g, '')).join(','));
  const orderA = await A.evaluate(() => [...document.querySelectorAll('#chat-messages .msg .bubble')].map(b => b.textContent.replace(/[^0-9]/g, '')).join(','));
  ok(rebuilt === 0, label + '：收 8 条消息，聊天界面一次都没有整页重画（只追加新的那一条）');
  ok(order === '0,1,2,3,4,5,6,7', label + '：接收方消息顺序正确：' + order);
  ok(orderA === '0,1,2,3,4,5,6,7', label + '：发送方消息顺序正确：' + orderA);
  // 互相回复：交替发送，顺序也要对
  await B.fill('#chat-input', '回复 8'); await B.click('#btn-send'); await sleep(1500);
  await A.fill('#chat-input', '再说 9'); await A.click('#btn-send'); await sleep(1800);
  const ab = await A.evaluate(() => [...document.querySelectorAll('#chat-messages .msg .bubble')].slice(-2).map(b => b.textContent.replace(/[^0-9]/g, '')).join(','));
  const bb = await B.evaluate(() => [...document.querySelectorAll('#chat-messages .msg .bubble')].slice(-2).map(b => b.textContent.replace(/[^0-9]/g, '')).join(','));
  ok(ab === '8,9' && bb === '8,9', label + '：你一句我一句，两边顺序都对（' + ab + ' / ' + bb + '）');
  await browser.close();
 }
 console.log(results.join('\n')); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
