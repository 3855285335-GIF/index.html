// @ts-nocheck -- 全部用纯 JavaScript 写法（不加类型标注），这样同一份代码也能在测试里直接运行
// Chatter 推送函数（Supabase Edge Function，函数名：chatter-push）
// 整段粘贴到 Supabase 后台的函数编辑器里，点 Deploy；部署后在函数“设置”里关掉“Verify JWT with legacy secret”（函数自己核对登录凭证）。不需要设置任何密钥：
//   - 推送签名密钥第一次运行时自动生成，存在数据库 push_keys 表里（网页和任何人都读不到）
//   - 访问数据库用的是 Supabase 自动提供给函数的 SUPABASE_URL / SUPABASE_SECRET_KEYS
// 网页只能让它做两件事：拿推送公钥（op: key）；请求给某个好友推一条通知（op: push）。
// 推给谁、推什么内容，全部由数据库里的 push_job() 检查后决定（必须是好友、对方不在线、消息真的刚发出）。
// 不依赖任何第三方库：加密（RFC 8291）和签名（RFC 8292）都用浏览器 / Deno 自带的 WebCrypto。

const SUBJECT = 'https://3855285335-gif.github.io/index.html/';
// 只往正规的推送服务发（苹果、谷歌、火狐、微软）
const ALLOW = /^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)(:443)?\//i;

const te = new TextEncoder();
export function b64uEnc(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDec(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function cat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const Z = new Uint8Array([0]);

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

// RFC 8291（aes128gcm）：只有这台手机能解开内容，推送服务商（苹果 / 谷歌）看不到
export async function encryptPayload(p256dh, authSecret, plain) {
  const ua = b64uDec(p256dh), auth = b64uDec(authSecret);
  if (ua.length !== 65 || auth.length < 16) throw new Error('bad subscription keys');
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(te.encode('WebPush: info'), Z, ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, cat(te.encode('Content-Encoding: aes128gcm'), Z), 16);
  const nonce = await hkdf(salt, ikm, cat(te.encode('Content-Encoding: nonce'), Z), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]);   // 记录大小 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export async function makeVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { pub: b64uEnc(pub), priv: jwk.d };
}

// RFC 8292（VAPID）：证明这条推送确实来自 Chatter
export async function vapidAuth(endpoint, keys, nowSec) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(nowSec || Date.now() / 1000) + 12 * 3600;
  const h = b64uEnc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64uEnc(te.encode(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const pub = b64uDec(keys.pub);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEnc(pub.slice(1, 33)), y: b64uEnc(pub.slice(33, 65)), d: keys.priv, ext: true };
  const k = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, te.encode(h + '.' + c)));
  return 'vapid t=' + h + '.' + c + '.' + b64uEnc(sig) + ', k=' + keys.pub;
}

async function topicOf(tag) {   // 同一个 Topic 的推送，手机没联网时只保留最新一条（最多 32 个字符）
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('chatter:' + tag)));
  return b64uEnc(d.slice(0, 24));
}

function cors(req) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

