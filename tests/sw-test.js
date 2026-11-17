// 可选：用真实浏览器内核（Chromium）测后台小助手 sw.js —— 程序文件和图片有没有存进手机、断网时能不能打开。
// 需要另外装：cd tests && npm i --no-save playwright && npx playwright install chromium ；然后 node sw-test.js
// 会在本机临时开一个网站（端口 8765），用完就关；不联网（图片请求是假的）。
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-site-'));
fs.symlinkSync(path.resolve(__dirname, '..'), path.join(site, 'index.html'));   // 模拟 GitHub Pages 的网址结构 /index.html/
const PORT = 8765, URL0 = 'http://localhost:' + PORT + '/index.html/';
const startSrv = () => spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: site, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = startSrv(); await sleep(800);
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'allow' });
  const IMG = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/1_abcde.jpg.t';
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  let imgHits = 0;
  await ctx.route('https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/**', r => { imgHits++; r.fulfill({ status: 200, body: png, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' } }); });
  const p = await ctx.newPage();
  await p.goto(URL0); await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await sleep(1500);
  const ctl = await p.evaluate(() => !!navigator.serviceWorker.controller);
  const shell = await p.evaluate(async () => (await (await caches.open('chatter-shell-v1')).keys()).map(r => r.url.replace(location.origin, '')));
  console.log('[加速] 后台小助手接管页面 =', ctl, '；存下的程序文件 =', JSON.stringify(shell));
  // 图片：第一次走网络并存下，第二次直接用手机里的
  const load = () => p.evaluate(u => new Promise(res => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('err'); i.src = u; document.body.appendChild(i); }), IMG);
  const r1 = await load(); const h1 = imgHits;
  const r2 = await p.evaluate(u => new Promise(res => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('err'); i.src = u + '?r=123'; }), IMG); const h2 = imgHits;
  const imgs = await p.evaluate(async () => (await (await caches.open('chatter-img-v1')).keys()).length);
  console.log('[加速] 图片第一次：', r1, '（取了网络', h1, '次）；再看一次（带重试参数）：', r2, '（网络累计', h2, '次，没再取）；手机里存的图片数 =', imgs);
  // 断网后重新打开
  srv.kill(); await sleep(500);
  await ctx.unroute('https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/**'); await ctx.route('https://uaoiqbxptnbrvkzjwguc.supabase.co/**', r => r.abort());
  const t0 = Date.now(); let ok = true; try { await p.reload({ timeout: 15000 }); } catch (e) { ok = false; }
  await sleep(1500);
  const info = await p.evaluate(() => ({ title: document.title, hasApp: !!document.getElementById('app-view'), auth: (document.getElementById('auth-msg') || {}).textContent || '', scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean).map(s => s.replace(location.origin, '')).slice(0, 3) }));
  console.log('[加速] 服务器关掉后重新打开：成功 =', ok, '用时', Date.now() - t0, 'ms；标题 =', info.title, '；页面结构在 =', info.hasApp, '；主程序跑起来了（有提示文字）=', JSON.stringify(info.auth.slice(0, 40)));
  const r3 = await load();
  console.log('[加速] 断网时打开看过的图片：', r3);
  // 服务器回来、版本号变了：新页面马上生效
  srv = startSrv(); await sleep(800); await p.reload(); await sleep(800);
  const ver = await p.evaluate(() => Array.from(document.scripts).map(s => s.src).find(s => /app\.js/.test(s)));
  console.log('[加速] 服务器恢复后重新打开：用的程序 =', String(ver).replace(/^.*\//, ''));
  srv.kill(); await b.close();
  const pass = ctl && shell.some(s => /app\.js\?v=/.test(s)) && r1 === 'ok' && h2 === h1 && ok && info.hasApp && r3 === 'ok';
  console.log(pass ? '✅ 后台小助手正常' : '❌ 后台小助手有问题，看上面哪一行不对'); process.exit(pass ? 0 : 1);
})();
