// 固定源码 + 本机 Chromium，无登录、无生产服务。另一份源码可通过 CHATTER_TEST_ROOT 指定。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(process.env.CHATTER_TEST_ROOT || path.join(__dirname, '..'));
let browser, server, origin;
before(async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/prior') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<title>Previous page</title><a href="/">打开 Chatter</a>');
    }
    if (pathname === '/first-paint') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 仅传至首个同步主题脚本末尾，观察较大的其余 HTML 到达前的画布。
      return res.end(html.slice(0, html.indexOf('</script>') + '</script>'.length) + '</head><body></body>');
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404; return res.end();
    }
    const mime = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    res.setHeader('Content-Type', (mime[path.extname(file)] || 'application/octet-stream'));
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {});
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

async function session(run, options = {}) {
  const context = await browser.newContext({isMobile: true, hasTouch: true, viewport: {width: 390, height: 844},
    screen: {width: 390, height: 844}, colorScheme: 'dark', serviceWorkers: options.worker ? 'allow' : 'block'});
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(theme => {
      window.__TEST__ = true;
      if (theme) localStorage.setItem('ch2theme', JSON.stringify(theme));
    }, options.theme);
    const page = await context.newPage();
    page.setDefaultTimeout(6500);
    await run(page, context);
  } finally { await context.close(); }
}
async function ready(page) {
  await page.waitForFunction(() => window.__T && document.querySelector('#auth-view.active'));
  // 等初始化会话回调完成，再设置独立夹具的聊天状态。
  await page.evaluate(async () => {
    await __T.getReady();
    await __T.sb.auth.getSession();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function chat(page) {
  await page.evaluate(() => {
    document.getElementById('splash')?.remove();
    document.getElementById('auth-view').classList.remove('active');
    document.getElementById('app-view').classList.add('active');
    document.body.classList.add('chat-open');
    Object.assign(__T.S, { conv: 'bob::me', peer: 'bob', hist: true });
    history.pushState({chat: 1}, '');
  });
}
test('显式浅色和系统深色：完整 HTML 到达前已经有正确的首屏背景', async () => {
  for (const [theme, color] of [['light', 'rgb(246, 243, 238)'], ['auto', 'rgb(18, 16, 28)']]) {
    await session(async page => {
      await page.goto(origin + '/first-paint');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), color);
    }, { theme });
  }
});
test('同一安装 manifest 在线及离线随当前设备主题，保留标识、入口、作用域和原图标', async () => {
  await session(async (page, context) => {
    await page.goto(origin); await ready(page);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    const staticManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest')));
    const read = () => page.evaluate(async () => {
      const href = document.querySelector('link[rel=manifest]').getAttribute('href');
      return [href, await (await fetch(href)).json()];
    });
    const [href, light] = await read();
    assert.equal(href, 'manifest.webmanifest');
    assert.deepEqual(light, {...staticManifest, theme_color:'#f6f3ee', background_color:'#f6f3ee'});
    await page.evaluate(() => document.getElementById('btn-theme').click());
    await page.waitForFunction(async () => {
      const cached = await caches.match('./.chatter-launch-theme'); return cached && (await cached.text()) === 'dark';
    });
    await context.setOffline(true);
    const [same, dark] = await read();
    assert.equal(same, href);
    assert.deepEqual(dark, {...staticManifest, theme_color:'#12101c', background_color:'#12101c'});
  }, {theme: 'light', worker: true});
});
test('键盘收起后两个 JS 高度都滞留，回前台恢复整屏；重新打字时不覆盖真实键盘', async () => {
  await session(async page => {
    await page.goto(origin); await ready(page); await chat(page);
    await page.evaluate(() => {
      const input = document.getElementById('chat-input');
      let height = 462, hidden = false;
      Object.defineProperty(window, 'innerHeight', {configurable:true,get:()=>height});
      Object.defineProperty(visualViewport, 'height', {configurable:true,get:()=>462});
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>hidden});
      input.value = '保留这段尚未发出的草稿';
      input.focus(); visualViewport.dispatchEvent(new Event('resize'));
      window.testVisibility = v => { hidden=v; document.dispatchEvent(new Event('visibilitychange')); };
      window.testLayoutHeight = h => {height=h; window.dispatchEvent(new Event('resize'));};
      window.testVisibility(true); window.testVisibility(false);
    });
    await page.waitForTimeout(1100);
    const height = () => page.locator('#chat-view').evaluate(el => Math.round(el.getBoundingClientRect().height));
    assert.equal(await height(), 844);
    assert.equal(await page.locator('#chat-input').inputValue(), '保留这段尚未发出的草稿');
    await page.evaluate(() => {
      testVisibility(true); testVisibility(false);
      testLayoutHeight(844);
      document.getElementById('chat-input').focus();
      visualViewport.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(1100);
    assert.equal(await height(), 462);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'chat-input');
  });
});
test('聊天双击返回只退一层，根页面仍能正常离开；过期的聊天状态不带走当前页面', async () => {
  await session(async page => {
    await page.goto(origin + '/prior'); await page.getByRole('link').click(); await ready(page);
    await chat(page);
    const attempts = await page.evaluate(() => {
      let n = 0;
      const go = history.back.bind(history);
      history.back = () => { n++; go(); };
      const back = document.getElementById('chat-back'); back.click(); back.click();
      return n;
    });
    assert.equal(attempts, 1);
    await page.waitForFunction(() => !window.__T.S.conv);
    assert.equal(await page.locator('#app-view').isVisible(), true);
    await page.goBack(); assert.equal(new URL(page.url()).pathname, '/prior');
    await page.getByRole('link').click(); await ready(page); await chat(page);
    await page.evaluate(() => {
      history.replaceState({app: 1}, '');
      history.back = () => { throw new Error('当前不是聊天记录'); };
      document.getElementById('chat-back').click();
    });
    assert.equal(await page.evaluate(() => __T.S.conv), null);
  });
});
test('聊天边缘短划或竖划保持会话；完整的站内边缘手势回到消息页', async () => {
  await session(async page => {
    await page.goto(origin); await ready(page); await chat(page);
    const swipe = (x, y) => page.evaluate(([x, y]) => {
      const chat = document.getElementById('chat-view');
      function send(name, x, y) {
        const point = new Touch({identifier: 1, target: chat, clientX: x, clientY: y});
        chat.dispatchEvent(new TouchEvent(name, {bubbles:true, cancelable:true, touches:name==='touchend'?[]:[point], changedTouches:[point]}));
      }
      send('touchstart', 5, 250); send('touchmove',x,y); send('touchend',x,y);
    }, [x,y]);
    await swipe(35, 251); await swipe(22, 380);
    assert.equal(await page.evaluate(() => __T.S.conv), 'bob::me');
    await swipe(100, 254); await page.waitForFunction(() => !__T.S.conv);
    assert.equal(await page.locator('#app-view').isVisible(), true);
  });
});
