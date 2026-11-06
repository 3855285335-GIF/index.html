// 视频气泡：发送时截封面、聊天里只显示封面（不加载视频）、点了才播放；没有封面的旧视频照常能看；会话列表预览 [视频]
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const CLIP = fs.readFileSync(__dirname + '/fixtures/clip.webm');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const pages = {}, videoGets = [];
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => {
    const u = r.request().url();
    if (/old_nocover\.webm\.jpg/.test(u)) return r.fulfill({ status: 404, body: '' });          // 旧视频：没有封面
    if (/\.jpg(\?|$)/.test(u)) return r.fulfill({ status: 200, contentType: 'image/jpeg', body: PNG });
    if (/\.webm(\?|#|$)/.test(u)) { videoGets.push(u.split('/').pop()); return r.fulfill({ status: 200, contentType: 'video/webm', body: CLIP }); }
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const U = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/';
  const t0 = Date.now() - 600e3;
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }], friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }],
    messages: [{ id: 'old1', conv_key: 'alice::bob', from_acc: 'bob', to_acc: 'alice', type: 'video', body: U + 'old_nocover.webm', dur: 2, created_at: new Date(t0).toISOString() }],
    conversations: [{ owner_acc: 'alice', conv_key: 'alice::bob', peer_acc: 'bob', last_body: null, last_ts: new Date(t0).toISOString(), unread: 0 }, { owner_acc: 'bob', conv_key: 'alice::bob', peer_acc: 'alice', last_body: '[视频]', last_ts: new Date(t0).toISOString(), unread: 0 }],
    friend_requests: [], stickers: [] };
  const errors = [];
  async function mk(acc) { const p = await ctx.newPage(); pages[acc] = p; p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    await p.goto('https://app.test/'); await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed); await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…'); return p; }
  const A = await mk('alice');
  await sleep(500);
  // 数据库里的会话预览是空的（真实环境里出现过），也不能显示“开始聊天吧”
  await sleep(600); ok(await A.textContent('.conv-item .preview') === '[视频]', '数据库给的预览是空的（真实环境里出现过）：不显示“开始聊天吧”，自己补成 [视频]');
  await A.click('.conv-item'); await sleep(1200);
  // 旧视频（没有封面）：自动退回到以前的显示方式
  ok(await A.locator('.msg[data-id=old1] .bubble.video > video').count() === 1, '没有封面的旧视频：自动改用视频第一帧显示');
  await A.click('#chat-back'); await sleep(300);
  ok(await A.textContent('.conv-item .preview') === '[视频]', '进过聊天后，预览按最后一条消息显示为 [视频]');
  const B = await mk('bob');
  await A.click('.conv-item'); await B.click('.conv-item'); await sleep(800);
  videoGets.length = 0;
  await A.setInputFiles('#file-input', [{ name: 'clip.webm', mimeType: 'video/webm', buffer: CLIP }]); await sleep(2500);
  const upl = await A.evaluate(() => window.__upl || []);
  const vid = upl.find(u => /\.webm$/.test(u.path)), cov = upl.find(u => /\.webm\.jpg$/.test(u.path));
  ok(vid && vid.size === CLIP.length, '视频按原文件上传（大小不变）');
  ok(cov && cov.path === vid.path + '.jpg' && cov.ct === 'image/jpeg' && cov.size > 500 && cov.size < 200000, '同时上传了一张封面（和视频同名加 .jpg，' + (cov ? Math.round(cov.size / 1024) + ' KB' : '没有') + '）');
  const dur = (await A.evaluate(() => JSON.parse(localStorage.getItem('fakedb')).messages.find(m => m.type === 'video' && m.from_acc === 'alice') || {})).dur;
  ok(dur === 2, '视频时长读对了：' + dur + ' 秒');
  const last = B.locator('.msg.theirs .bubble.video').last();
  ok(await last.locator('img.vposter').count() === 1 && /\.webm\.jpg$/.test(await last.locator('img.vposter').getAttribute('src')) && await last.locator('video').count() === 0, '对方聊天里只显示封面，没有放视频播放器');
  ok(await last.locator('.vplay').count() === 1 && /00:02/.test(await last.textContent()), '封面上有播放按钮和时长 00:02');
  await sleep(500);
  ok(videoGets.filter(n => !/old_nocover/.test(n)).length === 0, '没点之前一个字节的视频都没下载（省流量、不卡）');
  await last.click(); await sleep(800);
  const pv = await last.evaluate(b => { const v = b.querySelector('video'); return v ? { c: v.controls, paused: v.paused, src: v.getAttribute('src') } : null; });
  ok(pv && pv.c && /\.webm$/.test(pv.src), '点一下：换成播放器开始播放');
  ok(videoGets.length > 0, '点了之后才开始加载视频');
  await B.click('#chat-back'); await sleep(300);
  ok(await B.textContent('.conv-item .preview') === '[视频]', '会话列表预览：[视频]');
  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 4).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
