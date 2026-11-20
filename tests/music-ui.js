// 音乐在真 Chromium 里的检查 + 截图：用 App 自己的样式（index.html 里的主题变量），Audius 换成假的（不联网）。
// 用法：cd tests && node music-ui.js [截图目录]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'mu-shots-'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];

// 一段 2 秒的正弦波（WAV），当作假的歌
function wav(sec) {
  const rate = 8000, n = Math.round(rate * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 3000), 44 + i * 2);
  return b;
}
const SONG = wav(5), SHORT = wav(0.6);
const COLORS = ['8b7cf6', '22c08a', 'e8508c', 'e39a2d', '3a8ee6', '6c5ce7'];
const ART = (id, size) => `https://art.test/${id}/${size}.svg`;
const TR = (n, extra) => Object.assign({ id: 't' + n, title: ['夜里的海', 'Morning Coffee', '城市边缘', 'Lo-Fi 学习用', '雨天', 'Slow Drive', '风', 'Neon'][n % 8] + (n >= 8 ? ' ' + n : ''), duration: 180 + n * 7,
  permalink: '/artist' + n + '/song-' + n, access: { stream: true, download: false }, is_stream_gated: false, stream_conditions: null,
  artwork: { '150x150': ART('t' + n, 150), '480x480': ART('t' + n, 480), '1000x1000': ART('t' + n, 1000), mirrors: ['https://mirror.test'] }, user: { name: '音乐人 ' + n, handle: 'artist' + n } }, extra || {});
