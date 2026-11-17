// Chatter 自动检查：① 代码检查（拼错变量名之类的低级错误）② 用假手机把 App 跑一遍关键场景。
// 用法：cd tests && npm install && npm test        （--quick 跳过几个要等十几秒的）
// 全部 ✅ 才推送；有 ❌ 先修。只在本机跑，不联网、不碰线上数据。
const path = require('path');
const { makeEnv, sleep, iso, prof, ME } = require('./harness');

const QUICK = process.argv.includes('--quick');
const ROOT = path.resolve(__dirname, '..');
const uid = i => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
const GA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', GK = 'g:' + GA;
const IMG = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/17000_abcde.jpg';
const click = (env, el) => el.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fail = msg => { throw new Error(msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); };

// 常用的假数据：我、Bob、一个群
function baseDb(t, extra) {
  return Object.assign({
    profiles: [prof(ME, '我'), Object.assign(prof('bob', 'Bob'), { avatar_url: 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/av.jpg' })],
    friendships: [{ owner_acc: ME, friend_acc: 'bob' }],
    chat_groups: [{ id: GA, name: '测试群', owner_acc: 'bob' }],
    chat_group_members: [{ group_id: GA, account_id: ME, role: 'member' }, { group_id: GA, account_id: 'bob', role: 'owner' }],
    conversations: [{ owner_acc: ME, conv_key: 'bob::me', peer_acc: 'bob', last_body: 'x', last_ts: iso(t - 1000), unread: 0 },
      { owner_acc: ME, conv_key: GK, peer_acc: GK, last_body: 'y', last_ts: iso(t - 50000), unread: 0 }],
    messages: []
  }, extra || {});
}
// 像线上的数据库触发器一样：插入一条消息，同时更新双方的会话行（预览、时间、未读）
function serverInsert(db, m) {
  db.messages.push(m);
  db.conversations.filter(c => c.conv_key === m.conv_key).forEach(c => { c.last_body = m.body; c.last_ts = m.created_at; if (c.owner_acc !== m.from_acc) c.unread = (c.unread || 0) + 1; });
  return m;
}
const msg = (i, from, conv, body, t, type) => ({ id: uid(i), conv_key: conv, from_acc: from, to_acc: conv === GK ? GK : (from === ME ? 'bob' : ME), type: type || 'text', body, dur: null, created_at: iso(t) });
const conv = (env, k) => env.T.S.convs.find(c => c.convKey === k) || {};
const banner = env => { const b = env.$('msg-banner'); const r = b.classList.contains('on') ? b.textContent : ''; b.classList.remove('on'); return r; };
const msgEl = (env, id) => env.$('chat-messages').querySelector('.msg[data-id="' + id + '"]');
const inbox = (d, a) => { const since = Date.parse(a.p_since) - 15000; return { data: { msgs: d.messages.filter(m => (m.to_acc === ME || m.conv_key === GK) && Date.parse(m.created_at) > since), sigs: [] }, error: null }; };

const tests = [];
const test = (name, fn, slow) => tests.push({ name, fn, slow });

// ---------------- 收消息 / 打开聊天 ----------------
test('收消息：聊天开着时立刻显示、聊天关着时加未读', async () => {
  const t = Date.now(), db = baseDb(t); const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(300);
    env.rtFire('INSERT', 'messages', serverInsert(db, msg(1, 'bob', 'bob::me', '在吗？', Date.now()))); await sleep(150);
    ok(msgEl(env, uid(1)), '聊天开着，新消息没出现');
    env.T.closeChat(); await sleep(200);
    env.rtFire('INSERT', 'messages', serverInsert(db, msg(2, 'bob', 'bob::me', '第二条', Date.now()))); await sleep(200);
    ok(conv(env, 'bob::me').last_body === '第二条', '列表预览没更新：' + conv(env, 'bob::me').last_body);
    ok(conv(env, 'bob::me').unread === 1, '未读数不对：' + conv(env, 'bob::me').unread);
  } finally { env.close(); }
});

test('打开聊天：本机缓存 + 服务器新消息合并，最新一条在最后', async () => {
  const t = Date.now();
  const db = baseDb(t, { messages: Array.from({ length: 120 }, (_, i) => msg(i + 1, i % 2 ? 'bob' : ME, 'bob::me', '第' + (i + 1) + '条', t - 200000 + i * 1000)) });
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(200);
    await env.T.msgCacheSave('bob::me', db.messages.slice(0, 110).map(m => Object.assign({ conv: m.conv_key }, m)));
    await env.T.openConv('bob::me', 'bob'); await sleep(700);
    const all = env.$('chat-messages').querySelectorAll('.msg'); const last = all[all.length - 1];
    ok(last && /第120条/.test(last.textContent), '最后一条不是第 120 条：' + (last && last.textContent));
  } finally { env.close(); }
});

// ---------------- 不闪：刷新时只改变化的部分 ----------------
test('不闪：对方改消息/来新消息时，原有气泡和图片节点都不重建，只有新消息弹一下', async () => {
  const t = Date.now();
  const db = baseDb(t, { messages: Array.from({ length: 30 }, (_, i) => msg(i + 1, i % 3 ? 'bob' : ME, 'bob::me', i % 5 === 0 ? IMG + '#w=800&h=600' : '第' + i + '条', t - 60000 + i * 1000, i % 5 === 0 ? 'image' : 'text')) });
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(600);
    const box = env.$('chat-messages'), a1 = Array.from(box.children), i1 = Array.from(box.querySelectorAll('img'));
    ok(box.querySelectorAll('.msg.new').length === 0, '打开聊天时整片都在弹动画');
    db.messages[4].body = '第4条（改过）'; db.messages[4].edited_at = iso(Date.now());
    env.rtFire('UPDATE', 'messages', Object.assign({}, db.messages[4])); await sleep(150);
    const a2 = Array.from(box.children), i2 = Array.from(box.querySelectorAll('img'));
    ok(a2.every(el => a1.indexOf(el) >= 0), '有气泡被整条重建了');
    ok(i2.every(el => i1.indexOf(el) >= 0), '有图片被重新加载了');
    ok(/改过/.test(msgEl(env, uid(5)).textContent), '被改的消息没显示新内容');
    env.rtFire('INSERT', 'messages', serverInsert(db, msg(99, 'bob', 'bob::me', '新来的', Date.now()))); await sleep(150);
    const news = box.querySelectorAll('.msg.new');
    ok(news.length === 1 && /新来的/.test(news[0].textContent), '新消息动画不对：' + news.length);
  } finally { env.close(); }
});

