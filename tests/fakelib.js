/* createClient 假实现：仅用于本地冒烟测试（pad: createClient） */
(function () {
  const SUPA = 'https://uaoiqbxptnbrvkzjwguc.supabase.co';
  const BC = new BroadcastChannel('fakedb');
  const load = () => JSON.parse(localStorage.getItem('fakedb') || '{}');
  const save = d => localStorage.setItem('fakedb', JSON.stringify(d));
  const T = n => { const d = load(); d[n] = d[n] || []; return d; };
  const chans = [];
  const emit = (table, eventType, row) => { BC.postMessage({ table, eventType, new: row }); local(table, eventType, row); };
  function local(table, eventType, row) {
    if (window.__noWS) return;
    chans.forEach(ch => ch.pg.forEach(h => {
      if (h.table !== table) return; if (h.event !== '*' && h.event !== eventType) return;
      if (h.filter) { const m = h.filter.match(/^(\w+)=eq\.(.*)$/); if (m && String(row[m[1]]) !== m[2]) return; }
      setTimeout(() => h.cb({ eventType, new: row }), 5);
    }));
  }
  BC.onmessage = e => local(e.data.table, e.data.eventType, e.data.new);
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => (Math.random() * 16 | 0).toString(16));
  let me = null;
  function afterInsertMsg(d, m) {
    const mk = (owner, peer, unread, read) => {
      let c = d.conversations.find(x => x.owner_acc === owner && x.conv_key === m.conv_key);
      if (!c) { c = { owner_acc: owner, conv_key: m.conv_key, peer_acc: peer, unread: 0 }; d.conversations.push(c); }
      const P = { image: '[图片]', voice: '[语音]', call: '[通话]', sticker: '[表情]', video: '[视频]' };
      c.last_body = m.type === 'text' ? m.body : m.type === 'file' ? '[文件] ' + Array.from(JSON.parse(m.body).n || '').slice(0, 60).join('') : (P[m.type] || '[消息]'); c.last_ts = m.created_at; c.peer_acc = peer;
      if (read) { c.last_read_ts = m.created_at; c.unread = 0; } else c.unread = (c.unread || 0) + unread;
      emit('conversations', 'UPDATE', Object.assign({}, c));
    };
    mk(m.from_acc, m.to_acc, 0, true); mk(m.to_acc, m.from_acc, m.type === 'call' ? 0 : 1, false);
  }
  function query(table) {
    const q = { table, op: 'select', f: [], ord: null, lim: null, vals: null, single: false, maybe: false };
    const api = {
      select(c) { q.sel = c || '*'; return api; }, eq(c, v) { q.f.push(r => String(r[c]) === String(v)); return api; }, neq(c, v) { q.f.push(r => String(r[c]) !== String(v)); return api; },
      lt(c, v) { q.f.push(r => r[c] < v); return api; }, gt(c, v) { q.f.push(r => r[c] > v); return api; }, in(c, a) { q.f.push(r => a.indexOf(r[c]) > -1); return api; },
      or(s) { const parts = s.split(',').map(p => p.match(/^(\w+)\.ilike\.%(.*)%$/)); q.f.push(r => parts.some(m => m && String(r[m[1]] || '').toLowerCase().indexOf(m[2].toLowerCase()) > -1)); return api; },
      ilike(c, pat) { const lit = String(pat).replace(/^%|%$/g, '').replace(/\\([\\%_])/g, '$1').toLowerCase(); q.f.push(r => String(r[c] || '').toLowerCase().indexOf(lit) > -1); return api; },
      not() { return api; }, order(c, o) { q.ord = [c, o && o.ascending === false]; return api; }, limit(n) { q.lim = n; return api; },
      insert(v) { q.op = 'insert'; q.vals = v; return api; }, update(v) { q.op = 'update'; q.vals = v; return api; }, upsert(v) { q.op = 'upsert'; q.vals = v; return api; }, delete() { q.op = 'delete'; return api; },
      single() { q.single = true; return api; }, maybeSingle() { q.maybe = true; return api; },
      then(res, rej) { return new Promise(r => setTimeout(r, 15)).then(() => run()).then(res, rej); }
    };
    function run() {
      const d = T(table); let rows = d[table];
      if (table === 'friendships' && window.__noV7 && /remark/.test(q.sel || '')) return { data: null, error: { code: '42703', message: 'column friendships.remark does not exist' } };
      if (table === 'stickers') {   // 模拟 setup-v6.sql 的表和权限：只能看/改/删自己的；只能加自己文件夹里的；最多 500 个
        if (window.__noV6) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.stickers' in the schema cache" } };
        q.f.push(r => r.owner_acc === me);
        if (q.op === 'insert') {
          const v = q.vals;
          if (v.owner_acc !== me || String(v.url).indexOf('/storage/v1/object/public/chat-media/' + me + '/') < 0 || rows.filter(r => r.owner_acc === me).length >= 500) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "stickers"' } };
          q.vals = Object.assign({ id: uuid(), created_at: new Date().toISOString(), kw: '' }, v);
        }
      }
      if (q.op === 'insert' || q.op === 'upsert') {
        let v = Object.assign({}, q.vals);
        if (table === 'messages') {
          if (window.__failInsert) return { data: null, error: { code: '08006', message: 'network down' } };
          if (rows.some(r => r.id === v.id)) return { data: null, error: { code: '23505', message: 'dup' } };
          if (v.from_acc !== me) return { data: null, error: { code: '42501', message: 'rls' } };
          if (['text', 'image', 'voice', 'call'].concat(window.__noV6 ? [] : ['sticker', 'video', 'file']).indexOf(v.type) < 0) return { data: null, error: { code: 'P0001', message: 'invalid message type' } };
          if (v.type === 'file') { let j = null; try { j = JSON.parse(v.body); } catch (e) {} if (!j || typeof j !== 'object' || Array.isArray(j) || !j.u) return { data: null, error: { code: 'P0001', message: 'invalid file body' } }; }
          v.created_at = new Date().toISOString(); v.conv_key = [v.from_acc, v.to_acc].sort().join('::');
          rows.push(v); afterInsertMsg(d, v); save(d); emit('messages', 'INSERT', v); return out([v]);
        }
        rows.push(v); save(d); return out([v]);
      }
      if (q.op === 'delete') {
        const hit = rows.filter(r => q.f.every(f => f(r)));
        d[table] = rows.filter(r => hit.indexOf(r) < 0); save(d); return out(hit);
      }
      if (q.op === 'update') {
        const hit = rows.filter(r => q.f.every(f => f(r)));
        hit.forEach(r => Object.assign(r, q.vals)); save(d);
        if (table === 'messages') hit.forEach(r => emit('messages', 'UPDATE', Object.assign({}, r)));
        return out(hit);
      }
      let hit = rows.filter(r => q.f.every(f => f(r)));
      if (q.ord) hit.sort((a, b) => (a[q.ord[0]] < b[q.ord[0]] ? -1 : 1) * (q.ord[1] ? -1 : 1));
      if (q.lim) hit = hit.slice(0, q.lim);
      return out(hit);
    }
    function out(hit) {
      if (q.single) return hit.length ? { data: hit[0], error: null } : { data: null, error: { message: 'none' } };
      if (q.maybe) return { data: hit[0] || null, error: null };
      return { data: hit, error: null };
    }
    return api;
  }
  window.supabase = { createClient() {
    const subs = [];
    const client = {
      auth: {
        onAuthStateChange(cb) { subs.push(cb); setTimeout(() => cb('INITIAL_SESSION', null), 5); return { data: { subscription: {} } }; },
        async signInWithPassword({ email, password }) {
          if (window.__netFail) return { data: { user: null, session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
          if (window.__realPw && password !== window.__realPw) return { data: null, error: { message: 'Invalid login credentials' } };
          const acc = email.split('@')[0], d = T('profiles');
          if (!d.profiles.some(p => p.account_id === acc)) return { error: { message: 'bad' } };
          me = acc; window.__acc = acc;
          setTimeout(() => subs.forEach(cb => cb('SIGNED_IN', { access_token: 'tok-' + acc, user: { id: 'uid-' + acc } })), 5);
          return { data: {}, error: null };
        },
        async signUp({ email, password, options }) {
          if (window.__netFail) return { data: { user: null, session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
          const acc = email.split('@')[0], d = T('profiles');
          d.profiles.push({ id: 'uid-' + acc, account_id: acc, nickname: (options && options.data && options.data.nickname) || acc }); save(d);
          me = acc; window.__acc = acc; window.__signedUp = acc;
          setTimeout(() => subs.forEach(cb => cb('SIGNED_IN', { access_token: 'tok-' + acc, user: { id: 'uid-' + acc } })), 5);
          return { data: { user: { id: 'uid-' + acc }, session: { access_token: 'tok-' + acc } }, error: null };
        },
        async getSession() { return { data: { session: me ? { access_token: 'tok-' + me } : null }, error: null }; },
        async getUser() { return { data: { user: { id: 'uid-' + me, email: me + '@chatter.local' } }, error: null }; },
        async updateUser({ password }) { if (window.__failUpdate) return { data: null, error: { message: 'weak' } }; (window.__pw = window.__pw || []).push(password); return { data: {}, error: null }; },
        async signOut() { return {}; }
      },
      realtime: { setAuth() {} },
      from: query,
      rpc(name, args) {   // 和真库一样：返回值支持 .abortSignal()
        const pr = client._rpc(name, args);
        const wrap = p => { p.abortSignal = sig => wrap(new Promise(res => { sig.addEventListener('abort', () => res({ data: null, error: { message: 'AbortError: signal is aborted' } })); p.then(res); })); return p; };
        return wrap(pr);
      },
      async _rpc(name, args) {
        await new Promise(r => setTimeout(r, 20));
        if (window.__netFail) return { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } };
        const d = load();
        if (name === 'account_exists') { if (window.__noAccFn) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.account_exists(p_acc) in the schema cache' } }; return { data: d.profiles.some(p => p.account_id === args.p_acc), error: null }; }
        if (name === 'chatter_schema') { window.__schemaCalls = (window.__schemaCalls || 0) + 1; return window.__noV6 ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.chatter_schema without parameters in the schema cache' } } : { data: window.__noV7 ? 6 : 7, error: null }; }
        if (name === 'remove_friendship') { const d0 = load(); d0.friendships = (d0.friendships || []).filter(f => !((f.owner_acc === args.p_me && f.friend_acc === args.p_peer) || (f.owner_acc === args.p_peer && f.friend_acc === args.p_me))); save(d0); return { data: null, error: null }; }
        if (name === 'set_remark' || name === 'storage_used') {
          if (window.__noV7) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name + ' in the schema cache' } };
          if (name === 'storage_used') return { data: window.__stUsed != null ? window.__stUsed : 0, error: null };
          const d0 = load(), r = String(args.p_remark || '').trim();
          if (Array.from(r).length > 20) return { data: null, error: { code: 'P0001', message: 'remark too long' } };
          const row = (d0.friendships || []).find(f => f.owner_acc === me && f.friend_acc === args.p_friend);
          if (!row) return { data: null, error: { code: 'P0001', message: 'not friends' } };
          row.remark = r; save(d0); window.__remarkCalls = (window.__remarkCalls || 0) + 1; return { data: null, error: null };
        }
        if (name === 'bootstrap') {
          const prof = a => { const p = d.profiles.find(x => x.account_id === a); return p && { account_id: p.account_id, nickname: p.nickname, avatar_url: null }; };
          const friends = d.friendships.filter(f => f.owner_acc === me).map(f => prof(f.friend_acc));
          const convs = (d.conversations || []).filter(c => c.owner_acc === me);
          return { data: { me: d.profiles.find(p => p.account_id === me), friends, convs, peers: convs.map(c => prof(c.peer_acc)), requests: [] }, error: null };
        }
        if (name === 'send_signal') {
          if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.send_signal' } };
          if (!d.friendships.some(x => x.owner_acc === me && x.friend_acc === args.p_to)) return { data: null, error: { message: 'not friends' } };
          const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          localStorage.setItem('fsig:' + args.p_to + ':' + id, JSON.stringify({ id, from_acc: me, payload: args.p_payload, created_at: new Date().toISOString() }));
          window.__sigSent = (window.__sigSent || 0) + 1; return { data: null, error: null };
        }
        if (name === 'poll_inbox') {
          if (window.__hangInbox) { window.__hung = (window.__hung || 0) + 1; await new Promise(() => {}); }   // 模拟国内网络把请求卡住
          if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.poll_inbox' } };
          const since = args.p_since ? Date.parse(args.p_since) : Date.now() - 60000, until = Date.now() + Math.min(args.p_wait_ms || 0, 2500);
          window.__inboxCalls = (window.__inboxCalls || 0) + 1;
          for (;;) {
            const db = load();
            const msgs = (db.messages || []).filter(m => m.to_acc === me && Date.parse(m.created_at) > since - 15000).sort((x, y) => (x.created_at < y.created_at ? -1 : 1)).slice(0, 100);
            const fresh = msgs.filter(m => Date.parse(m.created_at) > since).length;
            const sigs = []; Object.keys(localStorage).filter(k => k.indexOf('fsig:' + me + ':') === 0).forEach(k => { const v = JSON.parse(localStorage.getItem(k)); localStorage.removeItem(k); if (Date.now() - Date.parse(v.created_at) < 60000) sigs.push({ id: v.id, from_acc: v.from_acc, payload: v.payload }); });
            if (fresh || sigs.length || Date.now() >= until) return { data: { msgs, sigs: sigs.sort((x, y) => x.id - y.id) }, error: null };
            await new Promise(r => setTimeout(r, 100));
          }
        }
        if (name === 'take_signals') {
          if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.take_signals' } };
          const out = []; Object.keys(localStorage).filter(k => k.indexOf('fsig:' + me + ':') === 0).forEach(k => { const v = JSON.parse(localStorage.getItem(k)); localStorage.removeItem(k); if (Date.now() - Date.parse(v.created_at) < 60000) out.push(v); });
          window.__sigTaken = (window.__sigTaken || 0) + out.length; return { data: out.sort((a, b) => a.id - b.id), error: null };
        }
        if (name === 'heartbeat') { if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.heartbeat' } }; localStorage.setItem('fpres:' + me, args.p_online === false ? '0' : String(Date.now())); return { data: null, error: null }; }
        if (name === 'friends_seen') { if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.friends_seen' } }; return { data: d.friendships.filter(x => x.owner_acc === me).map(x => ({ account_id: x.friend_acc, online: Date.now() - (+localStorage.getItem('fpres:' + x.friend_acc) || 0) < 75000 })), error: null }; }
        if (name === 'mark_read') { if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.mark_read' } }; const c = (d.conversations || []).find(x => x.owner_acc === me && x.conv_key === args.p_conv); if (c) { c.unread = 0; c.last_read_ts = new Date().toISOString(); save(d); } window.__mr = (window.__mr || 0) + 1; return { data: null, error: null }; }
        if (name === 'peer_read') { if (window.__noRpc) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.peer_read' } }; const mine = (d.conversations || []).find(x => x.owner_acc === me && x.conv_key === args.p_conv); const c = mine && (d.conversations || []).find(x => x.owner_acc === mine.peer_acc && x.conv_key === args.p_conv); return { data: (c && c.last_read_ts) || null, error: null }; }
        return { data: 'ok', error: null };
      },
      channel(name) {
        const ch = { name, pg: [], bc: {}, state: 'joined',
          on(kind, opts, cb) { if (kind === 'postgres_changes') ch.pg.push({ table: opts.table, event: opts.event, filter: opts.filter, cb }); else if (kind === 'broadcast') (ch.bc[opts.event] = ch.bc[opts.event] || []).push(cb); return ch; },
          subscribe(cb) { chans.push(ch); setTimeout(() => cb && cb((window.__noWS || window.__wsStatusFail) ? 'TIMED_OUT' : 'SUBSCRIBED'), window.__subDelay || 10); return ch; },
          track() { return Promise.resolve(); }, presenceState() { return {}; } };
        return ch;
      },
      removeChannel(ch) { const i = chans.indexOf(ch); if (i > -1) chans.splice(i, 1); return Promise.resolve(); },
      storage: { from() { const folder0 = window.__me || ''; return {
        async upload(path, blob, opt) {
          const lim = window.__noV6 ? 20971520 : 52428800;
          if (blob && blob.size > lim) return { error: { statusCode: '413', message: 'The object exceeded the maximum allowed size' } };
          (window.__uploads = window.__uploads || []).push(blob && blob.size); (window.__upl = window.__upl || []).push({ path, size: blob && blob.size, ct: opt && opt.contentType }); return { error: null };
        },
        async list(folder, opt) { const all = window.__files || []; const off = (opt && opt.offset) || 0, lim = (opt && opt.limit) || 100; return { data: all.slice(off, off + lim), error: window.__listErr ? { message: 'permission denied' } : null }; },
        async remove(paths) { window.__removed = (window.__removed || []).concat(paths); window.__files = (window.__files || []).filter(f => paths.indexOf(window.__acc + '/' + f.name) < 0); return { data: paths.map(p => ({ name: p })), error: null }; },
        getPublicUrl(path) { return { data: { publicUrl: SUPA + '/storage/v1/object/public/chat-media/' + path } }; } }; } }
    };
    window.__deliver = (topic, event, payload) => window.__noWS ? 0 : chans.forEach(ch => { if (ch.name === topic) (ch.bc[event] || []).forEach(cb => cb({ payload })); });
    return client;
  } };
})();
/* createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding createClient padding */

/* 模拟 Supabase Storage 的上传接口（网页用 XHR 直接上传，才能显示进度） */
(function () {
  if (typeof XMLHttpRequest === 'undefined') return;
  const XP = XMLHttpRequest.prototype, o = XP.open, sd = XP.send, sh = XP.setRequestHeader;
  XP.open = function (m, u) { this.__fk = /\/storage\/v1\/object\/chat-media\//.test(u) && !window.__realXhr ? { u, h: {} } : null; if (!this.__fk) return o.apply(this, arguments); };
  XP.setRequestHeader = function (k, v) { if (this.__fk) { this.__fk.h[String(k).toLowerCase()] = v; return; } return sh.apply(this, arguments); };
  XP.send = function (body) {
    if (!this.__fk) return sd.apply(this, arguments);
    const x = this, fk = this.__fk;
    const path = decodeURIComponent(fk.u.split('/storage/v1/object/chat-media/')[1] || '');
    const file = body && body.get ? body.get('') : body, size = file ? file.size : 0;
    (window.__xhrReqs = window.__xhrReqs || []).push({ path, auth: fk.h.authorization || '', apikey: fk.h.apikey || '', upsert: fk.h['x-upsert'], cc: body && body.get ? body.get('cacheControl') : null });
    const done = (st, obj) => { Object.defineProperty(x, 'status', { value: st, configurable: true }); Object.defineProperty(x, 'responseText', { value: JSON.stringify(obj), configurable: true }); if (x.onload) x.onload(); };
    if (window.__xhrFail) { setTimeout(() => { if (x.onerror) x.onerror(); }, 20); return; }
    if (!/^Bearer tok-/.test(fk.h.authorization || '') || !fk.h.apikey) { setTimeout(() => done(400, { statusCode: '400', error: 'Bad Request', message: 'Invalid headers' }), 20); return; }
    const lim = window.__noV6 ? 20971520 : 52428800;
    if (size > lim) { setTimeout(() => done(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }), 20); return; }
    const steps = window.__slowUp ? 10 : 3; let i = 0;
    const tick = () => {
      i++; if (x.upload && x.upload.onprogress) x.upload.onprogress({ lengthComputable: true, loaded: Math.round(size * i / steps), total: size });
      if (i < steps) { setTimeout(tick, window.__slowUp || 15); return; }
      (window.__uploads = window.__uploads || []).push(size); (window.__upl = window.__upl || []).push({ path, size, ct: file && file.type, via: 'xhr' });
      done(200, { Key: 'chat-media/' + path });
    };
    setTimeout(tick, 10);
  };
})();
