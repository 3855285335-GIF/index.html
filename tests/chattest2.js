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
  const hide = (P, v) => P.evaluate(v => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, v);
  // ---- 后台：不发已读、标题闪烁；回到前台：发已读、停止闪烁 ----
  await hide(B, true); await sleep(200);
  await A.fill('#chat-input', '后台消息'); await A.click('#btn-send');
  await B.waitForSelector('.bubble:has-text("后台消息")', { timeout: 3000 });
  await sleep(1200);
  ok(!(await A.textContent('.msg.mine:last-child .msg-time')).includes('已读'), 'B 在后台时，A 不显示已读');
  const titles = new Set(); for (let i = 0; i < 6; i++) { titles.add(await B.title()); await sleep(500); }
  ok(titles.size >= 2 && Array.from(titles).some(t => t.includes('新消息')), '后台收到消息，标题闪烁：' + Array.from(titles).join(' / '));
  await hide(B, false);
  await A.waitForFunction(() => /已读/.test(document.querySelector('.msg.mine:last-child .msg-time').textContent), null, { timeout: 4000 });
  ok(true, '回到前台后补发已读');
  await sleep(1200); const t2 = await B.title(); await sleep(1000);
  ok(!(await B.title()).includes('新消息') && !t2.includes('新消息'), '回到前台后标题恢复：' + t2);
  // ---- 特殊内容：消息里自己带标记字符 / 超长 / 换行 / HTML ----
  const weird = '⁣Q123⁣伪造⁣正文 <b>x</b>\n第二行';
  await A.evaluate(t => { const i = document.getElementById('chat-input'); i.value = t; }, weird); await A.click('#btn-send');
  await B.waitForSelector('.msg.theirs:last-child .bubble', { timeout: 3000 }); await sleep(300);
  const wtxt = await B.textContent('.msg.theirs:last-child .bubble');
  ok(wtxt.includes('<b>x</b>') && !(await B.evaluate(() => !!document.querySelector('.msg.theirs:last-child .bubble b'))) && !(await B.evaluate(() => !!document.querySelector('.msg.theirs:last-child .quote'))), '特殊字符/HTML 原样显示，不会变成引用或标签 -> ' + JSON.stringify(wtxt.slice(0, 30)));
  // ---- 回复 → 刷新页面后引用仍在 ----
  await A.locator('.msg.mine .bubble', { hasText: '后台消息' }).click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-reply'); await A.fill('#chat-input', '引用我自己'); await A.click('#btn-send');
  await sleep(600);
  await A.reload(); await A.waitForSelector('#login-acc'); await A.fill('#login-acc', 'alice'); await A.fill('#login-pass', 'secret1'); await A.click('#login-form button[type=submit]'); await A.waitForSelector('#app-view.active'); await A.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(800);
  ok(await A.locator('.bubble.hasq .quote', { hasText: '后台消息' }).count() === 1, '刷新页面后引用依然显示');
  // ---- 撤回被引用的消息：引用块不崩 ----
  await A.locator('.msg.mine .bubble:not(.hasq)', { hasText: '后台消息' }).click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-recall'); await sleep(500);
  ok(await A.locator('.bubble.hasq').count() === 1 && (await A.locator('.bubble.recalled').count()) >= 1, '撤回被引用的消息，引用回复仍正常');
  // ---- 在已读状态下撤回：不应再显示已读 ----
  ok((await A.locator('.msg.mine .bubble.recalled').first().evaluate(e => e.closest('.msg').querySelector('.msg-time').textContent)).indexOf('已读') < 0, '已撤回的消息不显示已读');
  // ---- 图片发送失败后重发 + 不同大小限制 ----
  const tmpD = fs.mkdtempSync(require('os').tmpdir() + '/c2-'), bigP = tmpD + '/big.png'; fs.writeFileSync(bigP, Buffer.alloc(51 * 1024 * 1024));
  await A.setInputFiles('#file-input', bigP); await sleep(800); fs.rmSync(tmpD, { recursive: true, force: true });
  ok(await A.locator('.bubble.img').count() === 0, '超过 50MB 的图片被拒绝且有提示（Supabase 免费版单个文件上限）');
  await A.setInputFiles('#file-input', [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]); await sleep(900);
  ok(await A.locator('.bubble.img').count() === 0 && await A.locator('.msg.mine .bubble.file').count() === 1, '不是图片/视频的文件按“文件”发送，不会当成图片');
  // ---- 10 张只发 9 张 ----
  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await A.setInputFiles('#file-input', Array.from({ length: 10 }, (_, i) => ({ name: i + '.png', mimeType: 'image/png', buffer: tiny })));
  await sleep(2500);
  ok(await A.locator('.msg.mine .bubble.img').count() === 9, '一次选 10 张，只发前 9 张：' + await A.locator('.msg.mine .bubble.img').count());
  // ---- 手机长按（触摸事件）：长按弹菜单；中途移动则取消；菜单刚弹出时的误触不会立刻关掉 ----
  const touch = (P, type) => P.evaluate(ty => { const el = document.querySelector('.msg.theirs .bubble'); el.dispatchEvent(new Event(ty, { bubbles: true, cancelable: true })); }, type);
  await touch(B, 'touchstart'); await sleep(700);
  ok(await B.isVisible('#msg-menu.active'), '长按 0.55 秒后弹出菜单');
  await B.evaluate(() => document.getElementById('msg-menu-backdrop').click()); await sleep(50);
  ok(await B.isVisible('#msg-menu.active'), '菜单刚弹出时的误触不会把它关掉');
  await sleep(400); await B.evaluate(() => document.getElementById('msg-menu-backdrop').click());
  ok(!(await B.isVisible('#msg-menu.active')), '稍后点空白处可以关闭菜单');
  await touch(B, 'touchstart'); await sleep(200); await touch(B, 'touchmove'); await sleep(600);
  ok(!(await B.isVisible('#msg-menu.active')), '按住时手指一动就取消，不弹菜单');
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
