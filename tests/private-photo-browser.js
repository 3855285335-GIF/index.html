// Uses an isolated preview with Auth, PostgREST, Realtime and Storage. Never points at production.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const origin = new URL(process.env.CHATTER_PRIVATE_PREVIEW_URL || 'http://127.0.0.1:58776').origin;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const tag = randomBytes(4).toString('hex');
const password = randomBytes(18).toString('hex') + 'Aa!';
const legacyPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X/FsAAAAASUVORK5CYII=';
const urlOf = m => m.body.split('#')[0];
const conversation = (a, b) => [a, b].sort().join('::');
const openChat = (page, me, peer) => page.evaluate(({ conv, peer }) => __T.openConv(conv, peer), { conv: conversation(me, peer), peer });
const waitImage = (page, id, local) => page.waitForFunction(({ id, local }) => {
  const img = document.querySelector(`[data-id="${id}"] .bubble.img img`);
  return !!img && img.naturalWidth > 0 && img.src.startsWith(local ? 'blob:' : location.origin + '/storage/');
}, { id, local });
const authenticatedStatus = (page, url) => page.evaluate(async url => (await fetch(url, { cache: 'no-store', headers: { Authorization: 'Bearer ' + __T.S.token } })).status, url);

async function signUp(browser, account, nickname) {
  const context = await browser.newContext({ viewport: { width:390, height:844 }, isMobile:true, hasTouch:true });
  await context.route(url => url.origin !== origin, route => route.abort());
  await context.addInitScript(() => { window.__TEST__ = true; });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.click('#tab-register');
  await page.fill('#reg-acc', account);
  await page.fill('#reg-name', nickname);
  await page.fill('#reg-pass', password);
  await page.click('#register-form button[type="submit"]');
  await page.waitForFunction(id => __T.S.me?.account_id === id && __T.S.rt.db, account);
  return page;
}
async function befriend(a, b, userA, userB) {
  const ask = (page, peer) => page.evaluate(id => __T.sb.rpc('send_friend_request', { p_to: id }), peer);
  assert.equal((await ask(a,userB)).data, 'ok');
  assert.equal((await ask(b,userA)).data, 'accepted');
  await a.waitForFunction(peer => __T.S.friends.includes(peer), userB);
  await b.waitForFunction(peer => __T.S.friends.includes(peer), userA);
}
// 同一账号的另一个设备只带登录会话，不复制消息或好友设置缓存。
async function anotherDevice(browser, signedIn, legacyOrigin) {
  const state = await signedIn.context().storageState();
  state.origins.forEach(entry => { entry.localStorage = entry.localStorage.filter(k => /^sb-.+-auth-token$/.test(k.name)); });
  const context = await browser.newContext({ storageState:state, serviceWorkers:'block' });
  await context.route(url => url.origin !== origin, route => route.abort());
  let legacy = !!legacyOrigin;
  if (legacy) {
    await context.route(url => url.origin === origin && ['/', '/index.html', '/app.js'].includes(url.pathname), async route => {
      if (!legacy) return route.continue();
      const original = new URL(route.request().url());
      const result = await fetch(new URL(original.pathname + original.search, legacyOrigin));
      assert.equal(result.status, 200);
      await route.fulfill({ contentType:result.headers.get('content-type'), body:await result.text() });
    });
  }
  await context.addInitScript(() => { window.__TEST__ = true; });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__T?.S.me);
  return {page,context,upgrade:async () => {
    legacy = false; await page.reload();
    await page.waitForFunction(() => !!window.__T?.S.me);
  }};
}
async function contactsOnlyCheck(browser, a, b, alice, bob) {
  await b.evaluate(() => __T.closeChat());
  const contact = b.locator('#friend-list .friend-item[data-acc="' + alice + '"]');
  const row = b.locator('#conv-list [data-peer="' + alice + '"]');
  await b.click('.app-nav [data-tab="contacts"]');
  await contact.locator('.act-profile').click(); await b.click('#pf-contacts-only');
  await b.waitForFunction(() => document.querySelector('#pf-contacts-only').getAttribute('aria-pressed') === 'true');
  await b.click('#pf-close');
  const second = await anotherDevice(browser,b);
  try {
    const p = second.page;
    await p.waitForFunction(id => __T.S.convs.some(c => c.peer_acc === id),alice);
    assert.equal(await p.locator('#conv-list [data-peer="' + alice + '"]').count(),0);
    await a.fill('#chat-input','通讯录收信验证'); await a.evaluate(() => __T.sendText());
    await contact.locator('.badge').waitFor();
    assert.equal(await row.count(),0);
    assert.equal(await b.locator('#msg-banner.on').count(),0);
    assert.ok(await a.locator('#conv-list [data-peer="' + bob + '"]').count());
    await contact.locator('.act-chat').click();
    await b.waitForFunction(() => __T.S.msgs.some(m => m.body === '通讯录收信验证'));
    await b.evaluate(() => __T.closeChat()); await b.click('.app-nav [data-tab="contacts"]');
    await contact.locator('.act-profile').click(); await b.click('#pf-contacts-only');
    await b.waitForFunction(() => document.querySelector('#pf-contacts-only').getAttribute('aria-pressed') === 'false');
    await b.click('#pf-close');
    await p.evaluate(() => __T.pullRefresh());
    await p.locator('#conv-list [data-peer="' + alice + '"]').waitFor({state:'attached'});
    await openChat(b,bob,alice);
    console.log('真实隔离账号：通讯录设置跨设备保存，来信留在通讯录并显示未读，原聊天和对方的消息页正常，关闭后两台设备均恢复。');
  } finally { await second.context.close(); }
}
async function legacyPhotoCheck(browser, a, b, c, accounts, photo, expected, oldOrigin) {
  assert.match(oldOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
  const [alice,bob,other] = accounts;
  const device = await anotherDevice(browser,b,oldOrigin);
  const p = device.page;
  try {
    assert.match(await p.locator('script[src^="app.js"]').getAttribute('src'), /20261119d/);
    const attempts = [];
    p.on('request', req => { if (req.url().includes('/storage/v1/object/')) attempts.push(req.url()); });
    await openChat(p,bob,alice);
    const bubble = p.locator('[data-id="' + photo.id + '"] .bubble.img img');
    await p.waitForFunction(id => {
      const image = document.querySelector('[data-id="' + id + '"] .bubble.img img');
      return image?.naturalWidth === 220 && decodeURIComponent(image.src.split('#')[0]).includes('更新 Chatter 后查看原图');
    }, photo.id);
    assert.ok(!attempts.some(u => u.includes(photo.id)));
    await device.context.setOffline(true);
    assert.equal(await bubble.evaluate(img => img.complete && img.naturalWidth === 220),true);
    await device.context.setOffline(false);
    await p.locator('[data-id="' + photo.id + '"] .bubble.img').click({button:'right'});
    await p.click('#msg-menu-fwd');
    await p.locator('#as-items button').filter({hasText:'小周'}).click();
    await openChat(c,other,bob);
    await c.waitForFunction(() => __T.S.msgs.some(m => m.type === 'image' && m.body.startsWith('data:image/') && decodeURIComponent(m.body).includes('从原聊天重新转发')));
    assert.notEqual(await authenticatedStatus(c,urlOf(photo)),200);
    // 旧发送端自己的上传按旧程序工作；单独验证，避免把新版保护误报成所有设备都已启用。
    const oldBytes = Buffer.from(legacyPNG,'base64');
    await p.locator('#file-input').setInputFiles({name:'old.png', mimeType:'image/png',buffer:oldBytes});
    await p.click('#ipv-send');
    await a.waitForFunction(peer => __T.S.msgs.some(m => m.from_acc === peer && m.type === 'image' && m.body.includes('/public/chat-media/')),bob);
    const legacy = await a.evaluate(peer => __T.S.msgs.find(m => m.from_acc === peer && m.type === 'image' && m.body.includes('/public/chat-media/')),bob);
    await waitImage(a,legacy.id,false);
    const oldDownload = await fetch(urlOf(legacy)); assert.ok(oldDownload.ok);
    assert.ok(Buffer.from(await oldDownload.arrayBuffer()).equals(oldBytes));
    console.log('旧版自己选图发送走旧公开路径，新版收图字节一致；旧版转发私密照片只传提示，接收人无法读取原件。');
    await device.upgrade();
    await openChat(p,bob,alice);
    await waitImage(p,photo.id,true);
    const bytes = await p.evaluate(async url => {
      const r = await fetch(url, {headers:{Authorization:'Bearer '+__T.S.token}});
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, urlOf(photo));
    assert.ok(Buffer.from(bytes).equals(expected));
    console.log('线上旧版 20261119d 在真实隔离聊天里收到更新提示，断网时提示仍可见；同一设备升级后能读取同一条消息的原图，字节完全一致。');
  } finally { await device.context.close(); }
}
async function noisePNG(page) {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
}

(async () => {
  const browser = await chromium.launch();
  try {
    const accounts = ['alice_' + tag, 'bob_' + tag, 'other_' + tag];
    const [alice,bob,other] = accounts;
    const [a,b,c] = await Promise.all([signUp(browser,alice,'阿明'),signUp(browser,bob,'小林'),signUp(browser,other,'小周')]);
    await befriend(a,b,alice,bob);
    await befriend(b,c,bob,other);
    await Promise.all([openChat(a,alice,bob),openChat(b,bob,alice)]);
    const legacyId = randomUUID();
    await a.evaluate(async ({ id, raw, alice, bob }) => {
      const media = __T.sb.storage.from('chat-media');
      const path = alice + '/' + id + '.png';
      const bytes = Uint8Array.from(atob(raw), m => m.charCodeAt(0));
      const uploaded = await media.upload(path, new Blob([bytes], {type:'image/png'}));
      if (uploaded.error) throw uploaded.error;
      const data = await __T.sb.from('messages').insert({ id, conv_key:[alice,bob].sort().join('::'), from_acc:alice, to_acc:bob, type:'image', body:media.getPublicUrl(path).data.publicUrl });
      if (data.error) throw data.error;
    }, { id:legacyId, raw:legacyPNG, alice,bob });
    await waitImage(b,legacyId,false);
    console.log('历史公开图片在同一个真实聊天界面仍能显示。');

    await contactsOnlyCheck(browser,a,b,alice,bob);
    const original = await noisePNG(a);
    assert.ok(original.length > 300 * 1024);
    await a.locator('#file-input').setInputFiles({ name:'private.png', mimeType:'image/png', buffer:original });
    await a.click('#ipv-send');
    await b.waitForFunction(() => __T.S.msgs.some(m => m.type === 'image' && m.body.includes('/authenticated/chatter-private/')));
    const photo = await b.evaluate(() => __T.S.msgs.find(m => m.type === 'image' && m.body.includes('/authenticated/chatter-private/')));
    await Promise.all([waitImage(a,photo.id,true),waitImage(b,photo.id,true)]);
    if (process.env.CHATTER_LEGACY_PREVIEW_URL) await legacyPhotoCheck(browser,a,b,c,accounts,photo,original,process.env.CHATTER_LEGACY_PREVIEW_URL);
    const url = urlOf(photo);
    assert.equal((await fetch(url)).ok,false);
    assert.notEqual(await authenticatedStatus(c,url),200);
    assert.notEqual(await authenticatedStatus(c,url+'.t'),200);
    await b.locator(`[data-id="${photo.id}"] .bubble.img img`).click();
    await b.waitForFunction(() => document.querySelector('#lightbox-img').naturalWidth === 640);
    const downloaded = b.waitForEvent('download');
    await b.click('#lb-save');
    const stream = await (await downloaded).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(original), '保存的私密原图发生了变更');
    await b.locator('#lightbox-img').click();
    await b.locator('#lightbox').waitFor({state:'hidden'});
    console.log('从真实上传界面发图，收发双方可以打开并保存原图，陌生人和匿名用户不能读取原件或缩略图。');

    await b.locator(`[data-id="${photo.id}"] .bubble.img`).click({button:'right'});
    await b.click('#msg-menu-fwd');
    await b.locator('#as-items button').filter({ hasText: new RegExp(`小周|${other}`) }).click();
    await openChat(c,other,bob);
    try { await c.waitForFunction(() => __T.S.msgs.some(m => m.type === 'image' && m.body.includes('/authenticated/chatter-private/'))); }
    catch (error) {
      console.error('转发状态', await b.evaluate(() => ({ queue:[...__T.S.out.values()].map(m => [m.type,m._st]), errors: __T.LOG.slice(-4) })));
      throw error;
    }
    const forwarded = await c.evaluate(() => __T.S.msgs.find(m => m.type === 'image' && m.body.includes('/authenticated/chatter-private/')));
    assert.notEqual(urlOf(forwarded),url);
    await waitImage(c,forwarded.id,true);
    assert.equal(await authenticatedStatus(c,urlOf(forwarded)),200);
    assert.notEqual(await authenticatedStatus(a,urlOf(forwarded)),200);
    assert.notEqual(await authenticatedStatus(c,url),200);
    console.log('通过原转发入口生成受新会话权限保护的副本，两条会话的读取权限保持独立。');

    const groupTitle = '私密转发验证';
    const group = await b.evaluate(async ({ title, other }) => {
      await __T.grpCreate(title,[other]);
      return __T.S.conv;
    }, { title:groupTitle, other });
    assert.match(group,/^g:/);
    const groupId = group.slice(2);
    await c.evaluate(async gid => {
      const invitations = await __T.sb.rpc('my_group_invites');
      const invitation = invitations.data.find(item => item.group_id === gid);
      const accepted = await __T.sb.rpc('group_invite_accept', { p_id:invitation.id });
      if (accepted.error) throw accepted.error;
      await __T.openConv('g:'+gid,'g:'+gid);
    }, groupId);
    await openChat(b,bob,alice);
    await waitImage(b,photo.id,true);
    await b.locator(`[data-id="${photo.id}"] .bubble.img`).click({button:'right'});
    await b.click('#msg-menu-fwd');
    await b.locator('#as-items button').filter({hasText:groupTitle}).click();
    await c.waitForFunction(() => __T.S.msgs.some(m => m.type === 'image' && m.body.includes('/authenticated/chatter-private/')));
    const groupPhoto = await c.evaluate(() => __T.S.msgs.find(m => m.type === 'image'));
    await waitImage(c,groupPhoto.id,true);
    assert.notEqual(await authenticatedStatus(a,urlOf(groupPhoto)),200);
    await c.evaluate(async ({ gid, account }) => {
      const r = await __T.sb.from('chat_group_members').delete().eq('group_id',gid).eq('account_id',account);
      if (r.error) throw r.error;
    }, { gid:groupId, account:other });
    assert.notEqual(await authenticatedStatus(c,urlOf(groupPhoto)),200);
    console.log('私密图片转发到群后，群成员可查看。群外账号和退出群聊的账号都读不到。');

    await b.locator(`[data-id="${photo.id}"] .bubble.img img`).click();
    await b.waitForFunction(() => document.querySelector('#lightbox-img').src.startsWith('blob:'));
    await a.locator(`[data-id="${photo.id}"] .bubble.img`).click({button:'right'});
    await a.click('#msg-menu-recall');
    await b.waitForFunction(id => __T.S.msgs.some(m => m.id === id && m.type === 'recalled'), photo.id);
    assert.equal(await b.locator('#lightbox').evaluate(el => el.classList.contains('active')),false);
    assert.notEqual(await authenticatedStatus(b,url),200);
    assert.equal(await authenticatedStatus(c,urlOf(forwarded)),200);
    console.log('发送方撤回后，接收方正在打开的大图关闭，原链接不可重新读取，明确转发的新副本仍可读取。');

    await a.click('#chat-back');
    await a.click('.app-nav button[data-tab="me"]');
    await a.click('#btn-store');
    await a.waitForFunction(() => !document.getElementById('st-all').disabled);
    const count = Number((await a.locator('#st-all').textContent()).match(/（(\d+)）/)[1]);
    assert.equal(count, photo.body.includes('t=1') ? 3 : 2);
    await a.click('#st-all');
    await a.locator('#as-items button').getByText(`删除 ${count} 个附件文件`, {exact:true}).click();
    await a.getByText(`已删除 ${count} 个附件文件`, {exact:true}).waitFor();
    assert.notEqual(await authenticatedStatus(a,url),200);
    assert.equal(await authenticatedStatus(c,urlOf(forwarded)),200);
    console.log('同一附件管理入口列出并删除本账号的公开和私密附件，其他账号的转发副本保留。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
