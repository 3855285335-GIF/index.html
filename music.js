/* Chatter 音乐：用 Audius（免费、公开的独立音乐库，不用注册、不用密钥）找歌、听歌。
   - 歌和封面由手机直接从 Audius 下载，不经过我们的服务器：不花 Supabase 的免费流量和次数。
   - 点“应用 → 音乐”才下载这个文件；上次听过歌的，打开 App 一会儿后在空闲时加载，底部恢复迷你播放条（不自动播放）。
   - 颜色、字体全部用 App 的主题变量，跟着“我”里的主题和字体走。
   - 喜欢的歌、最近播放、播放列表存在这台手机里（按账号分开，退出登录清掉）。
   Audius 的接口 11-20 在 GitHub 服务器上实测过：节点列表 https://api.audius.co/、搜歌 /v1/tracks/search、热门 /v1/tracks/trending，
   不用密钥、允许跨域；播放地址 /v1/tracks/{id}/stream 会跳到真正的音乐文件；能不能播看 access.stream（is_streamable 不准）。 */
(function () {
'use strict';
if (window.ChatterMusic) return;
const B = window.__chWS;
if (!B) return;

/* ---------- 小工具 ---------- */
const APP = 'Chatter', MAIN = 'https://api.audius.co';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LSg = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const LSs = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 存不下就算了 */ } };
const uidKey = k => k + ':' + (B.uid() || '');
const mmss = s => { s = Math.max(0, Math.floor(+s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x; };
const ico = (d, w) => '<svg viewBox="0 0 24 24" width="' + (w || 22) + '" height="' + (w || 22) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const I = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  find: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 5.5v13l9-6.5z" fill="currentColor" stroke="none"/><path d="M18 5.5v13"/>',
  prev: '<path d="M18 5.5v13l-9-6.5z" fill="currentColor" stroke="none"/><path d="M6 5.5v13"/>',
  heart: '<path d="M12 19.5s-7-4.3-7-9.5a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.2-7 9.5-7 9.5z"/>',
  heartOn: '<path d="M12 19.5s-7-4.3-7-9.5a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.2-7 9.5-7 9.5z" fill="currentColor"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  list: '<path d="M4 7l16 0M4 12h16M4 17h10"/><path d="M17.5 15.5l3 1.5-3 1.5z" fill="currentColor"/>',
  one: '<path d="M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3"/><path d="M11.5 10.5l1-.7V14.5"/>',
  loop: '<path d="M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3"/>',
  shuffle: '<path d="M4 7h3.5c2 0 3 1 4.5 3.5l1 1.7C14.5 15 15.5 17 18 17h2M17 14l3 3-3 3M4 17h3.5c1.3 0 2.2-.5 3-1.4M20 7h-2c-1.4 0-2.4.6-3.2 1.6M17 4l3 3-3 3"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  send: '<path d="M4 12l16-7-6 16-3-6.5z"/>'
};
// 曲风（Audius 的曲风名字，11-20 在 GitHub 服务器上实测过能用来查热门）
const GENRES = [['', '热门'], ['Electronic', '电子'], ['Hip-Hop/Rap', '嘻哈'], ['Pop', '流行'], ['Rock', '摇滚'], ['Lo-Fi', 'Lo-Fi'], ['Ambient', '氛围'], ['Jazz', '爵士'], ['Classical', '古典'], ['R&B/Soul', 'R&B'], ['Soundtrack', '配乐']];
const MODES = [['list', '列表循环', I.loop], ['one', '单曲循环', I.one], ['shuffle', '随机播放', I.shuffle]];

/* ---------- Audius 接口：手机直接请求 ---------- */
const AU = { host: '' };
async function getJson(u, ms) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ac ? setTimeout(() => { try { ac.abort(); } catch (e) { /* 已经结束 */ } }, ms || 12000) : 0;
  let r;
  try { r = await fetch(u, { signal: ac ? ac.signal : undefined, credentials: 'omit' }); }
  catch (e) { clearTimeout(t); const x = new Error(e && e.name === 'AbortError' ? '等太久了，网络可能不太好' : '连不上 Audius，检查一下网络'); x.code = 'net'; throw x; }
  clearTimeout(t);
  if (!r.ok) { const x = new Error(r.status === 429 ? 'Audius 现在太忙，等一会儿再试' : 'Audius 出错了（' + r.status + '）'); x.code = r.status === 429 ? 'busy' : 'http'; throw x; }
  try { return await r.json(); } catch (e) { const x = new Error('Audius 返回的内容看不懂'); x.code = 'http'; throw x; }
}
async function auHost() {   // 先问 Audius 现在用哪个服务器（记一天）；问不到就用主服务器
  if (AU.host) return AU.host;
  const c = LSg('ch2muHost', null);
  if (c && c.h && Date.now() - c.t < 86400000) { AU.host = c.h; return c.h; }
  try {
    const j = await getJson(MAIN + '/', 8000), list = ((j && j.data) || []).filter(h => typeof h === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(h));
    if (list.length) { AU.host = list[Math.floor(Math.random() * list.length)]; LSs('ch2muHost', { h: AU.host, t: Date.now() }); return AU.host; }
  } catch (e) { /* 用主服务器 */ }
  AU.host = MAIN; return MAIN;
}
async function au(path, params) {
  const h = await auHost(), q = new URLSearchParams(Object.assign({ app_name: APP }, params || {})).toString();
  try { return await getJson(h + '/v1' + path + '?' + q, 12000); }
  catch (e) {
    if (h === MAIN || e.code === 'busy') throw e;
    AU.host = MAIN; LSs('ch2muHost', null);   // 那个服务器不行：换主服务器再试一次
    return await getJson(MAIN + '/v1' + path + '?' + q, 12000);
  }
}
const streamUrl = id => (AU.host || MAIN) + '/v1/tracks/' + encodeURIComponent(id) + '/stream?app_name=' + APP;
function toTrack(x) {   // 只留要用的几项；不能直接播的（删了、不公开、要付费 / 关注才能听）不要
  if (!x || !x.id || x.is_delete || x.is_unlisted || x.is_available === false) return null;
  if ((x.access && x.access.stream === false) || x.is_stream_gated || x.stream_conditions) return null;
  const aw = x.artwork || {}, u = x.user || {};
  return {
    id: String(x.id), t: String(x.title || '没有名字'), a: String(u.name || u.handle || ''), d: Math.round(+x.duration || 0),
    s: aw['150x150'] || '', m: aw['480x480'] || aw['150x150'] || '', l: aw['1000x1000'] || aw['480x480'] || '',
    mir: Array.isArray(aw.mirrors) ? aw.mirrors.filter(h => typeof h === 'string').slice(0, 3) : [], p: String(x.permalink || '')
  };
}
const tracksOf = j => ((j && j.data) || []).map(toTrack).filter(Boolean);

