(function () {
'use strict';

/* ================= 配置 ================= */
const SUPABASE_URL = 'https://uaoiqbxptnbrvkzjwguc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2FQ9q01lGWiDntr7VUrzcQ_SkgIo8uf';
const PROJECT_REF  = 'uaoiqbxptnbrvkzjwguc';
// 国内网络连不上 supabase.co 时，把 Cloudflare Worker 中转地址填在这里（例如 'https://chatter-proxy.xxx.workers.dev'，末尾不要加 /）。
// 留空 = 直连 Supabase。图片/语音地址在数据库里始终存直连地址，显示时才换成中转地址，所以两种用户可以互通。
const PROXY_URL = '';
const API_URL = PROXY_URL || SUPABASE_URL;
const canon = u => (PROXY_URL && typeof u === 'string' && u.indexOf(PROXY_URL + '/') === 0) ? SUPABASE_URL + u.slice(PROXY_URL.length) : u;
const disp = u => (PROXY_URL && typeof u === 'string' && u.indexOf(SUPABASE_URL + '/') === 0) ? PROXY_URL + u.slice(SUPABASE_URL.length) : u;
const AUTH_KEY_REF = (function () { try { return new URL(API_URL).hostname.split('.')[0]; } catch (e) { return PROJECT_REF; } })();
// 通话中转（TURN）：两台手机能直连时不经过中转、不花额度；直连失败才走中转，按流量算额度。
// 中转服务商列表优先读数据库 app_config 表里的 'ice'（换服务商、换密码只要跑 SQL，不用重新上传网页）；读不到时用下面的内置默认值。
// STUN：只放 iPhone 5G 真机实测能用的（stun.qq.com 实测不通，不用）
const STUN_SERVER = { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.hitv.com:3478', 'stun:stun.chat.bilibili.com:3478', 'stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
const TURN_DEFAULT = [
  { name: 'ExpressTURN', username: '000000002109207283', credential: 'F2O3wiOhufam3ieQHr7cTrp77u0=', urls: ['turn:free.expressturn.com:3478?transport=udp', 'turn:free.expressturn.com:3478?transport=tcp'] },
  { name: 'Metered', username: '8e04f6769d4effbe70fb66f7', credential: 'z8AVqW5ZnBQ0zgNV', urls: ['turn:global.relay.metered.ca:80', 'turns:global.relay.metered.ca:443?transport=tcp'] }
];
const RECALL_MS = 2 * 60 * 1000;
const PAGE = 40;

function validTurn(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(p => p && typeof p.username === 'string' && typeof p.credential === 'string' && p.username && p.credential && !/[<>]/.test(p.username + p.credential) &&
      Array.isArray(p.urls) && p.urls.length && p.urls.every(u => typeof u === 'string' && /^turns?:[a-z0-9.\-]+(:\d+)?(\?transport=(udp|tcp))?$/i.test(u)))
    .slice(0, 4).map(p => ({ name: String(p.name || '中转').slice(0, 20), username: p.username, credential: p.credential, urls: p.urls.slice(0, 4) }));
}
let turnList = null, turnFrom = '内置';
function turns() { if (!turnList) { const c = validTurn(LS.get('ch2ice', null)); if (c.length) { turnList = c; turnFrom = '数据库（缓存）'; } else turnList = TURN_DEFAULT; } return turnList; }
function iceServers() { return [STUN_SERVER].concat(turns().map(p => ({ urls: p.urls, username: p.username, credential: p.credential }))); }
async function loadIceConfig() {
  if (!sb || !S.me) return;
  try {
    const { data, error } = await sb.from('app_config').select('value').eq('key', 'ice').maybeSingle();
    if (error) { logErr('ice-config', error.message || error.code); return; }
    const l = validTurn(data && data.value && data.value.turn);
    if (l.length) { turnList = l; turnFrom = '数据库'; LS.set('ch2ice', l); }
  } catch (e) { logErr('ice-config', e); }
}

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const now = () => Date.now();
const ts = m => Date.parse(m.created_at) || 0;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (window.crypto && crypto.randomUUID && window.isSecureContext) ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const pad2 = n => String(n).padStart(2, '0');
const fmtDur = s => pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
const isTemp = id => S.out.has(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t), n = new Date();
  const hh = pad2(d.getHours()), mm = pad2(d.getMinutes());
  if (d.toDateString() === n.toDateString()) return hh + ':' + mm;
  if (d.getFullYear() !== n.getFullYear()) return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm;
}
const convKeyOf = (a, b) => [a, b].sort().join('::');
const peerOf = (k, me) => { const p = k.split('::'); return p[0] === me ? p[1] : p[0]; };
const rowToMsg = r => ({ id: String(r.id), conv: r.conv_key, from_acc: r.from_acc, to_acc: r.to_acc, type: r.type, body: r.body, dur: r.dur, created_at: r.created_at });
const SEP = '\u2063';
function encQ(q, text) { return SEP + 'Q' + q.id + SEP + String(q.snip || '').replace(/[\u2063\r\n]+/g, ' ').slice(0, 40) + SEP + text; }
function parseQ(body) {
  body = typeof body === 'string' ? body : '';
  if (body.charAt(0) !== SEP || body.charAt(1) !== 'Q') return { text: body, q: null };
  const parts = body.split(SEP);
  if (parts.length < 4) return { text: '[回复]', q: null };
  return { q: { id: parts[1].slice(1), snip: parts[2] }, text: parts.slice(3).join(SEP) };
}
let hidden = new Set();
let clr = {}, clrUid = null;
function clrOf(conv) { if (clrUid !== S.uid) { clr = LS.get('ch2clr:' + (S.uid || ''), {}) || {}; clrUid = S.uid; } return clr[conv] || 0; }
function setClr(conv, t) { clrOf(conv); clr[conv] = t; LS.set('ch2clr:' + (S.uid || ''), clr); }
const isHidden = m => hidden.has(m.id) || (clrOf(m.conv) > 0 && Date.parse(m.created_at) <= clrOf(m.conv));
const convGone = c => { const t = clrOf(c.convKey); return t > 0 && (Date.parse(c.last_ts || 0) || 0) <= t; };
const stampAfterClr = conv => new Date(Math.max(now(), clrOf(conv) + 1)).toISOString();
function loadHidden() { hidden = new Set(LS.get('ch2del:' + (S.uid || ''), []) || []); }
function saveHidden() { const a = Array.from(hidden).slice(-3000); LS.set('ch2del:' + (S.uid || ''), a); }
const peerReadOf = conv => (S.peerRead && S.peerRead[conv]) || 0;
function loadPeerRead() { S.peerRead = LS.get('ch2rd:' + (S.uid || ''), {}) || {}; }
function isRead(m) { return m.from_acc === ME() && !m._st && m.type !== 'call' && m.type !== 'recalled' && peerReadOf(m.conv) >= Date.parse(m.created_at); }
const previewOf = m => m.type === 'text' ? parseQ(m.body).text : m.type === 'image' ? '[图片]' : m.type === 'voice' ? '[语音]' : m.type === 'call' ? '[通话]' : m.type === 'recalled' ? '[已撤回]' : '[消息]';

const LOG = [];
function logErr(tag, e) {
  const s = new Date().toTimeString().slice(0, 8) + ' ' + tag + ': ' + ((e && (e.message || e.code)) || e);
  LOG.push(s); if (LOG.length > 60) LOG.shift();
  try { console.warn(tag, e); } catch (x) {}
}
window.addEventListener('error', e => logErr('error', e.message));
window.addEventListener('unhandledrejection', e => logErr('promise', e.reason));

let toastEl = null, toastT = 0;
function toast(msg) {
  if (toastEl) toastEl.remove();
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; toastEl = el;
  document.body.appendChild(el);
  clearTimeout(toastT); toastT = setTimeout(() => { el.remove(); if (toastEl === el) toastEl = null; }, 2600);
}
const stopStream = s => { try { s && s.getTracks().forEach(t => t.stop()); } catch (e) {} };
function gum(constraints, ms) {
  return new Promise((res, rej) => {
    let done = false;
    const t = setTimeout(() => { done = true; rej(new Error('timeout')); }, ms || 30000);
    navigator.mediaDevices.getUserMedia(constraints).then(s => {
      if (done) { stopStream(s); return; }   // 超时后才授权：立刻释放，避免麦克风一直被占用
      done = true; clearTimeout(t); res(s);
    }, e => { if (done) return; done = true; clearTimeout(t); rej(e); });
  });
}
// iOS 上第三方 App 的内置浏览器（如 Koder）：UA 里没有 Safari 标记。这类 App 如果没有声明麦克风权限，一调用麦克风整个 App 会被系统直接杀掉（页面代码拦不住），所以提前拦下。
function iosAppWebview() {
  const ua = navigator.userAgent || '';
  if (!/iPhone|iPad|iPod/.test(ua) && !(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return false;
  if (navigator.standalone) return false;                      // 添加到主屏幕的网页应用可以正常用麦克风
  return !/Safari\//.test(ua);
}
const IOS_APP_MSG = '当前是 App 内置浏览器，使用麦克风可能导致 App 闪退。请用 Safari 打开此页面（复制网址到 Safari）';
function micError(e) {
  const n = e && e.name, m = e && e.message;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return '需要麦克风/摄像头权限（请在浏览器设置里允许）';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '没有找到麦克风/摄像头';
  if (n === 'NotReadableError' || n === 'AbortError') return '麦克风/摄像头被其他应用占用';
  if (m === 'timeout') return '麦克风请求超时';
  return m || '未知错误';
}

/* ================= 音效（Web Audio 合成，不需要音频文件）=================
   发送：轻快上扬一声；收到：两音叮咚（正在看的会话更轻）；好友请求：三音琶音；
   来电：循环铃声；呼叫中：等待音；接通/挂断/取消各有一声。iPhone 静音拨片打开时没有声音。 */
const SFX = (function () {
  let ctx = null, master = null, on = LS.get('ch2sfx', true) !== false, ringT = 0, backT = 0;
  function ensure() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
        ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
        const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);  // iOS：用一个静音片段解锁
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    } catch (e) { return null; }
  }
  function note(f, t, d, o) {
    o = o || {};
    const osc = ctx.createOscillator(), g = ctx.createGain(), v = o.vol == null ? 0.22 : o.vol;
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + (o.att || 0.012)); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(g); g.connect(master); osc.start(t); osc.stop(t + d + 0.04);
  }
  function play(fn) {
    if (!on) return;
    const c = ensure(); if (!c) return;
    if (c.state === 'running') { try { fn(c.currentTime + 0.01); } catch (e) {} }
    else if (c.resume) c.resume().then(() => { if (c.state === 'running') { try { fn(c.currentTime + 0.01); } catch (e) {} } }).catch(() => {});
  }
  const unlock = () => { if (!ctx || ctx.state !== 'running') ensure(); };
  ['touchstart', 'touchend', 'mousedown', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, unlock, { passive: true }));
  const ringOnce = () => play(t => { [659, 784, 988, 784].forEach((f, i) => note(f, t + i * 0.17, 0.2, { type: 'triangle', vol: 0.2 })); [659, 784, 988, 1319].forEach((f, i) => note(f, t + 0.9 + i * 0.17, 0.22, { type: 'triangle', vol: 0.2 })); });
  const backOnce = () => play(t => note(450, t, 1.0, { vol: 0.1, att: 0.06 }));
  return {
    isOn: () => on,
    setOn(v) { on = !!v; LS.set('ch2sfx', on); if (on) this.recv(false); else this.stopAll(); },
    send() { play(t => { note(520, t, 0.1, { to: 880, vol: 0.16 }); note(1046, t + 0.06, 0.12, { vol: 0.09 }); }); },
    recv(open) { play(t => { if (open) note(988, t, 0.14, { vol: 0.11 }); else { note(784, t, 0.16, { type: 'triangle', vol: 0.2 }); note(1175, t + 0.11, 0.3, { vol: 0.18 }); } }); },
    notify() { play(t => { [659, 831, 988].forEach((f, i) => note(f, t + i * 0.1, 0.22, { type: 'triangle', vol: 0.17 })); }); },
    cancel() { play(t => note(300, t, 0.14, { to: 170, vol: 0.14 })); },
    connect() { play(t => { note(660, t, 0.14, { vol: 0.16 }); note(990, t + 0.11, 0.24, { vol: 0.15 }); }); },
    hangup() { play(t => { note(540, t, 0.16, { to: 300, vol: 0.17 }); note(400, t + 0.15, 0.24, { to: 220, vol: 0.14 }); }); },
    ringStart() { this.ringStop(); if (!on) return; ringOnce(); ringT = setInterval(ringOnce, 2800); },
    ringStop() { clearInterval(ringT); ringT = 0; },
    backStart() { this.backStop(); if (!on) return; backOnce(); backT = setInterval(backOnce, 4000); },
    backStop() { clearInterval(backT); backT = 0; },
    stopAll() { this.ringStop(); this.backStop(); }
  };
})();

