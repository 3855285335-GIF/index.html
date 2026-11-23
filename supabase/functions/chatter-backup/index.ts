// Chatter 每日备份用的服务器函数（名字 chatter-backup）。
// 只把数据库连接交给一个人：私有仓库 3855285335-GIF/chatter-keepalive 主分支上的“每日备份”任务（.github/workflows/backup.yml）。
// 怎么认人：GitHub 给每次任务运行签发一张身份证明（OIDC 令牌，GitHub 用自己的私钥签名，几分钟后过期），这里用 GitHub 公开的公钥核对签名，
// 再核对是哪个仓库（连仓库主人的数字编号一起核对）、哪个分支、哪个任务文件、怎么触发的。任何一项对不上就拒绝。
// 这样不用把数据库密码存进 GitHub，也不用任何人手抄密码；连接来自 Supabase 自带给服务器函数的 SUPABASE_DB_URL。
// GitHub 的电脑只有 IPv4，免费版直连地址是 IPv6，所以交出去的是“会话池”地址（同一个密码）。
const ISS = 'https://token.actions.githubusercontent.com';
const AUD = 'chatter-backup';
const REPO = '3855285335-GIF/chatter-keepalive';
const OWNER_ID = '347707398';   // 仓库主人的 GitHub 数字编号：账号改名、别人抢注同名账号都冒充不了
const WORKFLOW = REPO + '/.github/workflows/backup.yml@refs/heads/main';
const EVENTS = ['schedule', 'workflow_dispatch'];
const PROJECT = 'uaoiqbxptnbrvkzjwguc';
const POOLER = 'aws-0-ap-northeast-1.pooler.supabase.com:5432';
const env = (k: string) => (Deno.env.get(k) || '').trim();
// deno-lint-ignore no-explicit-any
type Any = any;
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const out = (o: Any, st = 200) => new Response(JSON.stringify(o), { status: st, headers: H });
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const jsonPart = (s: string) => JSON.parse(new TextDecoder().decode(b64u(s)));