/* ---------- 状态 ---------- */
const M = {
  on: false, stack: [], quiet: false,
  q: [], i: -1, mode: 'list', order: null,   // 播放列表、正在放第几首、播放方式；随机时的顺序
  lists: {}, seq: 0, wait: false, failRow: 0
};
let root = null, audio = null, mini = null, acct = 0, saveT = 0;
const cur = () => M.q[M.i] || null;
const likes = () => LSg(uidKey('ch2muLike'), []);
const recent = () => LSg(uidKey('ch2muRecent'), []);
const isLiked = id => likes().some(x => x.id === id);
function toggleLike(t) {
  if (!t) return false;
  const a = likes(), on = !a.some(x => x.id === t.id);
  LSs(uidKey('ch2muLike'), on ? [t].concat(a).slice(0, 500) : a.filter(x => x.id !== t.id));
  return on;
}
function addRecent(t) { LSs(uidKey('ch2muRecent'), [t].concat(recent().filter(x => x.id !== t.id)).slice(0, 50)); }
function saveSync() {   // 播放列表和位置存在手机里：重开 App 还能接着听（不自动播放）
  clearTimeout(saveT); M.savedAt = Date.now();
  const t = cur(); if (!t || !B.uid()) return;
  const keep = Math.max(0, M.i - 50), q = M.q.slice(keep, keep + 100);   // 最多存 100 首（正在放的这首前后）
  LSs(uidKey('ch2muNow'), { q: q, i: M.i - keep, mode: M.mode, at: audio && audio.src ? Math.floor(audio.currentTime || 0) : (M.resumeAt || 0) });
}
function saveNow() { clearTimeout(saveT); saveT = setTimeout(saveSync, 400); }

