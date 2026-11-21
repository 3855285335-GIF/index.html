/* 测试用的假高德（不联网）：只做导航用到的接口。返回的坐标是 GCJ-02（和真高德一样加偏），用来检查程序有没有换算。
   接口名字、回调、结果字段按高德官网参考手册（a.amap.com/jsapi/static/doc/20230922/index.html）写；骑行结果用 rides（手册没写清，两种都要能读）。
   window.__amErr = { 方法名: '错误信息' } 可以让某个接口返回错误；{ noComplete: true } 地图一直不出来。 */
(function () {
  'use strict';
  const E = window.__amErr || {};
  const log = window.__am = { calls: [], layers: [], lines: [], markers: 0, map: null, opts: null, ps: [], transfer: null, sec: (window._AMapSecurityConfig || {}).securityJsCode || '' };
  // GCJ-02（同一个公开算法；测试里用它造“高德返回的坐标”）
  function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3; r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3; return r; }
  function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3; r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3; return r; }
  function g(lat, lon) { const A = 6378245, EE = 0.006693421622965943; let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35); const rl = lat / 180 * Math.PI; let m = Math.sin(rl); m = 1 - EE * m * m; const sm = Math.sqrt(m); dLat = dLat * 180 / (A * (1 - EE) / (m * sm) * Math.PI); dLon = dLon * 180 / (A / sm * Math.cos(rl) * Math.PI); return new LngLat(lon + dLon, lat + dLat); }
  window.__gcj = g;

  class LngLat { constructor(lng, lat) { this.lng = +lng; this.lat = +lat; } getLng() { return this.lng; } getLat() { return this.lat; } }
  const LL = (x) => x instanceof LngLat ? x : Array.isArray(x) ? new LngLat(x[0], x[1]) : x;
  class Bounds { constructor(sw, ne) { this.sw = LL(sw); this.ne = LL(ne); } getCenter() { return new LngLat((this.sw.lng + this.ne.lng) / 2, (this.sw.lat + this.ne.lat) / 2); } }
  class Ev { on(n, f) { ((this._h = this._h || {})[n] = this._h[n] || []).push(f); } off() {} emit(n, a) { ((this._h || {})[n] || []).slice().forEach((f) => f(a)); } }
  const mx = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
  const my = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };

  class Map extends Ev {
    constructor(id, o) {
      super();
      this.el = typeof id === 'string' ? document.getElementById(id) : id; this.o = o || {}; this.z = this.o.zoom || 10; this.c = LL(this.o.center || [116.397, 39.909]); this.items = [];
      log.map = this; log.opts = this.o;
      this.el.classList.add('amap-container');
      this.ov = document.createElement('div'); this.ov.className = 'amap-layers'; this.ov.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#e8ecef'; this.el.appendChild(this.ov);
      const logo = document.createElement('div'); logo.className = 'amap-logo'; logo.style.cssText = 'position:absolute;left:4px;bottom:4px;width:60px;height:18px;background:#9aa'; this.el.appendChild(logo);
      this.el.addEventListener('pointerdown', () => this.emit('dragstart'));
      if (!E.noComplete) setTimeout(() => this.emit('complete'), 30);
    }
    getZoom() { return this.z; }
    setZoom(z) { this.z = z; this.draw(); this.emit('moveend'); }
    getCenter() { return this.c; }
    setCenter(c) { this.c = LL(c); this.draw(); this.emit('moveend'); }
    setZoomAndCenter(z, c) { this.z = z; this.c = LL(c); this.draw(); this.emit('moveend'); }
    panTo(c) { this.c = LL(c); this.draw(); this.emit('moveend'); }
    add(x) { [].concat(x).forEach((i) => { if (!this.items.includes(i)) { this.items.push(i); if (i._on) i._on(this); } }); this.draw(); }
    remove(x) { [].concat(x).forEach((i) => { const had = this.items.includes(i); this.items = this.items.filter((j) => j !== i); if (had && i._off) i._off(this); }); }
    destroy() { this.el.innerHTML = ''; log.destroyed = true; }
    px(ll) { const W = this.el.clientWidth, H = this.el.clientHeight; return { x: mx(ll.lng, this.z) - mx(this.c.lng, this.z) + W / 2, y: my(ll.lat, this.z) - my(this.c.lat, this.z) + H / 2 }; }
    draw() { this.items.forEach((i) => { if (i._draw) i._draw(this); }); }
  }
  class Marker extends Ev {
    constructor(o) { super(); this.o = o || {}; this.p = LL(this.o.position); }
    setPosition(p) { this.p = LL(p); if (this._m) this._draw(this._m); }
    getPosition() { return this.p; }
    setLabel(l) { this.label = l; }
    _on(m) {
      this._m = m; const n = this.o.content;
      this.node = document.createElement('div'); this.node.className = 'amap-marker'; this.node.style.cssText = 'position:absolute';
      if (typeof n === 'string') this.node.innerHTML = n; else if (n) this.node.appendChild(n);
      this.node.addEventListener('click', () => this.emit('click', { target: this }));
      m.ov.appendChild(this.node); log.markers++;
    }
    _off() { if (this.node) this.node.remove(); this._m = null; log.markers--; }
    _draw(m) { const p = m.px(this.p); this.node.style.left = p.x + 'px'; this.node.style.top = p.y + 'px'; this.node.style.transform = this.o.anchor === 'center' ? 'translate(-50%,-50%)' : 'translate(-50%,-100%)'; }
  }
  class Polyline { constructor(o) { this.o = o || {}; } _on() { log.lines.push(this); } _off() { log.lines = log.lines.filter((x) => x !== this); } getPath() { return this.o.path; } }
  class Circle { constructor(o) { this.o = o || {}; } setCenter(c) { this.o.center = c; } setRadius(r) { this.o.radius = r; } }
  class Tile { constructor(name, o) { this.name = name; this.o = o || {}; } _on() { log.layers.push(this.name); } _off() { const i = log.layers.indexOf(this.name); if (i >= 0) log.layers.splice(i, 1); } }
  const TileLayer = function () {};
  TileLayer.Satellite = class extends Tile { constructor(o) { super('sat', o); } };
  TileLayer.RoadNet = class extends Tile { constructor(o) { super('road', o); } };
  TileLayer.Traffic = class extends Tile { constructor(o) { super('traffic', o); } };

  // 服务：回调和 complete / error 事件都给（真高德两种都有）
  const ser = (a) => a instanceof LngLat ? [+a.lng.toFixed(6), +a.lat.toFixed(6)] : a instanceof Bounds ? 'bounds' : a;
  function reply(self, args, name, fn) {
    log.calls.push([name].concat(args.filter((a) => typeof a !== 'function').map(ser)));
    const cb = args.filter((a) => typeof a === 'function').pop();
    setTimeout(() => {
      if (E[name]) { if (cb) cb('error', E[name]); self.emit('error', { info: E[name] }); return; }
      const r = fn();
      if (!r) { if (cb) cb('no_data', 0); return; }
      r.info = 'OK';
      if (cb) cb('complete', r); self.emit('complete', r);
    }, 20);
  }
  const C = [39.9027, 116.4035];
  function pois(q) {
    if (q === '没有') return null;
    return { poiList: { count: 2, pageIndex: 1, pageSize: 20, pois: [
      { id: 'B1', name: q + '一号店', address: '测试东路 1 号', type: '餐饮服务;咖啡厅;咖啡厅', location: g(C[0], C[1]) },
      { id: 'B2', name: q + '二号店', address: [], type: '', pname: '北京市', cityname: '北京市', adname: '东城区', location: g(39.9040, 116.4010) }] } };
  }
  class PlaceSearch extends Ev {
    constructor(o) { super(); this.o = o || {}; log.ps.push(this.o); }
    search(q, ...a) { reply(this, [q, ...a], 'search', () => q === '没有' && !this.o.city ? { poiList: { count: 0, pois: [] }, cityList: [{ name: '北京市', citycode: '010', adcode: '110000', count: 3 }] } : pois(q === '没有' ? '城里' : q)); }
    searchInBounds(q, b, ...a) { reply(this, [q, b, ...a], 'searchInBounds', () => pois(q)); }
    searchNearBy(q, c, r, ...a) { reply(this, [q, c, r, ...a], 'searchNearBy', () => pois(q)); }
  }
  class Geocoder extends Ev {
    constructor(o) { super(); this.o = o || {}; }
    getAddress(ll, ...a) {
      reply(this, [ll, ...a], 'getAddress', () => ({ regeocode: { formattedAddress: '北京市东城区测试北路 5 号', addressComponent: { province: '北京市', city: [], citycode: '010', district: '东城区', adcode: '110101', township: '东华门街道', street: '测试北路', streetNumber: '5号', neighborhood: '', building: [] }, pois: [{ name: '测试大厦', distance: 20, location: LL(ll) }] } }));
    }
  }
  function route(kind, o, d) {   // 从起点往北 300 米，右转往东到终点
    o = LL(o); d = LL(d);
    const b = new LngLat(o.lng, o.lat + 0.0027);
    const steps = [
      { road: '测试北路', distance: 300, time: kind === 'car' ? 50 : 200, action: '右转', assist_action: kind === 'foot' ? '通过人行横道' : '', instruction: '沿测试北路行驶300米右转', path: [o, b] },
      { road: '测试东路', distance: 300, time: kind === 'car' ? 50 : 200, action: '', assist_action: '到达目的地', instruction: '沿测试东路行驶300米到达目的地', path: [b, d] }];
    const r = { distance: 600, time: kind === 'car' ? 100 : 400 };
    if (kind === 'bike') r.rides = steps; else r.steps = steps;
    return { origin: o, destination: d, routes: [r] };
  }
  class Driving extends Ev { constructor(o) { super(); this.o = o || {}; } search(o, d, ...a) { reply(this, [o, d, ...a], 'driving', () => route('car', o, d)); } }
  class Walking extends Ev { constructor(o) { super(); this.o = o || {}; } search(o, d, ...a) { reply(this, [o, d, ...a], 'walking', () => route('foot', o, d)); } }
  class Riding extends Ev { constructor(o) { super(); this.o = o || {}; } search(o, d, ...a) { reply(this, [o, d, ...a], 'riding', () => route('bike', o, d)); } }
  class Transfer extends Ev {
    constructor(o) { super(); this.o = o || {}; log.transfer = this.o; }
    search(o, d, ...a) {
      reply(this, [o, d, ...a], 'transfer', () => {
        o = LL(o); d = LL(d);
        const b = new LngLat(o.lng, o.lat + 0.0027);
        const walk = { transit_mode: 'WALK', distance: 300, time: 240, instruction: '步行300米', transit: { origin: o, destination: b, steps: [{ path: [o, b], distance: 300 }] } };
        return { plans: [
          { cost: 2, time: 900, distance: 700, walking_distance: 300, segments: [walk, { transit_mode: 'BUS', distance: 400, time: 600, instruction: '乘坐测试1路', transit: { lines: [{ name: '测试1路(北站--东站)' }, { name: '测试9路(北站--西站)' }], on_station: { name: '北站' }, off_station: { name: '东站' }, via_num: 2, path: [b, d] } }] },
          { cost: 4, time: 1200, distance: 900, walking_distance: 300, segments: [walk, { transit_mode: 'SUBWAY', distance: 600, time: 900, instruction: '乘坐地铁测试线', transit: { lines: [{ name: '地铁测试线(北--南)' }], on_station: { name: '北' }, off_station: { name: '南' }, via_num: 1, path: [b, d] } }] }] };
      });
    }
  }
  window.AMap = { Map, LngLat, Bounds, Marker, Polyline, Circle, TileLayer, PlaceSearch, Geocoder, Driving, Walking, Riding, Transfer, DrivingPolicy: { LEAST_TIME: 0 }, TransferPolicy: { LEAST_TIME: 0 }, version: 'fake' };
})();
