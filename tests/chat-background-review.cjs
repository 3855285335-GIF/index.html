const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, prof, iso, sleep } = require('./harness');

const key = 'bob::me';
function data() {
  const profiles = [prof('me'), prof('bob')];
  return {
    profiles, friendships: [{ owner_acc: 'me', friend_acc: 'bob' }, { owner_acc: 'bob', friend_acc: 'me' }],
    messages: [],
    conversations: profiles.map(({ account_id }) => ({
      owner_acc: account_id, peer_acc: account_id === 'me' ? 'bob' : 'me',
      conv_key: key, last_body: 'earlier', last_ts: iso(Date.now() - 30000), unread: 0
    }))
  };
}

async function device(db, owner, delivered) {
  const peer = owner === 'me' ? 'bob' : 'me';
  const selfRow = db.conversations.find(c => c.owner_acc === owner);
  const peerRow = db.conversations.find(c => c.owner_acc === peer);
  const me = db.profiles.find(p => p.account_id === owner);
  const env = makeEnv({
    db,
    onRpc(name) {
      if (name === 'bootstrap') return { data: { me, friends: db.profiles.filter(p => p !== me),
        convs: [selfRow], requests: [], peers: [] }, error: null };
      if (name === 'mark_read') {
        selfRow.unread = 0;
        selfRow.last_read_ts = iso(Date.now());
        return { data: null, error: null };
      }
      if (name === 'peer_read') return { data: peerRow.last_read_ts || null, error: null };
    },
    before(w) {
      const fallback = w.fetch;
      w.fetch = async (url, options) => {
        if (String(url).endsWith('/chatter-push')) {
          const req = JSON.parse(options.body);
          if (req.op === 'push') delivered.push({ owner, to: req.to, ref: req.ref });
          return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) };
        }
        return fallback(url, options);
      };
    }
  });
  await env.T.getReady();
  await env.T.onAuth('SIGNED_IN', { user: { id: me.id }, access_token: 'test' });
  assert.equal(env.T.S.me.account_id, owner);
  return env;
}

function visibility(env, hidden) {
  Object.defineProperties(env.w.document, {
    hidden: { configurable: true, value: hidden },
    visibilityState: { configurable: true, value: hidden ? 'hidden' : 'visible' }
  });
  env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
}

test('刚读过的收件人退到后台后，新消息送出推送请求，回到前台才产生已读', async () => {
  const db = data(), endpoint = [];
  const receiver = await device(db, 'me', endpoint);
  let sender;
  try {
    await receiver.T.openConv(key, 'bob');
    await sleep(400);
    const row = db.conversations.find(r => r.owner_acc === 'me');
    assert.ok(row.last_read_ts);
    visibility(receiver, true);
    sender = await device(db, 'bob', endpoint);
    await sender.T.openConv(key, 'me');
    await sleep(400);
    sender.$('chat-input').value = '隔离环境通知验证';
    sender.$('btn-send').click();
    for (let i = 0; i < 40 && !db.messages.length; i++) await sleep(25);
    assert.equal(db.messages.length, 1);
    const msg = db.messages[0];
    assert.equal(msg.to_acc, 'me');
    row.unread = 1;
    row.last_body = msg.body; row.last_ts = msg.created_at;
    const before = receiver.rpcLog.filter(x => x.name === 'mark_read').length;
    receiver.rtFire('INSERT', 'messages', msg);
    receiver.rtFire('UPDATE', 'conversations', row);
    await sleep(550);
    assert.deepEqual(endpoint, [{ owner: 'bob', to: 'me', ref: msg.id }]);
    assert.equal(receiver.rpcLog.filter(x => x.name === 'mark_read').length, before);
    assert.equal(row.unread, 1);
    visibility(receiver, false);
    await sleep(750);
    assert.ok(receiver.rpcLog.filter(x => x.name === 'mark_read').length > before);
    assert.equal(row.unread, 0);
    const bubble = receiver.$('chat-messages').querySelector('[data-id="' + msg.id + '"]');
    assert.ok(bubble?.textContent.includes(msg.body));
  } finally { sender?.close(); receiver.close(); }
});
