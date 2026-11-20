// 导航（11-21 重写版）在真 Chromium 里的检查 + 截图。天地图、Esri、Photon、路线服务全是假的（不联网），定位用 Chromium 的模拟定位。
// 用法：cd tests && node navigation-ui.cjs [截图目录]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'nav-shots-'));
const zlib = require('zlib');
const PNG = (() => {   // 一块 256×256 的浅灰色图块（假的地图）
  const W = 256, raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3, line = x % 64 === 0 || y % 64 === 0; raw[o] = line ? 214 : 232; raw[o + 1] = line ? 218 : 236; raw[o + 2] = line ? 222 : 239; } }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
const KEY = '0123456789abcdef0123456789abcdef';
const T = (L) => ({ url: `https://t{s}.tianditu.gov.cn/${L}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${L}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${KEY}`, subdomains: '01234567', maxNativeZoom: 18, credit: '天地图', creditUrl: 'https://www.tianditu.gov.cn/' });
const SVC = { tiles: [T('vec'), T('cva')], sat: [T('img'), T('cia')], tdt: KEY };
// 测试路线：从 A 往北 300 米到 B，右转往东 300 米到 C
const A = [39.9000, 116.4000], B = [39.9027, 116.4000], C = [39.9027, 116.4035];
const ROUTE = (from) => ({ code: 'Ok', routes: [{ distance: 600, duration: 120, geometry: { coordinates: [[from[1], from[0]], [B[1], B[0]], [C[1], C[0]]] }, legs: [{ steps: [
  { distance: 300, duration: 60, name: '测试北路', maneuver: { type: 'depart', location: [from[1], from[0]] } },
  { distance: 300, duration: 60, name: '测试东路', maneuver: { type: 'turn', modifier: 'right', location: [B[1], B[0]] } },
  { distance: 0, duration: 0, name: '测试东路', maneuver: { type: 'arrive', location: [C[1], C[0]] } }] }] }] });

