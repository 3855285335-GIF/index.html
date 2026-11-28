/* Chatter 的后台小助手（service worker）：
   1) 收到推送时弹通知、点通知打开对应的聊天；
   2) 加速打开：带版本号的程序文件（app.js?v=…）和依赖库存在手机里，第二次打开不用再下载；
      页面本身先联网取，2.5 秒取不到才用手机里存的（所以新版本照样第一次打开就生效，网不好时也能秒开）；
   3) 聊天和朋友圈的图片存在手机里（最多 300 张），看过的图再打开不用重新下载。 */
const SW_BUILD = '4.4';
const SHELL = 'chatter-shell-v1', IMG = 'chatter-img-v1', IMG_MAX = 300;
const IMG_PREFIX = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/';

self.addEventListener('install', e => e.waitUntil((async () => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
    const vendor = new URL('vendor/supabase-2.45.4.js', self.registration.scope);
    const request = new Request(vendor.href, { signal: controller.signal });
    await (await caches.open(SHELL)).add(request);
  } catch (x) { /* The shell can still load and cache the dependency on demand. */ }
  finally { clearTimeout(timer); }
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.filter(k => /^chatter-(shell|img)-/.test(k) && k !== SHELL && k !== IMG).map(k => caches.delete(k))); } catch (x) {}   // 只清旧版本留下的缓存
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (url === new URL('manifest.webmanifest', self.registration.scope).href) {
    e.respondWith(launchManifest(req));
    return;
  }
  if (url.indexOf(IMG_PREFIX) === 0) {   // 图片（不碰视频/语音：它们要分段加载）
    if (req.destination === 'image' && !req.headers.get('range')) e.respondWith(imgFirst(req));
    return;
  }
  let u; try { u = new URL(url); } catch (x) { return; }
  if (u.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (u.pathname.indexOf(scope.pathname) !== 0 || u.pathname.indexOf('/review/') >= 0) return;
  if (req.mode === 'navigate' && (u.pathname === scope.pathname || u.pathname === scope.pathname + 'index.html')) {
    const c = caches.open(SHELL), key = scope.href;
    const net = fetch(req).then(async r => {
      if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) {
        try { await (await c).put(key, r.clone()); } catch (x) {}
      }
      return r;
    });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(pageFirst(net, c, key, u));
    return;
  }
  if (u.searchParams.has('retry')) return;
  if (u.searchParams.has('v') || u.pathname.indexOf('/vendor/') >= 0) e.respondWith(keepFirst(req));
});

// 安装标识、作用域和图标仍来自同一份 manifest，只按本机主题调整系统启动底色。
async function launchManifest(req) {
  let response, cache;
  try { cache = await caches.open(SHELL); } catch (e) {}
  try {
    response = await fetch(req);
    if (cache && response.ok) await cache.put(req, response.clone()).catch(() => {});
  } catch (err) {
    response = cache && await cache.match(req);
    if (!response) throw err;
  }
  if (!response.ok || !cache) return response;
  try {
    const pref = await cache.match(new URL('.chatter-launch-theme', self.registration.scope).href);
    if (!pref) return response;
    const theme = await pref.text();
    if (theme !== 'light' && theme !== 'dark') return response;
    const manifest = await response.clone().json();
    manifest.background_color = theme === 'dark' ? '#12101c' : '#f6f3ee';
    manifest.theme_color = manifest.background_color;
    return new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' }
    });
  } catch (e) { return response; }
}

