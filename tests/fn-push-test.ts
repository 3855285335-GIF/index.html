import assert from 'node:assert/strict';

Deno.env.set('CHATTER_PUSH_TEST', '1');
const { makeHandler } = await import('../supabase/functions/chatter-push/index.ts');
const url = 'https://project.test';
const token = 'synthetic.valid.token';
const actor = '11111111-1111-4111-8111-111111111111';
const configuration: Record<string, string> = {
  SUPABASE_URL: url,
  SUPABASE_ANON_KEY: 'public-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server.test.key',
};
let alive = true;
const jobs: unknown[] = [];
const handle = makeHandler((key: string) => configuration[key], (input: string, init: RequestInit) => {
  const headers = new Headers(init.headers);
  const path = new URL(input).pathname;
  if (path === '/auth/v1/user' || path === '/rest/v1/rpc/session_alive') {
    assert.equal(headers.get('apikey'), configuration.SUPABASE_ANON_KEY);
    if (headers.get('authorization') !== 'Bearer ' + token) return Promise.resolve(new Response(null, { status: 403 }));
    return Promise.resolve(Response.json(path === '/auth/v1/user' ? { id: actor } : alive));
  }
  if (path === '/rest/v1/rpc/push_job') {
    assert.equal(headers.get('apikey'), configuration.SUPABASE_SERVICE_ROLE_KEY);
    jobs.push(JSON.parse(String(init.body)));
    return Promise.resolve(Response.json({ skip: 'friend' }));
  }
  throw new Error('Unexpected test request: ' + path);
});
const push = (authorization?: string) => handle(new Request(url, {
  method: 'POST',
  headers: authorization ? { authorization } : {},
  body: JSON.stringify({ op: 'push', kind: 'msg', uid: 'ignored', to: 'friend', ref: 'msg' }),
}));

assert.equal((await push()).status, 401);
assert.equal((await push('Bearer bad.test.token')).status, 401);
alive = false;
assert.equal((await push('Bearer ' + token)).status, 401);
assert.equal(jobs.length, 0);
alive = true;
assert.equal((await (await push('Bearer ' + token)).json()).skip, 'friend');
assert.deepEqual(jobs, [{ p_uid: actor, p_kind: 'msg', p_ref: 'msg', p_to: 'friend' }]);
console.log('✅ 无凭证、伪造凭证和撤销会话被拒绝；推送身份由服务器验证，数据库拒绝向非好友推送');