/* 给“添加到主屏幕”用：在页面里直接生成 manifest（不需要单独的文件），图标内嵌 */
const ICON_DATA = (document.querySelector('link[rel=apple-touch-icon]') || {}).href || '';
function setupManifest() {
  try {
    const base = location.href.split('#')[0].split('?')[0], dir = base.replace(/[^/]*$/, '');
    const abs = f => new URL(f, base).href;
    const icons = [{ src: ICON_DATA, sizes: '180x180', type: 'image/png', purpose: 'any' }, { src: abs('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: abs('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: abs('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
    const m = { name: 'Chatter', short_name: 'Chatter', description: '絮语 · 即时聊天、语音与视频通话', lang: 'zh-CN', start_url: base, scope: dir, display: 'standalone', orientation: 'portrait', background_color: '#12101c', theme_color: '#6c5ce7', icons };
    const url = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/manifest+json' }));
    let l = document.querySelector('link[rel=manifest]'); if (!l) { l = document.createElement('link'); l.rel = 'manifest'; document.head.appendChild(l); }
    l.href = url;
  } catch (e) { logErr('manifest', e); }
}

/* ================= 状态 ================= */
const S = {
  uid: null, started: false, me: null, token: null,
  friends: [], profiles: {}, convs: [], requests: [],
  msgs: [], out: new Map(), conv: null, peer: null, hasMore: true, loadingOlder: false, stick: true, hist: false,
  online: new Set(), seen: new Set(),
  call: null, incoming: null, recalledEarly: new Set(), pendingIce: {}, callHideT: 0, incTimer: 0,
  rt: { db: false, user: false }, rtGen: 0, presGen: 0, chDb: null, chUser: null, presCh: null,
  tm: 0, tc: 0, syncing: false, noMR: false, noPR: false, noSigDb: false, noPres: false, noInbox: false, fbOnline: new Set(), peerRead: {}, typingUntil: 0, reply: null
};
let sb = null;
const ME = () => S.me && S.me.account_id;
const peerName = a => (S.profiles[a] && S.profiles[a].nickname) || a;
const avatarOf = a => (S.profiles[a] && S.profiles[a].avatar_url) || '';
const isOnline = a => S.online.has(a) || (S.fbOnline && S.fbOnline.has(a));
const convOf = k => S.convs.find(c => c.convKey === k);

/* ================= 本地缓存（秒开的关键）================= */
const ck = u => 'ch2:' + u, mk = (u, c) => 'ch2m:' + u + ':' + c;
let saveT = 0, saveMT = 0;
function saveCache() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (S.uid && S.me) LS.set(ck(S.uid), { me: S.me, friends: S.friends, profiles: S.profiles, convs: S.convs, requests: S.requests }); }, 500);
}
function hydrate(c) {
  S.me = c.me; S.friends = c.friends || []; S.profiles = c.profiles || {}; S.convs = c.convs || []; S.requests = c.requests || [];
  if (S.me) S.profiles[S.me.account_id] = S.me;
}
function saveMsgsNow() {
  clearTimeout(saveMT);
  if (!S.uid || !S.conv) return;
  const list = S.msgs.filter(m => !m._st && !m._blob).slice(-PAGE).map(m => ({ id: m.id, conv: m.conv, from_acc: m.from_acc, to_acc: m.to_acc, type: m.type, body: m.body, dur: m.dur, created_at: m.created_at }));
  LS.set(mk(S.uid, S.conv), list);
  const idx = LS.get('ch2midx:' + S.uid, []).filter(k => k !== S.conv); idx.push(S.conv);
  while (idx.length > 12) LS.del(mk(S.uid, idx.shift()));
  LS.set('ch2midx:' + S.uid, idx);
}
function saveMsgsSoon() { clearTimeout(saveMT); saveMT = setTimeout(saveMsgsNow, 700); }
function peekUid() {
  try {
    const raw = localStorage.getItem('sb-' + AUTH_KEY_REF + '-auth-token'); if (!raw) return null;
    const j = JSON.parse(raw); return (j && j.user && j.user.id) || (j && j.currentSession && j.currentSession.user && j.currentSession.user.id) || null;
  } catch (e) { return null; }
}

/* ================= 渲染调度（合并同一帧内的多次刷新）================= */
const dirty = {}; let rafId = 0;
function sched(k) { dirty[k] = true; if (!rafId) rafId = requestAnimationFrame(flush); }
function flush() {
  rafId = 0;
  if (dirty.list) { dirty.list = false; renderList(); updateTitle(); }
  if (dirty.contacts) { dirty.contacts = false; renderContacts(); }
  if (dirty.reqs) { dirty.reqs = false; renderRequests(); }
  if (dirty.title) { dirty.title = false; renderChatTitle(); }
}
let baseTitle = 'Chatter', flashI = 0;
function flashTitle() {
  if (flashI) return; let k = 0;
  flashI = setInterval(() => { if (!document.hidden) { stopFlash(); return; } document.title = (k++ % 2 ? baseTitle : '💬 新消息'); }, 900);
}
function stopFlash() { if (flashI) { clearInterval(flashI); flashI = 0; } document.title = baseTitle; }
function updateTitle() {
  let n = 0; S.convs.forEach(c => { if (c.convKey !== S.conv && !convGone(c)) n += c.unread || 0; });
  baseTitle = (n ? '(' + (n > 99 ? '99+' : n) + ') ' : '') + 'Chatter';
  if (!flashI) document.title = baseTitle;
  try { if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n).catch(() => {}); else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); } } catch (e) {}
}
function showApp() { $('auth-view').classList.remove('active'); $('app-view').classList.add('active'); }
function showAuth(msg) {
  $('app-view').classList.remove('active'); $('auth-view').classList.add('active');
  document.body.classList.remove('chat-open');
  if (msg) $('auth-msg').textContent = msg;
}
function showBanner(t) { const b = $('banner'); b.textContent = t; b.style.display = t ? 'block' : 'none'; }
function hueOf(s) { let h = 7; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function avatarHTML(name, url, online, key) {
  const hue = hueOf(key || name), letter = esc(((name || '?') + '').trim().slice(0, 1).toUpperCase());
  const inner = url ? '<img src="' + esc(disp(url)) + '" alt="">' : letter;
  const st = url ? '' : ' style="background:linear-gradient(140deg,hsl(' + hue + ',72%,64%),hsl(' + ((hue + 42) % 360) + ',74%,52%))"';
  return '<div class="avatar-wrapper"><div class="avatar"' + st + '>' + inner + '</div>' + (online ? '<span class="online-dot"></span>' : '') + '</div>';
}
const EMPTY_SVG = '<svg viewBox="0 0 84 84" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="14" width="46" height="32" rx="14" fill="#6c5ce7" fill-opacity=".14" stroke="#6c5ce7" stroke-width="2.5"/><path d="M22 46l-3 12 14-12" fill="#6c5ce7" fill-opacity=".14" stroke="#6c5ce7" stroke-width="2.5"/><rect x="38" y="34" width="36" height="26" rx="12" fill="#e8508c" fill-opacity=".16" stroke="#e8508c" stroke-width="2.5"/><circle cx="48" cy="47" r="2" fill="#e8508c"/><circle cx="56" cy="47" r="2.6" fill="#e8508c"/><circle cx="65" cy="47" r="3.2" fill="#e8508c"/></svg>';
const emptyHTML = t => '<div class="empty">' + EMPTY_SVG + t + '</div>';
function renderMe() {
  $('me-name').textContent = S.me ? S.me.nickname : '加载中…';
  $('me-acc').textContent = S.me ? '@' + S.me.account_id : '';
  $('me-acc2').textContent = S.me ? S.me.account_id : '';
  if ($('me-name2')) $('me-name2').textContent = S.me ? S.me.nickname : '';
  if ($('me-avatar')) $('me-avatar').innerHTML = S.me ? avatarHTML(S.me.nickname, S.me.avatar_url, false, S.me.account_id) : '';
}
function renderAll() { renderMe(); renderList(); renderContacts(); renderRequests(); updateTitle(); }
function renderList() {
  const el = $('conv-list');
  const shown = S.convs.filter(c => !convGone(c));
  if (!shown.length) { el.innerHTML = emptyHTML(S.me ? '还没有会话<br>去通讯录找个好友，说点什么' : '加载中…'); return; }
  el.innerHTML = shown.map(c => {
    const name = peerName(c.peer_acc), un = c.convKey === S.conv ? 0 : (c.unread || 0);
    return '<div class="conv-item" data-key="' + esc(c.convKey) + '" data-peer="' + esc(c.peer_acc) + '">' + avatarHTML(name, avatarOf(c.peer_acc), isOnline(c.peer_acc), c.peer_acc) +
      '<div class="conv-main"><div class="conv-top"><span class="conv-name">' + esc(name) + '</span><span class="conv-time">' + fmtTime(c.last_ts) + '</span></div>' +
      '<div class="conv-sub"><span class="preview">' + (draftOf(c.convKey) && c.convKey !== S.conv ? '<span class="draft">[草稿] </span>' + esc(draftOf(c.convKey).slice(0, 60)) : esc(parseQ(c.last_body).text || '开始聊天吧')) + '</span>' + (un ? '<span class="badge">' + (un > 99 ? '99+' : un) + '</span>' : '') + '</div></div></div>';
  }).join('');
}
function renderContacts() {
  const el = $('friend-list');
  if (!S.friends.length) { el.innerHTML = emptyHTML('还没有好友<br>在上面搜索账号，加一个吧'); return; }
  el.innerHTML = S.friends.map(a => '<div class="friend-item" data-acc="' + esc(a) + '">' + avatarHTML(peerName(a), avatarOf(a), isOnline(a), a) +
    '<div class="name"><div class="name-main">' + esc(peerName(a)) + '</div><div class="name-sub">@' + esc(a) + '</div></div>' +
    '<div class="row-actions"><button class="btn-primary act-chat">聊天</button><button class="btn-danger act-remove">删除</button></div></div>').join('');
}
function renderRequests() {
  const el = $('request-list'), badge = $('req-badge'), n = S.requests.length;
  badge.style.display = n ? '' : 'none'; badge.textContent = n;
  if (!n) { el.innerHTML = emptyHTML('暂时没有新的好友请求'); return; }
  el.innerHTML = S.requests.map(r => '<div class="req-item" data-id="' + esc(r.id) + '">' + avatarHTML(r.from_name || r.from_acc, '', false, r.from_acc) +
    '<div class="name"><div class="name-main">' + esc(r.from_name || r.from_acc) + '</div><div class="name-sub">@' + esc(r.from_acc) + '</div></div>' +
    '<div class="row-actions"><button class="btn-ok act-accept">接受</button><button class="btn-danger act-decline">拒绝</button></div></div>').join('');
}
function renderChatTitle() {
  if (!S.peer) return;
  const on = isOnline(S.peer);
  $('chat-title').innerHTML = '<span>' + esc(peerName(S.peer)) + '</span><span class="sub' + (on ? ' on' : '') + '"><i></i>' + (S.typingUntil > now() ? '对方正在输入…' : on ? '在线' : '离线') + '</span>';
}
function renderEnv() {
  const ua = navigator.userAgent || '';
  const inapp = /MicroMessenger|QQ\/|Alipay|DingTalk|Weibo|baiduboxapp|Quark|UCBrowser/i.test(ua);
  const L = [], ok = (b, t) => { L.push((b ? '✅ ' : '❌ ') + t); };
  ok(window.isSecureContext, '安全环境 (https)');
  ok(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), '麦克风/摄像头接口');
  ok(typeof RTCPeerConnection !== 'undefined', 'WebRTC 通话');
  ok(!!(window.AudioContext || window.webkitAudioContext), '语音录制');
  ok(!iosAppWebview(), iosAppWebview() ? 'iOS App 内置浏览器：录音/通话已禁用以防闪退，请用 Safari 打开' : '非 iOS App 内置浏览器');
  ok(!inapp, inapp ? '内置浏览器（常不支持通话/录音，请用 Safari / Chrome 打开）' : '非内置浏览器');
  if (S.rt.db) ok(true, '实时消息通道');
  else L.push(S.noInbox ? '🟡 实时消息通道连不上 → 消息每 2 秒同步一次（运行 setup-v4.sql 后会变成即时）' : '🟡 实时消息通道连不上 → 已切换国内模式（长轮询，消息基本即时到达）');
  if (S.rt.user) ok(true, '快速通道 / 通话信令');
  else if (!S.noSigDb) L.push('🟡 快速通道连不上 → 通话信号改走数据库（国内模式）');
  else ok(false, '通话信令不可用：请在 Supabase 运行 setup-v4.sql');
  if (S.noPres) L.push('🟡 在线状态：未运行 setup-v4.sql，国内网络下可能显示离线');
  L.push('ℹ️ 中转服务器：' + turns().map(p => p.name).join('、') + '（来自' + turnFrom + '）');
  $('diag').textContent = L.join('\n');
  $('errlog').textContent = LOG.join('\n') || '（暂无错误）';
}

/* ================= 会话 / 消息数据 ================= */
function touchConv(key, preview, t, inc) {
  let c = convOf(key);
  if (c) { c.last_body = preview; c.last_ts = t; if (inc && key !== S.conv) c.unread = (c.unread || 0) + 1; }
  else {
    const peer = peerOf(key, ME());
    S.convs.push({ convKey: key, peer_acc: peer, last_body: preview, last_ts: t, last_read_ts: null, unread: inc && key !== S.conv ? 1 : 0 });
    if (!S.profiles[peer]) fetchProfile(peer);
  }
  S.convs.sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0));
  sched('list'); saveCache();
}
async function fetchProfile(acc) {
  if (!sb || S.profiles[acc]) return;
  const { data } = await sb.from('profiles').select('account_id,nickname,avatar_url').eq('account_id', acc).maybeSingle();
  if (data) { S.profiles[acc] = data; sched('list'); sched('contacts'); sched('title'); saveCache(); }
}
let readT = {};
const isMissingFn = e => /42883|PGRST202|PGRST204|schema cache|does not exist|Could not find the function/i.test(String((e && (e.code || '')) + ' ' + (e && e.message || '')));
async function fetchPeerRead(conv) {
  if (!sb || !conv || S.noPR || !S.me) return;
  try {
    const { data, error } = await sb.rpc('peer_read', { p_conv: conv });
    if (error) { if (isMissingFn(error)) S.noPR = true; return; }
    const t = data ? Date.parse(data) : 0;
    if (t > 0 && t > peerReadOf(conv)) { S.peerRead[conv] = t; LS.set('ch2rd:' + (S.uid || ''), S.peerRead); if (S.conv === conv) refreshReads(); }
  } catch (e) { logErr('peerRead', e); }
}
function markReadSoon(key) {
  if (key === S.conv) setTimeout(() => sendReadAck(key), 120);
  const c = convOf(key); if (c) { c.unread = 0; c.last_read_ts = new Date().toISOString(); sched('list'); }
  clearTimeout(readT[key]);
  readT[key] = setTimeout(() => {
    if (!sb || !S.me) return;
    const direct = () => sb.from('conversations').update({ unread: 0, last_read_ts: new Date().toISOString() }).eq('owner_acc', ME()).eq('conv_key', key).then(r => { if (r && r.error) logErr('markRead', r.error); });
    if (S.noMR) { direct(); return; }
    sb.rpc('mark_read', { p_conv: key }).then(r => {
      if (r && r.error) { if (isMissingFn(r.error)) S.noMR = true; logErr('mark_read', r.error); direct(); }
    }, () => direct());
  }, 250);
  saveCache();
}
function upsertConvRow(r) {
  const key = r.conv_key; if (!key) return;
  const n = { convKey: key, peer_acc: r.peer_acc || peerOf(key, ME()), last_body: r.last_body, last_ts: r.last_ts, last_read_ts: r.last_read_ts, unread: r.unread || 0 };
  if (key === S.conv) { if (n.unread > 0) markReadSoon(key); n.unread = 0; }
  const c = convOf(key);
  if (c) Object.assign(c, n); else S.convs.push(n);
  S.convs.sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0));
  if (!S.profiles[n.peer_acc]) fetchProfile(n.peer_acc);
  sched('list'); saveCache();
}
function applyBoot(b) {
  S.me = b.me; S.profiles[b.me.account_id] = b.me;
  S.friends = (b.friends || []).map(p => { S.profiles[p.account_id] = p; return p.account_id; });
  (b.peers || []).forEach(p => { S.profiles[p.account_id] = p; });
  S.convs = (b.convs || []).map(c => ({ convKey: c.conv_key, peer_acc: c.peer_acc, last_body: c.last_body, last_ts: c.last_ts, last_read_ts: c.last_read_ts, unread: c.conv_key === S.conv ? 0 : (c.unread || 0) }));
  S.requests = b.requests || [];
  saveCache(); renderMe(); sched('list'); sched('contacts'); sched('reqs'); sched('title');
}
async function bootstrap() {
  const { data, error } = await sb.rpc('bootstrap');
  if (error) {
    if (error.code === 'PGRST202' || /bootstrap/i.test(error.message || '')) throw new Error('数据库脚本还没更新：请先在 Supabase 执行最新的 setup.sql');
    throw error;
  }
  return data;
}
async function ensureProfile(user) {
  const meta = user.user_metadata || {};
  const acc = String(meta.account_id || ('user_' + user.id.slice(0, 6))).toLowerCase();
  await sb.from('profiles').upsert({ id: user.id, account_id: acc, nickname: meta.nickname || '新用户' }, { onConflict: 'id', ignoreDuplicates: true });
}
async function resync() {
  if (S.syncing || !sb || !S.me) return;
  S.syncing = true;
  try { const b = await bootstrap(); if (b) applyBoot(b); if (S.conv) await syncChat(); }
  catch (e) { logErr('resync', e); }
  finally { S.syncing = false; }
}

/* ---- 聊天窗口 DOM（增量更新，不整页重绘）---- */
let audioEl = null, playingId = null;
function msgHTML(m) {
  const mine = m.from_acc === ME(); let body;
  switch (m.type) {
    case 'recalled': body = '<div class="bubble recalled">' + (mine ? '你撤回了一条消息' : '对方撤回了一条消息') + '</div>'; break;
    case 'image': body = '<div class="bubble img"><img src="' + esc(disp(m.body)) + '" alt="" decoding="async"></div>'; break;
    case 'voice': { const d = Math.max(1, m.dur || 1); body = '<div class="bubble voice' + (playingId === m.id ? ' playing' : '') + '" data-url="' + esc(m.body) + '" style="min-width:' + Math.min(200, 96 + d * 6) + 'px"><span class="vp"></span><span class="vw"><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="vd">' + d + '″</span></div>'; break; }
    case 'call': body = '<div class="bubble call">' + (m.body === 'video' ? '<svg class="ic" viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="3" y="6.5" width="12.5" height="11" rx="3"/><path d="m15.5 11 5-3v8l-5-3z"/></svg>' : '<svg class="ic" viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M5.2 4h3.3l1.6 4.2-2 1.4a11 11 0 0 0 5.3 5.3l1.4-2 4.2 1.6v3.3a1.8 1.8 0 0 1-1.9 1.8C10.8 19.2 4.8 13.2 3.4 5.9A1.8 1.8 0 0 1 5.2 4z"/></svg>') + (m.dur > 0 ? '通话时长 ' + fmtDur(m.dur) : '未接通') + '</div>'; break;
    default: { const pq = parseQ(m.body); let qh = ''; if (pq.q) { const t = S.msgs.find(x => x.id === pq.q.id); qh = '<div class="quote" data-qid="' + esc(pq.q.id) + '"><b>' + esc(t ? (t.from_acc === ME() ? '我' : peerName(t.from_acc)) : '消息') + '</b>' + esc(t ? previewOf(t).slice(0, 40) : pq.q.snip) + '</div>'; } body = '<div class="bubble' + (pq.q ? ' hasq' : '') + '">' + qh + esc(pq.text) + '</div>'; }
  }
  const st = m._st === 'sending' ? '<span class="st sending"></span>' : m._st === 'failed' ? '<span class="st failed" data-retry="1">!</span>' : '';
  return '<div class="msg ' + (mine ? 'mine' : 'theirs') + '" data-id="' + esc(m.id) + '" data-mine="' + mine + '">' +
    (mine ? '' : avatarHTML(peerName(m.from_acc), avatarOf(m.from_acc), false, m.from_acc)) +
    '<div class="msg-body"><div class="row">' + (mine ? st : '') + body + '</div><div class="msg-time">' + fmtTime(m.created_at) + (isRead(m) ? ' · 已读' : '') + '</div></div></div>';
}
function chatRender(stick) {
  const b = $('chat-messages');
  const vis = S.msgs.filter(m => !isHidden(m)); b.innerHTML = vis.length ? vis.map(msgHTML).join('') : '<div class="empty">' + EMPTY_SVG + '还没有消息，打个招呼吧</div>';
  if (stick) b.scrollTop = b.scrollHeight;
}
function chatAppend(m, force) {
  if (isHidden(m)) return;
  const b = $('chat-messages'), e = b.querySelector('.empty'); if (e) e.remove();
  b.insertAdjacentHTML('beforeend', msgHTML(m));
  if (force || S.stick) b.scrollTop = b.scrollHeight;
}
function msgElOf(id) { return $('chat-messages').querySelector('.msg[data-id="' + id + '"]'); }
function chatReplace(m) {
  if (isHidden(m)) return;
  const el = msgElOf(m.id);
  if (!el) { chatRender(S.stick); return; }
  el.outerHTML = msgHTML(m);
}
function patchMsg(id, p) {
  const i = S.msgs.findIndex(x => x.id === id); if (i < 0) return null;
  Object.assign(S.msgs[i], p); chatReplace(S.msgs[i]); return S.msgs[i];
}
function upsertMsg(m) {
  const i = S.msgs.findIndex(x => x.id === m.id);
  if (i > -1) {
    const o = S.msgs[i];
    if (o.type === m.type && o.body === m.body && o.dur === m.dur && !o._st) { o.created_at = m.created_at; return; }
    S.msgs[i] = Object.assign({}, m); S.out.delete(m.id); chatReplace(S.msgs[i]); saveMsgsSoon(); return;
  }
  const last = S.msgs[S.msgs.length - 1];
  S.msgs.push(m);
  if (last && ts(m) < ts(last)) { S.msgs.sort((a, b) => ts(a) - ts(b)); chatRender(S.stick); } else chatAppend(m);
  saveMsgsSoon();
}

