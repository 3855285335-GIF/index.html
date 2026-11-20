(() => {
'use strict';
const $ = id => document.getElementById(id);
let bridge=null;
try { if (parent!==window) bridge=parent.getChatterNavigation?.(window); } catch { /* 可独立打开的地点卡。 */ }
if (bridge) {
  for (const [key,value] of Object.entries(bridge.theme)) if (value) document.documentElement.style.setProperty(key,value);
  document.body.style.fontFamily = bridge.font;
  $('back').hidden = false;
  $('back').onclick = () => bridge.close();
}
const valid = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat)<=90 && Math.abs(p.lon)<=180;
const validPlace = p => valid(p) && typeof p.name==='string' && p.name.trim() && p.name.length<=120;
const coordText = p => '纬度 ' + p.lat.toFixed(6) + '，经度 ' + p.lon.toFixed(6) + '（WGS84）';
const say = text => { $('notice').textContent = text; };
let dest=null, queryRequest, queryRevision=0, map, pins, didFit=false, onlineTiles=false;
let trip=null, peerFix=null, ownFix=null, watch=null, generation=0, stopped=false, busy=false, pollBusy=false, lastUpload=0, inviteId=null;
let requested = bridge?.invitation || null, choosing=false, proposing=false, mapAnchor=null, lastPeerTime=0;
const fresh = f => valid(f) && Number.isFinite(f.time) && Date.now()-f.time<90000 && f.time<=Date.now()+10000;
function createMap() {
  if (map || !window.L) return;
  map=L.map('map',{zoomControl:true, maxZoom:19}); pins=L.layerGroup().addTo(map);
  const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者',maxZoom:19
  }).addTo(map);
  map.on('click',e=>{if (!choosing || (trip && !proposing)) return;
    $('manual').open=true; $('lat').value=e.latlng.lat.toFixed(6); $('lon').value=e.latlng.lng.toFixed(6);
    $('place-name').focus();say('请为刚点的入口命名，并点「核对地点」。'); choosing=false;
  });
  tiles.on('tileerror',() => { $('map-status').textContent='部分街道底图未加载。标记仍按坐标显示，可到高德核对入口。'; });
  tiles.on('tileload',() => { if (!onlineTiles) { onlineTiles=true; $('map-status').textContent=''; } });
}
function draw(fit=false) {
  const points=[];
  if (dest) points.push([dest,'终','目的地：'+dest.name,'dest']);
  if (fresh(ownFix)) points.push([ownFix,'我','我的位置','me']);
  if (fresh(peerFix)) points.push([peerFix,'友','同行好友的位置','peer']);
  if (trip?.myWait) points.push([trip.myWait,'等','我等在：'+trip.myWait.name,'me']);
  if (trip?.peerWait) points.push([trip.peerWait,'等','好友等在：'+trip.peerWait.name,'peer']);
  if (!points.length && mapAnchor) points.push([mapAnchor,'附','选点参考位置','me']);
  $('map-section').hidden=!points.length; $('pick').hidden=!points.length || (!!trip && !proposing);
  if (!points.length) return;
  createMap();
  if (!map) { $('map-status').textContent='地图组件暂不可用，仍可使用上方已核对的地点。'; return; }
  map.invalidateSize(); pins.clearLayers();
  for (const [p,label,title,style] of points) {
    const tip=document.createElement('span');tip.textContent=title;
    const coords=[p.lat,p.lon];
    if (Number.isFinite(p.accuracy)) L.circle(coords,{radius:p.accuracy,weight:1,fillOpacity:.07}).addTo(pins);
    L.marker(coords,{title,icon:L.divIcon({className:'nav-pin '+style,html:label,iconSize:[27,27]})}).addTo(pins).bindPopup(tip);
  }
  if (fit || !didFit) {
    if (points.length===1) map.setView([points[0][0].lat,points[0][0].lon],16);
    else map.fitBounds(points.map(([p])=>[p.lat,p.lon]),{padding:[32,32],maxZoom:17});
    didFit=true;
  }
}
function choosePlace(place) {
  if (!validPlace(place))return;
  choosing=false;
  if (trip && proposing) { proposing=false; action('propose',trip.id,place);render(); }
  else if (!trip) select(place);
}
function select(place) {
  if (!validPlace(place)) return;
  dest={name:place.name,lat:place.lat,lon:place.lon}; inviteId=null;
  $('confirmed').hidden=false; $('dest-name').textContent=dest.name;
  $('dest-info').textContent=[place.address,coordText(dest)].filter(Boolean).join(' · ');
  const target=new URL('https://uri.amap.com/marker');
  target.search=new URLSearchParams({position:dest.lon+','+dest.lat,name:dest.name,coordinate:'wgs84',src:'Chatter'}).toString();
  $('route').href=target.href; draw(true); render();
}
function invalidateSearch() {
  ++queryRevision; queryRequest?.abort(); $('results').replaceChildren(); $('search-status').textContent='';
}
function clearSelection() {
  if (!trip) {dest=null;inviteId=null;$('confirmed').hidden=true;render();draw();}
}
$('query').oninput=()=>{invalidateSearch();clearSelection();$('amap-search').hidden=true;};
$('coords').oninput=clearSelection;
$('pick').onclick=()=>{choosing=true;say('在地图上点具体入口，再核对坐标和名称。');};
$('nearby').onclick=()=>{
  if (!navigator.geolocation) {say('设备无法定位，可以搜索或手填坐标。');return;}
  const rev=queryRevision;
  navigator.geolocation.getCurrentPosition(pos=>{
    if(stopped || rev!==queryRevision || (trip && !proposing))return;
    mapAnchor={lat:pos.coords.latitude,lon:pos.coords.longitude};choosing=true;draw(true);
    if(map) map.setView([mapAnchor.lat,mapAnchor.lon],16);
    say('已到你附近，在图上点入口并核对。定位精度约 '+Math.round(pos.coords.accuracy)+' 米。');
  },()=>say('未取得定位，可以搜索地点或手填坐标。'),{enableHighAccuracy:true,timeout:12000,maximumAge:0});
};
$('search').onsubmit=async e=>{
  e.preventDefault(); invalidateSearch(); const rev=queryRevision;
  const q=$('query').value.trim(); if (!q || (trip && !proposing)) return;
  const fallback=new URL('https://uri.amap.com/search'); fallback.search=new URLSearchParams({keyword:q,src:'Chatter'}); $('amap-search').href=fallback.href;$('amap-search').hidden=false;
  const ctl=new AbortController();queryRequest=ctl;
  const timer=setTimeout(()=>ctl.abort(),9000); $('search-status').textContent='正在查找地点…';
  try {
    const url=new URL('https://photon.komoot.io/api/');url.search=new URLSearchParams({q,limit:'8'}).toString();
    const response=await fetch(url,{signal:ctl.signal,credentials:'omit',referrerPolicy:'no-referrer'});
    if (!response.ok) throw new Error('地点来源暂不可用');
    const data=await response.json(); if (rev!==queryRevision || stopped) return;
    const places=(data.features||[]).filter(f=>f.geometry?.type==='Point').map(f=>{
      const [lon,lat]=f.geometry.coordinates;const p=f.properties||{};
      return {lat,lon,name:p.name||p.street,address:[...new Set([p.country,p.state,p.city,p.district,p.street,p.housenumber].filter(Boolean))].join(' · ')};
    }).filter(validPlace);
    $('search-status').textContent=places.length?'请选择正确的城市和入口（地点来源：OpenStreetMap / Photon）。':'没有匹配地点，请补充城市、门牌或入口。';
    for (const place of places) {
      const btn=document.createElement('button'), detail=document.createElement('small');
      btn.type='button';btn.textContent=place.name;detail.textContent=(place.address||'地址未提供')+' · '+coordText(place);btn.append(detail);
      btn.onclick=()=>{invalidateSearch();choosePlace(place);}; $('results').append(btn);
    }
  } catch { if (rev===queryRevision && !stopped) $('search-status').textContent='地点查询未完成。可以重试，也可输入已核对的 GPS 坐标。'; }
  finally { clearTimeout(timer); }
};
$('coords').onsubmit=e=>{e.preventDefault();if(trip && !proposing)return;invalidateSearch();choosePlace({name:$('place-name').value.trim(),lat:$('lat').valueAsNumber,lon:$('lon').valueAsNumber});};
$('copy').onclick=async()=>{
  if (!dest) return;const u=new URL('navigation.html',location.href);
  u.hash=new URLSearchParams({name:dest.name,lat:dest.lat,lon:dest.lon}).toString();
  try {await navigator.clipboard.writeText(u.href);say('已复制目的地链接。');} catch {window.prompt('复制目的地链接',u.href);}
};
$('recenter').onclick=()=>draw(true);
function stopGPS() {if (watch!==null) navigator.geolocation.clearWatch(watch);watch=null;ownFix=null;lastUpload=0;}
function render() {
  $('together').hidden=!bridge?.peer;
  $('search').hidden=!!trip && !proposing;$('manual').hidden=$('nearby').hidden=$('search').hidden;
  if($('search').hidden)$('amap-search').hidden=true;
  $('meeting').hidden=!trip?.active;
  $('wait-info').textContent=[trip?.myWait && '我等在：'+trip.myWait.name,trip?.peerWait && '好友等在：'+trip.peerWait.name].filter(Boolean).join(' · ');
  $('proposal').textContent=trip?.proposal?'提议的新会合点：'+trip.proposal.name+' · '+coordText(trip.proposal):'';
  $('agree').hidden=!trip?.proposal || trip.proposal.by===bridge?.me;
  $('invite').hidden=!dest || !!trip || !!requested;
  $('accept').hidden=!trip || trip.active || trip.inviter===bridge?.me;
  $('share').hidden=!trip?.active || watch!==null;
  $('end').hidden=!trip;
  $('trip-title').textContent=bridge?.peer?'和 '+bridge.peer+' 一起导航':'一起导航';
  if (!trip) $('trip-status').textContent=requested?'此邀请已结束或不可用。':'选好入口后可以邀请这位好友。';
  else $('trip-status').textContent=(trip.active?'双方已加入。选择共享后，好友可在本次同行中看见你的位置。':trip.inviter===bridge.me?'等待对方接受。':'对方邀请你前往上方地点。')+' 到期时间 '+new Date(trip.expires).toLocaleTimeString();
  $('other').textContent=fresh(peerFix)?'好友更新于 '+new Date(peerFix.time).toLocaleTimeString()+' · 精度约 '+Math.round(peerFix.accuracy)+' 米':trip?.active?(lastPeerTime?'好友最后更新于 '+new Date(lastPeerTime).toLocaleTimeString()+'，请等待新定位。':'好友尚未分享定位。'):'';
}
function setTrip(value) {
  const prev=trip;
  if (prev?.id!==value?.id) {++generation;lastPeerTime=0;proposing=false;choosing=false;stopGPS();$('gps').textContent='';}
  trip=value;peerFix=value?.peerFix||null;
  if (peerFix) lastPeerTime=peerFix.time;
  if (trip && (!prev || prev.id!==trip.id || JSON.stringify(prev.destination)!==JSON.stringify(trip.destination))) {invalidateSearch();select(trip.destination);}
  if (!trip && prev) say('本次同行已结束。');
  render();draw(!prev && !!value);
}
function backendError(err) {
  const missing=['PGRST202','42883'].includes(err?.code);
  say(missing?'这个环境尚未启用双人同行，单人地点和路线入口可继续使用。':String(err?.message||'网络暂不可用，请重试').slice(0,160));
}
async function action(op,id,value) {
  if (busy || stopped) return;
  busy=true;const seq=++generation;
  try {
    const result=await bridge.rpc(op,id,value);
    if(stopped || seq!==generation)return;
    say('');setTrip(result);
    if (op==='invite' && result) bridge.notify(result.id);
    if (op==='end') {requested=null;render();}
  } catch(err){if(!stopped)backendError(err);}
  finally {busy=false;}
}
async function poll() {
  if(stopped || busy || pollBusy || document.hidden || !bridge?.peer)return;
  pollBusy=true;const seq=generation;
  try {
    const value=await bridge.rpc('read',trip?.id || requested);
    if (!busy && !stopped && seq===generation) setTrip(value);
  } catch(err){if(!stopped)backendError(err);}
  finally{pollBusy=false;}
}
$('invite').onclick=()=>{if (dest) {inviteId ||= crypto.randomUUID();action('invite',inviteId,dest);}};
$('accept').onclick=()=>action('accept',trip?.id);
$('end').onclick=()=>{stopGPS();draw();action('end',trip?.id);};
$('change').onclick=()=>{proposing=!proposing;render();if(proposing)$('query').focus();};
$('agree').onclick=()=>{if(trip?.proposal)action('agree',trip.id,{key:trip.proposal.key});};
$('wait-here').onclick=()=>{
  const name=$('wait-note').value.trim();
  if(!fresh(ownFix) || !name){say('先共享本次定位，再写明入口或楼层。');return;}
  action('wait',trip.id,{lat:ownFix.lat,lon:ownFix.lon,name});
};
$('share').onclick=()=>{
  if (!trip?.active || watch!==null) return;
  if (!navigator.geolocation) {say('设备暂不支持定位。');return;}
  const id=trip.id; bridge.shareStarted(id); $('gps').textContent='等待设备定位…';
  watch=navigator.geolocation.watchPosition(async pos=>{
    if (stopped || watch===null || trip?.id!==id) return;
    ownFix={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy,time:pos.timestamp};
    if(!fresh(ownFix)){ownFix=null;draw();return;}
    draw();if(Date.now()-lastUpload<4000)return;
    lastUpload=Date.now();
    try{const result=await bridge.rpc('fix',id,ownFix);
      if(!stopped && trip?.id===id && watch!==null) {
        if(!result)setTrip(null);else $('gps').textContent='我的位置更新于 '+new Date(pos.timestamp).toLocaleTimeString();
      }
    }catch(err){if(!stopped && trip?.id===id)backendError(err);}
  },err=>{if(stopped || trip?.id!==id)return;if(err.code===1)stopGPS();$('gps').textContent=err.code===1?'你已拒绝定位，仍可查看会合点。':'设备暂未取得新定位。';render();},
  {enableHighAccuracy:true,maximumAge:0,timeout:15000});render();
};
const timer=setInterval(()=>{if(stopped)return;if(trip && Date.parse(trip.expires)<=Date.now())setTrip(null);render();draw();poll();},6000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){render();draw();poll();}});
function dispose() {stopped=true;++generation;clearInterval(timer);invalidateSearch();stopGPS();}
window.addEventListener('pagehide',dispose,{once:true});
window.stopChatterNavigation=dispose;
const params=new URLSearchParams(location.hash.slice(1));
if (params.has('lat') && params.has('lon') && params.get('lat').trim() && params.get('lon').trim()) {
  const p={name:params.get('name'),lat:Number(params.get('lat')),lon:Number(params.get('lon'))};if(validPlace(p))select(p);else say('地点链接无效，请重新选点。');
}
render();poll();
})();