/* ---------- 样式 ---------- */
const CSS = `
.mu{position:fixed;inset:0;z-index:62;display:none;background:var(--bg);color:var(--ink);font-family:var(--font)}
.mu.on{display:block}
.mu a[href]{-webkit-touch-callout:none}
.mu-v{position:absolute;inset:0;display:none;flex-direction:column;background:var(--bg)}
.mu-v.on{display:flex}
.mu-in{width:100%;max-width:760px;margin:0 auto}
.mu-bar{display:flex;align-items:center;gap:6px;padding:10px 12px 8px;padding-top:calc(10px + env(safe-area-inset-top));flex-shrink:0}
.mu-ib{width:44px;height:44px;border-radius:14px;padding:0;background:transparent;color:var(--ink);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.mu-ib:active,.mu-chip:active,.mu-btn:active{opacity:.55}
.mu-field{flex:1;min-width:0;display:flex;align-items:center;gap:10px;height:46px;padding:0 6px 0 14px;background:var(--surface);border-radius:16px;box-shadow:var(--shadow);margin:0}
.mu-field>svg{color:var(--accent);flex-shrink:0}
.mu-field input{flex:1;min-width:0;border:0;padding:0;height:44px;background:transparent;box-shadow:none;border-radius:0;font-size:16px;color:var(--ink)}
.mu-field input:focus{box-shadow:none;border:0}
.mu-field input::-webkit-search-cancel-button{display:none}
.mu-clr{width:34px;height:34px;border-radius:12px;padding:0;background:transparent;color:var(--muted);display:none;align-items:center;justify-content:center;flex-shrink:0}
.mu-field.has .mu-clr{display:flex}
.mu-ttl{flex:1;min-width:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
.mu-sc{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding-bottom:calc(16px + env(safe-area-inset-bottom))}
.mu-chips{display:flex;gap:8px;overflow-x:auto;padding:4px 12px 10px;scrollbar-width:none;flex-shrink:0}
.mu-chips::-webkit-scrollbar{display:none}
.mu-chip{flex-shrink:0;height:34px;padding:0 14px;border-radius:17px;background:var(--surface);color:var(--ink);font-size:14px;box-shadow:var(--shadow)}
.mu-chip.act{background:var(--accent);color:#fff}
.mu-quick{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:2px 12px 4px}
.mu-quick button{display:flex;align-items:center;gap:8px;height:48px;padding:0 14px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow);color:var(--ink);font-size:15px;min-width:0}
.mu-quick button svg{color:var(--accent);flex-shrink:0}
.mu-quick b{margin-left:auto;font-weight:500;color:var(--muted);font-size:13px}
.mu-sec{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 8px;font-size:13px;color:var(--muted)}
.mu-sec button{background:transparent;color:var(--accent);font-size:13px;padding:2px 4px}
.mu-list{margin:0 12px;background:var(--surface);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
.mu-row{display:flex;align-items:center;gap:12px;padding:9px 6px 9px 10px;cursor:pointer;border-bottom:1px solid var(--line)}
.mu-row:last-child{border-bottom:0}
.mu-row:active{background:var(--surface2)}
.mu-row.cur .mu-rt{color:var(--accent)}
.mu-art{width:46px;height:46px;border-radius:10px;object-fit:cover;background:var(--surface2);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.mu-tx{flex:1;min-width:0}
.mu-rt{font-size:15px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mu-rs{font-size:12.5px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mu-more{width:40px;height:40px;border-radius:12px;padding:0;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.mu-msg{margin:16px 12px;padding:22px 18px;border-radius:18px;background:var(--surface);box-shadow:var(--shadow);text-align:center;color:var(--muted);font-size:14px;line-height:1.6}
.mu-msg b{display:block;color:var(--ink);font-size:15px;margin-bottom:4px;font-weight:600}
.mu-btn{height:44px;padding:0 18px;border-radius:14px;background:var(--surface2);color:var(--ink);font-size:14px;margin:12px 6px 0}
.mu-btn.pri{background:var(--accent);color:#fff}
.mu-skel{height:64px;margin:0;border-bottom:1px solid var(--line);background:linear-gradient(90deg,var(--surface) 0,var(--surface2) 50%,var(--surface) 100%);background-size:200% 100%;animation:muSk 1.2s linear infinite}
@keyframes muSk{to{background-position:-200% 0}}
.mu-from{padding:14px 16px;font-size:12px;color:var(--muted);text-align:center}
.mu-from a{color:var(--muted)}
.mu-now{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 24px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center}
.mu-big{width:min(78vw,340px,42vh);aspect-ratio:1;border-radius:22px;object-fit:cover;background:var(--surface2);box-shadow:0 14px 40px rgba(0,0,0,.18);margin:8px 0 22px;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.mu-nt{width:100%;max-width:420px;display:flex;align-items:center;gap:10px}
.mu-nt .mu-tx{text-align:left}
.mu-nt .mu-rt{font-size:19px;font-weight:600;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mu-nt .mu-rs{font-size:14px}
.mu-like.on{color:var(--accent2)}
.mu-prog{width:100%;max-width:420px;margin-top:18px}
.mu-prog input{width:100%;margin:0;accent-color:var(--accent);height:28px}
.mu-times{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.mu-ctl{display:flex;align-items:center;justify-content:center;gap:clamp(4px,2.5vw,18px);margin-top:10px;width:100%;max-width:420px}
.mu-ctl .mu-ib{width:clamp(40px,12vw,52px);height:clamp(40px,12vw,52px);border-radius:18px}
.mu-pp{width:clamp(60px,18vw,72px)!important;height:clamp(60px,18vw,72px)!important;border-radius:36px!important;background:var(--accent)!important;color:#fff!important;box-shadow:0 8px 22px color-mix(in srgb,var(--accent) 40%,transparent)}
.mu-side{color:var(--muted)!important}
.mu-side.on{color:var(--accent)!important}
.mu-state{min-height:18px;margin-top:6px;font-size:12.5px;color:var(--muted)}
.mu-up{width:100%;max-width:420px;margin-top:18px}
.mu-up .mu-sec{padding-left:4px;padding-right:4px}
.mu-up .mu-list{margin:0}
#mu-mini{display:none;align-items:center;gap:10px;margin:0 10px 6px;padding:7px 6px 7px 7px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow);position:relative;overflow:hidden;flex-shrink:0;cursor:pointer}
#mu-mini.on{display:flex}
#mu-mini .mu-art{width:40px;height:40px;border-radius:9px}
#mu-mini .mu-rt{font-size:14px}
#mu-mini .mu-ib{width:40px;height:40px}
#mu-mini i{position:absolute;left:0;bottom:0;height:2px;background:var(--accent);width:0}
body.chat-open #mu-mini{display:none}
`;