/* ---- 收到消息 ---- */
function onIncoming(m) {
  if (S.recalledEarly.has(m.id) && m.type !== 'recalled') { m = Object.assign({}, m, { type: 'recalled', body: '' }); }
  const first = !S.seen.has(m.id); S.seen.add(m.id);
  if (S.seen.size > 800) S.seen = new Set(Array.from(S.seen).slice(-400));
  const open = S.conv === m.conv;
  if (open && m.from_acc === S.peer) { S.typingUntil = 0; sched('title'); }
  if (first && m.type !== 'call') { SFX.recv(open); if (document.hidden) flashTitle(); }
  if (open) { upsertMsg(m); if (first) markReadSoon(m.conv); }
  touchConv(m.conv, previewOf(m), m.created_at, first && !open && m.type !== 'call');
  if (!S.profiles[m.from_acc]) fetchProfile(m.from_acc);
}
function onDbMsg(row, kind) {
  const m = rowToMsg(row);
  if (kind === 'ins') { if (m.from_acc !== ME()) onIncoming(m); }
  else if (S.conv === m.conv) upsertMsg(m);
}
function onFastMsg(p) {
  try {
    if (!p || typeof p !== 'object') return;
    const me = ME();
    if (p.to !== me || typeof p.from !== 'string' || !S.friends.includes(p.from)) return;
    if (typeof p.id !== 'string' || p.conv !== convKeyOf(p.from, p.to)) return;
    if (['text', 'image', 'voice'].indexOf(p.type) < 0) return;
    let body = typeof p.body === 'string' ? p.body : '';
    if (p.type === 'text') body = body.slice(0, 5200);
    else if (body.indexOf(SUPABASE_URL + '/storage/') !== 0) return;   // 图片/语音只接受本项目存储的地址
    onIncoming({ id: p.id, conv: p.conv, from_acc: p.from, to_acc: me, type: p.type, body, dur: p.dur | 0 || null, created_at: stampAfterClr(p.conv) });
  } catch (e) { logErr('fast', e); }
}
function onFastRecall(p) {
  if (!p || typeof p.id !== 'string' || !S.friends.includes(p.from)) return;
  const m = S.msgs.find(x => x.id === p.id);
  if (m && m.from_acc === p.from && m.type !== 'recalled') patchMsg(p.id, { type: 'recalled', body: '' });
  else if (!m) { S.recalledEarly.add(p.id); if (S.recalledEarly.size > 200) S.recalledEarly = new Set(Array.from(S.recalledEarly).slice(-100)); }
}

/* ---- 发送 ---- */
async function bcast(topic, event, payload, keep) {
  if (!S.token) return false;
  try {
    const r = await fetch(API_URL + '/realtime/v1/api/broadcast', {
      method: 'POST', keepalive: !!keep,
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] })
    });
    if (!r.ok) { logErr('bcast', event + ' HTTP ' + r.status); return false; }
    return true;
  } catch (e) { logErr('bcast', e); return false; }
}
function newMsg(type, body, dur, extra) {
  return Object.assign({ id: uuid(), conv: S.conv, from_acc: ME(), to_acc: S.peer, type, body, dur: dur || null, created_at: stampAfterClr(S.conv), _st: 'sending' }, extra || {});
}
function addLocal(m) {
  S.out.set(m.id, m); S.msgs.push(m); chatAppend(m, true);
  touchConv(m.conv, previewOf(m), m.created_at, false);
  deliver(m); SFX.send();
}
async function upload(blob, ext, ct) {
  const path = ME() + '/' + now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
  const { error } = await sb.storage.from('chat-media').upload(path, blob, { contentType: ct, cacheControl: '31536000' });
  if (error) throw error;
  return canon(sb.storage.from('chat-media').getPublicUrl(path).data.publicUrl);
}
async function deliver(m, silent) {
  const id = m.id;
  try {
    if (m._blob) {
      const old = m.body, url = await upload(m._blob, m._ext, m._ct);
      m.body = url; m._blob = null; patchMsg(id, { body: url }); try { URL.revokeObjectURL(old); } catch (e) {}
    }
    if (S.token && m.type !== 'call') bcast('u:' + m.to_acc, 'm', { id: m.id, conv: m.conv, from: m.from_acc, to: m.to_acc, type: m.type, body: m.body, dur: m.dur });
    const row = { id: m.id, conv_key: m.conv, from_acc: m.from_acc, to_acc: m.to_acc, type: m.type, body: m.body, dur: m.dur };
    const { data, error } = await sb.from('messages').insert(row).select('created_at').single();
    if (error && error.code !== '23505') throw error;
    S.out.delete(id); delete m._blob;
    const t = data ? data.created_at : m.created_at;
    patchMsg(id, { _st: '', created_at: t, _blob: undefined });
    touchConv(m.conv, previewOf(m), t, false);
    saveMsgsSoon();
  } catch (e) {
    logErr('send', e);
    m._st = 'failed'; if (e && e.code === '42501') m._fatal = true; patchMsg(id, { _st: 'failed' });
    if (!silent || m._fatal) toast(e && e.code === '42501' ? '发送失败：对方不是你的好友' : '发送失败，网络恢复后会自动重发，也可点消息左边的 ! 重试');
  }
}
function sendText() {
  const input = $('chat-input'), v = input.value.trim();
  if (!v || !S.conv) return;
  input.value = ''; draftSave(S.conv, ''); lastTy = 0;   // 发出消息后，对方的“正在输入”会被清掉；下次打字要立刻重新通知
  let body = v.replace(/\u2063/g, '').slice(0, 5000);
  if (!body) return;
  if (S.reply) { body = encQ(S.reply, body); clearReply(); }
  addLocal(newMsg('text', body));
}
function setReply(m) {
  S.reply = { id: m.id, snip: previewOf(m).slice(0, 40) };
  $('reply-text').textContent = (m.from_acc === ME() ? '我' : peerName(m.from_acc)) + '：' + S.reply.snip;
  $('reply-bar').classList.add('active'); $('chat-input').focus();
}
function clearReply() { S.reply = null; $('reply-bar').classList.remove('active'); }
let lastTy = 0;
function sendTyping() {
  if (!S.conv || !S.peer || !S.token || now() - lastTy < 3000) return;
  lastTy = now(); const p = { t: 'ty', from: ME(), conv: S.conv, sq: sqOf() };
  bcast('u:' + S.peer, 'ty', p); dbSignal(S.peer, p);
}
function onTyping(p) {
  if (!p || typeof p.from !== 'string' || !S.friends.includes(p.from) || p.conv !== convKeyOf(p.from, ME())) return;
  if (sigDup(p)) return;
  if (S.conv !== p.conv || S.peer !== p.from) return;
  S.typingUntil = now() + 4500; renderChatTitle();
  setTimeout(() => { if (S.typingUntil <= now()) renderChatTitle(); }, 4600);
}
/* 已读回执 */
let lastAck = 0;
function sendReadAck(conv, force) {
  if (!conv || !S.token || document.hidden) return;
  if (!force && now() - lastAck < 400) return; lastAck = now();
  const peer = peerOf(conv, ME());
  let t = 0; if (S.conv === conv) S.msgs.forEach(m => { if (m.from_acc === peer && !m._st) t = Math.max(t, ts(m)); });
  if (!t) return;
  bcast('u:' + peer, 'rd', { from: ME(), conv, ts: new Date(t).toISOString() });
}
function refreshReads() {
  if (!S.conv) return;
  $('chat-messages').querySelectorAll('.msg.mine').forEach(el => {
    const m = S.msgs.find(x => x.id === el.dataset.id); if (!m) return;
    const tEl = el.querySelector('.msg-time'); if (tEl) tEl.textContent = fmtTime(m.created_at) + (isRead(m) ? ' · 已读' : '');
  });
}
function onReadAck(p) {
  if (!p || typeof p.from !== 'string' || !S.friends.includes(p.from) || p.conv !== convKeyOf(p.from, ME())) return;
  const t = Date.parse(p.ts); if (!(t > 0)) return;
  if (t <= peerReadOf(p.conv)) return;
  S.peerRead[p.conv] = t; LS.set('ch2rd:' + (S.uid || ''), S.peerRead); refreshReads();
}
function onReadReq(p) {
  if (!p || typeof p.from !== 'string' || !S.friends.includes(p.from) || p.conv !== convKeyOf(p.from, ME())) return;
  if (S.conv === p.conv && !document.hidden) { sendReadAck(p.conv, true); return; }
  const c = convOf(p.conv);
  if (c && !(c.unread > 0) && c.last_ts && S.token) bcast('u:' + p.from, 'rd', { from: ME(), conv: p.conv, ts: c.last_ts });
}
async function sendImage(file) {
  if (!file || !S.conv || !/^image\//.test(file.type)) return;
  if (file.size > 20 * 1024 * 1024) { toast('有图片超过 20MB，已跳过（' + Math.round(file.size / 1048576) + 'MB）'); return; }
  const ext = ((file.type.split('/')[1]) || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  addLocal(newMsg('image', URL.createObjectURL(file), null, { _blob: file, _ext: ext, _ct: file.type }));
}
async function sendImages(files) {
  const list = Array.from(files || []).filter(f => /^image\//.test(f.type));
  if (!list.length) { if (files && files.length) toast('只能发送图片'); return; }
  if (list.length > 9) toast('一次最多 9 张，已发送前 9 张');
  for (const f of list.slice(0, 9)) { if (!S.conv) break; await sendImage(f); await new Promise(r => setTimeout(r, 60)); }
}
function sendVoice(blob, dur) {
  if (!S.conv) return;
  addLocal(newMsg('voice', URL.createObjectURL(blob), dur, { _blob: blob, _ext: 'wav', _ct: 'audio/wav' }));
}
function retryMsg(id) {
  const m = S.out.get(id); if (!m || m._st !== 'failed') return;
  m._tries = 0; m._fatal = false; m._st = 'sending'; patchMsg(id, { _st: 'sending' }); deliver(m);
}
function retryFailed() {
  if (!sb || !S.me || navigator.onLine === false) return;
  S.out.forEach(m => {
    if (m._st !== 'failed' || m._fatal || (m._tries || 0) >= 8) return;
    m._tries = (m._tries || 0) + 1; m._st = 'sending'; patchMsg(m.id, { _st: 'sending' }); deliver(m, true);
  });
}

/* ---- 撤回 ---- */
let menuId = null;
let menuOpenAt = 0;
function showMsgMenu(id) {
  const m = S.msgs.find(x => x.id === id);
  if (!m || m._st === 'sending') return;
  const mine = m.from_acc === ME(), plain = m.type !== 'recalled' && m.type !== 'call' && !m._st;
  const canRecall = mine && plain && now() - ts(m) <= RECALL_MS;
  $('msg-menu-reply').style.display = plain ? '' : 'none';
  $('msg-menu-copy').style.display = plain && m.type === 'text' ? '' : 'none';
  $('msg-menu-recall').style.display = canRecall ? '' : 'none';
  $('msg-menu-del').style.display = '';
  $('msg-menu-title').textContent = canRecall ? '2 分钟内可撤回' : '消息';
  menuId = id; menuOpenAt = now(); $('msg-menu-backdrop').classList.add('active'); $('msg-menu').classList.add('active');
}
function closeMenu() { $('msg-menu-backdrop').classList.remove('active'); $('msg-menu').classList.remove('active'); menuId = null; }
function copyText(t) {
  const done = () => toast('已复制');
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, () => fb()); return; } } catch (e) {}
  fb();
  function fb() { try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0'; document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, t.length); document.execCommand('copy'); ta.remove(); done(); } catch (e) { toast('复制失败'); } }
}
function menuAction(kind) {
  const id = menuId, m = S.msgs.find(x => x.id === id); closeMenu(); if (!m) return;
  if (kind === 'reply') setReply(m);
  else if (kind === 'copy') copyText(parseQ(m.body).text);
  else if (kind === 'del') {
    hidden.add(id); saveHidden(); S.out.delete(id);
    const el = msgElOf(id); if (el) el.remove();
    if (!$('chat-messages').querySelector('.msg')) chatRender(true);
    toast('已删除（仅在你这边）');
  }
}
async function doRecall() {
  const id = menuId; closeMenu(); if (!id) return;
  const m = S.msgs.find(x => x.id === id);
  if (!m || m.from_acc !== ME() || m.type === 'recalled' || now() - ts(m) > RECALL_MS) { toast('超过 2 分钟，无法撤回'); return; }
  const prev = { type: m.type, body: m.body };
  patchMsg(id, { type: 'recalled', body: '' });
  const { data, error } = await sb.from('messages').update({ type: 'recalled', body: '' }).eq('id', id).select('id');
  if (error || !data || !data.length) { patchMsg(id, prev); toast('撤回失败：' + (error ? error.message : '已超时')); return; }
  if (S.token) bcast('u:' + m.to_acc, 'r', { id, from: ME(), conv: m.conv });
  saveMsgsSoon();
}

/* ---- 打开 / 关闭聊天 ---- */
async function fetchMsgs(conv, before) {
  let q = sb.from('messages').select('*').eq('conv_key', conv).order('created_at', { ascending: false }).limit(PAGE);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q; if (error) throw error;
  return (data || []).reverse().map(rowToMsg);
}
async function openConv(key, peer) {
  if (!S.me) return;
  recAbort();
  S.conv = key; S.peer = peer || peerOf(key, ME()); S.hasMore = true; S.stick = true; S.typingUntil = 0; clearReply(); loadHidden(); loadPeerRead(); closeSearch(); $('chat-input').value = draftOf(key);
  S.msgs = (LS.get(mk(S.uid, key), []) || []).slice();
  S.out.forEach(m => { if (m.conv === key && !S.msgs.some(x => x.id === m.id)) S.msgs.push(m); });
  document.body.classList.add('chat-open');
  if (!S.hist) { try { history.pushState({ chat: 1 }, ''); S.hist = true; } catch (e) {} }
  $('emoji-panel').classList.remove('active');
  renderChatTitle(); chatRender(true);          // 先用缓存秒开
  markReadSoon(key); sendReadAck(key, true);
  if (S.token) bcast('u:' + S.peer, 'rq', { from: ME(), conv: key });
  try {
    const rows = await fetchMsgs(key);
    if (S.conv !== key) return;
    const map = new Map(); rows.forEach(r => map.set(r.id, r));
    S.msgs.forEach(m => { if (!map.has(m.id) && S.out.has(m.id)) map.set(m.id, m); });
    S.msgs = Array.from(map.values()).sort((a, b) => ts(a) - ts(b));
    S.hasMore = rows.length >= PAGE && !(rows.length && rows.every(isHidden));
    chatRender(true); saveMsgsSoon(); sendReadAck(key, true); fetchPeerRead(key);
  } catch (e) { logErr('open', e); if (!S.msgs.length) $('chat-messages').innerHTML = '<div class="empty">加载失败，请检查网络后重新打开</div>'; }
}
function closeChat() {
  recAbort(); stopAudio(); saveMsgsNow(); if (S.conv) draftSave(S.conv, $('chat-input').value); closeSearch(); closeActs();
  S.conv = null; S.peer = null; S.msgs = []; S.hist = false; S.typingUntil = 0; clearReply();
  document.body.classList.remove('chat-open'); $('emoji-panel').classList.remove('active'); closeMenu();
  sched('list');
}
async function syncChat() {
  const conv = S.conv; if (!conv || !sb) return;
  try {
    const rows = await fetchMsgs(conv); if (S.conv !== conv) return;
    rows.forEach(r => { if (r.from_acc !== ME() && !S.msgs.some(x => x.id === r.id)) onIncoming(r); else upsertMsg(r); });
    fetchPeerRead(conv);
  } catch (e) { logErr('syncChat', e); }
}
async function loadOlder() {
  if (S.loadingOlder || !S.hasMore || !S.conv || !S.msgs.length) return;
  S.loadingOlder = true; const conv = S.conv;
  try {
    const rows = await fetchMsgs(conv, S.msgs[0].created_at); if (S.conv !== conv) return;
    const have = new Set(S.msgs.map(m => m.id)), add = rows.filter(r => !have.has(r.id));
    S.hasMore = rows.length >= PAGE && !(rows.length && rows.every(isHidden));
    if (add.length) {
      const b = $('chat-messages'), h = b.scrollHeight, t = b.scrollTop;
      S.msgs = add.concat(S.msgs); chatRender(false); b.scrollTop = b.scrollHeight - h + t;
    }
  } catch (e) { logErr('older', e); } finally { S.loadingOlder = false; }
}

/* ---- 语音播放 ---- */
function stopAudio() { if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; } const id = playingId; playingId = null; if (id) markPlaying(id, false); }
function markPlaying(id, on) { const el = msgElOf(id); const v = el && el.querySelector('.voice'); if (v) v.classList.toggle('playing', on); }
function togglePlay(id, url) {
  if (playingId === id) { stopAudio(); return; }
  stopAudio();
  const src = disp(url);
  const a = new Audio(); audioEl = a; playingId = id; a.preload = 'auto'; a.src = src; markPlaying(id, true);
  const end = () => { if (playingId === id) { playingId = null; audioEl = null; markPlaying(id, false); } };
  a.onended = end;
  let tried = false;
  // 直接播放失败时：先把文件下载成 Blob 再播（绕开服务器返回的类型/分段请求问题），仍失败就说明具体原因
  a.onerror = async () => {
    const code = a.error ? a.error.code : 0;
    logErr('voice-play', 'MediaError ' + code + ' ' + src.slice(0, 120));
    if (tried || playingId !== id || src.indexOf('blob:') === 0) { end(); toast('语音播放失败（错误码 ' + code + '）'); return; }
    tried = true;
    try {
      const r = await fetch(src, { cache: 'no-store' });
      if (!r.ok) { end(); toast('语音文件读取失败（HTTP ' + r.status + '）'); logErr('voice-http', r.status + ' ' + src.slice(0, 120)); return; }
      const buf = await r.arrayBuffer();
      if (playingId !== id) return;
      const b = new Blob([buf], { type: 'audio/wav' }), u = URL.createObjectURL(b);
      const a2 = new Audio(); audioEl = a2; a2.preload = 'auto'; a2.src = u;
      a2.onended = () => { end(); try { URL.revokeObjectURL(u); } catch (e) {} };
      a2.onerror = () => { end(); toast('语音无法解码（错误码 ' + (a2.error ? a2.error.code : 0) + '，大小 ' + buf.byteLength + '）'); };
      const p2 = a2.play(); if (p2 && p2.catch) p2.catch(e => { if (e && e.name === 'NotAllowedError') { end(); toast('无法播放语音，请再点一次'); } });
    } catch (e) { end(); toast('语音下载失败：网络连不上存储服务'); logErr('voice-fetch', e); }
  };
  const p = a.play(); if (p && p.catch) p.catch(e => { if (e && e.name === 'NotAllowedError') { end(); toast('无法播放语音'); } });
}

