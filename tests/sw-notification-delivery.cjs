const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scope = 'https://example.test/chatter/';
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function createWorker(clients, navigator = {}) {
  const events = new Map();
  const displayed = [];
  const opened = [];
  const self = {
    location: new URL(scope),
    registration: {
      scope,
      async showNotification(title, options) { displayed.push({ title, options }); }
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async url => { opened.push(url); }
    },
    navigator,
    addEventListener: (name, handler) => events.set(name, handler)
  };
  vm.runInNewContext(worker, { self, URL, setTimeout, clearTimeout });
  function dispatch(type, props) {
    let pending;
    events.get(type)({ ...props, waitUntil(p) { pending = p; } });
    return pending;
  }
  return {
    displayed, opened,
    push: data => dispatch('push', { data: { json: () => data } }),
    tap: url => dispatch('notificationclick', { notification: { data: { url }, close() {} } })
  };
}

test('更新角标尚未完成时，收到的通知已经展示', async () => {
  let releaseBadge;
  const badge = new Promise(resolve => { releaseBadge = resolve; });
  const sw = createWorker([], { setAppBadge: () => badge });
  const pending = sw.push({ title: '测试来信', badge: 2, tag: 'm:sample' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sw.displayed.length, 1);
    assert.equal(sw.displayed[0].options.tag, 'm:sample');
  } finally {
    releaseBadge();
    await pending;
  }
});

test('通知点击时第一个聊天窗口已失效，唤起下一个并只在该窗口打开会话', async () => {
  const delivery = [];
  const gone = { url: scope, async focus() { throw Error('Gone'); }, postMessage() { delivery.push('gone'); } };
  const ready = { url: scope + 'index.html', async focus() { delivery.push('focus'); }, postMessage(m) { delivery.push(m.url); } };
  const sw = createWorker([gone, ready]);
  await sw.tap('./#c=sample');
  assert.deepEqual(delivery, ['focus', scope + '#c=sample']);
  assert.deepEqual(sw.opened, []);
});

test('所有已打开的聊天窗口都不能唤起时，使用通知的站内地址重新打开', async () => {
  const sw = createWorker([{ url: scope, async focus() { throw Error('Gone'); }, postMessage() {} }]);
  await sw.tap('./#g=sample');
  assert.deepEqual(sw.opened, [scope + '#g=sample']);
});