/* ---------- 页面 ---------- */
function bar(ph) {
  return '<div class="mu-bar mu-in"><button type="button" class="mu-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button>' +
    '<form class="mu-field" action="#" role="search">' + ico(I.find, 18) + '<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(ph) + '" aria-label="' + esc(ph) + '">' +
    '<button type="button" class="mu-clr" data-act="clear" aria-label="清空">' + ico(I.x, 16) + '</button></form></div>';
}
function build() {
  if (root) return;
  if (!document.getElementById('mu-css')) { const st = document.createElement('style'); st.id = 'mu-css'; st.textContent = CSS; document.head.appendChild(st); }
  root = document.createElement('div'); root.id = 'mu'; root.className = 'mu'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '音乐');
  root.innerHTML =
    '<section class="mu-v" data-v="home">' + bar('搜歌、歌手（英文搜得更多）') + '<div class="mu-chips mu-in" data-r="genres"></div><div class="mu-sc"><div class="mu-in" data-r="home"></div></div></section>' +
    '<section class="mu-v" data-v="list"><div class="mu-bar mu-in"><button type="button" class="mu-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="mu-ttl" data-r="ltitle"></span><span style="width:44px"></span></div><div class="mu-sc"><div class="mu-in" data-r="list"></div></div></section>' +
    '<section class="mu-v" data-v="now"><div class="mu-bar mu-in"><button type="button" class="mu-ib" data-act="back" aria-label="收起">' + ico(I.down) + '</button><span class="mu-ttl" style="font-weight:500;color:var(--muted);font-size:14px">正在播放</span><button type="button" class="mu-ib" data-act="now-more" aria-label="更多">' + ico(I.more) + '</button></div><div class="mu-now" data-r="now"></div></section>';
  (document.querySelector('.app-container') || document.body).appendChild(root);
  root.addEventListener('click', onClick);
  root.addEventListener('submit', e => { e.preventDefault(); const inp = e.target.querySelector('input'); try { inp.blur(); } catch (x) { /* 没关系 */ } search(inp.value); });
  root.addEventListener('input', e => {
    const f = e.target.closest && e.target.closest('.mu-field'); if (f) f.classList.toggle('has', !!e.target.value);
    if (e.target.dataset && e.target.dataset.r === 'seek') { const t = cur(), d = (audio && isFinite(audio.duration) && audio.duration) || (t && t.d) || 0; R('t0').textContent = mmss(d * e.target.value / 1000); M.seeking = true; }
  });
  root.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.r === 'seek') { seekTo(+e.target.value / 1000); M.seeking = false; } });
  root.addEventListener('error', e => { const im = e.target; if (im && im.tagName === 'IMG') artFallback(im); }, true);
}
const R = k => root.querySelector('[data-r="' + k + '"]');
const V = v => root.querySelector('.mu-v[data-v="' + v + '"]');
function artFallback(im) {   // 封面的服务器连不上：换 Audius 给的备用服务器，再不行就显示音符
  const mir = (im.dataset.mir || '').split(' ').filter(Boolean), n = +(im.dataset.n || 0);
  if (n < mir.length) { im.dataset.n = n + 1; im.src = String(im.getAttribute('src') || '').replace(/^https?:\/\/[^/]+/, mir[n]); return; }
  const d = document.createElement('div'); d.className = im.className; d.innerHTML = ico(I.note, im.classList.contains('mu-big') ? 64 : 20); im.replaceWith(d);
}
const art = (t, size, cls) => {
  const src = t && (size === 'l' ? t.l : size === 'm' ? t.m : t.s);
  return src ? '<img class="' + cls + '" src="' + esc(src) + '" data-mir="' + esc((t.mir || []).join(' ')) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<div class="' + cls + '">' + ico(I.note, cls === 'mu-big' ? 64 : 20) + '</div>';
};
function rows(list, from) {   // from：这串歌属于哪个列表（点了就把它作为播放列表）
  const c = cur();
  return '<div class="mu-list">' + list.map((t, i) => '<div class="mu-row' + (c && c.id === t.id ? ' cur' : '') + '" data-act="row" data-from="' + esc(from) + '" data-i="' + i + '">' + art(t, 's', 'mu-art') +
    '<div class="mu-tx"><div class="mu-rt">' + esc(t.t) + '</div><div class="mu-rs">' + esc([t.a, t.d ? mmss(t.d) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
    '<button type="button" class="mu-more" data-act="row-more" data-from="' + esc(from) + '" data-i="' + i + '" aria-label="更多">' + ico(I.more, 18) + '</button></div>').join('') + '</div>';
}
const skel = n => '<div class="mu-list">' + Array.from({ length: n || 6 }, () => '<div class="mu-skel"></div>').join('') + '</div>';
const msg = (title, sub, btn) => '<div class="mu-msg"><b>' + esc(title) + '</b>' + esc(sub || '') + (btn ? '<div>' + btn + '</div>' : '') + '</div>';

/* ---------- 页面栈和返回手势（和搜索一样：每进一层加一条浏览器历史） ---------- */
const top = () => M.stack[M.stack.length - 1];
function show() {
  const t = top(); if (!t) return;
  root.querySelectorAll('.mu-v').forEach(el => el.classList.toggle('on', el.dataset.v === t.v));
  if (t.v === 'home') renderHome(); else if (t.v === 'list') renderList(t); else if (t.v === 'now') renderNow();
}
function go(v, d) {
  M.stack.push({ v: v, d: d || {} });
  try { history.pushState({ mu: M.stack.length }, '', location.href); } catch (e) { /* 没关系 */ }
  show();
}
function back() { if (history.state && history.state.mu) { try { history.back(); return; } catch (e) { /* 换下面 */ } } popTo(M.stack.length - 1); }
function popTo(n) { M.stack.length = Math.max(0, Math.min(n, M.stack.length)); if (!M.stack.length) { close(); return; } show(); }
function onPop(e) { if (!M.on) return false; const st = (e && e.state) || history.state; popTo((st && st.mu) || 0); return true; }
function open(v) {
  build(); ensureAudio(); restore();
  if (!M.on) { M.on = true; root.classList.add('on'); document.body.classList.add('mu-open'); go(v === 'now' && cur() ? 'now' : 'home'); return; }   // 从迷你条点进来：只有“正在播放”这一层，返回就关掉
  if (v === 'now' && cur() && top().v !== 'now') go('now');
}
function close() { M.on = false; M.stack.length = 0; if (root) root.classList.remove('on'); document.body.classList.remove('mu-open'); paintMini(); }

/* ---------- 首页：搜索框、曲风、我喜欢 / 最近播放、热门 ---------- */
function renderHome() {
  const g = M.genre || '';
  R('genres').innerHTML = GENRES.map(x => '<button type="button" class="mu-chip' + (g === x[0] ? ' act' : '') + '" data-act="genre" data-g="' + esc(x[0]) + '">' + esc(x[1]) + '</button>').join('');
  const nl = likes().length, rc = recent();
  let h = '<div class="mu-quick"><button type="button" data-act="likes">' + ico(I.heart, 19) + '我喜欢<b>' + (nl || '') + '</b></button><button type="button" data-act="recent">' + ico(I.clock, 19) + '最近播放<b>' + (rc.length || '') + '</b></button></div>';
  const key = 'trend:' + g, L = M.lists[key];
  h += '<div class="mu-sec">' + esc((GENRES.find(x => x[0] === g) || GENRES[0])[1]) + (g ? ' · 本周热门' : ' · 本周') + '</div>';
  if (!L || L.loading) h += skel(8);
  else if (L.err) h += msg('没取到歌', L.err, '<button type="button" class="mu-btn pri" data-act="retry" data-k="' + esc(key) + '">重试</button>');
  else if (!L.items.length) h += msg('这一类暂时没有能直接听的歌', '换一类看看');
  else h += rows(L.items, key);
  h += '<div class="mu-from">歌来自 <a href="https://audius.co" data-act="audius">Audius</a>（免费、公开的独立音乐库），由手机直接播放</div>';
  R('home').innerHTML = h;
  if (!L) loadList(key);
}
async function loadList(key, more) {   // key：'trend:曲风' 热门 / 'q:搜索词' 搜索
  const L = M.lists[key] = more ? M.lists[key] : { items: [], loading: true, err: '', done: false };
  if (more) { if (L.loading || L.done) return; L.loading = true; L.more = true; }
  const my = ++M.seq, account = acct;
  let r = null, err = '';
  try {
    if (key.indexOf('trend:') === 0) { const g = key.slice(6); r = tracksOf(await au('/tracks/trending', Object.assign({ time: 'week', limit: 50 }, g ? { genre: g } : {}))); }
    else r = tracksOf(await au('/tracks/search', { query: key.slice(2), limit: 30, offset: L.items.length }));
  } catch (e) { err = (e && e.message) || '出错了'; }
  if (account !== acct) return;
  L.loading = false; L.more = false;
  if (err) { if (!more) L.err = err; else B.toast(err); }
  else {
    const seen = new Set(L.items.map(x => x.id));
    const add = r.filter(x => !seen.has(x.id));
    L.items = L.items.concat(add);
    L.done = key.indexOf('trend:') === 0 || r.length < 20 || !add.length;   // 热门一次拿 50 首就够；搜索不满一页说明没有了
  }
  void my;
  const t = M.on && top(); if (t && (t.v === 'home' || (t.v === 'list' && t.d.key === key))) show();
}

/* ---------- 列表页：搜索结果、我喜欢、最近播放 ---------- */
function search(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim(); if (!q) return;
  const key = 'q:' + q.toLowerCase();
  if (!M.lists[key] || M.lists[key].err) delete M.lists[key];
  const t = top();
  if (t && t.v === 'list' && t.d.key && t.d.key.indexOf('q:') === 0) { t.d = { key: key, title: q }; show(); } else go('list', { key: key, title: q });
}
function listOf(key) {
  if (key === 'likes') return { items: likes(), done: true };
  if (key === 'recent') return { items: recent(), done: true };
  return M.lists[key] || null;
}
function renderList(t) {
  const key = t.d.key, L = listOf(key);
  R('ltitle').textContent = key === 'likes' ? '我喜欢' : key === 'recent' ? '最近播放' : '搜「' + t.d.title + '」';
  const box = R('list'); let h = '';
  if (!L || (L.loading && !L.items.length)) { h = skel(8); if (!L) loadList(key); }
  else if (L.err && !L.items.length) h = msg('没搜到', L.err, '<button type="button" class="mu-btn pri" data-act="retry" data-k="' + esc(key) + '">重试</button>');
  else if (!L.items.length) h = key === 'likes' ? msg('还没有喜欢的歌', '听歌时点 ♡ 就会存在这里') : key === 'recent' ? msg('还没听过歌', '') : msg('没找到能直接听的歌', 'Audius 是独立音乐人的曲库，很多大明星的歌没有；换个说法，或者用英文搜');
  else {
    h = '<div style="padding:4px 0 2px">' + rows(L.items, key) + '</div>';
    if (key.indexOf('q:') === 0) h += L.done ? '<div class="mu-from">没有更多了</div>' : '<div style="text-align:center"><button type="button" class="mu-btn" data-act="more-res" data-k="' + esc(key) + '"' + (L.more ? ' disabled' : '') + '>' + (L.more ? '正在加载…' : '加载更多') + '</button></div>';
  }
  box.innerHTML = h;
}

/* ---------- 播放 ---------- */
function ensureAudio() {
  if (audio) return audio;
  audio = document.createElement('audio');
  audio.id = 'mu-audio'; audio.preload = 'auto'; audio.setAttribute('playsinline', ''); audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('play', () => { M.wait = false; paint(); });
  audio.addEventListener('playing', () => { M.wait = false; M.failRow = 0; paint(); });
  audio.addEventListener('pause', () => { paint(); saveNow(); });
  audio.addEventListener('waiting', () => { M.wait = true; paintState(); });
  audio.addEventListener('ended', () => onEnded());
  audio.addEventListener('error', () => onAudioError());
  audio.addEventListener('loadedmetadata', () => { if (M.resumeAt) { try { audio.currentTime = M.resumeAt; } catch (e) { /* 不支持就从头 */ } M.resumeAt = 0; } paintProg(); });
  audio.addEventListener('timeupdate', () => { paintProg(); if (Date.now() - (M.savedAt || 0) > 5000) saveSync(); });   // 放的时候每 5 秒记一次位置
  document.addEventListener('visibilitychange', () => { if (document.hidden && cur()) saveSync(); });   // 切到后台、锁屏：马上记下
  // 别的声音（语音消息、视频、通话）开始放：音乐先停，免得两个声音叠在一起（iPhone 上还可能让通话没声音）
  document.addEventListener('play', e => { const x = e.target; if (x !== audio && !x.muted && audio && !audio.paused) audio.pause(); }, true);   // 静音的视频（比如通话里自己的画面）不算
  setupSession();
  return audio;
}
function playAt(list, i, from) {   // 把这串歌作为播放列表，从第 i 首开始放
  if (!list || !list[i]) return;
  M.q = list.slice(0, 200); M.i = i; M.order = null; M.from = from || '';
  startCur(true);
}
function startCur(autoplay, keepPos) {   // keepPos：重开 App 后第一次点播放，从上次的位置接着放
  const t = cur(); if (!t) return;
  if (!keepPos) M.resumeAt = 0;
  ensureAudio();
  M.wait = !!autoplay;
  audio.src = streamUrl(t.id);
  if (autoplay) { const p = audio.play(); if (p && p.catch) p.catch(err => { if (err && err.name === 'NotAllowedError') { M.wait = false; paint(); } }); }
  addRecent(t); setMeta(t); saveNow();
  if (root && M.on && top() && top().v === 'now') renderNow(); else paint();   // 换了歌：正在播放页整页换成新的这首
}
function toggle() {
  const t = cur(); if (!t) return;
  ensureAudio();
  if (!audio.src) { startCur(true, true); return; }
  if (audio.paused) { const p = audio.play(); if (p && p.catch) p.catch(() => { /* 没在点击里，系统不让放 */ }); } else audio.pause();
}
function nextIndex(dir) {
  const n = M.q.length; if (!n) return -1;
  if (M.mode === 'shuffle' && n > 1) {
    if (!M.order || M.order.length !== n) { const o = M.q.map((_, k) => k).filter(k => k !== M.i); for (let k = o.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); [o[k], o[r]] = [o[r], o[k]]; } M.order = [M.i].concat(o); }
    const p = M.order.indexOf(M.i); return M.order[(p + dir + n) % n];
  }
  return (M.i + dir + n) % n;
}
function step(dir, auto) {
  if (!M.q.length) return;
  if (dir < 0 && audio && audio.currentTime > 3) { seekTo(0); return; }   // 放了 3 秒以上点“上一首”：先回到这首开头
  if (auto && M.mode === 'one') { seekTo(0); audio.play().catch(() => { /* 系统不让就停着 */ }); return; }
  const k = nextIndex(dir); if (k < 0) return;
  M.i = k; startCur(true);
}
function onEnded() { step(1, true); }
function onAudioError() {   // 这首放不出来：说一声，自动换下一首（连续 3 首都不行就停下，免得一直转）
  const t = cur(); if (!t || !audio.src) return;
  M.wait = false; M.failRow++;
  if (M.failRow >= 3 || M.q.length < 2) { B.toast('放不出来：可能是网络不好，或者 Audius 暂时连不上'); M.failRow = 0; paint(); return; }
  B.toast('“' + t.t + '”放不出来，换下一首');
  const k = nextIndex(1); if (k < 0) return; M.i = k; startCur(true);
}
function seekTo(frac) {   // frac：0~1；传 0 就是回到开头
  if (!audio) return;
  const d = isFinite(audio.duration) && audio.duration ? audio.duration : ((cur() && cur().d) || 0);
  try { audio.currentTime = Math.max(0, Math.min(d - 0.5, d * frac)); } catch (e) { /* 还没加载好 */ }
  paintProg();
}

/* ---------- 锁屏、耳机线控、车载：系统的“正在播放” ---------- */
function setupSession() {
  const ms = navigator.mediaSession; if (!ms) return;
  const on = (k, f) => { try { ms.setActionHandler(k, f); } catch (e) { /* 这台设备不支持这个按钮 */ } };
  on('play', () => toggle()); on('pause', () => { if (audio && !audio.paused) audio.pause(); });
  on('previoustrack', () => step(-1)); on('nexttrack', () => step(1));
  on('seekto', d => { if (audio && d && isFinite(d.seekTime)) { try { audio.currentTime = d.seekTime; } catch (e) { /* 没关系 */ } } });
  on('seekbackward', d => { if (audio) audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); });
  on('seekforward', d => { if (audio) audio.currentTime = audio.currentTime + ((d && d.seekOffset) || 10); });
}
function setMeta(t) {
  const ms = navigator.mediaSession; if (!ms || typeof window.MediaMetadata !== 'function') return;
  try {
    const aw = []; if (t.s) aw.push({ src: t.s, sizes: '150x150', type: 'image/jpeg' }); if (t.m) aw.push({ src: t.m, sizes: '480x480', type: 'image/jpeg' }); if (t.l) aw.push({ src: t.l, sizes: '1000x1000', type: 'image/jpeg' });
    ms.metadata = new window.MediaMetadata({ title: t.t, artist: t.a, album: 'Chatter · Audius', artwork: aw });
  } catch (e) { /* 不支持就算了 */ }
}

