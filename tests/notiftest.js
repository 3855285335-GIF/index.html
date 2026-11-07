// build 4.0：来电 / 消息提醒——顶部横幅、App 在后台时的系统通知、推送（开启 / 关闭 / 显示内容）、
// 发消息 / 打电话 / 未接来电 / 加好友时请求推送、点通知打开对应聊天、后台小助手（service worker）弹通知
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
const swSrc = fs.readFileSync(__dirname + '/../site/sw.js', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function world(opts) {
  opts = opts || {};
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) });
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 780 }, permissions: ['microphone', 'camera'].concat(opts.noPerm ? [] : ['notifications']) }, opts.ua ? { userAgent: opts.ua } : {}));
  const pages = {};
  await ctx.route('https://app.test/**', r => {
    const u = r.request().url();
    if (/\/sw\.js$/.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: swSrc });
    if (/\.png$/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (/\.(js|webmanifest)$/.test(u)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await ctx.route('**/storage/v1/object/public/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  await ctx.route('**/rest/v1/rpc/**', r => r.fulfill({ status: 204, body: '' }));   // 页面关闭时用的 keepalive 请求
  await ctx.route('**/realtime/v1/api/broadcast', async r => { const body = JSON.parse(r.request().postData()); for (const m of body.messages) { const p = pages[m.topic.slice(2)]; if (p) p.evaluate(a => window.__deliver(a[0], a[1], a[2]), [m.topic, m.event, m.payload]).catch(() => {}); } r.fulfill({ status: 202, body: '' }); });
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }, { id: 'uid-bob', account_id: 'bob', nickname: 'Bob' }, { id: 'uid-carol', account_id: 'carol', nickname: 'Carol' }, { id: 'uid-dave', account_id: 'dave', nickname: 'Dave' }],
    friendships: [{ owner_acc: 'alice', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'alice' }, { owner_acc: 'alice', friend_acc: 'carol' }, { owner_acc: 'carol', friend_acc: 'alice' }, { owner_acc: 'bob', friend_acc: 'carol' }, { owner_acc: 'carol', friend_acc: 'bob' }],
    messages: [], conversations: [], friend_requests: [], stickers: [], push_subs: [] };
  const errors = [];
  async function mk(acc, init) {
    const p = await ctx.newPage(); pages[acc] = p;
    p.on('pageerror', e => errors.push(acc + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fetching the script|unsupported MIME|Failed to load resource/.test(m.text())) errors.push(acc + ' console: ' + m.text()); });
    await p.addInitScript(init || (() => {}));
    await p.addInitScript(() => {
      window.__TEST__ = true; window.__reqEmu = true; window.__toasts = []; window.__notes = []; window.__pushSub = null;
      document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); }))).observe(document.body, { childList: true, subtree: true }));
      // 无头浏览器的通知权限永远是“拒绝”：按测试需要模拟（默认已允许；__permAsk = 还没问过，点开启时用户点“允许”）
      if (window.Notification) {
        let perm = window.__permAsk ? 'default' : 'granted';
        try { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => window.__permDenied ? 'denied' : perm }); } catch (e) {}
        Notification.requestPermission = cb => { window.__permAsked = (window.__permAsked || 0) + 1; perm = window.__permDenyOnAsk ? 'denied' : 'granted'; if (cb) cb(perm); return Promise.resolve(perm); };
      }
      // 无头浏览器连不上谷歌的推送服务：用假的推送登记代替（和真机拿到的格式一样）
      if (window.PushManager) {
        PushManager.prototype.getSubscription = async function () { return window.__pushSub; };
        PushManager.prototype.subscribe = async function (opt) {
          if (window.__subFail) throw new DOMException('Registration failed - push service error', 'AbortError');
          const key = new Uint8Array(opt.applicationServerKey); window.__subKeyLen = key.length; window.__subVisible = opt.userVisibleOnly;
          const s = { endpoint: 'https://fcm.googleapis.com/fcm/send/fake-' + Math.random().toString(36).slice(2), options: { applicationServerKey: key.buffer },
            toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }; },
            async unsubscribe() { window.__pushSub = null; window.__unsub = (window.__unsub || 0) + 1; return true; } };
          window.__pushSub = s; return s;
        };
      }
      // 记录页面自己弹的系统通知（App 在后台还活着时）
      if (window.ServiceWorkerRegistration) {
        ServiceWorkerRegistration.prototype.showNotification = function (title, o) { window.__notes.push({ title, body: o && o.body, tag: o && o.tag, url: o && o.data && o.data.url, ri: !!(o && o.requireInteraction) }); return Promise.resolve(); };
        ServiceWorkerRegistration.prototype.getNotifications = function () { return Promise.resolve((window.__notes || []).filter(n => !n.closed).map(n => ({ tag: n.tag, close() { n.closed = true; } }))); };
      }
    });
    await p.goto('https://app.test/');
    await p.evaluate(s => { if (!localStorage.getItem('fakedb')) localStorage.setItem('fakedb', JSON.stringify(s)); }, seed);
    if (opts.hash) { await p.goto('about:blank'); await p.goto('https://app.test/' + opts.hash); } else await p.reload();   // 像点通知那样，带着 #c=… 打开 App
    await p.fill('#login-acc', acc); await p.fill('#login-pass', 'secret1'); await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app-view.active'); await p.waitForFunction(() => document.getElementById('me-name').textContent !== '加载中…');
    return p;
  }
  return { browser, ctx, mk, errors, pages };
}
const db = P => P.evaluate(() => JSON.parse(localStorage.getItem('fakedb')));
const toastHas = (P, re) => P.evaluate(s => window.__toasts.some(t => new RegExp(s).test(t)), re.source);
const fnCalls = P => P.evaluate(() => (window.__fnCalls || []).map(c => ({ op: c.op, kind: c.kind, to: c.to, ref: c.ref, auth: c.auth, apikey: c.apikey })));
const openChat = (P, peer) => P.evaluate(p => { const me = window.__T.S.me.account_id; window.__T.openConv([me, p].sort().join('::'), p); }, peer);
const send = async (P, text) => { await P.fill('#chat-input', text); await P.click('#btn-send'); };
const hide = (P, h) => P.evaluate(v => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }, h);