const parent = (opts) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>
window.__rpc = []; window.__sent = []; window.__remember = []; window.__notify = []; window.__open = [];
window.open = function (u) { window.__open.push(String(u)); return null; };
const O = ${JSON.stringify(opts)};
let TR = null;   // 假的同行（服务器那边的状态）
const now = () => Date.now();
const pub = () => TR && Object.assign({}, TR, { serverTime: now(), peerFix: TR.active ? TR.peerFix : null });
window.__peerAccept = () => { TR.active = true; TR.expires = new Date(now() + 1800000).toISOString(); TR.canExtend = true; };
window.__peerFix = (lat, lon) => { TR.peerFix = { lat, lon, accuracy: 10, time: now() }; };
window.__peerInvite = (dest) => { TR = { id: '11111111-2222-4333-8444-555555555555', inviter: 'bob', active: false, destination: dest, expires: new Date(now() + 1800000).toISOString(), canExtend: false }; };
window.getChatterNavigation = function () {
  return { peer: O.peer || null, peerLabel: O.peer ? '小明' : null, me: 'me', uid: 'u1', fromApps: !O.peer, invitation: O.invitation || null, font: '', appearance: O.dark ? 'dark' : 'light',
    theme: { '--accent': '#07c160' },
    close() { window.__closed = 1; },
    async getServices() { if (O.svcDelay) await new Promise((r) => setTimeout(r, O.svcDelay)); return O.svc; },
    remember(v) { window.__remember.push(v ? v.id : null); },
    beforeSound() { return !window.__inCall; },
    notify(id) { window.__notify.push(id); },
    sendPlace(p) { window.__sent.push(p); },
    async rpc(op, id, v) {
      window.__rpc.push([op, id, v]);
      if (op === 'read') return pub();
      if (op === 'invite') { TR = { id, inviter: 'me', active: false, destination: v, expires: new Date(now() + 1800000).toISOString(), canExtend: false }; return pub(); }
      if (!TR || TR.id !== id) return null;
      if (op === 'accept') { TR.active = true; TR.expires = new Date(now() + 1800000).toISOString(); TR.canExtend = true; }
      if (op === 'fix') TR.myFix = v;
      if (op === 'end') { TR = null; return null; }
      return pub();
    } };
};
</script><iframe id="f" allow="geolocation" src="/navigation.html?v=t${opts.hash || ''}"></iframe></body></html>`;

const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/p') { const o = JSON.parse(decodeURIComponent(u.searchParams.get('o') || '{}')); r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(parent(o)); }
  const f = path.join(ROOT, u.pathname.replace(/^\/+/, ''));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
  r.writeHead(200, { 'content-type': ct }); r.end(fs.readFileSync(f));
}).listen(8771);

let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(br, o) {
  const ctx = await br.newContext({ viewport: { width: o.w || 390, height: 844 }, deviceScaleFactor: o.shot ? 2 : 1, hasTouch: true, colorScheme: o.dark ? 'dark' : 'light', geolocation: o.geo === false ? undefined : { latitude: A[0], longitude: A[1], accuracy: 8 }, permissions: o.geo === false ? [] : ['geolocation'] });
  const log = { tiles: [], tdtSearch: 0, photon: 0, route: [], geocoder: 0, esri: 0, said: [], tdtBad: !!o.tdtBad };
  await ctx.addInitScript(() => {
    const said = [];
    window.__said = said;
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { said.push(u.text); try { window.top.__allSaid = (window.top.__allSaid || []).concat(u.text); } catch (e) {} }, cancel() {}, getVoices() { return []; } } });
  });
  await ctx.route(/tianditu\.gov\.cn\/(vec|cva|img|cia)_w/, (rt) => {
    const u = rt.request().url(); log.tiles.push(/\/(\w+)_w\//.exec(u)[1]);
    if (log.tdtBad) return rt.fulfill({ status: 403, contentType: 'application/json', body: '{"msg":"权限类型错误","resolve":"请检查您的应用类型","code":"12"}' });
    rt.fulfill({ contentType: 'image/png', body: PNG });
  });
  await ctx.route(/api\.tianditu\.gov\.cn\/v2\/search/, (rt) => {
    log.tdtSearch++;
    const post = JSON.parse(new URL(rt.request().url()).searchParams.get('postStr'));
    if (o.tdtNoCors) return rt.abort('failed');   // 不让跨域 / 连不上：手机上的 fetch 直接失败
    const H = { 'access-control-allow-origin': '*' };
    if (post.keyWord === '没有') return rt.fulfill({ contentType: 'application/json', headers: H, body: JSON.stringify({ resultType: 1, count: 0, pois: [], status: { infocode: 1000, cndesc: '服务正常' } }) });
    rt.fulfill({ contentType: 'application/json', headers: H, body: JSON.stringify({ resultType: 1, count: 2, keyWord: post.keyWord, status: { infocode: 1000, cndesc: '服务正常' },
      pois: [{ name: post.keyWord + '一号店', address: '测试东路 1 号', lonlat: C[1] + ',' + C[0], typeName: '餐饮' }, { name: post.keyWord + '二号店', address: '测试北路 9 号', lonlat: '116.4010,39.9040' }] }) });
  });
  await ctx.route(/api\.tianditu\.gov\.cn\/geocoder/, (rt) => { log.geocoder++; rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ status: '0', result: { formatted_address: '北京市东城区测试北路 5 号', addressComponent: { poi: '测试大厦', road: '测试北路' } } }) }); });
  await ctx.route(/photon\.komoot\.io/, (rt) => { log.photon++; rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: [{ geometry: { coordinates: [C[1], C[0]] }, properties: { name: '开源数据里的公园', city: '北京市', street: '测试东路' } }] }) }); });
  await ctx.route(/routing\.openstreetmap\.de/, (rt) => {
    const u = rt.request().url(); log.route.push(/routed-(\w+)/.exec(u)[1]);
    const m = /driving\/([\d.]+),([\d.]+);/.exec(u);
    rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(ROUTE([+m[2], +m[1]])) });
  });
  await ctx.route(/arcgisonline\.com/, (rt) => { log.esri++; rt.fulfill({ contentType: 'image/png', body: PNG }); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  if (o.saved) await ctx.addInitScript((v) => { try { if (location.pathname.endsWith('navigation.html') && !sessionStorage.getItem('seeded')) { localStorage.setItem('ch2navSvc', JSON.stringify(v)); sessionStorage.setItem('seeded', '1'); } } catch (e) {} }, o.saved);
  await pg.goto('http://127.0.0.1:8771/p?o=' + encodeURIComponent(JSON.stringify({ svc: o.svc === undefined ? SVC : o.svc, peer: o.peer, dark: o.dark, hash: o.hash, invitation: o.invitation, svcDelay: o.svcDelay })));
  const fr = () => pg.frame({ url: /navigation\.html/ });
  for (let i = 0; i < 50 && !(fr() && await fr().evaluate(() => !!window.__nav).catch(() => false)); i++) await sleep(100);
  return { ctx, pg, f: fr(), log, errs };
}
const geo = (s, lat, lon, acc) => s.ctx.setGeolocation({ latitude: lat, longitude: lon, accuracy: acc || 8 });
const txt = (s, sel) => s.f.$eval(sel, (e) => e.textContent).catch(() => '');
const vis = (s, sel) => s.f.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' && r.height > 0; }).catch(() => false);
const shot = async (s, name) => { await s.pg.screenshot({ path: path.join(OUT, name + '.png') }); };

(async () => {
  const br = await chromium.launch();
  try {
    /* 1. 天地图正常：街道图、卫星图、定位、搜地点、地点卡片、路线、跟着走的导航 */
    let s = await setup(br, { shot: true });
    await sleep(1200);
    ok(s.log.tiles.includes('vec') && s.log.tiles.includes('cva') && s.log.esri === 0, '天地图正常：街道图 + 中文注记两层都在加载，没有用备用图 → ' + [...new Set(s.log.tiles)].join(','));
    ok(await s.f.evaluate(() => window.__nav.kind) === 'street' && await s.f.$eval('#map', (e) => e.classList.contains('street')), '默认是街道图');
    ok(await s.f.evaluate(() => !!window.__nav.me), '一打开就定位（模拟定位在测试北路起点）');
    await shot(s, '1-首页');
    await s.f.click('#layer'); await sleep(700);
    ok(s.log.tiles.includes('img') && s.log.tiles.includes('cia') && await s.f.evaluate(() => window.__nav.kind) === 'sat', '点图层按钮：换成天地图卫星图（带中文注记）');
    await s.f.click('#layer'); await sleep(200);
    // 搜地点
    await s.f.fill('#q', '咖啡'); await s.f.press('#q', 'Enter');
    await s.f.waitForSelector('#v-list:not([hidden]) [data-res]', { timeout: 5000 }).catch(() => {});
    const rows = await s.f.$$eval('[data-res] .r-name', (a) => a.map((e) => e.textContent));
    ok(s.log.tdtSearch === 1 && rows.join('|') === '咖啡一号店|咖啡二号店' && /天地图/.test(await txt(s, '#list-note')), '搜“咖啡”：手机直接问天地图，列出 2 个结果，写着来自天地图 → ' + rows.join('|'));
    ok(/米|公里/.test(await txt(s, '[data-res] .r-dist')), '每个结果显示离我多远');
    await shot(s, '2-搜索结果');
    await s.f.click('[data-res="0"]'); await sleep(300);
    ok(await vis(s, '#v-place') && await txt(s, '#p-name') === '咖啡一号店' && /测试东路 1 号/.test(await txt(s, '#p-addr')), '点结果：地点卡片（名字、地址、离我多远）');
    ok(!(await s.f.$('#p-send')) && !(await s.f.$('#p-invite')), '从应用页打开（没有好友）：卡片上没有“发给好友”“一起去”');
    // 路线
    await s.f.click('#p-route');
    await s.f.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 5000 }).catch(() => {});
    ok(s.log.route[0] === 'car' && /2 分钟/.test(await txt(s, '#r-sum')) && /600 米/.test(await txt(s, '#r-sum')), '点“路线”：默认驾车，算出 2 分钟、600 米 → ' + (await txt(s, '#r-sum')));
    await s.f.click('[data-mode="foot"]'); await sleep(500);
    ok(s.log.route.slice(-1)[0] === 'foot' && await s.f.$eval('[data-mode="foot"]', (e) => e.classList.contains('on')), '换成步行：重新按步行算');
    await s.f.click('#r-steps-btn');
    const steps = await s.f.$$eval('#r-steps li', (a) => a.map((e) => e.textContent));
    ok(steps.length === 3 && /出发，沿测试北路/.test(steps[0]) && /右转进入测试东路/.test(steps[1]) && /到达目的地/.test(steps[2]), '路线详情：中文的每一步 → ' + steps.join(' / '));
    await s.f.click('[data-mode="car"]'); await sleep(500);
    ok(await s.f.evaluate(() => { const sv = document.querySelector('.leaflet-overlay-pane svg'), r = sv && sv.getBoundingClientRect(); return !!r && r.width > 300 && document.querySelectorAll('.leaflet-overlay-pane path').length >= 2; }), '路线在地图上画出来了（画布没有被图标的样式压小）');
    await shot(s, '3-路线');
    // 开始导航
    await s.f.click('#go'); await sleep(300);
    await sleep(400);
    const dot = await s.f.evaluate(() => { const r = document.querySelector('.me-dot').getBoundingClientRect(), g = document.getElementById('guide').getBoundingClientRect(), sh = document.getElementById('sheet').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: g.bottom, bottom: sh.top, w: innerWidth }; });
    ok(Math.abs(dot.x - dot.w / 2) < 6 && dot.y > dot.top && dot.y < dot.bottom && Math.abs(dot.y - (dot.top + dot.bottom) / 2) < 12, '开始导航：地图放大并把我放在屏幕正中（转向提示和底部卡片之间） → ' + JSON.stringify(dot));
    ok(await vis(s, '#guide') && /300 米/.test(await txt(s, '#g-dist')) && /右转进入测试东路/.test(await txt(s, '#g-text')), '开始导航：顶上写着“300 米 右转进入测试东路” → ' + (await txt(s, '#g-dist')) + ' ' + (await txt(s, '#g-text')));
    let said = await s.pg.evaluate(() => window.__allSaid || []);
    ok(/开始导航，全程600米/.test(said.join('|')) && /前方300米，右转进入测试东路/.test(said.join('|')), '语音：开始导航 + 前方 300 米右转 → ' + said.join(' | '));
    ok(/1 分钟|2 分钟/.test(await txt(s, '#n-left')) && /到达/.test(await txt(s, '#n-eta')), '底部：还剩多久、多远、几点到');
    await shot(s, '4-导航中');
    await geo(s, 39.9018, 116.4000); await sleep(700);
    ok(/100 米/.test(await txt(s, '#g-dist')), '往前走到离路口 100 米：距离跟着变 → ' + (await txt(s, '#g-dist')));
    said = await s.pg.evaluate(() => window.__allSaid || []);
    ok(/前方100米，右转进入测试东路/.test(said.join('|')), '离路口 100 米时再说一次');
    await geo(s, 39.90258, 116.4000); await sleep(700);
    said = await s.pg.evaluate(() => window.__allSaid || []);
    ok(said.slice(-1)[0] === '右转进入测试东路', '到路口：说“右转进入测试东路” → ' + said.slice(-1)[0]);
    await geo(s, 39.9027, 116.4015); await sleep(700);
    ok(/到达目的地/.test(await txt(s, '#g-text')) && /1[67]0 米/.test(await txt(s, '#g-dist')), '转过去以后：下一步是“到达目的地”，还剩 170 米 → ' + (await txt(s, '#g-dist')));
    // 走错了：连着 3 次离路线 150 米以上、超过 5 秒 → 重新算
    const n0 = s.log.route.length;
    for (let i = 0; i < 4; i++) { await geo(s, 39.9040 + i * 0.00001, 116.4015); await sleep(1800); }
    await sleep(800);
    ok(s.log.route.length === n0 + 1 && (await s.pg.evaluate(() => (window.__allSaid || []).join('|'))).includes('已重新规划路线'), '走错路：自动从现在的位置重新算路线，并说“已重新规划路线” → 多算了 ' + (s.log.route.length - n0) + ' 次');
    // 到达
    await geo(s, C[0], C[1] - 0.0001); await sleep(800);
    ok(/已到达/.test(await txt(s, '#g-dist')) && (await s.pg.evaluate(() => (window.__allSaid || []).join('|'))).includes('已到达目的地'), '走到终点：显示“已到达”，说“已到达目的地，导航结束”');
    await sleep(4300);
    ok(!(await vis(s, '#guide')) && await vis(s, '#v-place'), '到达几秒后：导航自动结束，回到地点卡片');
    ok((await s.pg.evaluate(() => window.__open)).length === 0 && !(await s.f.$('a[href*="amap"]')), '整个过程没有跳到别的软件（没有打开新窗口、没有高德链接）');
    // 中途结束
    await s.f.click('#p-route'); await s.f.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 5000 }).catch(() => {});
    await s.f.click('#go'); await sleep(200);
    await s.f.click('#n-voice');
    ok(await txt(s, '#n-voice') === '声音关', '导航中能关声音');
    await s.f.click('#n-end'); await sleep(200);
    ok(!(await vis(s, '#guide')) && await s.f.evaluate(() => !window.__nav.nav), '点“结束”：退出导航');
    // 长按地图选点 → 查地址
    await s.f.click('#v-place [data-back]'); await sleep(100);
    await s.pg.mouse.click(195, 300, { button: 'right' });
    await sleep(700);
    ok(await vis(s, '#v-place') && await txt(s, '#p-name') === '测试大厦' && /测试北路 5 号/.test(await txt(s, '#p-addr')) && s.log.geocoder === 1, '长按地图：选这个点，问天地图这里叫什么 → ' + (await txt(s, '#p-name')));
    // 最近去过
    await s.f.click('#v-place [data-back]'); await sleep(200);
    const rec = await s.f.$$eval('[data-recent] .r-name', (a) => a.map((e) => e.textContent));
    ok(rec[0] === '咖啡一号店', '首页“最近去过”记着刚导航过的地方 → ' + rec.join('|'));
    ok(await s.f.evaluate(() => Object.keys(localStorage).filter((k) => /^ch2nav(Recent|View):/.test(k)).every((k) => /:u1$/.test(k))), '最近去过、地图位置按账号分开存（退出登录时 Chatter 会删）');
    ok(!s.errs.length, '没有脚本报错 ' + s.errs.join(' / '));
    await s.ctx.close();

    /* 2. 天地图不给图（密钥类型不对）：自动换 Esri 卫星图，检查页说清原因 */
    s = await setup(br, { tdtBad: true, shot: true });
    await sleep(2500);
    ok(await s.f.evaluate(() => window.__nav.kind) === 'backup' && s.log.esri > 0, '天地图不给图：自动换成 Esri 卫星图 + 道路 + 地名，地图不会一片空白');
    ok(/天地图没有给地图/.test(await txt(s, '#banner')) && await vis(s, '#banner [data-act="check"]'), '顶上说明“天地图没有给地图，先换成了卫星图”，带“检查原因”按钮');
    ok(await s.f.$eval('#layer', (e) => e.hidden), '天地图不行时图层按钮藏起来（只有一种图）');
    await s.f.click('#banner [data-act="check"]'); await sleep(1500);
    const chk = await s.f.$$eval('#check-list li', (a) => a.map((e) => e.textContent));
    ok(/天地图街道图✗/.test(chk[0]) && /备用卫星图（Esri）✓/.test(chk[3]) && /路线.*✓/.test(chk[5]), '地图服务检查：天地图 ✗、备用图 ✓、路线 ✓ → ' + chk.join(' / '));
    ok(/VPN/.test(await txt(s, '#check-tip')) && /直连/.test(await txt(s, '#check-tip')) && /浏览器端/.test(await txt(s, '#check-tip')), '检查页说清原因：先说开着 VPN（天地图只让国内网络用，关掉或设直连），再说密钥类型');
    ok(/VPN/.test(await txt(s, '#banner')), '顶上的提示也说“开着 VPN 时会这样”');
    await s.f.click('#check-show'); await sleep(500);
    ok(/tianditu\.gov\.cn\/vec_w/.test(await s.f.$eval('#check-raw', (e) => e.src)) && await vis(s, '#check-raw-wrap'), '“看天地图返回的原文”：在页面里直接显示天地图的回答（能截图发给 AI）');
    await shot(s, '5-天地图不行时的检查');
    await s.f.click('#check-close');
    s.log.tdtBad = false;   // 关掉了 VPN：天地图又能用了
    await s.f.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(1500);
    ok(await s.f.evaluate(() => window.__nav.kind) === 'street' && /换回来/.test(await txt(s, '#banner')) && !(await s.f.$eval('#layer', (e) => e.hidden)), '关掉 VPN 以后：自动试一下天地图，通了就换回天地图（不用重开），图层按钮回来');
    await s.ctx.close();

    /* 2b. 数据库的配置来晚了（手机里存的是旧配置，没有卫星图）：先用旧的，新的到了补上卫星图，并存起来 */
    s = await setup(br, { svcDelay: 2500, saved: { tiles: SVC.tiles } });
    await sleep(800);
    ok(await s.f.$eval('#layer', (e) => e.hidden), '配置还没到：先用手机里存的（只有街道图）');
    await sleep(2600);
    ok(!(await s.f.$eval('#layer', (e) => e.hidden)) && await s.f.evaluate(() => !!JSON.parse(localStorage.getItem('ch2navSvc')).sat), '新配置晚到：补上卫星图（图层按钮出现），并存进手机，下次直接有');
    await s.ctx.close();

    /* 3. 天地图搜索不让手机直接问（没有跨域头）：换开源数据搜 */
    s = await setup(br, { tdtNoCors: true });
    await sleep(600);
    await s.f.fill('#q', '公园'); await s.f.press('#q', 'Enter'); await sleep(1500);
    ok(s.log.tdtSearch === 1 && s.log.photon === 1 && /开源数据里的公园/.test(await txt(s, '#list')) && /Photon/.test(await txt(s, '#list-note')), '天地图搜索问不通：自动换成 Photon（开源地图数据），写清来源');
    await s.f.click('#v-list [data-back]');
    await s.f.fill('#q', '公园'); await s.f.press('#q', 'Enter'); await sleep(800);
    ok(s.log.tdtSearch === 1 && s.log.photon === 2, '问不通一次以后这次打开就不再问天地图（不白等） → 天地图 ' + s.log.tdtSearch + ' 次、Photon ' + s.log.photon + ' 次');
    await s.f.fill('#q', '公园'); await s.ctx.close();

    /* 4. 没有定位权限 */
    s = await setup(br, { geo: false });
    await sleep(1500);
    ok(/没有定位权限/.test(await txt(s, '#banner')), '不给定位：说清楚要在设置里允许使用位置');
    await s.ctx.close();

    /* 5. 从私聊打开：发位置给好友、邀请一起去、对方接受、互相看到位置、结束 */
    s = await setup(br, { peer: 'bob', shot: true });
    await sleep(800);
    ok(/和小明一起导航/.test(await txt(s, '#trip-box')), '从私聊打开：首页写着怎么和小明一起导航');
    await s.f.fill('#q', '火锅'); await s.f.press('#q', 'Enter'); await sleep(800);
    await s.f.click('[data-res="0"]'); await sleep(300);
    ok(await vis(s, '#p-send') && /发给小明/.test(await txt(s, '#p-send')) && /邀请小明一起去/.test(await txt(s, '#p-invite')), '地点卡片：有“发给小明”“邀请小明一起去”');
    await s.f.click('#p-send'); await sleep(200);
    const sent = await s.pg.evaluate(() => window.__sent);
    ok(sent.length === 1 && sent[0].name === '火锅一号店' && Math.abs(sent[0].lat - C[0]) < 1e-6, '点“发给小明”：把地点（名字、坐标）发到聊天');
    await s.f.click('#p-invite'); await sleep(500);
    let rpc = await s.pg.evaluate(() => window.__rpc.filter((x) => x[0] === 'invite'));
    ok(rpc.length === 1 && rpc[0][2].name === '火锅一号店' && /已邀请小明一起去「火锅一号店」/.test(await txt(s, '#trip-box')) && (await s.pg.evaluate(() => window.__notify)).length === 1, '邀请：服务器记下会合点，聊天里发一条邀请，首页写“已邀请，等对方接受”');
    await s.pg.evaluate(() => { window.__peerAccept(); window.__peerFix(39.9010, 116.4010); });
    await s.f.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(800);
    ok(/正在和小明一起去/.test(await txt(s, '#trip-box')) && /小明离你/.test(await txt(s, '#trip-box')) && /接受了/.test(await txt(s, '#banner')), '小明接受：横幅提示，首页写“正在一起去”和小明离我多远');
    ok(await s.f.$('.peer-dot') !== null, '地图上显示小明的位置');
    rpc = await s.pg.evaluate(() => window.__rpc.filter((x) => x[0] === 'fix'));
    ok(rpc.length >= 1 && Math.abs(rpc[0][2].lat - A[0]) < 1e-4 && Number.isFinite(rpc[0][2].time), '接受以后：我的位置自动共享给服务器（带定位时间）');
    await shot(s, '6-一起导航');
    await s.f.click('[data-trip="go"]'); await s.f.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 5000 }).catch(() => {});
    ok(await vis(s, '#v-route') && /火锅一号店/.test(await txt(s, '#r-to')), '“导航去会合点”：直接算到会合点的路线');
    await s.f.click('#v-route [data-back]'); await s.f.click('#v-place [data-back]').catch(() => {}); await sleep(200);
    await s.f.click('[data-trip="end"]'); await sleep(400);
    ok((await s.pg.evaluate(() => window.__rpc.some((x) => x[0] === 'end'))) && /同行已结束/.test(await txt(s, '#banner')), '点“结束”：服务器删掉同行，提示不再共享位置');
    await s.ctx.close();

    /* 6. 好友邀请我：接受 */
    s = await setup(br, { peer: 'bob', invitation: '11111111-2222-4333-8444-555555555555' });
    await s.pg.evaluate(() => window.__peerInvite({ lat: 39.9027, lon: 116.4035, name: '东门' }));
    await s.f.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(700);
    ok(/小明邀请你一起去「东门」/.test(await txt(s, '#trip-box')) && await vis(s, '[data-trip="accept"]'), '好友邀请我：写清去哪，给“接受”“不去了”');
    await s.f.click('[data-trip="accept"]'); await sleep(500);
    ok((await s.pg.evaluate(() => window.__rpc.some((x) => x[0] === 'accept'))) && /正在和小明一起去「东门」/.test(await txt(s, '#trip-box')), '点“接受”：开始一起去');
    await s.ctx.close();

    /* 7. 聊天里点好友发来的位置：直接打开那个地点 */
    s = await setup(br, { hash: '#lat=39.902700&lon=116.403500&name=' + encodeURIComponent('老地方') + '&addr=' + encodeURIComponent('测试东路') });
    await sleep(800);
    ok(await vis(s, '#v-place') && await txt(s, '#p-name') === '老地方', '打开好友发来的位置：直接显示那个地点的卡片');
    await s.ctx.close();

    /* 8. 深色主题、小屏 */
    s = await setup(br, { dark: true, w: 320, shot: true });
    await sleep(800);
    ok(await s.f.evaluate(() => document.documentElement.hasAttribute('data-dark')), '跟着 Chatter 的深色主题');
    ok(await s.f.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById('search').getBoundingClientRect().right <= innerWidth), '320 宽小屏：不溢出');
    await shot(s, '7-深色小屏');
    await s.ctx.close();
  } finally { await br.close(); srv.close(); }
  console.log('\n截图在：' + OUT);
  console.log(bad ? '有 ' + bad + ' 项没通过' : '全部通过');
  process.exit(bad ? 1 : 0);
})();