/* ---------- 正在播放页 ---------- */
function renderNow() {
  const t = cur(), box = R('now');
  if (!t) { box.innerHTML = msg('还没有在放的歌', ''); return; }
  const md = MODES.find(x => x[0] === M.mode) || MODES[0];
  const up = [];
  for (let k = 1; k <= Math.min(8, M.q.length - 1); k++) { const j = M.mode === 'shuffle' ? null : (M.i + k) % M.q.length; if (j != null && M.q[j]) up.push(M.q[j]); }
  box.innerHTML = art(t, 'l', 'mu-big') +
    '<div class="mu-nt"><div class="mu-tx"><div class="mu-rt">' + esc(t.t) + '</div><div class="mu-rs">' + esc(t.a) + '</div></div><button type="button" class="mu-ib mu-like' + (isLiked(t.id) ? ' on' : '') + '" data-act="like" aria-label="喜欢">' + ico(isLiked(t.id) ? I.heartOn : I.heart, 24) + '</button></div>' +
    '<div class="mu-prog"><input type="range" min="0" max="1000" step="1" value="0" data-r="seek" aria-label="播放进度"><div class="mu-times"><span data-r="t0">0:00</span><span data-r="t1">' + esc(t.d ? mmss(t.d) : '') + '</span></div></div>' +
    '<div class="mu-ctl"><button type="button" class="mu-ib mu-side' + (M.mode !== 'list' ? ' on' : '') + '" data-act="mode" aria-label="' + esc(md[1]) + '">' + ico(md[2], 22) + '</button>' +
    '<button type="button" class="mu-ib" data-act="prev" aria-label="上一首">' + ico(I.prev, 30) + '</button>' +
    '<button type="button" class="mu-ib mu-pp" data-act="toggle" data-r="pp" aria-label="播放 / 暂停"></button>' +
    '<button type="button" class="mu-ib" data-act="next" aria-label="下一首">' + ico(I.next, 30) + '</button>' +
    '<button type="button" class="mu-ib mu-side" data-act="send" aria-label="发给好友">' + ico(I.send, 22) + '</button></div>' +
    '<div class="mu-state" data-r="state"></div>' +
    (up.length ? '<div class="mu-up"><div class="mu-sec">接下来</div>' + rows(up, 'up') + '</div>' : M.mode === 'shuffle' && M.q.length > 1 ? '<div class="mu-state">随机播放：' + M.q.length + ' 首里随便挑</div>' : '') +
    '<div class="mu-from">来自 <a href="' + esc('https://audius.co' + (t.p || '')) + '" data-act="audius">Audius</a></div>';
  M.upList = up;
  paint();
}
function paintState() {
  if (!root) return;
  const s = R('state'); if (!s) return;
  s.textContent = M.wait ? '正在缓冲…' : '';
}
function paintProg() {
  const t = cur(); if (!t || !audio) return;
  const d = isFinite(audio.duration) && audio.duration ? audio.duration : t.d, c = audio.currentTime || 0, f = d ? Math.min(1, c / d) : 0;
  if (root && M.on && top() && top().v === 'now' && !M.seeking) {
    const sk = R('seek'); if (sk) sk.value = String(Math.round(f * 1000));
    const a = R('t0'), b = R('t1'); if (a) a.textContent = mmss(c); if (b && d) b.textContent = mmss(d);
  }
  if (mini) { const bar = mini.querySelector('i'); if (bar) bar.style.width = (f * 100).toFixed(1) + '%'; }
  try { if (navigator.mediaSession && navigator.mediaSession.setPositionState && d && isFinite(d)) navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: audio.playbackRate || 1 }); } catch (e) { /* 不支持就算了 */ }
}
function paint() {   // 播放 / 暂停按钮、列表里正在放的那首、迷你条
  const playing = audio && !audio.paused;
  if (root) {
    const pp = R('pp'); if (pp) pp.innerHTML = ico(playing ? I.pause : I.play, 32);
    root.querySelectorAll('.mu-row').forEach(r => { const L = r.dataset.from === 'up' ? M.upList : (listOf(r.dataset.from) || {}).items, it = L && L[+r.dataset.i]; r.classList.toggle('cur', !!(it && cur() && it.id === cur().id)); });
    paintState();
  }
  try { if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : (cur() ? 'paused' : 'none'); } catch (e) { /* 不支持就算了 */ }
  paintMini();
  try { window.dispatchEvent(new CustomEvent('chatter-music')); } catch (e) { /* 应用页的小组件跟着变 */ }
}

