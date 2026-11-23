// WebKit (Safari engine) smoke checks, serving only local repository files.
// Deliberately blocks all real Supabase/network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webkit, devices } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const contentType = f => (!f || f === '/' || f.endsWith('.html')) ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript; charset=utf-8' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream';
const load = pathname => {
  let name;
  try { name = decodeURIComponent(pathname); while (name.startsWith('/')) name = name.slice(1); } catch { return null; }
  if (!name || name === 'index.html') name = 'index.html';
  const file = path.resolve(ROOT, name);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try { return fs.readFileSync(file); } catch { return null; }
};
const server = http.createServer((req,res) => {
  const pathName = new URL(req.url, 'http://localhost').pathname;
  const bytes = load(pathName);
  if (!bytes) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type':contentType(pathName)}); res.end(bytes);
});
async function main() {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  const local = 'http://127.0.0.1:' + port;
  let browser;
  try {
    browser = await webkit.launch();
    const options = { ...devices['iPhone 13'], serviceWorkers:'block' };
    const ctx = await browser.newContext(options);
    const prodRequests = [];
    const previewHost = 'chatter-unmerged-check.vercel.app';
    await ctx.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname.includes('uaoiqbxptnbrvkzjwguc.supabase.co')) prodRequests.push(u.href);
      if (u.origin === local) return route.continue();
      if (u.hostname === previewHost) {
        const bytes = load(u.pathname);
        return bytes ? route.fulfill({status:200,contentType:contentType(u.pathname),body:bytes}) : route.fulfill({status:404,body:''});
      }
      return route.abort();
    });
    const normal = await ctx.newPage();
    await normal.goto(local,{waitUntil:'domcontentloaded'});
    await normal.waitForFunction(() => window.__chBooted === true,{timeout:20000});
    await normal.waitForFunction(() => document.querySelector('#auth-view.active'),{timeout:20000});
    const page = await normal.evaluate(() => ({
      viewport:document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
      scrollWidth:document.documentElement.scrollWidth,
      windowWidth:innerWidth,
      hasLogin:!!document.querySelector('#login-form'),
      errorText:document.querySelector('#auth-msg')?.textContent || ''
    }));
    assert.ok(page.viewport.includes('user-scalable=no'),'must preserve no-zoom setting');
    assert.ok(page.hasLogin,'login form missing in WebKit');
    assert.ok(page.scrollWidth <= page.windowWidth + 6,'mobile page overflows horizontally');
    await normal.close();
    const preview = await ctx.newPage();
    await preview.goto('https://' + previewHost + '/',{waitUntil:'domcontentloaded'});
    await preview.waitForFunction(() => window.__chBooted === true,{timeout:20000});
    const blocked = await preview.locator('#auth-msg').textContent();
    assert.ok(blocked.includes('已禁止登录及收发消息'),'preview was not blocked');
    assert.equal(prodRequests.length,0,'preview or local test sent requests to production');
    await preview.close();
    await ctx.close();
    console.log('WebKit移动端启动/缩放/水平布局与预览隔离检查通过；这不是实体 iPhone 真机测试。');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
