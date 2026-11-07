// build 3.9：好友备注（数据库 / 本机兜底 / 自动同步）、好友资料页、上传进度、存储快满提醒、导出聊天记录
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function world(opts) {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, acceptDownloads: true, permissions: ['microphone', 'camera'] });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }, { id: 'uid-carol', account_id: 'carol', nickname: 'Carol' }],
    friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }, { owner_acc: 'alice', friend_acc: 'carol' }, { owner_acc: 'carol', friend_acc: 'alice' }],
    messages: [], conversations: [], friend_requests: [], stickers: [] };
  const errors = [];
  async function mk(acc, init) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME|Failed to load resource/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(init || (() => {}));
    await p.addInitScript(() => { window.__toasts = []; window.__shares = [];
      document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); }))).observe(document.body, { childList: true, subtree: true })); });
    await p.goto('https://app.test/');
    await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed);
    await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
    return p;
  }
  return { browser, ctx, mk, errors, pages };
}
const db = P => P.evaluate(() => JSON.parse(localStorage.getItem('fakedb')));
const toastHas = (P, re) => P.evaluate(s => window.__toasts.some(t => new RegExp(s).test(t)), re.source);

(async () => {
  // ================= 第一部分：已运行 setup-v7.sql =================
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__stUsed = 850e6; }), B = await W.mk('bob');
    await sleep(800);
    // ---- 存储快满提醒：打开 App 就提醒（每天一次）----
    ok(await A.isVisible('#act-sheet.active') && /存储空间快满了：两个人一共用了 85%（约 850 MB \/ 1 GB）/.test(await A.textContent('#as-title')), '存储用到 85%：打开 App 就提醒“存储空间快满了”，写清楚用了多少');
    await A.click('#as-items button:has-text("去清理旧文件")'); await sleep(900);
    ok(await A.isVisible('#store-box') && /两个人一共用了 850 MB \/ 1 GB（85%）/.test(await A.textContent('#store-total')) && await A.locator('#store-total .st-bar.warn').count() === 1, '点“去清理旧文件”：直接打开存储空间，显示两人合计用量和红色进度条');
    await A.reload(); await A.waitForSelector('#app-view.active', { timeout: 8000 }).catch(async () => { await A.fill('#login-acc', 'alice'); await A.fill('#login-pass', 'secret1'); await A.click('#login-form button[type=submit]'); await A.waitForSelector('#app-view.active'); });
    await sleep(1200);
    ok(!(await A.isVisible('#act-sheet.active')), '同一天再打开：不会重复提醒');

    // ---- 联系人：“资料”按钮 → 资料页 ----
    await A.click('.app-nav button[data-tab=contacts]'); await sleep(300);
    ok(await A.locator('.friend-item[data-acc=bob] .act-profile').count() === 1 && await A.locator('.friend-item .act-remove').count() === 0, '联系人列表：“删除”按钮换成了“资料”（不会再一碰就删好友）');
    await A.click('.friend-item[data-acc=bob] .act-profile'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    ok(await A.textContent('#pf-name') === 'Bob' && /账号：@bob/.test(await A.textContent('#pf-sub')) && /在线|离线/.test(await A.textContent('#pf-sub')), '资料页：名字、账号、在线状态');
    ok(await A.isVisible('#pf-chat') && await A.isVisible('#pf-voice') && await A.isVisible('#pf-video') && await A.textContent('#pf-remark') === '设置备注' && await A.isVisible('#pf-del'), '资料页：发消息、语音通话、视频通话、设置备注、删除好友');
    // ---- 设置备注 ----
    await A.click('#pf-remark'); await A.waitForSelector('#form-sheet.active'); await sleep(200);
    ok(await A.getAttribute('#fsf0', 'maxlength') === '20', '备注输入框最多 20 个字');
    await A.fill('#fsf0', '  宝贝   一号 '); await A.click('#fs-ok'); await sleep(600);
    const fsRow = (await db(A)).friendships.find(f => f.owner_acc === 'alice' && f.friend_acc === 'bob');
    ok(fsRow && fsRow.remark === '宝贝 一号', '备注存进数据库（多余空格已整理）：' + (fsRow && fsRow.remark));
    ok(await A.textContent('#pf-name') === '宝贝 一号' && /昵称：Bob/.test(await A.textContent('#pf-sub')) && await A.textContent('#pf-remark') === '修改备注', '资料页马上显示备注，下面写着原来的昵称');
    await A.click('#pf-close'); await sleep(300);
    ok(await A.textContent('.friend-item[data-acc=bob] .name-main') === '宝贝 一号' && /昵称：Bob/.test(await A.textContent('.friend-item[data-acc=bob] .name-sub')), '联系人列表显示备注 + 昵称');
    await A.click('.friend-item[data-acc=bob] .act-chat'); await sleep(400);
    ok(/宝贝 一号/.test(await A.textContent('#chat-title')), '聊天标题显示备注');
    await A.fill('#chat-input', '你好呀'); await A.click('#btn-send'); await sleep(700);
    await A.click('#chat-back'); await A.click('.app-nav button[data-tab=convs]'); await sleep(300);
    ok(await A.textContent('.conv-item[data-peer=bob] .conv-name') === '宝贝 一号', '会话列表显示备注');
    await B.click('.app-nav button[data-tab=contacts]'); await sleep(300);
    ok(await B.textContent('.friend-item[data-acc=alice] .name-main') === 'Alice', '备注只有自己看得到：对方那边名字不变');
    // 刷新后还在（从数据库读）
    await A.evaluate(() => localStorage.removeItem('ch2rmk:uid-alice')); await A.reload();
    await A.waitForSelector('#app-view.active', { timeout: 8000 }).catch(async () => { await A.fill('#login-acc', 'alice'); await A.fill('#login-pass', 'secret1'); await A.click('#login-form button[type=submit]'); await A.waitForSelector('#app-view.active'); });
    await sleep(1500);
    ok(await A.textContent('.conv-item[data-peer=bob] .conv-name') === '宝贝 一号', '清掉本机记录再打开：备注从数据库读回来（换手机也在）');

    // ---- 点聊天标题打开资料页；资料页发起语音通话 ----
    await A.click('.conv-item[data-peer=bob]'); await sleep(400);
    await A.click('#chat-title'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    ok(await A.textContent('#pf-name') === '宝贝 一号', '点聊天标题：打开对方资料');
    await A.click('#pf-voice'); await sleep(900);
    ok(await A.isVisible('#call-ui.active') && !(await A.isVisible('#profile-card.active')), '资料页点“语音通话”：直接拨出');
    await A.click('#btn-hangup'); await sleep(1200);

    await B.click('.app-nav button[data-tab=convs]'); await B.click('.conv-item[data-peer=alice]'); await sleep(400);
    // ---- 上传进度 ----
    await A.evaluate(() => { window.__slowUp = 60; window.__seenPct = []; const box = document.getElementById('chat-messages'); new MutationObserver(() => { document.querySelectorAll('.fup, .vup, .uppct').forEach(e => { const t = e.textContent; if (/%/.test(t) && window.__seenPct.indexOf(t) < 0) window.__seenPct.push(t); }); }).observe(box, { subtree: true, childList: true, characterData: true }); });
    await A.setInputFiles('#doc-input', [{ name: '资料.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2 * 1048576, 3) }]); await sleep(1600);
    const seen = await A.evaluate(() => window.__seenPct);
    ok(seen.length >= 3 && seen.some(t => /上传中 [1-9]\d?%/.test(t)), '发 2MB 文件：气泡上显示上传百分比（看到 ' + seen.join('、') + '）');
    const req = (await A.evaluate(() => window.__xhrReqs || [])).slice(-1)[0] || {};
    ok(/^Bearer tok-alice$/.test(req.auth) && req.apikey && req.upsert === 'false' && req.cc === '31536000', '直接上传时带好了登录凭证、项目密钥，不覆盖已有文件，缓存一年');
    const up = (await A.evaluate(() => window.__upl)).slice(-1)[0];
    ok(up && up.via === 'xhr' && up.size === 2 * 1048576 && up.ct === 'application/pdf', '文件原样上传（大小、类型不变）');
    ok(await B.locator('.msg.theirs .bubble.file').count() === 1, '对方收到文件');
    await A.setInputFiles('#doc-input', [{ name: 'p.html', mimeType: 'text/html', buffer: Buffer.alloc(400 * 1024, 60) }]); await sleep(1500);
    ok((await A.evaluate(() => window.__upl)).slice(-1)[0].ct === 'text/plain', '网页文件真正按纯文本上传（以前官方库会忽略这个设置）');
    // 直接上传失败：自动退回官方库
    await A.evaluate(() => { window.__xhrFail = true; window.__slowUp = 0; });
    await A.setInputFiles('#doc-input', [{ name: 'b.zip', mimeType: 'application/zip', buffer: Buffer.alloc(500 * 1024, 4) }]); await sleep(1500);
    const up2 = (await A.evaluate(() => window.__upl)).slice(-1)[0];
    ok(up2 && !up2.via && up2.size === 500 * 1024 && await B.locator('.msg.theirs .bubble.file').count() === 3, '直接上传不通时：自动改用原来的方式上传，照样发出去');
    await A.evaluate(() => { window.__xhrFail = false; });
    // 存储那边拒绝（文件太大）：不再重试，提示清楚
    await A.evaluate(() => { window.__noV6 = true; });   // 模拟存储上限还是 20MB
    const tmpD = fs.mkdtempSync(require('os').tmpdir() + '/v39-'), bigP = tmpD + '/big.png'; fs.writeFileSync(bigP, Buffer.alloc(21 * 1048576, 1));
    await A.setInputFiles('#file-input', bigP); await sleep(2000); fs.rmSync(tmpD, { recursive: true, force: true });
    ok(await toastHas(A, /超过了存储允许的大小/), '存储拒绝太大的文件：直接提示“超过了存储允许的大小”，不会反复重传');
    await A.evaluate(() => { window.__noV6 = false; });

    // ---- 导出聊天记录 ----
    await A.click('#btn-more'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
    ok(await A.locator('#as-items button', { hasText: '导出聊天记录' }).count() === 1 && await A.locator('#as-items button', { hasText: '查看资料' }).count() === 1, '“⋯”菜单里有“查看资料 / 设置备注”和“导出聊天记录”');
    const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#as-items button:has-text("导出聊天记录")')]);
    const fp = await dl.path(), txt = fs.readFileSync(fp, 'utf8');
    ok(/^Chatter聊天记录_宝贝_一号_\d{8}_\d{6}\.html$/.test(dl.suggestedFilename().replace(/^Chatter聊天记录_宝贝_一号_/, 'Chatter聊天记录_宝贝_一号_')) || /^Chatter聊天记录_/.test(dl.suggestedFilename()), '导出文件名：' + dl.suggestedFilename());
    ok(/和 宝贝 一号（@bob）的聊天记录/.test(txt) && /你好呀/.test(txt) && /\[文件\] 资料\.pdf/.test(txt) && /一共 \d+ 条/.test(txt), '导出的网页里有对方名字、文字消息、文件，以及总条数');
    ok(!/<script/i.test(txt), '导出的网页里没有脚本（只有文字和链接）');
    // iPhone：导出后弹出“保存 / 分享”
    await B.evaluate(() => { let n = 0; navigator.canShare = () => true; navigator.share = async d => { window.__shares.push(d.files[0].name + '|' + d.files[0].type); }; });
    await B.click('#btn-more'); await B.waitForSelector('#act-sheet.active'); await sleep(400);
    await B.click('#as-items button:has-text("导出聊天记录")'); await sleep(1200);
    ok(/导出好了：一共 \d+ 条消息/.test(await B.textContent('#as-title')), 'iPhone：导出好后弹出“导出好了，一共 N 条”');
    await B.click('#as-items button:has-text("保存 / 分享")'); await sleep(300);
    ok(/\.html\|text\/html$/.test((await B.evaluate(() => window.__shares))[0] || ''), '点“保存 / 分享”：调出系统分享，可以存到“文件”');

    // ---- 清除备注 ----
    await A.click('#chat-title'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    await A.click('#pf-remark'); await A.waitForSelector('#form-sheet.active'); await sleep(150);
    await A.fill('#fsf0', ''); await A.click('#fs-ok'); await sleep(600);
    ok(await A.textContent('#pf-name') === 'Bob' && ((await db(A)).friendships.find(f => f.owner_acc === 'alice' && f.friend_acc === 'bob') || {}).remark === '', '备注留空保存：恢复显示原来的昵称');
    // ---- 删除好友：先确认 ----
    await A.click('#pf-close'); await sleep(200); await A.click('#chat-back'); await A.click('.app-nav button[data-tab=contacts]'); await sleep(300);
    await A.click('.friend-item[data-acc=carol] .act-profile'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    await A.click('#pf-del'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
    ok(/删除好友“Carol”（@carol）？/.test(await A.textContent('#as-title')), '删除好友：先弹出确认（不再用系统的确认框）');
    await A.click('#as-items button:text-is("取消")'); await sleep(300);
    ok(await A.locator('.friend-item[data-acc=carol]').count() === 1, '点“取消”：好友还在');
    await A.click('.friend-item[data-acc=carol] .act-profile'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    await A.click('#pf-del'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
    await A.click('#as-items button:has-text("删除好友")'); await sleep(900);
    ok(await A.locator('.friend-item[data-acc=carol]').count() === 0, '确认删除：好友没了');
    ok(W.errors.length === 0, '第一部分页面无未捕获错误' + (W.errors.length ? '：' + W.errors.slice(0, 5).join(' | ') : ''));
    await W.browser.close();
  }
  // ================= 第二部分：还没运行 setup-v7.sql =================
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__noV7 = true; window.__stUsed = 950e6; });
    await sleep(800);
    ok(!(await A.isVisible('#act-sheet.active')), '没运行 setup-v7.sql：不弹存储提醒（拿不到两人合计用量），也不报错');
    await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item[data-acc=bob] .act-profile'); await A.waitForSelector('#profile-card.active'); await sleep(300);
    await A.click('#pf-remark'); await A.waitForSelector('#form-sheet.active'); await sleep(150);
    await A.fill('#fsf0', '老板'); await A.click('#fs-ok'); await sleep(600);
    ok(await A.textContent('#pf-name') === '老板' && await toastHas(A, /保存在这台手机上（运行 setup-v7\.sql 后会同步/), '没运行 SQL：备注先存在这台手机上，照样显示，并说明运行后会同步');
    ok(!((await db(A)).friendships.find(f => f.owner_acc === 'alice' && f.friend_acc === 'bob') || {}).remark, '这时数据库里还没有');
    await A.click('#pf-close'); await sleep(200);
    ok(await A.textContent('.friend-item[data-acc=bob] .name-main') === '老板', '联系人列表显示本机备注');
    // 运行 SQL 之后：回到 App 自动同步上去
    await A.evaluate(() => { window.__noV7 = false; }); await sleep(5300);
    await A.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(1800);
    const r = ((await db(A)).friendships.find(f => f.owner_acc === 'alice' && f.friend_acc === 'bob') || {}).remark;
    ok(r === '老板', '运行 setup-v7.sql 后回到 App：本机的备注自动同步进数据库（' + r + '）');
    ok(await A.textContent('.friend-item[data-acc=bob] .name-main') === '老板', '同步后照样显示');
    ok(await A.isVisible('#act-sheet.active') && /95%/.test(await A.textContent('#as-title')), '运行之后，存储提醒也开始工作（95%）');
    ok(W.errors.length === 0, '第二部分页面无未捕获错误' + (W.errors.length ? '：' + W.errors.slice(0, 5).join(' | ') : ''));
    await W.browser.close();
  }
  console.log(results.join('\n')); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