/* ---------- 迷你播放条：在主界面底部（聊天里不显示） ---------- */
function paintMini() {
  const t = cur();
  if (!mini) {
    if (!t) return;
    const nav = document.querySelector('#app-view .app-nav'); if (!nav) return;
    mini = document.createElement('div'); mini.id = 'mu-mini'; mini.setAttribute('role', 'button'); mini.setAttribute('aria-label', '正在播放，点开');
    nav.parentNode.insertBefore(mini, nav);
    mini.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'mini-pp') { e.stopPropagation(); toggle(); return; }
      if (b && b.dataset.act === 'mini-next') { e.stopPropagation(); step(1); return; }
      open('now');
    });
    mini.addEventListener('error', e => { const im = e.target; if (im && im.tagName === 'IMG') artFallback(im); }, true);
  }
  if (!t) { mini.classList.remove('on'); return; }
  const playing = audio && !audio.paused, key = t.id + '|' + playing;
  if (mini.dataset.k !== key) {
    mini.dataset.k = key;
    mini.innerHTML = art(t, 's', 'mu-art') + '<div class="mu-tx"><div class="mu-rt">' + esc(t.t) + '</div><div class="mu-rs">' + esc(t.a) + '</div></div>' +
      '<button type="button" class="mu-ib" data-act="mini-pp" aria-label="' + (playing ? '暂停' : '播放') + '">' + ico(playing ? I.pause : I.play, 24) + '</button>' +
      '<button type="button" class="mu-ib" data-act="mini-next" aria-label="下一首">' + ico(I.next, 22) + '</button><i></i>';
  }
  mini.classList.toggle('on', !M.on);
  paintProg();
}
function restore() {   // 重开 App：把上次的播放列表放回来（不自动播放，点了从上次的位置接着放）
  if (M.restored || !B.uid()) return; M.restored = true;
  const s = LSg(uidKey('ch2muNow'), null);
  if (!s || !Array.isArray(s.q) || !s.q[s.i]) return;
  M.q = s.q; M.i = s.i; M.mode = MODES.some(x => x[0] === s.mode) ? s.mode : 'list';
  M.resumeAt = +s.at || 0;   // 先不连 Audius（不花流量）：点播放时才去取，取到后跳到上次的位置
  ensureAudio(); setMeta(cur()); paint();
}