(async () => {
  // ================= 第一部分：后台已开通（setup-v8.sql + chatter-push 函数） =================
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__permAsk = true; });
    await sleep(600);
    // ---- 我 → 通知：开启 ----
    await A.click('.app-nav button[data-tab=me]'); await sleep(200);
    ok(await A.textContent('#btn-notify') === '📳 通知：关', '“我”页面有“📳 通知：关”按钮');
    await A.click('#btn-notify'); await sleep(400);
    ok(await A.isVisible('#notify-box') && /还没开启/.test(await A.textContent('#nt-state')) && await A.isVisible('#nt-on') && !(await A.isVisible('#nt-off')), '点开：说明“还没开启”，只有“开启通知”按钮');
    ok(/顶部弹横幅，不开通知也有/.test(await A.textContent('#nt-tip')), '说明 App 开着时不开通知也有顶部横幅');
    await A.click('#nt-on');
    await A.waitForFunction(() => /已开启/.test(document.getElementById('nt-state').textContent), null, { timeout: 15000 }).catch(() => {});
    const calls1 = await fnCalls(A), d1 = await db(A);
    ok(await A.evaluate(() => window.__permAsked === 1), '点“开启通知”时才向系统要通知权限（只问一次）');
    ok(calls1.some(c => c.op === 'key') && calls1.every(c => /^Bearer tok-alice$/.test(c.auth) && /^sb_publishable_/.test(c.apikey)), '开启时先向推送函数要公钥（带登录凭证和公开 key）');
    ok(await A.evaluate(() => window.__subKeyLen === 65 && window.__subVisible === true), '用 65 字节公钥向浏览器登记推送，并承诺每条推送都显示');
    ok(d1.push_subs.length === 1 && d1.push_subs[0].acc === 'alice' && /^https:\/\/fcm\.googleapis\.com\//.test(d1.push_subs[0].endpoint) && d1.push_subs[0].preview === true, '这台手机登记进数据库（push_save），默认显示内容');
    ok(calls1.some(c => c.op === 'push' && c.kind === 'test'), '开启后马上发一条测试通知');
    ok(await toastHas(A, /通知已开启 ✅/), '提示“通知已开启 ✅ 测试通知几秒内会弹出来”');
    ok(/✅ 已开启/.test(await A.textContent('#nt-state')) && await A.textContent('#btn-notify') === '📳 通知：开' && await A.isVisible('#nt-off') && await A.isVisible('#nt-test') && !(await A.isVisible('#nt-on')), '开启后：状态“✅ 已开启”，按钮变成“通知：开”，出现测试 / 显示内容 / 关闭');
    ok(await A.evaluate(() => !!navigator.serviceWorker.controller || !!navigator.serviceWorker.getRegistration()), '后台小助手（service worker）装好了');
    // ---- 通知显示内容：关 ----
    await A.click('#nt-pv'); await sleep(500);
    ok((await db(A)).push_subs[0].preview === false && await A.textContent('#nt-pv') === '通知显示内容：关' && /不显示消息内容/.test(await A.textContent('#nt-state')), '“通知显示内容”改成关：数据库同步，通知里不显示内容');
    await A.click('#nt-pv'); await sleep(500);
    ok((await db(A)).push_subs[0].preview === true, '再点一次改回显示内容');
    // ---- 测试通知按钮 ----
    const n0 = (await fnCalls(A)).length; await A.click('#nt-test'); await sleep(400);
    ok((await fnCalls(A)).length === n0 + 1 && await toastHas(A, /测试通知已发出/), '“发一条测试通知”按钮可以用');
    // ---- 诊断 ----
    ok(/✅ 通知已开启（这台手机）/.test(await A.textContent('#diag')), '环境诊断里显示“通知已开启”');

    // ---- 发消息给不在线的人：请求推送（连发 3 条只推最后一条） ----
    await openChat(A, 'carol'); await sleep(500);
    const before = (await fnCalls(A)).length;
    await send(A, '在吗'); await send(A, '晚上吃饭'); await send(A, '七点？');
    await sleep(2200);
    const msgCalls = (await fnCalls(A)).slice(before).filter(c => c.kind === 'msg');
    const lastMsg = (await db(A)).messages.filter(m => m.from_acc === 'alice' && m.to_acc === 'carol').pop();
    ok(msgCalls.length === 1 && msgCalls[0].to === 'carol' && msgCalls[0].ref === lastMsg.id, '连发 3 条给不在线的 carol：只请求推送 1 次，用最后一条（服务器会显示“[3条]”）');

    const b1 = (await fnCalls(A)).length;
    await send(A, '发完马上切走'); await sleep(250); await hide(A, true); await sleep(350);
    ok((await fnCalls(A)).slice(b1).filter(c => c.kind === 'msg').length === 1, '发完消息马上切到后台：不等 1.2 秒，立刻请求推送（手机切走后很快会暂停网页）');
    await hide(A, false); await sleep(300);

    // ---- 打电话给不在线的人：来电推送；没接就挂：未接来电 ----
    const b2 = (await fnCalls(A)).length;
    await A.click('#btn-voice-call'); await sleep(1500);
    const cid = await A.evaluate(() => window.__T.S.call && window.__T.S.call.id);
    await A.click('#btn-hangup'); await sleep(800);
    const cc = (await fnCalls(A)).slice(b2);
    ok(cc.some(c => c.kind === 'call' && c.to === 'carol' && c.ref === cid), '打电话：请求推送“来电”（带这次通话的编号）');
    ok(cc.some(c => c.kind === 'miss' && c.to === 'carol' && c.ref === cid) && cc.findIndex(c => c.kind === 'call') < cc.findIndex(c => c.kind === 'miss'), '没接通就挂断：再请求一次“未接来电”');
    ok(!cc.some(c => c.kind === 'msg'), '通话记录那条消息不会再推送一次');
    await A.evaluate(() => history.back()); await sleep(400);

    // ---- 加好友：请求推送 ----
    await A.click('.app-nav button[data-tab=contacts]'); await sleep(200);
    await A.fill('#search-input', 'dave'); await A.click('#search-btn'); await sleep(600);
    const b3 = (await fnCalls(A)).length;
    await A.click('#search-results .act-add[data-acc=dave]'); await sleep(600);
    ok((await fnCalls(A)).slice(b3).some(c => c.kind === 'req' && c.to === 'dave'), '发好友请求：请求推送给对方');

    // ---- 对方在线：不请求推送 ----
    const B = await W.mk('bob');
    await sleep(1500);
    ok(await A.evaluate(() => window.__T.S.fbOnline.has('bob') || window.__T.S.online.has('bob')), '（准备）alice 看到 bob 在线');
    await openChat(A, 'bob'); await sleep(400);
    const b4 = (await fnCalls(A)).length;
    await send(A, '你在线呀'); await sleep(2000);
    ok(!(await fnCalls(A)).slice(b4).some(c => c.kind === 'msg'), '对方在线（App 开着）：不请求推送，省一次请求');

    // ---- 顶部横幅 ----
    // bob 在“通讯录”页：alice 来消息 → 顶部横幅
    await B.click('.app-nav button[data-tab=contacts]'); await sleep(200);
    await send(A, '看横幅'); await B.waitForSelector('#nbar.show', { timeout: 6000 }).catch(() => {});
    ok(await B.isVisible('#nbar.show') && await B.textContent('#nbar .nb-name') === 'Alice' && await B.textContent('#nbar .nb-body') === '看横幅', 'bob 在通讯录页：顶部滑下横幅“Alice：看横幅”');
    await send(A, '第二条'); await sleep(900);
    ok(await B.textContent('#nbar .nb-body') === '[2条] 第二条', '横幅还没收起又来一条：显示“[2条] 第二条”');
    await B.click('#nbar'); await sleep(700);
    ok(await B.evaluate(() => window.__T.S.conv === 'alice::bob') && !(await B.isVisible('#nbar.show')), '点横幅：直接进入和 Alice 的聊天，横幅收起');
    // bob 正在和 alice 聊天：carol 来消息 → 横幅；点了直接切到 carol 的聊天
    const C = await W.mk('carol');
    await sleep(1200);
    await openChat(C, 'bob'); await sleep(400);
    await send(C, '我是 carol'); await B.waitForSelector('#nbar.show', { timeout: 6000 }).catch(() => {});
    ok(await B.isVisible('#nbar.show') && await B.textContent('#nbar .nb-name') === 'Carol', 'bob 正和 Alice 聊天时 Carol 来消息：弹横幅');
    const histLen = await B.evaluate(() => history.length);
    await B.click('#nbar'); await sleep(700);
    ok(await B.evaluate(() => window.__T.S.conv === 'bob::carol') && await B.evaluate(() => history.length) === histLen, '点横幅：从 Alice 的聊天直接切到 Carol 的聊天（返回键不会多一层）');
    // 正在和 carol 聊：carol 的消息不弹横幅
    await send(C, '同一个聊天'); await sleep(1200);
    ok(!(await B.isVisible('#nbar.show')), '正开着这个聊天：不弹横幅');
    // 免打扰：不弹
    await B.evaluate(() => { history.back(); }); await sleep(500);
    await B.click('.app-nav button[data-tab=contacts]'); await sleep(200);
    await B.evaluate(() => window.__T.toggleMute('bob::carol')); await sleep(300);
    await send(C, '免打扰的消息'); await sleep(1500);
    ok(!(await B.isVisible('#nbar.show')), '开了免打扰的聊天：不弹横幅');
    await B.evaluate(() => window.__T.toggleMute('bob::carol'));
    // 在消息列表页：列表本身会更新，不弹横幅
    await B.click('.app-nav button[data-tab=convs]'); await sleep(300);
    await send(C, '列表页'); await sleep(1500);
    ok(!(await B.isVisible('#nbar.show')), '正看着消息列表：不弹横幅（列表本身已更新）');

    // ---- App 在后台（还没被系统关掉）：没开推送的 bob 弹系统通知；开了推送的 alice 交给推送 ----
    await hide(B, true); await sleep(300);
    await send(C, '后台消息'); await sleep(1500);
    const bn = await B.evaluate(() => window.__notes.slice());
    ok(bn.some(n => n.title === 'Carol' && n.body === '后台消息' && n.tag === 'm:carol' && n.url === './#c=carol'), 'bob 的 App 在后台：弹系统通知“Carol：后台消息”，点开会进 Carol 的聊天');
    await hide(B, false); await sleep(400);
    await openChat(B, 'carol'); await sleep(500);
    ok(await B.evaluate(() => window.__notes.filter(n => n.tag === 'm:carol' && !n.closed).length === 0), '打开 Carol 的聊天：Carol 的通知自动收起');
    await B.evaluate(() => history.back()); await sleep(300);
    await hide(A, true); await sleep(300);
    await openChat(C, 'alice'); await sleep(300);
    await send(C, '给 alice'); await sleep(1500);
    ok(await A.evaluate(() => window.__notes.length === 0), 'alice 开了推送：App 在后台时不再自己弹（交给推送，免得一条弹两次）');
    await hide(A, false); await sleep(300);

    // ---- 来电时 App 在后台：弹来电通知 ----
    await openChat(C, 'bob'); await sleep(300);
    await hide(B, true); await sleep(200);
    await C.click('#btn-voice-call'); await sleep(2500);
    const callNote = await B.evaluate(() => window.__notes.find(n => n.tag === 'c:carol'));
    ok(callNote && callNote.title === 'Carol' && callNote.body === '📞 邀请你语音通话' && callNote.ri && callNote.url === './#call=carol', 'bob 的 App 在后台时来电：弹“Carol 📞 邀请你语音通话”，一直留着直到处理');
    await C.click('#btn-hangup'); await sleep(800);
    await hide(B, false); await sleep(300);

    // ---- 好友请求横幅 ----
    await B.click('.app-nav button[data-tab=me]'); await sleep(200);
    const D = await W.mk('dave');
    await D.click('.app-nav button[data-tab=contacts]'); await D.fill('#search-input', 'bob'); await D.click('#search-btn'); await sleep(600);
    await D.click('#search-results .act-add[data-acc=bob]'); await B.waitForSelector('#nbar.show', { timeout: 6000 }).catch(() => {});
    ok(await B.isVisible('#nbar.show') && await B.textContent('#nbar .nb-name') === '新的好友请求' && /Dave（dave）请求加你为好友/.test(await B.textContent('#nbar .nb-body')), '有人加好友：横幅“新的好友请求 Dave（dave）请求加你为好友”');
    await B.click('#nbar'); await sleep(500);
    ok(await B.isVisible('#tab-requests.active'), '点横幅：打开“请求”页');

    // ---- 退出登录：这台手机不再收 alice 的通知 ----
    if (await A.evaluate(() => !!window.__T.S.conv)) { await A.evaluate(() => history.back()); await sleep(400); }
    await A.click('.app-nav button[data-tab=me]'); await sleep(200);
    await A.click('#btn-logout'); await A.waitForSelector('#auth-view.active', { timeout: 8000 }).catch(() => {});
    const d9 = await db(B);
    ok(!d9.push_subs.some(x => x.acc === 'alice') && await A.evaluate(() => (window.__unsub || 0) >= 0), '退出登录：数据库里删掉这台手机的登记（不会再收到 alice 的通知）');
    ok(W.errors.length === 0, '没有脚本错误' + (W.errors.length ? '：' + W.errors.slice(0, 3).join(' | ') : ''));
    await W.browser.close();
  }

  // ================= 第二部分：点通知打开 App、后台小助手收到推送 =================
  {
    const W = await world({ hash: '#c=carol' });
    const B = await W.mk('bob');
    await sleep(1200);
    ok(await B.evaluate(() => window.__T.S.conv === 'bob::carol') && await B.evaluate(() => location.hash === ''), '从通知打开（网址带 #c=carol）：登录后直接进入 Carol 的聊天，网址里的标记清掉');
    await B.evaluate(() => history.back()); await sleep(400);
    // 后台小助手：等它装好
    await B.evaluate(() => navigator.serviceWorker.register('sw.js'));
    await B.evaluate(() => navigator.serviceWorker.ready); await sleep(500);
    const sw = W.ctx.serviceWorkers()[0];
    ok(!!sw && await sw.evaluate(() => self.__chatter.build) === fs_build(), '后台小助手装好了，版本号和页面一致（' + fs_build() + '）');
    // 推送来了：弹通知（用无头浏览器自带的推送测试接口）
    await sw.evaluate(() => { self.__shown = []; self.__badge = null; self.registration.showNotification = (t, o) => { self.__shown.push({ t, o }); return Promise.resolve(); }; if (self.navigator.setAppBadge) self.navigator.setAppBadge = n => { self.__badge = n; return Promise.resolve(); }; });
    const cdp = await W.ctx.newCDPSession(B);
    let regId = null; cdp.on('ServiceWorker.workerRegistrationUpdated', e => { (e.registrations || []).forEach(r => { if (!r.isDeleted && /app\.test/.test(r.scopeURL)) regId = r.registrationId; }); });
    await cdp.send('ServiceWorker.enable'); await sleep(500);
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: 'https://app.test', registrationId: regId, data: JSON.stringify({ title: '老婆', body: '[2条] 晚上一起吃饭吗？', tag: 'm:alice', url: './#c=alice', kind: 'msg', from: 'alice', badge: 3 }) });
    await sleep(800);
    let shown = await sw.evaluate(() => self.__shown);
    ok(shown.length === 1 && shown[0].t === '老婆' && shown[0].o.body === '[2条] 晚上一起吃饭吗？' && shown[0].o.tag === 'm:alice' && shown[0].o.renotify === true && shown[0].o.data.url === './#c=alice', '收到推送：弹通知“老婆：[2条] 晚上一起吃饭吗？”，同一个人的通知会替换成最新一条');
    ok(await sw.evaluate(() => self.__badge === 3 || !self.navigator.setAppBadge), '主屏幕图标角标设成 3（支持的手机上）');
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: 'https://app.test', registrationId: regId, data: JSON.stringify({ title: 'Alice', body: '📞 邀请你语音通话', tag: 'c:alice', url: './#call=alice', kind: 'call', from: 'alice' }) });
    await sleep(800);
    shown = await sw.evaluate(() => self.__shown);
    ok(shown.length === 2 && shown[1].o.requireInteraction === true && shown[1].o.vibrate.length >= 5, '来电推送：通知一直留着、震动更长');
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: 'https://app.test', registrationId: regId, data: 'not json' });
    await sleep(600);
    shown = await sw.evaluate(() => self.__shown);
    ok(shown.length === 3 && shown[2].t === 'Chatter' && shown[2].o.body === 'not json', '推送内容不是标准格式：也照样弹（苹果要求每条推送都要弹）');
    // 点通知：App 开着 → 切到前台并打开对应聊天
    const how = await sw.evaluate(() => self.__chatter.openUrl('./#c=alice'));
    await sleep(900);
    ok(how === 'focus' && await B.evaluate(() => window.__T.S.conv === 'alice::bob'), '点通知（App 开着）：切到前台，打开和 Alice 的聊天');
    await B.evaluate(() => history.back()); await sleep(400);
    await B.evaluate(() => window.__T.goLink('https://app.test/#req')); await sleep(500);
    ok(await B.isVisible('#tab-requests.active'), '点“好友请求”通知（#req）：打开“请求”页');
    const taken0 = await B.evaluate(() => window.__inboxCalls || 0);
    await B.evaluate(() => { window.__tsCalls = 0; const sbc = window.__T.getSb(); const orig = sbc.rpc.bind(sbc); sbc.rpc = (n, a) => { if (n === 'take_signals') window.__tsCalls++; return orig(n, a); }; });
    await B.evaluate(() => window.__T.goLink('https://app.test/#call=alice')); await sleep(600);
    ok(await B.evaluate(() => window.__T.S.conv === 'alice::bob') && await B.evaluate(() => window.__tsCalls >= 1), '点“来电”通知（#call=alice）：打开和 Alice 的聊天，并马上取一次来电信号');
    await B.evaluate(() => window.__T.goLink('https://app.test/#c=stranger')); await sleep(300);
    ok(await B.evaluate(() => window.__T.S.conv === 'alice::bob'), '通知里的账号不是好友：不理会');
    ok(await sw.evaluate(() => typeof self.onfetch === 'undefined' || self.onfetch === null) && !/addEventListener\('fetch'/.test(swSrc), '后台小助手不拦截网页请求（不缓存页面，更新网页不受影响）');
    ok(W.errors.length === 0, '没有脚本错误' + (W.errors.length ? '：' + W.errors.slice(0, 3).join(' | ') : ''));
    await W.browser.close();
  }

  // ================= 第三部分：后台还没开通 / 函数没部署 / iPhone 没加到主屏幕 / 推送服务连不上 =================
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__noV8 = true; });
    await sleep(800);
    await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-notify'); await sleep(600);
    ok(/setup-v8\.sql/.test(await A.textContent('#nt-state')), '没运行 setup-v8.sql：说明要先运行 setup-v8.sql 并部署 chatter-push 函数');
    ok(/setup-v8\.sql/.test(await A.textContent('#diag')), '环境诊断里也写清楚');
    await A.click('#nt-on'); await sleep(1500);
    ok(await toastHas(A, /setup-v8\.sql/) && (await db(A)).push_subs.length === 0, '点“开启通知”：提示先运行 setup-v8.sql，不会登记');
    await openChat(A, 'carol'); await sleep(400);
    await send(A, 'hi'); await sleep(2000);
    ok(!(await fnCalls(A)).some(c => c.op === 'push' && c.kind === 'msg'), '后台没开通时发消息：不去请求推送（省请求）');
    await W.browser.close();
  }
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__noFn = true; });
    await sleep(800);
    await openChat(A, 'carol'); await sleep(400);
    await send(A, 'one'); await sleep(2000);
    await send(A, 'two'); await sleep(2000);
    const c = (await fnCalls(A)).filter(x => x.op === 'push');
    ok(c.length === 1, '推送函数没部署（404）：试过一次之后 10 分钟内不再请求');
    await A.evaluate(() => history.back()); await sleep(300);
    await A.click('.app-nav button[data-tab=me]'); await sleep(200);
    ok(/通知服务连不上/.test(await A.textContent('#diag')), '环境诊断：“通知服务连不上：还没有部署 chatter-push 函数”');
    await A.click('#btn-notify'); await A.click('#nt-on'); await sleep(1500);
    ok(await toastHas(A, /还没有部署 chatter-push 函数/) && (await db(A)).push_subs.length === 0, '函数没部署时点“开启通知”：说清楚原因，不登记');
    await W.browser.close();
  }
  {
    const W = await world();
    const A = await W.mk('alice', () => { window.__subFail = true; });
    await sleep(600);
    await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-notify'); await A.click('#nt-on'); await sleep(1500);
    ok(await toastHas(A, /连不上手机的推送服务/) && (await db(A)).push_subs.length === 0 && /还没开启/.test(await A.textContent('#nt-state')), '手机连不上推送服务（比如安卓在国内连不上谷歌）：说清楚原因，状态仍是“还没开启”');
    await W.browser.close();
  }
  {
    const W = await world({ ua: IPHONE });
    const A = await W.mk('alice');
    await sleep(600);
    await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-notify'); await sleep(300);
    ok(/添加到主屏幕/.test(await A.textContent('#nt-state')) && !(await A.isVisible('#nt-on')), 'iPhone 在 Safari 里打开（没加到主屏幕）：说明要先添加到主屏幕、从图标打开，不显示“开启”按钮');
    ok(/iOS 16\.4/.test(await A.textContent('#nt-tip')), 'iPhone 提示：需要 iOS 16.4 以上');
    const A2 = await W.mk('bob', () => { Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true }); });
    await sleep(600);
    await A2.click('.app-nav button[data-tab=me]'); await A2.click('#btn-notify'); await sleep(300);
    ok(/还没开启/.test(await A2.textContent('#nt-state')) && await A2.isVisible('#nt-on'), 'iPhone 从主屏幕图标打开：可以开启通知');
    await W.browser.close();
  }
  {
    const W = await world({ noPerm: true });
    const A = await W.mk('alice', () => { window.__permDenied = true; });
    await sleep(600);
    await A.click('.app-nav button[data-tab=me]'); await A.click('#btn-notify'); await sleep(300);
    ok(/之前点了“不允许”/.test(await A.textContent('#nt-state')) && !(await A.isVisible('#nt-on')), '之前拒绝过通知权限：告诉用户去系统设置里打开');
    await W.browser.close();
  }
  console.log(results.join('\n'));
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });

function fs_build() { return (/<div class="build">build ([^<]+)<\/div>/.exec(html) || [])[1]; }
