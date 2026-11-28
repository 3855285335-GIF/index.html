// node --test tests/background-notification.cjs  仓库的隔离登录、消息库和推送替身。
const assert = require('node:assert/strict');
const test = require('node:test');
const { makeEnv, sleep, iso, prof, ME } = require('./harness');
const key = 'bob::me';
function fixture(options = {}) {
  return makeEnv({ db: {
    profiles: [prof(ME), prof('bob')],
    friendships: [{ owner_acc: ME, friend_acc: 'bob' }],
    conversations: [{ owner_acc: ME, peer_acc: 'bob', conv_key: key, unread: 0, last_ts: iso(Date.now() - 1000) }],
    messages: []
  }, ...options });
}
function visibility(env, hidden, dispatch = true) {
  const d = env.w.document;
  Object.defineProperty(d, 'hidden', { configurable: true, value: hidden });
  Object.defineProperty(d, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
  if (dispatch) d.dispatchEvent(new env.w.Event('visibilitychange'));
}
function receive(env) {
  const row = { id: '00000000-0000-4000-8000-000000000931', conv_key: key, from_acc: 'bob', to_acc: ME, body: '隔离收信', type: 'text', created_at: iso(Date.now()) };
  env.db.messages.push(row);
  env.db.conversations[0].unread = 1;
  env.rtFire('INSERT', 'messages', row);
}
const reads = env => env.rpcLog.filter(r => r.name === 'mark_read').length;
test('锁屏时当前会话仍保持未读，前台恢复正常结算', async () => {
  const env = fixture();
  try {
    await env.login();
    await env.T.openConv(key, 'bob');
    await sleep(550);
    const prior = reads(env);
    visibility(env, true);
    receive(env);
    await sleep(520);
    assert.equal(reads(env), prior);
    assert.equal(env.db.conversations[0].unread, 1);
    assert.equal(env.T.S.convs.find(c => c.convKey === key).unread, 1);
    visibility(env, false);
    await sleep(750);
    assert.ok(reads(env) > prior);
    assert.equal(env.db.conversations[0].unread, 0);
  } finally { env.close(); }
});
test('打开聊天后立即锁屏，原有延迟已读任务不能清掉锁屏时收到的消息', async () => {
  const env = fixture();
  try {
    await env.login();
    await env.T.openConv(key, 'bob');
    const prior = reads(env);
    visibility(env, true);
    receive(env);
    await sleep(550);
    assert.equal(reads(env), prior);
    assert.equal(env.db.conversations[0].unread, 1);
  } finally { env.close(); }
});
test('已读 RPC 延迟失败时不能在后台写入旧会话的回退更新', async () => {
  let rejectRead;
  const env = fixture({onRpc(name) {
    if (name === 'mark_read') return new Promise(resolve => { rejectRead = () => resolve({ error: { code: 'PGRST202' } }); });
  }});
  try {
    await env.login();
    await env.T.openConv(key, 'bob');
    for (let i = 0; !rejectRead && i < 40; i++) await sleep(25);
    assert.ok(rejectRead, '测试应先进入已读 RPC');
    visibility(env, true);
    receive(env);
    rejectRead();
    await sleep(380);
    assert.equal(env.db.conversations[0].unread, 1);
    const resets = env.log.filter(q => q.op === 'update' && q.table === 'conversations' && q.values?.unread === 0);
    assert.equal(resets.length, 0);
  } finally { env.close(); }
});
test('推送短暂断网后按同一消息编号重试，服务器确定已读即停止', async () => {
  const calls = [];
  const env = fixture({ before(window) {
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).includes('chatter-push') && options && JSON.parse(options.body).op === 'push') {
        calls.push({ body: JSON.parse(options.body), keepalive: options.keepalive });
        if (calls.length === 1) throw new TypeError('isolated offline');
        return { ok: true, json: async () => ({skip: 'read'}) };
      }
      return originalFetch(url, options);
    };
  }});
  try {
    await env.login(); env.T.PUSH.retryMs = [40, 60];
    const m = { id: 'fixture-ref', type: 'text', conv: key, to_acc: 'bob', from_acc: ME, created_at: iso(Date.now()) };
    env.T.firePushRetry('msg', 'bob', m.id, m);
    await sleep(360);
    assert.deepEqual(calls.map(x=>x.body.ref), [m.id, m.id]);
    assert.ok(calls.every(x=>x.keepalive === true));
  } finally { env.close(); }
});