test('不闪：后台同步时，会话列表/通讯录/我的头像/朋友圈头部都不重建', async () => {
  const t = Date.now(), db = baseDb(t); db.profiles[0].avatar_url = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/me/av.jpg';
  const env = makeEnv({ db, rt: false });
  try {
    await env.login(); await sleep(1500);
    const pick = () => ({ list: Array.from(env.$('conv-list').children), me: env.$('me-avatar').querySelector('img'), fl: env.$('friend-list').querySelector('img'), mo: env.$('mo-me-av') && env.$('mo-me-av').querySelector('img') });
    const a = pick(); await sleep(QUICK ? 4000 : 10000); const b = pick();
    ok(b.list.every(el => a.list.indexOf(el) >= 0), '会话列表被重建了');
    ok(a.me === b.me, '我的头像被重建了'); ok(a.fl === b.fl, '通讯录头像被重建了'); ok(a.mo === b.mo, '朋友圈头部头像被重建了');
  } finally { env.close(); }
});

test('不闪：朋友圈刷新时卡片不重建（入场动画不重播）', async () => {
  const t = Date.now();
  const db = baseDb(t, { moments: [1, 2, 3].map(i => ({ id: 'm' + i, author_acc: 'bob', body: '动态' + i, images: [], created_at: iso(t - i * 60000) })) });
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300);
    click(env, env.w.document.querySelector('.app-nav button[data-tab="moments"]')); await sleep(800);
    const el = env.$('moment-list'), a = Array.from(el.querySelectorAll('.moment'));
    ok(a.length === 3, '朋友圈没显示出 3 条：' + a.length);
    await env.T.pullRefresh(); await sleep(800);
    const b = Array.from(el.querySelectorAll('.moment'));
    ok(b.length === 3 && b.every(x => a.indexOf(x) >= 0), '朋友圈卡片被重建了');
  } finally { env.close(); }
});

