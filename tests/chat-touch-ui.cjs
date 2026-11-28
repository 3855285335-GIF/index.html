const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      serviceWorkers: 'block', reducedMotion: 'reduce'
    });
    const origin = 'https://chatter-fixture.test';
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (url.origin !== origin || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return route.abort();
      const type = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
      return route.fulfill({ path: file, contentType: type[path.extname(file)] || 'application/octet-stream' });
    });
    await context.addInitScript(() => { window.__TEST__ = true; });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => !!window.__T && typeof window.__vvApply === 'function');
    await page.waitForFunction(() => document.getElementById("auth-view").classList.contains("active"));
    await page.evaluate(async () => {
      await __T.getReady();
      await __T.sb.auth.getSession();
    });
    await page.evaluate(() => {
      const $ = id => document.getElementById(id);
      $('splash')?.remove();
      $('auth-view').classList.remove('active');
      $('app-view').classList.add('active');
      document.body.classList.add('chat-open');
      const state = window.__T.S;
      state.me = { account_id: 'me' };
      state.conv = 'cat::me';
      state.peer = 'cat';
      state.profiles.bob = { account_id: 'bob', nickname: '好友乙' };
      $('chat-input').focus();
    });
    for (const top of [0, 80]) {
      await page.evaluate(top => {
        Object.defineProperties(window.visualViewport, {
          height: { configurable: true, value: 462 },
          offsetTop: { configurable: true, value: top }
        });
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.__T.onIncoming({
          id: 'test-' + top, type: 'text', body: '隔离测试来信',
          conv: 'bob::me', from_acc: 'bob', to_acc: 'me', created_at: new Date().toISOString()
        });
      }, top);
      await page.waitForTimeout(450);
      const data = await page.evaluate(() => {
        const $ = id => document.getElementById(id);
        const rect = el => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), right: Math.round(r.right), y: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        return {
          top: visualViewport.offsetTop, height: visualViewport.height, focused: document.activeElement.id,
          smallActive: $('msg-banner').classList.contains('on'), largeActive: $('nbar').classList.contains('show'),
          small: rect($('msg-banner')), large: rect($('nbar')), chat: rect($('chat-view'))
        };
      });
      console.log(JSON.stringify(data));
      assert.equal(data.focused, 'chat-input');
      assert.equal(data.smallActive, false);
      assert.equal(data.largeActive, true);
      assert.ok(data.large.right > data.large.x);
      assert.ok(data.large.y >= top && data.large.bottom <= top + data.height);
    }
    await page.evaluate(() => {
      document.getElementById('chat-input').blur();
      const view = document.getElementById('chat-messages');
      const rate = 8000;
      const buf = new ArrayBuffer(44 + rate * 2 * 30);
      const dv = new DataView(buf);
      function text(pos, str) { [...str].forEach((c, i) => dv.setUint8(pos + i, c.charCodeAt(0))); }
      text(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); text(36, 'data'); dv.setUint32(40, buf.byteLength - 44, true);
      const body = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      const rows = ['a', 'b'].map(id => ({ id, conv: 'cat::me', from_acc: 'cat',
        to_acc: 'me', type: 'voice', dur: 30, body, created_at: new Date().toISOString() }));
      window.__T.S.msgs = rows;
      view.innerHTML = rows.map(m => window.__T.msgHTML(m)).join('');
    });
    const first = page.locator('.msg[data-id=a] .voice');
    await first.tap();
    await page.waitForFunction(() => __T.getAudio()?.duration > 29 && !__T.getAudio().paused);
    await page.evaluate(() => { __T.getAudio().currentTime = 6; });
    await first.tap();
    assert.ok(await page.evaluate(() => __T.getAudio()?.paused && Math.abs(__T.getAudio().currentTime - 6) < 1));
    await first.tap();
    await page.waitForFunction(() => !__T.getAudio().paused);
    assert.ok(await page.evaluate(() => Math.abs(__T.getAudio().currentTime - 6) < 1));
    const rect = await first.boundingBox();
    await page.mouse.move(rect.x + 3, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.72, rect.y + rect.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.ok(await page.evaluate(() => __T.getAudio().currentTime > 19 && !__T.getAudio().paused));
    await page.locator('.msg[data-id=b] .voice').tap();
    await page.waitForFunction(() => __T.getPlaying() === 'b' && __T.getAudio().duration > 29);
    assert.ok(await page.evaluate(() => __T.getAudio().currentTime < 2));
    console.log('前台输入横幅唯一且位于可视范围，语音轻点暂停、原位续播、水平拖动和换条均通过。');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