export function makeHandler(env, fx) {
  fx = fx || fetch;
  let keys = null;
  const jwtCache = new Map();
  const pick = (name, legacy) => {
    try { const j = JSON.parse(env(name) || '{}'); if (j && j.default) return j.default; const v = j && Object.values(j)[0]; if (v) return v; } catch { /* 不是 JSON：改用旧版变量 */ }
    return env(legacy) || '';
  };
  const base = () => String(env('SUPABASE_URL') || '').replace(/\/+$/, '');
  const secretKey = () => pick('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  const publicKey = () => pick('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const adminHeaders = () => {
    const k = secretKey(), h = { apikey: k, 'Content-Type': 'application/json' };
    if (k.split('.').length === 3) h.Authorization = 'Bearer ' + k;   // 旧版 service_role 密钥本身是 JWT
    return h;
  };
  async function rpc(fn, args) {
    const r = await fx(base() + '/rest/v1/rpc/' + fn, { method: 'POST', headers: adminHeaders(), body: JSON.stringify(args || {}) });
    const t = await r.text();
    if (!r.ok) throw new Error(fn + ' ' + r.status + ' ' + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  }
  async function getKeys() {
    if (keys) return keys;
    let k = await rpc('push_vapid', {});
    if (!k || !k.pub || !k.priv) { const g = await makeVapidKeys(); k = await rpc('push_set_vapid', { p_pub: g.pub, p_priv: g.priv }); }
    if (!k || !k.pub || !k.priv) throw new Error('no vapid keys');
    keys = k; return k;
  }
  async function userId(req) {
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!tok || tok.split('.').length !== 3) return null;
    const r = await fx(base() + '/auth/v1/user', { headers: { apikey: publicKey() || secretKey(), Authorization: 'Bearer ' + tok } });
    if (!r.ok) { await r.text().catch(() => {}); return null; }
    const u = await r.json().catch(() => null);
    return (u && u.id) || null;
  }
  async function authFor(endpoint, k) {
    const aud = new URL(endpoint).origin, c = jwtCache.get(aud), t = Date.now();
    if (c && c.until > t) return c.v;
    const v = await vapidAuth(endpoint, k);
    jwtCache.set(aud, { v, until: t + 6 * 3600 * 1000 });
    return v;
  }
  async function sendOne(s, job, k) {
    if (!ALLOW.test(s.endpoint)) return 0;
    const msg = { title: job.title, body: s.preview === false ? job.hidden : job.body, tag: job.tag, url: job.url, kind: job.kind, from: job.from, badge: job.badge, ts: Date.now() };
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const body = await encryptPayload(s.p256dh, s.auth, te.encode(JSON.stringify(msg)));
      const r = await fx(s.endpoint, {
        method: 'POST', signal: ctl.signal, body,
        headers: { Authorization: await authFor(s.endpoint, k), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(job.ttl || 86400), Urgency: 'high', Topic: await topicOf(job.tag || 'chatter') }
      });
      await r.arrayBuffer().catch(() => {});
      return r.status;
    } catch { return -1; } finally { clearTimeout(tm); }
  }
  return async function handle(req) {
    const H = Object.assign({ 'Content-Type': 'application/json' }, cors(req));
    const out = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: H });
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
    if (req.method !== 'POST') return out({ error: 'POST only' }, 405);
    try {
      if (!base() || !secretKey()) return out({ error: 'no-env' }, 500);
      const body = await req.json().catch(() => ({})) || {};
      if (body.op === 'key') { const k = await getKeys(); return out({ pub: k.pub, v: 1 }); }
      if (body.op !== 'push') return out({ error: 'op' }, 400);
      const uid = await userId(req);
      if (!uid) return out({ error: 'auth' }, 401);
      const s = v => (v == null || v === '' ? null : String(v).slice(0, 100));
      const job = await rpc('push_job', { p_uid: uid, p_kind: String(body.kind || ''), p_ref: s(body.ref), p_to: s(body.to) });
      if (!job || job.skip || !Array.isArray(job.subs)) return out({ ok: true, skip: (job && job.skip) || 'none' });
      const k = await getKeys();
      const codes = await Promise.all(job.subs.map(x => sendOne(x, job, k)));
      const gone = job.subs.filter((_x, i) => codes[i] === 404 || codes[i] === 410).map(x => x.endpoint);
      if (gone.length) await rpc('push_gone', { p_endpoints: gone }).catch(() => {});
      return out({ ok: true, sent: codes.filter(c => c >= 200 && c < 300).length, codes, gone: gone.length });
    } catch (e) {
      return out({ error: String((e && e.message) || e).slice(0, 300) }, 500);
    }
  };
}

if (typeof Deno !== 'undefined' && Deno.serve && !Deno.env.get('CHATTER_PUSH_TEST')) Deno.serve(makeHandler(k => Deno.env.get(k)));
