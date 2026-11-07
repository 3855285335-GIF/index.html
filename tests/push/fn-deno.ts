// @ts-nocheck
// 推送函数测试（Deno，和 Supabase Edge Functions 同一类运行环境）：
// 1) 原样运行函数文件（Deno.serve），配一个假的 Supabase，走一遍浏览器预检、拿公钥、未登录被拒
// 2) 在 Deno 里加密，再用测试自己写的解密（WebCrypto）解开，确认 Deno 的加密接口行为和 Node 一致
// 用法：tests/push/node_modules/.bin/deno run --allow-net --allow-env --allow-run --allow-read tests/push/fn-deno.ts
const SRC = new URL('../../supabase/functions/chatter-push/index.ts', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ✅ ' + m); } else { fail++; console.log('FAIL ❌ ' + m); } };

let stored = null, rpcHeaders = null;
const mock = Deno.serve({ port: 54331, hostname: '127.0.0.1', onListen() {} }, async req => {
  const u = new URL(req.url);
  if (u.pathname.startsWith('/rest/v1/rpc/')) rpcHeaders = Object.fromEntries(req.headers);
  if (u.pathname === '/rest/v1/rpc/push_vapid') return Response.json(stored);
  if (u.pathname === '/rest/v1/rpc/push_set_vapid') { const a = await req.json(); if (!stored) stored = { pub: a.p_pub, priv: a.p_priv }; return Response.json(stored); }
  if (u.pathname === '/auth/v1/user') return new Response('{"msg":"bad"}', { status: 401 });
  return new Response('no', { status: 404 });
});

console.log('=== 1) 原样运行函数文件');
const child = new Deno.Command(Deno.execPath(), {
  args: ['run', '--allow-net', '--allow-env', SRC],
  env: { SUPABASE_URL: 'http://127.0.0.1:54331', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_t"}', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_t"}' },
  stdout: 'null', stderr: 'piped'
}).spawn();
const F = 'http://127.0.0.1:8000/';
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { await (await fetch(F, { method: 'OPTIONS' })).text(); up = true; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
ok(up, '函数启动成功（Deno ' + Deno.version.deno + '）');
const pre = await fetch(F, { method: 'OPTIONS', headers: { Origin: 'https://3855285335-gif.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-client-info, apikey, content-type' } });
await pre.text();
ok(pre.status === 200 && pre.headers.get('access-control-allow-origin') === '*' && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), '浏览器预检放行');
const k = await fetch(F, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'key' }) });
const kj = await k.json();
ok(k.status === 200 && kj.pub && kj.pub.length === 87 && stored && stored.pub === kj.pub, '拿公钥：自动生成 65 字节公钥并存进数据库');
ok(rpcHeaders && rpcHeaders.apikey === 'sb_secret_t' && !rpcHeaders.authorization, '读数据库用自动提供的 SUPABASE_SECRET_KEYS（只放 apikey 头）');
const p = await fetch(F, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer a.b.c' }, body: JSON.stringify({ op: 'push', kind: 'msg', ref: 'x', to: 'bob' }) });
await p.text();
ok(p.status === 401, '登录凭证无效：拒绝推送');
child.kill('SIGTERM');
const err = new TextDecoder().decode((await child.output()).stderr);
ok(!/error|uncaught/i.test(err.replace(/Listening on.*\n?/g, '')), '运行中没有报错' + (err.trim() ? '（输出：' + err.trim().slice(0, 120) + '）' : ''));

console.log('=== 2) Deno 里的加密，用独立写的解密解开');
Deno.env.set('CHATTER_PUSH_TEST', '1');
const M = await import(SRC + '?t=' + Date.now());
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
const text = JSON.stringify({ title: '测试', body: '📞 邀请你语音通话' });
const body = await M.encryptPayload(M.b64uEnc(uaPub), M.b64uEnc(auth), new TextEncoder().encode(text));
// 独立解密（RFC 8291 第 3.4 节 + RFC 8188）
const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
ok(rs === 4096 && idlen === 65, '头部：记录大小 4096，带 65 字节发送方公钥');
const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256);
const H = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
const te = new TextEncoder(), j = (...a) => { const o = new Uint8Array(a.reduce((x, y) => x + y.length, 0)); let q = 0; a.forEach(y => { o.set(y, q); q += y.length; }); return o; };
const ikm = await H(auth, new Uint8Array(shared), j(te.encode('WebPush: info\0'), uaPub, asPub), 32);
const cek = await H(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await H(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
ok(pt[pt.length - 1] === 2 && new TextDecoder().decode(pt.slice(0, -1)) === text, '解开后内容一致，结尾是最后一段的标记 0x02');
const h = await M.vapidAuth('https://fcm.googleapis.com/fcm/send/x', stored);
const [hd, cl, sg] = h.slice(8, h.indexOf(',')).split('.');
const pubKey = await crypto.subtle.importKey('raw', M.b64uDec(stored.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, M.b64uDec(sg), te.encode(hd + '.' + cl)), '数据库里存的密钥签出来的 VAPID 能验证通过');

await mock.shutdown();
console.log('\n推送函数（Deno）：' + pass + ' 项通过，' + fail + ' 项失败');
Deno.exit(fail ? 1 : 0);
