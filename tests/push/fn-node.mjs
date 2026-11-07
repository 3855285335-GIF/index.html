// 推送函数测试（Node）：用 web-push 官方用的加密库 http_ece 解密我们加密的内容，验证 RFC 8291 实现正确；
// 用 Node 自带 crypto 验证 VAPID 签名；用假的 Supabase / 推送服务把整个请求流程走一遍。
// 用法：node tests/push/fn-node.mjs
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import os from 'os'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ece = require('http_ece'), webpush = require('web-push'), nc = require('crypto');
const SRC = path.join(HERE, '../../supabase/functions/chatter-push/index.ts');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pushfn-')), 'fn.mjs');
fs.copyFileSync(SRC, tmp);
const M = await import(tmp);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ✅ ' + m); } else { fail++; console.log('FAIL ❌ ' + m); } };
const b64u = b => Buffer.from(b).toString('base64url');

function mkUA() { const e = nc.createECDH('prime256v1'); e.generateKeys(); const a = nc.randomBytes(16); return { ecdh: e, p256dh: b64u(e.getPublicKey()), auth: b64u(a) }; }
const dec = (ua, body) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua.ecdh, authSecret: ua.auth }).toString('utf8');

console.log('=== 1) 加密：http_ece（web-push 用的同一个库）能解开，内容一字不差');
{
  const ua = mkUA();
  const msg = JSON.stringify({ title: '老婆', body: '晚上一起吃饭吗？🍜 ' + 'x'.repeat(300) });
  const body = await M.encryptPayload(ua.p256dh, ua.auth, new TextEncoder().encode(msg));
  ok(dec(ua, body) === msg, '解密结果和原文相同（' + body.length + ' 字节）');
  const b2 = await M.encryptPayload(ua.p256dh, ua.auth, new TextEncoder().encode(msg));
  ok(Buffer.compare(Buffer.from(body), Buffer.from(b2)) !== 0, '同一条内容两次加密结果不同（每次随机）');
  const other = mkUA(); let threw = false; try { dec(other, body); } catch (e) { threw = true; }
  ok(threw, '别的手机的密钥解不开');
  let bad = false; try { await M.encryptPayload('abc', ua.auth, new Uint8Array(1)); } catch (e) { bad = true; }
  ok(bad, '手机公钥格式不对时直接报错，不会乱发');
}