/* ================= 录音（WAV，所有浏览器通用、不依赖 MediaRecorder）================= */
const rec = { state: 'idle', token: 0, ctx: null, stream: null, src: null, proc: null, chunks: [], len: 0, rate: 44100, t0: 0, y0: 0, cancel: false, tm: 0 };
function recProblem() {
  if (iosAppWebview()) return IOS_APP_MSG;
  if (!window.isSecureContext) return '录音需要 https 地址（或 localhost）';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return '当前浏览器不支持录音（微信/QQ 等内置浏览器常见），请用 Safari / Chrome 打开';
  if (!(window.AudioContext || window.webkitAudioContext)) return '当前浏览器不支持录音';
  return '';
}
function recUI(on, text) {
  const o = $('record-overlay'); o.classList.toggle('active', !!on); if (!on) o.classList.remove('cancel');
  if (text) $('record-text').textContent = text;
  $('btn-audio').textContent = on ? '松开 发送' : '按住 说话';
}
function recCleanup() {
  clearInterval(rec.tm);
  try { if (rec.proc) { rec.proc.onaudioprocess = null; rec.proc.disconnect(); } if (rec.src) rec.src.disconnect(); } catch (e) {}
  stopStream(rec.stream);
  try { if (rec.ctx && rec.ctx.state !== 'closed') { const p = rec.ctx.close(); if (p && p.catch) p.catch(() => {}); } } catch (e) {}
  rec.stream = rec.src = rec.proc = rec.ctx = null; rec.chunks = []; rec.len = 0; rec.state = 'idle';
  recUI(false);
}
function recAbort() { if (rec.state === 'idle') return; rec.token++; recCleanup(); }
function recTick() {
  const s = (now() - rec.t0) / 1000;
  $('record-overlay').classList.toggle('cancel', rec.cancel);
  $('record-text').textContent = Math.floor(s) + '″  ' + (rec.cancel ? '松开手指，取消发送' : '手指上滑，取消发送');
  if (s >= 60) recEnd(false);
}
function recStart(y) {
  if (rec.state !== 'idle' || !S.conv) return;
  const pr = recProblem(); if (pr) { toast(pr); return; }
  const token = ++rec.token; rec.state = 'starting'; rec.y0 = y || 0; rec.cancel = false; rec.chunks = []; rec.len = 0;
  recUI(true, '手指上滑，取消发送');
  let ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC(); rec.ctx = ctx; rec.rate = ctx.sampleRate || 44100;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});   // iOS：必须在手势里创建/恢复
  } catch (e) { logErr('rec-ctx', e); recCleanup(); toast('无法初始化录音'); return; }
  gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, 20000).then(stream => {
    if (token !== rec.token || rec.state !== 'starting') { stopStream(stream); return; }
    try {
      rec.stream = stream;
      const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = e => { if (rec.state !== 'recording') return; const d = e.inputBuffer.getChannelData(0); rec.chunks.push(new Float32Array(d)); rec.len += d.length; };
      src.connect(proc); proc.connect(ctx.destination); rec.src = src; rec.proc = proc;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      rec.state = 'recording'; rec.t0 = now(); rec.tm = setInterval(recTick, 200);
    } catch (e) { logErr('rec-start', e); recCleanup(); toast('无法开始录音'); }
  }).catch(e => { if (token !== rec.token) return; logErr('rec-gum', e); recCleanup(); toast('无法录音：' + micError(e)); });
}
function recMove(y) { if (rec.state === 'idle') return; rec.cancel = rec.y0 - y > 60; }
function recEnd(cancel) {
  if (rec.state === 'idle') return;
  if (rec.state === 'starting') { rec.token++; recCleanup(); return; }
  const dc = cancel || rec.cancel, sec = (now() - rec.t0) / 1000;
  const blob = dc ? null : encodeWav(rec.chunks, rec.len, rec.rate);
  recCleanup();
  if (dc) { SFX.cancel(); return; }
  if (sec < 0.8 || !blob) { toast('说话时间太短'); return; }
  sendVoice(blob, Math.max(1, Math.round(sec)));
}
function encodeWav(chunks, len, srcRate) {
  const target = 12000, ratio = srcRate / target, outLen = Math.max(1, Math.floor(len / ratio));
  const merged = new Float32Array(len); let o = 0, peak = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  for (let i = 0; i < len; i++) { const a = Math.abs(merged[i]); if (a > peak) peak = a; }
  const gain = peak > 0.0001 ? Math.min(4, 0.9 / peak) : 1;
  const buf = new ArrayBuffer(44 + outLen * 2), v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + outLen * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, target, true); v.setUint32(28, target * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * ratio), e = Math.min(len, Math.max(s + 1, Math.floor((i + 1) * ratio)));
    let sum = 0; for (let j = s; j < e; j++) sum += merged[j];
    let x = (sum / Math.max(1, e - s)) * gain; x = Math.max(-1, Math.min(1, x));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ================= 好友 ================= */
let searchT = 0;
async function runSearch(q) {
  const el = $('search-results'); q = (q || '').trim();
  if (!q) { el.innerHTML = ''; return; }
  const safe = q.replace(/[,%_\\()[\]*]/g, ''); if (!safe) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="empty">搜索中…</div>';
  const { data, error } = await sb.from('profiles').select('account_id,nickname,avatar_url').or('account_id.ilike.%' + safe + '%,nickname.ilike.%' + safe + '%').neq('account_id', ME()).limit(20);
  if ($('search-input').value.trim() !== q) return;
  if (error) { el.innerHTML = '<div class="empty">搜索失败：' + esc(error.message) + '</div>'; return; }
  if (!data.length) { el.innerHTML = '<div class="empty">没有找到匹配用户</div>'; return; }
  data.forEach(p => { if (!S.profiles[p.account_id]) S.profiles[p.account_id] = p; });
  el.innerHTML = data.map(p => '<div class="search-result">' + avatarHTML(p.nickname, p.avatar_url, isOnline(p.account_id), p.account_id) +
    '<div class="name"><div class="name-main">' + esc(p.nickname) + '</div><div class="name-sub">@' + esc(p.account_id) + '</div></div>' +
    '<div class="row-actions">' + (S.friends.includes(p.account_id) ? '<button class="btn-primary act-chat" data-acc="' + esc(p.account_id) + '">聊天</button>' : '<button class="btn-primary act-add" data-acc="' + esc(p.account_id) + '">加好友</button>') + '</div></div>').join('');
}
async function addFriend(btn) {
  btn.disabled = true;
  const { data, error } = await sb.rpc('send_friend_request', { p_to: btn.dataset.acc });
  if (error) { btn.disabled = false; toast('发送失败：' + error.message); return; }
  if (data === 'ok' || data === 'exists') { btn.textContent = '已发送'; if (data === 'exists') toast('请求已发送过，等待对方处理'); }
  else if (data === 'friends' || data === 'accepted') { btn.textContent = '已是好友'; resync(); }
  else { btn.disabled = false; toast('无法发送（' + data + '）'); }
}
async function acceptRequest(id) {
  const { error } = await sb.rpc('accept_friend_request', { p_req_id: String(id) });
  if (error) { toast('接受失败：' + error.message); return; }
  S.requests = S.requests.filter(r => String(r.id) !== String(id)); sched('reqs'); resync();
}
async function declineRequest(id) {
  S.requests = S.requests.filter(r => String(r.id) !== String(id)); sched('reqs');
  await sb.from('friend_requests').update({ status: 'declined' }).eq('id', id);
}
async function removeFriend(acc) {
  if (!confirm('确定删除好友 @' + acc + ' 吗？')) return;
  const { error } = await sb.rpc('remove_friendship', { p_me: ME(), p_peer: acc });
  if (error) { toast('删除失败：' + error.message); return; }
  bcast('u:' + acc, 'fr', {});
  S.friends = S.friends.filter(a => a !== acc); sched('contacts'); resync();
}

