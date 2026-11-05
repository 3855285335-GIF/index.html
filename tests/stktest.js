// build 3.8：表情包（表情库 / 我的表情 / 搜索 / 联想）、发视频、发文件、保存到手机、转发、链接、置顶 / 免打扰、存储清理不删表情
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
  // 这台测试机默认不是 UTF-8 语言环境，浏览器会把中文下载文件名换成 “download”；手机和正常电脑不会这样
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, acceptDownloads: true });
  const pages = {};
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: /\.pdf/.test(r.request().url()) ? 'application/pdf' : 'image/png', body: PNG }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/realtime/v1/api/broadcast', async r => {
    const body = JSON.parse(r.request().postData());
    for (const m of body.messages) {
      const acc = m.topic.slice(2), p = pages[acc];
      if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {});
    }
    r.fulfill({ status: 202, body: '' });
  });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }, { id: 'uid-carol', account_id: 'carol', nickname: 'Carol' }],
    friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }, { owner_acc: 'alice', friend_acc: 'carol' }, { owner_acc: 'carol', friend_acc: 'alice' }],
    messages: [], conversations: [], friend_requests: [], stickers: [] };
  const errors = [];
  async function mk(acc) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME|Failed to load resource/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(() => {
      window.__toasts = []; window.__shares = [];
      document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); }))).observe(document.body, { childList: true, subtree: true }));
      if (window.__wantShare || localStorage.getItem('wantShare')) {   // 模拟 iPhone 的系统分享：第一次因为“不是用户点的”被拒绝，第二次成功
        let n = 0;
        navigator.canShare = () => true;
        navigator.share = async d => { n++; window.__shares.push(d.files[0].name + '|' + d.files[0].size); if (n === 1) { const e = new Error('not allowed'); e.name = 'NotAllowedError'; throw e; } };
      }
    });
    await p.goto('https://app.test/');
    await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed);
    if (acc === 'bob') { await p.evaluate(() => localStorage.setItem('wantShare', '1')); }
    await p.reload();
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app-view.active');
    await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
    return p;
  }
  const A = await mk('alice'), B = await mk('bob');
  const toastHas = (P, re) => P.evaluate(s => window.__toasts.some(t => new RegExp(s).test(t)), re.source);
  const db = P => P.evaluate(() => JSON.parse(localStorage.getItem('fakedb')));

  // ---- 0. 诊断：后端版本 ----
  await A.click('.app-nav button[data-tab=me]'); await sleep(1800);
  ok(/✅ 表情包 \/ 视频 \/ 文件/.test(await A.textContent('#diag')), '环境诊断显示：✅ 表情包 / 视频 / 文件（已运行 setup-v6.sql）');
  ok(!/VPN/.test(await A.evaluate(() => document.body.innerText)), '页面上没有 VPN 字样');

  // 打开聊天
  await A.click('.app-nav button[data-tab=contacts]'); await A.click('.friend-item[data-acc=bob] .act-chat');
  await B.click('.app-nav button[data-tab=contacts]'); await B.click('.friend-item .act-chat');
  await sleep(300);

  // ---- 1. 表情面板：😀 表情（插到文字里） ----
  await A.click('#btn-emoji'); await sleep(200);
  ok(await A.isVisible('#emoji-panel.active') && await A.isVisible('#ep-search'), '点表情按钮：面板打开，上面有搜索框');
  await A.click('.ep-tabs button[data-ep=emoji]'); await sleep(150);
  const nEmo = await A.locator('#ep-emoji span[data-e]').count();
  ok(nEmo >= 250, '😀 表情页有 ' + nEmo + ' 个 emoji（按类别分组）');
  await A.click('#ep-emoji span[data-e="😂"]'); await A.click('#ep-emoji span[data-e="👍"]');
  ok(await A.inputValue('#chat-input') === '😂👍', '点 emoji 插进输入框（不直接发送）');
  await A.fill('#chat-input', '');

  // ---- 2. 表情库：文字贴纸 / 大表情，点一下发送 ----
  await A.evaluate(() => document.getElementById('emoji-panel').classList.remove('active'));
  await A.click('#btn-emoji'); await A.click('.ep-tabs button[data-ep=lib]'); await sleep(150);
  ok(await A.locator('#ep-lib .tstk').count() === 40 && await A.locator('#ep-lib .stk-it.e').count() >= 40, '表情库：40 个文字贴纸 + 大表情');
  await A.click('#ep-lib [data-b="t:wa"]'); await sleep(900);
  ok(await A.locator('.msg.mine .bubble.sticker .tstk').count() === 1, '发出文字贴纸“晚安”');
  ok(await B.locator('.msg.theirs .bubble.sticker .tstk b', { hasText: '晚安' }).count() === 1, '对方收到文字贴纸“晚安”（显示成贴纸，不是代码）');
  const sm = (await db(A)).messages.find(m => m.type === 'sticker');
  ok(sm && sm.body === 't:wa', '发出去的数据只有几个字节：' + (sm && sm.body));
  await A.click('#ep-lib [data-b="e:🤣"]'); await sleep(700);
  ok(await B.locator('.bubble.sticker .emo', { hasText: '🤣' }).count() === 1, '大表情 🤣 发送成功，对方显示成大表情');
  ok(await A.locator('#ep-lib .ep-cat', { hasText: '最近使用' }).count() === 1 && await A.locator('#ep-lib [data-b="e:🤣"]').count() === 2, '“最近使用”里出现刚发的表情');
  ok((await A.evaluate(() => document.querySelector('#conv-list') && (JSON.parse(localStorage.getItem('fakedb')).conversations.find(c => c.owner_acc === 'bob') || {}).last_body)) === '[表情]', '会话列表预览：[表情]');

  // ---- 3. 搜索 ----
  await A.fill('#ep-search', '晚安'); await sleep(350);
  ok(await A.isVisible('#ep-find') && !(await A.isVisible('.ep-tabs')), '输入关键字：切换到搜索结果，隐藏分类');
  const fTxt = await A.textContent('#ep-find');
  ok(/文字贴纸/.test(fTxt) && await A.locator('#ep-find [data-b="t:wa"]').count() === 1 && await A.locator('#ep-find [data-b="e:😴"]').count() === 1 && await A.locator('#ep-find [data-b="e:🌙"]').count() === 1, '搜“晚安”：找到文字贴纸“晚安”和 😴 🌙');
  await A.fill('#ep-search', '猫'); await sleep(350);
  ok(await A.locator('#ep-find [data-b="e:🐱"]').count() === 1 && await A.locator('#ep-find [data-b="e:😻"]').count() === 1, '搜“猫”：找到 🐱 😻 等');
  await A.fill('#ep-search', '完全不存在的词'); await sleep(350);
  ok(/没有找到/.test(await A.textContent('#ep-find')), '搜不到时有提示');
  await A.fill('#ep-search', ''); await sleep(300);
  ok(await A.isVisible('.ep-tabs'), '清空搜索框：回到分类');

  // ---- 4. 我的表情：上传原图、发送、设置关键词、搜索、置顶、删除 ----
  await A.click('.ep-tabs button[data-ep=mine]'); await sleep(300);
  ok(/0 \/ 500/.test(await A.textContent('#ep-mine')) && await A.locator('#ep-mine .stk-add').count() === 1, '我的表情：显示 0 / 500 和 ＋');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(300000, 7)]);
  await A.setInputFiles('#stk-input', [{ name: 'cat.gif', mimeType: 'image/gif', buffer: gif }, { name: 'dog.png', mimeType: 'image/png', buffer: PNG }]); await sleep(900);
  const upl = await A.evaluate(() => window.__upl || []);
  ok(await A.locator('#ep-mine .stk-m').count() === 2, '添加 2 个表情（GIF 动图也行）');
  ok(upl.some(u => /^alice\/sticker_\d+_\w+\.gif$/.test(u.path) && u.size === gif.length && u.ct === 'image/gif'), '表情按原文件上传到自己文件夹（sticker_ 开头，大小不变，不压缩）');
  await A.setInputFiles('#stk-input', [{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1048576) }]); await sleep(500);
  ok(await A.locator('#ep-mine .stk-m').count() === 2 && await toastHas(A, /超过 10MB/), '超过 10MB 的表情被跳过并提示');
  const firstUrl = await A.getAttribute('#ep-mine .stk-m >> nth=0', 'data-b');
  await A.click('#ep-mine .stk-m >> nth=0'); await sleep(800);
  ok(await B.locator('.msg.theirs .bubble.sticker img').count() === 1, '发出自己的表情（图片），对方收到');
  // 设置关键词
  await A.locator('#ep-mine .stk-m >> nth=1').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  ok(/还没有搜索关键词/.test(await A.textContent('#as-title')), '长按自己的表情：菜单');
  await A.click('#as-items button:has-text("设置搜索关键词")'); await A.waitForSelector('#form-sheet.active'); await sleep(150);
  await A.fill('#fsf0', '  猫猫   可爱 '); await A.click('#fs-ok'); await sleep(400);
  const st1 = (await db(A)).stickers;
  ok(st1.some(x => x.kw === '猫猫 可爱'), '关键词保存到数据库（多余空格已整理）');
  await A.fill('#ep-search', '猫猫'); await sleep(350);
  ok(await A.locator('#ep-find .ep-cat >> nth=0').textContent() === '我的表情' && await A.locator('#ep-find .stk-it img').count() === 1, '搜“猫猫”：自己的表情排在最前面');
  await A.fill('#ep-search', ''); await sleep(250);
  // 移到最前面
  const secUrl = await A.getAttribute('#ep-mine .stk-m >> nth=1', 'data-b');
  await A.locator('#ep-mine .stk-m >> nth=1').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  await A.click('#as-items button:has-text("移到最前面")'); await sleep(400);
  ok(await A.getAttribute('#ep-mine .stk-m >> nth=0', 'data-b') === secUrl, '移到最前面');
  // 联想表情
  await A.click('#btn-emoji'); await sleep(100);
  await A.click('#chat-input'); await A.type('#chat-input', '猫猫'); await sleep(250);
  ok(await A.isVisible('#stk-suggest.active') && await A.locator('#stk-suggest [data-b]').count() >= 1, '输入框打“猫猫”：上方冒出联想表情');
  await A.click('#stk-suggest [data-b] >> nth=0'); await sleep(800);
  ok(await A.inputValue('#chat-input') === '' && !(await A.isVisible('#stk-suggest.active')), '点联想表情：直接发出，输入框清空');
  ok(await B.locator('.msg.theirs .bubble.sticker img').count() === 2, '对方收到联想发出的表情');
  await A.type('#chat-input', '今天天气不错'); await sleep(250);
  ok(!(await A.isVisible('#stk-suggest.active')), '普通句子不会冒联想');
  await A.fill('#chat-input', '');
  // 删除
  await A.click('#btn-emoji'); await A.click('.ep-tabs button[data-ep=mine]'); await sleep(200);
  await A.locator('#ep-mine .stk-m >> nth=1').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  await A.click('#as-items button:has-text("删除这个表情")'); await sleep(400);
  ok(await A.locator('#ep-mine .stk-m').count() === 1 && (await db(A)).stickers.length === 1, '删除表情：面板和数据库都少了一个');
  ok(await B.locator('.msg.theirs .bubble.sticker img').count() === 2, '已经发出的表情不受影响');
  await A.click('#btn-emoji');

  // ---- 5. 对方把表情 / 图片添加到自己的表情 ----
  await B.click('.msg.theirs .bubble.sticker img >> nth=0'); await B.waitForSelector('#act-sheet.active'); await sleep(400);
  await B.click('#as-items button:has-text("添加到我的表情")'); await sleep(900);
  const bst = (await db(B)).stickers.filter(x => x.owner_acc === 'bob');
  ok(bst.length === 1 && /\/chat-media\/bob\/sticker_/.test(bst[0].url), '点对方的表情 → 添加到我的表情：复制一份到自己文件夹（对方清理也不影响）');
  await A.setInputFiles('#file-input', [{ name: 'p.png', mimeType: 'image/png', buffer: PNG }]); await sleep(900);
  await A.locator('.msg.mine .bubble.img img').last().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  ok(await A.isVisible('#msg-menu-stk') && await A.isVisible('#msg-menu-save') && await A.isVisible('#msg-menu-fwd'), '图片的长按菜单有：转发 / 添加到表情 / 保存到手机');
  const nUp = (await A.evaluate(() => window.__upl.length));
  await A.click('#msg-menu-stk'); await sleep(700);
  ok((await db(A)).stickers.filter(x => x.owner_acc === 'alice').length === 2 && (await A.evaluate(() => window.__upl.length)) === nUp, '自己发的图片添加到表情：直接用同一个文件，不重复上传');
  await A.locator('.msg.mine .bubble.img img').last().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-stk'); await sleep(400);
  ok(await toastHas(A, /已经在“我的表情”里了/), '重复添加有提示');

  // ---- 6. 发视频（原文件，不压缩） ----
  const vid = Buffer.alloc(3 * 1048576, 1);
  await A.setInputFiles('#file-input', [{ name: 'IMG_0001.MOV', mimeType: 'video/quicktime', buffer: vid }]); await sleep(1800);
  const vu = (await A.evaluate(() => window.__upl)).find(u => /\.mov$/.test(u.path));
  ok(vu && vu.size === vid.length && vu.ct === 'video/quicktime', '视频按原文件上传（大小不变、类型 video/quicktime）');
  ok(await A.locator('.msg.mine .bubble.video').count() === 1 && await B.locator('.msg.theirs .bubble.video').count() === 1, '视频消息双方都显示');
  const vm = (await db(A)).messages.find(m => m.type === 'video');
  ok(vm && /\/chat-media\/alice\/\d+_\w+\.mov$/.test(vm.body), '视频消息存的是地址：' + (vm && vm.body.split('/').pop()));
  ok((((await db(A)).conversations.find(c => c.owner_acc === 'bob') || {}).last_body) === '[视频]', '会话列表预览：[视频]');
  const tmpDir = fs.mkdtempSync(require('os').tmpdir() + '/stk-'), bigPath = tmpDir + '/big.mp4'; fs.writeFileSync(bigPath, Buffer.alloc(51 * 1048576));
  await A.setInputFiles('#file-input', bigPath); await sleep(1500); fs.rmSync(tmpDir, { recursive: true, force: true });
  ok(await A.locator('.msg.mine .bubble.video').count() === 1 && await toastHas(A, /超过 50MB/), '超过 50MB 的视频被跳过，并说明是 Supabase 免费版的上限');
  await A.setInputFiles('#file-input', [{ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(21 * 1048576) }]); await sleep(1500);
  ok(await A.locator('.msg.mine .bubble.img').count() === 2, '运行 setup-v6.sql 后，21MB 的图片也能发（上限 50MB）');

  // ---- 7. 发文件 ----
  await A.click('#btn-more'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  ok(await A.locator('#as-items button', { hasText: '发送文件' }).count() === 1, '“⋯”菜单里有“发送文件”');
  const [chooser] = await Promise.all([A.waitForEvent('filechooser'), A.click('#as-items button:has-text("发送文件")')]);
  await chooser.setFiles([{ name: '合同 最终版.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(123456, 2) }]); await sleep(1200);
  ok(await A.locator('.msg.mine .bubble.file b', { hasText: '合同 最终版.pdf' }).count() === 1, '文件消息显示文件名');
  ok(/121 KB/.test(await B.textContent('.msg.theirs .bubble.file')) && /PDF/.test(await B.textContent('.msg.theirs .bubble.file .fic')), '对方看到文件名、大小、类型');
  ok((((await db(A)).conversations.find(c => c.owner_acc === 'bob') || {}).last_body) === '[文件] 合同 最终版.pdf', '会话列表预览：[文件] 文件名');
  await A.setInputFiles('#doc-input', [{ name: 'x.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') }]); await sleep(900);
  ok((await A.evaluate(() => window.__upl)).some(u => /\.html$/.test(u.path) && u.ct === 'text/plain'), '网页文件按纯文本存（打开时不会被当成网页运行）');
  await B.evaluate(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f].join('|')); return null; }; });
  await B.click('.msg.theirs .bubble.file >> nth=0'); await sleep(200);
  const op = (await B.evaluate(() => window.__opened))[0] || '';
  ok(/\/chat-media\/alice\/\d+_\w+\.pdf\|_blank\|noopener$/.test(op), '点文件：在新页面打开预览（iPhone 上由 Safari 预览）：' + op.split('/').pop());

  // ---- 8. 保存到手机 ----
  await A.locator('.msg.mine .bubble.file').first().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#msg-menu-save')]);
  ok(dl.suggestedFilename() === '合同 最终版.pdf', '电脑上：保存文件用原来的文件名下载：' + dl.suggestedFilename());
  await A.locator('.msg.mine .bubble.img img').first().click(); await A.waitForSelector('#lightbox.active');
  ok(await A.isVisible('#lb-save'), '看大图时有“保存”按钮');
  const [dl2] = await Promise.all([A.waitForEvent('download'), A.click('#lb-save')]);
  ok(/^Chatter_\d{8}_\d{6}\.png$/.test(dl2.suggestedFilename()), '大图保存：文件名 ' + dl2.suggestedFilename());
  await A.click('#lightbox-img'); await sleep(200);
  // iPhone：系统分享（第一次被拒绝时，弹出“保存 / 分享”按钮再点一次）
  await B.locator('.msg.theirs .bubble.video').first().click({ button: 'right' }); await B.waitForSelector('#msg-menu.active'); await sleep(400);
  await B.click('#msg-menu-save'); await B.waitForSelector('#act-sheet.active', { timeout: 5000 }); await sleep(400);
  ok(/文件准备好了/.test(await B.textContent('#as-title')), 'iPhone：下载完弹出“保存 / 分享”（系统要求必须是手指点的）');
  await B.click('#as-items button:has-text("保存 / 分享")'); await sleep(300);
  const sh = await B.evaluate(() => window.__shares);
  ok(sh.length === 2 && /^Chatter_\d{8}_\d{6}\.mov\|/.test(sh[1]), '调出系统分享面板（可以“存储视频”到相册）：' + sh[1]);

  // ---- 9. 转发 ----
  await A.fill('#chat-input', '转发测试 https://example.com/a?b=1，好吗'); await A.click('#btn-send'); await sleep(800);
  const link = B.locator('.msg.theirs .bubble a').last();
  ok(await link.getAttribute('href') === 'https://example.com/a?b=1' && await link.getAttribute('target') === '_blank', '文字里的网址变成链接（后面的中文逗号不算进网址）');
  await A.locator('.msg.mine .bubble', { hasText: '转发测试' }).click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-fwd'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  ok(/转发给/.test(await A.textContent('#as-title')) && await A.locator('#as-items button', { hasText: 'Carol' }).count() === 1, '转发：列出好友');
  await A.click('#as-items button:has-text("Carol")'); await sleep(900);
  const fw = (await db(A)).messages.filter(m => m.to_acc === 'carol');
  ok(fw.length === 1 && /转发测试/.test(fw[0].body), '转发给 Carol 成功（不在当前聊天里）');
  await A.locator('.msg.mine .bubble.video').first().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-fwd'); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  await A.click('#as-items button:has-text("当前聊天")'); await sleep(900);
  ok(await A.locator('.msg.mine .bubble.video').count() === 2 && await B.locator('.msg.theirs .bubble.video').count() === 2, '转发到当前聊天：视频直接出现');

  // ---- 10. 撤回表情 ----
  await A.click('#btn-emoji'); await A.click('.ep-tabs button[data-ep=lib]'); await A.click('#ep-lib [data-b="t:ok"] >> nth=-1'); await A.click('#btn-emoji'); await sleep(800);
  await A.locator('.msg.mine .bubble.sticker').last().click({ button: 'right' }); await A.waitForSelector('#msg-menu.active'); await sleep(400);
  await A.click('#msg-menu-recall'); await sleep(800);
  ok(await B.locator('.msg.theirs .bubble.recalled').count() === 1, '表情 2 分钟内可以撤回');

  // ---- 11. 快速通道校验：乱发的内容不会显示 ----
  const before = await B.locator('.msg.theirs').count();
  await B.evaluate(() => {
    const send = (type, body) => window.__deliver('u:bob', 'm', { id: 'x' + Math.random(), conv: 'alice::bob', from: 'alice', to: 'bob', type, body });
    send('sticker', 't:不存在'); send('sticker', 'https://evil.test/a.png'); send('video', 'https://evil.test/v.mp4'); send('file', '{"u":"https://evil.test/a.exe","n":"a.exe"}'); send('file', 'not json');
  }); await sleep(400);
  ok(await B.locator('.msg.theirs').count() === before, '快速通道收到格式不对 / 外站地址的表情、视频、文件：一律丢掉');

  // ---- 12. 会话置顶 / 免打扰 ----
  await A.click('#chat-back'); await B.click('#chat-back'); await sleep(400);
  await A.click('.app-nav button[data-tab=convs]').catch(() => {}); await sleep(300);
  ok((await A.getAttribute('.conv-item >> nth=0', 'data-peer')) === 'bob', '置顶前：最近聊过的 Bob 在最上面');
  await A.locator('.conv-item[data-peer=carol]').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  await A.click('#as-items button:has-text("置顶聊天")'); await sleep(300);
  ok((await A.getAttribute('.conv-item >> nth=0', 'data-peer')) === 'carol' && await A.locator('.conv-item.pinned').count() === 1, '置顶后 Carol 排第一');
  await A.locator('.conv-item[data-peer=bob]').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  await A.click('#as-items button:has-text("消息免打扰")'); await sleep(300);
  await B.click('.app-nav button[data-tab=convs]'); await B.click('.conv-item'); await sleep(300); await B.fill('#chat-input', '免打扰测试'); await B.click('#btn-send'); await sleep(900);
  ok(await A.locator('.conv-item[data-peer=bob] .badge.mute').count() === 1 && await A.locator('.conv-item[data-peer=bob] .mute-ic').count() === 1, '免打扰：未读数变灰，名字后有静音图标');
  ok(!/^\(\d+\)/.test(await A.title()), '免打扰的未读不计入标题总数：' + await A.title());
  await A.locator('.conv-item[data-peer=bob]').click({ button: 'right' }); await A.waitForSelector('#act-sheet.active'); await sleep(400);
  ok(await A.locator('#as-items button', { hasText: '删除会话' }).count() === 1 && await A.locator('#as-items button', { hasText: '关闭消息免打扰' }).count() === 1 && await A.locator('#as-items button', { hasText: '置顶聊天' }).count() === 1, '长按会话：置顶 / 免打扰 / 删除会话');
  await A.click('#as-items button:text-is("取消")'); await sleep(200);

  // ---- 13. 存储空间：正在用的表情不清理 ----
  const stNow = (await db(A)).stickers.filter(x => x.owner_acc === 'alice').map(x => x.url.split('/chat-media/alice/')[1]).filter(Boolean);
  await A.evaluate(names => { const old = new Date(Date.now() - 40 * 86400000).toISOString(); window.__files = names.map((n, i) => ({ id: 'k' + i, name: n, created_at: old, metadata: { size: 1048576 } })).concat([{ id: 'o1', name: 'sticker_999_old.png', created_at: old, metadata: { size: 1048576 } }, { id: 'o2', name: '1_a.jpg', created_at: old, metadata: { size: 1048576 } }, { id: 'o3', name: 'avatar_1.jpg', created_at: old, metadata: { size: 1048576 } }]); }, stNow);
  await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-store'); await sleep(700);
  ok(stNow.length === 2 && /共 2 个/.test(await A.textContent('#store-info')), '存储空间只统计可清理的：“我的表情”里的 2 个和头像不算（删掉的表情会算进来）：' + (await A.textContent('#store-info')).slice(0, 40));

  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 6).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