const TREND = Array.from({ length: 12 }, (_, i) => TR(i)).concat([TR(90, { access: { stream: false } }), TR(91, { stream_conditions: { follow_user_id: 1 } }), TR(92, { is_delete: true })]);
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${CSS}</style></head>
<body><div class="app-container"><div id="app-view" class="active" style="display:flex;flex-direction:column;height:100%"><header class="app-header"><div class="brand"><span>Chatter</span></div></header><main><p style="padding:20px">消息列表</p><audio id="voice" src="/voice.wav"></audio></main><nav class="app-nav"><button>消息</button><button>我</button></nav></div></div><script>
window.__log = [];
window.__chWS = { toast: m => __log.push({ toast: m }), acts: (t, items) => { window.__acts = items; }, forward: t => __log.push({ fwd: t }), uid: () => window.__uid || 'u1', link: (u, t) => __log.push({ link: u }) };
addEventListener('popstate', e => window.ChatterMusic && ChatterMusic.onPop(e));
</script><script src="/music.js"></script></body></html>`;
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/music.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(fs.readFileSync(path.join(ROOT, 'music.js'))); }
  if (q.url.startsWith('/voice.wav')) { r.writeHead(200, { 'content-type': 'audio/wav' }); return r.end(SHORT); }
  const sm = /^\/cidstream\/(\w+)/.exec(q.url);
  if (sm) {   // 像 Audius 的音乐文件服务器：支持分段取（拖进度条要用）
    const body = sm[1] === 't1' ? SHORT : SONG, rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || '');
    const h = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
    if (!rg) { r.writeHead(200, Object.assign(h, { 'content-length': body.length })); return r.end(body); }
    const a = +rg[1], b = rg[2] ? Math.min(+rg[2], body.length - 1) : body.length - 1;
    r.writeHead(206, Object.assign(h, { 'content-range': 'bytes ' + a + '-' + b + '/' + body.length, 'content-length': b - a + 1 })); return r.end(body.slice(a, b + 1));
  }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page);
}).listen(8768);
let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + m); };
(async () => {
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const shots = {};
  for (const theme of ['light', 'dark']) {
    const L = theme === 'light'; let likedT = '';
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: true });
    const reqs = [];
    await ctx.route(/art\.test|mirror\.test/, rt => { const u = rt.request().url(), id = (/\/(t\d+)\//.exec(u) || [])[1] || 't0', c = COLORS[(+id.slice(1)) % COLORS.length];
      if (/art\.test\/t3\//.test(u)) return rt.fulfill({ status: 404, body: '' });   // 第 3 首的封面服务器坏了：要换备用服务器
      rt.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${c}"/><stop offset="1" stop-color="#1d1b2e"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="210" cy="90" r="40" fill="#fff" fill-opacity=".25"/></svg>` }); });
    await ctx.route(/api\.audius\.co/, async rt => {
      const u = new URL(rt.request().url()); reqs.push(u.pathname + u.search);
      const J = d => rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(d) });
      if (u.pathname === '/') return J({ data: ['https://api.audius.co'] });
      if (u.pathname === '/v1/tracks/trending') { await new Promise(r => setTimeout(r, 150)); const g = u.searchParams.get('genre'); return J({ data: g ? TREND.slice(0, 4).map(t => Object.assign({}, t, { id: t.id + g.replace(/\W/g, ''), title: g + ' · ' + t.title })) : TREND }); }
      if (u.pathname === '/v1/tracks/search') { const off = +u.searchParams.get('offset') || 0, q = u.searchParams.get('query'); if (q === '没有') return J({ data: [] }); if (q === '坏了') return rt.fulfill({ status: 500, body: '' });
        if (q === '少量') return J({ data: off >= 90 ? [] : Array.from({ length: 30 }, (_, i) => TR(500 + off + i, { title: '少量 ' + (off + i + 1), access: { stream: i % 5 < 2 } })) });   // 一页 30 条里只有 12 条能播
        return J({ data: off >= 60 ? [] : Array.from({ length: 30 }, (_, i) => TR(100 + off + i, { title: q + ' 第 ' + (off + i + 1) + ' 首' })) }); }
      const m = /^\/v1\/tracks\/([^/]+)\/stream$/.exec(u.pathname);
      if (m) { if (/^bad/.test(m[1])) return rt.fulfill({ status: 404, body: '' }); return rt.fulfill({ status: 302, headers: { location: 'http://localhost:8768/cidstream/' + m[1] + '?signature=x', 'access-control-allow-origin': '*' } }); }
      rt.fulfill({ status: 404, body: '' });
    });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await pg.goto('http://localhost:8768/');
    const shot = async name => { await pg.waitForTimeout(300); const f = path.join(OUT, theme + '-' + name + '.png'); await pg.screenshot({ path: f }); (shots[name] = shots[name] || {})[theme] = f; };
    const on = () => pg.evaluate(() => (document.querySelector('.mu-v.on') || {}).dataset.v);
    const st = () => pg.evaluate(() => { const a = document.getElementById('mu-audio'); return a ? { paused: a.paused, src: a.getAttribute('src') || '', t: a.currentTime } : null; });
    const toasts = () => pg.evaluate(() => __log.filter(x => x.toast).map(x => x.toast));

    await pg.evaluate(() => ChatterMusic.open());
    await pg.waitForSelector('.mu-v.on[data-v="home"] .mu-row');
    await shot('1-音乐首页');
    if (L) {
      const titles = await pg.$$eval('.mu-v.on .mu-row .mu-rt', a => a.map(x => x.textContent));
      ok(titles.length === 12 && !titles.some(t => /9[012]/.test(t)), '热门：只列出能直接播的歌（要付费 / 关注才能听的、删了的去掉）→ ' + titles.length + ' 首');
      ok(reqs.includes('/') && reqs.some(r => r === '/v1/tracks/trending?app_name=Chatter&time=week&limit=50'), '直接问 Audius：先问用哪个服务器，再拿本周热门（带 app_name）→ ' + reqs.slice(0, 3).join(' | '));
      ok(await pg.evaluate(() => history.state && history.state.mu === 1), '打开音乐加了一层历史（返回手势能关掉）');
      await pg.click('.mu-chip[data-g="Lo-Fi"]'); await pg.waitForFunction(() => /Lo-Fi · /.test((document.querySelector('.mu-v.on .mu-row .mu-rt') || {}).textContent || ''));
      ok(reqs.some(r => /genre=Lo-Fi/.test(r)) && await pg.$eval('.mu-chip.act', e => e.textContent) === 'Lo-Fi', '点曲风“Lo-Fi”：换成这一类的热门');
      await pg.click('.mu-chip[data-g=""]'); await pg.waitForTimeout(100);
      const n0 = reqs.filter(r => /trending/.test(r)).length; await pg.click('.mu-chip[data-g="Lo-Fi"]'); await pg.waitForTimeout(100); await pg.click('.mu-chip[data-g=""]'); await pg.waitForTimeout(100);
      ok(reqs.filter(r => /trending/.test(r)).length === n0, '切回看过的曲风：用已经拿到的，不重复请求');
      await pg.waitForFunction(() => { const im = document.querySelector('.mu-v.on .mu-row[data-i="3"] img'); return im && /mirror\.test/.test(im.src) && im.complete && im.naturalWidth > 0; }, null, { timeout: 4000 }).catch(() => {});
      ok(await pg.evaluate(() => { const im = document.querySelector('.mu-v.on .mu-row[data-i="3"] img'); return !!im && /mirror\.test/.test(im.src); }), '封面的服务器坏了：自动换 Audius 给的备用服务器');
    }
    // 播放
    await pg.click('.mu-v.on .mu-row >> nth=0'); await pg.waitForSelector('.mu-v.on[data-v="now"]');
    await pg.waitForFunction(() => { const a = document.getElementById('mu-audio'); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 8000 }).catch(() => {});
    await shot('2-正在播放');
    if (L) {
      const s1 = await st();
      ok(s1 && !s1.paused && s1.src === 'https://api.audius.co/v1/tracks/t0/stream?app_name=Chatter', '点一首：打开“正在播放”，手机直接从 Audius 取歌开始放 → ' + JSON.stringify(s1));
      const meta = await pg.evaluate(() => navigator.mediaSession && navigator.mediaSession.metadata && { t: navigator.mediaSession.metadata.title, a: navigator.mediaSession.metadata.artist, n: navigator.mediaSession.metadata.artwork.length });
      ok(meta && meta.t === '夜里的海' && meta.a === '音乐人 0' && meta.n === 3, '锁屏和耳机线控能看到歌名、歌手、封面（系统的“正在播放”）→ ' + JSON.stringify(meta));
      await pg.click('[data-act="toggle"]'); await pg.waitForFunction(() => { const a = document.getElementById('mu-audio'); return a.paused; }, null, { timeout: 4000 }).catch(() => {});
      ok((await st()).paused && /M8 5\.5v13/.test(await pg.$eval('[data-act="toggle"]', e => e.innerHTML)) && await pg.evaluate(() => navigator.mediaSession.playbackState) === 'paused', '点暂停：停下，按钮变回“播放”');
      await pg.click('[data-act="toggle"]'); await pg.waitForFunction(() => !document.getElementById('mu-audio').paused);
      ok(true, '再点：接着放');
      await pg.click('[data-act="next"]'); await pg.waitForFunction(() => { const a = document.getElementById('mu-audio'); return a.getAttribute('src').includes('/t1/stream'); }, null, { timeout: 4000 }).catch(() => {});
      ok((await st()).src.includes('/t1/stream') && await pg.$eval('.mu-nt .mu-rt', e => e.textContent) === 'Morning Coffee', '下一首');
      await pg.waitForFunction(() => document.getElementById('mu-audio').getAttribute('src').includes('/t2/stream'), null, { timeout: 6000 }).catch(() => {});
      ok((await st()).src.includes('/t2/stream'), '放完自动下一首');
      await pg.evaluate(() => { document.getElementById('mu-audio').currentTime = 0; });
      await pg.click('[data-act="prev"]'); await pg.waitForFunction(() => { const a = document.getElementById('mu-audio'); return a.getAttribute('src').includes('/t1/stream'); }, null, { timeout: 4000 }).catch(() => {});
      ok((await st()).src.includes('/t1/stream'), '刚开始放时点“上一首”：回到上一首');
      await pg.waitForFunction(() => document.getElementById('mu-audio').currentTime > 0.1).catch(() => {});
      await pg.click('[data-act="next"]'); await pg.waitForFunction(() => document.getElementById('mu-audio').currentTime > 0.1, null, { timeout: 5000 }).catch(() => {});
      await pg.evaluate(() => { const a = document.getElementById('mu-audio'); try { a.currentTime = 3.5; } catch (e) {} });
      await pg.waitForTimeout(150);
      await pg.click('[data-act="prev"]'); await pg.waitForTimeout(150);
      const s2 = await st();
      ok(s2.src.includes('/t2/stream') && s2.t < 0.8, '放了一会儿再点“上一首”：先回到这首开头 → ' + JSON.stringify(s2));
      // 播放方式
      await pg.click('[data-act="mode"]'); ok((await toasts()).slice(-1)[0] === '单曲循环', '播放方式：列表循环 → 单曲循环');
      await pg.evaluate(() => { const a = document.getElementById('mu-audio'); a.currentTime = a.duration - 0.2; });
      await pg.waitForFunction(() => document.getElementById('mu-audio').currentTime < 1 && !document.getElementById('mu-audio').paused, null, { timeout: 4000 }).catch(() => {});
      ok((await st()).src.includes('/t2/stream'), '单曲循环：放完从头再放这一首');
      await pg.click('[data-act="mode"]'); ok((await toasts()).slice(-1)[0] === '随机播放', '→ 随机播放');
      const seen = new Set(); for (let k = 0; k < 11; k++) { await pg.click('[data-act="next"]'); await pg.waitForTimeout(40); seen.add(await pg.evaluate(() => ChatterMusic._m.i)); }
      ok(seen.size === 11, '随机播放：每首都轮到一次才重复 → 轮到了 ' + seen.size + ' 首');
      await pg.click('[data-act="mode"]'); ok((await toasts()).slice(-1)[0] === '列表循环', '→ 回到列表循环');
      // 拖进度条
      await pg.evaluate(() => { const a = document.getElementById('mu-audio'); a.pause(); });
      await pg.evaluate(() => { const r = document.querySelector('[data-r="seek"]'); r.value = '500'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
      const t2 = await pg.evaluate(() => { const a = document.getElementById('mu-audio'); return a.currentTime / a.duration; });
      ok(t2 > 0.4 && t2 < 0.6, '拖进度条：跳到对应的位置 → ' + t2.toFixed(2));
      // 喜欢
      likedT = await pg.evaluate(() => ChatterMusic.now().t);
      await pg.click('[data-act="like"]');
      ok((await toasts()).slice(-1)[0] === '已加到“我喜欢”' && await pg.$('.mu-like.on'), '点 ♡：加到“我喜欢”');
      // 别的声音开始放：音乐先停
      await pg.click('[data-act="toggle"]'); await pg.waitForFunction(() => !document.getElementById('mu-audio').paused);
      await pg.evaluate(() => document.getElementById('voice').play());
      await pg.waitForFunction(() => { const a = document.getElementById('mu-audio'); return a.paused; }, null, { timeout: 4000 }).catch(() => {});
      ok((await st()).paused, '放语音消息、视频或者通话开始时：音乐自动先停，不叠在一起');
      await pg.evaluate(() => document.getElementById('voice').pause());
    }
    // 迷你播放条
    await pg.click('.mu-v.on [data-act="back"]'); await pg.waitForTimeout(150);
    await pg.click('.mu-v.on [data-act="back"]'); await pg.waitForTimeout(150);
    await shot('3-迷你播放条');
    if (L) {
      const nowT = await pg.evaluate(() => ChatterMusic.now().t);
      ok(!(await pg.evaluate(() => ChatterMusic.isOpen())) && await pg.$eval('#mu-mini', (e, t) => e.classList.contains('on') && e.textContent.indexOf(t) >= 0, nowT), '关掉音乐：主界面底部（菜单上面）出现迷你播放条');
      ok(await pg.evaluate(() => { const m = document.getElementById('mu-mini'), n = document.querySelector('.app-nav'); return m.nextElementSibling === n && m.getBoundingClientRect().bottom <= n.getBoundingClientRect().top + 1; }), '迷你条在菜单上面，不挡菜单');
      await pg.click('#mu-mini [data-act="mini-pp"]'); await pg.waitForFunction(() => !document.getElementById('mu-audio').paused);
      ok(!(await pg.evaluate(() => ChatterMusic.isOpen())), '迷你条上点播放：直接放，不打开页面');
      await pg.evaluate(() => { const a = document.getElementById('mu-audio'); a.currentTime = 2.2; ChatterMusic._m.savedAt = 0; });
      await pg.waitForFunction(() => { const v = JSON.parse(localStorage.getItem('ch2muNow:u1') || 'null'); return v && v.at >= 2; }, null, { timeout: 4000 }).catch(() => {});
      const sv = await pg.evaluate(() => JSON.parse(localStorage.getItem('ch2muNow:u1') || 'null'));
      ok(sv && sv.at >= 2 && sv.q.length === 12, '放的时候每 5 秒把位置记在手机里（重开能接着听）→ ' + (sv && sv.at) + ' 秒');
      await pg.evaluate(() => { const v = document.createElement('video'); v.muted = true; v.id = 'mutedv'; v.src = '/voice.wav'; document.body.appendChild(v); return v.play().catch(() => {}); });
      await pg.waitForTimeout(200);
      ok(!(await st()).paused, '静音的视频开始放（比如视频通话里自己的画面）：音乐不停');
      await pg.evaluate(() => document.getElementById('mutedv').remove());
      const want = await pg.evaluate(() => { const m = ChatterMusic._m; return m.q[(m.i + 1) % m.q.length].id; });
      await pg.click('#mu-mini [data-act="mini-next"]'); await pg.waitForFunction(w => document.getElementById('mu-audio').getAttribute('src').includes('/' + w + '/stream'), want, { timeout: 4000 }).catch(() => {});
      ok((await st()).src.includes('/' + want + '/stream'), '迷你条上点下一首');
      await pg.evaluate(() => ChatterMusic._play(ChatterMusic._m.q, 3));
      await pg.click('#mu-mini .mu-tx'); await pg.waitForSelector('.mu-v.on[data-v="now"]');
      ok(await pg.evaluate(() => history.state && history.state.mu === 1), '点迷你条：打开“正在播放”（只有这一层）');
      await pg.waitForTimeout(400);
      ok(await pg.evaluate(() => { const im = document.querySelector('.mu-big'); return im && im.tagName === 'IMG' && /mirror\.test/.test(im.src); }), '封面的服务器坏了：自动换 Audius 给的备用服务器');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(!(await pg.evaluate(() => ChatterMusic.isOpen())), '返回：直接关掉');
      await pg.evaluate(() => document.body.classList.add('chat-open'));
      ok(await pg.$eval('#mu-mini', e => getComputedStyle(e).display === 'none'), '打开聊天时：迷你条不显示（不挡输入框）');
      await pg.evaluate(() => document.body.classList.remove('chat-open'));
    }
    // 搜索
    await pg.evaluate(() => ChatterMusic.open()); await pg.waitForSelector('.mu-v.on[data-v="home"]');
    await pg.fill('.mu-v.on input[type="search"]', 'piano'); await pg.press('.mu-v.on input[type="search"]', 'Enter');
    await pg.waitForSelector('.mu-v.on[data-v="list"] .mu-row');
    await shot('4-搜索结果');
    if (L) {
      ok((await pg.$$eval('.mu-v.on .mu-row', a => a.length)) === 30 && await pg.$eval('[data-r="ltitle"]', e => e.textContent) === '搜「piano」', '搜歌：一次列出 30 首');
      await pg.click('[data-act="more-res"]'); await pg.waitForFunction(() => document.querySelectorAll('.mu-v.on .mu-row').length === 60);
      ok(reqs.some(r => /search\?app_name=Chatter&query=piano&limit=30&offset=30/.test(r)), '加载更多：接着往后取（offset）');
      await pg.click('[data-act="more-res"]'); await pg.waitForFunction(() => /没有更多了/.test(document.querySelector('[data-r="list"]').textContent));
      ok(true, '没有了：写“没有更多了”');
      await pg.click('.mu-v.on .mu-row [data-act="row-more"] >> nth=0');
      const lab = await pg.evaluate(() => __acts.map(x => x.label));
      ok(lab.includes('喜欢') && lab.includes('下一首播放') && lab.includes('发给好友'), '每首歌的“⋯”：喜欢、下一首播放、发给好友 → ' + lab.join(' / '));
      await pg.evaluate(() => __acts.find(x => x.label === '下一首播放').fn());
      ok(await pg.evaluate(() => ChatterMusic._m.q[ChatterMusic._m.i + 1].t) === 'piano 第 1 首', '下一首播放：插到正在放的这首后面');
      await pg.fill('.mu-v.on input[type="search"]', '没有').catch(() => {});
      await pg.goBack(); await pg.waitForTimeout(120);
      await pg.fill('.mu-v.on input[type="search"]', '没有'); await pg.press('.mu-v.on input[type="search"]', 'Enter'); await pg.waitForSelector('.mu-v.on .mu-msg');
      ok(/没找到能直接听的歌[\s\S]*英文搜/.test(await pg.$eval('.mu-v.on .mu-msg', e => e.textContent)), '搜不到：说清楚（Audius 是独立音乐人的曲库），建议用英文搜');
      await pg.goBack(); await pg.waitForTimeout(120);
      await pg.fill('.mu-v.on input[type="search"]', '坏了'); await pg.press('.mu-v.on input[type="search"]', 'Enter'); await pg.waitForSelector('.mu-v.on .mu-msg .mu-btn');
      ok(/Audius 出错了（500）/.test(await pg.$eval('.mu-v.on .mu-msg', e => e.textContent)), 'Audius 出错：说中文原因，给“重试”');
      await pg.goBack(); await pg.waitForTimeout(120);
      // 我喜欢、最近播放
      await pg.click('.mu-quick [data-act="likes"]'); await pg.waitForSelector('.mu-v.on[data-v="list"]');
      ok((await pg.$$eval('.mu-v.on .mu-row .mu-rt', a => a.map(x => x.textContent))).join() === likedT, '“我喜欢”里有刚才点了 ♡ 的歌');
      await pg.goBack(); await pg.waitForTimeout(120);
      await pg.click('.mu-quick [data-act="recent"]'); await pg.waitForSelector('.mu-v.on[data-v="list"] .mu-row');
      ok((await pg.$$eval('.mu-v.on .mu-row', a => a.length)) >= 4 && (await pg.$eval('.mu-v.on .mu-row .mu-rt', e => e.textContent)) === await pg.evaluate(() => ChatterMusic.now().t), '“最近播放”：最近放的排最前');
      await pg.goBack(); await pg.waitForTimeout(120);
      // 放不出来：换下一首；连续 3 首都不行就停
      await pg.evaluate(() => ChatterMusic._play([{ id: 'bad1', t: '坏的 1', a: '' }, { id: 'bad2', t: '坏的 2', a: '' }, { id: 'bad3', t: '坏的 3', a: '' }, { id: 't5', t: '好的', a: '' }], 0));
      await pg.waitForFunction(() => __log.filter(x => x.toast && /放不出来/.test(x.toast)).length >= 3, null, { timeout: 8000 }).catch(() => {});
      const tt = (await toasts()).filter(x => /放不出来/.test(x));
      // GPT 11-20 挑出来的 4 个问题（复测）
      const T200 = await pg.evaluate(() => Array.from({ length: 205 }, (_, i) => ({ id: 'q' + i, t: '第 ' + (i + 1) + ' 首', a: '' })));
      await pg.evaluate(L => ChatterMusic._play(L, 200), T200); await pg.waitForTimeout(100);
      ok(await pg.evaluate(() => ChatterMusic.now() && ChatterMusic.now().t) === '第 201 首', '【GPT 挑的③】在 205 首的列表里点第 201 首：放的就是第 201 首（以前显示“还没有在放的歌”）');
      await pg.evaluate(L => ChatterMusic._play(L, 204), T200); await pg.waitForTimeout(100);
      ok(await pg.evaluate(() => ChatterMusic.now().t) === '第 205 首', '点最后一首也对');
      const e0 = errs.length;
      const nx = await pg.evaluate(() => { const m = ChatterMusic._m, t = m.q[0], before = m.q[m.i].id; try { ChatterMusic._next(t); } catch (e) { return 'ERR ' + e.message; } return [m.q[m.i].id === before, m.q[m.i + 1].id === t.id, m.q.filter(x => x.id === t.id).length].join(); });
      ok(nx === 'true,true,1' && errs.length === e0, '【GPT 挑的②】放最后一首时给第一首点“下一首播放”：不出错，排到正在放的后面，列表里不重复 → ' + nx);
      await pg.evaluate(() => ChatterMusic._next(ChatterMusic._m.q[ChatterMusic._m.i]));
      ok((await toasts()).slice(-1)[0] === '正在放的就是这首', '给正在放的这首点“下一首播放”：提示一下，不乱排');
      await pg.fill('.mu-v.on input[type="search"]', '少量'); await pg.press('.mu-v.on input[type="search"]', 'Enter');
      await pg.waitForFunction(() => document.querySelectorAll('.mu-v.on[data-v="list"] .mu-row').length >= 12, null, { timeout: 5000 }).catch(() => {});
      const fewN = await pg.$$eval('.mu-v.on .mu-row', a => a.length);
      ok(fewN === 12 && await pg.$('[data-act="more-res"]'), '【GPT 挑的④】一页 30 条里只有 12 首能播：“加载更多”还在（以前按能播的条数判断，以为到底了）');
      await pg.click('[data-act="more-res"]'); await pg.waitForFunction(() => document.querySelectorAll('.mu-v.on[data-v="list"] .mu-row').length === 24, null, { timeout: 5000 }).catch(() => {});
      ok(reqs.some(r => /query=%E5%B0%91%E9%87%8F&limit=30&offset=30/.test(r)) && await pg.$$eval('.mu-v.on .mu-row', a => a.length) === 24, '加载更多：按 Audius 给过的条数往后取（offset=30，不是 12），不跳过、不重复');
      await pg.goBack(); await pg.waitForTimeout(150);
      ok(tt[0] === '“坏的 1”放不出来，换下一首' && tt[1] === '“坏的 2”放不出来，换下一首' && /可能是网络不好/.test(tt[2]) && !(await st()).src.includes('t5'), '放不出来：说一声换下一首；连续 3 首不行就停下说原因（不一直转）→ ' + tt.join(' / '));
    }
    await pg.close();
    // 重开 App：恢复迷你条，不自动播放、先不连 Audius；点播放从上次的位置接着放
    if (L) {
      const pg2 = await ctx.newPage(); pg2.on('pageerror', e => errs.push(e.message));
      await pg2.goto('http://localhost:8768/');
      await pg2.evaluate(() => localStorage.setItem('ch2muNow:u1', JSON.stringify({ q: [{ id: 't4', t: '雨天', a: '音乐人 4', d: 208, s: 'https://art.test/t4/150.svg' }, { id: 't5', t: 'Slow Drive', a: '音乐人 5', d: 215 }], i: 0, mode: 'list', at: 1 })));
      const r0 = reqs.length;
      await pg2.evaluate(() => ChatterMusic.restore()); await pg2.waitForTimeout(300);
      const mm = await pg2.evaluate(() => { const m = document.getElementById('mu-mini'), a = document.getElementById('mu-audio'); return { on: m && m.classList.contains('on'), txt: m && m.textContent, paused: a.paused, src: a.getAttribute('src') }; });
      ok(mm.on && /雨天/.test(mm.txt) && mm.paused && !mm.src && reqs.slice(r0).every(r => !/stream/.test(r)), '重开 App：底部恢复上次的歌（不自动播放、先不连 Audius 不花流量）→ ' + JSON.stringify(mm));
      await pg2.click('#mu-mini [data-act="mini-pp"]');
      await pg2.waitForFunction(() => { const a = document.getElementById('mu-audio'); return !a.paused && a.currentTime >= 0.9; }, null, { timeout: 6000 }).catch(() => {});
      const at = await pg2.evaluate(() => document.getElementById('mu-audio').currentTime);
      ok(at >= 0.9, '点播放：从上次听到的地方接着放 → ' + at.toFixed(2) + ' 秒');
      await pg2.evaluate(() => ChatterMusic.open()); await pg2.waitForSelector('.mu-v.on[data-v="home"]');
      await pg2.fill('.mu-v.on input[type="search"]', '甲的秘密歌名'); await pg2.press('.mu-v.on input[type="search"]', 'Enter'); await pg2.waitForTimeout(300);
      await pg2.evaluate(() => ChatterMusic.resetAccount());
      const rs = await pg2.evaluate(() => ({ mini: !!document.getElementById('mu-mini'), paused: document.getElementById('mu-audio').paused }));
      ok(!rs.mini && rs.paused, '换账号 / 退出登录：音乐停掉，迷你条收起');
      await pg2.evaluate(() => { window.__uid = 'u2'; ChatterMusic.open(); }); await pg2.waitForSelector('.mu-v.on[data-v="home"]');
      ok(await pg2.$eval('.mu-v.on input[type="search"]', e => e.value === '') && !(await pg2.evaluate(() => document.body.textContent.includes('甲的秘密歌名'))), '【GPT 挑的①】换账号以后打开音乐：搜索框和页面里没有上一个人搜的词');
      await pg2.evaluate(() => { ChatterMusic.closeNow(); window.__uid = 'u1'; });
      // 小屏
      await pg2.setViewportSize({ width: 320, height: 640 });
      await pg2.evaluate(() => { localStorage.setItem('ch2muNow:u1', JSON.stringify({ q: [{ id: 't6', t: '一个很长很长很长很长很长很长很长的歌名，看会不会把页面撑宽', a: '一个名字也很长很长很长的音乐人', d: 999 }], i: 0, mode: 'list', at: 0 })); ChatterMusic._m.restored = false; ChatterMusic.restore(); ChatterMusic.open('now'); });
      await pg2.waitForTimeout(300);
      const wide = await pg2.evaluate(() => { const bad = []; document.querySelectorAll('.mu-v.on *, #mu-mini *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && r.right > innerWidth + 1) bad.push(e.className || e.tagName); }); return bad.slice(0, 5); });
      ok(!wide.length, '320 宽的小屏：正在播放页、迷你条都不横着溢出 → ' + JSON.stringify(wide));
      await pg2.close();
    }
    ok(!errs.length, theme + '：没有报错 ' + errs.join(' | '));
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
