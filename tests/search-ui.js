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
  ], src: 'exa', used: 120 };
const TAV = { ok: true, type: 'web', q: '量子计算', src: 'tavily', used: 31, items: [{ t: '量子计算科普合集', u: 'https://kepu.example.cn/q', s: '来自 Tavily 的另一批结果。' }, { t: '量子计算 - 维基百科，自由的百科全书', u: 'https://zh.wikipedia.org/wiki/x', s: '……' }] };
const IMGS = { ok: true, type: 'images', q: '极光', src: 'tavily', items: [['5b8def', '1fd1a5', 600, 400], ['22c08a', '0e5d4a', 400, 600], ['8b7cf6', '2b1d6e', 600, 450], ['e39a2d', 'a33b54', 500, 500], ['1fd1a5', '2b6cb0', 600, 340], ['e8508c', '6c5ce7', 420, 600], ['3a8ee6', '0b1f4d', 600, 400], ['f6c453', 'e8508c', 600, 600]].map((c, i) => ({ t: '极光照片 ' + (i + 1), img: IMG('i' + i, c[0], c[1]), th: IMG('t' + i, c[0], c[1]), w: c[2], h: c[3], u: 'https://photos.example.com/p/' + i, src: ['photos.example.com', 'travel.example.org', 'nature.example.net'][i % 3] })) };
const VIDS = { ok: true, type: 'videos', q: '量子计算', src: 'exa', items: [
  { t: '十分钟看懂量子计算', u: 'https://www.youtube.com/watch?v=abcdefghijk', img: IMG('v1', '6c5ce7', '1fd1a5'), dur: '10:24', src: 'YouTube', ch: '科普频道', d: '3 个月前' },
  { t: '量子计算机到底是怎么工作的？', u: 'https://www.bilibili.com/video/BV1xx411c7mD', img: IMG('v2', 'e8508c', 'e39a2d'), dur: '18:02', src: 'Bilibili', ch: '物理小站', d: '1 年前' },
  { t: '量子比特和普通比特的区别', u: 'https://vimeo.com/1', img: IMG('v3', '3a8ee6', '22c08a'), dur: '6:47', src: 'Vimeo', ch: 'Lab', d: '2 周前' }] };
const DEEP = { ok: true, type: 'deep', q: '量子计算', down: ['GitHub'], groups: [
  { k: 'wiki', n: '维基百科', items: [{ t: '量子计算', u: 'https://zh.m.wikipedia.org/wiki/x', s: '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式……', f: '更新于 2026-09-01' }, { t: '量子比特', u: 'https://zh.m.wikipedia.org/wiki/y', s: '量子比特是量子信息的基本单位……' }] },
  { k: 'archive', n: '互联网档案馆', items: [{ t: '量子计算导论（扫描版）', u: 'https://archive.org/details/quantum-book', s: '一本 2001 年出版的入门教材。', f: '书 / 文档 · 2001', img: IMG('ar', 'e39a2d', '8b7cf6'), ext: true }] },
  { k: 'papers', n: '论文', items: [{ t: '量子计算的现状与挑战', u: 'https://arxiv.org/pdf/0000.pdf', s: '张三、李四', f: '2020 · 被引用 12 次 · 可以免费看全文', ext: true }] },
  { k: 'hn', n: 'Hacker News 讨论', items: [{ t: 'Quantum computing, explained simply', u: 'https://gone.example.com/post', c: 'https://news.ycombinator.com/item?id=123', f: '321 分 · 45 条评论 · 2026-01-01' }] }] };
const OLD = { ok: true, u: 'https://gone.example.com/post', title: 'Quantum computing, explained simply', site: 'gone.example.com', date: '2019-02-20', len: 900, arch: '20190302000000',
  html: '<p>This is the version saved by the Internet Archive in 2019. The original page has since been deleted.</p><p>Quantum computers use <a href="https://en.wikipedia.org/wiki/Qubit">qubits</a>, which can be in a superposition of 0 and 1 until they are measured.</p><pre>print("hello qubit")</pre>' };
const EN = { ok: true, type: 'web', q: 'quantum computing', src: 'exa', used: 121, items: [
  { t: 'Quantum computing - Wikipedia', u: 'https://en.wikipedia.org/wiki/Quantum_computing', s: 'A quantum computer is a computer that exploits quantum mechanical phenomena.' },
  { t: 'What Is Quantum Computing? | IBM', u: 'https://www.ibm.com/topics/quantum-computing', s: 'Quantum computing is a rapidly-emerging technology that harnesses the laws of quantum mechanics.' },
  { t: 'Quantum computers explained for beginners', u: 'https://blog.example.com/qc', s: 'A friendly introduction to qubits, gates and measurement.' }] };