console.log('=== 2) 签名密钥：格式能被 web-push 接受；VAPID 签名能验证通过');
{
  const k = await M.makeVapidKeys();
  ok(Buffer.from(k.pub, 'base64url').length === 65 && Buffer.from(k.priv, 'base64url').length === 32, '公钥 65 字节、私钥 32 字节');
  let wpOk = true; try { webpush.setVapidDetails(M.b64uEnc ? 'https://3855285335-gif.github.io/index.html/' : '', k.pub, k.priv); } catch (e) { wpOk = false; console.log(e.message); }
  ok(wpOk, 'web-push 认可这对密钥');
  const h = await M.vapidAuth('https://web.push.apple.com/QGuR3x/abc', k);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  ok(!!m && m[4] === k.pub, '请求头格式：vapid t=…, k=公钥');
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  ok(claims.aud === 'https://web.push.apple.com' && /^https:\/\//.test(claims.sub) && claims.exp > Date.now() / 1000 + 11 * 3600 && claims.exp < Date.now() / 1000 + 24 * 3600, 'aud 是推送服务的域名，sub 是网址，有效期 12 小时（苹果要求不超过 24 小时）');
  const pub = Buffer.from(k.pub, 'base64url');
  const key = nc.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  const v = nc.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  ok(v, 'ES256 签名验证通过');
  const v2 = nc.verify('sha256', Buffer.from(m[1] + '.' + m[2] + 'x'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  ok(!v2, '改动内容后签名验证失败');
}

console.log('=== 3) 整个流程（假的 Supabase 和推送服务）');
function mkWorld(opts) {
  opts = opts || {};
  const W = { calls: [], stored: null, pushes: [], gone: null, job: null };
  const uaOk = mkUA(), uaGone = mkUA(), uaHide = mkUA(), uaEvil = mkUA();
  W.ua = { ok: uaOk, gone: uaGone, hide: uaHide };
  W.job = opts.job || {
    subs: [
      { endpoint: 'https://fcm.googleapis.com/fcm/send/ok1', p256dh: uaOk.p256dh, auth: uaOk.auth, preview: true },
      { endpoint: 'https://web.push.apple.com/gone1', p256dh: uaGone.p256dh, auth: uaGone.auth, preview: true },
      { endpoint: 'https://evil.example.com/steal', p256dh: uaEvil.p256dh, auth: uaEvil.auth, preview: true },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/hide1', p256dh: uaHide.p256dh, auth: uaHide.auth, preview: false }
    ],
    title: '老婆', body: '[2条] 晚上一起吃饭吗？', hidden: '发来 2 条新消息', tag: 'm:alice', url: './#c=alice', ttl: 86400, kind: 'msg', from: 'alice', badge: 3
  };
  W.fx = async (url, init) => {
    init = init || {}; const h = init.headers || {};
    W.calls.push({ url, init });
    const J = (o, s) => new Response(o === undefined ? '' : JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://proj.supabase.co/auth/v1/user')) return h.Authorization === 'Bearer aaa.bbb.ccc' ? J({ id: 'uid-alice' }) : J({ msg: 'bad jwt' }, 401);
    if (url.startsWith('https://proj.supabase.co/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1], a = JSON.parse(init.body || '{}');
      if (opts.rpcFail === fn) return J({ message: 'boom' }, 500);
      if (fn === 'push_vapid') return J(W.stored);
      if (fn === 'push_set_vapid') { if (!W.stored) W.stored = { pub: a.p_pub, priv: a.p_priv }; return J(W.stored); }
      if (fn === 'push_job') { W.jobArgs = a; return J(W.job); }
      if (fn === 'push_gone') { W.gone = a.p_endpoints; return J(undefined, 204); }
    }
    if (/googleapis|apple|evil/.test(url)) {
      const ua = url.endsWith('ok1') ? uaOk : url.endsWith('gone1') ? uaGone : url.endsWith('hide1') ? uaHide : uaEvil;
      W.pushes.push({ url, headers: h, text: dec(ua, init.body) });
      return new Response('', { status: url.endsWith('gone1') ? 410 : 201 });
    }
    return J({ error: 'unexpected ' + url }, 599);
  };
  return W;
}
const envNew = k => ({ SUPABASE_URL: 'https://proj.supabase.co/', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_abc"}', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_xyz"}' })[k];
const req = (body, auth, method) => new Request('https://proj.supabase.co/functions/v1/chatter-push', { method: method || 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: 'Bearer ' + auth } : {}), body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body) });
{
  const W = mkWorld(), H = M.makeHandler(envNew, W.fx);
  const pre = await H(new Request('https://x/f', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version' } }));
  ok(pre.status === 200 && pre.headers.get('access-control-allow-origin') === '*' && /x-supabase-api-version/.test(pre.headers.get('access-control-allow-headers')), '浏览器预检（OPTIONS）放行，并回应它要的全部请求头');
  ok((await H(req(null, null, 'GET'))).status === 405, 'GET 请求被拒绝');
  const r1 = await H(req({ op: 'key' }, 'aaa.bbb.ccc')); const j1 = await r1.json();
  ok(r1.status === 200 && j1.pub && j1.pub === W.stored.pub, '第一次拿公钥：自动生成并存进数据库');
  ok(r1.headers.get('access-control-allow-origin') === '*', '正常回应也带跨域头');
  const n1 = W.calls.length; const j1b = await (await H(req({ op: 'key' }))).json();
  ok(j1b.pub === j1.pub && W.calls.length === n1, '第二次拿公钥：用缓存，不再查数据库');
  const rpcCall = W.calls.find(c => c.url.includes('/rpc/push_vapid'));
  ok(rpcCall.init.headers.apikey === 'sb_secret_abc' && !rpcCall.init.headers.Authorization, '新版密钥只放在 apikey 头里（放进 Authorization 会被 Supabase 拒绝）');
  ok(!rpcCall.url.includes('//rest'), '项目地址末尾的 / 不会造成双斜杠');

  const r401 = await H(req({ op: 'push', kind: 'msg', ref: 'm1', to: 'bob' }));
  ok(r401.status === 401, '没登录不能请求推送');
  const r401b = await H(req({ op: 'push', kind: 'msg', ref: 'm1', to: 'bob' }, 'xxx.yyy.zzz'));
  ok(r401b.status === 401, '登录凭证无效不能请求推送');

  const r2 = await H(req({ op: 'push', kind: 'msg', ref: 'm1', to: 'bob' }, 'aaa.bbb.ccc')); const j2 = await r2.json();
  ok(W.jobArgs && W.jobArgs.p_uid === 'uid-alice' && W.jobArgs.p_kind === 'msg' && W.jobArgs.p_ref === 'm1' && W.jobArgs.p_to === 'bob', '发信人以登录凭证为准（uid-alice），不是网页自己说的');
  ok(j2.ok && j2.sent === 2 && j2.gone === 1, '推给 2 台正常的手机；失效的 1 台记下来（' + JSON.stringify(j2.codes) + '）');
  ok(!W.pushes.some(p => p.url.includes('evil')), '不是正规推送服务的地址：不发');
  ok(JSON.stringify(W.gone) === JSON.stringify(['https://web.push.apple.com/gone1']), '失效地址交给数据库删除');
  const pOk = W.pushes.find(p => p.url.endsWith('ok1')), pHide = W.pushes.find(p => p.url.endsWith('hide1'));
  const m1 = JSON.parse(pOk.text), m2 = JSON.parse(pHide.text);
  ok(m1.title === '老婆' && m1.body === '[2条] 晚上一起吃饭吗？' && m1.url === './#c=alice' && m1.tag === 'm:alice' && m1.badge === 3, '手机收到的内容：标题、正文、跳转、角标都对');
  ok(m2.body === '发来 2 条新消息', '设了“不显示内容”的手机只收到“发来 2 条新消息”');
  const hh = pOk.headers;
  ok(hh['Content-Encoding'] === 'aes128gcm' && hh.TTL === '86400' && hh.Urgency === 'high' && /^vapid t=/.test(hh.Authorization), '推送请求头：aes128gcm、TTL、Urgency、VAPID');
  ok(/^[A-Za-z0-9_-]{32}$/.test(hh.Topic), 'Topic 是 32 个合法字符（规范上限）');
  const aud1 = JSON.parse(Buffer.from(hh.Authorization.split('.')[1], 'base64url').toString()).aud;
  const aud2 = JSON.parse(Buffer.from(W.pushes.find(p => p.url.includes('apple')).headers.Authorization.split('.')[1], 'base64url').toString()).aud;
  ok(aud1 === 'https://fcm.googleapis.com' && aud2 === 'https://web.push.apple.com', '每个推送服务用各自域名签名');
}
{
  const W = mkWorld({ job: { skip: 'online' } }), H = M.makeHandler(envNew, W.fx);
  const j = await (await H(req({ op: 'push', kind: 'msg', ref: 'm1', to: 'bob' }, 'aaa.bbb.ccc'))).json();
  ok(j.ok && j.skip === 'online' && W.pushes.length === 0 && !W.calls.some(c => c.url.includes('push_vapid')), '数据库说对方在线：什么都不发');
}
{
  const W = mkWorld({ rpcFail: 'push_job' }), H = M.makeHandler(envNew, W.fx);
  const r = await H(req({ op: 'push', kind: 'msg', ref: 'm1', to: 'bob' }, 'aaa.bbb.ccc')); const j = await r.json();
  ok(r.status === 500 && /push_job 500/.test(j.error), '数据库出错：返回 500 和原因，不会崩');
}
{
  const legacy = k => ({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGc.eyJyb2xl.sig', SUPABASE_ANON_KEY: 'eyJ.anon.sig' })[k];
  const W = mkWorld(), H = M.makeHandler(legacy, W.fx);
  await H(req({ op: 'key' }));
  const c = W.calls.find(x => x.url.includes('/rpc/'));
  ok(c.init.headers.apikey === 'eyJhbGc.eyJyb2xl.sig' && c.init.headers.Authorization === 'Bearer eyJhbGc.eyJyb2xl.sig', '只有旧版密钥时也能用（旧版密钥同时放进 Authorization）');
  const none = M.makeHandler(() => undefined, W.fx);
  ok((await none(req({ op: 'key' }))).status === 500, '环境变量缺失：返回 500');
}
{
  const W = mkWorld(), H = M.makeHandler(envNew, W.fx);
  const r = await H(new Request('https://x/f', { method: 'POST', body: 'not json' }));
  ok(r.status === 400, '乱发的内容：返回 400');
  const big = await H(req({ op: 'push', kind: 'msg', ref: 'r'.repeat(5000), to: 't'.repeat(5000) }, 'aaa.bbb.ccc'));
  ok(big.status === 200 && W.jobArgs.p_ref.length === 100 && W.jobArgs.p_to.length === 100, '超长参数被截断，不会把大段内容传给数据库');
}
console.log('\n推送函数（Node）：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