/* ================= 通话 ================= */
function envProblem() {
  if (iosAppWebview()) return IOS_APP_MSG;
  if (!window.isSecureContext) return '通话需要 https 地址（或 localhost）';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return '当前浏览器不支持通话（微信/QQ 等内置浏览器常见），请用 Safari / Chrome 打开';
  if (typeof RTCPeerConnection === 'undefined') return '当前浏览器不支持 WebRTC 通话';
  return '';
}
let sigSeq = 0;
const sqOf = () => ME() + ':' + now().toString(36) + (++sigSeq).toString(36);
function dbSignal(peer, payload, keep) {
  if (S.noSigDb || !sb) return Promise.resolve(false);
  if (keep) return restRpc('send_signal', { p_to: peer, p_payload: payload });   // 页面关闭时：用 keepalive 请求，关掉也能发出去
  return sb.rpc('send_signal', { p_to: peer, p_payload: payload }).then(r => {
    if (r && r.error) { if (isMissingFn(r.error)) S.noSigDb = true; logErr('send_signal', r.error); return false; }
    return true;
  }, e => { logErr('send_signal', e); return false; });
}
async function sig(peer, t, data) {
  const p = Object.assign({ t, from: ME(), sq: sqOf() }, data);
  const [a, b] = await Promise.all([bcast('u:' + peer, 'sig', p), dbSignal(peer, p)]);
  return a || b;
}
function restRpc(fn, body) {   // 直接发 HTTP（带 keepalive），用于页面关闭的那一刻
  if (!S.token) return Promise.resolve(false);
  try {
    return fetch(API_URL + '/rest/v1/rpc/' + fn, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + S.token }, body: JSON.stringify(body || {}) })
      .then(r => r.ok, () => false);
  } catch (e) { return Promise.resolve(false); }
}
let lastPr = null;
function announcePresence(on, keep) {   // 在线状态变化了才发：上线 / 下线各通知好友一次
  if (!S.me || !S.token || lastPr === on) return;
  lastPr = on;
  const p = { t: 'pr', from: ME(), on: on ? 1 : 0, n: now(), sq: sqOf() };
  S.friends.forEach(a => { bcast('u:' + a, 'pr', p, keep); dbSignal(a, p, keep); });
}
const prLast = {}, prAt = {};
function onPresence(p) {
  if (!p || typeof p.from !== 'string' || !S.friends.includes(p.from) || sigDup(p)) return;
  const n = +p.n || 0; if (n && prLast[p.from] && n <= prLast[p.from]) return;   // 两条路到达顺序可能颠倒：只认更新的
  prLast[p.from] = n; prAt[p.from] = { on: !!p.on, t: now() };
  if (p.on) S.fbOnline.add(p.from); else { S.fbOnline.delete(p.from); S.online.delete(p.from); }
  sched('list'); sched('contacts'); sched('title');
}
const sigSeen = new Set();
function sigDup(p) {
  if (!p || typeof p.sq !== 'string') return false;
  if (sigSeen.has(p.sq)) return true;
  sigSeen.add(p.sq); if (sigSeen.size > 600) { const a = Array.from(sigSeen).slice(-300); sigSeen.clear(); a.forEach(x => sigSeen.add(x)); }
  return false;
}
const QUAL = { hd1080: { w: 1920, h: 1080, fps: 30, br: 4000000, name: '超清' }, hd: { w: 1280, h: 720, fps: 30, br: 2500000, name: '清晰' }, sd: { w: 854, h: 480, fps: 30, br: 1000000, name: '流畅' } };
function loadQ() { const q = LS.get('callq', 'hd'); return QUAL[q] ? q : 'hd'; }
function vcons(call, facing) {
  const q = QUAL[call.q] || QUAL.hd;
  return { facingMode: { ideal: facing || call.facing || 'user' }, width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: 30 } };
}
function mkCall(peer, video, caller, id) {
  return { id: id || uuid(), peer, video, caller, pc: null, local: null, remote: null, connected: false, startedAt: 0, candBuf: [], candT: 0, timers: [], dcT: 0, clock: 0, muted: false, camOff: false, ended: false, facing: 'user', q: loadQ(), statsT: 0, prevStats: null, flipping: false };
}
function ctimer(call, fn, ms) { const t = setTimeout(fn, ms); call.timers.push(t); return t; }
function clearTimers(call) { call.timers.forEach(clearTimeout); call.timers = []; }
function setCallStatus(t) { $('call-status').textContent = t; }
let wl = null;
async function wakeOn() {
  if (!navigator.wakeLock || wl) return;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!S.call) { try { l.release(); } catch (e) {} return; }
    wl = l; if (l.addEventListener) l.addEventListener('release', () => { if (wl === l) wl = null; });
  } catch (e) { logErr('wakeLock', e); }
}
function wakeOff() { const l = wl; wl = null; try { if (l) l.release(); } catch (e) {} }
function showCallUI(call, status) {
  wakeOn();
  clearTimeout(S.callHideT);
  $('call-name').textContent = peerName(call.peer); setCallStatus(status);
  $('remote-video').style.display = call.video ? 'block' : 'none';
  $('local-video').style.display = call.video ? 'block' : 'none';
  $('btn-cam').style.display = call.video ? '' : 'none';
  $('btn-mute').classList.remove('off'); $('btn-cam').classList.remove('off'); $('call-tip').style.display = 'none';
  $('call-avatar').innerHTML = avatarHTML(peerName(call.peer), avatarOf(call.peer), false, call.peer);
  $('call-ui').classList.remove('connected', 'swap'); $('call-ui').classList.toggle('video', !!call.video); $('call-stats').classList.remove('show'); $('call-sig').className = 'l4';
  $('call-ui').classList.add('active');
}
function hideCallUI() {
  $('call-ui').classList.remove('active', 'connected', 'video', 'swap'); $('call-stats').classList.remove('show');
  $('remote-video').srcObject = null; $('local-video').srcObject = null; $('remote-audio').srcObject = null;
}
function playEl(el) { try { const p = el.play(); if (p && p.catch) p.catch(() => { $('call-tip').style.display = 'block'; }); } catch (e) {} }
function attachRemote(call) {
  const a = $('remote-audio'); if (a.srcObject !== call.remote) a.srcObject = call.remote; playEl(a);
  if (call.video) { const v = $('remote-video'); if (v.srcObject !== call.remote) v.srcObject = call.remote; playEl(v); }
}
async function getMedia(call) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const fail = e => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError' && false);
  if (call.video) {
    try { return await gum({ audio, video: vcons(call) }, 30000); }
    catch (e) {
      if (fail(e)) throw e;
      try { return await gum({ audio, video: { facingMode: 'user' } }, 30000); } catch (e2) { if (fail(e2)) throw e2; }
    }
    try {
      const s = await gum({ audio }, 30000); call.video = false;
      $('remote-video').style.display = 'none'; $('local-video').style.display = 'none'; $('btn-cam').style.display = 'none'; $('call-ui').classList.remove('video');
      toast('摄像头不可用，已切换为语音通话'); return s;
    } catch (e3) { throw e3; }
  }
  return await gum({ audio, video: false }, 30000);
}
function vSender(call) { return call.pc && call.pc.getSenders().find(x => x.track && x.track.kind === 'video'); }
const relaySave = () => LS.get('ch2relaysave2', false) === true;   // 默认关：走中转也不降画质，想省流量由用户自己打开
const saving = call => !!(call && call.relay && relaySave());
function aSender(call) { return call.pc && call.pc.getSenders().find(x => x.track && x.track.kind === 'audio'); }
async function applyAudioParams(call) {
  const sd = aSender(call); if (!sd || !sd.getParameters || !sd.setParameters) return;
  try {
    const pr = sd.getParameters();
    if (!pr.encodings || !pr.encodings.length) pr.encodings = [{}];
    if (saving(call)) pr.encodings[0].maxBitrate = 24000; else delete pr.encodings[0].maxBitrate;
    await sd.setParameters(pr);
  } catch (e) { logErr('setParameters-a', e); }
}
async function applyCallParams(call) { await applyAudioParams(call); await applyVideoParams(call); }
async function applyVideoParams(call) {
  if (!call.video || !call.pc) return;
  const q = QUAL[call.q] || QUAL.hd;
  const vt = call.local && call.local.getVideoTracks()[0];
  try { if (vt && 'contentHint' in vt) vt.contentHint = call.q === 'sd' ? 'motion' : 'detail'; } catch (e) {}
  const sd = vSender(call); if (!sd || !sd.getParameters || !sd.setParameters) return;
  try {
    const pr = sd.getParameters();
    if (!pr.encodings || !pr.encodings.length) pr.encodings = [{}];
    if (saving(call)) {                                         // 走中转：约 300kbps、分辨率减半，节省中转额度
      pr.encodings[0].maxBitrate = 300000; pr.encodings[0].scaleResolutionDownBy = 2; pr.encodings[0].maxFramerate = Math.min(q.fps, 24);
      try { pr.degradationPreference = 'balanced'; } catch (e) {}
    } else {                                                    // 直连：按画质设置，不限
      pr.encodings[0].maxBitrate = q.br; pr.encodings[0].scaleResolutionDownBy = 1; pr.encodings[0].maxFramerate = q.fps;
      try { pr.degradationPreference = call.q === 'sd' ? 'balanced' : 'maintain-resolution'; } catch (e) {}
    }
    await sd.setParameters(pr);
  } catch (e) { logErr('setParameters', e); }
}
async function setQuality(call, key) {
  if (!QUAL[key]) return;
  call.q = key; LS.set('callq', key); $('btn-q').textContent = '画质：' + QUAL[key].name;
  const vt = call.local && call.local.getVideoTracks()[0], q = QUAL[key];
  if (vt && vt.applyConstraints) { try { await vt.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: 30 } }); } catch (e) { logErr('applyConstraints', e); } }
  await applyVideoParams(call);
}
async function flipCam(call) {
  if (!call || call.flipping || !call.video || call.ended || !call.local) return;
  const old = call.local.getVideoTracks()[0]; if (!old) return;
  call.flipping = true;
  const prevFacing = call.facing, next = prevFacing === 'user' ? 'environment' : 'user';
  const wasOff = call.camOff;
  try { old.stop(); } catch (e) {}                 // iOS 不允许同时打开两个摄像头：先关旧的
  let nt = null, used = next;
  try { nt = (await gum({ video: vcons(call, next) }, 15000)).getVideoTracks()[0]; }
  catch (e) {
    logErr('flipCam', e);
    try { nt = (await gum({ video: vcons(call, prevFacing) }, 15000)).getVideoTracks()[0]; used = prevFacing; toast('无法切换摄像头，已恢复原摄像头'); } catch (e2) { logErr('flipCam-restore', e2); }
  }
  if (call.ended || S.call !== call) { if (nt) try { nt.stop(); } catch (e) {} call.flipping = false; return; }
  if (!nt) { call.flipping = false; toast('摄像头出错，已关闭视频'); call.camOff = true; $('btn-cam').classList.add('off'); return; }
  try {
    nt.enabled = !wasOff;
    const sd = vSender(call) || (call.pc && call.pc.getSenders().find(x => !x.track && x.dtmf === undefined));
    if (sd) await sd.replaceTrack(nt);
    try { call.local.removeTrack(old); } catch (e) {}
    call.local.addTrack(nt);
    call.facing = used;
    const lv = $('local-video'); lv.srcObject = call.local; playEl(lv);
    lv.classList.toggle('mirror', used === 'user');
    await applyVideoParams(call);
  } catch (e) { logErr('flipCam-replace', e); toast('切换失败，请再试一次'); }
  call.flipping = false;
}
function sigLevel(loss, rtt, br) {
  if (rtt == null && loss == null) return 4;
  let l = 4;
  if (loss != null) { if (loss > 8) l = Math.min(l, 1); else if (loss > 4) l = Math.min(l, 2); else if (loss > 1.5) l = Math.min(l, 3); }
  if (rtt != null) { if (rtt > 600) l = Math.min(l, 1); else if (rtt > 350) l = Math.min(l, 2); else if (rtt > 180) l = Math.min(l, 3); }
  return l;
}
async function pollStats(call) {
  if (!call.pc || call.ended || S.call !== call || !call.connected) return;
  let rep; try { rep = await call.pc.getStats(); } catch (e) { return; }
  const now0 = Date.now(), cur = { t: now0, rx: 0, tx: 0, lost: 0, rcv: 0 };
  let inV = null, outV = null, pair = null, byId = {};
  rep.forEach(r => { byId[r.id] = r; });
  rep.forEach(r => {
    if (r.type === 'inbound-rtp') { cur.rx += r.bytesReceived || 0; cur.lost += r.packetsLost || 0; cur.rcv += r.packetsReceived || 0; if (r.kind === 'video') inV = r; }
    else if (r.type === 'outbound-rtp') { cur.tx += r.bytesSent || 0; if (r.kind === 'video') outV = r; }
    else if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded' && (!pair || (r.bytesReceived || 0) + (r.bytesSent || 0) > (pair.bytesReceived || 0) + (pair.bytesSent || 0))) pair = r;
  });
  rep.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId && byId[r.selectedCandidatePairId]) pair = byId[r.selectedCandidatePairId]; });
  const pv = call.prevStats; call.prevStats = cur;
  let rxK = null, txK = null, lossP = null;
  if (pv && cur.t > pv.t) {
    const dt = (cur.t - pv.t) / 1000;
    rxK = Math.max(0, (cur.rx - pv.rx) * 8 / dt / 1000); txK = Math.max(0, (cur.tx - pv.tx) * 8 / dt / 1000);
    const dl = Math.max(0, cur.lost - pv.lost), dr = Math.max(0, cur.rcv - pv.rcv);
    lossP = dl + dr > 0 ? dl * 100 / (dl + dr) : 0;
  }
  const rtt = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
  let route = '';
  if (pair) {
    const lc = byId[pair.localCandidateId], rc = byId[pair.remoteCandidateId];
    route = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay') ? '中转' : '直连';
  }
  if (route && now0 - (call.relayChk || 0) >= 4000) {         // 每 4 秒复查一次是否走中转
    call.relayChk = now0;
    const relay = route === '中转';
    if (relay !== !!call.relay) {
      call.relay = relay; applyCallParams(call);
      if (relay && relaySave() && !call.relayTold) { call.relayTold = true; toast('正在走中转服务器：已自动降低码率，节省中转流量'); }
    }
  }
  call.stat = { rxK, txK, lossP, rtt, route, rxRes: inV && inV.frameWidth ? inV.frameWidth + '×' + inV.frameHeight : '', rxFps: inV && inV.framesPerSecond != null ? Math.round(inV.framesPerSecond) : null, txRes: outV && outV.frameWidth ? outV.frameWidth + '×' + outV.frameHeight : '', txFps: outV && outV.framesPerSecond != null ? Math.round(outV.framesPerSecond) : null, limit: outV && outV.qualityLimitationReason && outV.qualityLimitationReason !== 'none' ? outV.qualityLimitationReason : '' };
  const lv = pv ? sigLevel(lossP, rtt) : 4;
  const sg = $('call-sig'); sg.className = 'l' + lv;
  if ($('call-stats').classList.contains('show')) renderStats(call);
}
function renderStats(call) {
  const x = call.stat; if (!x) { $('call-stats').textContent = '统计中…'; return; }
  const k = v => v == null ? '-' : v >= 1000 ? (v / 1000).toFixed(1) + ' Mbps' : Math.round(v) + ' kbps';
  const lim = { bandwidth: '带宽不足', cpu: '设备性能不足', other: '受限' };
  let t = '';
  if (call.video) t += '收 ' + (x.rxRes || '-') + ' · ' + (x.rxFps == null ? '-' : x.rxFps) + 'fps · ' + k(x.rxK) + '\n发 ' + (x.txRes || '-') + ' · ' + (x.txFps == null ? '-' : x.txFps) + 'fps · ' + k(x.txK) + (x.limit ? '（' + (lim[x.limit] || x.limit) + '）' : '') + '\n';
  else t += '收 ' + k(x.rxK) + ' · 发 ' + k(x.txK) + '\n';
  t += '延迟 ' + (x.rtt == null ? '-' : x.rtt + 'ms') + ' · 丢包 ' + (x.lossP == null ? '-' : x.lossP.toFixed(1) + '%') + ' · ' + (x.route || '-');
  if (saving(call)) t += '\n中转省流量中：视频约 300kbps、分辨率减半，语音约 24kbps';
  else if (call.relay) t += '\n走中转：保持你选的画质（会用中转额度；想省流量可在“我 → 中转省流量”打开）';
  const el = $('call-stats'); el.textContent = t; el.style.whiteSpace = 'pre-line';
}
function makePC(call) {
  const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
  call.pc = pc;
  pc.onicecandidate = e => { if (e.candidate) queueCand(call, e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); else flushCand(call); };
  pc.ontrack = e => {
    if (!call.remote) call.remote = new MediaStream();
    if (e.track && !call.remote.getTracks().some(t => t.id === e.track.id)) call.remote.addTrack(e.track);
    attachRemote(call);
  };
  pc.onconnectionstatechange = () => onPcState(call);
  pc.oniceconnectionstatechange = () => onPcState(call);
  call.local.getTracks().forEach(t => pc.addTrack(t, call.local));
  if (call.video) { const lv = $('local-video'); lv.srcObject = call.local; lv.classList.toggle('mirror', call.facing === 'user'); playEl(lv); applyVideoParams(call); $('btn-q').textContent = '画质：' + (QUAL[call.q] || QUAL.hd).name; }
  return pc;
}
function queueCand(call, c) { call.candBuf.push(c); if (!call.candT) call.candT = setTimeout(() => flushCand(call), 100); }
function flushCand(call) {
  clearTimeout(call.candT); call.candT = 0;
  if (!call.candBuf.length || call.ended) return;
  const c = call.candBuf; call.candBuf = []; sig(call.peer, 'ice', { id: call.id, c });
}
async function flushPendingIce(call) {
  const list = S.pendingIce[call.id]; delete S.pendingIce[call.id];
  if (!list || !call.pc) return;
  for (const c of list) { try { await call.pc.addIceCandidate(c); } catch (e) {} }
}
function onPcState(call) {
  if (call.ended || S.call !== call || !call.pc) return;
  let st = call.pc.connectionState; if (!st || st === 'new') st = call.pc.iceConnectionState; if (st === 'completed') st = 'connected';
  if (st === 'connected') {
    clearTimeout(call.dcT);
    if (!call.connected) {
      call.connected = true; call.startedAt = now(); clearTimers(call);
      SFX.backStop(); SFX.connect(); $('call-ui').classList.add('connected');
      const tick = () => setCallStatus(fmtDur(Math.floor((now() - call.startedAt) / 1000)));
      tick(); call.clock = setInterval(tick, 500);
      applyCallParams(call); clearInterval(call.statsT); call.statsT = setInterval(() => pollStats(call), 2000); setTimeout(() => pollStats(call), 600);
    }
  } else if (st === 'disconnected') {
    if (call.connected) setCallStatus('网络不稳定，重连中…');
    clearTimeout(call.dcT);
    call.dcT = setTimeout(() => {
      if (S.call !== call || !call.pc) return;
      const s2 = call.pc.connectionState || call.pc.iceConnectionState;
      if (s2 === 'disconnected' || s2 === 'failed') endCall('网络中断', true);
    }, 8000);
  } else if (st === 'failed') {
    endCall(call.connected ? '网络中断' : '连接失败：网络受限（可能需要配置 TURN 服务器）', true);
  }
}
async function startCall(video) {
  if (S.call || S.incoming || !S.peer) return;
  const pr = envProblem(); if (pr) { toast(pr); return; }
  if (!S.rt.user && S.noSigDb) { toast('实时通道连不上，且还没有运行 setup-v4.sql，暂时不能通话（我的 → 环境诊断）'); return; }
  const call = mkCall(S.peer, !!video, true); S.call = call;
  showCallUI(call, '正在呼叫…'); SFX.backStart();
  try {
    call.local = await getMedia(call); if (S.call !== call) { stopStream(call.local); return; }
    const pc = makePC(call);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    const ok = await sig(call.peer, 'invite', { id: call.id, video: call.video, sdp: { type: offer.type, sdp: offer.sdp } });
    if (!ok) throw new Error('信令发送失败，请检查网络');
    ctimer(call, () => { if (S.call === call && !call.connected) endCall('对方未接听', true); }, 45000);
  } catch (e) { logErr('startCall', e); if (S.call === call) endCall('无法发起通话：' + micError(e), false); }
}
function onInvite(p) {
  if (!p.sdp || typeof p.sdp.sdp !== 'string') return;
  if (S.incoming && S.incoming.id === p.id) return;
  if (S.call && S.call.id === p.id) return;
  if (S.call || S.incoming) { sig(p.from, 'busy', { id: p.id }); return; }
  S.incoming = { id: p.id, from: p.from, video: !!p.video, sdp: p.sdp };
  $('incoming-name').textContent = peerName(p.from); $('incoming-avatar').innerHTML = avatarHTML(peerName(p.from), avatarOf(p.from), false, p.from); $('incoming-type').textContent = p.video ? '邀请你视频通话…' : '邀请你语音通话…';
  $('incoming-ui').classList.add('active');
  try { if (navigator.vibrate) navigator.vibrate([300, 200, 300, 200, 300]); } catch (e) {}
  SFX.ringStart();
  clearTimeout(S.incTimer); S.incTimer = setTimeout(() => { if (S.incoming && S.incoming.id === p.id) declineCall(); }, 40000);
}
function clearIncoming() { SFX.ringStop(); clearTimeout(S.incTimer); S.incoming = null; $('incoming-ui').classList.remove('active'); }
function declineCall() {
  const inc = S.incoming; if (!inc) return;
  clearIncoming(); delete S.pendingIce[inc.id]; sig(inc.from, 'reject', { id: inc.id });
}
async function acceptCall() {
  const inc = S.incoming; if (!inc) return;
  const pr = envProblem();
  if (pr) { toast(pr); declineCall(); return; }
  clearIncoming();
  const call = mkCall(inc.from, inc.video, false, inc.id); S.call = call;
  showCallUI(call, '连接中…');
  try {
    call.local = await getMedia(call); if (S.call !== call) { stopStream(call.local); return; }
    const pc = makePC(call);
    await pc.setRemoteDescription(inc.sdp);
    await flushPendingIce(call);
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    const ok = await sig(call.peer, 'accept', { id: call.id, sdp: { type: ans.type, sdp: ans.sdp } });
    if (!ok) throw new Error('信令发送失败，请检查网络');
    ctimer(call, () => { if (S.call === call && !call.connected) endCall('连接超时：网络受限（可能需要配置 TURN 服务器）', true); }, 25000);
  } catch (e) { logErr('acceptCall', e); if (S.call === call) endCall('接听失败：' + micError(e), true); }
}
async function onAccept(p) {
  const call = S.call;
  if (!call || call.id !== p.id || !call.caller || !call.pc || !p.sdp || call.pc.signalingState !== 'have-local-offer') return;
  try {
    clearTimers(call); setCallStatus('连接中…');
    await call.pc.setRemoteDescription(p.sdp);
    await flushPendingIce(call);
    ctimer(call, () => { if (S.call === call && !call.connected) endCall('连接超时：网络受限（可能需要配置 TURN 服务器）', true); }, 25000);
  } catch (e) { logErr('onAccept', e); if (S.call === call) endCall('连接失败', true); }
}
async function onIce(p) {
  const list = Array.isArray(p.c) ? p.c : [];
  const call = S.call;
  if (call && call.id === p.id && call.pc && call.pc.remoteDescription) {
    for (const c of list) { try { await call.pc.addIceCandidate(c); } catch (e) {} }
  } else { (S.pendingIce[p.id] = S.pendingIce[p.id] || []).push.apply(S.pendingIce[p.id], list); }
}
function onSig(p) {
  if (!p || typeof p !== 'object' || typeof p.from !== 'string' || typeof p.id !== 'string' || !S.friends.includes(p.from)) return;
  if (sigDup(p)) return;
  switch (p.t) {
    case 'invite': return onInvite(p);
    case 'accept': return onAccept(p);
    case 'ice': return onIce(p);
    case 'reject': case 'busy': { const c = S.call; if (c && c.id === p.id) endCall(p.t === 'busy' ? '对方忙线中' : '对方已拒绝', false); return; }
    case 'end': {
      const c = S.call;
      if (c && c.id === p.id) endCall(c.connected ? '通话已结束' : '对方已取消', false);
      else if (S.incoming && S.incoming.id === p.id) { clearIncoming(); toast('对方已取消通话'); }
      delete S.pendingIce[p.id]; return;
    }
  }
}
function sendCallLog(call, dur) {
  const conv = convKeyOf(ME(), call.peer);
  const m = { id: uuid(), conv, from_acc: ME(), to_acc: call.peer, type: 'call', body: call.video ? 'video' : 'audio', dur, created_at: new Date().toISOString(), _st: 'sending' };
  S.out.set(m.id, m);
  if (S.conv === conv) { S.msgs.push(m); chatAppend(m, true); }
  touchConv(conv, '[通话]', m.created_at, false);
  deliver(m);
}
function endCall(reason, notify) {
  const call = S.call;
  if (!call) { hideCallUI(); return; }
  S.call = null; call.ended = true; wakeOff(); SFX.backStop(); SFX.ringStop(); SFX.hangup();
  clearTimers(call); clearTimeout(call.dcT); clearTimeout(call.candT); clearInterval(call.clock); clearInterval(call.statsT);
  const dur = call.connected && call.startedAt ? Math.floor((now() - call.startedAt) / 1000) : 0;
  if (notify) sig(call.peer, 'end', { id: call.id });
  try { if (call.pc) { call.pc.onicecandidate = null; call.pc.ontrack = null; call.pc.onconnectionstatechange = null; call.pc.oniceconnectionstatechange = null; call.pc.close(); } } catch (e) {}
  stopStream(call.local); stopStream(call.remote);
  delete S.pendingIce[call.id];
  if (call.caller) sendCallLog(call, dur);
  if (reason) { setCallStatus(reason); clearTimeout(S.callHideT); S.callHideT = setTimeout(() => { if (!S.call) hideCallUI(); }, 2200); }
  else hideCallUI();
}

