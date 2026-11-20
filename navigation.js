/* Chatter 导航（11-21 重写）：全屏地图、搜地点、路线、跟着走的导航（语音、走错自动重算、到达提醒）、和好友一起去。
   全部在 App 里完成，不跳到别的软件。
   - 地图：天地图（街道 / 卫星 + 中文注记，地址和密钥在数据库 app_config.navigation）。天地图出不来时自动换成 Esri 卫星图 + 道路 + 地名，不会一片空白，
     并且能在“地图服务检查”里看到天地图返回的原因（天地图只让国内的网络访问，服务器替不了手机检查）。
   - 搜地点：天地图搜索（手机直接问）；问不通时换成 Photon（开源地图数据）。
   - 路线：routing.openstreetmap.de（驾车 / 骑行 / 步行，开源地图数据，允许手机直接问）。
   - 坐标：手机定位、天地图、开源地图都是 WGS84（天地图的 CGCS2000 和它差不到 1 米），不用换算。 */
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

  /* ---------- 地图 ---------- */
  const map = L.map('map', { zoomControl: false, minZoom: 3, maxZoom: 19, worldCopyJump: true });
  map.attributionControl.setPrefix(false);
  const VKEY = 'ch2navView:' + UID, view0 = LSget(VKEY, null);
  if (view0 && Number.isFinite(view0[0]) && Number.isFinite(view0[1]) && Number.isFinite(view0[2])) map.setView([view0[0], view0[1]], view0[2]);
  else map.setView([35.0, 105.0], 4);
  map.on('moveend', () => { const c = map.getCenter(); LSset(VKEY, [+c.lat.toFixed(5), +c.lng.toFixed(5), map.getZoom()]); });

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
  const sets = { street: makeSet(SETS.street, 'street'), sat: makeSet(SETS.sat, 'sat'), backup: makeSet(SETS.backup, 'backup') };
  let kind = LSget('ch2navLayer', 'street') === 'sat' ? 'sat' : 'street', shown = null;
  function pickSet(k) {
    const s = sets[k];
    if (s && !s.failed) return s;
    const other = sets[k === 'sat' ? 'street' : 'sat'];
    if (k === 'street' && other && !other.failed && !sets.street) return other;
    return sets.backup;
  }
  function showLayers() {
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
    banner('天地图没有给地图（开着 VPN 时会这样：天地图只让国内网络用），先换成了卫星图。关掉 VPN 后会自动换回来。<br><button data-act="check">检查原因</button>', true);
  }
  function tryRecover(manual) {   // 用的是备用图时：每 30 秒、联网、回到前台时试一块天地图，通了就换回来（比如刚关掉 VPN）
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
  $('layer').onclick = () => { kind = kind === 'sat' ? 'street' : 'sat'; LSset('ch2navLayer', kind); showLayers(); };
  showLayers();

  const pinIcon = (cls) => L.divIcon({ className: 'pin ' + cls, iconSize: [30, 40], iconAnchor: [15, 39], html: '<svg viewBox="0 0 30 40"><path d="M15 39s-12-12.4-12-22A12 12 0 0 1 27 17c0 9.6-12 22-12 22z"/><circle cx="15" cy="16" r="4.5" fill="#fff" stroke="none"/></svg>' });
  const resLayer = L.layerGroup().addTo(map), selLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map), tripLayer = L.layerGroup().addTo(map);

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
    if (v === 'home') { stack.length = 0; resLayer.clearLayers(); selLayer.clearLayers(); results = []; $('q').value = ''; $('q-clear').hidden = true; renderHome(); }
    requestAnimationFrame(sheetSize);
  }
  function back() {
    const v = stack.pop() || 'home';
    if (viewNow === 'route') clearRoute();
    if (v === 'home' || v === 'list') { selLayer.clearLayers(); }
    if (v === 'home') { resLayer.clearLayers(); results = []; }
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
  const meIcon = L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="me-dot nohead"><i></i></div>' });
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
      if (!hasTarget()) { map.setView([me.lat, me.lon], 16); following = true; $('locate').classList.add('on'); }
      if (viewNow === 'list' && results.length) renderList();
    }
    if (nav) navTick();
    else if (following) map.panTo([me.lat, me.lon], { animate: true });
    tripShare();
  }
  function drawMe() {
    if (!me) return;
    const ll = [me.lat, me.lon];
    if (!meMarker) { meMarker = L.marker(ll, { icon: meIcon, interactive: false, zIndexOffset: 1000, keyboard: false }).addTo(map); meCircle = L.circle(ll, { radius: me.acc, interactive: false, stroke: false, fillColor: '#1a73e8', fillOpacity: 0.12 }).addTo(map); }
    meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(Math.min(me.acc || 0, 500));
    const el = meMarker.getElement() && meMarker.getElement().querySelector('.me-dot');
    if (el) {
      const h = nav && nav.head != null ? nav.head : me.head;
      el.classList.toggle('nohead', h == null);
      if (h != null) el.querySelector('i').style.transform = 'rotate(' + Math.round(h) + 'deg)';
    }
  }
  map.on('dragstart', () => { following = false; $('locate').classList.remove('on'); });
  $('locate').onclick = () => {
    if (!me) { if (gpsDenied) onGpsErr({ code: 1 }); else { banner('正在定位…'); startGPS(); } return; }
    following = true; $('locate').classList.add('on');
    if (nav) followNav(true); else map.setView([me.lat, me.lon], Math.max(map.getZoom(), 16));
  };

  /* ---------- 搜地点 ---------- */
  let results = [], tdtDown = false, lastSrc = '';
  function tdtUrl(path, post, type) { return 'https://api.tianditu.gov.cn/' + path + '?postStr=' + encodeURIComponent(JSON.stringify(post)) + (type ? '&type=' + type : '') + '&tk=' + TDT; }
  const lonlat = (s) => { const m = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? { lon: +m[1], lat: +m[2] } : null; };
  async function tdtSearch(q, nearby, specify) {
    const c = me && (nearby || map.getZoom() < 9) ? { lat: me.lat, lon: me.lon } : { lat: map.getCenter().lat, lon: map.getCenter().lng };
    let post;
    if (nearby) post = { keyWord: q, level: 15, queryRadius: 3000, pointLonlat: c.lon.toFixed(6) + ',' + c.lat.toFixed(6), queryType: 3, start: 0, count: 20, show: 2 };
    else {
      const b = map.getBounds(), pad = 0.4;   // 至少搜周围几十公里：地图放得很大时也能搜到附近城区的
      const w = Math.min(b.getWest(), c.lon - pad), s = Math.min(b.getSouth(), c.lat - pad), e = Math.max(b.getEast(), c.lon + pad), n = Math.max(b.getNorth(), c.lat + pad);
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
    const c = me || { lat: map.getCenter().lat, lon: map.getCenter().lng };
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
    if (TDT && !tdtDown) {
      try { out = await tdtSearch(q, nearby, specify); src = '天地图'; } catch (e) { if (e && (e.name === 'TypeError' || e.name === 'AbortError')) tdtDown = true; err = String(e && e.message || e); }
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
      $('list').onclick = (e) => { const b = e.target.closest('[data-city]'); if (!b) return; const c = out.cities[+b.dataset.city]; map.setView([c.lat, c.lon], 11); runSearch(q, false, c.admin); };
      return;
    }
    $('list').onclick = onListClick;
    renderList();
    if (!results.length) $('list-note').textContent = err ? '搜不到：' + (tdtDown ? '天地图问不通，' : '') + '网络不太好，稍后再试' : '没找到，换个说法试试';
  }
  function renderList() {
    $('list-note').textContent = results.length ? '共 ' + results.length + ' 个' + (lastSrc ? ' · 来自' + lastSrc : '') : $('list-note').textContent;
    $('list').innerHTML = results.map((p, i) => rowHTML(p, i, 'data-res')).join('');
    resLayer.clearLayers();
    const pts = [];
    results.forEach((p, i) => { pts.push([p.lat, p.lon]); L.marker([p.lat, p.lon], { icon: pinIcon('res') }).on('click', () => openPlace(results[i])).addTo(resLayer); });
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
    if (pts.length === 1) { map.setView(pts[0], Math.min(maxZoom || 16, 17)); return; }
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, top], paddingBottomRight: [60, bottom], maxZoom: maxZoom || 17 });
  }

  /* ---------- 地点卡片 ---------- */
  let place = null;
  function hasTarget() { return !!place || !!nav || (trip && trip.destination) || viewNow !== 'home'; }
  function openPlace(p, push = true) {
    if (!validPlace(p)) return;
    place = p;
    following = false; $('locate').classList.remove('on');
    selLayer.clearLayers();
    L.marker([p.lat, p.lon], { icon: pinIcon('sel'), zIndexOffset: 500 }).addTo(selLayer);
    $('p-name').textContent = p.name || '地图上的点';
    $('p-addr').textContent = [p.addr, me ? '离你 ' + fmtDist(dist(me, p)) : ''].filter(Boolean).join(' · ');
    const acts = ['<button class="solid" id="p-route">路线</button>'];
    if (PEER && bridge && bridge.sendPlace) acts.push('<button id="p-send">发给' + esc(PEER_NAME) + '</button>');
    if (PEER && bridge && bridge.rpc && !(trip && trip.active)) acts.push('<button id="p-invite">邀请' + esc(PEER_NAME) + '一起去</button>');
    if (PEER && trip && trip.active) acts.push('<button id="p-invite">改成在这里会合</button>');
    $('p-acts').innerHTML = acts.join('');
    show('place', push);
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), p.zoom || 16), { animate: true });
    setTimeout(() => { const pt = map.latLngToContainerPoint([p.lat, p.lon]), H = map.getSize().y, sh = $('sheet').getBoundingClientRect().height; if (pt.y > H - sh - 30) map.panBy([0, pt.y - (H - sh) / 2], { animate: true }); }, 60);
    if (!p.name && !p.temp) reverseName(p);
  }
  $('p-acts').onclick = (e) => {
    const id = e.target.closest('button') && e.target.closest('button').id;
    if (id === 'p-route') { remember(place); openRoute(place); }
    if (id === 'p-send') { try { bridge.sendPlace({ name: place.name || '地图上的点', addr: place.addr || '', lat: place.lat, lon: place.lon }); banner('已发到和' + esc(PEER_NAME) + '的聊天'); } catch (err) { banner('没发出去：' + esc(err && err.message || '请重试')); } }
    if (id === 'p-invite') { remember(place); invite(place); }
  };
  map.on('contextmenu', (e) => {   // 长按地图（电脑上点右键）：选这个点
    if (nav) return;
    const p = { name: '', addr: '正在查地址…', lat: e.latlng.lat, lon: e.latlng.wrap().lng };
    openPlace(p);
  });
  async function reverseName(p) {
    let name = '', addr = '';
    if (TDT && !tdtDown) {
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
  let mode = ['car', 'bike', 'foot'].includes(LSget('ch2navMode', '')) ? LSget('ch2navMode', '') : 'car';
  let plan = null, routeSeq = 0;
  const MODE_NAME = { car: '驾车', bike: '骑行', foot: '步行' };
  async function getRoute(from, to, m) {
    const url = ROUTER + 'routed-' + m + '/route/v1/driving/' + from.lon.toFixed(6) + ',' + from.lat.toFixed(6) + ';' + to.lon.toFixed(6) + ',' + to.lat.toFixed(6) + '?overview=full&geometries=geojson&steps=true';
    const r = await fetchT(url, 15000);
    const d = await r.json().catch(() => null);
    if (!d || d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error(d && d.code === 'NoRoute' ? '这两个地方之间找不到能走的路' : d && d.code === 'NoSegment' ? '起点或终点附近没有路' : '路线服务出错了（' + r.status + '）');
    const rt = d.routes[0];
    const line = (rt.geometry.coordinates || []).map((c) => [c[1], c[0]]);
    const steps = ((rt.legs[0] || {}).steps || []).map((s) => ({ d: s.distance, t: s.duration, name: s.name || s.ref || '', type: s.maneuver.type, mod: s.maneuver.modifier || '', exit: s.maneuver.exit, loc: [s.maneuver.location[1], s.maneuver.location[0]] }));
    return prepRoute({ dist: rt.distance, time: rt.duration, line, steps, mode: m, to, from });
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
    routeLayer.clearLayers(); plan = null;
    const to = place, seq = ++routeSeq;
    $('go').disabled = true; $('r-steps').hidden = true;
    if (!me) {
      $('r-sum').innerHTML = '<p class="note">' + (gpsDenied ? '没有定位权限，算不了从你这里出发的路线。在手机设置里允许使用位置后再试。' : '正在定位你的位置…') + '</p>';
      startGPS();
      if (!gpsDenied) { const wait = Date.now(); while (!me && Date.now() - wait < 15000 && seq === routeSeq) await new Promise((r) => setTimeout(r, 300)); }
      if (!me || seq !== routeSeq) { if (seq === routeSeq && !me) $('r-sum').innerHTML = '<p class="note">定位不到你的位置，到开阔的地方再试。</p>'; return; }
    }
    $('r-sum').innerHTML = '<p class="note">正在算' + MODE_NAME[mode] + '路线…</p>';
    try {
      const rt = await getRoute({ lat: me.lat, lon: me.lon }, to, mode);
      if (seq !== routeSeq || viewNow !== 'route') return;
      plan = rt;
      drawRoute(rt);
      $('r-sum').innerHTML = '<div class="big">' + fmtTime(rt.time) + '<small>' + fmtDist(rt.dist) + ' · ' + clock(Date.now() + rt.time * 1000) + ' 到</small></div>' +
        (mode === 'car' ? '<p class="note">时间按不堵车算。</p>' : '');
      $('r-steps').innerHTML = stepsHTML(rt);
      $('go').disabled = false;
      fitTo(rt.line.concat([[me.lat, me.lon]]), 17);
    } catch (e) {
      if (seq !== routeSeq) return;
      $('r-sum').innerHTML = '<p class="note">' + esc(e && e.name === 'AbortError' ? '路线服务太慢了，稍后再试' : e && e.name === 'TypeError' ? '连不上路线服务，看看网络' : (e && e.message) || '算不出路线') + '</p>' + '<div class="acts"><button id="r-retry">重试</button></div>';
      $('r-retry').onclick = planRoute;
    }
  }
  function drawRoute(rt) {
    routeLayer.clearLayers();
    const css = getComputedStyle(document.documentElement);
    L.polyline(rt.line, { color: css.getPropertyValue('--route-edge').trim() || '#0b4fae', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(rt.line, { color: css.getPropertyValue('--route').trim() || '#1a73e8', weight: 6, opacity: 1, interactive: false }).addTo(routeLayer);
    L.marker([rt.to.lat, rt.to.lon], { icon: pinIcon('dest'), interactive: false }).addTo(routeLayer);
  }
  function clearRoute() { routeLayer.clearLayers(); plan = null; ++routeSeq; }
  $('r-steps-btn').onclick = () => { $('r-steps').hidden = !$('r-steps').hidden; sheetSize(); };

  /* 转弯说明（中文） */
  const DIR = { left: '左转', right: '右转', 'slight left': '向左前方行驶', 'slight right': '向右前方行驶', 'sharp left': '向左后方转', 'sharp right': '向右后方转', straight: '直行', uturn: '掉头' };
  function stepText(s) {
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
    const k = s.type === 'arrive' ? 'arrive' : /roundabout|rotary/.test(s.type) && !/exit/.test(s.type) ? 'round' : s.mod === 'sharp left' ? 'left' : s.mod === 'sharp right' ? 'right' : IC[s.mod] ? s.mod : 'straight';
    return '<svg viewBox="0 0 24 24">' + IC[k] + '</svg>';
  }
  function stepsHTML(rt) { return rt.steps.map((s, i) => '<li data-i="' + i + '">' + stepIcon(s) + '<span>' + esc(stepText(s)) + '</span>' + (s.d > 0 && s.type !== 'arrive' ? '<span class="d">' + fmtDist(s.d) + '</span>' : '') + '</li>').join(''); }

  /* ---------- 跟着走的导航 ---------- */
  let nav = null, voiceOn = LSget('ch2navVoice', true) !== false, wake = null;
  const SAY_AT = { car: [600, 200, 40], bike: [150, 40], foot: [80, 20] };
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
    if (me) followNav(false, rt.mode === 'car' ? 17 : 18); else map.setZoom(rt.mode === 'car' ? 17 : 18);   // 放大和移到我这里一步做完（两个动画叠在一起时后一个会被吞掉）
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
    const z = zoom || map.getZoom(), pt = map.project([me.lat, me.lon], z);
    const gh = $('guide').getBoundingClientRect().height, sh = $('sheet').getBoundingClientRect().height;
    map.setView(map.unproject(pt.add([0, (sh - gh) / 2]), z), z, { animate });
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
    if (trip && (!prev || prev.id !== trip.id) && trip.destination && !nav && viewNow === 'home') map.setView([trip.destination.lat, trip.destination.lon], 15);
    drawTrip(); renderTrip();
    if (trip && trip.active) tripShare(true);
  }
  function drawTrip() {
    tripLayer.clearLayers(); peerMarker = null;
    if (!trip) return;
    const d = trip.destination;
    if (validPlace(d)) L.marker([d.lat, d.lon], { icon: pinIcon('dest'), zIndexOffset: 400 }).bindTooltip('会合：' + (d.name || ''), { direction: 'top', offset: [0, -36] }).addTo(tripLayer);
    const pp = trip.proposal;
    if (pp && validPlace(pp)) L.marker([pp.lat, pp.lon], { icon: pinIcon('res'), zIndexOffset: 300 }).bindTooltip('提议的会合点：' + (pp.name || ''), { direction: 'top', offset: [0, -36] }).addTo(tripLayer);
    const f = trip.peerFix;
    if (trip.active && f && validPlace(f) && serverNow() - f.time < 90000) {
      peerMarker = L.marker([f.lat, f.lon], { zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="peer-dot">' + esc(Array.from(PEER_NAME)[0] || '友') + '</div>' }) }).addTo(tripLayer);
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
    else if (a === 'see' && trip.proposal) { following = false; map.setView([trip.proposal.lat, trip.proposal.lon], 17); }
    else if (a === 'peer' && trip.peerFix) { following = false; map.setView([trip.peerFix.lat, trip.peerFix.lon], 17); }
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
    const c = me ? L.latLng(me.lat, me.lon) : map.getCenter(), p = map.project(c, z).divideBy(256).floor();
    return L.Util.template(set.url, { s: set.sub[Math.abs(p.x + p.y) % set.sub.length], x: p.x, y: p.y, z });
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
    const items = [
      ['天地图街道图', () => imgOk(tileUrlOf(sets.street, 15))],
      ['天地图卫星图', () => imgOk(tileUrlOf(sets.sat, 15))],
      ['天地图搜地点', () => TDT ? fetchOk(tdtUrl('v2/search', { keyWord: '公园', level: 12, mapBound: '115.4,39.4,117.5,41.1', queryType: 1, start: 0, count: 1 }, 'query'), (t) => /"pois"|"resultType"/.test(t)) : Promise.resolve({ ok: false, why: '没有密钥' })],
      ['备用卫星图（Esri）', () => imgOk(tileUrlOf(sets.backup, 15))],
      ['开源地图搜地点（Photon）', () => fetchOk(PHOTON + '?q=park&limit=1', (t) => /features/.test(t))],
      ['路线（routing.openstreetmap.de）', () => { const c = me || { lat: 39.9087, lon: 116.3975 }; return fetchOk(ROUTER + 'routed-foot/route/v1/driving/' + c.lon.toFixed(5) + ',' + c.lat.toFixed(5) + ';' + (c.lon + 0.003).toFixed(5) + ',' + (c.lat + 0.003).toFixed(5) + '?overview=false', (t) => /"code":"Ok"/.test(t)); }]
    ];
    list.innerHTML = items.map(([n]) => '<li><b>' + esc(n) + '</b><span>检查中…</span></li>').join('');
    tip.textContent = '';
    const res = await Promise.all(items.map(([, f], i) => f().then((r) => { const li = list.children[i]; li.innerHTML = '<b>' + esc(items[i][0]) + '</b><span class="' + (r.ok ? 'ok">✓ 正常' + (r.ms ? '（' + r.ms + ' 毫秒）' : '') : 'bad">✗ ' + esc(r.why || '不行')) + '</span>'; return r; })));
    const tdtTile = res[0].ok || res[1].ok;
    if (tdtTile) tryRecover(true);   // 天地图又通了：马上换回来
    if (!tdtTile && (res[3].ok || res[5].ok)) {
      tip.innerHTML = '天地图不给图，但别的服务都通。最常见的原因是<b>开着 VPN</b>：天地图只让国内的网络用，VPN 的出口在国外就会被拒。关掉 VPN（或者在 VPN 里设置 tianditu.gov.cn 走直连），地图会自动换回天地图。没开 VPN 还这样，再看天地图密钥的“应用类型”是不是“浏览器端”、“域名白名单”是不是空的。';
      rawUrl = tileUrlOf(sets.street, 15); $('check-show').hidden = !rawUrl;
    } else if (!tdtTile && !res[3].ok) tip.textContent = '地图服务都连不上：手机网络可能有问题，换个网络试试。';
    else if (!res[2].ok && tdtTile) tip.textContent = '天地图的地图正常，但搜地点不让手机直接问，现在用开源地图数据搜（中文地点会少一些）。';
    else tip.textContent = '都正常。';
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
  window.__nav = { map, get nav() { return nav; }, get me() { return me; }, get trip() { return trip; }, get kind() { return shown && shown.name; }, sets, runSearch, openPlace, startNav: () => startNav(plan), get plan() { return plan; } };   // 给自动检查用
})();
