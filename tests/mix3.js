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
    await p.addInitScript(a => { if (a === 'alice') { window.__noWS = true; window.__noRpc = true; } else { window.__noWS = true; window.__noRpc = true; } }, acc); await p.goto('https://app.test/');
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

  const callOnce = async (from, to, label) => {
    const t0 = Date.now();
    await from.click("#btn-video-call"); await to.waitForSelector("#incoming-ui.active", { timeout: 6000 });
    await to.click("#btn-answer");
    try { for (const P of [from, to]) await P.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById("call-status").textContent), null, { timeout: 20000 }); ok(true, label + "：通话接通 " + (Date.now() - t0) + " ms"); }
    catch (e) { ok(false, label + "：没接通 " + await from.textContent("#call-status") + " / " + await to.textContent("#call-status")); }
    await sleep(2500);
    ok(await from.evaluate(() => document.getElementById("call-ui").classList.contains("active")) && await to.evaluate(() => document.getElementById("call-ui").classList.contains("active")), label + "：接通 2.5 秒后两边仍在通话（没有被重复信号误挂断/误报忙线）");
    await from.click("#btn-hangup");
    await to.waitForFunction(() => !document.getElementById("call-ui").classList.contains("active"), null, { timeout: 6000 });
    await sleep(2500);
    ok(!(await to.isVisible("#incoming-ui.active")) && !(await from.isVisible("#incoming-ui.active")), label + "：挂断后没有重复/幽灵来电");
  };
  const msgOnce = async (from, to, txt, label) => {
    const t0 = Date.now(); await from.fill("#chat-input", txt); await from.click("#btn-send");
    await to.waitForSelector(".bubble:has-text(\"" + txt + "\")", { timeout: 6000 }); const ms = Date.now() - t0; await sleep(600);
    ok(await to.locator(".bubble", { hasText: txt }).count() === 1, label + "：" + ms + " ms 到达，且只显示 1 次");
  };

  await sleep(1500);
  await msgOnce(A, B, "没跑SQL也能收", "没运行 v4：消息靠每 2 秒同步");
  await A.click("#chat-back"); await sleep(200); await A.click(".app-nav button[data-tab=me]"); await sleep(1700);
  const dg = await A.textContent("#diag"); ok(/setup-v4\.sql/.test(dg), "诊断页提示运行 setup-v4.sql：" + dg.split("\n").slice(-3).join(" / "));
  await A.click(".app-nav button[data-tab=contacts]"); await A.click(".friend-item .act-chat"); await sleep(300);
  await A.click("#btn-voice-call"); await sleep(600);
  ok(!(await A.isVisible("#call-ui.active")) && /setup-v4/.test(await A.evaluate(() => (document.querySelector(".toast") || {}).textContent || "")), "没运行 v4 时点通话：直接提示原因，不会傻等 45 秒");

  ok(errors.length === 0, "页面无未捕获错误" + (errors.length ? "：" + errors.slice(0, 6).join(" | ") : ""));
  console.log(results.join("\n")); await browser.close(); process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
})().catch(e => { console.log(results.join("\n")); console.log("TEST CRASH", e.message); process.exit(2); });