/* ================= 实时 / 在线 / 定时同步 ================= */
function startRealtime() {
  if (!sb || !S.me) return;
  const gen = ++S.rtGen, acc = ME();
  [S.chDb, S.chUser].forEach(c => { if (c) { try { sb.removeChannel(c); } catch (e) {} } });
  S.rt.db = false; S.rt.user = false;
  const filt = (table, col) => ({ schema: 'public', table, filter: col + '=eq.' + acc });
  let first = true;
  S.chDb = sb.channel('db-' + acc + '-' + gen)
    .on('postgres_changes', Object.assign({ event: 'INSERT' }, filt('messages', 'to_acc')), p => { try { onDbMsg(p.new, 'ins'); } catch (e) { logErr('db-ins', e); } })
    .on('postgres_changes', Object.assign({ event: 'UPDATE' }, filt('messages', 'to_acc')), p => { try { onDbMsg(p.new, 'upd'); } catch (e) { logErr('db-upd', e); } })
    .on('postgres_changes', Object.assign({ event: '*' }, filt('conversations', 'owner_acc')), p => { try { if (p.eventType === 'DELETE') return; upsertConvRow(p.new); } catch (e) { logErr('db-conv', e); } })
    .on('postgres_changes', Object.assign({ event: '*' }, filt('friend_requests', 'to_acc')), p => {
      try {
        const r = p.new; if (!r || !r.id) return;
        S.requests = S.requests.filter(x => String(x.id) !== String(r.id));
        if (r.status === 'pending') { S.requests.unshift(r); SFX.notify(); }
        sched('reqs'); saveCache();
      } catch (e) { logErr('db-req', e); }
    })
    .on('postgres_changes', Object.assign({ event: '*' }, filt('friendships', 'owner_acc')), () => resyncSoon())
    .subscribe((st, err) => {
      if (gen !== S.rtGen) return;
      S.rt.db = st === 'SUBSCRIBED';
      if (st === 'SUBSCRIBED') { if (!first) resyncSoon(); first = false; }
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') rtFailLog('rt-db', err || st);
    });
  S.chUser = sb.channel('u:' + acc, { config: { private: true } })
    .on('broadcast', { event: 'm' }, ({ payload }) => onFastMsg(payload))
    .on('broadcast', { event: 'r' }, ({ payload }) => { try { onFastRecall(payload); } catch (e) { logErr('fast-r', e); } })
    .on('broadcast', { event: 'ty' }, ({ payload }) => { try { onTyping(payload); } catch (e) { logErr('ty', e); } })
    .on('broadcast', { event: 'rd' }, ({ payload }) => { try { onReadAck(payload); } catch (e) { logErr('rd', e); } })
    .on('broadcast', { event: 'rq' }, ({ payload }) => { try { onReadReq(payload); } catch (e) { logErr('rq', e); } })
    .on('broadcast', { event: 'pr' }, ({ payload }) => { try { onPresence(payload); } catch (e) { logErr('pr', e); } })
    .on('broadcast', { event: 'fr' }, () => resyncSoon())
    .on('broadcast', { event: 'sig' }, ({ payload }) => { try { onSig(payload); } catch (e) { logErr('sig', e); } })
    .subscribe((st, err) => {
      if (gen !== S.rtGen) return;
      S.rt.user = st === 'SUBSCRIBED';
      if (st === 'SUBSCRIBED') showBanner('');
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
        rtFailLog('rt-user', err || st);
        const why = String((err && (err.message || err)) || '');
        if (st === 'CHANNEL_ERROR' && /unauthori|permission|denied|policy|not allowed/i.test(why)) showBanner('实时通道没有权限：请重新执行最新的 setup.sql（含 realtime.messages 策略）');
      }
    });
}
const rtFailSeen = {};
function rtFailLog(tag, e) { if (rtFailSeen[tag]) return; rtFailSeen[tag] = 1; logErr(tag, (e && (e.message || e)) || e); }   // 国内网络会反复失败：只记一次，避免刷屏

/* ================= 国内模式：实时通道连不上时，用普通请求顶替 ================= */
let fbT = 0, fbRun = 0, msgCursor = 0, lastMsgPoll = 0, lastSigPoll = 0, lastSeenPoll = 0, lastReadPoll = 0;
const pollTypes = new Map();
function fbSchedule(ms) { clearTimeout(fbT); fbT = setTimeout(fbLoop, ms); }
function fbStart() { fbRun++; msgCursor = 0; lastSeenPoll = 0; pollTypes.clear(); fbSchedule(800); }
function fbStop() { fbRun++; clearTimeout(fbT); }
function fbKick() { fbRun++; clearTimeout(fbT); fbT = setTimeout(fbLoop, 50); }   // 立刻重启循环（旧的那轮会自己退出）
async function fbLoop() {
  const run = fbRun;
  if (!S.started || !sb || !S.me) return;
  if (document.hidden) { fbSchedule(3000); return; }
  let next = 1000;
  try {
    const need = !S.rt.db || !S.rt.user;
    if (need && !S.noInbox) { await pollInbox(); next = 30; }   // 长轮询：服务器一有新内容立刻返回，没有就等 2.5 秒
    else if (need) {                                            // 没运行 setup-v4.sql：退回普通轮询
      const t = now();
      if (!S.rt.user && !S.noSigDb && t - lastSigPoll >= 2000) { lastSigPoll = t; await pollSignals(); }
      if (!S.rt.db && t - lastMsgPoll >= 2000) { lastMsgPoll = t; await pollMsgs(); }
    }
    if (run !== fbRun) return;
    const t = now();
    if (!S.rt.user && S.conv && t - lastReadPoll >= 4000) { lastReadPoll = t; fetchPeerRead(S.conv); }
    if (t - lastSeenPoll >= 40000) { lastSeenPoll = t; heartbeat(true); pollSeen(); if (S.rt.user && !S.noSigDb) { lastSigPoll = t; await pollSignals(); } }
  } catch (e) { if (e && e.abort) next = 30; else { logErr('fb', (e && e.message) || e); next = 2000; } }   // 卡住被放弃：马上重发；其他错误：等 2 秒
  if (run !== fbRun) return;
  fbSchedule(next);
}
async function pollInbox() {
  let base = 0;
  if (!msgCursor) { S.convs.forEach(c => { base = Math.max(base, Date.parse(c.last_ts || 0) || 0); }); msgCursor = base || (now() - 60000); }
  const ctl = window.AbortController ? new AbortController() : null, tm = ctl ? setTimeout(() => ctl.abort(), 10000) : 0;   // 国内网络偶尔会让请求卡住：10 秒没回就放弃重发
  let q = sb.rpc('poll_inbox', { p_since: new Date(msgCursor).toISOString(), p_wait_ms: base ? 0 : 2500 });
  if (ctl && q && typeof q.abortSignal === 'function') q = q.abortSignal(ctl.signal);
  let res; try { res = await q; } finally { clearTimeout(tm); }
  const { data, error } = res || {};
  if (error) { if (isMissingFn(error)) S.noInbox = true; const er = new Error('poll_inbox ' + (error.message || error.code)); er.abort = /abort/i.test(String(error.message || '')); throw er; }
  const d = data || {};
  handleMsgRows(d.msgs || [], base);
  handleSigRows(d.sigs || []);
}
function handleSigRows(rows) {
  rows.slice().sort((a, b) => a.id - b.id).forEach(r => {
    const p = Object.assign({}, r.payload || {}, { from: r.from_acc });   // 发信人以服务器记录为准
    try { if (p.t === 'ty') onTyping(p); else if (p.t === 'pr') onPresence(p); else onSig(p); } catch (e) { logErr('sig-db', e); }
  });
}
function handleMsgRows(rows, base) {
  rows.forEach(r => {
    const m = rowToMsg(r); const t = Date.parse(m.created_at) || 0; if (t > msgCursor) msgCursor = t;
    if (pollTypes.get(m.id) === m.type) return;
    pollTypes.set(m.id, m.type); if (pollTypes.size > 500) pollTypes.delete(pollTypes.keys().next().value);
    if (base && t <= base) { S.seen.add(m.id); return; }   // 第一次：会话列表里已有的消息，只登记、不当新消息提醒
    if (m.type === 'recalled' && S.seen.has(m.id)) { if (S.conv === m.conv) upsertMsg(m); return; }
    onIncoming(m);
  });
}
async function pollSignals() {
  const { data, error } = await sb.rpc('take_signals');
  if (error) { if (isMissingFn(error)) S.noSigDb = true; logErr('take_signals', error); return; }
  handleSigRows(data || []);
}
async function pollMsgs() {
  let base = 0;
  if (!msgCursor) { S.convs.forEach(c => { base = Math.max(base, Date.parse(c.last_ts || 0) || 0); }); msgCursor = base || (now() - 60000); }
  const since = new Date(msgCursor - 15000).toISOString();   // 往回多看 15 秒，防止漏掉同一时刻提交的消息
  const { data, error } = await sb.from('messages').select('*').eq('to_acc', ME()).gt('created_at', since).order('created_at', { ascending: true }).limit(100);
  if (error) { logErr('pollMsgs', error); return; }
  handleMsgRows(data || [], base);
}
async function heartbeat(on) {
  if (S.noPres || !sb || !S.me) return;
  try { const r = await sb.rpc('heartbeat', { p_online: on !== false }); if (r && r.error && isMissingFn(r.error)) S.noPres = true; } catch (e) {}
}
async function pollSeen() {
  if (S.noPres || !sb || !S.me) return;
  try {
    const { data, error } = await sb.rpc('friends_seen');
    if (error) { if (isMissingFn(error)) S.noPres = true; return; }
    const n = new Set(); (data || []).forEach(r => { if (r && r.online) n.add(r.account_id); });
    Object.keys(prAt).forEach(a => { const x = prAt[a]; if (now() - x.t < 10000) { if (x.on) n.add(a); else n.delete(a); } });   // 10 秒内刚收到的上下线推送比数据库更新，以推送为准
    const same = n.size === S.fbOnline.size && Array.from(n).every(x => S.fbOnline.has(x));
    if (!same) { S.fbOnline = n; sched('list'); sched('contacts'); sched('title'); }
  } catch (e) {}
}

let resyncT = 0;
function resyncSoon() { clearTimeout(resyncT); resyncT = setTimeout(resync, 300); }
function setupPresence() {
  if (!sb || !S.me) return;
  const gen = ++S.presGen, acc = ME();
  if (S.presCh) { try { sb.removeChannel(S.presCh); } catch (e) {} }
  const ch = sb.channel('presence:online', { config: { presence: { key: acc } } }); S.presCh = ch;
  ch.on('presence', { event: 'sync' }, () => {
    if (gen !== S.presGen) return;
    try { S.online = new Set(Object.keys(ch.presenceState() || {})); } catch (e) {}
    sched('list'); sched('contacts'); sched('title');
  }).subscribe(async st => { if (gen === S.presGen && st === 'SUBSCRIBED') { try { await ch.track({ t: now() }); } catch (e) {} } });
}
function startTimers() {
  clearInterval(S.tm); let n = 0;
  S.tm = setInterval(() => {
    if (document.hidden || !sb || !S.me) return;
    n++;
    const lp = !S.noInbox;                                         // 国内模式的长轮询在工作：新消息已经即时到达，补漏校对放慢到 18 秒
    if (S.rt.db && S.rt.user ? n % 5 === 0 : (!lp || n % 3 === 0)) resync();   // 实时正常：每 30 秒校对一次；异常：6 秒（长轮询时 18 秒）
    if (!S.rt.db && S.conv && (!lp || n % 3 === 0)) syncChat();
    retryFailed();
    if (S.conv && n % 5 === 0) fetchPeerRead(S.conv);
  }, 6000);
}
function teardown() {
  S.started = false;
  clearInterval(S.tm); clearTimeout(resyncT); clearTimeout(S.incTimer); fbStop(); if (S.me) { restRpc('heartbeat', { p_online: false }); announcePresence(false, true); } lastPr = null;
  S.rtGen++; S.presGen++;
  [S.chDb, S.chUser, S.presCh].forEach(c => { if (c && sb) { try { sb.removeChannel(c); } catch (e) {} } });
  S.chDb = S.chUser = S.presCh = null; S.rt.db = S.rt.user = false;
  wakeOff(); SFX.stopAll();
  if (S.call) { const c = S.call; S.call = null; c.ended = true; clearTimers(c); clearInterval(c.clock); clearInterval(c.statsT); try { c.pc && c.pc.close(); } catch (e) {} stopStream(c.local); stopStream(c.remote); }
  S.incoming = null; hideCallUI(); $('incoming-ui').classList.remove('active');
  recAbort(); stopAudio();
  document.body.classList.remove('chat-open');
  S.me = null; S.uid = null; S.token = null; S.convs = []; S.msgs = []; S.out = new Map(); S.conv = null; S.peer = null; S.friends = []; S.requests = []; S.profiles = {}; S.online = new Set(); S.fbOnline = new Set(); S.noSigDb = false; S.noPres = false; S.noInbox = false; S.seen = new Set(); S.peerRead = {}; S.reply = null; S.typingUntil = 0; hidden = new Set(); stopFlash();
}

/* ================= 登录 / 启动 ================= */
async function start(user) {
  S.started = true; S.uid = user.id;
  if (!S.me) { const c = LS.get(ck(user.id)); if (c && c.me) hydrate(c); }
  showApp(); renderAll();                       // 有缓存就先显示（秒开）
  try {
    let b = await bootstrap();
    if (!b) { await ensureProfile(user); b = await bootstrap(); }
    if (!b || !b.me) throw new Error('无法读取账号档案');
    applyBoot(b); showBanner('');
  } catch (e) {
    logErr('boot', e);
    if (!S.me) { teardown(); showAuth('加载失败：' + (e.message || '请重试')); return; }
    showBanner(e.message && /setup\.sql/.test(e.message) ? e.message : '网络较慢，先显示缓存数据…');
  }
  S.started = true;
  startRealtime(); startTimers(); fbStart(); loadIceConfig(); heartbeat(true).then(() => announcePresence(true));   // 先报到再通知，免得对方查数据库时读到旧状态
  setTimeout(setupPresence, 1200);
}
async function onAuth(ev, session) {
  if (!session) { if (ev === 'INITIAL_SESSION' || ev === 'SIGNED_OUT') { teardown(); showAuth(); $('login-pass').value = ''; } return; }
  S.token = session.access_token;
  if (ev === 'TOKEN_REFRESHED') { try { sb.realtime.setAuth(session.access_token); } catch (e) {} return; }
  if (S.started && S.uid === session.user.id) return;
  await start(session.user);
}
const msgAuth = t => { $('auth-msg').textContent = t; };
let ready = null;
function initClient() {
  sb = window.supabase.createClient(API_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }, realtime: { params: { eventsPerSecond: 20 } } });
  sb.auth.onAuthStateChange((ev, session) => { setTimeout(() => { onAuth(ev, session).catch(e => logErr('auth', e)); }, 0); });
  return sb;
}

/* ================= 草稿 ================= */
let drafts = {}, draftUid = null, draftT = 0;
function draftsLoad() { if (draftUid !== S.uid) { drafts = LS.get('ch2dr:' + (S.uid || ''), {}) || {}; draftUid = S.uid; } }
function draftOf(conv) { draftsLoad(); return drafts[conv] || ''; }
function draftSave(conv, text) {
  if (!conv) return; draftsLoad();
  const v = (text || '').replace(/\u2063/g, '');
  if (v.trim()) drafts[conv] = v.slice(0, 5000); else delete drafts[conv];
  clearTimeout(draftT); draftT = setTimeout(() => LS.set('ch2dr:' + (S.uid || ''), drafts), 250);
}

/* ================= 通用弹窗 / 菜单 ================= */
let fsOk = null, actItems = [];
function openForm(title, fields, onOk, okText) {
  $('fs-title').textContent = title; $('fs-msg').textContent = '';
  $('fs-fields').innerHTML = fields.map((f, i) => '<input id="fsf' + i + '" type="' + (f.type || 'text') + '" placeholder="' + esc(f.ph || '') + '" value="' + esc(f.val || '') + '" maxlength="' + (f.max || 60) + '" autocomplete="' + esc(f.ac || 'off') + '" autocapitalize="none">').join('');
  $('fs-ok').textContent = okText || '确定'; $('fs-ok').disabled = false;
  fsOk = async () => {
    const vals = fields.map((f, i) => $('fsf' + i).value); $('fs-ok').disabled = true;
    try { const err = await onOk(vals); if (err) { $('fs-msg').textContent = err; $('fs-ok').disabled = false; return; } closeForm(); }
    catch (e) { logErr('form', e); $('fs-msg').textContent = '失败：' + ((e && e.message) || e); $('fs-ok').disabled = false; }
  };
  $('form-backdrop').classList.add('active'); $('form-sheet').classList.add('active');
  setTimeout(() => { const f = $('fsf0'); if (f) f.focus(); }, 60);
}
function closeForm() { $('form-backdrop').classList.remove('active'); $('form-sheet').classList.remove('active'); fsOk = null; }
function openActs(title, items) {
  actItems = items; $('as-title').textContent = title;
  $('as-items').innerHTML = items.map((it, i) => '<button type="button" class="menu-item' + (it.danger ? '' : ' plain') + '" data-i="' + i + '">' + esc(it.label) + '</button>').join('');
  $('act-backdrop').classList.add('active'); $('act-sheet').classList.add('active'); actOpenAt = now();
}
let actOpenAt = 0;
function closeActs() { $('act-backdrop').classList.remove('active'); $('act-sheet').classList.remove('active'); }

