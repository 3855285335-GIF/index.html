/* Chatter service worker（可选）：只缓存本站的页面，先给缓存、后台更新；
   Supabase 接口、实时通道、图片语音等跨域请求一律不碰。更新页面后需要打开两次才会用上新版。 */
const V = 'chatter-v3';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(['./', 'index.html'].map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res && res.ok) c.put(r, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (r.mode === 'navigate') { const idx = await c.match('index.html'); if (idx) return idx; }
    return new Response('离线且无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