// ---------------- 编辑 ----------------
test('编辑：对方改消息立刻提示一次、只在改的是最新一条时改预览；聊天开着时就地更新', async () => {
  const t = Date.now();
  const db = baseDb(t, { messages: [msg(1, 'bob', 'bob::me', '第一条', t - 40000), msg(2, 'bob', 'bob::me', '第二条（最新）', t - 30000)] });
  db.conversations[0].last_body = '第二条（最新）'; db.conversations[0].last_ts = iso(t - 30000);
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(1500);
    Object.assign(db.messages[0], { body: '第一条（改过）', edited_at: iso(Date.now()) });
    env.rtFire('UPDATE', 'messages', Object.assign({}, db.messages[0])); await sleep(100);
    ok(/第一条（改过）/.test(banner(env)), '对方改了消息却没有横幅');
    ok(conv(env, 'bob::me').last_body === '第二条（最新）', '改的是旧消息，预览却被顶掉了：' + conv(env, 'bob::me').last_body);
    env.rtFire('UPDATE', 'messages', Object.assign({}, db.messages[0])); await sleep(100);
    ok(banner(env) === '', '同一次编辑提示了两次');
    db.messages.push(msg(3, 'bob', 'bob::me', '第三条', Date.now()));
    await env.T.openConv('bob::me', 'bob'); await sleep(400);
    Object.assign(db.messages[2], { body: '第三条（改过）', edited_at: iso(Date.now()) });
    env.rtFire('UPDATE', 'messages', Object.assign({}, db.messages[2])); await sleep(150);
    ok(/第三条（改过）.*已编辑/.test(msgEl(env, uid(3)).textContent.replace(/\s+/g, ' ')), '聊天开着时气泡没更新');
  } finally { env.close(); }
});

test('编辑：自己的消息只能改一次，改完发一条 kind=edit 的推送', async () => {
  const t = Date.now(), db = baseDb(t, { messages: [msg(5, ME, 'bob::me', '我写错了', t - 3000)] });
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(400);
    const bubble = () => msgEl(env, uid(5)).querySelector('.bubble');
    bubble().dispatchEvent(new env.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await sleep(100);
    ok(env.$('msg-menu-edit').style.display !== 'none', '菜单里没有“编辑”');
    click(env, env.$('msg-menu-edit')); await sleep(150);
    env.$('fsf0').value = '我写对了'; click(env, env.$('fs-ok')); await sleep(300);
    const pushes = env.fetchLog.filter(f => /chatter-push/.test(f.u)).map(f => JSON.parse(f.body));
    ok(pushes.some(p => p.kind === 'edit'), '没有发编辑推送');
    ok(/我写对了/.test(msgEl(env, uid(5)).textContent), '气泡没变成新内容');
    bubble().dispatchEvent(new env.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await sleep(100);
    ok(env.$('msg-menu-edit').style.display === 'none', '改过一次还能再改');
  } finally { env.close(); }
});

// ---------------- 推送 ----------------
test('推送：本机以为对方在线也照样问服务器（以前直接不推）；对方刚读过这个聊天就不推', async () => {
  const t = Date.now(), db = baseDb(t); const calls = [];
  let readNow = false;
  const env = makeEnv({ db, onRpc: n => n === 'peer_read' ? { data: readNow ? new Date().toISOString() : null, error: null } : null,
    before: w => { const of = w.fetch; w.fetch = async (u, o) => { if (/chatter-push/.test(String(u))) { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ sent: 1 }) }; } return of(u, o); }; } });
  try {
    await env.login(); await sleep(300);
    env.T.S.online.add('bob');
    await env.T.openConv('bob::me', 'bob'); await sleep(400);
    env.$('chat-input').value = '在吗'; env.T.sendText(); await sleep(800);
    ok(calls.filter(c => c.op === 'push').length === 1, '本机以为对方在线就没请求推送');
    env.T.closeChat(); await sleep(100); readNow = true;
    await env.T.openConv('bob::me', 'bob'); await sleep(600);
    env.$('chat-input').value = '第二条'; env.T.sendText(); await sleep(800);
    ok(calls.filter(c => c.op === 'push').length === 1, '对方刚读过这个聊天还在推');
  } finally { env.close(); }
});

