(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let bridge = null;
  try {
    if (parent !== window) bridge = parent.getChatterNavigation?.(window);
  } catch {
    /* 可独立打开的地点卡。 */
  }
  if (bridge) {
    for (const [key, value] of Object.entries(bridge.theme))
      if (value) document.documentElement.style.setProperty(key, value);
    document.body.style.fontFamily = bridge.font;
    $('back').hidden = false;
    $('back').onclick = () => bridge.close();
  }
  const valid = (p) =>
    p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  const validPlace = (p) => valid(p) && typeof p.name === 'string' && p.name.trim() && p.name.length <= 120;
  const coordText = (p) => '纬度 ' + p.lat.toFixed(6) + '，经度 ' + p.lon.toFixed(6) + '（WGS84）';
  const say = (text) => {
    $('notice').textContent = text;
  };
  let dest = null,
    queryRequest,
    queryRevision = 0,
    map,
    pins,
    didFit = false,
    onlineTiles = false;
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
    map = L.map('map', { zoomControl: true, maxZoom: 19 });
    pins = L.layerGroup().addTo(map);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者',
      maxZoom: 19
    }).addTo(map);
    map.on('click', (e) => {
      if (!choosing || (trip && !proposing)) return;
      $('manual').open = true;
      $('lat').value = e.latlng.lat.toFixed(6);
      $('lon').value = e.latlng.lng.toFixed(6);
      $('place-name').focus();
      say('请为刚点的入口命名，并点「核对地点」。');
      choosing = false;
    });
    tiles.on('tileerror', () => {
      $('map-status').textContent = '部分街道底图未加载。标记仍按坐标显示，可到高德核对入口。';
    });
    tiles.on('tileload', () => {
      if (!onlineTiles) {
        onlineTiles = true;
        $('map-status').textContent = '';
      }
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
    $('map-section').hidden = !points.length;
    $('pick').hidden = !points.length || (!!trip && !proposing);
    if (!points.length) return;
    createMap();
    if (!map) {
      $('map-status').textContent = '地图组件暂不可用，仍可使用上方已核对的地点。';
      return;
    }
    map.invalidateSize();
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
    if (fit || !didFit) {
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
  function choosePlace(place) {
    if (!validPlace(place)) return;
    choosing = false;
    if (trip && proposing) {
      proposing = false;
      action('propose', trip.id, place);
      render();
    } else if (!trip) select(place);
  }
  function select(place) {
    if (!validPlace(place)) return;
    resetRoute();
    dest = { name: place.name, lat: place.lat, lon: place.lon };
    inviteId = null;
    $('confirmed').hidden = false;
    $('dest-name').textContent = dest.name;
    $('dest-info').textContent = [place.address, coordText(dest)].filter(Boolean).join(' · ');
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
    $('plan-status').textContent = '';
    $('plan-go').disabled = false;
  }
  function metres(a, b) {
    const rad = (n) => (n * Math.PI) / 180;
    const h =
      Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function changeStart() {
    resetRoute();
    $('from-fields').hidden = $('start-source').value !== 'manual';
    draw();
  }
  $('start-source').onchange = changeStart;
  $('mode').onchange = changeStart;
  $('from-fields').oninput = changeStart;
  $('plan-go').onclick = async () => {
    if (!dest || Date.now() - lastRouteAt < 1200) return;
    resetRoute();
    draw();
    const rev = routeRevision,
      target = { ...dest },
      mode = $('mode').value;
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
          '?overview=full&geometries=geojson',
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
        !Number.isFinite(r.duration)
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
      $('plan-status').textContent =
        '约 ' +
        (r.distance / 1000).toFixed(2) +
        ' 公里 · 预计 ' +
        Math.max(1, Math.round(r.duration / 60)) +
        ' 分钟。路线终点距选定位置约 ' +
        Math.round(toGap) +
        ' 米。时间按道路数据估算。';
    } catch (e) {
      if (rev === routeRevision && !stopped)
        $('plan-status').textContent =
          e.code === 1
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
  $('pick').onclick = () => {
    choosing = true;
    say('在地图上点具体入口，再核对坐标和名称。');
  };
  $('nearby').onclick = () => {
    if (!navigator.geolocation) {
      say('设备无法定位，可以搜索或手填坐标。');
      return;
    }
    const rev = queryRevision;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (stopped || rev !== queryRevision || (trip && !proposing)) return;
        mapAnchor = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        choosing = true;
        draw(true);
        if (map) map.setView([mapAnchor.lat, mapAnchor.lon], 16);
        say('已到你附近，在图上点入口并核对。定位精度约 ' + Math.round(pos.coords.accuracy) + ' 米。');
      },
      () => say('未取得定位，可以搜索地点或手填坐标。'),
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
        detail.textContent = (place.address || '地址未提供') + ' · ' + coordText(place);
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
      say('已复制目的地链接。');
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
    $('search').hidden = !!trip && !proposing;
    $('manual').hidden = $('nearby').hidden = $('search').hidden;
    if ($('search').hidden) $('amap-search').hidden = true;
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
    $('end').disabled = busy;
    $('end').hidden = !trip;
    $('trip-title').textContent = bridge?.peer ? '和 ' + bridge.peer + ' 一起导航' : '一起导航';
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
      pendingEnd = null;
      say('本次同行已结束。');
    }
    render();
    draw(!prev && !!value);
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
    invalidateSearch();
    clearSelection();
    say('');
    mapAnchor = null;
    draw();
    if (!location.hash) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const number = (key) => {
      const raw = params.get(key);
      return raw && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(raw.trim()) ? Number(raw) : NaN;
    };
    const place = { name: params.get('name'), lat: number('lat'), lon: number('lon') };
    if (validPlace(place)) select(place);
    else say('地点链接无效，请重新选点。');
  }
  window.addEventListener('hashchange', openSharedPlace);
  openSharedPlace();
  render();
  poll();
})();