let JWKS: Any = null, JWKS_AT = 0;
async function keyFor(kid: string) {
  for (let round = 0; round < 2; round++) {
    if (!JWKS || Date.now() - JWKS_AT > 3600000 || round === 1) {   // 公钥一小时换一次缓存；找不到这把钥匙就重新取一次（GitHub 会轮换）
      const r = await fetch(ISS + '/.well-known/jwks', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('jwks ' + r.status);
      JWKS = await r.json(); JWKS_AT = Date.now();
    }
    const k = ((JWKS && JWKS.keys) || []).find((x: Any) => x && x.kid === kid && x.kty === 'RSA');
    if (k) return await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  return null;
}
export async function verify(tok: string): Promise<string> {   // 通过返回 ''，不通过返回原因
  const parts = tok.split('.');
  if (parts.length !== 3) return 'format';
  let head: Any, body: Any;
  try { head = jsonPart(parts[0]); body = jsonPart(parts[1]); } catch { return 'format'; }
  if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string') return 'alg';
  const key = await keyFor(head.kid);
  if (!key) return 'kid';
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return 'sig';
  const now = Math.floor(Date.now() / 1000);
  if (body.iss !== ISS) return 'iss';
  if (!(body.aud === AUD || (Array.isArray(body.aud) && body.aud.includes(AUD)))) return 'aud';
  if (typeof body.exp !== 'number' || body.exp < now) return 'exp';
  if (typeof body.iat !== 'number' || body.iat > now + 60 || now - body.iat > 1800) return 'iat';
  if (typeof body.nbf === 'number' && body.nbf > now + 60) return 'nbf';
  if (body.repository !== REPO || String(body.repository_owner_id) !== OWNER_ID) return 'repo';
  if (body.ref !== 'refs/heads/main') return 'ref';
  if (body.workflow_ref !== WORKFLOW) return 'workflow';
  if (!EVENTS.includes(body.event_name)) return 'event';
  if (body.runner_environment && body.runner_environment !== 'github-hosted') return 'runner';
  return '';
}
export function poolerUrl(dbUrl: string): string {   // 用 Supabase 给的连接里的密码，拼成会话池地址
  const u = new URL(dbUrl);
  if (!u.password) return '';
  return 'postgresql://postgres.' + PROJECT + ':' + u.password + '@' + POOLER + '/postgres';
}
export async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return out({ ok: false, code: 'method' }, 405);
  const m = /^Bearer\s+([A-Za-z0-9_\-.]+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return out({ ok: false, code: 'auth' }, 401);
  let why = '';
  try { why = await verify(m[1]); } catch { return out({ ok: false, code: 'jwks' }, 503); }
  if (why) { console.warn('chatter-backup rejected', why); return out({ ok: false, code: 'denied', why }, 403); }
  // The OIDC-verified private backup workflow may request short-lived links,
  // but NEVER receives the long-lived Storage service key. Only this private
  // bucket is eligible, and the signed URLs expire after 15 minutes.
  let input: Any = {};
  try {
    const raw = await req.text();
    if (raw.length > 32768) return out({ ok: false, code: 'body-size' }, 413);
    if (raw.trim()) input = JSON.parse(raw);
  } catch { return out({ ok: false, code: 'body' }, 400); }
  if (input && input.op === 'sign-private') {
    if (input.bucket !== 'chatter-private' || !Array.isArray(input.paths) ||
        input.paths.length < 1 || input.paths.length > 50 ||
        input.paths.some((p: Any) => typeof p !== 'string' || !p || p.length > 512 ||
          p.startsWith('/') || p.includes('\\') || p.includes('%') || p.includes(String.fromCharCode(0)) || p.split('/').some((part: string) => !part || part === '.' || part === '..')) ||
        new Set(input.paths).size !== input.paths.length) {
      return out({ ok: false, code: 'paths' }, 400);
    }
    const secret = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!secret) return out({ ok: false, code: 'storage-config' }, 503);
    const base = 'https://' + PROJECT + '.supabase.co';
    let signed: Any;
    try {
      const response = await fetch(base + '/storage/v1/object/sign/chatter-private', {
        method: 'POST',
        headers: { apikey: secret, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: input.paths, expiresIn: 900 }),
      });
      if (!response.ok) return out({ ok: false, code: 'storage-sign' }, 502);
      signed = await response.json();
    } catch { return out({ ok: false, code: 'storage-sign' }, 502); }
    if (!Array.isArray(signed) || signed.length !== input.paths.length) {
      return out({ ok: false, code: 'storage-result' }, 502);
    }
    const items = [];
    for (let i = 0; i < signed.length; i++) {
      const item = signed[i], relative = item?.signedURL || item?.signedUrl;
      if (item?.error || item?.path !== input.paths[i] || typeof relative !== 'string') {
        return out({ ok: false, code: 'storage-result' }, 502);
      }
      const target = relative.startsWith('/object/sign/')
        ? base + '/storage/v1' + relative
        : relative.startsWith('/storage/v1/object/sign/') ? base + relative : '';
      if (!target) return out({ ok: false, code: 'storage-result' }, 502);
      const parsed = new URL(target);
      if (parsed.origin !== base ||
          !parsed.pathname.startsWith('/storage/v1/object/sign/chatter-private/') ||
          decodeURIComponent(parsed.pathname.slice('/storage/v1/object/sign/chatter-private/'.length)) !== input.paths[i] ||
          !parsed.searchParams.has('token') || parsed.hash || parsed.username || parsed.password) return out({ ok: false, code: 'storage-result' }, 502);
      items.push({ path: input.paths[i], signedUrl: target });
    }
    return out({ ok: true, expiresIn: 900, items });
  }
  if (input && input.op && input.op !== 'database') return out({ ok: false, code: 'operation' }, 400);
  const url = poolerUrl(env('SUPABASE_DB_URL'));
  if (!url) return out({ ok: false, code: 'nodb' }, 500);
  return out({ ok: true, url });
}
if (!env('CHATTER_TEST')) Deno.serve(handle);
