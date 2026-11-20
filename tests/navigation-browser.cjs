// 在隔离服务与真实 Chromium 检查，系统位置由 Playwright 提供，不能代替手机实地验收。
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const origin = new URL(process.env.CHATTER_NAV_PREVIEW || 'http://127.0.0.1:58780').origin;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const tag = randomBytes(4).toString('hex'),
  pass = randomBytes(18).toString('hex') + 'Aa!';
async function account(browser, name, latitude, longitude) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['geolocation'],
    geolocation: { latitude, longitude, accuracy: 12 }
  });
  await ctx.route(
    (url) => url.origin !== origin,
    (route) => route.abort()
  );
  await ctx.addInitScript(() => {
    window.__TEST__ = true;
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(16000);
  await page.goto(origin);
  await page.click('#tab-register');
  await page.fill('#reg-acc', name);
  await page.fill('#reg-name', name);
  await page.fill('#reg-pass', pass);
  await page.click('#register-form button[type=submit]');
  await page.waitForFunction((id) => window.__T?.S.me?.account_id === id && __T.S.rt.db, name);
  return page;
}
async function openChat(page, me, peer) {
  await page.evaluate(({ me, peer }) => __T.openConv([me, peer].sort().join('::'), peer), { me, peer });
}
async function enter(page) {
  await page.click('#btn-more');
  await page.getByText('一起导航', { exact: true }).click();
  return page.frameLocator('iframe[title="导航"]');
}
async function offerPoint(nav, name, lat, lon) {
  if (!(await nav.locator('#lat').isVisible())) await nav.locator('#manual summary').click();
  await nav.locator('#place-name').fill(name);
  await nav.locator('#lat').fill(String(lat));
  await nav.locator('#lon').fill(String(lon));
  await nav.locator('#coords button').click();
}
async function read(page, peer, id) {
  return page.evaluate(
    async ({ peer, id }) =>
      await __T.sb.rpc('chatter_navigation', { p_peer: peer, p_action: 'read', p_id: id || null }),
    { peer, id }
  );
}
(async () => {
  const browser = await chromium.launch();
  try {
    const [alice, bob, eve] = ['a', 'b', 'c'].map((x) => 'nav' + x + tag);
    const [a, b, c] = await Promise.all([
      account(browser, alice, 31.21, 121.45),
      account(browser, bob, 31.213, 121.46),
      account(browser, eve, 30.22, 120.1)
    ]);
    for (const [page, peer] of [
      [a, bob],
      [b, alice]
    ])
      assert.equal(
        (await page.evaluate((id) => __T.sb.rpc('send_friend_request', { p_to: id }), peer)).error,
        null
      );
    await a.waitForFunction((id) => __T.S.friends.includes(id), bob);
    await b.waitForFunction((id) => __T.S.friends.includes(id), alice);
    await openChat(a, alice, bob);
    await openChat(b, bob, alice);
    const an = await enter(a);
    await offerPoint(an, '测试场馆东入口', 31.21014, 121.45013);
    const marker = new URL(await an.locator('#route').getAttribute('href'));
    assert.equal(marker.searchParams.get('position'), '121.45013,31.21014');
    assert.equal(marker.searchParams.get('coordinate'), 'wgs84');
    await an.locator('#invite').click();
    await b.locator('[data-nav-invite]').first().click();
    const bn = b.frameLocator('iframe[title="导航"]');
    await bn.locator('#accept').waitFor();
    const pending = (await read(a, bob)).data;
    assert.equal(pending.active, false);
    assert.equal(pending.peerFix, null);
    assert.ok((await read(c, bob, pending.id)).error);
    assert.equal(await bn.locator('#plan-go').isVisible(), false);
    assert.equal(await bn.locator('#back').innerText(), '返回聊天');
    const guestFrame = b.frames().find((f) => f.url().includes('/navigation.html'));
    await guestFrame.evaluate(() => {
      window.navSpoken = [];
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        speak: u => navSpoken.push(u.text), cancel() {}, getVoices: () => [{ lang: 'zh-CN', localService: true }]
      } });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
    });
    await bn.locator('#open-sound').click();
    await bn.locator('#sound-options [value=voice]').check();
    await bn.locator('#close-sound').click();
    await bn.locator('#accept').click();
    await an.locator('#share').click();
    await bn.locator('#share').click();
    await an.locator('#other').filter({ hasText: '好友更新于' }).waitFor();
    await bn.locator('#other').filter({ hasText: '好友更新于' }).waitFor();
    await bn.locator('#separation').filter({ hasText: '直线相距约' }).waitFor();
    assert.equal(await guestFrame.evaluate(() => navSpoken.filter(s => s === '双方已加入同行。').length), 1);
    const view = (await read(b, alice)).data;
    assert.equal(view.peerFix.lat, 31.21);
    assert.equal(view.peerFix.lon, 121.45);
    console.log('双方同意后可见彼此位置，精确经纬度交给高德标记，陌生账号读不到同行。');
    await an.locator('#wait-note').fill('东门蓝色售票亭');
    await an.locator('#wait-here').click();
    await bn.locator('#wait-info').filter({ hasText: '东门蓝色售票亭' }).waitFor();
    await an.locator('#change').click();
    await offerPoint(an, '南入口', 31.219, 121.452);
    await bn.locator('#agree').waitFor();
    assert.equal(await bn.locator('#dest-name').innerText(), '测试场馆东入口');
    assert.equal(await guestFrame.evaluate(() => navSpoken.filter(s => s.includes('提议更换')).length), 1);
    await bn.locator('#agree').click();
    await an.locator('#dest-name').filter({ hasText: '南入口' }).waitFor();
    assert.equal((await read(a, bob)).data.destination.lon, 121.452);
    assert.equal(await guestFrame.evaluate(() => navSpoken.filter(s => s.includes('会合点已更新为南入口')).length), 1);
    const frame = b.frames().find((f) => f.url().includes('/navigation.html'));
    const stale = await frame.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 100000;
      document.dispatchEvent(new Event('visibilitychange'));
      Date.now = now;
      return {
        distance: document.getElementById('separation').textContent,
        other: document.getElementById('other').textContent,
        liveMarker: !!document.querySelector('#map .nav-pin.peer[title="同行好友的位置"]')
      };
    });
    assert.equal(stale.distance, '');
    assert.match(stale.other, /最后更新/);
    assert.equal(stale.liveMarker, false);
    console.log('定位超过 90 秒后，好友的实时标记和两人距离同时撤下。');
    console.log('固定等候点两人均可见；换入口须对方确认，旧路线在确认前保持有效。');
    await a.context().setOffline(true);
    await a.context().setGeolocation({ latitude: 31.222, longitude: 121.463, accuracy: 18 });
    await a.context().setOffline(false);
    await bn.locator('#end').click();
    await an.locator('#trip-status').filter({ hasText: '选好入口' }).waitFor();
    assert.equal((await read(b, alice, pending.id)).data, null);
    await bn.locator('#back').click();
    await b.locator('#btn-more').waitFor();
    assert.equal(await b.evaluate(() => __T.S.peer), alice);
    console.log('断网重连后结束共享，服务端移除临时会话，返回后仍是原好友。');
    await b.evaluate(()=>__T.closeChat());
    await b.click('.app-nav [data-tab="me"]'); await b.click('#btn-navigation');
    const solo=b.frameLocator('iframe[title="导航"]');
    await solo.locator('#query').waitFor();
    assert.equal(await solo.locator('#together').isVisible(),false);
    assert.equal(await solo.locator('#back').innerText(), '返回应用');
    await solo.locator('#back').click();await b.locator('#btn-navigation').waitFor();

    await b.click('.app-nav [data-tab="convs"]');
    await b.click('#btn-apps');
    await b.click('#apps-view [data-app="map"]');
    await b.frameLocator('iframe[title="导航"]').locator('#back').click();
    const musicIcon = b.locator('#apps-view.on .ap-grid [data-app="music"]');
    await musicIcon.click();
    await b.locator('.mu-v.on[data-v="home"] [data-act="back"]').click();
    await musicIcon.waitFor();
    // 播放器使用本地 WAV 夹具，检查两个真实模块的音频协调，无需请求外部歌曲。
    await b.evaluate(async () => {
      const audio = document.getElementById('mu-audio');
      audio.src = 'vendor/navigation-cue.wav'; audio.loop = true; await audio.play();
    });
    await b.click('#apps-view .ap-grid [data-app="map"]');
    await solo.locator('#open-sound').click();
    assert.equal(await b.evaluate(() => document.getElementById('mu-audio').paused), false);
    await solo.locator('#try-sound').click();
    assert.equal(await b.evaluate(() => document.getElementById('mu-audio').paused), true);
    // 子框架消费本次返回，主文档不会重新触发 load。
    await b.evaluate(() => history.back());
    await solo.locator('#sound-dialog').waitFor({ state: 'hidden' });
    assert.ok(await solo.locator('#query').isVisible());
    await solo.locator('#back').click();
    await musicIcon.waitFor();
    console.log('真实音乐播放器用本地音频播放；打开静音导航继续播，主动试听后暂停音乐。');
    console.log('共用应用页的导航可打开并返回格子；搜索、音乐入口仍在。');
    console.log('「我 → 应用 → 导航」可独立打开并返回，不向任何好友广播位置。');
    await a.close();
    await b.close();
    await c.close();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
