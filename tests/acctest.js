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
  const tapMe = async P => { await P.click('#chat-back').catch(() => {}); await sleep(250); await P.click('.app-nav button[data-tab=me]'); };
  const openChat = async P => { await P.click('.app-nav button[data-tab=contacts]'); await P.click('.friend-item .act-chat'); await sleep(350); };
  // ---------- 昵称 ----------
  await tapMe(A); await A.click('#btn-nick'); await A.waitForSelector('#form-sheet.active');
  await A.fill('#fsf0', '   '); await A.click('#fs-ok'); await sleep(200);
  ok(/不能为空/.test(await A.textContent('#fs-msg')) && await A.isVisible('#form-sheet.active'), '昵称为空：提示且窗口保持打开');
  await A.fill('#fsf0', 'x'.repeat(21)); ok((await A.inputValue('#fsf0')).length === 20, '昵称输入框限制 20 字');
  await A.fill('#fsf0', 'Alice2'); await A.click('#fs-ok'); await sleep(500);
  ok(!(await A.isVisible('#form-sheet.active')) && (await A.textContent('#me-name2')) === 'Alice2', '昵称修改成功并刷新显示');
  ok(await B.evaluate(() => JSON.parse(localStorage.getItem('fakedb')).profiles.find(p => p.account_id === 'alice').nickname) === 'Alice2', '昵称已写入数据库');
  await B.waitForFunction(() => (document.getElementById('chat-title').textContent || '').includes('Alice2') || document.title !== null, null, { timeout: 4000 });
  // ---------- 密码 ----------
  await A.evaluate(() => { window.__realPw = 'secret1'; });
  await A.click('#btn-pass'); await A.waitForSelector('#form-sheet.active');
  const pw = async (o, n, n2) => { await A.fill('#fsf0', o); await A.fill('#fsf1', n); await A.fill('#fsf2', n2); await A.click('#fs-ok'); await sleep(500); return A.textContent('#fs-msg'); };
  ok(/至少 6 位/.test(await pw('secret1', '123', '123')), '新密码太短：提示');
  ok(/不一致/.test(await pw('secret1', 'newpass1', 'newpass2')), '两次输入不一致：提示');
  ok(/不能和当前密码相同/.test(await pw('secret1', 'secret1', 'secret1')), '新旧密码相同：提示');
  ok(/当前密码不对/.test(await pw('wrongpw', 'newpass1', 'newpass1')), '当前密码错误：被拒绝');
  ok((await A.evaluate(() => window.__pw || [])).length === 0, '前面几次都没有真正修改密码');
  await A.evaluate(() => { window.__failUpdate = true; }); ok(/修改失败/.test(await pw('secret1', 'newpass1', 'newpass1')) && await A.isVisible('#form-sheet.active'), '服务器拒绝时：显示错误、窗口保持打开、可重试');
  await A.evaluate(() => { window.__failUpdate = false; }); await pw('secret1', 'newpass1', 'newpass1');
  ok(!(await A.isVisible('#form-sheet.active')) && (await A.evaluate(() => window.__pw)).join() === 'newpass1', '密码修改成功');
  // 点背景取消
  await A.click('#btn-pass'); await A.waitForSelector('#form-sheet.active'); await A.click('#fs-cancel'); ok(!(await A.isVisible('#form-sheet.active')), '取消可关闭');
  // ---------- 头像 ----------
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await A.setInputFiles('#avatar-input', [{ name: 'me.png', mimeType: 'image/png', buffer: png }]); await sleep(1200);
  ok(await A.locator('#me-avatar img').count() === 1, '头像上传后在“我的”显示');
  ok(/avatar_/.test(await A.evaluate(() => JSON.parse(localStorage.getItem('fakedb')).profiles.find(p => p.account_id === 'alice').avatar_url || '')), '头像地址已写入数据库（文件名带 avatar_）');
  await A.setInputFiles('#avatar-input', [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]); await sleep(300);
  ok(await A.locator('#me-avatar img').count() === 1, '选了非图片：头像保持不变');
  // 清理存储不会列出头像
  await A.evaluate(() => { window.__files = [{ id: 'a', name: 'avatar_1.jpg', created_at: new Date(Date.now() - 99 * 864e5).toISOString(), metadata: { size: 1000 } }, { id: 'b', name: '1_x.jpg', created_at: new Date(Date.now() - 99 * 864e5).toISOString(), metadata: { size: 1000 } }]; });
  await A.click('#btn-store'); await sleep(500);
  ok(/共 1 个/.test(await A.textContent('#store-info')), '存储清理不会统计/删除头像');
  await A.click('#btn-store');
  // ---------- 草稿 ----------
  await openChat(A); await A.fill('#chat-input', '先发一句'); await A.click('#btn-send'); await sleep(400); await A.fill('#chat-input', '写了一半'); await sleep(400);
  await A.click('#chat-back'); await sleep(300); await A.click('.app-nav button[data-tab=convs]'); await sleep(200);
  ok(/\[草稿\]/.test(await A.textContent('#conv-list')) && /写了一半/.test(await A.textContent('#conv-list')), '会话列表显示“[草稿] 写了一半”');
  await A.click('.conv-item'); await sleep(300);
  ok((await A.inputValue('#chat-input')) === '写了一半', '再进入聊天，草稿恢复');
  await A.click('#btn-send'); await sleep(300); await A.click('#chat-back'); await sleep(300);
  ok(!/\[草稿\]/.test(await A.textContent('#conv-list')), '发送后草稿清除');
  await A.click('.conv-item'); await sleep(300); await A.fill('#chat-input', '切后台'); await sleep(400);
  await A.reload(); await A.waitForSelector('#login-acc'); await A.fill('#login-acc', 'alice'); await A.fill('#login-pass', 'secret1'); await A.click('#login-form button[type=submit]'); await A.waitForSelector('#app-view.active'); await A.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); await sleep(300); await A.click('.app-nav button[data-tab=convs]');
  ok(/切后台/.test(await A.textContent('#conv-list')), '刷新页面后草稿还在');
  await A.click('.conv-item'); await sleep(300); await A.fill('#chat-input', ''); await sleep(400); await A.click('#chat-back'); await sleep(300);
  // ---------- 搜索 ----------
  await openChat(A);
  for (const t of ['苹果手机很好用', '今天吃了橙子', '苹果 100% 新鲜_真的']) { await A.fill('#chat-input', t); await A.click('#btn-send'); await sleep(250); }
  await B.waitForSelector('.bubble:has-text("新鲜")');
  await A.click('#btn-more'); await A.waitForSelector('#act-sheet.active');
  ok(await A.isVisible('#act-sheet') && /搜索聊天记录/.test(await A.textContent('#as-items')) && /清空聊天记录/.test(await A.textContent('#as-items')), '右上角“···”菜单：搜索 / 清空');
  await sleep(400); await A.click('#as-items button:has-text("搜索聊天记录")'); await A.waitForSelector('#chat-search.active');
  await A.fill('#cs-input', '苹果'); await sleep(900);
  ok(await A.locator('.cs-item').count() === 2, '搜索“苹果”找到 2 条：' + await A.locator('.cs-item').count());
  ok(await A.locator('.cs-text mark').first().textContent() === '苹果', '关键字高亮');
  await A.fill('#cs-input', '100%'); await sleep(900);
  ok(await A.locator('.cs-item').count() === 1, '特殊符号 % 当作普通字符搜索：' + await A.locator('.cs-item').count());
  await A.fill('#cs-input', '_真'); await sleep(900);
  ok(await A.locator('.cs-item').count() === 1, '特殊符号 _ 当作普通字符搜索');
  await A.fill('#cs-input', '不存在的词'); await sleep(900);
  ok(/没有找到/.test(await A.textContent('#cs-list')), '搜不到时提示');
  await A.fill('#cs-input', '橙子'); await sleep(900); await A.click('.cs-item'); await sleep(500);
  ok(!(await A.isVisible('#chat-search.active')) && await A.evaluate(() => !!document.querySelector('.msg.flash')), '点结果：关闭搜索并定位高亮到原消息');
  // ---------- 清空聊天记录 ----------
  const cnt = await A.locator('.msg').count();
  await A.click('#btn-more'); await sleep(400); await A.click('#as-items button:has-text("清空聊天记录")'); await A.waitForSelector('#act-sheet.active'); await sleep(450);
  ok(/只在你这边/.test(await A.textContent('#as-title')), '清空前需要确认，并说明只影响自己');
  await A.click('#as-items button:has-text("取消")'); await sleep(200);
  ok(await A.locator('.msg').count() === cnt, '取消后没有清空');
  await A.click('#btn-more'); await sleep(400); await A.click('#as-items button:has-text("清空聊天记录")'); await sleep(450); await A.click('#as-items button:has-text("清空聊天记录")'); await sleep(400);
  ok(await A.locator('.msg').count() === 0, '确认后本地聊天记录清空');
  ok(await B.locator('.msg').count() >= 3, '对方的聊天记录不受影响');
  await A.fill('#chat-input', '清空后第一句'); await A.click('#btn-send'); await sleep(500);
  ok(await A.locator('.msg').count() === 1, '清空后新发的消息正常显示（只有 1 条）');
  await B.fill('#chat-input', '对方回复'); await B.click('#btn-send'); await A.waitForSelector('.bubble:has-text("对方回复")', { timeout: 3000 });
  ok(await A.locator('.msg').count() === 2, '清空后对方的新消息正常显示');
  await A.click('#chat-back'); await sleep(300); await A.click('.app-nav button[data-tab=convs]').catch(() => {});
  await A.reload(); await A.waitForSelector('#login-acc'); await A.fill('#login-acc', 'alice'); await A.fill('#login-pass', 'secret1'); await A.click('#login-form button[type=submit]'); await A.waitForSelector('#app-view.active'); await A.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); await sleep(300);
  await A.click('.conv-item'); await sleep(900);
  ok(await A.locator('.msg').count() === 2, '刷新重新登录后，被清空的旧记录不会回来（仍是 2 条）');
  // ---------- 删除会话（列表长按）----------
  await A.click('#chat-back'); await sleep(300);
  await A.locator('.conv-item').first().click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(450);
  ok(await A.locator('#as-items button', { hasText: '置顶聊天' }).count() === 1 && await A.locator('#as-items button', { hasText: '消息免打扰' }).count() === 1, '会话列表长按/右键：菜单有 置顶 / 免打扰 / 删除会话');
  await A.click('#as-items button:has-text("删除会话")'); await sleep(450);
  ok(/删除这个会话/.test(await A.textContent('#as-title')), '点“删除会话”：弹出确认框');
  await A.click('#as-items button:has-text("删除会话")'); await sleep(400);
  ok(await A.locator('.conv-item').count() === 0, '删除会话后从列表消失');
  await B.fill('#chat-input', '你还在吗'); await B.click('#btn-send'); await sleep(900);
  ok(await A.locator('.conv-item').count() === 1, '对方再发消息，会话重新出现');
  await A.click('.conv-item'); await sleep(800);
  ok(await A.locator('.msg').count() === 1 && /你还在吗/.test(await A.textContent('#chat-messages')), '重新出现的会话只有新消息，旧记录没回来');
  const real = errors.filter(e => !/status of 404/.test(e));
  ok(real.length === 0, '页面无未捕获错误' + (real.length ? '：' + real.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