async function pageFirst(net, cache, key, u) {
  let saved;
  try {
    const c = await cache;
    saved = await c.match(key) || await c.match(u.origin + u.pathname);
  } catch (x) {}
  if (!saved) return net;
  let timer;
  try {
    return await Promise.race([
      net.then(r => r.ok ? r : saved, () => saved),
      new Promise(res => { timer = setTimeout(() => res(saved), 2500); })
    ]);
  } finally { clearTimeout(timer); }
}
async function keepFirst(req) {   // 带版本号的文件内容不会变：有就直接用
  let c, hit;
  try { c = await caches.open(SHELL); hit = await c.match(req); } catch { return fetch(req); }
  if (hit) return hit;
  const r = await fetch(req);
  if (r && r.ok) { try { await c.put(req, r.clone()); } catch (x) {} }
  return r;
}
let imgPuts = 0;
async function imgFirst(req) {
  let c, hit;
  const key = req.url.replace(/[?&]r=\d+$/, '');
  try { c = await caches.open(IMG); hit = await c.match(key); } catch { return fetch(req); }
  if (hit) return hit;
  let r;
  try { r = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); }
  catch (x) { return fetch(req); }   // 跨域取不了就按原样取（不存）
  if (r && r.ok) {
    try { await c.put(key, r.clone()); } catch (x) {}
    if (++imgPuts % 20 === 0) await trimImgs(c);
  }
  return r;
}
async function trimImgs(c) {   // 超过 300 张就删最早存的
  try { const ks = await c.keys(); for (let i = 0; i < ks.length - IMG_MAX; i++) await c.delete(ks[i]); } catch (x) {}
}

function readPush(e) {
  if (!e.data) return {};
  try { return e.data.json() || {}; } catch (x) { try { return { body: e.data.text() }; } catch (y) { return {}; } }
}

async function show(d) {
  d = d || {};
  const kind = d.kind || 'msg';
  const title = String(d.title || 'Chatter').slice(0, 80);
  const opt = {
    body: String(d.body || '你有一条新消息').slice(0, 240),
    tag: String(d.tag || 'chatter'), renotify: true,
    icon: 'icon-192.png', badge: 'badge-96.png',
    timestamp: d.ts || Date.now(),
    data: { url: d.url || './', kind, from: d.from || '' }
  };
  if (kind === 'call') { opt.requireInteraction = true; opt.vibrate = [600, 300, 600, 300, 600, 300, 600]; }   // 来电：一直留着、震久一点
  else opt.vibrate = [180];
  // 每次推送都一定要弹通知（苹果的规定：收到推送却不弹，会被系统收回推送权限）
  await self.registration.showNotification(title, opt);
  try {   // 告诉开着的页面：正看着这个聊天的话，页面会把通知收起来
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(c => { try { c.postMessage({ t: 'pushed', tag: opt.tag, kind, from: opt.data.from }); } catch (x) {} });
  } catch (x) {}
  if (d.badge != null && self.navigator && self.navigator.setAppBadge) {   // 主屏幕图标上的未读数（iPhone 16.4+ / 部分安卓）
    try { if (+d.badge > 0) await self.navigator.setAppBadge(+d.badge); else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } catch (x) {}
  }
}

async function openUrl(u) {
  const scope = new URL(self.registration.scope);
  let url = scope.href;
  try {
    const dest = new URL(u || './', scope);
    if (dest.origin === scope.origin && (dest.pathname === scope.pathname || dest.pathname === scope.pathname + 'index.html') && !dest.search) url = dest.href;
  } catch (x) {}
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of list) {
    try {
      const page = new URL(client.url);
      if (page.origin !== scope.origin || (page.pathname !== scope.pathname && page.pathname !== scope.pathname + 'index.html')) continue;
      await client.focus();
      client.postMessage({ t: 'open', url });
      return 'focus';
    } catch (x) { /* 窗口可能刚被系统回收，继续找能接收此次点击的窗口。 */ }
  }
  if (self.clients.openWindow) { await self.clients.openWindow(url); return 'open'; }
  return 'none';
}

self.addEventListener('push', e => { e.waitUntil(show(readPush(e))); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(openUrl((e.notification.data || {}).url));
});
// 系统换了推送地址：通知开着的页面重新登记（页面每次打开也会自己检查一遍）
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.forEach(c => { try { c.postMessage({ t: 'resub' }); } catch (x) {} })));
});
self.__chatter = { show, openUrl, build: SW_BUILD };   // 给测试用