test('群消息补推：推了一部分就过一会儿再问，服务器说“都推过了”就停；私聊推出去后不再问', async () => {
  const t = Date.now(), db = baseDb(t); const calls = []; let seq = [];
  const env = makeEnv({ db, before: w => { const of = w.fetch; w.fetch = async (u, o) => { if (/chatter-push/.test(String(u))) { const b = JSON.parse(o.body); calls.push(b); const r = seq.shift() || { ok: true, skip: 'done' }; return { ok: true, status: 200, json: async () => r }; } return of(u, o); }; } });
  try {
    await env.login(); await sleep(300);
    env.T.PUSH.retryMs = [150, 150];
    const n = () => calls.filter(c => c.op === 'push').length;
    seq = [{ ok: true, sent: 1 }, { ok: true, skip: 'online' }, { ok: true, sent: 1 }];
    env.T.firePushRetry('gmsg', 'g:x', 'r1', { conv: 'g:x' }); await sleep(900);
    ok(n() === 3, '群：推了一部分 → 还有人在线 → 补推，应该一共问 3 次，实际 ' + n());
    calls.length = 0; seq = [{ ok: true, sent: 2 }, { ok: true, skip: 'done' }];
    env.T.firePushRetry('gmsg', 'g:x', 'r2', { conv: 'g:x' }); await sleep(900);
    ok(n() === 2, '群：第二次服务器说“都推过了”还在问：' + n());
    calls.length = 0; seq = [{ ok: true, sent: 1 }, { ok: true, skip: 'dup' }];
    env.T.firePushRetry('gmsg', 'g:x', 'r3', { conv: 'g:x' }); await sleep(900);
    ok(n() === 2, '群：还没运行新 SQL（服务器回“已经推过”）时没停：' + n());
    calls.length = 0; seq = [{ ok: true, sent: 1 }];
    env.T.firePushRetry('msg', 'bob', 'r4', { conv: 'bob::me', to_acc: 'bob' }); await sleep(600);
    ok(n() === 1, '私聊已经推出去了还在补推：' + n());
  } finally { env.close(); }
});

