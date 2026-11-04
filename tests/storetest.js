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
  const day = 86400000, iso = d => new Date(Date.now() - d * day).toISOString();
  await A.evaluate(([a, b, c, i1, i2, i3]) => { window.__files = [{ id: 'f1', name: '1_old.jpg', created_at: i1, metadata: { size: 5 * 1048576 } }, { id: 'f2', name: '2_mid.jpg', created_at: i2, metadata: { size: 3 * 1048576 } }, { id: 'f3', name: '3_new.wav', created_at: i3, metadata: { size: 1048576 } }, { id: null, name: 'folder' }]; }, [0, 0, 0, iso(40), iso(10), iso(1)]);
  await A.click('#chat-back'); await B.click('#chat-back'); await sleep(300); await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-store'); await sleep(500);
  const info = await A.textContent('#store-info');
  ok(/共 3 个/.test(info) && /9\.0 MB/.test(info), '存储统计：' + info);
  ok(/（1）/.test(await A.textContent('#st-30')) && /（2）/.test(await A.textContent('#st-7')) && /（3）/.test(await A.textContent('#st-all')), '三个清理按钮的数量：1 / 2 / 3');
  await A.click('#st-30'); ok(/再点一次确认/.test(await A.textContent('#st-30')), '第一次点击只提示确认，不会直接删除');
  ok((await A.evaluate(() => window.__removed || [])).length === 0, '确认前没有删除任何文件');
  await A.click('#st-30'); await sleep(600);
  const rm = await A.evaluate(() => window.__removed || []);
  ok(rm.length === 1 && rm[0] === 'alice/1_old.jpg', '确认后只删除 40 天前的文件：' + rm.join(','));
  ok(/共 2 个/.test(await A.textContent('#store-info')), '清理后重新统计');
  await A.click('#st-7'); await sleep(300); await sleep(100);
  ok(/再点一次确认/.test(await A.textContent('#st-7')), '清理 7 天前：同样需要二次确认');
  await sleep(5300);
  ok(!/再点一次确认/.test(await A.textContent('#st-7')), '5 秒不确认，自动取消');
  // 没有权限 / 没运行 SQL
  await A.evaluate(() => { window.__listErr = true; }); await A.click('#btn-store'); await A.click('#btn-store'); await sleep(500);
  ok(/setup-v3\.sql/.test(await A.textContent('#store-info')) && await A.isDisabled('#st-all'), '读不到时提示运行 setup-v3.sql，按钮置灰');
  await A.evaluate(() => { window.__listErr = false; });
  // ---- 图片被清理后：显示占位，点一下重试 ----
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(300);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await ctx.unroute('**/storage/v1/object/public/**');
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 404, body: 'gone' }));
  await A.setInputFiles('#file-input', [{ name: 'x.png', mimeType: 'image/png', buffer: png }]);
  await B.waitForSelector('.imgfail', { timeout: 6000 });
  ok(/无法显示/.test(await B.textContent('.imgfail')), '图片文件被清理(404)后，显示“图片无法显示”占位');
  await ctx.unroute('**/storage/v1/object/public/**');
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await B.click('.imgfail'); await sleep(800);
  ok(await B.locator('.bubble.img img').count() === 1 && await B.locator('.imgfail').count() === 0, '点一下重试，加载成功后恢复显示');
  // ---- 服务器已读 RPC ----
  ok((await B.evaluate(() => window.__mr || 0)) > 0, '打开聊天时调用 mark_read（服务器时间）');
  await A.click('#chat-back'); await sleep(300);
  await A.evaluate(() => { const o = window.__deliver; window.__deliver = (t, e, p) => { if (e === 'rd' || e === 'rq') return; return o(t, e, p); }; });   // 屏蔽实时已读，只靠数据库
  await B.click('#chat-back'); await sleep(300);
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(200);
  await A.fill('#chat-input', '离线已读测试'); await A.click('#btn-send'); await sleep(500);
  await A.click('#chat-back'); await sleep(300);
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat'); await sleep(900);   // B 看了
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item .act-chat'); await sleep(900);   // A 再进来，只能靠 peer_read
  ok((await A.textContent('.msg.mine:last-child .msg-time')).includes('已读') || (await A.locator('.msg.mine .msg-time', { hasText: '已读' }).count()) > 0, 'A 之后再打开聊天，通过数据库补上“已读”（不靠实时通道）');
  // ---- 没运行 SQL：自动回退，不报错 ----
  await B.evaluate(() => { window.__noRpc = true; });
  await A.fill('#chat-input', 'SQL没跑也能用'); await A.click('#btn-send');
  await B.waitForSelector('.bubble:has-text("SQL没跑也能用")', { timeout: 4000 }); await sleep(900);
  const unread = await B.evaluate(() => (JSON.parse(localStorage.getItem('fakedb')).conversations.find(c => c.owner_acc === 'bob') || {}).unread);
  ok(unread === 0, '没运行新 SQL 时，回退到老方式标记已读（unread=' + unread + '）');
  const real = errors.filter(e => !/status of 404/.test(e)); ok(real.length === 0, '页面无未捕获错误（故意制造的 404 除外）' + (real.length ? '：' + real.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