const PORTAL = { ok: true, kind: 'links', u: 'https://portal.example.com/', title: 'Portal Home', site: 'portal.example.com', desc: 'A portal with many links', lang: 'en', links: [
  { t: 'First big headline today', u: 'https://portal.example.com/story/0' }, { t: 'Second story about space travel', u: 'https://portal.example.com/story/1' }, { t: 'Third story on world markets', u: 'https://portal.example.com/story/2' },
  { t: 'BLOCKME sensitive headline', u: 'https://portal.example.com/story/3' }, { t: 'Partner site article link', u: 'https://other.example.org/x' }] };
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
const DATA = ${JSON.stringify({ WEB, TAV, IMGS, VIDS, READ, DEEP, OLD, EN, PORTAL })};
window.__chWS = {
  call: async b => {
    __log.push(b); await new Promise(r => setTimeout(r, 60));
    if (b.op === 'usage') return { ok: true, used: { exa: 120, tavily: 31 }, free: { exa: 2500, tavily: 1000 }, keys: { exa: true, tavily: true, glm: true, groq: false } };
    if (b.op === 'translate') {
      if (window.__trMode === 'nokey') return { ok: false, code: 'nokey', msg: '翻译还没开通：服务器里还没填智谱的密钥' };
      if (b.to === 'en') return { ok: true, items: b.items.map(x => x === '量子计算' ? 'quantum computing' : 'english ' + x) };
      const blk = x => /BLOCKME/.test(x);
      return { ok: true, items: b.items.map(x => blk(x) ? null : '译：' + x), failed: b.items.filter(blk).length, why: b.items.some(blk) ? ['blocked'] : [] };
    }
    if (b.op === 'frame') return window.__frame ? window.__frame(b) : { ok: true, frame: false, why: 'xfo', url: b.url };
    if (b.op === 'versions') return { ok: true, url: b.url, list: ['20240501000000', '20190302000000', '20150101000000'] };
    if (b.op === 'read') {
      if (b.url.indexOf('gone.example.com') >= 0) return b.at ? DATA.OLD : { ok: false, code: 'gone', msg: '这个网页已经不存在了（404）' };
      if (b.url.indexOf('blilblil.com') >= 0) return { ok: false, code: 'noArticle', msg: '这个网页不是文章，页面上也没有能接着点的链接', to: 'https://gotowww.aipages.dev/6d/?blilblil.com' };
      if (b.url.indexOf('bilibilii.com') >= 0) return { ok: false, code: 'nohost', msg: '找不到 bilibilii.com 这个网站', to: b.url };
      if (b.url.indexOf('busyarch.example.com') >= 0) return b.at ? { ok: false, code: 'busy', msg: '互联网档案馆现在太忙（同一时间请求的人太多）' } : { ok: false, code: 'gone', msg: '这个网页已经不存在了（404）' };
      if (/portal\\.example\\.com\\/?$/.test(b.url)) return DATA.PORTAL;
      if (b.url.indexOf('en.example.com') >= 0 || b.url.indexOf('en.wikipedia.org') >= 0 || b.url.indexOf('portal.example.com/story') >= 0) return Object.assign({}, DATA.OLD, { u: b.url, arch: undefined, title: 'English article at ' + b.url, html: DATA.OLD.html.replace('2019', b.url) });
      return DATA.READ;
    }
    if (b.type === 'deep') return DATA.DEEP;
    if (b.type === 'images') return DATA.IMGS;
    if (b.type === 'videos') return DATA.VIDS;
    if (/^[\\x00-\\x7f]+$/.test(b.q)) return Object.assign({}, DATA.EN, { q: b.q });
    return b.src === 'tavily' ? Object.assign({}, DATA.TAV, { q: b.q }) : Object.assign({}, DATA.WEB, { q: b.q });
  },
  toast: m => __log.push({ toast: m }), acts: (t, items) => { window.__acts = items; }, form: () => {}, copy: () => {}, logErr: () => {}, forward: t => __log.push({ fwd: t }),
  sb: () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null }), upsert: async () => ({}) }; return q; } }), uid: () => 'u1'
};
localStorage.setItem('ch2ws:u1', JSON.stringify({ open: 'read', pin: ['github.com', 'developer.mozilla.org', 'bilibili.com'], fav: [{ u: 'https://example.org/quantum-intro', t: '量子计算入门：从量子比特到量子门', s: 'example.org' }] }));
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
    await ctx.route(/frame\.test|unsure\.test/, rt => { const u = new URL(rt.request().url()), n = u.pathname.slice(1) || 'a';   // 假的“能嵌的网站”：a → b → c 三页
      rt.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px sans-serif;margin:0;padding:24px;background:#fff;color:#222"><h2 style="margin:0 0 12px">示例网站 · 第 ' + n + ' 页</h2><p>这是网站自己的页面，原样显示在 App 里。</p><p><a id="to-b" href="/b">去第 b 页</a> · <a id="to-c" href="/c">去第 c 页</a></p><div style="height:420px;border-radius:14px;background:linear-gradient(135deg,#8b7cf6,#1fd1a5)"></div></body>' }); });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await pg.goto('http://localhost:8767/');
    const shot = async name => { await pg.waitForTimeout(250); const f = path.join(OUT, theme + '-' + name + '.png'); await pg.screenshot({ path: f }); (shots[name] = shots[name] || {})[theme] = f; };
    const on = () => pg.evaluate(() => (document.querySelector('.ws-v.on') || {}).dataset.v);
    await pg.evaluate(() => ChatterSearch.open()); await pg.evaluate(() => document.activeElement && document.activeElement.blur());
    if (theme === 'light') {
      await pg.evaluate(() => {
        const call = __chWS.call;
        window.restoreCall = () => { __chWS.call = call; };
        __chWS.call = async req => {
          if (req.op !== 'translate' || req.to !== 'en') return call(req);
          await new Promise(done => { window.releaseTranslation = done; });
          const result = await call(req);
          setTimeout(() => { window.translationReturned = true; }, 0);
          return result;
        };
      });
      await pg.fill('[data-form="home"] input', '返回测试关键词'); await pg.press('[data-form="home"] input', 'Enter');
      await pg.click('[data-act="q-en"]'); await pg.waitForFunction(() => !!window.releaseTranslation);
      const oldRequests = await pg.evaluate(() => __log.filter(x => x.op === 'search').length);
      await pg.goBack(); await pg.waitForFunction(() => document.querySelector('.ws-v.on')?.dataset.v === 'home');
      await pg.evaluate(() => { window.releaseTranslation(); window.restoreCall(); });
      await pg.waitForFunction(() => window.translationReturned);
      ok(await on() === 'home' && await pg.evaluate(() => __log.filter(x => x.op === 'search').length) === oldRequests,
        '退出结果页后，迟到的英文翻译不会带走当前页面或再发起搜索');
      await pg.evaluate(() => { window.__log.length = 0; });
    }
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
      await pg.waitForSelector('.ws-v.on[data-v="web"] .ws-err');
      ok(!(await pg.evaluate(() => __opened.length)) && /用浏览器打开（能用你的登录）/.test(await pg.$eval('.ws-v.on .ws-err', e => e.textContent)), '知乎这类要登录的：不再自动跳出 App；不让在 App 里显示时给出“用浏览器打开（能用你的登录）”');
      await pg.click('.ws-v.on .ws-err [data-act="web-ext"]');
      ok((await pg.evaluate(() => __opened.slice(-1)[0])).includes('zhihu.com'), '点了才用浏览器打开');
      await pg.click('.ws-v.on [data-act="web-close"]'); await pg.waitForFunction(() => (document.querySelector('.ws-v.on') || {}).dataset.v === 'res');
      ok(await pg.$eval('[data-act="src"]', e => e.textContent.trim() === 'Exa'), '结果页标出这次是用 Exa 搜的');
      await pg.click('[data-act="swap"]'); await pg.waitForSelector('.ws-r a.t >> text=量子计算科普合集');
      ok((await pg.evaluate(() => __log.filter(x => x.op === 'search').slice(-1)[0].src)) === 'tavily' && await pg.$eval('[data-act="src"]', e => e.textContent.trim() === 'Tavily'), '点“换 Tavily 再搜一次”：用 Tavily 重搜，标签跟着变');
      await pg.click('[data-act="src"]'); const lab = await pg.evaluate(() => __acts.map(x => x.label).join(' | '));
      ok(/Exa（本月用了 120 次，免费约 2500 次）/.test(lab) && /Tavily（本月用了 31 次，免费约 1000 次） ✓/.test(lab), '来源菜单里写着每家这个月用了多少次 → ' + lab.slice(0, 60));
      await pg.evaluate(() => __acts[0].fn()); await pg.waitForSelector('.ws-r a.t >> text=qiskit/qiskit：开源的量子计算工具包');
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
      ok(await on() === 'res' && await pg.evaluate(() => __log.filter(x => x.op === 'search').length) === 3, '返回结果页：不重新搜（一共只有首次、换 Tavily、换回 Exa 这 3 次）');
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
    await pg.click('[data-act="tab"][data-t="deep"]'); await pg.waitForSelector('.ws-gh'); await pg.waitForTimeout(200);
    await shot('7-深挖');
    if (theme === 'light') {
      ok((await pg.$$eval('.ws-gh b', a => a.map(x => x.textContent))).join(',') === '维基百科,互联网档案馆,论文,Hacker News 讨论' && /这次没连上：GitHub/.test(await pg.$eval('[data-r="res"]', e => e.textContent)), '深挖：按来源分组，连不上的说明一下');
      ok(!(await pg.$('[data-act="src"]')), '深挖不显示来源和时间筛选（它不花 Exa、Tavily 的次数）');
      await pg.click('.ws-r a.t >> text=量子计算导论（扫描版）'); ok((await pg.evaluate(() => __opened.slice(-1)[0])).includes('archive.org/details'), '档案馆的书：用浏览器打开');
    }
    await pg.click('.ws-r a.t >> text=Quantum computing, explained simply'); await pg.waitForSelector('[data-act="rd-arch"]');
    if (theme === 'light') ok(/已经不存在了/.test(await pg.$eval('[data-r="read"]', e => e.textContent)) && await pg.$eval('.ws-err .ws-btn.pri', e => e.dataset.act === 'rd-arch'), '网页没了：说清楚，“看存档”是第一个按钮');
    await pg.click('[data-act="rd-arch"]'); await pg.waitForSelector('.ws-arch'); await pg.waitForFunction(() => /已翻译成中文/.test((document.querySelector('.ws-trb') || {}).textContent || ''));
    await shot('8-存档（自动翻译）');
    if (theme === 'light') {
      const b = await pg.evaluate(() => __log.filter(x => x.op === 'read').slice(-1)[0]);
      ok(b.at === 'latest' && /2019-03-02 的存档/.test(await pg.$eval('.ws-arch', e => e.textContent)), '看存档：显示是哪一天存的');
      const rd = () => pg.evaluate(() => { const b = document.querySelector('.ws-body'), ot = document.querySelector('.ws-ot'); return { p: Array.from(b.querySelectorAll('p')).map(x => x.textContent), a: (b.querySelector('a[href="https://en.wikipedia.org/wiki/Qubit"]') || {}).textContent, pre: b.querySelector('pre').textContent, h1: document.querySelector('.ws-art h1').textContent, ot: ot.textContent, otHidden: ot.hidden, bar: document.querySelector('.ws-trb').textContent }; });
      const ntr = () => pg.evaluate(() => __log.filter(x => x.op === 'translate').length);
      let x = await rd();
      ok(x.p.length === 2 && x.p.every(t => t.startsWith('译：')) && x.a === 'qubits' && x.pre === 'print("hello qubit")', '外文文章自动翻成中文：每段都换了，正文里的链接还在，代码块不翻 → ' + x.p[1].slice(0, 30));
      ok(x.h1.startsWith('译：') && !x.otHidden && x.ot === '原标题：Quantum computing, explained simply' && /已翻译成中文/.test(x.bar), '标题也翻了，下面小字留着原标题；顶部写着“已翻译成中文”');
      const n1 = await ntr();
      ok(n1 === 1, '标题和开头几段第一批一起翻（一次请求）→ ' + n1);
      await pg.click('.ws-trb [data-act="tr-orig"]'); x = await rd();
      ok(x.p[0].startsWith('This is the version') && x.a === 'qubits' && x.otHidden && /正在看原文/.test(x.bar), '点“看原文”：换回英文原文（链接还在），原标题小字收起');
      await pg.click('.ws-trb [data-act="tr-go"]'); x = await rd();
      ok(x.p.every(t => t.startsWith('译：')) && await ntr() === n1, '点“看译文”：马上换回中文，不再请求翻译');
      await pg.click('.ws-tool [data-act="rd-vers"]'); await pg.waitForFunction(() => window.__acts && /2015/.test(__acts.map(x => x.label).join()));
      const lab = await pg.evaluate(() => __acts.map(x => x.label));
      ok(lab[0] === '2024 年 5 月 1 日' && lab[1] === '2019 年 3 月 2 日（正在看）', '历史版本：列出每一版，标出正在看的 → ' + lab.slice(0, 2).join(' / '));
      await pg.click('[data-act="rd-copy"]');
      await pg.goBack(); await pg.goBack(); await pg.waitForTimeout(150);
    } else { await pg.goBack(); await pg.goBack(); await pg.waitForTimeout(150); }
    await pg.click('.ws-v.on [data-act="rules"]'); await pg.waitForSelector('.ws-rules .ws-sw'); await pg.waitForTimeout(150);
    await shot('6-搜索规则');
    if (theme === 'light') {
      ok(/用了 120 \/ 2500 次/.test(await pg.$eval('[data-r="rules"]', e => e.textContent)), '规则页：显示这个月每家用了多少次');
      await pg.goBack(); await pg.goBack(); await pg.waitForTimeout(150);
      ok(await on() === 'home', '一路返回：规则 → 结果 → 首页');
      ok(/最近看过[\s\S]*Quantum computing, explained simply[\s\S]*2019-03-02 存档/.test(await pg.$eval('[data-r="home"]', e => e.textContent)), '首页“最近看过”记下了刚看的文章（含存档）');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(await pg.$eval('#ws', e => !e.classList.contains('on')), '首页再返回：关掉搜索');
      ok(!errs.length, '没有报错 ' + errs.join(' | '));
    }
    // ---- 这次新加的：仿冒网址提醒、按原因的出错页、链接列表、外文结果翻译、翻成英文再搜、没填翻译密钥 ----
    const typeGo = async q => { await pg.fill('.ws-v.on input[type="search"]', q); await pg.press('.ws-v.on input[type="search"]', 'Enter'); await pg.evaluate(() => document.activeElement && document.activeElement.blur()); };
    const readTxt = () => pg.$eval('[data-r="read"]', e => e.textContent);
    await pg.evaluate(() => { if (ChatterSearch.isOpen()) ChatterSearch.closeNow(); ChatterSearch._w.type = 'web'; ChatterSearch.open(); }); await pg.waitForTimeout(80);
    await typeGo('www.blilblil.com'); await pg.waitForSelector('.ws-warn');
    await shot('9-仿冒网址提醒');
    if (theme === 'light') {
      const w = await readTxt();
      ok(/blilblil\.com 和「哔哩哔哩」（bilibili\.com）只差几个字母/.test(w) && /跳转到了另一个网站：gotowww\.aipages\.dev/.test(w), '输入 www.blilblil.com：提醒可能是仿冒的哔哩哔哩，并说跳到了 gotowww.aipages.dev');
      ok(await pg.$eval('.ws-warn [data-act="rd-goto"]', e => e.dataset.u === 'https://bilibili.com/' && /去真的哔哩哔哩/.test(e.textContent)), '提醒里有“去真的哔哩哔哩（bilibili.com）”');
      const eb = await pg.$$eval('.ws-err .ws-btn', a => a.map(x => (x.classList.contains('pri') ? '★' : '') + x.textContent));
      ok(eb[0] === '★去真的哔哩哔哩（bilibili.com）' && eb.indexOf('仍然打开原网页（小心）') > 0 && !eb.some(x => x === '★仍然打开原网页（小心）'), '疑似仿冒：第一个按钮是去真的网站，“打开原网页”放后面并提醒小心 → ' + eb.join(' / '));
      const la = await pg.evaluate(() => ['https://www.blilblil.com/', 'https://gitlab.com/', 'https://www.bilibili.com/video/x', 'https://githud.com/', 'https://apple.com.cn/', 'https://twitch.tv/', 'https://goggle.com/', 'https://taobaoo.com/', 'https://zhibo.tv/', 'https://example.org/', 'https://space.bilibili.com/1'].map(u => (ChatterSearch._lookAlike(u) || {}).n || '-'));
      ok(la.join(',') === '哔哩哔哩,-,-,GitHub,-,-,Google,淘宝,-,-,-', '仿冒判断：只提醒真像的，不误伤正规网站 → ' + la.join(','));
    }
    await pg.goBack(); await pg.waitForTimeout(120);
    await typeGo('www.bilibilii.com'); await pg.waitForSelector('.ws-err .ws-btn');
    if (theme === 'light') {
      const bs = await pg.$$eval('.ws-err .ws-btn', a => a.map(x => (x.classList.contains('pri') ? '★' : '') + x.textContent));
      ok(/找不到 bilibilii\.com 这个网站/.test(await readTxt()) && bs[0] === '★你要找的是哔哩哔哩吗？去 bilibili.com' && bs[1] === '搜索「bilibilii」', '网站不存在：先问“你要找的是不是哔哩哔哩”，再给搜索 → ' + bs.join(' / '));
      await pg.click('.ws-err [data-act="rd-search"]'); await pg.waitForSelector('[data-v="res"].on');
      ok((await pg.evaluate(() => __log.filter(x => x.op === 'search').slice(-1)[0].q)) === 'bilibilii', '点“搜索”：直接搜这个词');
      await pg.goBack(); await pg.waitForTimeout(120);
    }
    await pg.goBack(); await pg.waitForTimeout(120);
    await typeGo('busyarch.example.com/p'); await pg.waitForSelector('.ws-err [data-act="rd-arch"]');
    await pg.click('.ws-err [data-act="rd-arch"]'); await pg.waitForFunction(() => /太忙/.test((document.querySelector('[data-r="read"]') || {}).textContent || ''));
    await shot('10-档案馆限流');
    if (theme === 'light') {
      const t = await readTxt(), pri = await pg.$eval('.ws-err .ws-btn.pri', e => e.textContent);
      ok(/互联网档案馆现在太忙/.test(t) && /已经自动重试过一次/.test(t) && pri === '重试' && !/可能要登录/.test(t), '档案馆限流（就是截图那种情况）：说清楚是档案馆太忙、已经自动重试过，第一个按钮是“重试”');
    }
    await pg.goBack(); await pg.goBack(); await pg.waitForTimeout(150);
    await typeGo('portal.example.com'); await pg.waitForSelector('.ws-lks'); await pg.waitForFunction(() => /已翻译成中文/.test((document.querySelector('.ws-trb') || {}).textContent || ''));
    await shot('11-链接列表');
    if (theme === 'light') {
      const lt = await pg.$$eval('.ws-lks .lt', a => a.map(x => x.textContent));
      ok(lt[0] === '译：First big headline today' && lt[3] === 'BLOCKME sensitive headline' && await pg.$eval('.ws-art h1', e => e.textContent === '译：Portal Home'), '首页这类：列出页面上的链接，外文的自动翻成中文');
      ok(/有 1 段没翻成：翻译服务按国内规定拒绝翻译这些内容/.test(await pg.$eval('.ws-trb', e => e.textContent)) && await pg.$('.ws-trb [data-act="tr-go"]'), '有一段被拒绝翻译：说清楚原因，显示原文，可以再试');
      await pg.click('.ws-lks [data-i="1"]'); await pg.waitForSelector('.ws-body p');
      ok((await pg.evaluate(() => __log.filter(x => x.op === 'read').slice(-1)[0].url)) === 'https://portal.example.com/story/1', '点列表里的链接：接着在 App 里打开');
      await pg.goBack(); await pg.waitForTimeout(120);
    }
    await pg.goBack(); await pg.waitForTimeout(120);
    await typeGo('quantum computing'); await pg.waitForFunction(() => { const a = document.querySelector('.ws-r a.t'); return a && a.textContent.startsWith('译：'); });
    await shot('12-外文结果自动翻译');
    if (theme === 'light') {
      ok((await pg.$$eval('.ws-r a.t', a => a.map(x => x.textContent))).every(t => t.startsWith('译：')) && /译：A quantum computer/.test(await pg.$eval('.ws-r .s', e => e.textContent)), '外文搜索结果：标题和摘要自动翻成中文');
      await pg.click('[data-act="res-tr"]');
      ok((await pg.$eval('.ws-r a.t', e => e.textContent)) === 'Quantum computing - Wikipedia', '点“已翻成中文”：换回原文，不重新搜');
      await pg.click('[data-act="res-tr"]');
      ok((await pg.$eval('.ws-r a.t', e => e.textContent)).startsWith('译：'), '再点：换回译文');
      await typeGo('量子计算'); await pg.waitForSelector('[data-act="q-en"]');
      await pg.click('[data-act="q-en"]'); await pg.waitForFunction(() => /已把「量子计算」翻成英文「quantum computing」来搜/.test((document.querySelector('[data-r="res"]') || {}).textContent || ''));
      await pg.waitForFunction(() => { const a = document.querySelector('.ws-r a.t'); return a && a.textContent.startsWith('译：'); });
      ok((await pg.evaluate(() => __log.filter(x => x.op === 'search').slice(-1)[0].q)) === 'quantum computing', '“翻成英文再搜”：中文词翻成英文去搜，结果自动翻回中文');
      await pg.click('[data-act="q-back"]'); await pg.waitForFunction(() => (document.querySelector('.ws-r a.t') || {}).textContent === 'qiskit/qiskit：开源的量子计算工具包');
      ok(true, '点“搜回中文”：回到中文结果');
      await pg.evaluate(() => { window.__trMode = 'nokey'; });
      await typeGo('en.example.com/a'); await pg.waitForFunction(() => /翻译还没开通/.test((document.querySelector('.ws-trb') || {}).textContent || ''));
      ok(!(await pg.$('.ws-trb [data-act="tr-go"]')), '还没填翻译密钥：说清楚，不给没用的“重试”');
      await pg.evaluate(() => { window.__trMode = ''; });
      await pg.goBack(); await pg.waitForTimeout(120);
      await pg.click('.ws-v.on [data-act="rules"]'); await pg.waitForSelector('[data-act="tgl-tr"]');
      ok(/外文自动翻译成中文[\s\S]*智谱（免费）[\s\S]*已开通[\s\S]*Groq（备用，可不填）[\s\S]*没填/.test(await pg.$eval('[data-r="rules"]', e => e.textContent)), '规则页：有翻译开关和两家翻译服务的状态');
      await pg.click('.ws-sw[data-act="tgl-tr"]'); const n0 = await pg.evaluate(() => __log.filter(x => x.op === 'translate').length);
      await pg.goBack(); await pg.waitForTimeout(120);
      await typeGo('en.example.com/b'); await pg.waitForFunction(() => /这是外文网页/.test((document.querySelector('.ws-trb') || {}).textContent || ''));
      ok(await pg.evaluate(() => __log.filter(x => x.op === 'translate').length) === n0 && await pg.$('.ws-trb [data-act="tr-go"]'), '关掉自动翻译：外文网页不自动翻，顶部给一个“翻译成中文”按钮');
      await pg.click('.ws-trb [data-act="tr-go"]'); await pg.waitForFunction(() => /已翻译成中文/.test((document.querySelector('.ws-trb') || {}).textContent || ''));
      ok(true, '点“翻译成中文”：照样能翻');
      ok(!errs.length, '新功能也没有报错 ' + errs.join(' | '));

      // ---------- 在 App 里看原网页 ----------
      await pg.evaluate(() => { window.__frame = b => /frame\.test/.test(b.url) ? { ok: true, frame: true, why: '', url: b.url } : /unsure\.test/.test(b.url) ? { ok: true, frame: null, code: 'login', url: b.url } : /nowhere\.test/.test(b.url) ? { ok: true, frame: null, code: 'nohost', url: b.url } : { ok: true, frame: false, why: 'xfo', url: b.url }; });
      await pg.evaluate(() => { if (ChatterSearch.isOpen()) ChatterSearch.closeNow(); ChatterSearch.open(); }); await pg.waitForTimeout(80);
      await pg.click('.ws-v.on [data-act="rules"]'); await pg.waitForSelector('[data-act="tgl-open"]');
      ok(await pg.$eval('.ws-sw[data-act="tgl-open"]', e => e.getAttribute('aria-checked')) === 'false', '规则页有“先显示原网页”的开关（这组检查一开始设成了先简洁阅读）');
      await pg.click('.ws-sw[data-act="tgl-open"]');
      ok(await pg.$eval('.ws-sw[data-act="tgl-open"]', e => e.getAttribute('aria-checked')) === 'true', '打开“先显示原网页”');
      await pg.goBack(); await pg.waitForTimeout(120);
      const depth0 = await pg.evaluate(() => history.state && history.state.ws), op0 = await pg.evaluate(() => window.__opened.length);
      await typeGo('https://frame.test/a');
      await pg.waitForSelector('.ws-v.on[data-v="web"] iframe');
      const frameEl = await pg.$('.ws-v.on iframe');
      const fr = await frameEl.contentFrame(); await fr.waitForSelector('#to-b');
      ok(await on() === 'web' && /frame\.test/.test(await pg.$eval('[data-r="wsite"]', e => e.textContent)), '能嵌的网站：直接在 App 里显示原网页（顶上写着网站）');
      ok(await pg.$eval('.ws-v.on iframe', e => e.getAttribute('sandbox')) && !/allow-top-navigation/.test(await pg.$eval('.ws-v.on iframe', e => e.getAttribute('sandbox'))), '网页框有沙盒，不能把整个 App 跳走');
      ok((await pg.evaluate(() => window.__opened.length)) === op0, '没有跳到系统浏览器');
      await shot('13-原网页');
      await fr.click('#to-b'); await pg.waitForTimeout(250);
      await (await (await pg.$('.ws-v.on iframe')).contentFrame()).click('#to-c'); await pg.waitForTimeout(250);
      const cur = async () => (await (await pg.$('.ws-v.on iframe')).contentFrame()).url();
      ok(/\/c$/.test(await cur()), '网页里点链接：接着在 App 里看');
      await pg.click('.ws-v.on [data-act="back"]'); await pg.waitForTimeout(300);
      ok(await on() === 'web' && /\/b$/.test(await cur()), '点“‹”：先在网页里后退一页 → ' + await cur());
      await pg.click('.ws-v.on [data-act="web-close"]'); await pg.waitForFunction(d => history.state && history.state.ws === d && (document.querySelector('.ws-v.on') || {}).dataset.v === 'home', depth0, { timeout: 5000 }).catch(() => {});
      ok(await on() === 'home' && await pg.evaluate(() => history.state && history.state.ws) === depth0 && !(await pg.$('[data-r="wbox"] iframe')), '点“×”：不管网页里点了几层，直接回到进来之前那一页 → ' + await on() + ' ws=' + await pg.evaluate(() => history.state && history.state.ws));
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(!(await pg.evaluate(() => ChatterSearch.isOpen())) || (await pg.evaluate(() => history.state && history.state.ws)) !== depth0, '再返回一次就离开这一页（中间没有要多按几次的空记录）');
      await pg.evaluate(() => ChatterSearch.open()); await pg.waitForTimeout(80);
      await typeGo('https://frame.test/a'); await pg.waitForSelector('.ws-v.on iframe');
      await pg.click('.ws-v.on [data-act="web-read"]'); await pg.waitForFunction(() => (document.querySelector('.ws-v.on') || {}).dataset.v === 'read');
      ok((await pg.evaluate(() => __log.filter(x => x.op === 'read').slice(-1)[0].url)) === 'https://frame.test/a', '原网页里点“简洁阅读”：换成简洁阅读（能翻译、调字号）');
      await pg.goBack(); await pg.waitForTimeout(200);
      ok(await on() === 'home', '从简洁阅读返回：回到进来之前那一页');
      await typeGo('https://deny.test/x'); await pg.waitForFunction(() => /不允许在别的 App 里显示原网页，已换成简洁阅读/.test((document.querySelector('[data-r="read"]') || {}).textContent || ''));
      ok(await on() === 'read' && (await pg.evaluate(() => window.__opened.length)) === op0, '不让嵌的网站：自动换成简洁阅读，说清原因（不跳出 App）');
      await pg.click('[data-r="rdsc"] [data-act="rd-ext"]');
      ok((await pg.evaluate(() => window.__opened.slice(-1)[0])) === 'https://deny.test/x', '说明旁边可以“用浏览器打开原网页”');
      await pg.click('.ws-v.on .ws-bar [data-act="rd-orig"]');
      ok((await pg.evaluate(() => window.__opened.length)) === op0 + 2 && await on() === 'read', '已经知道不让嵌：“原网页”按钮直接用浏览器打开，不会来回跳');
      await pg.goBack(); await pg.waitForTimeout(150);
      await typeGo('https://x.com/someone'); await pg.waitForSelector('.ws-v.on[data-v="web"] .ws-err');
      ok(/用浏览器打开（能用你的登录）/.test(await pg.$eval('.ws-v.on .ws-err', e => e.textContent)), '要登录的网站（推特等）不让嵌：给出“用浏览器打开（能用你的登录）”');
      await shot('14-不让嵌');
      await pg.click('.ws-v.on .ws-err [data-act="web-ext"]');
      ok((await pg.evaluate(() => window.__opened.slice(-1)[0])) === 'https://x.com/someone', '点了才用浏览器打开');
      await pg.click('.ws-v.on [data-act="web-close"]'); await pg.waitForTimeout(300);
      await typeGo('https://nowhere.test/'); await pg.waitForFunction(() => (document.querySelector('.ws-v.on') || {}).dataset.v === 'read');
      ok(true, '找不到网站：交给简洁阅读那边按原因提示');
      await pg.goBack(); await pg.waitForTimeout(150);
      await typeGo('https://unsure.test/p'); await pg.waitForSelector('.ws-v.on iframe'); await pg.waitForSelector('[data-r="wtip"]:not([hidden])');
      ok(/没能确认[\s\S]*换简洁阅读/.test(await pg.$eval('[data-r="wtip"]', e => e.textContent)), '服务器取不到（可能不让国外服务器访问）：照样在 App 里试着显示，下面提示“看不到内容？换简洁阅读”');
      ok(!errs.length, '原网页功能没有报错 ' + errs.join(' | '));
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
      ${f.dark ? `<div><div style="font-size:15px;color:#4a4655;margin:0 0 10px 6px">深色</div><img src="${b64(f.dark)}" style="width:390px;height:844px;border-radius:38px;box-shadow:0 10px 40px rgba(0,0,0,.18);display:block"></div>` : ''}</div></body>`);
    await pg.waitForTimeout(100);
    await pg.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 86, fullPage: true });
  }
  await br.close(); srv.close();
  console.log('截图在：' + OUT);
  console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过'); process.exit(bad ? 1 : 0);
})().catch(e => { console.log('出错：', e); process.exit(1); });