test('退出其他设备：服务器删推送登记并给出时间，本机作废其他登录凭证；本机不会把自己踢掉；被踢的设备回登录页', async () => {
  const t = Date.now(), db = baseDb(t); let alive = true, kickAt = '2026-11-17T12:00:00.123456+00:00';
  db.profiles[0].kick_at = null;
  const env = makeEnv({ db, onRpc: (n) => n === 'kick_others' ? { data: kickAt, error: null } : n === 'session_alive' ? { data: alive, error: null } : null });
  try {
    await env.login(); await sleep(300);
    const outs = []; env.T.sb.auth.signOut = async o => { outs.push(o); return {}; };
    env.toasts.length = 0;
    await env.T.kickOthers(); await sleep(100);
    const kr = env.rpcLog.find(x => x.name === 'kick_others');
    ok(kr && 'p_keep' in kr.args, '没调用 kick_others');
    ok(outs.length === 1 && outs[0] && outs[0].scope === 'others', '没有作废其他设备的登录凭证：' + JSON.stringify(outs));
    ok(JSON.parse(env.w.localStorage.getItem('ch2kickAt')) === kickAt, '本机没记下服务器给的时间');
    ok(env.toasts.some(x => /马上收不到通知/.test(x)), '提示不对：' + JSON.stringify(env.toasts));
    // 服务器那边的 kick_at 就是刚才这个时间（6 位小数秒）：本机检查时不能把自己踢掉
    db.profiles.find(p => p.account_id === ME).kick_at = kickAt; env.toasts.length = 0;
    env.T.checkKick(); await sleep(400);
    ok(!env.toasts.some(x => /退出登录/.test(x)), '发起踢人的这台把自己也踢了');
    // 被踢的设备：服务器说这次登录已作废
    alive = false; env.T.checkKick(); await sleep(1500);
    ok(env.toasts.some(x => /已在其他设备退出登录/.test(x)), '服务器说登录已作废，但没回登录页：' + JSON.stringify(env.toasts));
    ok(!Object.keys(env.w.localStorage).some(k => /^ch2:/.test(k)), '退出后本机缓存没清');
  } finally { env.close(); }
});

