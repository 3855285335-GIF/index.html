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
  const png = n => { // 合法的最小 PNG，再补零字节到 n 字节（原样发送，不压缩）
    const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    return Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
  };
  const chk = async (P, js, arg) => P.evaluate(js, arg);
  // ---- 输入提示 ----
  await A.fill('#chat-input', ''); await A.type('#chat-input', 'hi', { delay: 30 });
  await B.waitForFunction(() => /正在输入/.test(document.getElementById('chat-title').textContent), null, { timeout: 3000 });
  ok(true, '对方打字时显示“对方正在输入…”');
  await A.fill('#chat-input', ''); await sleep(5200);
  ok(!/正在输入/.test(await B.textContent('#chat-title')), '停止输入 5 秒后提示消失');
  // ---- 发送 + 已读 ----
  await A.fill('#chat-input', '第一条'); await A.click('#btn-send');
  await B.waitForSelector('.msg.theirs .bubble:has-text("第一条")', { timeout: 3000 });
  await A.waitForFunction(() => /已读/.test(document.querySelector('.msg.mine:last-child .msg-time').textContent), null, { timeout: 4000 });
  ok(true, '对方正在看着聊天时，显示“已读”');
  // ---- 回复引用 ----
  await B.locator('.msg.theirs .bubble', { hasText: '第一条' }).click({ button: 'right' });
  await B.waitForSelector('#msg-menu.active');
  ok(!(await B.isVisible('#msg-menu-recall')), '对方的消息：菜单里没有“撤回”');
  ok(await B.isVisible('#msg-menu-reply') && await B.isVisible('#msg-menu-copy') && await B.isVisible('#msg-menu-del'), '菜单有 回复/复制/删除');
  await B.evaluate(() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip = t; } } }); });
  await B.click('#msg-menu-copy'); await sleep(200);
  ok((await B.evaluate(() => window.__clip)) === '第一条', '复制得到纯文字');
  await sleep(450);
  await B.locator('.msg.theirs .bubble', { hasText: '第一条' }).click({ button: 'right' });
  await B.waitForSelector('#msg-menu.active'); await sleep(400); await B.click('#msg-menu-reply');
  ok(await B.isVisible('#reply-bar') && /第一条/.test(await B.textContent('#reply-text')), '回复栏显示被引用内容');
  await B.fill('#chat-input', '收到啦'); await B.click('#btn-send');
  ok(!(await B.isVisible('#reply-bar')), '发送后回复栏收起');
  await A.waitForSelector('.msg.theirs .bubble.hasq', { timeout: 3000 });
  ok(/第一条/.test(await A.textContent('.msg.theirs .bubble.hasq .quote')) && /收到啦/.test(await A.textContent('.msg.theirs .bubble.hasq')), '对方收到带引用的回复');
  ok(!(await A.textContent('.msg.theirs .bubble.hasq')).includes('⁣'), '界面里没有露出内部标记');
  await A.click('.tab-chats, .app-nav button[data-tab=chats]').catch(() => {});
  const pv = await A.evaluate(() => Array.from(document.querySelectorAll('.preview')).map(e => e.textContent).join('|'));
  ok(!pv.includes('⁣') && pv.includes('收到啦') || pv === '', '会话列表预览是纯文字：' + pv);
  await A.click('.app-nav button[data-tab=contacts]').catch(() => {});
  // 点引用跳转
  await A.evaluate(() => { document.querySelector('.msg.theirs .bubble.hasq .quote').click(); });
  ok(await A.evaluate(() => !!document.querySelector('.msg.flash')), '点击引用后原消息高亮');
  // ---- 删除（仅自己）----
  const cntB = await B.locator('.msg').count();
  await B.locator('.msg.mine .bubble', { hasText: '收到啦' }).click({ button: 'right' });
  await B.waitForSelector('#msg-menu.active'); await sleep(400);
  ok(await B.isVisible('#msg-menu-recall'), '自己的消息：菜单里有“撤回”');
  await B.click('#msg-menu-del'); await sleep(200);
  ok(await B.locator('.msg').count() === cntB - 1, '删除后本地消失');
  ok(await A.locator('.bubble.hasq').count() === 1, '删除只影响自己，对方还在');
  await B.click('#chat-back'); await sleep(300);
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(500);
  ok(await B.locator('.bubble', { hasText: '收到啦' }).count() === 0, '重新进入聊天后仍是已删除状态');
  // ---- 多图原图 ----
  await A.setInputFiles('#file-input', [1, 2, 3].map(i => ({ name: 'p' + i + '.png', mimeType: 'image/png', buffer: png(300000 * i) })));
  await B.waitForFunction(() => document.querySelectorAll('.bubble.img').length >= 3, null, { timeout: 6000 });
  ok(true, '一次选 3 张图，对方收到 3 张');
  const ups = await A.evaluate(() => window.__uploads || []);
  ok(ups.slice(-3).join(',') === '300000,600000,900000', '图片按原始大小上传（未压缩）：' + ups.slice(-3).join(','));
  // ---- 看图：左右切换 ----
  await B.locator('.bubble.img img').nth(0).click(); await sleep(150);
  ok(await B.isVisible('#lightbox') && /1 \/ 3|\d \/ 3/.test(await B.textContent('#lb-count')), '打开大图并显示张数：' + await B.textContent('#lb-count'));
  const first = await B.textContent('#lb-count');
  await B.click('#lb-next'); const second = await B.textContent('#lb-count');
  ok(first !== second, '点右箭头切到下一张：' + first + ' → ' + second);
  await B.keyboard.press('ArrowLeft'); ok(await B.textContent('#lb-count') === first, '键盘左键回到上一张');
  await B.mouse.click(200, 400); await sleep(150);
  ok(!(await B.isVisible('#lightbox')), '点一下关闭大图');
  // ---- 失败自动重发 ----
  await A.evaluate(() => { window.__failInsert = true; });
  await A.fill('#chat-input', '断网消息'); await A.click('#btn-send');
  await A.waitForSelector('.st.failed', { timeout: 4000 });
  ok(true, '发送失败显示感叹号');
  await A.evaluate(() => { window.__failInsert = false; });
  await A.waitForFunction(() => !document.querySelector('.st.failed') && !document.querySelector('.st.sending'), null, { timeout: 15000 });
  await B.waitForSelector('.bubble:has-text("断网消息")', { timeout: 4000 });
  ok(await B.locator('.bubble', { hasText: '断网消息' }).count() === 1, '网络恢复后自动重发，对方只收到 1 条');
  // ---- 对方不在聊天界面，之后再进入：补发已读 ----
  await B.click('#chat-back'); await sleep(300);
  await A.fill('#chat-input', '你不在时发的'); await A.click('#btn-send'); await sleep(800);
  ok(!/你不在时发的[\s\S]*已读/.test(await A.textContent('.msg.mine:last-child .msg-time')) && !(await A.textContent('.msg.mine:last-child .msg-time')).includes('已读'), '对方没打开聊天时不显示已读');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat');
  await A.waitForFunction(() => /已读/.test(document.querySelector('.msg.mine:last-child .msg-time').textContent), null, { timeout: 4000 });
  ok(true, '对方打开聊天后，补上“已读”');
  // ---- 对方后台时标题闪烁不报错 ----
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
