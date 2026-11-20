// 备份服务器函数的检查：自己生成一对钥匙冒充 GitHub，签发各种身份证明，确认只有“私有仓库主分支上的每日备份任务”能拿到数据库连接。
// 用法：cd tests && deno run -A --node-modules-dir=none fn-backup-test.ts
Deno.env.set('CHATTER_TEST', '1');
Deno.env.set('SUPABASE_DB_URL', 'postgresql://postgres:p%40ss%2Fword@db.uaoiqbxptnbrvkzjwguc.supabase.co:5432/postgres');
// deno-lint-ignore no-explicit-any
type Any = any;
let n = 0, bad = 0;
const ok = (c: boolean, m: string) => { n++; if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + m); };
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey) as Any;
let jwksCalls = 0;
globalThis.fetch = ((u: string) => {
  if (String(u) === 'https://token.actions.githubusercontent.com/.well-known/jwks') { jwksCalls++; return Promise.resolve(new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'k1', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }] }))); }
  return Promise.reject(new Error('不该访问 ' + u));
}) as Any;
const { handle, poolerUrl } = await import('../supabase/functions/chatter-backup/index.ts');
const enc = (o: Any) => btoa(typeof o === 'string' ? o : JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = Math.floor(Date.now() / 1000);
const good = { iss: 'https://token.actions.githubusercontent.com', aud: 'chatter-backup', exp: now + 300, iat: now - 5, nbf: now - 5, repository: '3855285335-GIF/chatter-keepalive', repository_owner_id: '347707398', ref: 'refs/heads/main', workflow_ref: '3855285335-GIF/chatter-keepalive/.github/workflows/backup.yml@refs/heads/main', event_name: 'schedule', runner_environment: 'github-hosted' };
async function sign(claims: Any, head: Any = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key: CryptoKey = kp.privateKey) {
  const data = enc(head) + '.' + enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data)));
  return data + '.' + btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const call = async (tok: string | null, method = 'POST') => { const r = await handle(new Request('https://x/functions/v1/chatter-backup', { method, headers: tok ? { authorization: 'Bearer ' + tok } : {} })); return { st: r.status, j: await r.json() }; };

let r = await call(await sign(good));
ok(r.st === 200 && r.j.url === 'postgresql://postgres.uaoiqbxptnbrvkzjwguc:p%40ss%2Fword@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres', '私有仓库主分支上的每日备份任务（定时触发）：拿到会话池地址，密码原样保留编码');
r = await call(await sign({ ...good, event_name: 'workflow_dispatch' }));
ok(r.st === 200, '手动点“运行”也可以');
ok(poolerUrl('postgresql://postgres@db.x.supabase.co:5432/postgres') === '', '连接里没有密码：不给');
const deny: [string, Any, Any?, CryptoKey?][] = [
  ['别的仓库', { ...good, repository: 'someone/chatter-keepalive' }],
  ['同名仓库但主人编号不对（账号被抢注）', { ...good, repository_owner_id: '1' }],
  ['别的分支', { ...good, ref: 'refs/heads/evil' }],
  ['同一仓库的别的任务文件', { ...good, workflow_ref: '3855285335-GIF/chatter-keepalive/.github/workflows/keepalive.yml@refs/heads/main' }],
  ['别的分支上的备份任务', { ...good, workflow_ref: '3855285335-GIF/chatter-keepalive/.github/workflows/backup.yml@refs/heads/evil' }],
  ['拉取请求触发', { ...good, event_name: 'pull_request' }],
  ['自己搭的运行机', { ...good, runner_environment: 'self-hosted' }],
  ['给别的服务签的（aud 不对）', { ...good, aud: 'sts.amazonaws.com' }],
  ['不是 GitHub 签的（iss 不对）', { ...good, iss: 'https://evil.example' }],
  ['已经过期', { ...good, exp: now - 10 }],
  ['签发时间太早（重放旧证明）', { ...good, iat: now - 7200 }],
  ['签发时间在未来', { ...good, iat: now + 3600 }],
  ['用别的私钥签的（假冒签名）', good, undefined, other.privateKey],
  ['声称不用签名（alg none）', good, { alg: 'none', kid: 'k1' }],
  ['不认识的钥匙编号', good, { alg: 'RS256', kid: 'k9' }]
];
for (const [name, claims, head, key] of deny) {
  r = await call(await sign(claims, head, key));
  ok(r.st >= 400 && !r.j.url, '拒绝：' + name + ' → ' + r.st + ' ' + (r.j.why || r.j.code));
}
const t = await sign(good), [h, p] = t.split('.');
r = await call(h + '.' + enc({ ...good, repository: 'someone/x' }) + '.' + t.split('.')[2]);
ok(r.st === 403 && !r.j.url, '拒绝：改了内容但沿用原签名');
r = await call(h + '.' + p);
ok(r.st >= 400 && !r.j.url, '拒绝：缺签名');
r = await call(null);
ok(r.st === 401 && !r.j.url, '拒绝：没带身份证明');
r = await call(await sign(good), 'GET');
ok(r.st === 405, '只接受 POST');
ok(jwksCalls <= 3, 'GitHub 的公钥会缓存（不每次都去取）：取了 ' + jwksCalls + ' 次');
console.log(bad ? '\n有 ' + bad + ' 项没通过' : '\n全部通过（' + n + ' 项）');
if (bad) Deno.exit(1);