test('退出其他设备：还没运行新 SQL 时照旧（只记时间）；服务器查不到时不误踢', async () => {
  const t = Date.now(), db = baseDb(t);
  const env = makeEnv({ db, onRpc: (n) => n === 'kick_others' ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.kick_others' } } : n === 'session_alive' ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } : null });
  try {
    await env.login(); await sleep(300);
    env.T.sb.auth.signOut = async () => ({});
    env.toasts.length = 0;
    await env.T.kickOthers(); await sleep(150);
    const me = db.profiles.find(p => p.account_id === ME);
    ok(me.kick_at && JSON.parse(env.w.localStorage.getItem('ch2kickAt')) === me.kick_at, '旧办法没写 kick_at');
    ok(env.toasts.some(x => /下次联网时会自动退出/.test(x)), '提示不对：' + JSON.stringify(env.toasts));
    env.toasts.length = 0; env.T.checkKick(); await sleep(1200);
    ok(!env.toasts.some(x => /已在其他设备退出登录/.test(x)), 'session_alive 不存在时把人踢了');
  } finally { env.close(); }
});

// ---------------- 群 ----------------
test('群消息：实时通道到达立刻有横幅（带群名），同一条重复到达不重复提示', async () => {
  const t = Date.now(), db = baseDb(t); const env = makeEnv({ db });
  try {
    await env.login(); await sleep(1500);
    ok(env.T.S.rt.grp === true, '群消息实时通道没连上');
    const m = msg(200, 'bob', GK, '群里新消息', Date.now()); db.messages.push(m);
    env.rtFire('INSERT', 'messages', m); await sleep(100);
    ok(/测试群/.test(banner(env)), '群消息没有横幅或横幅没带群名');
    env.rtFire('INSERT', 'messages', m); await sleep(100);
    ok(banner(env) === '', '同一条群消息提示了两次');
  } finally { env.close(); }
});

test('国内模式：别人发的群消息有横幅加未读；我另一台设备发的不提醒但更新预览', async () => {
  const t = Date.now(), db = baseDb(t);
  const env = makeEnv({ db, rt: false, onRpc: (n, a, d) => n === 'poll_inbox' ? inbox(d, a) : null });
  try {
    await env.login(); await sleep(2500);
    db.messages.push(msg(800, ME, GK, '我在另一台手机发的', Date.now())); await sleep(1200);
    ok(conv(env, GK).unread === 0 && banner(env) === '', '自己发的群消息被当成新消息');
    ok(conv(env, GK).last_body === '我在另一台手机发的', '自己另一台设备发的消息没更新预览');
    db.messages.push(msg(900, 'bob', GK, 'Bob 的群消息', Date.now())); await sleep(1200);
    ok(conv(env, GK).unread === 1, '别人发的群消息没加未读：' + conv(env, GK).unread);
  } finally { env.close(); }
});

test('群链接卡片：取到信息显示“加入”；取不到显示“重试”且最多请求 3 次', async () => {
  const t = Date.now(), G2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const link = gid => 'https://x.github.io/index.html/#g=' + gid;
  const db = baseDb(t, { messages: [msg(1, 'bob', 'bob::me', link(GA), t - 5000), msg(2, 'bob', 'bob::me', link(G2), t - 4000)] });
  const env = makeEnv({ db, onRpc: (n, a) => n === 'group_link_info' ? (a.p_gid === GA ? { data: { name: '测试群', count: 5, member: false }, error: null } : { data: null, error: { code: '42501', message: 'denied' } }) : null });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(QUICK ? 4500 : 8000);
    const card = gid => env.$('chat-messages').querySelector('.gl-card[data-gid="' + gid + '"]');
    ok(card(GA) && /加入/.test(card(GA).textContent), '能取到的群卡片没显示“加入”：' + (card(GA) && card(GA).textContent));
    ok(card(G2) && /重试/.test(card(G2).textContent), '取不到的群卡片没显示“重试”：' + (card(G2) && card(G2).textContent));
    const n = env.rpcLog.filter(r => r.name === 'group_link_info' && r.args.p_gid === G2).length;
    ok(n <= 3, '取不到的群卡片请求了 ' + n + ' 次');
    ok(!/#g=/.test(msgEl(env, uid(1)).querySelector('.bubble').childNodes[0].textContent || ''), '气泡里还显示网址');
  } finally { env.close(); }
}, true);

// ---------------- 缓存 / 图片 ----------------
test('关聊天存缓存：不存“发送中/失败”的消息（重开不会有幽灵消息）', async () => {
  const t = Date.now(), db = baseDb(t, { messages: Array.from({ length: 50 }, (_, i) => msg(i + 1, 'bob', 'bob::me', '第' + i + '条', t - 90000 + i * 1000)) });
  const env = makeEnv({ db, onQuery: q => (q.table === 'messages' && q.op === 'insert') ? { data: null, error: { message: 'Failed to fetch' } } : null });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(500);
    env.$('chat-input').value = '断网时发的'; env.T.sendText(); await sleep(800);
    env.T.closeChat(); await sleep(300);
    const c = await env.T.msgCacheGet('bob::me');
    ok(c.length > 0, '缓存是空的');
    ok(!c.some(m => m._st || /断网时发的/.test(m.body)), '发送失败的消息被存进了缓存');
  } finally { env.close(); }
});

test('图片：先显示小图；小图失败换原图；多次失败先说“网络不好”，服务器确认没了才说“已被清理”；网络恢复自动重试', async () => {
  const t = Date.now(); let head = 400;
  const db = baseDb(t, { messages: [msg(1, 'bob', 'bob::me', IMG + '#w=800&h=600&t=1', t - 5000, 'image'), msg(2, 'bob', 'bob::me', IMG.replace('abcde', 'fghij') + '#w=800&h=600', t - 4000, 'image')] });
  const env = makeEnv({ db, before: w => { const of = w.fetch; w.fetch = async (u, o) => (o && o.method === 'HEAD') ? { ok: head < 400, status: head } : of(u, o); } });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(500);
    const im = id => msgEl(env, id).querySelector('.bubble.img img'), failTxt = id => { const f = msgEl(env, id).querySelector('.imgfail'); return f ? f.textContent : ''; };
    const err = el => el.dispatchEvent(new env.w.Event('error'));
    ok(/\.jpg\.t$/.test(im(uid(1)).getAttribute('src')), '带小图的消息没先显示小图');
    err(im(uid(1))); await sleep(50);
    ok(/abcde\.jpg$/.test(im(uid(1)).getAttribute('src')), '小图失败后没换原图');
    for (let i = 0; i < 4; i++) { err(im(uid(1))); await sleep(i < 3 ? [1300, 3600, 8100][i] : 300); }
    ok(/已被清理/.test(failTxt(uid(1))), '服务器确认文件没了，却没显示“已被清理”：' + failTxt(uid(1)));
    head = 0;
    for (let i = 0; i < 4; i++) { err(im(uid(2))); await sleep(i < 3 ? [1300, 3600, 8100][i] : 300); }
    ok(/网络不好/.test(failTxt(uid(2))), '网络不好时显示的不是“网络不好”：' + failTxt(uid(2)));
    env.w.dispatchEvent(new env.w.Event('online')); await sleep(200);
    ok(im(uid(2)), '网络恢复后没有自动重新加载');
    ok(/已被清理/.test(failTxt(uid(1))), '确认被删的图片网络恢复后又去加载了');
  } finally { env.close(); }
}, true);

