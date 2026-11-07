/* Chatter 的后台小助手（service worker）：只做两件事——收到推送时弹通知、点通知时打开对应的聊天。
   不缓存任何页面（以前那种“先给缓存、后台更新”的做法会让新版本要打开两次才生效，这里不用），
   所以它不会影响网页更新。构建时会把下面的版本号换成当前 build。 */
const SW_BUILD = '4.0';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (x) {}   // 清掉旧版本可能留下的页面缓存
  await self.clients.claim();
})()));

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
  if (d.badge != null && self.navigator && self.navigator.setAppBadge) {   // 主屏幕图标上的未读数（iPhone 16.4+ / 部分安卓）
    try { if (+d.badge > 0) await self.navigator.setAppBadge(+d.badge); else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } catch (x) {}
  }
  // 每次推送都一定要弹通知（苹果的规定：收到推送却不弹，会被系统收回推送权限）
  await self.registration.showNotification(title, opt);
  try {   // 告诉开着的页面：正看着这个聊天的话，页面会把通知收起来
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(c => { try { c.postMessage({ t: 'pushed', tag: opt.tag, kind, from: opt.data.from }); } catch (x) {} });
  } catch (x) {}
}

async function openUrl(u) {
  const url = new URL(u || './', self.registration.scope).href;
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const c = list.find(x => x.url.indexOf(self.registration.scope) === 0) || list[0];
  if (c) {   // App 已经开着（可能在后台）：切到前台，让它自己打开那个聊天
    try { c.postMessage({ t: 'open', url }); } catch (x) {}
    try { await c.focus(); } catch (x) {}
    return 'focus';
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
