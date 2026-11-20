(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const layers = new Map();
  let returning = false;
  function bindLayer(name, dialog, show) {
    layers.set(name, { dialog, show });
    dialog.addEventListener('close', () => {
      if (!dialog.open && history.state?.chatterNavLayer === name && !returning) {
        returning = true;
        history.back();
      }
    });
    return () => {
      if (returning || dialog.open) return;
      if (history.state?.chatterNavLayer !== name) {
        try { history.pushState({ ...history.state, chatterNavLayer: name }, ''); }
        catch { /* 系统限制历史记录时仍可用页面按钮关闭。 */ }
      }
      show();
    };
  }
  window.addEventListener('popstate', (event) => {
    returning = false;
    const selected = event.state?.chatterNavLayer;
    for (const [name, layer] of layers) {
      if (name !== selected && layer.dialog.open) layer.dialog.close();
    }
    const target = layers.get(selected);
    if (target && !target.dialog.open) target.show();
  });
  let bridge = null;
  const sound = window.createNavigationSound?.(() => bridge?.beforeSound?.() !== false, bindLayer);
  if (!sound) {
    $('open-sound').hidden = true;
    $('hear-route').hidden = true;
  }
  const recents = [];
  let routeSpeech = '';
  try {
    if (parent !== window) bridge = parent.getChatterNavigation?.(window);
  } catch {
    /* 可独立打开的地点卡。 */
  }
  if (bridge) {
    for (const [key, value] of Object.entries(bridge.theme))
      if (value) document.documentElement.style.setProperty(key, value);
    document.body.style.fontFamily = bridge.font;
    $('sound-music').hidden = !bridge.beforeSound;
    $('back').textContent = bridge.peer ? '返回聊天' : '返回应用';
    $('back').hidden = false;
    $('back').onclick = () => bridge.close();
  }
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const dark = bridge?.appearance ? bridge.appearance === 'dark' : systemTheme.matches;
    document.documentElement.toggleAttribute('data-dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
  applyTheme();
  systemTheme.addEventListener?.('change', applyTheme);
  const valid = (p) =>
    p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  const validPlace = (p) => valid(p) && typeof p.name === 'string' && p.name.trim() && p.name.length <= 120;
  const coordText = (p) => '纬度 ' + p.lat.toFixed(6) + '，经度 ' + p.lon.toFixed(6) + '（WGS84）';
  const say = (text) => {
    const notice = bridge?.peer ? $('trip-notice') : $('notice');
    notice.textContent = text;
  };
  let dest = null,
    queryRequest,
    queryRevision = 0,
    map,
    pins,
    didFit = false,
    lastPins = null,
    lastLine = null;
  const visibleStreetTiles = new Set();
  let routeLine = null,
    routeRevision = 0,
    routerRequest = null,
    lastRouteAt = 0;
  let trip = null,
    peerFix = null,
    ownFix = null,
    watch = null,
    generation = 0,
    stopped = false,
    busy = false,
    pollBusy = false,
    lastUpload = 0,
    inviteId = null;
  let pendingEnd = null;
  let requested = bridge?.invitation || null,
    choosing = false,
    proposing = false,
    mapAnchor = null,
    lastPeerTime = 0;
  const fresh = (f) =>
    valid(f) && Number.isFinite(f.time) && Date.now() - f.time < 90000 && f.time <= Date.now() + 10000;
  function createMap() {
    if (map || !window.L) return;
    map = L.map('map', { minZoom: 2, maxZoom: 19, scrollWheelZoom: false, worldCopyJump: true });
    map.zoomControl.setPosition('topright');
    L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 70 }).addTo(map);
    map.attributionControl.setPrefix(false);
    map.zoomControl.getContainer().querySelectorAll('a').forEach((el, i) => {
      el.title = i === 0 ? '放大地图' : '缩小地图';
      el.setAttribute('aria-label', el.title);
    });
    const overview = L.layerGroup();
    const [land, rivers] = window.chatterOverview || [];
    const polarLimit = 85.05112878;
    map.createPane('terrain').style.zIndex = 350;
    const relief = L.imageOverlay('vendor/earth-relief-50m.webp', [[-polarLimit, -180], [polarLimit, 180]], {
      pane: 'terrain', className: 'earth-relief', interactive: false
    }).addTo(overview);
    relief.on('load', () => $('map').classList.add('relief'));
    if (land && rivers) {
      L.geoJSON(land, { interactive: false, style: { className: 'overview-land', weight: 1, fillOpacity: 1 } }).addTo(overview);
      L.geoJSON(rivers, { interactive: false, style: { className: 'overview-river', weight: 1.2, opacity: 0.85 } }).addTo(overview);
      const cities = [
        ['北京', 39.90, 116.41], ['上海', 31.23, 121.47], ['广州', 23.13, 113.26],
        ['成都', 30.66, 104.07], ['武汉', 30.59, 114.30], ['西安', 34.34, 108.94],
        ['昆明', 25.04, 102.71], ['哈尔滨', 45.80, 126.53], ['乌鲁木齐', 43.83, 87.62],
        ['拉萨', 29.65, 91.12], ['台北', 25.03, 121.57], ['东京', 35.68, 139.69]
      ];
      const labels = L.layerGroup(cities.map(([name, lat, lon]) => L.marker([lat, lon], {
        interactive: false, keyboard: false, icon: L.divIcon({ className: 'city-label', html: name, iconSize: [68, 18], iconAnchor: [2, 9] })
      })));
      map.on('zoomend', () => {
        if (map.getZoom() >= 4 && map.getZoom() <= 5) labels.addTo(map);
        else labels.remove();
      });
    }
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者',
      maxZoom: 19
    });
    const key = (coords) => [coords.z, coords.x, coords.y].join('/');
    tiles.on('tileload', ({ coords }) => visibleStreetTiles.add(key(coords)));
    tiles.on('tileunload', ({ coords }) => visibleStreetTiles.delete(key(coords)));
    tiles.on('load', () => {
      if (map.hasLayer(tiles) && map.getContainer().querySelector('.leaflet-tile:not(.leaflet-tile-loaded)') === null && visibleStreetTiles.size) {
        $('map-status').textContent = '';
        $('map-region').hidden = true;
      }
    });
    tiles.on('tileerror', () => {
      if (map.hasLayer(tiles)) {
        $('map-status').textContent = '部分街道底图未加载。可看区域总览，或用高德核对入口。';
        $('map-region').hidden = false;
      }
    });
    const overviewCredit = '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>';
    map.on('zoomend', () => {
      const street = map.getZoom() >= 6;
      $('map').classList.toggle('street', street);
      if (!street) $('map-region').hidden = true;
      if (street && !map.hasLayer(tiles)) {
        map.removeLayer(overview);
        map.attributionControl.removeAttribution(overviewCredit);
        tiles.addTo(map);
      } else if (!street && !map.hasLayer(overview)) {
        tiles.remove();
        visibleStreetTiles.clear();
        overview.addTo(map);
        map.attributionControl.addAttribution(overviewCredit);
        $('map-status').textContent = land ? '' : '地理总览未加载，可搜索目的地。';
      }
    });
    pins = L.layerGroup().addTo(map);
    map.setView([33.7, 111.5], 4);
    map.on('click', (e) => {
      if (!choosing || (trip && !proposing)) return;
      const latlng = e.latlng.wrap(), zoom = map.getZoom();
      const tile = map.project(e.latlng, zoom).divideBy(256).floor();
      if (zoom < 16 || !visibleStreetTiles.has(key({ z: zoom, x: tile.x, y: tile.y }))) {
        $('map-status').textContent = zoom < 16 ? '请先放大到能看清街道和入口，再点具体位置。' : '这里的街道底图未加载，请搜索地点或输入已知坐标。';
        return;
      }
      if ($('map-dialog').open) closeMap(true);
      if (!trip) clearSelection();
      $('manual').open = true;
      $('place-name').value = '';
      $('lat').value = latlng.lat.toFixed(6);
      $('lon').value = latlng.lng.toFixed(6);
      $('place-name').focus();
      $('nearby-status').textContent = '写下这个入口的名称，再点「核对地点」。';
      choosing = false;
      draw();
    });
  }
  function draw(fit = false) {
    const points = [];
    if (dest) points.push([dest, '终', '目的地：' + dest.name, 'dest']);
    if (fresh(ownFix)) points.push([ownFix, '我', '我的位置', 'me']);
    if (fresh(peerFix)) points.push([peerFix, '友', '同行好友的位置', 'peer']);
    if (trip?.myWait) points.push([trip.myWait, '等', '我等在：' + trip.myWait.name, 'me']);
    if (trip?.peerWait) points.push([trip.peerWait, '等', '好友等在：' + trip.peerWait.name, 'peer']);
    if (!points.length && mapAnchor) points.push([mapAnchor, '附', '选点参考位置', 'me']);
    $('pick').hidden = !!trip && !proposing;
    $('pick').textContent = choosing ? '取消地图选点' : '在图上选点';
    $('pick').setAttribute('aria-pressed', String(choosing));
    $('recenter').hidden = !points.length;
    $('map-title').textContent = trip ? '会合地图' : dest ? '目的地地图' : mapAnchor ? '附近地图' : '地图总览';
    $('map-caption').textContent = choosing ? '放大到具体入口，然后轻点地图。'
      : routeLine ? '已绘制所选路线。' : dest ? dest.name : '放大地图可查看街道。';
    createMap();
    if (!map) {
      $('map-status').textContent = '地图组件暂不可用，仍可使用上方已核对的地点。';
      return;
    }
    map.invalidateSize();
    const signature = JSON.stringify(points);
    if (signature !== lastPins || lastLine !== routeLine) {
      lastPins = signature;
      lastLine = routeLine;
      pins.clearLayers();
      for (const [p, label, title, style] of points) {
        const tip = document.createElement('span');
        tip.textContent = title;
        const coords = [p.lat, p.lon];
        if (Number.isFinite(p.accuracy))
          L.circle(coords, { radius: p.accuracy, weight: 1, fillOpacity: 0.07 }).addTo(pins);
        L.marker(coords, {
          title,
          icon: L.divIcon({ className: 'nav-pin ' + style, html: label, iconSize: [27, 27] })
        })
          .addTo(pins)
          .bindPopup(tip);
      }
      if (routeLine) L.polyline(routeLine, { color: '#6652b7', weight: 5 }).addTo(pins);
    }
    if (points.length && (fit || !didFit)) {
      if (routeLine) {
        map.fitBounds(routeLine, { padding: [22, 22], maxZoom: 17 });
        didFit = true;
        return;
      }
      if (points.length === 1) map.setView([points[0][0].lat, points[0][0].lon], 16);
      else
        map.fitBounds(
          points.map(([p]) => [p.lat, p.lon]),
          { padding: [32, 32], maxZoom: 17 }
        );
      didFit = true;
    }
  }
  const mapDialog = $('map-dialog');
  const mapSlot = document.createComment('地图在页面中的位置');
  $('map-section').before(mapSlot);
  let focusPlaceName = false;
  function closeMap(toName = false) {
    focusPlaceName = toName;
    mapDialog.close();
  }
  const openMap = bindLayer('map', mapDialog, () => {
    mapDialog.append($('map-section'));
    $('map-expand').textContent = '收起地图';
    mapDialog.showModal();
    map?.invalidateSize();
    $('map-expand').focus();
  });
  $('map-expand').onclick = () => mapDialog.open ? closeMap() : openMap();
  mapDialog.addEventListener('close', () => {
    mapSlot.after($('map-section'));
    $('map-expand').textContent = '全屏地图';
    map?.invalidateSize();
    (focusPlaceName ? $('place-name') : $('map-expand')).focus();
    focusPlaceName = false;
  });
  $('map-region').onclick = () => {
    if (map) map.setView(map.getCenter(), 5);
  };
  function renderRecents() {
    const list = $('recent-places');
    list.replaceChildren();
    $('recents').hidden = !recents.length;
    for (const place of recents) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.name;
      const detail = document.createElement('small');
      detail.textContent = place.address || coordText(place);
      button.append(detail);
      button.onclick = () => choosePlace(place);
      list.append(button);
    }
  }
  $('clear-recents').onclick = () => {
    recents.length = 0;
    renderRecents();
    $('query').focus();
  };
  function choosePlace(place) {
    if (!validPlace(place)) return;
    choosing = false;
    if (trip && proposing) {
      proposing = false;
      action('propose', trip.id, place);
      render();
    } else if (!trip) {
      const old = recents.findIndex((p) => p.lat === place.lat && p.lon === place.lon && p.name === place.name);
      if (old >= 0) recents.splice(old, 1);
      recents.unshift({ ...place });
      if (recents.length > 3) recents.pop();
      renderRecents();
      select(place);
      $('dest-name').focus();
    }
  }
  function select(place) {
    if (!validPlace(place)) return;
    resetRoute();
    choosing = false;
    mapAnchor = null;
    dest = { name: place.name, lat: place.lat, lon: place.lon };
    inviteId = null;
    $('confirmed').hidden = false;
    $('dest-name').textContent = dest.name;
    $('dest-info').textContent = place.address || '';
    $('dest-coords').textContent = coordText(dest);
    $('coordinates').open = false;
    $('plan').open = !trip;
    $('copy-status').textContent = '';
    $('nearby-status').textContent = '';
    $('manual').open = false;
    const target = new URL('https://uri.amap.com/marker');
    target.search = new URLSearchParams({
      position: dest.lon + ',' + dest.lat,
      name: dest.name,
      coordinate: 'wgs84',
      src: 'Chatter'
    }).toString();
    $('route').href = target.href;
    draw(true);
    render();
  }
  function resetRoute() {
    ++routeRevision;
    routerRequest?.abort();
    routeLine = null;
    sound?.stop();
    routeSpeech = '';
    $('route-summary').hidden = true;
    $('step-list').replaceChildren();
    $('steps').open = false;
    $('route-audio-status').textContent = '';
    $('plan').querySelector('summary').textContent = '规划路线';
    $('plan-status').textContent = '';
    $('plan-go').disabled = false;
    $('plan-go').textContent = '计算' + document.querySelector('#mode :checked + span').textContent + '路线';
  }
  function metres(a, b) {
    const rad = (n) => (n * Math.PI) / 180;
    const h =
      Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  const directionNames = {
    left: '左转', right: '右转', 'slight left': '向左前方行进', 'slight right': '向右前方行进',
    'sharp left': '向左急转', 'sharp right': '向右急转', straight: '直行', uturn: '掉头'
  };
  function stepTitle(step) {
    const maneuver = step?.maneuver;
    if (!maneuver || !Number.isFinite(step.distance) || step.distance < 0) return '';
    const road = typeof step.name === 'string' ? step.name.trim().slice(0, 100) : '';
    let instruction;
    switch (maneuver.type) {
      case 'depart': instruction = '从起点出发'; break;
      case 'arrive': return '到达路线终点';
      case 'roundabout': case 'rotary':
        instruction = Number.isInteger(maneuver.exit) && maneuver.exit > 0 ? '进入环岛，从第 ' + maneuver.exit + ' 个出口驶出' : '进入环岛';
        break;
      case 'exit roundabout': case 'exit rotary': instruction = '离开环岛'; break;
      case 'on ramp': instruction = '进入匝道'; break;
      case 'off ramp': instruction = '驶离匝道'; break;
      case 'merge': instruction = '汇入道路'; break;
      case 'fork': instruction = ({left:'在岔路靠左','slight left':'在岔路靠左',right:'在岔路靠右','slight right':'在岔路靠右'})[maneuver.modifier] || '经过岔路'; break;
      case 'turn': case 'continue': case 'end of road': instruction = directionNames[maneuver.modifier] || '沿路线前行'; break;
      default: instruction = '沿路线前行';
    }
    return road ? instruction + ' · ' + road : instruction;
  }
  function presentRoute(route, gap) {
    const minutes = Math.max(1, Math.round(route.duration / 60));
    const unit = route.distance >= 1000 ? '公里' : '米';
    const distance = unit === '公里' ? Number((route.distance / 1000).toFixed(2)) : Math.round(route.distance);
    const mode = document.querySelector('#mode :checked + span').textContent;
    $('duration').textContent = minutes;
    $('distance').textContent = distance;
    $('distance-unit').textContent = unit;
    $('route-gap').textContent = '道路终点距所选入口约 ' + Math.round(gap) + ' 米。';
    routeSpeech = mode + '前往' + dest.name + '，预计 ' + minutes + ' 分钟，全程约 ' + distance + ' ' + unit + '。';
    const list = $('step-list');
    for (const leg of Array.isArray(route.legs) ? route.legs : []) {
      for (const step of Array.isArray(leg?.steps) ? leg.steps : []) {
        const title = stepTitle(step);
        if (!title) continue;
        const row = document.createElement('li'), text = document.createElement('span'), listen = document.createElement('button');
        text.textContent = title;
        const length = step.distance > 0 ? '本段约 ' + Math.round(step.distance) + ' 米' : '';
        if (length) {
          const detail = document.createElement('small');
          detail.textContent = length;
          text.append(detail);
        }
        const index = list.children.length + 1;
        listen.type = 'button';
        listen.textContent = '听';
        listen.setAttribute('aria-label', '朗读第 ' + index + ' 段');
        listen.onclick = () => sound?.read('路线预览，第 ' + index + ' 段。' + title.replace(' · ', '，') + '。' + length, $('route-audio-status'));
        row.append(text);
        if (sound) row.append(listen);
        list.append(row);
      }
    }
    $('steps').hidden = !list.children.length;
    $('route-summary').hidden = false;
    $('plan-status').textContent = '';
    $('plan').open = false;
    $('plan').querySelector('summary').textContent = '调整路线';
    $('route-heading').focus();
    sound?.announce(routeSpeech, $('route-audio-status'));
  }
  $('hear-route').onclick = () => { if (routeSpeech) sound?.read(routeSpeech, $('route-audio-status')); };
  function changeStart() {
    resetRoute();
    $('from-fields').hidden = $('start-source').value !== 'manual';
    draw();
  }
  $('start-source').onchange = changeStart;
  $('mode').onchange = changeStart;
  $('from-fields').oninput = changeStart;
  $('plan-go').onclick = async () => {
    if (!dest) return;
    if (Date.now() - lastRouteAt < 1200) {
      $('plan-status').textContent = '刚完成一次算路，请稍等一秒再试。';
      return;
    }
    resetRoute();
    draw();
    const rev = routeRevision,
      target = { ...dest },
      mode = document.querySelector('#mode :checked').value;
    const ctl = new AbortController();
    routerRequest = ctl;
    $('plan-go').disabled = true;
    let timer;
    try {
      let start;
      if ($('start-source').value === 'manual') {
        start = { lat: $('from-lat').valueAsNumber, lon: $('from-lon').valueAsNumber };
        if (!valid(start)) throw new Error('请填写有效的 WGS84 起点纬度和经度。');
      } else {
        $('plan-status').textContent = '正在获取本次出发位置…';
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation
            ? navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 12000,
                maximumAge: 0
              })
            : reject(new Error('请手填起点坐标。'))
        );
        if (pos.coords.accuracy > 120) throw new Error('当前定位误差超过 120 米，请手填起点或在室外重试。');
        start = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      }
      if (rev !== routeRevision || stopped) return;
      lastRouteAt = Date.now();
      $('plan-status').textContent = '正在按已选起点和入口算路…';
      const profile = { foot: 'routed-foot', bike: 'routed-bike', car: 'routed-car' }[mode];
      if (!profile) throw new Error('请选择出行方式。');
      const path = start.lon + ',' + start.lat + ';' + target.lon + ',' + target.lat;
      timer = setTimeout(() => ctl.abort(), 12000);
      const response = await fetch(
        'https://routing.openstreetmap.de/' +
          profile +
          '/route/v1/driving/' +
          path +
          '?overview=full&geometries=geojson&steps=true',
        { signal: ctl.signal, credentials: 'omit' }
      );
      const data = response.ok && (await response.json());
      if (rev !== routeRevision || stopped) return;
      const r = data?.routes?.[0],
        raw = r?.geometry?.coordinates;
      if (
        data?.code !== 'Ok' ||
        !Array.isArray(raw) ||
        raw.length < 2 ||
        !Number.isFinite(r.distance) ||
        !Number.isFinite(r.duration) || r.duration < 0 || r.distance < 0
      )
        throw new Error('暂时没有可核对的路线。可用高德查看已选地点。');
      const line = raw.map(([lon, lat]) => ({ lat, lon }));
      if (!line.every(valid)) throw new Error('路线数据异常，请重新规划。');
      const fromGap = metres(start, line[0]),
        toGap = metres(target, line[line.length - 1]);
      const tolerance = mode === 'car' ? 120 : 60;
      if (fromGap > tolerance || toGap > tolerance)
        throw new Error(
          '可通行道路与所选起点或入口相距较远（起点 ' +
            Math.round(fromGap) +
            ' 米，终点 ' +
            Math.round(toGap) +
            ' 米）。请核对入口后再规划。'
        );
      routeLine = line.map((p) => [p.lat, p.lon]);
      draw(true);
      presentRoute(r, toGap);
    } catch (e) {
      if (rev === routeRevision && !stopped)
        $('plan-status').textContent =
          e.code === 3 ? '定位超时，可到室外重试或手填起点。' : e.code === 2 ? '设备暂时无法定位，可手填起点。' : e.code === 1
            ? '定位未授权，可手填起点。'
            : e.name === 'AbortError'
              ? '路线请求超时，请重试。'
              : e instanceof TypeError
                ? '路线服务暂时连不上。可用高德核对原地点。'
                : e.message || '无法规划，请手填起点或重试。';
    } finally {
      clearTimeout(timer);
      if (rev === routeRevision) $('plan-go').disabled = false;
    }
  };
  function invalidateSearch() {
    ++queryRevision;
    queryRequest?.abort();
    $('results').replaceChildren();
    $('search-status').textContent = '';
    $('nearby-status').textContent = '';
  }
  function clearSelection() {
    if (!trip) {
      resetRoute();
      dest = null;
      inviteId = null;
      $('confirmed').hidden = true;
      render();
      draw();
    }
  }
  $('query').oninput = () => {
    invalidateSearch();
    clearSelection();
    $('amap-search').hidden = true;
  };
  $('coords').oninput = clearSelection;
  $('replace').onclick = () => {
    invalidateSearch();
    clearSelection();
    choosing = false;
    $('amap-search').hidden = true;
    $('query').focus();
    $('query').select();
    draw();
  };
  $('pick').onclick = () => {
    choosing = !choosing;
    draw();
    if (choosing) $('map').focus();
    else if (map?.getZoom() < 6) $('map-status').textContent = '';
  };
  $('nearby').onclick = () => {
    if (!navigator.geolocation) {
      $('nearby-status').textContent = '设备无法定位，可以搜索或输入坐标。';
      return;
    }
    invalidateSearch();
    const rev = queryRevision;
    $('nearby-status').textContent = '正在获取当前位置…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (stopped || rev !== queryRevision || (trip && !proposing)) return;
        mapAnchor = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        choosing = true;
        draw(true);
        if (map) map.setView([mapAnchor.lat, mapAnchor.lon], 16);
        $('nearby-status').textContent = '定位精度约 ' + Math.round(pos.coords.accuracy) + ' 米。';
        $('map').focus();
      },
      () => {
        if (!stopped && rev === queryRevision) $('nearby-status').textContent = '未取得定位，可以搜索地点或输入坐标。';
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };
  $('search').onsubmit = async (e) => {
    e.preventDefault();
    invalidateSearch();
    const rev = queryRevision;
    const q = $('query').value.trim();
    if (!q || (trip && !proposing)) return;
    const fallback = new URL('https://uri.amap.com/search');
    fallback.search = new URLSearchParams({ keyword: q, src: 'Chatter' });
    $('amap-search').href = fallback.href;
    $('amap-search').hidden = false;
    const ctl = new AbortController();
    queryRequest = ctl;
    const timer = setTimeout(() => ctl.abort(), 9000);
    $('search-status').textContent = '正在查找地点…';
    try {
      const url = new URL('https://photon.komoot.io/api/');
      url.search = new URLSearchParams({ q, limit: '8' }).toString();
      const response = await fetch(url, {
        signal: ctl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) throw new Error('地点来源暂不可用');
      const data = await response.json();
      if (rev !== queryRevision || stopped) return;
      const places = (data.features || [])
        .filter((f) => f.geometry?.type === 'Point')
        .map((f) => {
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          return {
            lat,
            lon,
            name: p.name || p.street,
            address: [
              ...new Set([p.country, p.state, p.city, p.district, p.street, p.housenumber].filter(Boolean))
            ].join(' · ')
          };
        })
        .filter(validPlace);
      $('search-status').textContent = places.length
        ? '请选择正确的城市和入口（地点来源：OpenStreetMap / Photon）。'
        : '没有匹配地点，请补充城市、门牌或入口。';
      for (const place of places) {
        const btn = document.createElement('button'),
          detail = document.createElement('small');
        btn.type = 'button';
        btn.textContent = place.name;
        detail.textContent = place.address || coordText(place);
        btn.append(detail);
        btn.onclick = () => {
          invalidateSearch();
          choosePlace(place);
        };
        $('results').append(btn);
      }
    } catch {
      if (rev === queryRevision && !stopped)
        $('search-status').textContent = '地点查询未完成。可以重试，也可输入已核对的 GPS 坐标。';
    } finally {
      clearTimeout(timer);
    }
  };
  $('coords').onsubmit = (e) => {
    e.preventDefault();
    if (trip && !proposing) return;
    invalidateSearch();
    choosePlace({
      name: $('place-name').value.trim(),
      lat: $('lat').valueAsNumber,
      lon: $('lon').valueAsNumber
    });
  };
  $('copy').onclick = async () => {
    if (!dest) return;
    const u = new URL('navigation.html', location.href);
    u.hash = new URLSearchParams({ name: dest.name, lat: dest.lat, lon: dest.lon }).toString();
    try {
      await navigator.clipboard.writeText(u.href);
      $('copy-status').textContent = '已复制目的地链接。';
    } catch {
      window.prompt('复制目的地链接', u.href);
    }
  };
  $('recenter').onclick = () => draw(true);
  function stopGPS() {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    ownFix = null;
    lastUpload = 0;
  }
  function render() {
    $('together').hidden = !bridge?.peer;
    $('destination-search').hidden = !!dest && !proposing;
    $('replace').hidden = !!trip;
    $('search-title').textContent = proposing ? '新的会合点在哪里？' : '你想去哪里？';
    document.querySelector('main').toggleAttribute('data-trip', !!trip);
    $('people').hidden = !trip?.active;
    $('change').textContent = proposing ? '取消更换' : '提议更换会合点';
    if ($('destination-search').hidden) $('amap-search').hidden = true;
    $('meeting').hidden = !trip?.active;
    $('wait-info').textContent = [
      trip?.myWait && '我等在：' + trip.myWait.name,
      trip?.peerWait && '好友等在：' + trip.peerWait.name
    ]
      .filter(Boolean)
      .join(' · ');
    $('proposal').textContent = trip?.proposal
      ? '提议的新会合点：' + trip.proposal.name + ' · ' + coordText(trip.proposal)
      : '';
    $('agree').hidden = !trip?.proposal || trip.proposal.by === bridge?.me;
    $('invite').hidden = !dest || !!trip || !!requested;
    $('accept').hidden = !trip || trip.active || trip.inviter === bridge?.me;
    $('share').hidden = !trip?.active || watch !== null || !!pendingEnd;
    for (const id of ['invite', 'accept', 'agree', 'end', 'wait-here', 'change']) $(id).disabled = busy;
    $('end').hidden = !trip;
    $('trip-title').textContent = bridge?.peer ? '和 ' + (bridge.peerLabel || bridge.peer) + ' 一起导航' : '一起导航';
    if (!trip)
      $('trip-status').textContent = requested ? '此邀请已结束或不可用。' : '选好入口后可以邀请这位好友。';
    else
      $('trip-status').textContent =
        (trip.active
          ? '双方已加入。选择共享后，好友可在本次同行中看见你的位置。'
          : trip.inviter === bridge.me
            ? '等待对方接受。'
            : '对方邀请你前往上方地点。') +
        ' 到期时间 ' +
        new Date(trip.expires).toLocaleTimeString();
    if (pendingEnd) $('trip-status').textContent = '本机已停止共享，等待联网关闭同行。旧定位最多显示 90 秒。';
    if (trip?.active && !$('gps').textContent) $('gps').textContent = '我还没有开启位置共享。';
    $('other').textContent = fresh(peerFix)
      ? '好友更新于 ' +
        new Date(peerFix.time).toLocaleTimeString() +
        ' · 精度约 ' +
        Math.round(peerFix.accuracy) +
        ' 米'
      : trip?.active
        ? lastPeerTime
          ? '好友最后更新于 ' + new Date(lastPeerTime).toLocaleTimeString() + '，请等待新定位。'
          : '好友尚未分享定位。'
        : '';
    let separation = '';
    if (trip?.active && fresh(ownFix) && fresh(peerFix)) {
      const gap = metres(ownFix, peerFix);
      const error = ownFix.accuracy + peerFix.accuracy;
      separation = gap <= error ? '两人的定位范围重叠，可用入口或楼层确认。'
        : gap < 1000 ? '你们直线相距约 ' + Math.round(gap / 10) * 10 + ' 米'
        : '你们直线相距约 ' + (gap / 1000).toFixed(1) + ' 公里';
    }
    $('separation').textContent = separation;
  }
  function setTrip(value) {
    const prev = trip;
    if (prev?.id !== value?.id) {
      ++generation;
      lastPeerTime = 0;
      proposing = false;
      choosing = false;
      stopGPS();
      $('gps').textContent = '';
    }
    trip = value;
    peerFix = value?.peerFix || null;
    if (peerFix) lastPeerTime = peerFix.time;
    if (
      trip &&
      (!prev || prev.id !== trip.id || JSON.stringify(prev.destination) !== JSON.stringify(trip.destination))
    ) {
      invalidateSearch();
      select(trip.destination);
    }
    if (!trip && prev) {
      $('plan').open = true;
      pendingEnd = null;
      say('本次同行已结束。');
    }
    render();
    draw(!prev && !!value);
    let announcement;
    if (prev && !trip) announcement = '本次同行已结束。';
    if (trip && prev?.id === trip.id) {
      if (!prev.active && trip.active) announcement = '双方已加入同行。';
      if (trip.proposal && prev.proposal?.key !== trip.proposal.key && trip.proposal.by !== bridge?.me)
        announcement = '好友提议更换会合点，请打开同行页面确认。';
      if (prev.destination && (prev.destination.name !== trip.destination.name || prev.destination.lat !== trip.destination.lat || prev.destination.lon !== trip.destination.lon))
        announcement = '会合点已更新为' + trip.destination.name + '。';
    }
    if (announcement) sound?.announce(announcement, $('trip-notice'));
  }
  function backendError(err) {
    const missing = ['PGRST202', '42883'].includes(err?.code);
    say(
      missing
        ? '这个环境尚未启用双人同行，单人地点和路线入口可继续使用。'
        : String(err?.message || '网络暂不可用，请重试').slice(0, 160)
    );
  }
  async function action(op, id, value) {
    if (busy || stopped) return;
    busy = true;
    render();
    const seq = ++generation;
    try {
      const result = await bridge.rpc(op, id, value);
      if (stopped || seq !== generation) return;
      say('');
      setTrip(result);
      if (op === 'invite' && result) bridge.notify(result.id);
      if (op === 'end') {
        pendingEnd = null;
        requested = null;
        render();
      }
    } catch (err) {
      if (!stopped) backendError(err);
    } finally {
      busy = false;
      render();
    }
  }
  async function poll() {
    if (stopped || busy || pollBusy || document.hidden || !bridge?.peer) return;
    if (pendingEnd) {
      await action('end', pendingEnd);
      return;
    }
    pollBusy = true;
    const seq = generation;
    try {
      const value = await bridge.rpc('read', trip?.id || requested);
      if (!busy && !stopped && seq === generation) setTrip(value);
    } catch (err) {
      if (!stopped) backendError(err);
    } finally {
      pollBusy = false;
    }
  }
  $('invite').onclick = () => {
    if (dest) {
      inviteId ||= crypto.randomUUID();
      action('invite', inviteId, dest);
    }
  };
  $('accept').onclick = () => action('accept', trip?.id);
  $('end').onclick = () => {
    if (!trip) return;
    pendingEnd = trip.id;
    stopGPS();
    render();
    draw();
    action('end', pendingEnd);
  };
  $('change').onclick = () => {
    proposing = !proposing;
    render();
    draw();
    if (proposing) $('query').focus();
  };
  $('agree').onclick = () => {
    if (trip?.proposal) action('agree', trip.id, { key: trip.proposal.key });
  };
  $('wait-here').onclick = () => {
    const name = $('wait-note').value.trim();
    if (!fresh(ownFix) || !name) {
      say('先共享本次定位，再写明入口或楼层。');
      return;
    }
    action('wait', trip.id, { lat: ownFix.lat, lon: ownFix.lon, name });
  };
  $('share').onclick = () => {
    if (!trip?.active || watch !== null) return;
    if (!navigator.geolocation) {
      say('设备暂不支持定位。');
      return;
    }
    const id = trip.id;
    bridge.shareStarted(id);
    $('gps').textContent = '等待设备定位…';
    watch = navigator.geolocation.watchPosition(
      async (pos) => {
        if (stopped || watch === null || trip?.id !== id) return;
        ownFix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          time: pos.timestamp
        };
        if (!fresh(ownFix)) {
          ownFix = null;
          draw();
          return;
        }
        draw();
        if (Date.now() - lastUpload < 4000) return;
        lastUpload = Date.now();
        try {
          const result = await bridge.rpc('fix', id, ownFix);
          if (!stopped && trip?.id === id && watch !== null) {
            if (!result) setTrip(null);
            else $('gps').textContent = '我的位置更新于 ' + new Date(pos.timestamp).toLocaleTimeString();
          }
        } catch (err) {
          if (!stopped && trip?.id === id) backendError(err);
        }
      },
      (err) => {
        if (stopped || trip?.id !== id) return;
        if (err.code === 1) stopGPS();
        $('gps').textContent = err.code === 1 ? '你已拒绝定位，仍可查看会合点。' : '设备暂未取得新定位。';
        render();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    render();
  };
  const timer = setInterval(() => {
    if (stopped) return;
    if (trip && Date.parse(trip.expires) <= Date.now()) setTrip(null);
    render();
    draw();
    poll();
  }, 6000);
  window.addEventListener('online', poll);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      render();
      draw();
      poll();
    }
  });
  function dispose() {
    stopped = true;
    recents.length = 0;
    sound?.dispose();
    ++generation;
    clearInterval(timer);
    resetRoute();
    invalidateSearch();
    stopGPS();
  }
  window.addEventListener('pagehide', dispose, { once: true });
  window.stopChatterNavigation = dispose;
  function openSharedPlace() {
    if (trip || bridge?.peer) return;
    const hadLocation = !!(dest || mapAnchor);
    invalidateSearch();
    clearSelection();
    say('');
    mapAnchor = null;
    draw();
    if (!location.hash) {
      if (hadLocation) map?.setView([33.7, 111.5], 4);
      return;
    }
    const params = new URLSearchParams(location.hash.slice(1));
    const number = (key) => {
      const raw = params.get(key);
      return raw && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(raw.trim()) ? Number(raw) : NaN;
    };
    const place = { name: params.get('name'), lat: number('lat'), lon: number('lon') };
    if (validPlace(place)) select(place);
    else {
      if (hadLocation) map?.setView([33.7, 111.5], 4);
      say('地点链接无效，请重新选点。');
    }
  }
  window.addEventListener('hashchange', openSharedPlace);
  openSharedPlace();
  render();
  layers.get(history.state?.chatterNavLayer)?.show();
  poll();
})();