// ---------------- 登录 / 设备 / 通话 / 键盘 ----------------
test('登录：网络失败自动重试（第 3 次成功）；密码错不重试', async () => {
  const env = makeEnv({ db: { profiles: [prof(ME, '我')] }, before: w => { try { w.localStorage.clear(); } catch (e) {} } });
  try {
    await env.T.getReady(); await sleep(200);
    let n = 0;
    env.T.sb.auth.signInWithPassword = async () => { n++; return n < 3 ? { data: null, error: Object.assign(new Error('Failed to fetch'), { status: 0, name: 'AuthRetryableFetchError' }) } : { data: { session: {} }, error: null }; };
    env.$('login-acc').value = 'me'; env.$('login-pass').value = '123456';
    env.$('login-form').dispatchEvent(new env.w.Event('submit', { cancelable: true })); await sleep(4000);
    ok(n === 3, '网络失败时尝试了 ' + n + ' 次（应为 3）');
    n = 0;
    env.T.sb.auth.signInWithPassword = async () => { n++; return { data: null, error: Object.assign(new Error('Invalid login credentials'), { status: 400 }) }; };
    env.$('login-form').dispatchEvent(new env.w.Event('submit', { cancelable: true })); await sleep(800);
    ok(n === 2, '密码错时尝试了 ' + n + ' 次（两个邮箱各一次，应为 2）');
    ok(/错误/.test(env.$('auth-msg').textContent), '密码错没提示：' + env.$('auth-msg').textContent);
  } finally { env.close(); }
});

test('登录设备：菜单能打开', async () => {
  const env = makeEnv({ db: { profiles: [prof(ME, '我')], friendships: [], conversations: [], user_devices: [{ account: ME, device_id: 'dabc', ua: 'iPhone', last_at: iso(Date.now()) }] } });
  try {
    await env.login(); await sleep(300); env.toasts.length = 0;
    click(env, env.$('btn-devices')); await sleep(300);
    ok(env.$('act-sheet').classList.contains('active'), '“登录设备”菜单没打开：' + JSON.stringify(env.toasts));
  } finally { env.close(); }
});

test('来电：弹出来电界面；点拒绝后关闭', async () => {
  const env = makeEnv({ db: baseDb(Date.now()) });
  try {
    await env.login(); await sleep(300);
    env.T.onSig({ t: 'invite', from: 'bob', id: 'call-1', sq: 1, video: false, sdp: { type: 'offer', sdp: 'v=0\r\n' } }); await sleep(300);
    ok(env.T.S.incoming && env.T.S.incoming.id === 'call-1', '来电没记下来');
    ok(env.$('incoming-ui').classList.contains('active'), '来电界面没弹出');
    click(env, env.$('btn-decline')); await sleep(200);
    ok(!env.T.S.incoming && !env.$('incoming-ui').classList.contains('active'), '拒绝后来电界面还在');
  } finally { env.close(); }
});

