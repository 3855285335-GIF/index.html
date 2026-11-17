// 启动和更新测试：用真 Chromium 打开本地网站，模拟各种打不开的情况（白屏保护）和发布新版（自动更新）
// 用法：cd tests && node start-test.js        （需要 playwright，见 README）
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const SHOTS = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-shots-'));
let mode = 'ok', navs = 0;
const CUR = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), CURV = /app\.js\?v=([\w.-]+)/.exec(CUR)[1];
const NEW = CUR.split(CURV).join('20261118d9');
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'); let f = u.pathname === '/' ? '/index.html' : u.pathname;
  const nav = q.headers['sec-fetch-mode'] === 'navigate';
  if (f === '/index.html') {
    if (nav) navs++;
    const html = (mode === 'newver' || (mode === 'stale' && !nav) || (mode === 'newslow')) ? NEW : CUR;
    const send = () => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); };
    if (mode === 'newslow' && !nav) return setTimeout(send, 7000);
    return send();
  }
  if (mode === 'noapp' && f === '/app.js') { r.writeHead(404); return r.end(); }
  if (mode === 'throw' && f === '/app.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end('window.__lib=Promise.resolve();\nfoo.bar.baz();'); }
  if (mode === 'hang' && f === '/app.js') { return; }   // 一直不回
  if (mode === 'bootfail' && f === '/app.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace('window.__chBooted = true;', "throw new Error('boot-x');")); }
  if (mode === 'nolib' && f.startsWith('/vendor/')) { r.writeHead(404); return r.end(); }
  const p = path.join(ROOT, f); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(p).pipe(r);
}).listen(8766);
const res = [];
const ok = (c, m) => { const l = (c ? '✅ ' : '❌ ') + m; res.push(l); console.log(l); };
(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route(/supabase\.co/, r => r.abort());   // 服务器连不上（国内常见），程序也应该能打开
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const st = async () => pg.evaluate(() => ({
    rescue: !!document.getElementById('ch-rescue'), slow: (document.getElementById('sp-slow') || {}).style ? document.getElementById('sp-slow').style.display : 'gone',
    splash: !!document.getElementById('splash'), booted: !!window.__chBooted,
    view: (document.querySelector('#auth-view.active, #app-view.active') || {}).id || '',
    msg: (document.querySelector('#ch-rescue div:nth-child(2)') || document.getElementById('sp-slow-msg') || {}).textContent || ''
  }));
  // 1 正常
  mode = 'ok'; await pg.goto('http://localhost:8766/'); await pg.waitForTimeout(16500);
  let s = await st(); ok(s.booted && s.view && !s.rescue && !s.splash, '正常打开：显示' + s.view + '，没有救援层，启动图已消失 ' + JSON.stringify(s));
  // 2 主程序下载失败（重试一次也失败）
  mode = 'noapp'; await pg.goto('http://localhost:8766/?v=1'); await pg.waitForTimeout(13000);
  s = await st(); ok(s.slow === 'block' && !s.booted, '主程序下载失败：12 秒后启动图下方出现按钮 ' + JSON.stringify(s));
  await pg.screenshot({ path: SHOTS + '/ws-noapp.png' });
  // 3 主程序启动时报错
  mode = 'throw'; await pg.goto('http://localhost:8766/?v=2'); await pg.waitForTimeout(1500);
  s = await st(); ok((s.slow === 'block' || s.rescue) && /报错/.test(s.msg), '程序报错：马上出现按钮并显示报错内容 ' + JSON.stringify(s));
  // 4 依赖库下载不到：应进登录页并提示（不是白屏）
  mode = 'nolib'; await pg.evaluate(() => { try { Object.keys(localStorage).forEach(k => /^ch2lib/.test(k) && localStorage.removeItem(k)); } catch (e) {} });
  await pg.goto('http://localhost:8766/?v=3'); await pg.waitForTimeout(16500);
  s = await st(); const am = await pg.evaluate(() => (document.getElementById('auth-msg') || {}).textContent || '');
  ok(s.view === 'auth-view' && !s.splash && (/程序组件没下载下来/.test(am)), '程序组件下载不到：进登录页并用中文说明原因「' + am.slice(0, 40) + '」' + JSON.stringify(s));
  // 5 页面空白（程序跑了但什么视图都没显示）→ 15 秒后救援层
  mode = 'ok'; await pg.goto('http://localhost:8766/?v=4'); await pg.waitForTimeout(800);
  await pg.evaluate(() => { const off = () => document.querySelectorAll('#auth-view.active, #app-view.active').forEach(e => e.classList.remove('active')); off(); new MutationObserver(off).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); });
  await pg.waitForTimeout(12000);
  s = await st(); ok(s.rescue && /没显示/.test(s.msg), '页面空白：12 秒后出现救援层 ' + JSON.stringify(s));
  await pg.screenshot({ path: SHOTS + '/ws-rescue.png' });
  // 5b 启动图已经消失后才报错（以前会一直白着）：马上出现救援层
  mode = 'bootfail'; await pg.goto('http://localhost:8766/?v=41'); await pg.waitForTimeout(2500);
  s = await st(); ok(s.rescue && /boot-x/.test(s.msg), '启动图消失后报错：马上出现救援层 ' + JSON.stringify(s));
  await pg.screenshot({ path: SHOTS + '/ws-bootfail.png' });
  // 6 清除缓存后重开：清缓存键 + IndexedDB + Cache Storage，保留登录和设置
  await pg.evaluate(async () => {
    localStorage.setItem('ch2:u1', '{"x":1}'); localStorage.setItem('ch2m:u1:c', '[]'); localStorage.setItem('ch2grp', '{}'); localStorage.setItem('ch2pushpub', 'x');
    localStorage.setItem('ch2theme', 'dark'); localStorage.setItem('ch2bubble', '3'); localStorage.setItem('sb-uaoiqbxptnbrvkzjwguc-auth-token', '{"t":1}'); localStorage.setItem('ch2lib4:x', 'lib');
    await new Promise(r => { const q = indexedDB.open('chatter', 1); q.onupgradeneeded = () => q.result.createObjectStore('m'); q.onsuccess = () => { q.result.close(); r(); }; });
    const c = await caches.open('chatter-img-v1'); await c.put('/x.png', new Response('x'));
  });
  await Promise.all([pg.waitForNavigation({ timeout: 8000 }).catch(() => {}), pg.click('#ch-rescue button:last-child')]);
  await pg.waitForTimeout(1200);
  const after = await pg.evaluate(async () => ({
    keys: Object.keys(localStorage).sort(), url: location.search,
    dbs: (await indexedDB.databases()).map(d => d.name), cache: await caches.has('chatter-img-v1')
  }));
  const k = after.keys;
  ok(!k.includes('ch2:u1') && !k.includes('ch2m:u1:c') && !k.includes('ch2grp') && !k.includes('ch2pushpub'), '清缓存：会话/消息/群缓存已删 ' + k.join(','));
  ok(k.includes('ch2theme') && k.includes('ch2bubble') && k.includes('sb-uaoiqbxptnbrvkzjwguc-auth-token') && k.includes('ch2lib4:x'), '清缓存：登录、主题、气泡、依赖库都保留');
  ok(!after.cache, '清缓存：图片缓存已删');
  ok(/v=\d{10,}/.test(after.url), '清缓存后自动重开 ' + after.url);
  // 7 ?reset=1
  await pg.evaluate(() => localStorage.setItem('ch2:u2', '1'));
  await pg.goto('http://localhost:8766/?reset=1'); await pg.waitForTimeout(2500);
  const r7 = await pg.evaluate(() => ({ has: !!localStorage.getItem('ch2:u2'), theme: localStorage.getItem('ch2theme'), url: location.search }));
  ok(!r7.has && r7.theme === 'dark' && !/reset/.test(r7.url), '网址加 ?reset=1 也能清缓存并重开（不会反复清）' + JSON.stringify(r7));
  // 8 正常运行后零星报错不弹救援层
  mode = 'ok'; await pg.goto('http://localhost:8766/?v=5'); await pg.waitForTimeout(2000);
  await pg.evaluate(() => setTimeout(() => { null.x; }, 0)); await pg.waitForTimeout(500);
  s = await st(); ok(!s.rescue, '正常运行后偶发报错：不打扰 ' + JSON.stringify(s));
  // 9 自动更新：刚打开时发现线上有新版 → 存好新页面并自动换上，换完提示一次
  mode = 'ok'; await pg.goto('http://localhost:8766/?v=6'); mode = 'newver'; navs = 0;
  await pg.waitForURL(/\?v=\d{10,}/, { timeout: 9000 }).catch(() => {});
  const toasted = await pg.waitForFunction(() => document.body && document.body.innerText.indexOf('已更新到新版本') >= 0, null, { timeout: 6000 }).then(() => true, () => false);
  await pg.waitForTimeout(500);
  let u9 = await pg.evaluate(async () => ({ v: __chUpd.v(), url: location.search, cached: !!(await caches.open('chatter-shell-v1').then(c => c.match(location.origin + location.pathname)).then(r => r && r.text()).then(t => t && t.indexOf('20261118d9') > 0)), ver: (document.getElementById('app-ver') || {}).textContent }));
  ok(u9.v === '20261118d9' && navs === 1 && u9.cached && toasted && /d9/.test(u9.ver), '自动更新：刚打开发现新版，自动换上一次并提示 ' + JSON.stringify(u9) + ' 重开次数=' + navs);
  // 10 网络那头一直给旧页面：最多换两次，不会无限刷新
  await pg.evaluate(() => localStorage.removeItem('ch2updTry'));
  mode = 'stale'; navs = 0; await pg.goto('http://localhost:8766/?v=7'); navs = 0;
  await pg.waitForTimeout(16000);
  const v10 = await pg.evaluate(() => __chUpd.v());
  ok(navs <= 2 && navs >= 1, '线上新版一直拿不到：最多自动重开 2 次就停（实际 ' + navs + ' 次，现在版本 ' + v10 + '）');
  // 11 发现新版时已经在用（不是刚打开）：先不打断，切到后台再回来时才换
  await pg.evaluate(() => localStorage.removeItem('ch2updTry'));
  mode = 'ok'; await pg.goto('http://localhost:8766/?v=8'); mode = 'newslow'; navs = 0;
  await pg.waitForTimeout(11000);
  const n11a = navs, p11 = await pg.evaluate(() => __chUpd.pend());
  const urls = []; const onNav = f => { if (f === pg.mainFrame()) urls.push(f.url()); }; pg.on('framenavigated', onNav);
  await pg.evaluate(() => { __chUpd.link('#c=abc'); document.dispatchEvent(new Event('visibilitychange')); });
  await pg.waitForTimeout(3500); pg.off('framenavigated', onNav);
  const u11 = await pg.evaluate(() => ({ v: __chUpd.v(), url: location.search })); u11.hash = (urls.find(x => /#/.test(x)) || '').replace(/^[^#]*/, '');
  ok(n11a === 0 && p11 === '20261118d9' && navs === 1 && u11.v === '20261118d9' && u11.hash === '#c=abc', '正在用时发现新版：当时不刷新，回到前台才换（并带上刚点的通知 ' + u11.hash + '）' + JSON.stringify(u11));
  // 12 手动检查：已经是最新
  mode = 'newver'; await pg.waitForTimeout(8000); await pg.evaluate(() => { __chUpd.check('manual'); });
  const t12 = await pg.waitForFunction(() => document.body.innerText.indexOf('已经是最新版本') >= 0, null, { timeout: 4000 }).then(() => true, () => false);
  ok(t12, '设置里点“检查更新”：已是最新时提示');
 console.log(res.every(x => x[0] === '✅') ? '\n✅ 启动和更新全部通过（截图在 ' + SHOTS + '）' : '\n❌ 有没通过的');
  await br.close(); srv.close(); process.exit(res.every(x => x[0] === '✅') ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