/* ---------- 点击 ---------- */
function rowList(from) { return from === 'up' ? M.upList : (listOf(from) || {}).items; }
function trackActs(t, from, i) {
  const liked = isLiked(t.id);
  B.acts(t.t, [
    { label: liked ? '取消喜欢' : '喜欢', fn: () => { const on = toggleLike(t); B.toast(on ? '已加到“我喜欢”' : '已取消喜欢'); show(); } },
    cur() && M.q.length ? { label: '下一首播放', fn: () => { M.q = M.q.filter((x, k) => k === M.i || x.id !== t.id); M.i = M.q.findIndex(x => x.id === cur().id); M.q.splice(M.i + 1, 0, t); M.order = null; saveNow(); B.toast('下一首放“' + t.t + '”'); show(); } } : null,
    { label: '发给好友', fn: () => B.forward(t.t + (t.a ? ' — ' + t.a : '') + '\nhttps://audius.co' + (t.p || '')) },
    from === 'recent' ? { label: '从最近播放里删掉', fn: () => { LSs(uidKey('ch2muRecent'), recent().filter(x => x.id !== t.id)); show(); } } : null,
    { label: '取消', fn: null }
  ].filter(Boolean));
  void i;
}
function onClick(e) {
  const el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) return;
  if (el.tagName === 'A' || e.target.closest('a')) e.preventDefault();
  const act = el.dataset.act;
  switch (act) {
    case 'back': back(); break;
    case 'clear': { const f = el.closest('.mu-field'), inp = f.querySelector('input'); inp.value = ''; f.classList.remove('has'); inp.focus(); break; }
    case 'genre': M.genre = el.dataset.g || ''; renderHome(); { const sc = V('home').querySelector('.mu-sc'); if (sc) sc.scrollTop = 0; } break;
    case 'retry': delete M.lists[el.dataset.k]; show(); break;
    case 'more-res': loadList(el.dataset.k, true); show(); break;
    case 'likes': go('list', { key: 'likes' }); break;
    case 'recent': go('list', { key: 'recent' }); break;
    case 'row': { const L = rowList(el.dataset.from), i = +el.dataset.i, t = L && L[i]; if (!t) break;
      if (cur() && cur().id === t.id) { if (audio && audio.paused) toggle(); go('now'); break; }
      if (el.dataset.from === 'up') { const k = M.q.findIndex(x => x.id === t.id); if (k >= 0) { M.i = k; startCur(true); } break; }
      playAt(L, i, el.dataset.from); go('now'); break; }
    case 'row-more': e.stopPropagation(); { const L = rowList(el.dataset.from), t = L && L[+el.dataset.i]; if (t) trackActs(t, el.dataset.from, +el.dataset.i); } break;
    case 'toggle': toggle(); break;
    case 'prev': step(-1); break;
    case 'next': step(1); break;
    case 'mode': { const k = MODES.findIndex(x => x[0] === M.mode), n = MODES[(k + 1) % MODES.length]; M.mode = n[0]; M.order = null; saveNow(); B.toast(n[1]); renderNow(); break; }
    case 'like': { const on = toggleLike(cur()); B.toast(on ? '已加到“我喜欢”' : '已取消喜欢'); renderNow(); break; }
    case 'send': { const t = cur(); if (t) B.forward(t.t + (t.a ? ' — ' + t.a : '') + '\nhttps://audius.co' + (t.p || '')); break; }
    case 'now-more': { const t = cur(); if (t) trackActs(t, 'now', M.i); break; }
    case 'audius': if (B.link) B.link(el.getAttribute('href'), 'Audius'); break;
  }
}

/* ---------- 换账号 ---------- */
function resetAccount() {
  acct++;
  if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { /* 没关系 */ } }
  M.q = []; M.i = -1; M.order = null; M.lists = {}; M.restored = false; M.genre = '';
  close();
  if (mini) { mini.remove(); mini = null; }
  try { if (navigator.mediaSession) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } } catch (e) { /* 不支持就算了 */ }
}

window.ChatterMusic = {
  open: open, onPop: onPop, isOpen: () => M.on, closeNow: close, resetAccount: resetAccount, restore: () => { restore(); },
  toggle: () => toggle(), next: () => step(1), pause: () => { if (audio && !audio.paused) audio.pause(); },
  now: () => { const t = cur(); return t ? { t: t.t, a: t.a, art: t.s, playing: !!(audio && !audio.paused) } : null; },
  _m: M, _toTrack: toTrack, _au: AU, _play: (list, i) => playAt(list, i)
};
})();