test('半屏：键盘开着时切出去再回来、或者 iPhone 没通知就收起键盘，页面都恢复整屏', async () => {
  const vv = { height: 844, offsetTop: 0, _l: {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }, fire(t) { (this._l[t] || []).forEach(f => f()); } };
  const env = makeEnv({ db: baseDb(Date.now()), before: w => { w.visualViewport = vv; Object.defineProperty(w, 'innerHeight', { value: 844, configurable: true }); } });
  try {
    await env.login(); await sleep(80); await env.T.openConv('bob::me', 'bob'); await sleep(100);
    const root = env.w.document.documentElement, kb = () => env.w.document.body.classList.contains('kb');
    const full = () => !/^4/.test(root.style.getPropertyValue('--vvh')) && (root.style.getPropertyValue('--vvt') === '0px' || !root.style.getPropertyValue('--vvt')) && !kb();
    env.$('chat-input').focus(); vv.height = 462; vv.offsetTop = 47; vv.fire('resize'); await sleep(50);
    ok(kb(), '键盘弹出时页面不知道');
    env.w.dispatchEvent(new env.w.Event('pageshow')); await sleep(1300);
    ok(full(), '切出去再回来没恢复整屏：' + root.style.getPropertyValue('--vvh'));
    env.$('chat-input').focus(); vv.fire('resize'); env.$('chat-input').blur(); await sleep(1000);
    ok(full(), '收起键盘（iPhone 没通知）后没恢复整屏：' + root.style.getPropertyValue('--vvh'));
  } finally { env.close(); }
});

// ---------------- 代码检查 ----------------
async function lint() {
  const { ESLint } = require('eslint');
  const globals = require('globals');
  const eslint = new ESLint({
    cwd: ROOT, overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: Object.assign({}, globals.browser, globals.serviceworker) },
      rules: {
        'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-unreachable': 'error',
        'no-func-assign': 'error', 'no-const-assign': 'error', 'no-self-assign': 'error', 'no-dupe-else-if': 'error', 'no-duplicate-case': 'error',
        'no-unsafe-negation': 'error', 'use-isnan': 'error', 'valid-typeof': 'error', 'no-unsafe-finally': 'error', 'getter-return': 'error',
        'no-setter-return': 'error', 'no-global-assign': 'error', 'no-loss-of-precision': 'error', 'no-constant-binary-expression': 'error'
      }
    }]
  });
  const res = await eslint.lintFiles(['app.js', 'sw.js']);
  const errs = [];
  res.forEach(r => r.messages.forEach(m => { if (m.severity === 2) errs.push(path.basename(r.filePath) + ' 第 ' + m.line + ' 行：' + m.message); }));
  return errs;
}

(async () => {
  let bad = 0;
  const t0 = Date.now();
  process.stdout.write('代码检查（app.js、sw.js）… ');
  try { const errs = await lint(); if (errs.length) { bad++; console.log('❌'); errs.slice(0, 30).forEach(e => console.log('   ' + e)); } else console.log('✅'); }
  catch (e) { bad++; console.log('❌ 代码检查没跑起来：' + e.message); }
  for (const tc of tests) {
    if (QUICK && tc.slow) { console.log('⏭  ' + tc.name + '（--quick 跳过）'); continue; }
    const s = Date.now();
    try { await tc.fn(); console.log('✅ ' + tc.name + '（' + ((Date.now() - s) / 1000).toFixed(1) + ' 秒）'); }
    catch (e) { bad++; console.log('❌ ' + tc.name + '\n   → ' + (e && e.message || e)); }
  }
  console.log('\n' + (bad ? '❌ 有 ' + bad + ' 项没通过，先别推送。' : '✅ 全部通过。') + ' 用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  process.exit(bad ? 1 : 0);
})();
