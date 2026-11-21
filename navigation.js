/* global L */
/* Chatter 导航（11-21 重写，11-21 晚加高德）：全屏地图、搜地点、路线、公交、路况、跟着走的导航（语音、走错自动重算、到达提醒）、和好友一起去。
   全部在 App 里完成，不跳到别的软件。
   - 地图：数据库 app_config.navigation.amap 有高德密钥（并且 on 不是 false）时用高德（官方网页地图：街道 / 卫星 / 实时路况，数据最新）；
     高德加载不出来（密钥的域名白名单不对、网络不通……）就自动用天地图（街道 / 卫星 + 中文注记），天地图也出不来再换 Esri 卫星图 + 道路 + 地名。
     “地图服务检查”里能看到每一家返回的原因。
   - 搜地点、查地址：高德 → 天地图 → Photon（开源地图数据），前一家出错就换下一家。
   - 路线：驾车 / 骑行 / 步行先问高德，不行换 routing.openstreetmap.de；公交只有高德有。
   - 坐标：程序里一律存 WGS84（手机定位、天地图、开源地图都是它）；高德是 GCJ-02，画到高德地图上、问高德、读高德结果时换算。 */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LSget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 存不下就算了 */ } };

  /* ---------- 和 Chatter 的连接（在 App 里打开时才有） ---------- */
  let bridge = null;
  try { if (parent !== window) bridge = parent.getChatterNavigation?.(window) || null; } catch { bridge = null; }
  const ME = (bridge && bridge.me) || 'local';
  const UID = (bridge && bridge.uid) || 'local';   // 手机里记的“最近去过”“地图停在哪”按账号分开，退出登录时 Chatter 会删掉
  const PEER = (bridge && bridge.peer) || null;
  const PEER_NAME = (bridge && bridge.peerLabel) || '好友';
  function applyTheme() {
    const dark = bridge && bridge.appearance ? bridge.appearance === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.toggleAttribute('data-dark', dark);
    if (bridge && bridge.theme) for (const [k, v] of Object.entries(bridge.theme)) if (v && String(v).trim()) document.documentElement.style.setProperty(k, String(v).trim());
    if (bridge && bridge.font) document.body.style.fontFamily = bridge.font;
  }
  applyTheme();
  if (bridge) {
    $('back').hidden = false;
    $('back').setAttribute('aria-label', PEER && !bridge.fromApps ? '返回聊天' : '返回应用');
    $('back').onclick = () => bridge.close();
  }

  /* ---------- 服务地址（数据库里的配置；读不到用手机里上次存的） ---------- */
  let services = {};
  const saved = LSget('ch2navSvc', null);
  let lateSvc = null;
  if (bridge && bridge.getServices) {   // 手机里有上次的配置就只等 1.2 秒；超时先用存的，晚到的新配置存起来并补上（以前一超时就作废，卫星图一直“没有配置”）
    const p = Promise.resolve().then(() => bridge.getServices(new AbortController().signal)).catch(() => null);
    const got = await Promise.race([p, new Promise((r) => setTimeout(() => r(undefined), saved ? 1200 : 4000))]);
    if (got && typeof got === 'object') { services = got; LSset('ch2navSvc', got); }
    else { if (saved && typeof saved === 'object') services = saved; if (got === undefined) lateSvc = p; }
  } else if (saved && typeof saved === 'object') services = saved;
  function httpsUrl(v) {
    if (typeof v !== 'string' || v.length > 1600) return null;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash ? u : null; } catch { return null; }
  }
  const tileOk = (t) => t && typeof t.url === 'string' && ['{z}', '{x}', '{y}'].every((p) => t.url.includes(p)) &&
    !/[{}]/.test(t.url.replace(/\{[xyzs]\}/g, '')) && !!httpsUrl(t.url.replace(/\{s\}/g, '0'));
  const layerList = (v) => { const a = (Array.isArray(v) ? v : v ? [v] : []).slice(0, 4); return a.length && a.every(tileOk) ? a : null; };
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const BACKUP = [
    { url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNativeZoom: 18, credit: 'Esri、Maxar、Earthstar Geographics', creditUrl: 'https://www.esri.com/' },
    { url: ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', maxNativeZoom: 18 },
    { url: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', maxNativeZoom: 18 }
  ];
  const SETS = {
    street: layerList(services.tiles),
    sat: layerList(services.sat),
    backup: layerList(services.fallback) || BACKUP
  };
  let TDT = typeof services.tdt === 'string' && /^[0-9a-f]{32}$/i.test(services.tdt) ? services.tdt
    : ((/[?&]tk=([0-9a-f]{32})/i.exec((SETS.street && SETS.street[0].url) || '') || [])[1] || '');
  const ROUTER = (() => { const u = httpsUrl(services.routeBase) || new URL('https://routing.openstreetmap.de/'); u.search = ''; if (!u.pathname.endsWith('/')) u.pathname += '/'; return u.href; })();
  const PHOTON = (httpsUrl(services.searchUrl) || new URL('https://photon.komoot.io/api/')).href;
  const PHOTON_REV = PHOTON.replace(/\/api\/?$/, '/reverse');

  /* ---------- 小工具 ---------- */
  const R = 6371008.8, rad = (d) => d * Math.PI / 180;
  function dist(a, b) {   // 两点距离（米）
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function fmtDist(m) {
    if (!Number.isFinite(m)) return '';
    if (m < 1000) { const r = m < 100 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10; return r + ' 米'; }
    return (m < 10000 ? (Math.round(m / 100) / 10).toFixed(1) : Math.round(m / 1000)) + ' 公里';
  }
  function sayDist(m) { return m < 1000 ? (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + '米' : (Math.round(m / 100) / 10) + '公里'; }
  function fmtTime(s) {
    if (!Number.isFinite(s)) return '';
    const m = Math.max(1, Math.round(s / 60));
    return m < 60 ? m + ' 分钟' : Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分钟' : '');
  }
  const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  async function fetchT(url, ms, init) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 9000);
    try { return await fetch(url, Object.assign({ signal: ac.signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' }, init || {})); } finally { clearTimeout(t); }
  }
  let toastTimer = 0;
  function banner(html, keep) {
    const b = $('banner');
    clearTimeout(toastTimer);
    if (!html) { b.hidden = true; b.innerHTML = ''; return; }
    b.innerHTML = html; b.hidden = false;
    if (!keep) toastTimer = setTimeout(() => { b.hidden = true; }, 3500);
  }
  const validPlace = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

  /* ---------- 坐标：手机定位、天地图、开源地图是 WGS84；高德是 GCJ-02（国家规定的加偏，差几百米）。程序里一律存 WGS84，画到高德地图上、问高德时再换算 ---------- */
  const outCN = (lat, lon) => lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
  function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3; r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3; return r; }
  function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3; r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3; return r; }
  function w2g(lat, lon) {
    if (outCN(lat, lon)) return { lat, lon };
    const A = 6378245.0, EE = 0.006693421622965943;
    let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
    const rl = lat / 180 * Math.PI; let m = Math.sin(rl); m = 1 - EE * m * m; const sm = Math.sqrt(m);
    dLat = (dLat * 180) / ((A * (1 - EE)) / (m * sm) * Math.PI); dLon = (dLon * 180) / (A / sm * Math.cos(rl) * Math.PI);
    return { lat: lat + dLat, lon: lon + dLon };
  }
  function g2w(lat, lon) {   // 反过来没有公式：猜一个、算一遍、按差值修正（和常用的开源换算库同一个办法），几次以后误差不到 1 厘米
    if (outCN(lat, lon)) return { lat, lon };
    let w = { lat, lon };
    for (let i = 0; i < 6; i++) { const g = w2g(w.lat, w.lon); w = { lat: w.lat - (g.lat - lat), lon: w.lon - (g.lon - lon) }; }
    return w;
  }
  const llOf = (x) => ({ lat: x.lat != null ? +x.lat : x.getLat(), lon: x.lng != null ? +x.lng : x.getLng() });
  // 网页墨卡托：自己算像素，地图接口只用最基本的“中心、缩放”（少依赖各家接口的细节）
  const mx = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
  const my = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };
  const ulon = (x, z) => x / (256 * 2 ** z) * 360 - 180;
  const ulat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (256 * 2 ** z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  const PIN_SVG = '<svg viewBox="0 0 30 40"><path d="M15 39s-12-12.4-12-22A12 12 0 0 1 27 17c0 9.6-12 22-12 22z"/><circle cx="15" cy="16" r="4.5" fill="#fff" stroke="none"/></svg>';
  const pinEl = (cls) => { const d = document.createElement('div'); d.className = 'pin ' + cls; d.innerHTML = PIN_SVG; return d; };
  const group = () => { const items = []; return { add: (h) => { items.push(h); return h; }, clear: () => { items.splice(0).forEach((h) => { try { h.remove(); } catch { /* 已经没了 */ } }); } }; };
  const VKEY = 'ch2navView:' + UID, view0 = (() => { const v = LSget(VKEY, null); return v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]) ? v : null; })();
  const DARK = document.documentElement.hasAttribute('data-dark');

  /* ---------- 高德（有密钥时）：官方的网页地图和服务，加载不出来就用下面的天地图 ---------- */
  const AMC = services.amap && typeof services.amap === 'object' ? services.amap : null;
  const AM = AMC && AMC.on !== false && /^[0-9a-f]{32}$/i.test(String(AMC.key || '')) ? { key: AMC.key, sec: String(AMC.sec || '') } : null;
  const AMAP_URL = (k) => 'https://webapi.amap.com/maps?v=2.0&key=' + k;
  const AMAP_PLUGINS = 'AMap.PlaceSearch,AMap.Geocoder,AMap.Driving,AMap.Walking,AMap.Riding,AMap.Transfer';
  let amapWhy = '';   // 高德加载不出来的原因（给“地图服务检查”和提示用）
  function loadAmap(ms) {
    return new Promise((res) => {
      if (!AM) { res(null); return; }
      if (window.AMap && window.AMap.Map) { res(window.AMap); return; }
      window._AMapSecurityConfig = { securityJsCode: AM.sec };   // 官方要求：必须在加载高德的程序之前设好
      let done = false;
      const fin = (v, why) => { if (done) return; done = true; if (!v) amapWhy = why || amapWhy || '加载失败'; res(v); };
      const sc = document.createElement('script');
      sc.src = AMAP_URL(AM.key) + '&plugin=' + AMAP_PLUGINS;
      sc.charset = 'utf-8';
      sc.onerror = () => fin(null, '高德没给地图程序');   // 密钥不对、域名不在白名单时高德回一段文字（不是程序），会走到这里
      sc.onload = () => setTimeout(() => fin(window.AMap && window.AMap.Map ? window.AMap : null, '高德没给地图程序'), 300);
      setTimeout(() => fin(window.AMap && window.AMap.Map ? window.AMap : null, '高德太慢了'), ms);
      document.head.appendChild(sc);
    });
  }
  async function amapReason() {   // 高德回的那段文字：{"info":"INVALID_USER_DOMAIN","infocode":"10006",...}
    if (!AMC || !/^[0-9a-f]{32}$/i.test(String(AMC.key || ''))) return { ok: false, why: '数据库里没有高德密钥' };
    try {
      const r = await fetchT(AMAP_URL(AMC.key), 8000), t = await r.text();
      if (/^\s*\{/.test(t)) { let d = {}; try { d = JSON.parse(t); } catch { /* 不是文字 */ } return { ok: false, info: d.info || '', why: amapInfo(d.info, d.infocode) }; }
      return r.ok ? { ok: true } : { ok: false, why: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, why: e && e.name === 'AbortError' ? '超时' : '连不上高德' }; }
  }
  function amapInfo(info, code) {   // 高德官网“错误码描述”里的说法，翻成大白话
    const M = {
      INVALID_USER_DOMAIN: '高德说“绑定域名无效”：高德控制台里这个密钥的“域名白名单”没有 Chatter 的网址（要填 3855285335-gif.github.io）',
      INVALID_USER_KEY: '高德说“密钥不正确或过期”',
      INVALID_USER_SCODE: '高德说“安全密钥没通过”：数据库里的安全密钥和密钥对不上',
      USERKEY_PLAT_NOMATCH: '高德说“密钥和平台不符”：申请密钥时要选「Web端(JS API)」',
      USER_KEY_RECYCLED: '高德说“密钥被删除了”',
      DAILY_QUERY_OVER_LIMIT: '高德说“今天的次数用完了”（明天恢复）',
      USER_DAILY_QUERY_OVER_LIMIT: '高德说“今天的次数用完了”（明天恢复）',
      ACCESS_TOO_FREQUENT: '高德说“问得太频繁了”',
      CUQPS_HAS_EXCEEDED_THE_LIMIT: '高德说“同时问的人太多了”',
      SERVICE_NOT_AVAILABLE: '高德说“服务不可用”：这个密钥没有开这项服务',
      INSUFFICIENT_PRIVILEGES: '高德说“权限不足”'
    };
    return M[info] || ('高德返回' + (info ? '：' + String(info).slice(0, 60) : '出错') + (code ? '（' + String(code).slice(0, 10) + '）' : ''));
  }
  function amapView(A) {
    const c0 = w2g(view0 ? view0[0] : 35, view0 ? view0[1] : 105);
    const m = new A.Map('map', { zoom: view0 ? view0[2] : 4, center: [c0.lon, c0.lat], viewMode: '2D', resizeEnable: true, zooms: [3, 20], showIndoorMap: false, rotateEnable: false, pitchEnable: false, mapStyle: DARK ? 'amap://styles/dark' : 'amap://styles/normal' });
    const el = $('map'), sz = () => ({ x: el.clientWidth, y: el.clientHeight });
    const G = (lat, lon) => { const g = w2g(lat, lon); return new A.LngLat(g.lon, g.lat); };
    const ctrG = () => llOf(m.getCenter());
    const setCZ = (glat, glon, z, anim) => m.setZoomAndCenter(z, new A.LngLat(glon, glat), !anim);
    const sat = [new A.TileLayer.Satellite(), new A.TileLayer.RoadNet()];
    let satOn = false, trf = null;
    const V = {
      kind: 'amap', raw: m,
      setView: (lat, lon, z, anim) => { const g = w2g(lat, lon); setCZ(g.lat, g.lon, z, anim); },
      panTo: (lat, lon) => m.panTo(G(lat, lon)),
      zoom: () => m.getZoom(), setZoom: (z) => m.setZoom(z),
      center: () => { const c = ctrG(); return g2w(c.lat, c.lon); },
      bounds: () => { const c = ctrG(), z = m.getZoom(), s = sz(), cx = mx(c.lon, z), cy = my(c.lat, z); const sw = g2w(ulat(cy + s.y / 2, z), ulon(cx - s.x / 2, z)), ne = g2w(ulat(cy - s.y / 2, z), ulon(cx + s.x / 2, z)); return { w: sw.lon, s: sw.lat, e: ne.lon, n: ne.lat }; },
      fit: (pts, pad, maxZoom) => {   // 自己算：所有点放进“去掉上下边距”的那块
        const gs = pts.map((p) => w2g(p[0], p[1])), s = sz();
        const W = Math.max(40, s.x - pad.left - pad.right), H = Math.max(40, s.y - pad.top - pad.bottom);
        let z = Math.min(maxZoom || 17, 18);
        const ext = (zz) => { const xs = gs.map((g) => mx(g.lon, zz)), ys = gs.map((g) => my(g.lat, zz)); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
        while (z > 3) { const e = ext(z); if (e.x1 - e.x0 <= W && e.y1 - e.y0 <= H) break; z -= 0.5; }
        const e = ext(z), cx = (e.x0 + e.x1) / 2 + (pad.right - pad.left) / 2, cy = (e.y0 + e.y1) / 2 + (pad.bottom - pad.top) / 2;
        setCZ(ulat(cy, z), ulon(cx, z), z, true);
      },
      screen: (lat, lon) => { const g = w2g(lat, lon), c = ctrG(), z = m.getZoom(), s = sz(); return { x: mx(g.lon, z) - mx(c.lon, z) + s.x / 2, y: my(g.lat, z) - my(c.lat, z) + s.y / 2 }; },
      size: sz,
      panBy: (dx, dy) => { const c = ctrG(), z = m.getZoom(); setCZ(ulat(my(c.lat, z) + dy, z), ulon(mx(c.lon, z) + dx, z), z, true); },
      followAt: (lat, lon, z, dy, anim) => { const g = w2g(lat, lon); setCZ(ulat(my(g.lat, z) + dy, z), g.lon, z, anim); },
      marker: (lat, lon, node, o) => {
        const mk = new A.Marker({ position: G(lat, lon), content: node, anchor: o.center ? 'center' : 'bottom-center', zIndex: 100 + (o.z || 0) / 10, bubble: !o.onClick });
        if (o.onClick) mk.on('click', o.onClick);
        if (o.title) { try { mk.setLabel({ content: '<div class="mk-label">' + esc(o.title) + '</div>', direction: 'top' }); } catch { /* 没有标签也行 */ } }
        m.add(mk);
        return { move: (la, lo) => mk.setPosition(G(la, lo)), remove: () => m.remove(mk) };
      },
      line: (pts, o) => { const pl = new A.Polyline(Object.assign({ path: pts.map((p) => G(p[0], p[1])), strokeColor: o.color, strokeWeight: o.weight, strokeOpacity: o.opacity == null ? 1 : o.opacity, lineJoin: 'round', lineCap: 'round', zIndex: 50 + (o.z || 0), bubble: true }, o.dash ? { strokeStyle: 'dashed', strokeDasharray: [8, 8] } : {})); m.add(pl); return { remove: () => m.remove(pl) }; },
      circle: (lat, lon, r, o) => { const c = new A.Circle({ center: G(lat, lon), radius: r, strokeWeight: 0, strokeOpacity: 0, fillColor: o.color, fillOpacity: o.opacity, bubble: true, zIndex: 40 }); m.add(c); return { move: (la, lo, rr) => { c.setCenter(G(la, lo)); if (rr != null) c.setRadius(rr); }, remove: () => m.remove(c) }; },
      onDrag: (fn) => m.on('dragstart', fn),
      onMoveEnd: (fn) => m.on('moveend', fn),
      onLongPress: (fn) => longPress((x, y) => { const c = ctrG(), z = m.getZoom(), s = sz(), w = g2w(ulat(my(c.lat, z) + y - s.y / 2, z), ulon(mx(c.lon, z) + x - s.x / 2, z)); fn(w.lat, w.lon); }),
      setBase: (k) => { const want = k === 'sat'; if (want !== satOn) { satOn = want; if (want) m.add(sat); else m.remove(sat); } $('layer').hidden = false; $('layer').setAttribute('aria-label', want ? '换成街道图' : '换成卫星图'); },
      traffic: (on) => { if (on && !trf) { trf = new A.TileLayer.Traffic({ autoRefresh: true, interval: 180, zIndex: 20 }); m.add(trf); } else if (!on && trf) { m.remove(trf); trf = null; } },
      label: '高德'
    };
    return V;
  }
  function longPress(fn) {   // 长按地图：手指按住 0.6 秒不动（各家地图都用这个，不靠地图自己的事件）
    const el = $('map'); let t = 0, sx = 0, sy = 0;
    el.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { clearTimeout(t); return; } const r = el.getBoundingClientRect(); sx = e.touches[0].clientX; sy = e.touches[0].clientY; t = setTimeout(() => fn(sx - r.left, sy - r.top), 600); }, { passive: true });
    el.addEventListener('touchmove', (e) => { const p = e.touches[0]; if (p && Math.hypot(p.clientX - sx, p.clientY - sy) > 10) clearTimeout(t); }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(t), { passive: true });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); fn(e.clientX - r.left, e.clientY - r.top); });   // 电脑上点右键
  }

  /* ---------- 天地图（没有高德、或者高德加载不出来时） ---------- */
  let sets = { street: null, sat: null, backup: null }, kind = LSget('ch2navLayer', 'street') === 'sat' ? 'sat' : 'street', shown = null, showLayers = () => {}, tryRecover = () => Promise.resolve(false);
  function leafletView() {
    const map = L.map('map', { zoomControl: false, minZoom: 3, maxZoom: 19, worldCopyJump: true });
    map.attributionControl.setPrefix(false);
    if (view0) map.setView([view0[0], view0[1]], view0[2]); else map.setView([35.0, 105.0], 4);
    function makeSet(defs, name) {
      if (!defs) return null;
      const set = { name, ok: 0, bad: 0, failed: false, firstBad: '', layers: [], url: defs[0].url, sub: typeof defs[0].subdomains === 'string' && /^[0-9a-z]{1,8}$/i.test(defs[0].subdomains) ? defs[0].subdomains : 'abc' };
      defs.forEach((t, i) => {
        const lay = L.tileLayer(t.url, {
          maxZoom: 19,
          maxNativeZoom: Math.min(19, Math.max(1, Math.round(Number(t.maxNativeZoom) || 18))),
          subdomains: typeof t.subdomains === 'string' && /^[0-9a-z]{1,8}$/i.test(t.subdomains) ? t.subdomains : 'abc',
          attribution: i === 0 && t.credit ? '© <a href="' + esc((httpsUrl(t.creditUrl) || {}).href || '#') + '" target="_blank" rel="noopener">' + esc(String(t.credit).slice(0, 80)) + '</a>' : '',
          keepBuffer: 3
        });
        if (i === 0) {   // 只看底图：注记层少一两块不算
          lay.on('tileload', () => { set.ok++; });
          lay.on('tileerror', (e) => { set.bad++; if (!set.firstBad && e && e.tile) set.firstBad = e.tile.src; if (set.bad >= 4 && set.ok === 0 && !set.failed) { set.failed = true; onSetFailed(set); } });
        }
        set.layers.push(lay);
      });
      return set;
    }
    sets = { street: makeSet(SETS.street, 'street'), sat: makeSet(SETS.sat, 'sat'), backup: makeSet(SETS.backup, 'backup') };
    function pickSet(k) {
      const s = sets[k];
      if (s && !s.failed) return s;
      const other = sets[k === 'sat' ? 'street' : 'sat'];
      if (k === 'street' && other && !other.failed && !sets.street) return other;
      return sets.backup;
    }
    showLayers = function () {
      const s = pickSet(kind);
      if (shown !== s) {
        if (shown) shown.layers.forEach((l) => map.removeLayer(l));
        shown = s;
        s.layers.forEach((l) => l.addTo(map));
        $('map').classList.toggle('street', s.name === 'street');
      }
      const tdtOk = (sets.street && !sets.street.failed) || (sets.sat && !sets.sat.failed);
      $('layer').hidden = !(sets.street && sets.sat) || !tdtOk;
      $('layer').setAttribute('aria-label', kind === 'sat' ? '换成街道图' : '换成卫星图');
    }
    function onSetFailed(set) {
      ['street', 'sat'].forEach((k) => { const o = sets[k]; if (set.name !== 'backup' && o && o !== set && o.ok === 0) o.failed = true; });   // 天地图两种图用同一个密钥：一种不给，另一种多半也不给
      if (set.name === 'backup') { banner('地图加载不出来：手机网络可能连不上地图服务器。<br><button data-act="check">检查原因</button>', true); return; }
      showLayers();
      banner('天地图没有给地图（它只认国内的网络，现在的网络它不认），先换成了卫星图。网络换回国内后会自动换回来。<br><button data-act="check">检查原因</button>', true);
    }
    tryRecover = function (manual) {   // 用的是备用图时：每 30 秒、联网、回到前台时试一块天地图，通了就换回来（比如网络刚换回国内）
      const bad = ['street', 'sat'].map((k) => sets[k]).filter((x) => x && x.failed);
      if (!bad.length) return Promise.resolve(false);
      return imgOk(tileUrlOf(bad[0], 12), 6000).then((r) => {
        if (!r.ok) return false;
        bad.forEach((x) => { x.failed = false; x.ok = 0; x.bad = 0; });
        showLayers();
        banner(manual ? '' : '天地图能用了，已经换回来');
        return true;
      });
    }
    setInterval(() => { if (!document.hidden) tryRecover(); }, 30000);
    addEventListener('online', () => tryRecover());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tryRecover(); });
    if (lateSvc) lateSvc.then((g) => {   // 晚到的配置：存起来；这次缺的（卫星图、搜地点的密钥）补上
      if (!g || typeof g !== 'object') return;
      LSset('ch2navSvc', g);
      const st = layerList(g.tiles), sa = layerList(g.sat);
      if (!sets.street && st) sets.street = makeSet(st, 'street');
      if (!sets.sat && sa) sets.sat = makeSet(sa, 'sat');
      if (!TDT && typeof g.tdt === 'string' && /^[0-9a-f]{32}$/i.test(g.tdt)) TDT = g.tdt;
      showLayers();
    });
    showLayers();


    return {
      kind: 'leaflet', raw: map,
      setView: (lat, lon, z, anim) => map.setView([lat, lon], z, { animate: !!anim }),
      panTo: (lat, lon) => map.panTo([lat, lon], { animate: true }),
      zoom: () => map.getZoom(), setZoom: (z) => map.setZoom(z),
      center: () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
      bounds: () => { const b = map.getBounds(); return { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }; },
      fit: (pts, pad, maxZoom) => map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [pad.left, pad.top], paddingBottomRight: [pad.right, pad.bottom], maxZoom }),
      screen: (lat, lon) => { const p = map.latLngToContainerPoint([lat, lon]); return { x: p.x, y: p.y }; },
      size: () => { const s = map.getSize(); return { x: s.x, y: s.y }; },
      panBy: (dx, dy) => map.panBy([dx, dy], { animate: true }),
      followAt: (lat, lon, z, dy, anim) => { const pt = map.project([lat, lon], z); map.setView(map.unproject(pt.add([0, dy]), z), z, { animate: !!anim }); },
      marker: (lat, lon, node, o) => {
        const w = o.w || 30, h = o.h || 40;
        const mk = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: node, iconSize: [w, h], iconAnchor: o.center ? [w / 2, h / 2] : [w / 2, h - 1] }), interactive: !!o.onClick, zIndexOffset: o.z || 0, keyboard: false });
        if (o.onClick) mk.on('click', o.onClick);
        if (o.title) mk.bindTooltip(o.title, { direction: 'top', offset: [0, o.center ? -h / 2 : -h + 4] });
        mk.addTo(map);
        return { move: (la, lo) => mk.setLatLng([la, lo]), remove: () => map.removeLayer(mk) };
      },
      line: (pts, o) => { const pl = L.polyline(pts, { color: o.color, weight: o.weight, opacity: o.opacity == null ? 1 : o.opacity, interactive: false, dashArray: o.dash ? '6 9' : null }).addTo(map); return { remove: () => map.removeLayer(pl) }; },
      circle: (lat, lon, r, o) => { const c = L.circle([lat, lon], { radius: r, interactive: false, stroke: false, fillColor: o.color, fillOpacity: o.opacity }).addTo(map); return { move: (la, lo, rr) => { c.setLatLng([la, lo]); if (rr != null) c.setRadius(rr); }, remove: () => map.removeLayer(c) }; },
      onDrag: (fn) => map.on('dragstart', fn),
      onMoveEnd: (fn) => map.on('moveend', fn),
      onLongPress: (fn) => map.on('contextmenu', (e) => { const w = e.latlng.wrap(); fn(w.lat, w.lng); }),
      setBase: (k) => { kind = k; showLayers(); },
      traffic: () => {},
      label: '天地图'
    };
  }
  async function amapStart(A) {   // 高德地图真的出来了（complete）才用；7 秒出不来就拆掉换天地图（这时还没画任何东西）
    let v = null;
    try { v = amapView(A); } catch (e) { amapWhy = '高德地图出错：' + String(e && e.message || e).slice(0, 60); return null; }
    const ok = await new Promise((r) => { let d = false; const f = (x) => { if (!d) { d = true; r(x); } }; try { v.raw.on('complete', () => f(true)); } catch { f(false); } setTimeout(() => f(false), 7000); });
    if (ok) return v;
    amapWhy = '高德地图 7 秒没出来';
    try { v.raw.destroy(); } catch { /* 拆不掉也要换 */ }
    const el = $('map'); el.innerHTML = ''; el.className = ''; el.removeAttribute('style');
    return null;
  }
  const AMapLib = await loadAmap(8000);
  const V = (AMapLib && await amapStart(AMapLib)) || leafletView();
  if (V.kind === 'amap') {
    $('layer').hidden = false; V.setBase(kind); $('map').classList.add('amap');
    if (lateSvc) lateSvc.then((g) => { if (g && typeof g === 'object') LSset('ch2navSvc', g); });   // 晚到的配置存起来，下次打开用
  }
  V.onMoveEnd(() => { const c = V.center(); LSset(VKEY, [+c.lat.toFixed(5), +c.lon.toFixed(5), V.zoom()]); });
  $('layer').onclick = () => { kind = kind === 'sat' ? 'street' : 'sat'; LSset('ch2navLayer', kind); V.setBase(kind); };
  // 路况（只有高德有）：记在手机里，下次打开还是开着
  let trafficOn = V.kind === 'amap' && LSget('ch2navTraffic', false) === true;
  function paintTraffic() { const b = $('traffic'); b.hidden = V.kind !== 'amap'; b.classList.toggle('on', trafficOn); b.setAttribute('aria-pressed', String(trafficOn)); b.setAttribute('aria-label', trafficOn ? '关掉实时路况' : '显示实时路况'); }
  $('traffic').onclick = () => { trafficOn = !trafficOn; LSset('ch2navTraffic', trafficOn); V.traffic(trafficOn); paintTraffic(); banner(trafficOn ? '已显示实时路况：绿色畅通，黄色缓行，红色拥堵' : '已关掉实时路况'); };
  if (trafficOn) V.traffic(true);
  paintTraffic();
  if (AM && V.kind !== 'amap') amapReason().then((r) => banner('高德地图没出来，先用天地图。' + esc(r.ok ? amapWhy || '可能是网络不好' : r.why) + '。<br><button data-act="check">检查原因</button>', true));
  const resLayer = group(), selLayer = group(), routeLayer = group(), tripLayer = group();

  /* ---------- 高德的服务：搜地点、查地址、驾车 / 骑行 / 步行、公交。出错就抛出来，由调用的地方换下一家 ---------- */
  const AS = AMapLib && AM ? AMapLib : null;
  let amDown = '';   // 高德服务整个用不了的原因（密钥不对、今天次数用完……）：记下来，这次打开不再问它
  const str = (v) => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : v && typeof v.name === 'string' ? v.name.trim() : '';   // 高德没有的字段有时给空数组
  const GL = (lat, lon) => { const g = w2g(lat, lon); return new AS.LngLat(g.lon, g.lat); };
  function WL(ll) {   // 高德的坐标（LngLat、[经, 纬]、"经,纬"）→ WGS84
    if (!ll) return null;
    let lon, lat;
    if (typeof ll.getLng === 'function') { lon = ll.getLng(); lat = ll.getLat(); }
    else if (Array.isArray(ll)) { lon = +ll[0]; lat = +ll[1]; }
    else if (typeof ll === 'string') { const m = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(ll); if (!m) return null; lon = +m[1]; lat = +m[2]; }
    else { lon = +ll.lng; lat = +ll.lat; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return g2w(lat, lon);
  }
  const pathOf = (v) => {   // 一段路的坐标：数组，或 "经,纬;经,纬"
    const a = Array.isArray(v) ? v : typeof v === 'string' ? v.split(';') : [];
    return a.map(WL).filter(Boolean).map((w) => [w.lat, w.lon]);
  };
  function amCall(make, method, args, ms) {
    return new Promise((res, rej) => {
      if (!AS) { rej(new Error('没有高德')); return; }
      if (amDown) { rej(new Error(amDown)); return; }
      let done = false;
      const fin = (st, r) => {
        if (done) return; done = true; clearTimeout(tm);
        if (st === 'complete') { res(r || {}); return; }
        if (st === 'no_data') { res(null); return; }
        const info = typeof r === 'string' ? r : (r && (r.info || r.message)) || '';
        if (/INVALID_USER|USERKEY_PLAT|USER_KEY_RECYCLED|OVER_LIMIT|INSUFFICIENT_PRIVILEGES|SERVICE_NOT_AVAILABLE/.test(info)) amDown = amapInfo(info);
        const e = new Error(info === '超时' ? '高德太慢了' : amapInfo(info)); e.amap = info; rej(e);
      };
      const tm = setTimeout(() => fin('error', '超时'), ms || 9000);
      try {
        const o = make();
        if (typeof o.on === 'function') { o.on('complete', (r) => fin('complete', r)); o.on('error', (r) => fin('error', r)); }   // 官方示例用事件，参考里写的是回调：两种都接
        o[method](...args, (st, r) => fin(st, r));
      } catch (e) { fin('error', String(e && e.message || e)); }
    });
  }
  const lastType = (t) => str(t).split(';').filter(Boolean).pop() || '';
  const uniqJoin = (a) => a.filter((x, i) => x && a.indexOf(x) === i).join('');
  function amPois(r) {
    return ((r && r.poiList && r.poiList.pois) || []).map((p) => {
      const w = WL(p.location); if (!w) return null;
      return { name: str(p.name), addr: [str(p.address), lastType(p.type)].filter(Boolean).join(' · ') || uniqJoin([str(p.pname), str(p.cityname), str(p.adname)]), lat: w.lat, lon: w.lon };
    }).filter((p) => p && p.name && validPlace(p));
  }
  async function amapSearch(q, nearby, specify) {
    const c = me && (nearby || V.zoom() < 9) ? { lat: me.lat, lon: me.lon } : V.center();
    const ps = (o) => () => new AS.PlaceSearch(Object.assign({ pageSize: 20, pageIndex: 1, extensions: 'base' }, o));
    if (nearby) return { places: amPois(await amCall(ps({}), 'searchNearBy', [q, GL(c.lat, c.lon), 3000])) };
    if (specify) return { places: amPois(await amCall(ps({ city: specify, citylimit: true }), 'search', [q])) };
    const b = V.bounds(), pad = 0.4;   // 先搜周围几十公里，和天地图一样
    const sw = GL(Math.max(-85, Math.min(b.s, c.lat - pad)), Math.min(b.w, c.lon - pad)), ne = GL(Math.min(85, Math.max(b.n, c.lat + pad)), Math.max(b.e, c.lon + pad));
    let places = amPois(await amCall(ps({}), 'searchInBounds', [q, new AS.Bounds(sw, ne)]));
    if (places.length) return { places };
    const r = await amCall(ps({}), 'search', [q]);   // 附近没有：全国找（比如在上海搜“故宫”）
    places = amPois(r);
    if (places.length) return { places };
    const cities = ((r && r.cityList) || []).map((x) => ({ name: str(x.name), addr: (str(x.count) || '') + ' 个结果', admin: str(x.adcode) || str(x.citycode) })).filter((x) => x.name && x.admin);
    return { places: [], cities };
  }
  const amCity = new Map();   // 坐标附近属于哪个城市（公交要按城市问）：约 5 公里一格记住
  async function amapRegeo(lat, lon) {
    const r = await amCall(() => new AS.Geocoder({ radius: 200, extensions: 'all' }), 'getAddress', [GL(lat, lon)]);
    const rg = r && r.regeocode; if (!rg) return null;
    const ac = rg.addressComponent || {};
    const near = (rg.pois || []).filter((x) => str(x.name) && Number(x.distance) < 60).sort((a, b) => a.distance - b.distance)[0];
    const sn = ac.streetNumber && typeof ac.streetNumber === 'object' ? str(ac.streetNumber.street) + str(ac.streetNumber.number) : str(ac.street) + str(ac.streetNumber);
    const out = { name: near ? str(near.name) : str(ac.building) || str(ac.neighborhood) || sn || str(ac.township), addr: str(rg.formattedAddress || rg.formatted_address), city: str(ac.citycode) || str(ac.city) || str(ac.province) };
    if (out.city) amCity.set(Math.round(lat * 20) + ',' + Math.round(lon * 20), out.city);
    return out;
  }
  async function cityOf(lat, lon) {
    const k = Math.round(lat * 20) + ',' + Math.round(lon * 20);
    if (amCity.has(k)) return amCity.get(k);
    const r = await amapRegeo(lat, lon);
    return (r && r.city) || '';
  }
  // 高德每一段的“动作”是这一段走完时做的；我们的每一步是“在这一步开头转弯，然后走 d 米”
  const ACT = [[/调头/, 'uturn'], [/左后方/, 'sharp left'], [/右后方/, 'sharp right'], [/左前方/, 'slight left'], [/右前方/, 'slight right'], [/左转/, 'left'], [/右转/, 'right'], [/直行/, 'straight']];
  function amSteps(list, line) {
    const st = [];
    list.forEach((x, i) => {
      const p = pathOf(x.path); if (!p.length) return;
      const prev = i > 0 ? list[i - 1] : null, act = prev ? str(prev.action) : '', asst = prev ? str(prev.assist_action || prev.assistant_action) : '';
      const road = str(x.road), fk = /靠左/.test(act) ? 'slight left' : /靠右/.test(act) ? 'slight right' : '';
      const mod = fk || ((ACT.find((a) => a[0].test(act)) || [])[1] || '');
      const type = !prev ? 'depart' : /环岛/.test(act) ? (/离开|出/.test(act) ? 'exit roundabout' : 'roundabout') : fk ? 'fork' : mod && mod !== 'straight' ? 'turn' : 'new name';
      const s = { d: +x.distance || 0, t: +x.time || 0, name: road, type, mod, loc: p[0] };
      const extra = asst && !/到达/.test(asst) ? asst : '';
      if (extra) s.txt = act && !/直行/.test(act) ? stepText(s) + '，' + extra : extra + (road ? '，沿' + road : '');
      st.push(s);
    });
    if (line.length) st.push({ d: 0, t: 0, name: '', type: 'arrive', mod: '', loc: line[line.length - 1] });
    return st;
  }
  function joinLine(parts) { const out = []; parts.forEach((p) => p.forEach((q) => { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - q[0]) > 1e-7 || Math.abs(l[1] - q[1]) > 1e-7) out.push(q); })); return out; }
  async function amapRoute(from, to, m) {
    const o = GL(from.lat, from.lon), d = GL(to.lat, to.lon);
    const r = m === 'car' ? await amCall(() => new AS.Driving({ policy: AS.DrivingPolicy ? AS.DrivingPolicy.LEAST_TIME : 0, hideMarkers: true, autoFitView: false }), 'search', [o, d, {}], 12000)
      : m === 'bike' ? await amCall(() => new AS.Riding({ policy: 0, hideMarkers: true, autoFitView: false }), 'search', [o, d], 12000)
      : await amCall(() => new AS.Walking({ hideMarkers: true, autoFitView: false }), 'search', [o, d], 12000);
    const rt = r && r.routes && r.routes[0];
    if (!rt) return null;
    const list = rt.steps || rt.rides || [];
    const line = joinLine(list.map((x) => pathOf(x.path)));
    if (line.length < 2) return null;
    return prepRoute({ dist: +rt.distance || 0, time: +rt.time || 0, line, steps: amSteps(list, line), mode: m, to, from, src: 'amap' });
  }
  const TMODE = { WALK: 'walk', BUS: 'bus', SUBWAY: 'subway', METRO_RAIL: 'subway', RAILWAY: 'rail', TAXI: 'taxi' };
  async function amapBus(from, to) {   // 公交：最多 3 个方案
    if (!AS || amDown) throw new Error(amDown || '公交要用高德，现在高德用不了');
    const city = await cityOf(from.lat, from.lon).catch(() => '');
    if (!city) throw new Error('不知道你在哪个城市，算不了公交');
    const cityd = await cityOf(to.lat, to.lon).catch(() => '');
    const r = await amCall(() => new AS.Transfer({ city, cityd: cityd || city, nightflag: true, policy: AS.TransferPolicy ? AS.TransferPolicy.LEAST_TIME : 0, extensions: 'all', hideMarkers: true, autoFitView: false }), 'search', [GL(from.lat, from.lon), GL(to.lat, to.lon)], 15000);
    return ((r && r.plans) || []).slice(0, 3).map((pl) => {
      const segs = (pl.segments || []).map((sg) => {
        const k = TMODE[str(sg.transit_mode).toUpperCase()] || 'walk', tr = sg.transit || {};
        const ln = pathOf(tr.path).length ? pathOf(tr.path) : joinLine(((tr.steps || [])).map((x) => pathOf(x.path)));
        const lines = (tr.lines || []).map((x) => str(x.name).replace(/\(.*?\)|（.*?）/g, '')).filter(Boolean);
        const on = str(tr.on_station), off = str(tr.off_station), via = +tr.via_num || 0;
        let text = str(sg.instruction);
        if (k === 'walk') text = '步行 ' + fmtDist(+sg.distance || 0);
        else if (k === 'bus' || k === 'subway') text = (on ? '在「' + on + '」上车，' : '') + '坐' + (lines[0] || (k === 'subway' ? '地铁' : '公交')) + (lines.length > 1 ? '（或' + lines.slice(1, 3).join('、') + '）' : '') + (via ? '，坐 ' + (via + 1) + ' 站' : '') + (off ? '，到「' + off + '」下车' : '');
        else if (k === 'rail') text = '坐火车' + (str(tr.name) ? '「' + str(tr.name) + '」' : '') + (str(tr.departure_stop) ? '，从' + str(tr.departure_stop) : '') + (str(tr.arrival_stop) ? '到' + str(tr.arrival_stop) : '');
        else if (k === 'taxi') text = '打车 ' + fmtDist(+sg.distance || 0);
        return { k, text: text || '继续', d: +sg.distance || 0, t: +sg.time || 0, line: ln, name: lines[0] || '' };
      }).filter((x) => x.line.length || x.d);
      const line = pathOf(pl.path).length > 1 ? pathOf(pl.path) : joinLine(segs.map((x) => x.line));
      if (line.length < 2) return null;
      const steps = segs.filter((x) => x.line.length).map((x, i) => ({ d: x.d || 0, t: x.t, name: x.name, type: i === 0 ? 'depart' : 'new name', mod: '', loc: x.line[0], txt: x.text, k: x.k }));
      steps.push({ d: 0, t: 0, name: '', type: 'arrive', mod: '', loc: line[line.length - 1] });
      const rides = segs.filter((x) => x.k !== 'walk' && x.name).map((x) => x.name);
      return prepRoute({ dist: +pl.distance || segs.reduce((n, x) => n + x.d, 0), time: +pl.time || 0, line, steps, segs, mode: 'bus', to, from, src: 'amap', cost: +pl.cost || 0, walk: +pl.walking_distance || 0, rides });
    }).filter(Boolean);
  }

  /* ---------- 底部卡片 ---------- */
  const VIEWS = ['home', 'list', 'place', 'route', 'nav'];
  let viewNow = 'home';
  const stack = [];
  function show(v, push = true) {
    if (push && viewNow !== v && viewNow !== 'nav') stack.push(viewNow);
    viewNow = v;
    VIEWS.forEach((x) => { $('v-' + x).hidden = x !== v; });
    document.body.classList.toggle('navigating', v === 'nav');
    $('guide').hidden = v !== 'nav';
    if (v === 'home') { stack.length = 0; resLayer.clear(); selLayer.clear(); results = []; $('q').value = ''; $('q-clear').hidden = true; renderHome(); }
    requestAnimationFrame(sheetSize);
  }
  function back() {
    const v = stack.pop() || 'home';
    if (viewNow === 'route') clearRoute();
    if (v === 'home' || v === 'list') { selLayer.clear(); }
    if (v === 'home') { resLayer.clear(); results = []; }
    show(v, false);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-back]'); if (t) { back(); return; }
    const a = e.target.closest('[data-act]'); if (a && a.dataset.act === 'check') { e.preventDefault(); openCheck(); }
  });
  function sheetSize() {
    const h = $('sheet').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--sheet-h', Math.round(h) + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(sheetSize).observe($('sheet'));
  addEventListener('resize', sheetSize);

  /* 首页：一起导航、附近、最近去过 */
  const CHIPS = ['美食', '咖啡', '超市', '加油站', '停车场', '地铁站', '公交站', '酒店', '医院', '药店', '银行', '厕所'];
  $('chips').innerHTML = CHIPS.map((c) => '<button data-chip="' + esc(c) + '">' + esc(c) + '</button>').join('');
  $('chips').onclick = (e) => { const b = e.target.closest('[data-chip]'); if (b) runSearch(b.dataset.chip, true); };
  const RKEY = 'ch2navRecent:' + UID;
  const recentGet = () => (LSget(RKEY, []) || []).filter(validPlace).slice(0, 8);
  function remember(p) {
    if (!validPlace(p) || p.temp) return;
    const a = recentGet().filter((x) => !(Math.abs(x.lat - p.lat) < 1e-5 && Math.abs(x.lon - p.lon) < 1e-5));
    a.unshift({ name: String(p.name || '').slice(0, 80), addr: String(p.addr || '').slice(0, 120), lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) });
    LSset(RKEY, a.slice(0, 8));
  }
  const rowHTML = (p, i, attr) => '<button class="row" ' + attr + '="' + i + '"><svg viewBox="0 0 24 24"><path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg><span class="r-main"><span class="r-name">' + esc(p.name || '地图上的点') + '</span>' +
    (p.addr ? '<span class="r-sub">' + esc(p.addr) + '</span>' : '') + '</span>' + (me ? '<span class="r-dist">' + fmtDist(dist(me, p)) + '</span>' : '') + '</button>';
  function renderHome() {
    const r = recentGet();
    $('recent').innerHTML = r.length ? '<div class="v-head"><p class="sec-t">最近去过</p><button class="bare" id="recent-clear">清除</button></div>' + r.map((p, i) => rowHTML(p, i, 'data-recent')).join('') : '<p class="note">搜地点，或者长按地图选一个点。</p>';
    $('credit-home').innerHTML = '<button class="bare" data-act="check">地图服务检查</button>';
    renderTrip();
  }
  $('recent').onclick = (e) => {
    if (e.target.id === 'recent-clear') { LSset(RKEY, []); renderHome(); return; }
    const b = e.target.closest('[data-recent]'); if (b) openPlace(recentGet()[+b.dataset.recent]);
  };

  /* ---------- 我的位置 ---------- */
  let me = null, watchId = null, firstFix = true, following = false, gpsDenied = false;
  const meEl = (() => { const d = document.createElement('div'); d.className = 'me-dot nohead'; d.innerHTML = '<i></i>'; return d; })();
  let meMarker = null, meCircle = null;
  function startGPS() {
    if (watchId != null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function stopGPS() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
  function onGpsErr(err) {
    if (err && err.code === 1) {
      gpsDenied = true; stopGPS();
      banner('没有定位权限：在手机的设置里允许 Chatter（或浏览器）使用位置，才能显示你在哪、跟着走导航。', true);
    } else if (!me) banner('暂时定位不到，到开阔的地方试试。');
  }
  function onFix(pos) {
    const c = pos.coords;
    const prev = me;
    me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, head: Number.isFinite(c.heading) && c.speed > 0.7 ? c.heading : null, speed: c.speed, t: pos.timestamp };
    if (me.head == null && prev && dist(prev, me) > 4) me.head = bearing(prev, me);   // 手机没给方向时，用这次和上次的位置算
    if (gpsDenied) { gpsDenied = false; banner(''); }
    drawMe();
    if (firstFix) {
      firstFix = false;
      if (!hasTarget()) { V.setView(me.lat, me.lon, 16); following = true; $('locate').classList.add('on'); }
      if (viewNow === 'list' && results.length) renderList();
    }
    if (nav) navTick();
    else if (following) V.panTo(me.lat, me.lon);
    tripShare();
  }
  function drawMe() {
    if (!me) return;
    if (!meMarker) { meMarker = V.marker(me.lat, me.lon, meEl, { center: true, w: 22, h: 22, z: 1000 }); meCircle = V.circle(me.lat, me.lon, Math.min(me.acc || 0, 500), { color: '#1a73e8', opacity: 0.12 }); }
    meMarker.move(me.lat, me.lon); meCircle.move(me.lat, me.lon, Math.min(me.acc || 0, 500));
    const el = meEl;
    if (el) {
      const h = nav && nav.head != null ? nav.head : me.head;
      el.classList.toggle('nohead', h == null);
      if (h != null) el.querySelector('i').style.transform = 'rotate(' + Math.round(h) + 'deg)';
    }
  }
  V.onDrag(() => { following = false; $('locate').classList.remove('on'); });
  $('locate').onclick = () => {
    if (!me) { if (gpsDenied) onGpsErr({ code: 1 }); else { banner('正在定位…'); startGPS(); } return; }
    following = true; $('locate').classList.add('on');
    if (nav) followNav(true); else V.setView(me.lat, me.lon, Math.max(V.zoom(), 16), true);
  };

  /* ---------- 搜地点 ---------- */
  let results = [], tdtDown = false, lastSrc = '';
  function tdtUrl(path, post, type) { return 'https://api.tianditu.gov.cn/' + path + '?postStr=' + encodeURIComponent(JSON.stringify(post)) + (type ? '&type=' + type : '') + '&tk=' + TDT; }
  const lonlat = (s) => { const m = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? { lon: +m[1], lat: +m[2] } : null; };
  async function tdtSearch(q, nearby, specify) {
    const c = me && (nearby || V.zoom() < 9) ? { lat: me.lat, lon: me.lon } : V.center();
    let post;
    if (nearby) post = { keyWord: q, level: 15, queryRadius: 3000, pointLonlat: c.lon.toFixed(6) + ',' + c.lat.toFixed(6), queryType: 3, start: 0, count: 20, show: 2 };
    else {
      const b = V.bounds(), pad = 0.4;   // 至少搜周围几十公里：地图放得很大时也能搜到附近城区的
      const w = Math.min(b.w, c.lon - pad), s = Math.min(b.s, c.lat - pad), e = Math.max(b.e, c.lon + pad), n = Math.max(b.n, c.lat + pad);
      post = { keyWord: q, level: 12, mapBound: [w, s, e, n].map((x) => x.toFixed(5)).join(','), queryType: 1, start: 0, count: 20, show: 2 };
      if (specify) post.specify = specify;
    }
    const r = await fetchT(tdtUrl('v2/search', post, 'query'), 9000);
    if (!r.ok) throw new Error('天地图搜索 ' + r.status);
    const d = await r.json();
    if (d && d.status && d.status.infocode != null && String(d.status.infocode) !== '1000') throw new Error(String(d.status.cndesc || '天地图搜索出错'));
    const pois = (d.pois || []).map((p) => { const ll = lonlat(p.lonlat); return ll && { name: p.name, addr: [p.address, p.typeName].filter(Boolean).join(' · ') || [p.province, p.city, p.county].filter((x, i, a) => x && a.indexOf(x) === i).join(''), lat: ll.lat, lon: ll.lon }; }).filter(validPlace);
    if (pois.length) return { places: pois };
    if (d.area) { const ll = lonlat(d.area.lonlat); if (ll) return { places: [{ name: d.area.name, addr: '行政区', lat: ll.lat, lon: ll.lon, zoom: 11 }] }; }
    const admins = (d.statistics && (d.statistics.priorityCitys || d.statistics.allAdmins)) || [];
    const cities = admins.map((a) => { const ll = lonlat(a.lonlat); return ll && { name: a.name || a.adminName, addr: (a.count || '') + ' 个结果', lat: ll.lat, lon: ll.lon, admin: a.adminCode || a.adminCodes || '' }; }).filter(validPlace);
    return { places: [], cities };
  }
  async function photonSearch(q) {
    const c = me || V.center();
    const r = await fetchT(PHOTON + '?q=' + encodeURIComponent(q) + '&limit=15&lat=' + c.lat.toFixed(5) + '&lon=' + c.lon.toFixed(5), 9000);
    if (!r.ok) throw new Error('Photon ' + r.status);
    const d = await r.json();
    return (d.features || []).map((f) => {
      const p = f.properties || {}, co = (f.geometry || {}).coordinates || [];
      const addr = [p.state, p.city, p.district, p.street, p.housenumber].filter((x, i, a) => x && a.indexOf(x) === i && x !== p.name).join('');
      return { name: p.name || p.street || q, addr, lat: +co[1], lon: +co[0] };
    }).filter(validPlace);
  }
  let searchSeq = 0;
  async function runSearch(q, nearby, specify) {
    q = String(q || '').trim(); if (!q) return;
    $('q').value = nearby ? '' : q; $('q-clear').hidden = !$('q').value;
    $('q').blur();
    const seq = ++searchSeq;
    $('list-title').textContent = nearby ? '附近的' + q : '“' + q + '”';
    $('list-note').textContent = '正在找…'; $('list').innerHTML = '';
    show('list');
    let out = { places: [] }, src = '', err = '';
    if (AS && !amDown) {
      try { out = await amapSearch(q, nearby, specify); src = '高德'; } catch (e) { err = String(e && e.message || e); }
      if (seq !== searchSeq) return;
    }
    if (!out.places.length && !(out.cities && out.cities.length) && TDT && !tdtDown) {
      try { out = await tdtSearch(q, nearby, /^\d+$/.test(String(specify || '')) && src !== '高德' ? specify : undefined); src = '天地图'; } catch (e) { if (e && (e.name === 'TypeError' || e.name === 'AbortError')) tdtDown = true; err = err || String(e && e.message || e); }
    }
    if (seq !== searchSeq) return;
    if (!out.places.length && !(out.cities && out.cities.length)) {
      try { out = { places: await photonSearch(q) }; src = 'Photon（开源地图数据）'; } catch (e) { err = err || String(e && e.message || e); }
    }
    if (seq !== searchSeq) return;
    lastSrc = src;
    results = out.places;
    if (me) results.sort((a, b) => (nearby ? dist(me, a) - dist(me, b) : 0));
    if (!results.length && out.cities && out.cities.length) {
      $('list-note').textContent = '附近没找到，这些地方有：';
      $('list').innerHTML = out.cities.map((p, i) => rowHTML(p, i, 'data-city')).join('');
      $('list').onclick = (e) => { const b = e.target.closest('[data-city]'); if (!b) return; const c = out.cities[+b.dataset.city]; if (validPlace(c)) V.setView(c.lat, c.lon, 11); runSearch(q, false, c.admin); };
      return;
    }
    $('list').onclick = onListClick;
    renderList();
    if (!results.length) $('list-note').textContent = err ? '搜不到：' + (amDown ? amDown + '；' : '') + (tdtDown ? '天地图问不通，' : '') + '网络不太好，稍后再试' : '没找到，换个说法试试';
  }
  function renderList() {
    $('list-note').textContent = results.length ? '共 ' + results.length + ' 个' + (lastSrc ? ' · 来自' + lastSrc : '') : $('list-note').textContent;
    $('list').innerHTML = results.map((p, i) => rowHTML(p, i, 'data-res')).join('');
    resLayer.clear();
    const pts = [];
    results.forEach((p, i) => { pts.push([p.lat, p.lon]); resLayer.add(V.marker(p.lat, p.lon, pinEl('res'), { onClick: () => openPlace(results[i]) })); });
    if (pts.length) fitTo(pts.concat(me ? [[me.lat, me.lon]] : []).slice(0, pts.length + (me && pts.length < 6 ? 1 : 0)), 16);
  }
  function onListClick(e) { const b = e.target.closest('[data-res]'); if (b) openPlace(results[+b.dataset.res]); }
  $('search').onsubmit = (e) => { e.preventDefault(); runSearch($('q').value, false); };
  $('q').oninput = () => { $('q-clear').hidden = !$('q').value; };
  $('q-clear').onclick = () => { $('q').value = ''; $('q-clear').hidden = true; $('q').focus(); };
  function fitTo(pts, maxZoom) {
    if (!pts.length) return;
    const top = (viewNow === 'nav' ? $('guide') : $('top')).getBoundingClientRect().bottom + 16;
    const bottom = $('sheet').getBoundingClientRect().height + 16;
    if (pts.length === 1) { V.setView(pts[0][0], pts[0][1], Math.min(maxZoom || 16, 17), true); return; }
    V.fit(pts, { top, bottom, left: 30, right: 60 }, maxZoom || 17);
  }

  /* ---------- 地点卡片 ---------- */
  let place = null;
  function hasTarget() { return !!place || !!nav || (trip && trip.destination) || viewNow !== 'home'; }
  function openPlace(p, push = true) {
    if (!validPlace(p)) return;
    place = p;
    following = false; $('locate').classList.remove('on');
    selLayer.clear();
    selLayer.add(V.marker(p.lat, p.lon, pinEl('sel'), { z: 500 }));
    $('p-name').textContent = p.name || '地图上的点';
    $('p-addr').textContent = [p.addr, me ? '离你 ' + fmtDist(dist(me, p)) : ''].filter(Boolean).join(' · ');
    const acts = ['<button class="solid" id="p-route">路线</button>'];
    if (PEER && bridge && bridge.sendPlace) acts.push('<button id="p-send">发给' + esc(PEER_NAME) + '</button>');
    if (PEER && bridge && bridge.rpc && !(trip && trip.active)) acts.push('<button id="p-invite">邀请' + esc(PEER_NAME) + '一起去</button>');
    if (PEER && trip && trip.active) acts.push('<button id="p-invite">改成在这里会合</button>');
    $('p-acts').innerHTML = acts.join('');
    show('place', push);
    V.setView(p.lat, p.lon, Math.max(V.zoom(), p.zoom || 16), true);
    setTimeout(() => { const pt = V.screen(p.lat, p.lon), H = V.size().y, sh = $('sheet').getBoundingClientRect().height; if (pt.y > H - sh - 30) V.panBy(0, pt.y - (H - sh) / 2); }, 60);
    if (!p.name && !p.temp) reverseName(p);
  }
  $('p-acts').onclick = (e) => {
    const id = e.target.closest('button') && e.target.closest('button').id;
    if (id === 'p-route') { remember(place); openRoute(place); }
    if (id === 'p-send') { try { bridge.sendPlace({ name: place.name || '地图上的点', addr: place.addr || '', lat: place.lat, lon: place.lon }); banner('已发到和' + esc(PEER_NAME) + '的聊天'); } catch (err) { banner('没发出去：' + esc(err && err.message || '请重试')); } }
    if (id === 'p-invite') { remember(place); invite(place); }
  };
  V.onLongPress((lat, lon) => {   // 长按地图（电脑上点右键）：选这个点
    if (nav) return;
    const p = { name: '', addr: '正在查地址…', lat, lon };
    openPlace(p);
  });
  async function reverseName(p) {
    let name = '', addr = '';
    if (AS && !amDown) {
      try { const r = await amapRegeo(p.lat, p.lon); if (r) { name = r.name; addr = r.addr; } } catch { /* 换下一家 */ }
    }
    if (!name && !addr && TDT && !tdtDown) {
      try {
        const r = await fetchT(tdtUrl('geocoder', { lon: +p.lon.toFixed(6), lat: +p.lat.toFixed(6), ver: 1 }, 'geocode'), 8000);
        const d = await r.json(); const res = d && d.result;
        if (res) { const ac = res.addressComponent || {}; name = ac.poi || ac.road || ''; addr = res.formatted_address || ''; }
      } catch (e) { if (e && e.name === 'TypeError') tdtDown = true; }
    }
    if (!name && !addr) {
      try {
        const r = await fetchT(PHOTON_REV + '?lat=' + p.lat.toFixed(6) + '&lon=' + p.lon.toFixed(6), 8000);
        const f = ((await r.json()).features || [])[0];
        if (f) { const q = f.properties || {}; name = q.name || q.street || ''; addr = [q.state, q.city, q.district, q.street, q.housenumber].filter((x, i, a) => x && a.indexOf(x) === i).join(''); }
      } catch { /* 查不到就叫“地图上的点” */ }
    }
    if (place !== p) return;
    p.name = name || '地图上的点'; p.addr = addr || (p.lat.toFixed(5) + ', ' + p.lon.toFixed(5));
    if (viewNow === 'place') { $('p-name').textContent = p.name; $('p-addr').textContent = [p.addr, me ? '离你 ' + fmtDist(dist(me, p)) : ''].filter(Boolean).join(' · '); }
  }

  /* ---------- 路线 ---------- */
  let mode = ['car', 'bike', 'foot', 'bus'].includes(LSget('ch2navMode', '')) ? LSget('ch2navMode', '') : 'car';
  if (mode === 'bus' && !AS) mode = 'car';
  let plan = null, routeSeq = 0, busPlans = [];
  const MODE_NAME = { car: '驾车', bike: '骑行', foot: '步行', bus: '公交' };
  $('modes').querySelector('[data-mode="bus"]').hidden = !AS;   // 公交只有高德有
  async function getRoute(from, to, m) {
    if (m === 'bus') { const ps = await amapBus(from, to); if (!ps.length) throw new Error('没找到公交路线（高德的公交只算城市里的，太近的话走路就行）'); busPlans = ps; return ps[0]; }
    if (AS && !amDown) { try { const rt = await amapRoute(from, to, m); if (rt) return rt; } catch { /* 换开源路线 */ } }
    return osmRoute(from, to, m);
  }
  async function osmRoute(from, to, m) {
    const url = ROUTER + 'routed-' + m + '/route/v1/driving/' + from.lon.toFixed(6) + ',' + from.lat.toFixed(6) + ';' + to.lon.toFixed(6) + ',' + to.lat.toFixed(6) + '?overview=full&geometries=geojson&steps=true';
    const r = await fetchT(url, 15000);
    const d = await r.json().catch(() => null);
    if (!d || d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error(d && d.code === 'NoRoute' ? '这两个地方之间找不到能走的路' : d && d.code === 'NoSegment' ? '起点或终点附近没有路' : '路线服务出错了（' + r.status + '）');
    const rt = d.routes[0];
    const line = (rt.geometry.coordinates || []).map((c) => [c[1], c[0]]);
    const steps = ((rt.legs[0] || {}).steps || []).map((s) => ({ d: s.distance, t: s.duration, name: s.name || s.ref || '', type: s.maneuver.type, mod: s.maneuver.modifier || '', exit: s.maneuver.exit, loc: [s.maneuver.location[1], s.maneuver.location[0]] }));
    return prepRoute({ dist: rt.distance, time: rt.duration, line, steps, mode: m, to, from, src: 'osm' });
  }
  function prepRoute(rt) {   // 算好每个点、每个转弯离起点多远，导航时用
    const cum = [0];
    for (let i = 1; i < rt.line.length; i++) cum.push(cum[i - 1] + dist({ lat: rt.line[i - 1][0], lon: rt.line[i - 1][1] }, { lat: rt.line[i][0], lon: rt.line[i][1] }));
    rt.cum = cum; rt.len = cum[cum.length - 1] || rt.dist || 0;
    let acc = 0; const sum = rt.steps.reduce((n, s) => n + s.d, 0) || 1, k = rt.len / sum;
    rt.steps.forEach((s) => { s.at = acc * k; acc += s.d; });
    return rt;
  }
  async function openRoute(to) {
    $('r-to').textContent = '到 ' + (to.name || '地图上的点');
    paintModes();
    show('route');
    await planRoute();
  }
  function paintModes() { $('modes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode)); }
  $('modes').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === mode) return; mode = b.dataset.mode; LSset('ch2navMode', mode); paintModes(); planRoute(); };
  async function planRoute() {
    routeLayer.clear(); plan = null;
    const to = place, seq = ++routeSeq;
    $('go').disabled = true; $('r-steps').hidden = true;
    if (!me) {
      $('r-sum').innerHTML = '<p class="note">' + (gpsDenied ? '没有定位权限，算不了从你这里出发的路线。在手机设置里允许使用位置后再试。' : '正在定位你的位置…') + '</p>';
      startGPS();
      if (!gpsDenied) { const wait = Date.now(); while (!me && Date.now() - wait < 15000 && seq === routeSeq) await new Promise((r) => setTimeout(r, 300)); }
      if (!me || seq !== routeSeq) { if (seq === routeSeq && !me) $('r-sum').innerHTML = '<p class="note">定位不到你的位置，到开阔的地方再试。</p>'; return; }
    }
    $('r-sum').innerHTML = '<p class="note">正在算' + MODE_NAME[mode] + '路线…</p>';
    busPlans = [];
    try {
      const rt = await getRoute({ lat: me.lat, lon: me.lon }, to, mode);
      if (seq !== routeSeq || viewNow !== 'route') return;
      pickPlan(rt);
      fitTo(rt.line.concat([[me.lat, me.lon]]), 17);
    } catch (e) {
      if (seq !== routeSeq) return;
      $('r-sum').innerHTML = '<p class="note">' + esc(e && e.name === 'AbortError' ? '路线服务太慢了，稍后再试' : e && e.name === 'TypeError' ? '连不上路线服务，看看网络' : (e && e.message) || '算不出路线') + '</p>' + '<div class="acts"><button id="r-retry">重试</button></div>';
      $('r-retry').onclick = planRoute;
    }
  }
  function pickPlan(rt) {   // 显示这条路线（公交有几个方案时，点哪个显示哪个）
    plan = rt;
    drawRoute(rt);
    const sum = '<div class="big">' + fmtTime(rt.time) + '<small>' + fmtDist(rt.dist) + ' · ' + clock(Date.now() + rt.time * 1000) + ' 到</small></div>';
    if (rt.mode === 'bus') {
      $('r-sum').innerHTML = (busPlans.length > 1 ? '<div class="plans">' + busPlans.map((b, i) => '<button data-plan="' + i + '" class="' + (b === rt ? 'on' : '') + '"><b>' + fmtTime(b.time) + '</b><span>' + esc(b.rides.join(' → ') || '步行') + '</span><small>' + [b.cost ? b.cost + ' 元' : '', b.walk ? '步行 ' + fmtDist(b.walk) : ''].filter(Boolean).join(' · ') + '</small></button>').join('') + '</div>' : sum) +
        '<p class="note">' + (busPlans.length > 1 ? '高德给了 ' + busPlans.length + ' 个方案，点一个看路线。' : [rt.cost ? '大约 ' + rt.cost + ' 元' : '', rt.walk ? '步行 ' + fmtDist(rt.walk) : ''].filter(Boolean).join(' · ')) + '</p>';
    } else $('r-sum').innerHTML = sum + (rt.mode === 'car' && rt.src === 'osm' ? '<p class="note">时间按不堵车算。</p>' : '');
    $('r-steps').innerHTML = stepsHTML(rt);
    $('r-credit').innerHTML = rt.src === 'amap' ? '路线：高德地图' : '路线：<a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">FOSSGIS</a>，道路数据 © OpenStreetMap 贡献者';
    $('go').disabled = false;
  }
  $('r-sum').onclick = (e) => { const b = e.target.closest('[data-plan]'); if (!b || !busPlans[+b.dataset.plan]) return; pickPlan(busPlans[+b.dataset.plan]); fitTo(plan.line.concat(me ? [[me.lat, me.lon]] : []), 17); };
  function drawRoute(rt) {
    routeLayer.clear();
    const css = getComputedStyle(document.documentElement), edge = css.getPropertyValue('--route-edge').trim() || '#0b4fae', main = css.getPropertyValue('--route').trim() || '#1a73e8';
    if (rt.segs) {   // 公交：坐车的部分实线，走路的部分虚线
      rt.segs.forEach((sg) => {
        if (sg.line.length < 2) return;
        if (sg.k === 'walk') routeLayer.add(V.line(sg.line, { color: main, weight: 5, opacity: 0.9, dash: true }));
        else { routeLayer.add(V.line(sg.line, { color: edge, weight: 9, opacity: 0.9 })); routeLayer.add(V.line(sg.line, { color: sg.k === 'subway' ? '#7b3fbf' : main, weight: 6, opacity: 1, z: 1 })); }
      });
    } else {
      routeLayer.add(V.line(rt.line, { color: edge, weight: 9, opacity: 0.9 }));
      routeLayer.add(V.line(rt.line, { color: main, weight: 6, opacity: 1, z: 1 }));
    }
    routeLayer.add(V.marker(rt.to.lat, rt.to.lon, pinEl('dest'), {}));
  }
  function clearRoute() { routeLayer.clear(); plan = null; ++routeSeq; }
  $('r-steps-btn').onclick = () => { $('r-steps').hidden = !$('r-steps').hidden; sheetSize(); };

  /* 转弯说明（中文） */
  const DIR = { left: '左转', right: '右转', 'slight left': '向左前方行驶', 'slight right': '向右前方行驶', 'sharp left': '向左后方转', 'sharp right': '向右后方转', straight: '直行', uturn: '掉头' };
  function stepText(s) {
    if (s.txt) return s.txt;
    const road = s.name ? '进入' + s.name : '', along = s.name ? '，沿' + s.name : '';
    switch (s.type) {
      case 'arrive': return '到达目的地';
      case 'depart': return '出发' + along;
      case 'roundabout': case 'rotary': return '进入环岛' + (s.exit ? '，从第' + s.exit + '个出口出' : '') + (s.name ? '，到' + s.name : '');
      case 'exit roundabout': case 'exit rotary': return '出环岛' + (road ? '，' + road : '');
      case 'merge': return '并入' + (s.name || '主路');
      case 'on ramp': return (DIR[s.mod] && s.mod !== 'straight' ? DIR[s.mod] + '，' : '') + '上匝道' + (s.name ? '，往' + s.name : '');
      case 'off ramp': return (DIR[s.mod] && s.mod !== 'straight' ? DIR[s.mod] + '，' : '') + '走出口下' + (s.name ? '，往' + s.name : '');
      case 'fork': return (/left/.test(s.mod) ? '靠左走' : /right/.test(s.mod) ? '靠右走' : '走中间') + (s.name ? '，往' + s.name : '');
      case 'end of road': return '走到路的尽头' + (DIR[s.mod] || '转弯') + (road ? '，' + road : '');
      case 'continue': case 'new name': return (s.mod && s.mod !== 'straight' && DIR[s.mod] ? DIR[s.mod] : '继续直行') + along;
      default: return (DIR[s.mod] || '继续') + (road ? (DIR[s.mod] ? road : '，' + road) : '');
    }
  }
  const IC = {
    straight: '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>',
    left: '<path d="M17 20v-7a4 4 0 0 0-4-4H6"/><path d="m10 5-4 4 4 4"/>',
    right: '<path d="M7 20v-7a4 4 0 0 1 4-4h7"/><path d="m14 5 4 4-4 4"/>',
    'slight left': '<path d="M15 20v-6L8 7"/><path d="M8 13V7h6"/>',
    'slight right': '<path d="M9 20v-6l7-7"/><path d="M10 7h6v6"/>',
    uturn: '<path d="M16 20V9a4 4 0 0 0-8 0v4"/><path d="m4 10 4 4 4-4"/>',
    arrive: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
    round: '<circle cx="12" cy="9" r="4"/><path d="M12 13v8"/>'
  };
  function stepIcon(s) {
    if (s.k && s.k !== 'walk') return '<svg viewBox="0 0 24 24">' + (s.k === 'subway' || s.k === 'rail' ? '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4"/>' : '<rect x="5" y="3" width="14" height="14" rx="2"/><path d="M5 11h14M8 21v-4M16 21v-4"/>') + '</svg>';
    const k = s.type === 'arrive' ? 'arrive' : /roundabout|rotary/.test(s.type) && !/exit/.test(s.type) ? 'round' : s.mod === 'sharp left' ? 'left' : s.mod === 'sharp right' ? 'right' : IC[s.mod] ? s.mod : 'straight';
    return '<svg viewBox="0 0 24 24">' + IC[k] + '</svg>';
  }
  function stepsHTML(rt) { return rt.steps.map((s, i) => '<li data-i="' + i + '">' + stepIcon(s) + '<span>' + esc(stepText(s)) + '</span>' + (s.d > 0 && s.type !== 'arrive' ? '<span class="d">' + fmtDist(s.d) + '</span>' : '') + '</li>').join(''); }

  /* ---------- 跟着走的导航 ---------- */
  let nav = null, voiceOn = LSget('ch2navVoice', true) !== false, wake = null;
  const SAY_AT = { car: [600, 200, 40], bike: [150, 40], foot: [80, 20], bus: [150, 30] };
  function speak(text, force) {
    if ((!voiceOn && !force) || !('speechSynthesis' in window) || !text) return;
    if (bridge && bridge.beforeSound && bridge.beforeSound() === false) return;   // 在打电话、录语音：不出声（顺便先停 Chatter 的音乐）
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = 1.05;
      const v = speechSynthesis.getVoices().find((x) => /^zh(-|_)?(CN|Hans)/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^zh/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch { /* 这台设备不会说话 */ }
  }
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      else if (!on && wake) { const w = wake; wake = null; await w.release(); }
    } catch { /* 不支持就算了：页面上有提示 */ }
  }
  function startNav(rt) {
    if (!rt) return;
    nav = { rt, seg: 0, off: 0, offSince: 0, said: new Set(), rerouting: false, lastReroute: 0, head: null, along: 0, arrived: false, started: Date.now() };
    following = true; $('locate').classList.add('on');
    $('n-list').innerHTML = stepsHTML(rt); $('n-list').hidden = true;
    $('n-voice').textContent = voiceOn ? '声音开' : '声音关'; $('n-voice').setAttribute('aria-pressed', String(voiceOn));
    show('nav');
    keepAwake(true);
    $('n-note').textContent = navigator.wakeLock ? '导航时屏幕保持常亮。锁屏或切到别的 App，导航会暂停。' : '导航时别锁屏：锁屏或切到别的 App，网页拿不到位置，导航会暂停。';
    speak('开始导航，全程' + sayDist(rt.dist) + '，大约' + fmtTime(rt.time).replace(/ /g, '') + '。', true);   // 这一下是在按钮里：手机才肯让网页说话
    const z0 = rt.mode === 'car' || rt.mode === 'bus' ? 17 : 18;
    if (me) followNav(false, z0); else V.setZoom(z0);   // 放大和移到我这里一步做完（两个动画叠在一起时后一个会被吞掉）
    navTick();
  }
  function stopNav(msg) {
    nav = null; keepAwake(false);
    try { speechSynthesis.cancel(); } catch { /* 没关系 */ }
    if (msg) banner(msg);
    drawMe();
  }
  function project(rt, p, from) {   // 我在路线上的哪儿：离路线多远、已经走了多少
    const kx = Math.cos(rad(p.lat)) * R * Math.PI / 180, ky = R * Math.PI / 180;
    const scan = (a, b) => {
      let best = { d: Infinity, seg: a, along: 0 };
      for (let i = Math.max(0, a); i < Math.min(rt.line.length - 1, b); i++) {
        const ax = (rt.line[i][1] - p.lon) * kx, ay = (rt.line[i][0] - p.lat) * ky, bx = (rt.line[i + 1][1] - p.lon) * kx, by = (rt.line[i + 1][0] - p.lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const x = ax + t * dx, y = ay + t * dy, d = Math.sqrt(x * x + y * y);
        if (d < best.d) best = { d, seg: i, along: rt.cum[i] + t * (rt.cum[i + 1] - rt.cum[i]) };
      }
      return best;
    };
    let best = scan(from - 3, from + 80);
    if (best.d > 50) { const all = scan(0, rt.line.length); if (all.d < best.d) best = all; }
    return best;
  }
  function navTick() {
    if (!nav || !me) return;
    const rt = nav.rt, pr = project(rt, me, nav.seg);
    const limit = Math.max(35, Math.min(me.acc || 30, 80) + 15);
    if (pr.d > limit) { if (!nav.off) nav.offSince = Date.now(); nav.off++; } else { nav.off = 0; nav.seg = pr.seg; if (!(pr.along < nav.along && nav.along - pr.along < 30)) nav.along = pr.along; }   // 定位抖动往回跳一点不算倒退
    if (nav.off >= 3 && Date.now() - nav.offSince > 5000 && !nav.rerouting && Date.now() - nav.lastReroute > 12000) reroute();
    const left = Math.max(0, rt.len - nav.along), toDest = dist(me, rt.to);
    const seg = rt.line[Math.min(nav.seg + 1, rt.line.length - 1)], segA = rt.line[nav.seg];
    nav.head = me.head != null ? me.head : bearing({ lat: segA[0], lon: segA[1] }, { lat: seg[0], lon: seg[1] });
    if (!nav.arrived && (left < 20 || toDest < Math.max(20, Math.min(me.acc || 20, 40)))) { arrive(); return; }
    let k = rt.steps.findIndex((s, i) => i > 0 && s.at > nav.along + 3);
    if (k < 0) k = rt.steps.length - 1;
    const s = rt.steps[k], to = Math.max(0, (k === rt.steps.length - 1 ? rt.len : s.at) - nav.along);
    $('g-ic').innerHTML = stepIcon(s);
    $('g-dist').textContent = fmtDist(to);
    $('g-text').textContent = nav.off >= 2 ? '好像走错了，正在核对…' : stepText(s);
    const remain = rt.time * (left / (rt.len || 1));
    $('n-left').textContent = fmtTime(remain) + ' · ' + fmtDist(left);
    $('n-eta').textContent = clock(Date.now() + remain * 1000) + ' 到达';
    $('n-list').querySelectorAll('li').forEach((li) => { const i = +li.dataset.i; li.classList.toggle('done', i < k); li.classList.toggle('cur', i === k); });
    const ths = SAY_AT[rt.mode] || SAY_AT.car;
    for (let j = 0; j < ths.length; j++) {
      const th = ths[j], key = k + ':' + j;
      if (to <= th && !nav.said.has(key) && (j === ths.length - 1 || to > ths[j + 1])) {
        ths.forEach((_, jj) => { if (jj < j) nav.said.add(k + ':' + jj); });
        nav.said.add(key);
        speak(j === ths.length - 1 ? stepText(s) : '前方' + sayDist(to) + '，' + stepText(s));
        break;
      }
    }
    drawMe();
    if (following) followNav(true);
  }
  function followNav(animate, zoom) {   // 我在屏幕上转向提示和底部卡片之间的正中间
    if (!me) return;
    const z = zoom || V.zoom();
    const gh = $('guide').getBoundingClientRect().height, sh = $('sheet').getBoundingClientRect().height;
    V.followAt(me.lat, me.lon, z, (sh - gh) / 2, animate);
  }
  async function reroute() {
    if (!nav || nav.rerouting) return;
    nav.rerouting = true; nav.lastReroute = Date.now();
    $('g-text').textContent = '正在重新规划路线…';
    const cur = nav;
    try {
      const rt = await getRoute({ lat: me.lat, lon: me.lon }, cur.rt.to, cur.rt.mode);
      if (nav !== cur) return;
      nav.rt = rt; nav.seg = 0; nav.along = 0; nav.off = 0; nav.said = new Set();
      drawRoute(rt);
      $('n-list').innerHTML = stepsHTML(rt);
      speak('已重新规划路线');
    } catch {
      if (nav === cur) banner('网络不好，暂时没法重新算路线，按原路线继续');
    } finally { if (nav === cur) nav.rerouting = false; }
    navTick();
  }
  function arrive() {
    nav.arrived = true;
    $('g-ic').innerHTML = stepIcon({ type: 'arrive' });
    $('g-dist').textContent = '已到达';
    $('g-text').textContent = nav.rt.to.name || '目的地';
    speak('已到达目的地，导航结束');
    const to = nav.rt.to;
    setTimeout(() => { if (nav && nav.arrived) { stopNav(''); clearRoute(); show('home', false); openPlace(to); banner('已到达' + esc(to.name || '目的地')); } }, 4000);
  }
  $('go').onclick = () => { if (plan) startNav(plan); };
  $('n-end').onclick = () => { const to = nav && nav.rt.to; stopNav('导航已结束'); clearRoute(); show('home', false); if (to) openPlace(to); };
  $('n-voice').onclick = () => { voiceOn = !voiceOn; LSset('ch2navVoice', voiceOn); $('n-voice').textContent = voiceOn ? '声音开' : '声音关'; $('n-voice').setAttribute('aria-pressed', String(voiceOn)); if (voiceOn) speak('声音已打开', true); else try { speechSynthesis.cancel(); } catch { /* 没关系 */ } };
  $('n-steps').onclick = () => { $('n-list').hidden = !$('n-list').hidden; sheetSize(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && nav) keepAwake(true); if (!document.hidden) tripPoll(); });

  /* ---------- 和好友一起去（只有从私聊打开时） ---------- */
  let trip = null, tripBusy = false, tripSeq = 0, lastShare = 0, offset = 0, peerMarker = null, tripTimer = 0;
  const serverNow = () => Date.now() + offset;
  const tripOn = !!(PEER && bridge && bridge.rpc);
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
  }
  function tripErr(e) {
    const missing = e && ['PGRST202', '42883'].includes(e.code);
    banner(missing ? '一起导航还没开通' : '一起导航：' + esc(String((e && e.message) || '网络不好，请重试').slice(0, 80)));
  }
  async function tripCall(op, id, value) {
    if (!tripOn || tripBusy) return;
    tripBusy = true; renderTrip();
    const seq = ++tripSeq;
    try {
      const v = await bridge.rpc(op, id, value);
      if (seq === tripSeq) setTrip(v || null);
      if (op === 'invite' && v) bridge.notify && bridge.notify(v.id);
    } catch (e) { tripErr(e); } finally { tripBusy = false; renderTrip(); }
  }
  async function tripPoll() {
    if (!tripOn || tripBusy || document.hidden) return;
    const seq = tripSeq;
    try { const v = await bridge.rpc('read', (trip && trip.id) || bridge.invitation || null); if (seq === tripSeq && !tripBusy) setTrip(v || null); } catch (e) { if (!trip) return; tripErr(e); }
  }
  function setTrip(v) {
    const prev = trip;
    trip = v && v.id ? v : null;
    if (trip && Number.isFinite(trip.serverTime)) offset = trip.serverTime - Date.now();
    bridge && bridge.remember && bridge.remember(trip);
    if (prev && !trip) banner('和' + esc(PEER_NAME) + '的同行已结束，位置不再共享');
    if (trip && trip.active && prev && prev.id === trip.id && !prev.active) {
      banner(esc(PEER_NAME) + '接受了，你们能互相看到位置了'); speak(PEER_NAME + '接受了一起导航');
      if (!nav) setTimeout(() => { const pts = [[trip.destination.lat, trip.destination.lon]]; if (me) pts.push([me.lat, me.lon]); if (trip.peerFix) pts.push([trip.peerFix.lat, trip.peerFix.lon]); fitTo(pts, 17); }, 50);   // 一眼看到我、对方、会合点
    }
    if (trip && prev && prev.id === trip.id && prev.destination && trip.destination && (prev.destination.lat !== trip.destination.lat || prev.destination.lon !== trip.destination.lon)) banner('会合点改成了「' + esc(trip.destination.name || '新地点') + '」');
    if (trip && trip.proposal && trip.proposal.by !== ME && !(prev && prev.proposal && prev.proposal.key === trip.proposal.key)) speak(PEER_NAME + '提议换个地方会合');
    if (trip && (!prev || prev.id !== trip.id) && trip.destination && !nav && viewNow === 'home') V.setView(trip.destination.lat, trip.destination.lon, 15, true);
    drawTrip(); renderTrip();
    if (trip && trip.active) tripShare(true);
  }
  function drawTrip() {
    tripLayer.clear(); peerMarker = null;
    if (!trip) return;
    const d = trip.destination;
    if (validPlace(d)) tripLayer.add(V.marker(d.lat, d.lon, pinEl('dest'), { z: 400, title: '会合：' + (d.name || '') }));
    const pp = trip.proposal;
    if (pp && validPlace(pp)) tripLayer.add(V.marker(pp.lat, pp.lon, pinEl('res'), { z: 300, title: '提议的会合点：' + (pp.name || '') }));
    const f = trip.peerFix;
    if (trip.active && f && validPlace(f) && serverNow() - f.time < 90000) {
      const pe = document.createElement('div'); pe.className = 'peer-dot'; pe.textContent = Array.from(PEER_NAME)[0] || '友';
      peerMarker = tripLayer.add(V.marker(f.lat, f.lon, pe, { center: true, w: 30, h: 30, z: 900 }));
    }
  }
  function renderTrip() {
    const box = $('trip-box');
    if (!tripOn) { box.hidden = true; return; }
    box.hidden = false;
    const n = esc(PEER_NAME), dn = trip && trip.destination ? '「' + esc(trip.destination.name || '会合点') + '」' : '';
    let h = '';
    if (!trip) h = '<b>和' + n + '一起导航</b><p class="note">搜一个地方（或长按地图选点），在地点卡片上点“邀请' + n + '一起去”。对方接受后，你们能互相看到位置，30 分钟后自动停止。</p>';
    else if (!trip.active && trip.inviter === ME) h = '<b>已邀请' + n + '一起去' + dn + '</b><p class="note">等对方接受。接受后互相看到位置。</p><div class="acts"><button data-trip="end">取消邀请</button></div>';
    else if (!trip.active) h = '<b>' + n + '邀请你一起去' + dn + '</b><p class="note">接受后你们能互相看到位置（30 分钟，到期自动停止）。</p><div class="acts"><button class="solid" data-trip="accept">接受</button><button data-trip="end">不去了</button></div>';
    else {
      const f = trip.peerFix, fresh = f && serverNow() - f.time < 90000;
      const mins = Math.max(0, Math.round((Date.parse(trip.expires) - serverNow()) / 60000));
      const far = fresh && me ? n + '离你 ' + fmtDist(dist(me, f)) : fresh ? n + '的位置在地图上' : n + '还没共享到位置';
      const ext = trip.renewBy && trip.renewBy !== ME ? '<button data-trip="accept_more">同意多 30 分钟</button>' : trip.renewBy === ME ? '<button disabled>已请求多 30 分钟</button>' : trip.canExtend ? '<button data-trip="offer_more">多 30 分钟</button>' : '';
      h = '<b>正在和' + n + '一起去' + dn + '</b><p class="note">' + far + (fresh ? '（' + Math.max(1, Math.round((serverNow() - f.time) / 1000)) + ' 秒前）' : '') + ' · 还剩 ' + mins + ' 分钟</p>' +
        (me ? '' : '<p class="note">你的位置还没定到，对方暂时看不到你。</p>') +
        (trip.proposal && trip.proposal.by !== ME ? '<p class="note">' + n + '提议改在「' + esc(trip.proposal.name || '新地点') + '」会合</p><div class="acts"><button class="solid" data-trip="agree">同意换</button><button data-trip="see">看看在哪</button></div>' : '') +
        (trip.proposal && trip.proposal.by === ME ? '<p class="note">你提议改在「' + esc(trip.proposal.name || '新地点') + '」会合，等' + n + '同意</p>' : '') +
        '<div class="acts"><button class="solid" data-trip="go">导航去会合点</button>' + (fresh ? '<button data-trip="peer">看' + n + '在哪</button>' : '') + ext + '<button data-trip="end" class="danger">结束</button></div>';
    }
    box.innerHTML = '<div class="trip">' + h + '</div>';
    box.querySelectorAll('button').forEach((b) => { b.disabled = b.disabled || tripBusy; });
    if (viewNow === 'nav' && trip && trip.active) { const f = trip.peerFix; $('n-note').textContent = f && me && serverNow() - f.time < 90000 ? PEER_NAME + '离你 ' + fmtDist(dist(me, f)) : '和' + PEER_NAME + '共享位置中'; }
  }
  $('trip-box').onclick = (e) => {
    const b = e.target.closest('[data-trip]'); if (!b || !trip) return;
    const a = b.dataset.trip;
    if (a === 'accept') { startGPS(); tripCall('accept', trip.id); }
    else if (a === 'end') tripCall('end', trip.id);
    else if (a === 'offer_more') tripCall('offer_more', trip.id);
    else if (a === 'accept_more') tripCall('accept_more', trip.id, { key: trip.renewKey });
    else if (a === 'agree' && trip.proposal) tripCall('agree', trip.id, { key: trip.proposal.key });
    else if (a === 'see' && trip.proposal) { following = false; V.setView(trip.proposal.lat, trip.proposal.lon, 17, true); }
    else if (a === 'peer' && trip.peerFix) { following = false; V.setView(trip.peerFix.lat, trip.peerFix.lon, 17, true); }
    else if (a === 'go' && trip.destination) { const d = trip.destination; openPlace({ name: d.name, addr: '会合点', lat: d.lat, lon: d.lon }); openRoute(place); }
  };
  function invite(p) {
    if (!tripOn) return;
    const name = String(p.name || '地图上的点').slice(0, 120);
    if (trip && trip.active) { tripCall('propose', trip.id, { lat: p.lat, lon: p.lon, name }); banner('已提议在这里会合，等' + esc(PEER_NAME) + '同意'); return; }
    if (trip && !trip.active && trip.inviter === ME) { banner('已经邀请过了，先等对方回应，或者先取消'); return; }
    startGPS();
    tripCall('invite', uuid(), { lat: p.lat, lon: p.lon, name });
    show('home', false);
  }
  async function tripShare(force) {
    if (!tripOn || !trip || !trip.active || !me || tripBusy) return;
    if (!force && Date.now() - lastShare < 5000) return;
    if (Date.now() - me.t > 60000) return;   // 太旧的定位不发
    lastShare = Date.now();
    const id = trip.id;
    try {
      const v = await bridge.rpc('fix', id, { lat: me.lat, lon: me.lon, accuracy: Math.min(100000, Math.max(0, me.acc || 50)), time: Math.round(serverNow() - (Date.now() - me.t)) });
      if (trip && trip.id === id) setTripQuiet(v);
    } catch (e) { if (e && /过期/.test(e.message || '')) return; }
  }
  function setTripQuiet(v) { if (!v) { setTrip(null); return; } trip = v; if (Number.isFinite(v.serverTime)) offset = v.serverTime - Date.now(); drawTrip(); renderTrip(); }
  if (tripOn) {
    tripTimer = setInterval(() => { tripPoll(); if (trip && Date.parse(trip.expires) <= serverNow()) setTrip(null); }, 6000);
    tripPoll();
  }

  /* ---------- 地图服务检查 ---------- */
  function tileUrlOf(set, z) {   // 我所在位置（没有就用地图中间）那一块图的地址
    if (!set) return '';
    const c = me || V.center(), x = Math.floor(mx(c.lon, z) / 256), y = Math.floor(my(c.lat, z) / 256);
    return set.url.replace(/\{s\}/g, set.sub[Math.abs(x + y) % set.sub.length]).replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{z\}/g, z);
  }
  function imgOk(url, ms) {
    return new Promise((res) => {
      if (!url) { res({ ok: false, why: '还没读到配置（重开导航再看）' }); return; }
      const im = new Image(), t0 = Date.now(), tm = setTimeout(() => { im.src = ''; res({ ok: false, why: '超时' }); }, ms || 8000);
      im.referrerPolicy = 'strict-origin-when-cross-origin';
      im.onload = () => { clearTimeout(tm); res({ ok: im.naturalWidth > 0, ms: Date.now() - t0 }); };
      im.onerror = () => { clearTimeout(tm); res({ ok: false, why: '服务器没给图片' }); };
      im.src = url;
    });
  }
  async function fetchOk(url, check) {
    const t0 = Date.now();
    try { const r = await fetchT(url, 9000); const txt = await r.text(); const ok = r.ok && check(txt); return { ok, ms: Date.now() - t0, why: ok ? '' : 'HTTP ' + r.status + ' ' + txt.slice(0, 80) }; }
    catch (e) { return { ok: false, why: e && e.name === 'AbortError' ? '超时' : '连不上，或者不允许手机直接问（跨域）' }; }
  }
  let rawUrl = '';
  async function openCheck() {
    $('check').hidden = false; $('check-raw-wrap').hidden = true; $('check-show').hidden = true;
    const list = $('check-list'), tip = $('check-tip');
    const c0 = me || { lat: 39.9087, lon: 116.3975 };
    const timed = (f) => async () => { const t0 = Date.now(); try { await f(); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 120) }; } };
    const items = [];
    if (AMC) {
      items.push(['amap', '高德地图', async () => {
        const r = await amapReason();
        if (!r.ok) return r;
        if (!AM) return { ok: true, note: '密钥能用（导航里还没打开高德）' };
        return V.kind === 'amap' ? { ok: true } : { ok: false, why: amapWhy || '这次没加载出来，重开导航再试' };
      }]);
      items.push(['amapSearch', '高德搜地点', AS ? timed(() => amCall(() => new AS.PlaceSearch({ pageSize: 1 }), 'searchNearBy', ['公园', GL(c0.lat, c0.lon), 3000])) : () => Promise.resolve({ ok: false, why: AM ? '高德没加载出来' : '导航里还没打开高德' })]);
    }
    items.push(
      ['street', '天地图街道图', () => imgOk(tileUrlOf(sets.street, 15))],
      ['sat', '天地图卫星图', () => imgOk(tileUrlOf(sets.sat, 15))],
      ['tdtSearch', '天地图搜地点', () => TDT ? fetchOk(tdtUrl('v2/search', { keyWord: '公园', level: 12, mapBound: '115.4,39.4,117.5,41.1', queryType: 1, start: 0, count: 1 }, 'query'), (t) => /"pois"|"resultType"/.test(t)) : Promise.resolve({ ok: false, why: '没有密钥' })],
      ['backup', '备用卫星图（Esri）', () => imgOk(tileUrlOf(sets.backup, 15))],
      ['photon', '开源地图搜地点（Photon）', () => fetchOk(PHOTON + '?q=park&limit=1', (t) => /features/.test(t))],
      ['osm', '路线（routing.openstreetmap.de）', () => fetchOk(ROUTER + 'routed-foot/route/v1/driving/' + c0.lon.toFixed(5) + ',' + c0.lat.toFixed(5) + ';' + (c0.lon + 0.003).toFixed(5) + ',' + (c0.lat + 0.003).toFixed(5) + '?overview=false', (t) => /"code":"Ok"/.test(t))]
    );
    if (V.kind === 'amap') items.splice(items.findIndex((x) => x[0] === 'street'), 4, items.find((x) => x[0] === 'tdtSearch'));   // 用着高德：天地图的图块没加载，不用查
    list.innerHTML = items.map(([, n]) => '<li><b>' + esc(n) + '</b><span>检查中…</span></li>').join('');
    tip.textContent = '';
    const R = {};
    await Promise.all(items.map(([k, n, f], i) => f().then((r) => { R[k] = r; list.children[i].innerHTML = '<b>' + esc(n) + '</b><span class="' + (r.ok ? 'ok">✓ ' + esc(r.note || '正常') + (r.ms ? '（' + r.ms + ' 毫秒）' : '') : 'bad">✗ ' + esc(r.why || '不行')) + '</span>'; })));
    const tips = [];
    if (R.amap && !R.amap.ok) {
      tips.push(R.amap.info === 'INVALID_USER_DOMAIN' ? '高德：在高德开放平台的控制台里找到这个密钥，把它的<b>域名白名单</b>改成 <b>3855285335-gif.github.io</b>（不要加 https:// 和后面的路径），保存后重开导航。现在先用天地图。'
        : '高德：' + esc(R.amap.why || '没加载出来') + '。现在先用天地图。');
    } else if (R.amapSearch && !R.amapSearch.ok && AS) tips.push('高德的地图正常，搜地点不行（' + esc(R.amapSearch.why || '') + '），先用天地图和开源数据搜。');
    if (V.kind !== 'amap') {
      const tdtTile = (R.street && R.street.ok) || (R.sat && R.sat.ok);
      if (tdtTile) tryRecover(true);   // 天地图又通了：马上换回来
      if (!tdtTile && ((R.backup && R.backup.ok) || (R.osm && R.osm.ok))) {
        tips.push('天地图不给图，但别的服务都通。最常见的原因是<b>手机现在的网络出口不在国内</b>：天地图只认国内的网络。换回国内的普通网络，地图会自动换回天地图。网络是国内的还这样，再看天地图密钥的“应用类型”是不是“浏览器端”、“域名白名单”是不是空的。');
        rawUrl = tileUrlOf(sets.street, 15); $('check-show').hidden = !rawUrl;
      } else if (!tdtTile && !(R.backup && R.backup.ok)) tips.push('地图服务都连不上：手机网络可能有问题，换个网络试试。');
      else if (R.tdtSearch && !R.tdtSearch.ok && !AS) tips.push('天地图的地图正常，但搜地点不让手机直接问，现在用开源地图数据搜（中文地点会少一些）。');
    }
    tip.innerHTML = tips.length ? tips.join('<br><br>') : '都正常。';
  }
  $('check-close').onclick = () => { $('check').hidden = true; $('check-raw').src = 'about:blank'; };
  $('check-again').onclick = openCheck;
  $('check-show').onclick = () => { $('check-raw-wrap').hidden = false; $('check-raw').src = rawUrl; };

  /* ---------- 打开时 ---------- */
  function openFromHash() {
    if (!location.hash) return false;
    const q = new URLSearchParams(location.hash.slice(1));
    const num = (k) => { const v = q.get(k); return v != null && /^[+-]?\d+(\.\d+)?$/.test(v.trim()) ? +v : NaN; };
    const p = { name: (q.get('name') || '').slice(0, 80), addr: (q.get('addr') || '').slice(0, 120), lat: num('lat'), lon: num('lon') };
    if (!validPlace(p)) return false;
    if (!p.name) p.name = '朋友发来的位置';
    openPlace(p);
    return true;
  }
  addEventListener('hashchange', openFromHash);
  show('home', false);
  openFromHash();
  startGPS();
  sheetSize();

  function dispose() {
    stopGPS(); clearInterval(tripTimer); keepAwake(false);
    try { speechSynthesis.cancel(); } catch { /* 没关系 */ }
    nav = null;
  }
  addEventListener('pagehide', dispose, { once: true });
  window.stopChatterNavigation = dispose;
  window.pauseChatterNavigation = () => { try { speechSynthesis.cancel(); } catch { /* 没关系 */ } };   // 来电：先别说话
  window.__nav = { map: V.raw, view: V, w2g, g2w, get nav() { return nav; }, get me() { return me; }, get trip() { return trip; }, get kind() { return V.kind === 'amap' ? 'amap' : shown && shown.name; }, get amDown() { return amDown; }, get busPlans() { return busPlans; }, get results() { return results; }, get place() { return place; }, sets, runSearch, openPlace, startNav: () => startNav(plan), get plan() { return plan; } };   // 给自动检查用
})();
