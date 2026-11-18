// 搜索界面在真 Chromium 里的检查 + 截图：用 App 自己的样式（index.html 里的主题变量），服务器换成假的（不联网、不花额度）。
// 用法：cd tests && node search-ui.js [截图目录]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ws-shots-'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];
const IMG = (n, a, b) => `https://img.test/${n}.svg?a=${a}&b=${b}`;
const SVG = (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${a}"/><stop offset="1" stop-color="#${b}"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><circle cx="430" cy="130" r="70" fill="#fff" fill-opacity=".22"/><path d="M0 330 L180 210 L320 300 L460 190 L600 280 L600 400 L0 400Z" fill="#000" fill-opacity=".16"/></svg>`;
const WEB = { ok: true, cached: false, left: 76, type: 'web', q: '量子计算', page: 1,
  wiki: { t: '量子计算', s: '量子计算是一种遵循量子力学规律、调控量子信息单元进行计算的新型计算模式。它和经典计算最大的不同，是可以利用叠加和纠缠同时处理很多种状态。', img: IMG('kg', '6c5ce7', 'e8508c'), u: 'https://zh.m.wikipedia.org/wiki/x', src: '维基百科' },
  items: [
    { t: '量子计算入门：从量子比特到量子门', u: 'https://example.org/quantum-intro', s: '用最少的数学讲清楚量子比特、叠加态和测量，适合第一次接触量子计算的读者。' },
    { t: '量子计算 - 维基百科，自由的百科全书', u: 'https://zh.wikipedia.org/wiki/x', s: '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式……' },
    { t: '震惊！量子计算机即将取代所有电脑？', u: 'https://baijiahao.baidu.com/s?id=1', s: '……' },
    { t: 'qiskit/qiskit：开源的量子计算工具包', u: 'https://github.com/qiskit/qiskit', s: 'Qiskit 是一个开源的量子计算软件开发工具包，可以在模拟器和真实量子硬件上运行程序。' },
    { t: '如何通俗地解释量子计算？', u: 'https://www.zhihu.com/question/1', s: '量子计算机不是更快的普通电脑，而是在某些特定问题上换了一种算法……' },
    { t: '量子计算的现状与挑战（综述）', u: 'https://arxiv.org/abs/0000.00000', s: '本文回顾了超导、离子阱、光量子等主要技术路线的进展，并讨论纠错和规模化的难点。', d: '2026年3月' }
  ], rel: ['量子计算机原理', '量子比特', '量子纠缠', '量子计算 入门书'] };
const IMGS = { ok: true, type: 'images', q: '极光', page: 1, items: [['5b8def', '1fd1a5', 600, 400], ['22c08a', '0e5d4a', 400, 600], ['8b7cf6', '2b1d6e', 600, 450], ['e39a2d', 'a33b54', 500, 500], ['1fd1a5', '2b6cb0', 600, 340], ['e8508c', '6c5ce7', 420, 600], ['3a8ee6', '0b1f4d', 600, 400], ['f6c453', 'e8508c', 600, 600]].map((c, i) => ({ t: '极光照片 ' + (i + 1), img: IMG('i' + i, c[0], c[1]), th: IMG('t' + i, c[0], c[1]), w: c[2], h: c[3], u: 'https://photos.example.com/p/' + i, src: ['photos.example.com', 'travel.example.org', 'nature.example.net'][i % 3] })) };
const VIDS = { ok: true, type: 'videos', q: '量子计算', page: 1, items: [
  { t: '十分钟看懂量子计算', u: 'https://www.youtube.com/watch?v=abcdefghijk', img: IMG('v1', '6c5ce7', '1fd1a5'), dur: '10:24', src: 'YouTube', ch: '科普频道', d: '3 个月前' },
  { t: '量子计算机到底是怎么工作的？', u: 'https://www.bilibili.com/video/BV1xx411c7mD', img: IMG('v2', 'e8508c', 'e39a2d'), dur: '18:02', src: 'Bilibili', ch: '物理小站', d: '1 年前' },
  { t: '量子比特和普通比特的区别', u: 'https://vimeo.com/1', img: IMG('v3', '3a8ee6', '22c08a'), dur: '6:47', src: 'Vimeo', ch: 'Lab', d: '2 周前' }] };
const P = t => '<p>' + t + '</p>';
const READ = { ok: true, u: 'https://example.org/quantum-intro', title: '量子计算入门：从量子比特到量子门', site: 'example.org', date: '2026-10-21', len: 1800,
  html: P('普通电脑里的一个比特，要么是 0，要么是 1。量子计算机里的量子比特不一样：在被测量之前，它可以处在 0 和 1 的叠加状态。') +
    '<img src="' + IMG('a1', '8b7cf6', '1fd1a5') + '" alt="示意图">' +
    P('叠加并不是“同时是 0 又是 1”这么简单。更准确地说，量子比特有一组概率幅，测量时按照这组数字随机得到 0 或 1。') +
    '<h2>量子门做了什么</h2>' + P('量子程序由一连串量子门组成。每个门都会旋转量子比特的状态，让正确答案的概率变大、错误答案的概率变小。') +
    '<blockquote>量子计算机不是更快的普通电脑，而是只在某些问题上有优势。</blockquote>' +
    P('目前最大的难点是噪声：量子状态非常脆弱，温度、电磁干扰都会让它出错，所以需要量子纠错。') };
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${CSS}</style></head>
<body><div class="app-container"></div><script>
window.__log = []; window.__opened = []; window.open = u => { __opened.push(u); };
const DATA = ${JSON.stringify({ WEB, IMGS, VIDS, READ })};
window.__chWS = {
  call: async b => { __log.push(b); await new Promise(r => setTimeout(r, 60)); if (b.op === 'read') return DATA.READ; return b.type === 'images' ? DATA.IMGS : b.type === 'videos' ? DATA.VIDS : Object.assign({}, DATA.WEB, { q: b.q }); },
  toast: m => __log.push({ toast: m }), acts: (t, items) => { window.__acts = items; }, form: () => {}, copy: () => {}, logErr: () => {}, forward: t => __log.push({ fwd: t }),
  sb: () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null }), upsert: async () => ({}) }; return q; } }), uid: () => 'u1'
};
localStorage.setItem('ch2ws:u1', JSON.stringify({ pin: ['github.com', 'developer.mozilla.org', 'bilibili.com'], fav: [{ u: 'https://example.org/quantum-intro', t: '量子计算入门：从量子比特到量子门', s: 'example.org' }] }));
localStorage.setItem('ch2wsHist:u1', JSON.stringify(['量子计算', '极光 拍摄 参数', '周末 徒步 路线']));
addEventListener('popstate', e => window.ChatterSearch && ChatterSearch.onPop(e));
</script><script src="/search.js"></script></body></html>`;
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/search.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(fs.readFileSync(path.join(ROOT, 'search.js'))); }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page);
}).listen(8767);
let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + m); };
(async () => {
  const br = await chromium.launch();
  const shots = {};
  for (const theme of ['light', 'dark']) {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: true });
    await ctx.route(/img\.test/, rt => { const u = new URL(rt.request().url()); rt.fulfill({ contentType: 'image/svg+xml', body: SVG(u.searchParams.get('a'), u.searchParams.get('b')) }); });
    await ctx.route(/youtube|bilibili|vimeo/, rt => rt.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#000"></body>' }));
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await pg.goto('http://localhost:8767/');
    const shot = async name => { await pg.waitForTimeout(250); const f = path.join(OUT, theme + '-' + name + '.png'); await pg.screenshot({ path: f }); (shots[name] = shots[name] || {})[theme] = f; };
    const on = () => pg.evaluate(() => (document.querySelector('.ws-v.on') || {}).dataset.v);
    await pg.evaluate(() => ChatterSearch.open()); await pg.evaluate(() => document.activeElement && document.activeElement.blur());
    await shot('1-首页');
    if (theme === 'light') ok(await on() === 'home' && await pg.evaluate(() => history.state && history.state.ws === 1), '打开搜索：首页');
    await pg.fill('[data-form="home"] input', '量子计算'); await pg.press('[data-form="home"] input', 'Enter');
    await pg.waitForSelector('.ws-r a.t'); await pg.evaluate(() => document.activeElement && document.activeElement.blur());
    await shot('2-结果页');
    if (theme === 'light') {
      const t = await pg.$$eval('.ws-r a.t', a => a.map(x => x.textContent));
      ok(t[0].startsWith('qiskit') && t[1].startsWith('量子计算 - 维基') && t.indexOf('震惊！量子计算机即将取代所有电脑？') < 0, '结果按规则排：置顶的 GitHub 第一、维基第二、营销号不显示 → ' + t.slice(0, 3).join(' / '));
      ok(await pg.$eval('[data-r="res"]', e => /隐藏了 1 条营销号/.test(e.textContent)), '提示隐藏了几条营销号');
      await pg.click('[data-act="show-farms"]'); ok((await pg.$$eval('.ws-r a.t', a => a.map(x => x.textContent))).some(x => /震惊/.test(x)), '点“显示”能看到被隐藏的营销号');
      await pg.click('[data-act="hide-farms"]');
      await pg.click('[data-act="tgl-clean"]');
      const t2 = await pg.$$eval('.ws-r a.t', a => a.map(x => x.textContent));
      ok(t2[1].startsWith('量子计算入门'), '关掉“干净页面优先”马上重排，不重新搜 → ' + t2[1] + '；搜索请求次数 ' + (await pg.evaluate(() => __log.filter(x => x.op === 'search').length)));
      await pg.click('[data-act="tgl-clean"]');
      await pg.click('.ws-r a.t >> text=如何通俗地解释量子计算？');
      ok((await pg.evaluate(() => __opened.slice(-1)[0])).includes('zhihu.com') && await on() === 'res', '知乎这类要登录的：直接用浏览器打开');
    }
    await pg.click('.ws-r a.t >> text=量子计算入门：从量子比特到量子门'); await pg.waitForSelector('.ws-body p');
    await shot('3-阅读页');
    if (theme === 'light') {
      ok(await pg.evaluate(() => history.state.ws === 3), '进入阅读页加了一层历史');
      await pg.click('[data-act="rd-fs"]'); ok(await pg.$eval('.ws-art', e => e.style.fontSize === '20px'), '字号按钮：18 → 20');
      await pg.click('[data-act="rd-fs"]'); await pg.click('[data-act="rd-fs"]'); await pg.click('[data-act="rd-fs"]');
      await pg.evaluate(() => { document.querySelector('[data-r="rdsc"]').scrollTop = 300; });
      await pg.click('.ws-body img'); ok(await on() === 'img', '点文章里的图：看大图'); await pg.goBack(); await pg.waitForTimeout(150);
      ok(await on() === 'read' && await pg.$eval('[data-r="rdsc"]', e => e.scrollTop) > 200, '看完大图返回：回到文章原来的位置');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(await on() === 'res' && await pg.evaluate(() => __log.filter(x => x.op === 'search').length) === 1, '返回结果页：不重新搜');
    } else { await pg.goBack(); await pg.waitForTimeout(150); }
    await pg.click('[data-act="tab"][data-t="images"]'); await pg.waitForSelector('.ws-im img'); await pg.waitForTimeout(300);
    await shot('4-图片');
    await pg.click('[data-act="tab"][data-t="videos"]'); await pg.waitForSelector('.ws-vd');
    await shot('5-视频');
    if (theme === 'light') {
      await pg.click('.ws-vd >> nth=1'); await pg.waitForSelector('iframe.ws-player');
      ok((await pg.$eval('iframe.ws-player', e => e.src)).startsWith('https://player.bilibili.com/player.html?bvid=BV1xx411c7mD'), 'B 站视频：在 App 里直接播放');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(!(await pg.$('iframe.ws-player')), '离开播放页：视频停掉');
      await pg.click('.ws-vd >> nth=2'); ok((await pg.evaluate(() => __opened.slice(-1)[0])).includes('vimeo.com'), '其他网站的视频：用浏览器打开');
    }
    await pg.click('.ws-v.on [data-act="rules"]'); await pg.waitForSelector('.ws-rules .ws-sw');
    await shot('6-搜索规则');
    if (theme === 'light') {
      await pg.goBack(); await pg.goBack(); await pg.waitForTimeout(150);
      ok(await on() === 'home', '一路返回：规则 → 结果 → 首页');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(await pg.$eval('#ws', e => !e.classList.contains('on')), '首页再返回：关掉搜索');
      ok(!errs.length, '没有报错 ' + errs.join(' | '));
    }
    await ctx.close();
  }
  // 拼图：每张左浅右深
  const ctx = await br.newContext({ viewport: { width: 1000, height: 960 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  for (const [name, f] of Object.entries(shots)) {
    const b64 = x => 'data:image/png;base64,' + fs.readFileSync(x).toString('base64');
    await pg.setContent(`<body style="margin:0;background:#d9d6cf;font-family:'Noto Sans CJK SC',sans-serif"><div style="display:flex;gap:28px;padding:28px;width:max-content">
      <div><div style="font-size:15px;color:#4a4655;margin:0 0 10px 6px">浅色</div><img src="${b64(f.light)}" style="width:390px;height:844px;border-radius:38px;box-shadow:0 10px 40px rgba(0,0,0,.18);display:block"></div>
      <div><div style="font-size:15px;color:#4a4655;margin:0 0 10px 6px">深色</div><img src="${b64(f.dark)}" style="width:390px;height:844px;border-radius:38px;box-shadow:0 10px 40px rgba(0,0,0,.18);display:block"></div></div></body>`);
    await pg.waitForTimeout(100);
    await pg.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 86, fullPage: true });
  }
  await br.close(); srv.close();
  console.log('截图在：' + OUT);
  console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过'); process.exit(bad ? 1 : 0);
})().catch(e => { console.log('出错：', e); process.exit(1); });