/* ================= 账号：头像 / 昵称 / 密码 ================= */
function notifyFriends() { if (!S.token) return; S.friends.forEach(a => bcast('u:' + a, 'fr', { from: ME() })); }
function editNick() {
  openForm('修改昵称', [{ ph: '新昵称（1-20 个字）', val: S.me.nickname, max: 20 }], async ([v]) => {
    v = (v || '').trim(); if (!v) return '昵称不能为空'; if (v.length > 20) return '最多 20 个字';
    if (v === S.me.nickname) return null;
    const { data, error } = await sb.from('profiles').update({ nickname: v }).eq('id', S.uid).select('id');
    if (error || !data || !data.length) return '保存失败：' + ((error && error.message) || '没有权限');
    S.me = Object.assign({}, S.me, { nickname: v }); S.profiles[ME()] = S.me;
    renderMe(); saveCache(); notifyFriends(); toast('昵称已修改'); return null;
  }, '保存');
}
function editPass() {
  openForm('修改密码', [
    { type: 'password', ph: '当前密码', max: 72, ac: 'current-password' },
    { type: 'password', ph: '新密码（至少 6 位）', max: 72, ac: 'new-password' },
    { type: 'password', ph: '再输入一次新密码', max: 72, ac: 'new-password' }
  ], async ([o, n, n2]) => {
    if (!o) return '请输入当前密码'; if ((n || '').length < 6) return '新密码至少 6 位'; if (n !== n2) return '两次输入的新密码不一致'; if (n === o) return '新密码不能和当前密码相同';
    const u = await sb.auth.getUser(); const email = u && u.data && u.data.user && u.data.user.email;
    if (!email) return '读取账号信息失败，请退出重新登录后再试';
    const v = await sb.auth.signInWithPassword({ email, password: o });
    if (v.error) return /rate|too many/i.test(v.error.message || '') ? '尝试次数太多，请稍后再试' : '当前密码不对';
    const r = await sb.auth.updateUser({ password: n });
    if (r.error) return '修改失败：' + r.error.message;
    toast('密码已修改'); return null;
  }, '修改');
}
async function squareJpeg(file, size) {
  let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
  const side = Math.min(bmp.width, bmp.height), out = Math.min(size, side);
  const cv = document.createElement('canvas'); cv.width = out; cv.height = out;
  cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out); if (bmp.close) bmp.close();
  return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
}
async function setAvatar(file) {
  if (!file || !/^image\//.test(file.type)) { toast('请选择图片'); return; }
  toast('正在上传头像…');
  let blob = null; try { blob = await squareJpeg(file, 400); } catch (e) { logErr('avatar', e); }
  if (!blob) { if (file.size > 5 * 1048576) { toast('这张图片无法处理，请换一张'); return; } blob = file; }
  const path = ME() + '/avatar_' + now() + '.jpg';
  const up = await sb.storage.from('chat-media').upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000' });
  if (up.error) throw up.error;
  const url = canon(sb.storage.from('chat-media').getPublicUrl(path).data.publicUrl);
  const { data, error } = await sb.from('profiles').update({ avatar_url: url }).eq('id', S.uid).select('id');
  if (error || !data || !data.length) throw error || new Error('保存失败');
  const old = S.me.avatar_url;
  S.me = Object.assign({}, S.me, { avatar_url: url }); S.profiles[ME()] = S.me; renderMe(); saveCache(); notifyFriends(); toast('头像已更新');
  try { const m = old && /\/chat-media\/([^?]+)/.exec(old); if (m) { const key = decodeURIComponent(m[1]); if (key.indexOf(ME() + '/avatar_') === 0) sb.storage.from('chat-media').remove([key]); } } catch (e) {}
}

/* ================= 清空聊天记录 / 搜索 ================= */
function clearConv(conv) {
  const c = convOf(conv); let t = c ? (Date.parse(c.last_ts || 0) || 0) : 0;
  if (S.conv === conv) S.msgs.forEach(m => { t = Math.max(t, Date.parse(m.created_at) || 0); });
  if (!t) t = now();
  setClr(conv, t);
  if (c) c.unread = 0;
  if (S.conv === conv) { S.hasMore = false; chatRender(true); }
  markReadSoon(conv); sched('list'); sched('title'); saveCache(); toast('已清空（仅在你这边，对方不受影响）');
}
function confirmClear(conv, isList) {
  openActs(isList ? '删除这个会话？聊天记录会在你这边清空，对方不受影响，对方再发消息时会重新出现。' : '清空这个聊天的全部记录？只在你这边清空，对方不受影响。', [{ label: isList ? '删除会话' : '清空聊天记录', danger: true, fn: () => clearConv(conv) }, { label: '取消', fn: null }]);
}
let csT = 0, csSeq = 0;
function openSearch() { $('chat-search').classList.add('active'); $('cs-input').value = ''; $('cs-list').innerHTML = '<div class="cs-empty">输入关键字，搜索这个聊天里的文字消息</div>'; setTimeout(() => $('cs-input').focus(), 60); }
function closeSearch() { $('chat-search').classList.remove('active'); $('cs-input').blur(); }
function hl(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return esc(text.slice(0, 80));
  const a = Math.max(0, i - 14), b = Math.min(text.length, i + q.length + 40);
  return (a > 0 ? '…' : '') + esc(text.slice(a, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, b)) + (b < text.length ? '…' : '');
}
async function runChatSearch(q) {
  q = (q || '').trim(); const seq = ++csSeq, conv = S.conv;
  if (!q) { $('cs-list').innerHTML = '<div class="cs-empty">输入关键字，搜索这个聊天里的文字消息</div>'; return; }
  $('cs-list').innerHTML = '<div class="cs-empty">搜索中…</div>';
  let rows = [];
  try {
    const pat = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const { data, error } = await sb.from('messages').select('id,conv_key,from_acc,to_acc,type,body,created_at').eq('conv_key', conv).eq('type', 'text').ilike('body', pat).order('created_at', { ascending: false }).limit(80);
    if (error) throw error; rows = (data || []).map(rowToMsg);
  } catch (e) { logErr('search-chat', e); rows = S.msgs.filter(m => m.type === 'text'); }
  if (seq !== csSeq || S.conv !== conv) return;
  const low = q.toLowerCase();
  const hit = rows.filter(m => !isHidden(m) && parseQ(m.body).text.toLowerCase().indexOf(low) >= 0).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50);
  $('cs-list').innerHTML = hit.length ? hit.map(m => '<div class="cs-item" data-id="' + esc(m.id) + '"><div class="cs-meta">' + esc(m.from_acc === ME() ? '我' : peerName(m.from_acc)) + ' · ' + esc(new Date(m.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })) + '</div><div class="cs-text">' + hl(parseQ(m.body).text, q) + '</div></div>').join('') : '<div class="cs-empty">没有找到相关消息</div>';
}
async function gotoMsg(id) {
  closeSearch();
  for (let i = 0; i < 40 && !msgElOf(id) && S.hasMore && S.conv; i++) { await loadOlder(); }
  if (msgElOf(id)) jumpTo(id); else toast('这条消息太久远，没能定位到');
}

/* ================= 存储空间（清理自己发送的图片/语音）================= */
let stFiles = null, stArm = null;
const fmtMB = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB';
const fileTs = f => { const t = Date.parse(f.created_at || f.updated_at || ''); if (t > 0) return t; const m = /^(\d{12,})_/.exec(f.name || ''); return m ? +m[1] : 0; };
function stCutoff(days) { return days ? now() - days * 86400000 : Infinity; }
function stPick(days) { const c = stCutoff(days); return (stFiles || []).filter(f => fileTs(f) < c); }
function stRenderInfo() {
  const all = stFiles || [], size = all.reduce((a, f) => a + ((f.metadata && f.metadata.size) || 0), 0);
  $('store-info').textContent = all.length ? '你发送的图片/语音共 ' + all.length + ' 个，占用约 ' + fmtMB(size) + '（免费额度 1 GB，是你们两个人共用的）。' : '你还没有发送过图片或语音。';
  [['st-30', 30], ['st-7', 7], ['st-all', 0]].forEach(([id, d]) => { const n = stPick(d).length; const b = $(id); b.disabled = !n; b.dataset.n = n; b.textContent = (d ? '清理 ' + d + ' 天前的' : '全部清理') + (n ? '（' + n + '）' : ''); });
}
async function loadStore() {
  $('store-box').style.display = 'block'; $('store-info').textContent = '统计中…'; stArm = null;
  try {
    const all = [];
    for (let off = 0; off < 10000; off += 100) {
      const { data, error } = await sb.storage.from('chat-media').list(ME(), { limit: 100, offset: off, sortBy: { column: 'created_at', order: 'asc' } });
      if (error) throw error;
      if (!data || !data.length) break;
      data.forEach(f => { if (f && f.name && f.id !== null && f.name.indexOf('avatar_') !== 0) all.push(f); });
      if (data.length < 100) break;
    }
    stFiles = all; stRenderInfo();
  } catch (e) { logErr('store', e); stFiles = null; $('store-info').textContent = '读取失败：' + (e && e.message || e) + '。如果提示没有权限，请先在 Supabase 运行 setup-v3.sql。'; ['st-30', 'st-7', 'st-all'].forEach(id => { $(id).disabled = true; }); }
}
async function stClean(days, btn) {
  const list = stPick(days); if (!list.length) return;
  if (stArm !== btn.id) { stArm = btn.id; btn.textContent = '再点一次确认删除 ' + list.length + ' 个（对方也将看不到这些图片/语音）'; setTimeout(() => { if (stArm === btn.id) { stArm = null; stRenderInfo(); } }, 5000); return; }
  stArm = null; ['st-30', 'st-7', 'st-all'].forEach(id => { $(id).disabled = true; });
  let done = 0, fail = 0;
  try {
    for (let i = 0; i < list.length; i += 50) {
      const part = list.slice(i, i + 50).map(f => ME() + '/' + f.name);
      const { data, error } = await sb.storage.from('chat-media').remove(part);
      if (error) { fail += part.length; logErr('store-rm', error); } else done += (data ? data.length : part.length);
      $('store-info').textContent = '清理中… ' + Math.min(i + 50, list.length) + ' / ' + list.length;
    }
  } catch (e) { logErr('store-rm', e); }
  toast(fail ? '已清理 ' + done + ' 个，' + fail + ' 个失败（可能没有权限，请运行 setup-v3.sql）' : '已清理 ' + done + ' 个文件');
  await loadStore();
}

/* ================= 中转测试：每家中转服务器单独测，看关掉 VPN 时能不能连上 ================= */
function turnLabel(u) {
  const m = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(\w+))?/i.exec(u) || [];
  const tls = /^turns$/i.test(m[1] || ''), port = m[3] || (tls ? '5349' : '3478');
  return (tls ? 'TLS' : (m[4] || 'udp').toUpperCase()) + ' ' + port;
}
function probeIce(server, policy, want, ms) {
  return new Promise(res => {
    let pc = null, done = false, tm = 0; const t0 = now();
    const fin = r => { if (done) return; done = true; clearTimeout(tm); try { if (pc) pc.close(); } catch (e) {} res(r); };
    try { pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: policy }); } catch (e) { fin({ ok: false }); return; }
    pc.onicecandidate = e => {
      if (!e.candidate) { fin({ ok: false }); return; }                  // 收集结束还没拿到 = 失败
      if ((e.candidate.candidate || '').indexOf(' typ ' + want) >= 0) fin({ ok: true, ms: now() - t0 });
    };
    tm = setTimeout(() => fin({ ok: false, timeout: true }), ms || 8000);
    try { pc.createDataChannel('probe'); pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => fin({ ok: false })); } catch (e) { fin({ ok: false }); }
  });
}
let relayTesting = false;
async function runRelayTest() {
  if (relayTesting) return;
  if (typeof RTCPeerConnection === 'undefined') { $('relay-res').textContent = '当前浏览器不支持 WebRTC，无法测试'; return; }
  relayTesting = true; $('btn-relaytest').disabled = true;
  const rows = STUN_SERVER.urls.map(u => ({ k: 'stun', title: 'STUN · ' + u.replace(/^stun:/, ''), server: { urls: u }, policy: 'all', want: 'srflx' }));
  turns().forEach(p => p.urls.forEach(u => rows.push({ k: p.name, title: p.name + ' · ' + turnLabel(u), server: { urls: u, username: p.username, credential: p.credential }, policy: 'relay', want: 'relay' })));
  const st = rows.map(() => '⏳ 测试中…');
  const paint = (summary) => {
    $('relay-res').textContent = rows.map((r, i) => r.title + '：' + st[i]).join('\n') + (summary ? '\n\n' + summary : '');
  };
  paint('');
  const res = await Promise.all(rows.map((r, i) => probeIce(r.server, r.policy, r.want, 8000).then(x => {
    st[i] = x.ok ? '✅ ' + (r.k === 'stun' ? '能拿到公网地址' : '可用') + '（' + (x.ms / 1000).toFixed(1) + ' 秒）' : '❌ ' + (x.timeout ? '连不上（超时）' : '连不上');
    paint(''); return x.ok;
  })));
  const okNames = []; turns().forEach(p => { if (rows.some((r, i) => r.k === p.name && res[i])) okNames.push(p.name); });
  const stunOk = rows.some((r, i) => r.k === 'stun' && res[i]);
  const sum = (stunOk ? '能拿到公网地址：两台手机有机会直连（直连不花中转额度）；能不能真打通要两台手机实际通话才知道。' : 'STUN 都拿不到公网地址，通话多半要走中转。') + '\n' +
    (okNames.length ? '能连上的中转：' + okNames.join('、') + (okNames[0] !== turns()[0].name ? '（排第一的 ' + turns()[0].name + ' 连不上，会自动用后面能用的）' : '') : '所有中转都连不上：直连失败时通话会接不通。') +
    '\n说明：拿到中转地址只代表服务器连得上、账号正确。关掉 VPN 再测，结果才代表国内网络。';
  paint(sum);
  relayTesting = false; $('btn-relaytest').disabled = false;
}

