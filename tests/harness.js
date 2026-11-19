// 测试用的“假手机”：用 jsdom 模拟浏览器，把仓库里的 index.html + app.js 原样跑起来；Supabase 用内存里的假数据库顶替。
// 不联网、不碰线上任何东西。用法见 tests/README.md。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const ROOT = path.resolve(__dirname, '..');   // 仓库根目录
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r/g, '').split('\n');
const bodyStart = SRC.findIndex(x => /^<body/.test(x)), appTag = SRC.findIndex(x => /<script src="app\.js/.test(x));
const BODY = SRC.slice(bodyStart + 1, appTag).join('\n').replace(/<script>[\s\S]*?<\/script>/g, '');
const MAIN = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\r/g, '');
if (MAIN.indexOf('if (window.__TEST__) window.__T = {') < 0) throw new Error('app.js 里找不到测试接口 window.__T（别删掉那一行）');

const ME = 'me', UID = '11111111-1111-4111-8111-111111111111';
const iso = t => new Date(t).toISOString();

function makeEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + BODY + '</body></html>', {
    url: 'https://example.test/app/', pretendToBeVisual: true, runScripts: 'outside-only'
  });
  const w = dom.window;
  w.indexedDB = opts.idb || new IDBFactory(); w.IDBKeyRange = IDBKeyRange;   // 每个测试一个全新的本机数据库（要模拟“重开 App”就把上一个的 env.idb 传进来）
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.__TEST__ = true;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.URL.createObjectURL = () => 'blob:fake-' + Math.random().toString(36).slice(2);
  w.URL.revokeObjectURL = () => {};
  const fetchLog = [];
  w.fetch = async (u, o) => { fetchLog.push({ u: String(u), body: o && o.body }); return { ok: true, status: 200, json: async () => ({ sent: 1 }), text: async () => '', blob: async () => new w.Blob(['x']) }; };
  const toasts = [];
  // ---------- 内存数据库 ----------
  const db = Object.assign({ messages: [], conversations: [], profiles: [], chat_group_members: [], chat_groups: [], moments: [], moment_views: [], moment_likes: [], moment_comments: [], stickers: [], group_files: [], group_invites: [], friendships: [], chat_backgrounds: [], app_config: [], friend_requests: [] }, opts.db || {});
  const log = [];
  const storage = { files: (opts.files || []).slice(), removed: [] };
  function rowsOf(q) {
    let rows = (db[q.table] || []).slice();
    // 模拟行级权限里和复现有关的两条
    if (q.table === 'moment_views') rows = rows.filter(r => { const m = db.moments.find(x => x.id === r.moment_id); return m && m.author_acc === ME; });   // mv_sel：只有作者能读
    for (const f of q.filters) {
      const [op, c, v] = f;
      if (op === 'eq') rows = rows.filter(r => String(r[c]) === String(v));
      else if (op === 'neq') rows = rows.filter(r => String(r[c]) !== String(v));
      else if (op === 'gt') rows = rows.filter(r => r[c] > v);
      else if (op === 'lt') rows = rows.filter(r => r[c] < v);
      else if (op === 'lte') rows = rows.filter(r => r[c] <= v);
      else if (op === 'is') rows = rows.filter(r => (r[c] == null) === (v === null));
      else if (op === 'in') rows = rows.filter(r => v.indexOf(r[c]) >= 0);
      else if (op === 'ilike') { const s = String(v).replace(/%/g, '').toLowerCase(); rows = rows.filter(r => String(r[c] || '').toLowerCase().indexOf(s) >= 0); }
    }
    if (q.or && q.or.startsWith('created_at.lt.')) {
      const match = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/.exec(q.or);
      if (!match) throw new Error('Invalid pagination filter');
      rows = rows.filter(r => r.created_at < match[1] || (r.created_at === match[2] && r.id < match[3]));
    }
    if (q.order) rows.sort((a, b) => {
      for (const { c, asc } of q.order) {
        const result = (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1);
        if (result) return result;
      }
      return 0;
    });
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit != null) rows = rows.slice(0, q.limit);
    return rows;
  }
  function run(q) {
    log.push(q);
    if (opts.onQuery) { const r = opts.onQuery(q, db); if (r) return r; }
    if (q.op === 'select') {
      const rows = rowsOf(q);
      if (q.single === 'maybe') return { data: rows[0] || null, error: null };
      if (q.single === 'one') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: rows, error: null };
    }
    if (q.op === 'insert' || q.op === 'upsert') {
      const rows = Array.isArray(q.rows) ? q.rows : [q.rows];
      if (q.table === 'moment_views') {   // unique (moment_id, viewer_acc)：一条重复，整批失败（Postgres 的行为）
        const dup = rows.some(r => db.moment_views.some(x => x.moment_id === r.moment_id && x.viewer_acc === r.viewer_acc));
        if (dup && !(q.op === 'upsert' && q.opts && q.opts.ignoreDuplicates)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        rows.forEach(r => { if (!db.moment_views.some(x => x.moment_id === r.moment_id && x.viewer_acc === r.viewer_acc)) db.moment_views.push(Object.assign({ created_at: iso(Date.now()) }, r)); });
        return { data: null, error: null };
      }
      if (q.table === 'messages') {
        const inserted = [];
        for (const r of rows) {
          if (['text', 'image', 'voice', 'call', 'sticker', 'video', 'file'].indexOf(r.type) < 0) return { data: null, error: { code: 'P0001', message: 'invalid message type' } };   // 触发器 messages_before_insert
          if (db.messages.some(m => m.id === r.id)) return { data: null, error: { code: '23505', message: 'duplicate' } };
          const row = Object.assign({ created_at: iso(Date.now()) }, r);
          db.messages.push(row);
          inserted.push(row);
        }
        return q.single ? { data: inserted[0], error: null } : { data: null, error: null };
      }
      const stored = rows.map(r => Object.assign({ id: 'id' + Math.random().toString(36).slice(2), created_at: iso(Date.now()) }, r));   // 像线上一样：返回的行带上数据库生成的 id 和时间
      stored.forEach(r => (db[q.table] = db[q.table] || []).push(r));
      return { data: q.single ? stored[0] : null, error: null };
    }
    if (q.op === 'update') {
      const rows = rowsOf(q); rows.forEach(r => Object.assign(r, q.values));
      return { data: q.single ? (rows[0] || null) : rows, error: null };
    }
    if (q.op === 'delete') { const rows = rowsOf(q); db[q.table] = (db[q.table] || []).filter(r => rows.indexOf(r) < 0); return { data: rows, error: null }; }
    return { data: null, error: null };
  }
  function from(table) {
    const q = { table, op: 'select', filters: [] };
    const b = {
      select(c) { q.cols = c; return b; }, insert(r) { q.op = 'insert'; q.rows = r; return b; }, upsert(r, o) { q.op = 'upsert'; q.rows = r; q.opts = o; return b; },
      update(v) { q.op = 'update'; q.values = v; return b; }, delete() { q.op = 'delete'; return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; }, neq(c, v) { q.filters.push(['neq', c, v]); return b; },
      gt(c, v) { q.filters.push(['gt', c, v]); return b; }, lt(c, v) { q.filters.push(['lt', c, v]); return b; }, lte(c, v) { q.filters.push(['lte', c, v]); return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; }, ilike(c, v) { q.filters.push(['ilike', c, v]); return b; }, or(v) { q.or = v; return b; }, is(c, v) { q.filters.push(['is', c, v]); return b; },
      order(c, o) { (q.order ||= []).push({ c, asc: !(o && o.ascending === false) }); return b; }, limit(n) { q.limit = n; return b; }, range(a, z) { q.range = [a, z]; return b; },
      maybeSingle() { q.single = 'maybe'; return b; }, single() { q.single = 'one'; return b; }, abortSignal() { return b; },
      then(res, rej) { return Promise.resolve().then(() => run(q)).then(res, rej); }, catch(f) { return Promise.resolve().then(() => run(q)).catch(f); }
    };
    return b;
  }
  const rpcLog = [];
  function rpc(name, args) {
    rpcLog.push({ name, args });
    let out = { data: null, error: null };
    if (opts.onRpc) { const r = opts.onRpc(name, args, db); if (r) out = r; else out = defRpc(name, args); } else out = defRpc(name, args);
    const p = (opts.slowInbox && name === 'poll_inbox' && args && args.p_wait_ms > 0) ? new Promise(r => setTimeout(() => r(out), args.p_wait_ms)) : Promise.resolve(out); p.abortSignal = () => p; return p;
  }
  function defRpc(name, args) {
    if (name === 'my_kick_at') return { data: null, error: { code: 'PGRST202' } };
    if (name === 'mark_read') { db.conversations.filter(c => c.owner_acc === ME && c.conv_key === (args && args.p_conv)).forEach(c => { c.unread = 0; c.last_read_ts = iso(Date.now()); }); return { data: null, error: null }; }   // 像线上一样：标记已读就把未读清零
    if (name === 'bootstrap') return { data: { me: db.profiles.find(p => p.account_id === ME), friends: db.profiles.filter(p => p.account_id !== ME && db.friendships.some(f => f.friend_acc === p.account_id)), convs: db.conversations.filter(c => c.owner_acc === ME), peers: [], requests: [] }, error: null };
    if (name === 'chatter_schema') return { data: 8, error: null };
    if (name === 'my_group_invites') return { data: [], error: null };
    if (name === 'friends_seen' || name === 'take_signals') return { data: [], error: null };
    if (name === 'poll_inbox') return { data: { msgs: [], sigs: [] }, error: null };
    if (name === 'group_call_state') return { data: null, error: null };
    if (name === 'storage_used') return { data: 0, error: null };
    return { data: null, error: null };
  }
  let authCb = null;
  const rtH = []; const chan = () => { const c = { on(type, filt, cb) { rtH.push({ type, filt, cb }); return c; }, subscribe(cb) { setTimeout(() => { try { cb && cb(opts.rt === false ? 'TIMED_OUT' : 'SUBSCRIBED'); } catch (e) {} }, 0); return c; }, presenceState() { return {}; }, track: async () => {}, state: 'joined' }; return c; };
  const sb = {
    from, rpc,
    auth: { onAuthStateChange(cb) { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; }, getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: UID } } } }), getUser: async () => ({ data: { user: { id: UID, email: 'me@chatter.local' } } }), signOut: async () => ({}) },
    channel: chan, removeChannel() {}, realtime: { setAuth() {} },
    storage: { from() { return {
      list: async (dir, o) => ({ data: storage.files.slice(o.offset, o.offset + o.limit), error: null }),
      remove: async keys => { storage.removed.push(...keys); storage.files = storage.files.filter(f => keys.indexOf(ME + '/' + f.name) < 0); return { data: keys.map(k => ({ name: k })), error: null }; },
      upload: async () => ({ data: {}, error: null }),
      getPublicUrl: p => ({ data: { publicUrl: 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/' + p } })
    }; } }
  };
  w.supabase = { createClient: () => sb };
  w.__lib = Promise.resolve();
  if (opts.before) opts.before(w);
  w.eval((opts.patch ? opts.patch(MAIN) : MAIN).replace('if (window.__TEST__) window.__T = {', 'window.__X = { convPreview, glGids, fillGlCards, msgHTML }; if (window.__TEST__) window.__T = {'));
  const T = w.__T;
  // 抓 toast 文本
  const mo = new w.MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('toast')) toasts.push(n.textContent); })));
  mo.observe(w.document.body, { childList: true });
  async function login() {
    await T.getReady();
    authCb('SIGNED_IN', { access_token: 'tok', user: { id: UID, user_metadata: {} } });
    await sleep(60);
  }
  const filtOk = (f, row) => { if (!f) return true; const m = /^(\w+)=(eq|in)\.(.*)$/.exec(f); if (!m) return true; const v = String(row[m[1]]); return m[2] === 'eq' ? v === m[3] : m[3].replace(/^\(|\)$/g, '').split(',').indexOf(v) >= 0; };
  const rtFire = (event, table, row) => rtH.filter(x => x.type === 'postgres_changes' && x.filt.table === table && (x.filt.event === event || x.filt.event === '*') && filtOk(x.filt.filter, row)).forEach(x => x.cb({ eventType: event, new: row }));
  return { idb: w.indexedDB, rtFire, w, T, X: w.__X, db, log, rpcLog, fetchLog, toasts, storage, login, $: id => w.document.getElementById(id), close() { try { w.close(); } catch (e) {} } };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prof = (acc, nick) => ({ id: acc === ME ? UID : 'u-' + acc, account_id: acc, nickname: nick || acc, avatar_url: '', signature: '', bg_url: '', cover_url: '', moments_seen_at: iso(0) });
module.exports = { makeEnv, sleep, iso, prof, ME, UID };
