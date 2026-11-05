// 还没运行 setup-v6.sql 时：文字 / 图片 / 语音照常；表情包 / 视频 / 文件给出明确提示；运行之后不用刷新就能用
const { chromium } = require('playwright');
const fs = require('fs');
const dir = __dirname;
const html = fs.readFileSync(require('path').join(dir, '..', 'site', 'index.html'), 'utf8');
let lib = fs.readFileSync(dir + '/fakelib.js', 'utf8');
while (lib.length < 21000) lib += '/* createClient */';
const results = [];
const ok = (c, t) => { results.push((c ? 'PASS ' : 'FAIL ') + t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => {
    const body = JSON.parse(r.request().postData());
    for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); }
    r.fulfill({ status: 202, body: '' });
  });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }], messages: [], conversations: [], friend_requests: [] };
  const errors = [];
  async function mk(acc) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME|Failed to load resource/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => {
      window.__noV6 = true; window.__toasts = [];
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
  const toastHas = (P, re) => P.evaluate(s => window.__toasts.some(t => new RegExp(s).test(t)), re.source);
  await A.click('.app-nav button[data-tab=me]'); await sleep(1800);
  ok(/🟡 表情包 \/ 视频 \/ 文件：要先在 Supabase 运行 setup-v6\.sql/.test(await A.textContent('#diag')), '环境诊断提示：要先运行 setup-v6.sql');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(300);

  // 文字、图片照常
  await A.fill('#chat-input', '你好'); await A.click('#btn-send'); await sleep(700);
  await A.setInputFiles('#file-input', [{ name: 'p.png', mimeType: 'image/png', buffer: PNG }]); await sleep(900);
  ok(await B.locator('.msg.theirs .bubble', { hasText: '你好' }).count() === 1 && await B.locator('.msg.theirs .bubble.img').count() === 1, '没运行 SQL：文字、图片照常能发');
  await A.setInputFiles('#file-input', [{ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(21 * 1048576) }]); await sleep(800);
  ok(await A.locator('.msg.mine .bubble.img').count() === 1 && await toastHas(A, /超过 20MB/), '没运行 SQL：图片上限仍是 20MB，超过的跳过并提示');

  // 表情面板
  await A.click('#btn-emoji'); await A.click('.ep-tabs button[data-ep=emoji]'); await sleep(150);
  ok(await A.locator('#ep-emoji span[data-e]').count() > 200, '😀 表情页照常能用（插到文字里，不需要 SQL）');
  await A.click('.ep-tabs button[data-ep=lib]'); await sleep(150);
  ok(/setup-v6\.sql/.test(await A.textContent('#ep-lib')) && await A.locator('#ep-lib [data-b]').count() === 0, '表情库页：提示要先运行 setup-v6.sql');
  await A.click('.ep-tabs button[data-ep=mine]'); await sleep(150);
  ok(/setup-v6\.sql/.test(await A.textContent('#ep-mine')), '我的表情页：同样提示');
  await A.fill('#ep-search', '猫'); await sleep(300);
  ok(/setup-v6\.sql/.test(await A.textContent('#ep-find')), '搜索：同样提示');
  await A.fill('#ep-search', ''); await A.click('#btn-emoji');
  await A.fill('#chat-input', '晚安'); await A.type('#chat-input', ' '); await A.press('#chat-input', 'Backspace'); await sleep(200);
  ok(!(await A.isVisible('#stk-suggest.active')), '没运行 SQL：不弹联想表情');
  await A.fill('#chat-input', '');

  // 视频、文件
  await A.setInputFiles('#file-input', [{ name: 'v.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1000, 1) }]); await sleep(900);
  ok(await A.locator('.bubble.video').count() === 0 && await toastHas(A, /setup-v6\.sql/), '没运行 SQL：选视频时提示要先运行 setup-v6.sql，不会发出一条失败的消息');
  await A.setInputFiles('#doc-input', [{ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1000, 1) }]); await sleep(700);
  ok(await A.locator('.bubble.file').count() === 0, '没运行 SQL：发文件同样被拦下');
  await A.locator('.msg.mine .bubble.img img').first().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-stk'); await sleep(300);
  ok(await toastHas(A, /才能发表情包/), '没运行 SQL：图片“添加到表情”给出提示');

  // 存储空间照常
  await A.evaluate(() => { window.__files = [{ id: 'a', name: '1_a.jpg', created_at: new Date(Date.now() - 40 * 86400000).toISOString(), metadata: { size: 1048576 } }]; });
  await A.click('#chat-back'); await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-store'); await sleep(600);
  ok(/共 1 个/.test(await A.textContent('#store-info')), '没运行 SQL：存储空间统计照常');

  // 运行 SQL 之后：不用刷新
  await A.evaluate(() => { window.__noV6 = false; }); await sleep(5200);
  await A.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(1200);
  ok(/✅ 表情包 \/ 视频 \/ 文件/.test(await A.textContent('#diag')), '运行 setup-v6.sql 后回到页面：自动检测到，诊断变成 ✅（不用刷新）');
  await A.click('.app-nav button[data-tab=convs]'); await A.click('.conv-item'); await sleep(400);
  await A.setInputFiles('#file-input', [{ name: 'v.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1000, 1) }]); await sleep(1200);
  ok(await B.locator('.msg.theirs .bubble.video').count() === 1, '然后就能发视频了');

  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