/* ================= 图片查看器 / 引用跳转 ================= */
let lbList = [], lbIdx = 0;
function lbShow() {
  const it = lbList[lbIdx]; if (!it) return;
  $('lightbox-img').src = it.url; $('lb-count').textContent = lbList.length > 1 ? (lbIdx + 1) + ' / ' + lbList.length : '';
  $('lb-prev').style.display = lbIdx > 0 ? '' : 'none'; $('lb-next').style.display = lbIdx < lbList.length - 1 ? '' : 'none';
}
function openLightbox(id) {
  lbList = S.msgs.filter(m => m.type === 'image' && !isHidden(m) && m.body).map(m => ({ id: m.id, url: disp(m.body) }));
  lbIdx = Math.max(0, lbList.findIndex(x => x.id === id));
  if (!lbList.length) return;
  lbShow(); $('lightbox').classList.add('active');
}
function closeLightbox() { $('lightbox').classList.remove('active'); $('lightbox-img').src = ''; }
function lbMove(d) { const n = lbIdx + d; if (n < 0 || n >= lbList.length) return; lbIdx = n; lbShow(); }
function bindLightbox() {
  const lb = $('lightbox'); let x0 = 0, y0 = 0, swiped = false;
  lb.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; swiped = false; }, { passive: true });
  lb.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; lbMove(dx < 0 ? 1 : -1); }
  }, { passive: true });
  lb.addEventListener('click', e => { if (swiped) { swiped = false; return; } if (e.target.closest('#lb-prev')) { lbMove(-1); return; } if (e.target.closest('#lb-next')) { lbMove(1); return; } closeLightbox(); });
  document.addEventListener('keydown', e => { if (!lb.classList.contains('active')) return; if (e.key === 'ArrowLeft') lbMove(-1); else if (e.key === 'ArrowRight') lbMove(1); else if (e.key === 'Escape') closeLightbox(); });
}
function jumpTo(id) {
  const el = msgElOf(id);
  if (!el) { toast('原消息不在当前页面里'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
}

/* ================= 事件绑定 ================= */
function bindViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const apply = () => {
    const root = document.documentElement;
    if (window.matchMedia('(min-width: 768px)').matches) { root.style.removeProperty('--vvh'); root.style.removeProperty('--vvt'); document.body.classList.remove('kb'); return; }
    root.style.setProperty('--vvh', vv.height + 'px'); root.style.setProperty('--vvt', vv.offsetTop + 'px');
    const kb = window.innerHeight - vv.height > 120; document.body.classList.toggle('kb', kb);
    if (kb && S.conv && S.stick) { const b = $('chat-messages'); b.scrollTop = b.scrollHeight; }
  };
  vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); apply();
}
function bindUI() {
  /* 登录 / 注册 */
  $('tab-login').onclick = () => { $('tab-login').classList.add('active'); $('tab-register').classList.remove('active'); $('login-form').style.display = ''; $('register-form').style.display = 'none'; msgAuth(''); };
  $('tab-register').onclick = () => { $('tab-register').classList.add('active'); $('tab-login').classList.remove('active'); $('login-form').style.display = 'none'; $('register-form').style.display = ''; msgAuth(''); };
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'), acc = $('login-acc').value.trim().toLowerCase(), pass = $('login-pass').value;
    if (!acc || !pass) return;
    btn.disabled = true; msgAuth('登录中…');
    try {
      await ready;
      let { error } = await sb.auth.signInWithPassword({ email: acc + '@chatter.local', password: pass });
      if (error) { const r2 = await sb.auth.signInWithPassword({ email: acc + '@gmail.com', password: pass }); error = r2.error; }
      msgAuth(error ? '❌ 账号或密码错误' : '');
    } catch (err) { msgAuth('❌ 登录失败：' + (err.message || '网络异常')); } finally { btn.disabled = false; }
  });
  $('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'), acc = $('reg-acc').value.trim().toLowerCase(), pass = $('reg-pass').value, name = $('reg-name').value.trim();
    if (!/^[a-z0-9_-]{3,20}$/.test(acc)) { msgAuth('❌ 账号只能用英文/数字/_/-，3-20 位'); return; }
    if (pass.length < 6) { msgAuth('❌ 密码至少 6 位'); return; }
    if (!name) { msgAuth('❌ 请输入昵称'); return; }
    btn.disabled = true; msgAuth('注册中…');
    try {
      await ready;
      const ex = await sb.rpc('account_exists', { p_acc: acc });
      if (ex.error) { msgAuth('❌ 检查账号失败：' + ex.error.message + '（请先执行 setup.sql）'); return; }
      if (ex.data) { msgAuth('❌ 账号已存在'); return; }
      const { data: up, error } = await sb.auth.signUp({ email: acc + '@chatter.local', password: pass, options: { data: { account_id: acc, nickname: name } } });
      if (error) { msgAuth('❌ ' + error.message); return; }
      if (!up || !up.user) { msgAuth('❌ 注册失败'); return; }
      msgAuth(up.session ? '' : '⚠️ 请到邮箱确认后再登录（或在 Supabase 关闭邮箱确认）');
    } catch (err) { msgAuth('❌ 注册失败：' + (err.message || '网络异常')); } finally { btn.disabled = false; }
  });

  /* 顶部导航 */
  document.querySelectorAll('.app-nav button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.app-nav button').forEach(b => b.classList.remove('active')); btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      $('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'me') renderEnv();
    };
  });
  setInterval(() => { try { if (!document.hidden && $('tab-me').classList.contains('active')) renderEnv(); } catch (e) {} }, 1500);   // 诊断页自动刷新：实时通道连上后会自己变绿
  let lpT = 0, lpFired = 0;
  const cl = $('conv-list');
  cl.addEventListener('click', e => { if (now() - lpFired < 700) return; const it = e.target.closest('.conv-item'); if (it) openConv(it.dataset.key, it.dataset.peer); });
  const lpOpen = it => { lpFired = now(); try { if (navigator.vibrate) navigator.vibrate(30); } catch (x) {} confirmClear(it.dataset.key, true); };
  cl.addEventListener('contextmenu', e => { const it = e.target.closest('.conv-item'); if (!it) return; e.preventDefault(); lpOpen(it); });
  cl.addEventListener('touchstart', e => { const it = e.target.closest('.conv-item'); if (!it) return; clearTimeout(lpT); lpT = setTimeout(() => lpOpen(it), 600); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev => cl.addEventListener(ev, () => clearTimeout(lpT), { passive: true }));
  $('friend-list').addEventListener('click', e => {
    const it = e.target.closest('.friend-item'); if (!it) return; const acc = it.dataset.acc;
    if (e.target.closest('.act-chat')) openConv(convKeyOf(ME(), acc), acc); else if (e.target.closest('.act-remove')) removeFriend(acc);
  });
  $('request-list').addEventListener('click', e => {
    const it = e.target.closest('.req-item'); if (!it) return;
    if (e.target.closest('.act-accept')) acceptRequest(it.dataset.id); else if (e.target.closest('.act-decline')) declineRequest(it.dataset.id);
  });
  $('search-results').addEventListener('click', e => {
    const c = e.target.closest('.act-chat'), a = e.target.closest('.act-add');
    if (c) openConv(convKeyOf(ME(), c.dataset.acc), c.dataset.acc); else if (a) addFriend(a);
  });
  const si = $('search-input');
  si.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => runSearch(si.value).catch(e => logErr('search', e)), 280); });
  si.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchT); runSearch(si.value).catch(x => logErr('search', x)); } });
  $('search-btn').onclick = () => { clearTimeout(searchT); runSearch(si.value).catch(x => logErr('search', x)); };

  /* 聊天窗口 */
  $('chat-back').onclick = () => { if (S.hist) { try { history.back(); return; } catch (e) {} } closeChat(); };
  window.addEventListener('popstate', () => { if (S.call) { try { history.pushState({ chat: 1 }, ''); } catch (e) {} return; } if (S.conv) { S.hist = false; closeChat(); } });
  const box = $('chat-messages');
  box.addEventListener('scroll', () => { S.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80; if (box.scrollTop < 60) loadOlder(); }, { passive: true });
  box.addEventListener('error', e => {
    const im = e.target; if (!im || im.tagName !== 'IMG' || !im.closest || !im.closest('.bubble.img')) return;
    const u = im.getAttribute('src') || ''; if (/^blob:/.test(u)) return;
    const holder = im.parentNode; if (!holder) return;
    holder.innerHTML = '<div class="imgfail" data-src="' + esc(u.replace(/[?&]r=\d+$/, '')) + '">图片无法显示<small>可能已被清理，点一下重试</small></div>';
  }, true);
  box.addEventListener('load', e => { if (e.target && e.target.tagName === 'IMG' && S.stick) box.scrollTop = box.scrollHeight; }, true);
  box.addEventListener('click', e => {
    const retry = e.target.closest('.st.failed'); if (retry) { retryMsg(retry.closest('.msg').dataset.id); return; }
    const v = e.target.closest('.bubble.voice'); if (v) { togglePlay(v.closest('.msg').dataset.id, v.dataset.url); return; }
    const q = e.target.closest('.quote'); if (q) { jumpTo(q.dataset.qid); return; }
    const bad = e.target.closest('.imgfail'); if (bad) { const u = bad.dataset.src || ''; const holder = bad.parentNode; holder.innerHTML = '<img src="' + esc(u + (u.indexOf('?') < 0 ? '?' : '&') + 'r=' + now()) + '" alt="" decoding="async">'; return; }
    const im = e.target.closest('.bubble.img img'); if (im) openLightbox(im.closest('.msg').dataset.id);
  });
  let pressT = 0;
  const mineBubble = e => e.target.closest && e.target.closest('.msg .bubble');
  box.addEventListener('contextmenu', e => { const b = mineBubble(e); if (!b) return; e.preventDefault(); showMsgMenu(b.closest('.msg').dataset.id); });
  box.addEventListener('touchstart', e => { const b = mineBubble(e); if (!b) return; clearTimeout(pressT); pressT = setTimeout(() => { showMsgMenu(b.closest('.msg').dataset.id); try { if (navigator.vibrate) navigator.vibrate(40); } catch (x) {} }, 550); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev => box.addEventListener(ev, () => clearTimeout(pressT), { passive: true }));
  bindLightbox();
  const paintRS = () => { $('btn-relaysave').textContent = relaySave() ? '📶 中转省流量：开' : '📶 中转省流量：关'; };
  paintRS();
  $('btn-relaysave').onclick = () => {
    LS.set('ch2relaysave2', !relaySave()); paintRS();
    toast(relaySave() ? '已开启：通话走中转时降低码率省流量（直连时不受影响）' : '已关闭：走中转时保持你选的画质');
    if (S.call && S.call.connected) applyCallParams(S.call);
  };
  $('btn-relaytest').onclick = () => { $('relay-box').style.display = 'block'; runRelayTest(); };
  $('btn-nick').onclick = editNick; $('btn-pass').onclick = editPass;
  $('btn-avatar').onclick = () => $('avatar-input').click();
  $('avatar-input').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; setAvatar(f).catch(x => { logErr('avatar', x); toast('头像上传失败：' + ((x && x.message) || '请重试')); }); };
  $('fs-ok').onclick = () => { if (fsOk) fsOk(); }; $('fs-cancel').onclick = closeForm; $('form-backdrop').onclick = closeForm;
  $('form-sheet').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && fsOk && !$('fs-ok').disabled) { e.preventDefault(); fsOk(); } });
  $('as-items').onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; const it = actItems[+b.dataset.i]; closeActs(); if (it && it.fn) it.fn(); };
  $('act-backdrop').onclick = () => { if (now() - actOpenAt > 350) closeActs(); };
  $('btn-more').onclick = () => { if (!S.conv) return; const key = S.conv; openActs('聊天选项', [{ label: '搜索聊天记录', fn: openSearch }, { label: '清空聊天记录', danger: true, fn: () => setTimeout(() => confirmClear(key, false), 50) }, { label: '取消', fn: null }]); };
  $('cs-close').onclick = closeSearch;
  $('cs-input').addEventListener('input', () => { clearTimeout(csT); csT = setTimeout(() => runChatSearch($('cs-input').value), 300); });
  $('cs-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); clearTimeout(csT); runChatSearch($('cs-input').value); } });
  $('cs-list').addEventListener('click', e => { const it = e.target.closest('.cs-item'); if (it) gotoMsg(it.dataset.id); });
  $('btn-store').onclick = () => { if ($('store-box').style.display === 'block') { $('store-box').style.display = 'none'; return; } loadStore(); };
  [['st-30', 30], ['st-7', 7], ['st-all', 0]].forEach(([id, d]) => { $(id).onclick = () => stClean(d, $(id)); });
  $('msg-menu-backdrop').onclick = () => { if (now() - menuOpenAt > 350) closeMenu(); };
  $('msg-menu-recall').onclick = doRecall;
  $('msg-menu-reply').onclick = () => menuAction('reply'); $('msg-menu-copy').onclick = () => menuAction('copy'); $('msg-menu-del').onclick = () => menuAction('del');
  $('reply-x').onclick = clearReply;

  /* 输入栏 */
  const input = $('chat-input'), sendBtn = $('btn-send');
  sendBtn.addEventListener('mousedown', e => e.preventDefault());                   // 点发送不收起键盘
  sendBtn.addEventListener('touchstart', e => { e.preventDefault(); }, { passive: false });
  sendBtn.addEventListener('touchend', e => { e.preventDefault(); sendText(); }, { passive: false });
  sendBtn.addEventListener('click', e => { e.preventDefault(); sendText(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendText(); } });
  input.addEventListener('focus', () => $('emoji-panel').classList.remove('active'));
  input.addEventListener('input', () => { if (input.value) sendTyping(); draftSave(S.conv, input.value); });
  let audioMode = false;
  $('btn-audio-toggle').onclick = () => {
    audioMode = !audioMode; input.style.display = audioMode ? 'none' : 'block'; $('btn-audio').style.display = audioMode ? 'block' : 'none';
    $('btn-audio-toggle').classList.toggle('audio-mode', audioMode);
  };
  $('btn-emoji').onclick = () => $('emoji-panel').classList.toggle('active');
  document.querySelectorAll('#emoji-panel span').forEach(s => { s.onclick = () => { input.value += s.textContent; draftSave(S.conv, input.value); }; });
  $('btn-img').onclick = () => $('file-input').click();
  $('file-input').onchange = e => { const fs = Array.from(e.target.files || []); e.target.value = ''; sendImages(fs).catch(x => { logErr('img', x); toast('图片发送失败'); }); };

  /* 按住说话 */
  const ab = $('btn-audio'); let down = false;
  const gy = e => (e.touches && e.touches[0]) ? e.touches[0].clientY : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : e.clientY;
  const onMove = e => { if (!down) return; if (e.cancelable) e.preventDefault(); recMove(gy(e)); };
  const onUp = e => { if (!down) return; down = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); if (e.cancelable) e.preventDefault(); recEnd(e.type === 'touchcancel'); };
  const onDown = e => { e.preventDefault(); if (down) return; down = true; if (!e.touches) { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); } recStart(gy(e)); };
  ab.addEventListener('touchstart', onDown, { passive: false }); ab.addEventListener('touchmove', onMove, { passive: false });
  ab.addEventListener('touchend', onUp, { passive: false }); ab.addEventListener('touchcancel', onUp, { passive: false });
  ab.addEventListener('mousedown', onDown); ab.addEventListener('contextmenu', e => e.preventDefault());

  /* 通话 */
  $('btn-voice-call').onclick = () => startCall(false);
  $('btn-video-call').onclick = () => startCall(true);
  $('btn-hangup').onclick = e => { e.stopPropagation(); endCall('', true); };
  $('btn-answer').onclick = () => acceptCall();
  $('btn-decline').onclick = () => declineCall();
  $('btn-mute').onclick = e => { e.stopPropagation(); const c = S.call; if (!c || !c.local) return; c.muted = !c.muted; c.local.getAudioTracks().forEach(t => { t.enabled = !c.muted; }); $('btn-mute').classList.toggle('off', c.muted); };
  $('btn-flip').onclick = e => { e.stopPropagation(); flipCam(S.call); };
  $('btn-q').onclick = e => { e.stopPropagation(); const c = S.call; if (!c) return; if (saving(c)) { toast('现在走中转服务器，已限制为省流量画质；可在“我 → 中转省流量”关闭'); return; } const order = ['hd', 'hd1080', 'sd']; setQuality(c, order[(order.indexOf(c.q) + 1) % 3]); toast('画质：' + QUAL[c.q].name + '（对方看到的画面）'); };
  $('btn-info').onclick = e => { e.stopPropagation(); const el = $('call-stats'); el.classList.toggle('show'); if (el.classList.contains('show') && S.call) renderStats(S.call); };
  $('local-video').onclick = () => { const u = $('call-ui'); if (!u.classList.contains('swap')) u.classList.add('swap'); };
  $('remote-video').onclick = () => { const u = $('call-ui'); if (u.classList.contains('swap')) u.classList.remove('swap'); };
  $('btn-cam').onclick = e => { e.stopPropagation(); const c = S.call; if (!c || !c.local) return; c.camOff = !c.camOff; c.local.getVideoTracks().forEach(t => { t.enabled = !c.camOff; }); $('btn-cam').classList.toggle('off', c.camOff); };
  $('call-ui').onclick = () => { $('call-tip').style.display = 'none'; playEl($('remote-audio')); if (S.call && S.call.video) playEl($('remote-video')); };

  /* 我 */
  const sndBtn = $('btn-sound'), paintSnd = () => { sndBtn.textContent = SFX.isOn() ? '🔔 音效：开' : '🔕 音效：关'; };
  paintSnd(); sndBtn.onclick = () => { SFX.setOn(!SFX.isOn()); paintSnd(); };
  $('btn-copylog').onclick = () => { const t = $('diag').textContent + '\n\n' + LOG.join('\n'); try { navigator.clipboard.writeText(t).then(() => toast('已复制'), () => toast('复制失败')); } catch (e) { toast('复制失败'); } };
  $('btn-logout').onclick = async () => {
    teardown();
    try { Object.keys(localStorage).forEach(k => { if (k.indexOf('ch2') === 0) localStorage.removeItem(k); }); } catch (e) {}
    try { if (sb) await sb.auth.signOut(); } catch (e) {}
    location.reload();
  };

  /* 页面回到前台：立刻校对 */
  const wake = () => {
    if (document.hidden || !sb || !S.me) return;
    if (!S.rt.db || !S.rt.user) startRealtime();
    if (!S.presCh || S.presCh.state !== 'joined') setupPresence(); else { try { S.presCh.track({ t: now() }); } catch (e) {} }
    resyncSoon(); retryFailed();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) { recAbort(); if (!S.call && S.me) { restRpc('heartbeat', { p_online: false }); announcePresence(false, true); } } else { heartbeat(true).then(() => announcePresence(true)); lastSigPoll = 0; lastMsgPoll = 0; fbKick(); stopFlash(); wake(); if (S.call) wakeOn(); if (S.conv) { markReadSoon(S.conv); sendReadAck(S.conv, true); } } });
  window.addEventListener('pagehide', () => { if (S.me && !S.call) { restRpc('heartbeat', { p_online: false }); announcePresence(false, true); } });
  window.addEventListener('online', wake); window.addEventListener('focus', wake);
}

/* ================= 启动 ================= */
function boot() {
  ready = (window.__lib || Promise.reject(new Error('依赖库加载失败'))).then(initClient);
  ready.then(() => { if (/^⏳/.test($('auth-msg').textContent)) msgAuth(''); }, () => {});
  ready.catch(e => {
    logErr('lib', e);
    var why = (window.__libErr || []).join('；'); if (!S.me) { showAuth(); msgAuth('❌ 依赖库加载失败，请检查网络后刷新页面' + (why ? '（' + why.slice(0, 300) + '）' : '')); } else showBanner('依赖库未加载，当前为离线缓存');
  });
  bindUI(); bindViewport(); setupManifest();
  try {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'))
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  } catch (e) {}
  const uid = peekUid();
  if (uid) {
    const c = LS.get(ck(uid));
    if (c && c.me) { S.uid = uid; hydrate(c); }
    showApp(); renderAll();            // 已登录过：直接进主界面，不闪登录页
  } else { showAuth(); msgAuth('⏳ 正在加载依赖库…（首次约需几秒到几十秒）'); }
}
if (window.__TEST__) window.__T = { togglePlay, S, openConv, sendText, onFastMsg, onSig, startCall, acceptCall, endCall, recStart, recEnd, recMove, encodeWav, msgHTML, closeChat, onIncoming, upsertMsg, bcast, deliver, runSearch, addLocal, newMsg, getSb: () => sb, getReady: () => ready, LOG };
boot();
})();
