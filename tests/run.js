// Chatter 自动检查：① 代码检查（拼错变量名之类的低级错误）② 用假手机把 App 跑一遍关键场景。
// 用法：cd tests && npm install && npm test        （--quick 跳过几个要等十几秒的）
// 全部 ✅ 才推送；有 ❌ 先修。只在本机跑，不联网、不碰线上数据。
const path = require('path');
const { makeEnv, sleep, iso, prof, ME } = require('./harness');

const QUICK = process.argv.includes('--quick');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);   // 只跑名字里带这几个字的检查：node run.js --only=朋友圈
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

test('省请求：朋友圈“谁看过”每条只记一次（访客读不到自己那行，以前每次打开都重发、被拒 409）', async () => {
  const t = Date.now();
  const db = baseDb(t, { moments: [1, 2, 3].map(i => ({ id: 'm' + i, author_acc: 'bob', body: '动态' + i, images: [], created_at: iso(t - i * 60000) })),
    moment_views: [{ moment_id: 'm1', viewer_acc: 'me', created_at: iso(t - 3600000) }] });   // m1 在别的手机上已经记过
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300);
    click(env, env.w.document.querySelector('.app-nav button[data-tab="moments"]')); await sleep(800);
    const ins = () => env.log.filter(q => q.table === 'moment_views' && (q.op === 'insert' || q.op === 'upsert')).length;
    const sel = () => env.log.filter(q => q.table === 'moment_views' && q.op === 'select').length;
    ok(db.moment_views.filter(v => v.viewer_acc === 'me').length === 3, '三条动态没都记上“我看过”：' + JSON.stringify(db.moment_views));
    const n1 = ins();
    ok(n1 === 3 && sel() === 0, '第一次打开：应该对三条各记一次、不先查（查了也是空的）：记 ' + n1 + ' 次、查 ' + sel() + ' 次');
    await env.T.pullRefresh(); await sleep(800);
    ok(ins() === n1, '刷新朋友圈又重发了“我看过”：' + (ins() - n1) + ' 次');
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
test('附件管理：识别新旧文件、保护表情和待发送文件，只删除确认的范围', async () => {
  const t = Date.now(), old = t - 31 * 86400000;
  const db = baseDb(t, { stickers: [] });
  const records = [
    [`${old}_abcde.jpg`, old], [`${old}_abcde.jpg.t`, old],
    [`${uid(2)}.mp4`, old], [`${uid(2)}.mp4.jpg`, old],
    [`${uid(3)}.jpg`, old], [`${uid(3)}.jpg.t`, old],
    [`${uid(4)}.wav`, old], [`${uid(5)}.jpg`, t], [`${uid(7)}.png`, old], [`${uid(7)}.png.t`, t],
    [`${uid(6)}.png`, old], ['avatar_123.jpg', old], ['gf_group.pdf', old], ['moment_123.png', old]
  ];
  const files = records.map(([name, time]) => ({ id: name, name, created_at: iso(time), metadata: { size: 1024 } }));
  const base = IMG.replace(/bob\/[^/]+$/, 'me/');
  db.stickers.push({ owner_acc: ME, url: base + uid(3) + '.jpg#t=1' });
  const env = makeEnv({ db, files });
  try {
    await env.login();
    env.T.S.out.set(uid(4), { id: uid(4), from_acc: ME, _ext: 'wav', _st: 'failed' });
    env.$('btn-store').click(); await sleep(40);
    ok(env.$('st-30').textContent.includes('（5）'), '新旧附件和预览图未按同一口径列出');
    env.$('st-30').click();
    ok(env.$('as-title').textContent.includes('双方') && env.$('as-title').textContent.includes('无法撤销'), '确认前未说明影响双方和不可撤销');
    env.$('as-items').querySelector('[data-i="0"]').click();
    ok(env.storage.removed.length === 0, '点取消也删除了文件');
    env.$('st-30').click();
    db.stickers.push({ owner_acc: ME, url: base + uid(6) + '.png' });
    env.$('as-items').querySelector('[data-i="1"]').click(); await sleep(60);
    const expected = records.slice(0, 4).map(([name]) => ME + '/' + name).sort();
    ok(env.storage.removed.slice().sort().join() === expected.join(), '删除范围越过了确认清单或漏掉附件');
    ok(env.toasts.some(s => /已删除 4 个.*跳过 1 个/.test(s)), '未通知重新检查时被保护的文件');
  } finally { env.close(); }
});

test('附件管理：部分删除没有确认时报告实际数量，退出登录后不再发送下一批', async () => {
  const old = Date.now() - 86400000 * 31;
  const files = Array.from({ length: 52 }, (_, i) => ({ id: uid(i), name: uid(i) + '.png', created_at: iso(old) }));
  let firstBatch = true, deferRemoval = false, finishRemoval;
  const env = makeEnv({ db: baseDb(old), files, onStorageRemove(keys, storage) {
    if (deferRemoval) return new Promise(resolve => { finishRemoval = resolve; });
    if (!firstBatch) return;
    firstBatch = false;
    const deleted = keys.slice(0, 49);
    storage.files = storage.files.filter(file => !deleted.includes(ME + '/' + file.name));
    return { data: deleted.map(name => ({ name })), error: null };
  } });
  try {
    await env.login();
    env.$('btn-store').click(); await sleep(30);
    env.$('st-all').click(); env.$('as-items').querySelector('[data-i="1"]').click(); await sleep(50);
    ok(env.storage.removed.length === 52 && env.storage.files.length === 1, '没有按确认清单处理全部批次');
    ok(env.toasts.some(s => /已删除 51 个.*1 个未确认/.test(s)), '部分成功显示成全成功');
    ok(env.$('st-all').textContent.includes('（1）'), '删除后没有刷新仍存在的附件');

    env.storage.files = files.slice();
    env.$('btn-store').click(); env.$('btn-store').click(); await sleep(30);
    deferRemoval = true;
    env.$('st-all').click(); env.$('as-items').querySelector('[data-i="1"]').click(); await sleep(30);
    ok(typeof finishRemoval === 'function' && env.storage.removed.length === 102, '第一批尚未提交');
    await env.T.onAuth('SIGNED_OUT', null);
    finishRemoval({ data: [], error: null }); await sleep(30);
    ok(env.storage.removed.length === 102 && env.$('store-box').style.display === 'none', '退出登录后仍在删附件或显示旧列表');
  } finally { env.close(); }
});

test('附件管理：关闭后重开，迟到的旧列表不能覆盖正在看的清单', async () => {
  const t = Date.now();
  let calls = 0, finishOld;
  const env = makeEnv({ db: baseDb(t), onStorageList() {
    if (++calls === 1) return new Promise(resolve => { finishOld = resolve; });
    return { data: [{ id: uid(2), name: uid(2) + '.jpg', created_at: iso(t) }], error: null };
  } });
  try {
    await env.login();
    env.$('btn-store').click(); await sleep(30);
    ok(typeof finishOld === 'function', '没有发出第一次请求');
    env.$('btn-store').click(); env.$('btn-store').click(); await sleep(30);
    finishOld({ data: [], error: null }); await sleep(30);
    ok(env.$('st-all').textContent.includes('（1）') && !env.$('st-all').disabled, '旧结果清空了当前清单');
  } finally { env.close(); }
});

test('本机缓存：清除当前账号的旧格式和 IndexedDB 数据，保留其他账号与待发送队列', async () => {
  const t = Date.now(), env = makeEnv({ db: baseDb(t) });
  try {
    await env.login();
    const { S, MSG } = env.T;
    const conv = 'bob::me', oldConv = 'alice::me';
    const key = 'ch2m:' + S.uid + ':' + oldConv;
    const legacy = JSON.stringify([msg(99, ME, oldConv, '待清缓存', t)]);
    const otherKey = 'ch2m:' + uid(42) + ':' + conv;
    const outKey = 'ch2outq:' + S.uid;
    env.w.localStorage.setItem(key, legacy);
    env.w.localStorage.setItem(otherKey, legacy);
    env.w.localStorage.setItem(outKey, legacy);
    env.T.msgCacheSave(conv, [msg(98, ME, conv, '待清 IndexedDB', t)]);
    await sleep(20);
    await env.$('btn-cache').onclick();
    env.$('as-items').querySelector('button.menu-item:not(.plain)').click();
    await sleep(40);
    ok(env.w.localStorage.getItem(key) === null, '旧格式消息缓存未清掉');
    ok(env.w.localStorage.getItem(otherKey) === legacy && env.w.localStorage.getItem(outKey) === legacy, '其他账号缓存或待发送队列被误清');
    ok(!MSG.mem.size && (await env.T.msgCacheGet(conv)).length === 0, '仍能从 IndexedDB 找到清理的记录');
    ok(env.storage.removed.length === 0, '清本机缓存调用了服务器删除');
  } finally { env.close(); }
});

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

test('注册：直接注册不先查重；网络失败自动重试并说清哪一步；太频繁、重名都说中文；重名但密码对就直接登录', async () => {
  const env = makeEnv({ db: { profiles: [prof(ME, '我')] }, before: w => { try { w.localStorage.clear(); } catch (e) {} } });
  try {
    await env.T.getReady(); await sleep(200);
    const fill = () => { env.$('reg-acc').value = 'newbie'; env.$('reg-pass').value = '123456'; env.$('reg-name').value = '新人'; };
    const sub = async ms => { env.$('register-form').dispatchEvent(new env.w.Event('submit', { cancelable: true })); await sleep(ms); return env.$('auth-msg').textContent; };
    const net = () => ({ data: null, error: Object.assign(new Error('Failed to fetch'), { status: 0, name: 'AuthRetryableFetchError' }) });
    let n = 0, li = 0; env.rpcLog.length = 0;
    env.T.sb.auth.signUp = async () => { n++; return net(); };
    fill(); let m = await sub(4200);
    ok(n === 3, '网络失败时注册试了 ' + n + ' 次（应为 3）');
    ok(/注册这一步没连上/.test(m), '没说清是哪一步：' + m);
    ok(!env.rpcLog.some(x => x.name === 'account_exists'), '还在单独查重（网络差时多一次失败）');
    env.T.sb.auth.signUp = async () => ({ data: null, error: Object.assign(new Error('Request rate limit reached'), { status: 429 }) });
    m = await sub(500); ok(/太频繁/.test(m), '429 没翻成中文：' + m);
    env.T.sb.auth.signUp = async () => ({ data: null, error: Object.assign(new Error('User already registered'), { status: 422 }) });
    env.T.sb.auth.signInWithPassword = async () => { li++; return { data: null, error: Object.assign(new Error('Invalid login credentials'), { status: 400 }) }; };
    m = await sub(500); ok(/账号已存在/.test(m) && li === 1, '重名提示不对：' + m);
    env.T.sb.auth.signInWithPassword = async () => ({ data: { session: {} }, error: null });
    m = await sub(500); ok(m === '', '重名但密码对（上次其实注册成功了）没直接登录：' + m);
  } finally { env.close(); }
});

test('添加到桌面：iPhone Safari、安卓各家浏览器给出通用步骤（不画可能指错的箭头）；微信里先叫用浏览器打开；已是桌面应用不弹', async () => {
  const env = makeEnv({ db: baseDb(Date.now()) });
  try {
    await env.login(); await sleep(300);
    const set = ua => Object.defineProperty(env.w.navigator, 'userAgent', { value: ua, configurable: true });
    set('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1');
    await env.T.showA2HS(false); let d = env.$('a2hs');
    ok(d && /添加到主屏幕/.test(d.textContent) && /「···」/.test(d.textContent) && !d.querySelector('[class*=arrow]'), 'iOS Safari 指引不对：' + (d && d.textContent));
    d.querySelector('.a2hs-ok').click(); ok(!env.$('a2hs'), '点“知道了”没关掉');
    set('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    await env.T.showA2HS(false); d = env.$('a2hs'); ok(d && /分享按钮/.test(d.textContent), '旧版 Safari 指引不对'); d.remove();
    set('Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 VivoBrowser/20.1');
    await env.T.showA2HS(false); d = env.$('a2hs'); ok(d && /底部中间/.test(d.textContent) && /桌面快捷方式/.test(d.textContent), '安卓浏览器指引没说菜单可能在别处、没提权限'); d.remove();
    set('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003237) NetType/WIFI Language/zh_CN');
    await env.T.showA2HS(false); d = env.$('a2hs'); ok(d && /在 Safari 中打开/.test(d.textContent) && d.querySelector('.a2hs-copy'), '微信里没先叫用 Safari 打开'); d.remove();
    env.w.navigator.standalone = true; env.toasts.length = 0;
    await env.T.showA2HS(false); ok(!env.$('a2hs') && env.toasts.some(x => /已经是桌面应用/.test(x)), '已经是桌面应用还弹指引');
  } finally { env.close(); }
});

test('返回手势：浏览器里主页面垫一条守卫（滑了不离开网站、被吃掉马上补）；桌面图标打开的不垫；聊天里返回关聊天；“前进”重开刚才的聊天', async () => {
  const t = Date.now(), key = 'bob::me';
  let env = makeEnv({ db: baseDb(t) });
  try {
    await env.login(); await sleep(400);
    const H = env.w.history;
    ok(H.length === 2 && H.state && H.state.app, '浏览器里主页面没垫守卫：length=' + H.length + ' state=' + JSON.stringify(H.state));
    H.back(); await sleep(300);
    ok(H.state && H.state.app && !env.T.S.conv, '主页面滑退后守卫没补回来（会离开网站白屏）：' + JSON.stringify(H.state));
    await env.T.openConv(key, 'bob'); await sleep(300);
    ok(env.T.S.conv === key && H.state && H.state.chat, '打开聊天没加历史');
    H.back(); await sleep(300);
    ok(!env.T.S.conv && H.state && H.state.app, '聊天里返回没回到消息列表');
    H.forward(); await sleep(500);
    ok(env.T.S.conv === key, '“前进”没有重新打开刚才的聊天：' + env.T.S.conv);
    H.back(); await sleep(300);
    ok(!env.T.S.conv, '再返回关不掉聊天');
  } finally { env.close(); }
  env = makeEnv({ db: baseDb(t), before: w => { Object.defineProperty(w.navigator, 'standalone', { value: true, configurable: true }); } });
  try {
    await env.login(); await sleep(400);
    const H = env.w.history;
    ok(H.length === 1 && !(H.state && H.state.app), '桌面图标打开的还垫了守卫（iOS 会出现点不动的假页面）：length=' + H.length);
    await env.T.openConv(key, 'bob'); await sleep(300);
    H.back(); await sleep(300);
    ok(!env.T.S.conv, '桌面应用里聊天返回没关聊天');
  } finally { env.close(); }
});

test('网页搜索：点放大镜才下载；结果按规则排（营销号隐藏、置顶在前、干净的往前）；简洁阅读洗掉脚本；返回一层层退；在搜索里打开聊天先收起搜索', async () => {
  const fs = require('fs');
  const env = makeEnv({ db: baseDb(Date.now(), { app_config: [{ key: 'search', value: { farms: ['baijiahao.baidu.com'], clean: ['wikipedia.org'], direct: ['x.com'] } }], search_prefs: [] }) });
  try {
    await env.login(); await sleep(300);
    const w = env.w, H = w.history, calls = [], opened = [];
    const resp = (j, st) => ({ ok: (st || 200) < 300, status: st || 200, json: async () => j });
    w.open = u => { opened.push(u); return null; };
    w.fetch = async (u, o) => {
      u = String(u);
      if (u.indexOf('/functions/v1/chatter-search') > 0) {
        const b = JSON.parse(o.body); calls.push(b);
        ok(o.headers.Authorization === 'Bearer tok', '调用搜索没带登录凭证');
        if (b.op === 'usage') return resp({ ok: true, used: { exa: 5, tavily: 0 }, free: { exa: 2500, tavily: 1000 }, keys: { exa: true, tavily: true } });
        if (b.op === 'search') return resp({ ok: true, cached: false, left: 70, used: 6, src: b.src || 'exa', type: b.type, q: b.q, items: [{ t: '营销', u: 'https://baijiahao.baidu.com/s?id=1', s: '震惊' }, { t: '普通', u: 'https://a.example.com/1', s: 'x' }, { t: '置顶的', u: 'https://docs.pin.dev/x', s: 'y' }, { t: '维基', u: 'https://zh.wikipedia.org/wiki/x', s: 'z' }, { t: '推特', u: 'https://x.com/a/status/1' }], wiki: { t: '词条', s: '摘要', u: 'https://zh.m.wikipedia.org/wiki/x' }, rel: ['相关一'] });
        if (b.op === 'frame') return resp({ ok: true, frame: false, why: 'xfo', url: b.url });
        if (b.op === 'read') return resp({ ok: true, u: b.url, title: '文章标题', site: '示例', html: '<p onclick="alert(0)">正文<script>alert(1)</script><img src="https://img.example/a.jpg" onerror="alert(2)"><a href="javascript:alert(3)">坏</a><a href="https://b.example.com/2">好</a></p><iframe src="https://evil/"></iframe>', len: 900 });
      }
      return resp({ sent: 1 });
    };
    w.localStorage.setItem('ch2ws:' + env.T.S.uid, JSON.stringify({ pin: ['pin.dev'] }));   // 假服务器说所有网站都不让嵌：点结果会在 App 里显示取来的内容；能嵌的原网页在 search-ui.js 里用真浏览器测
    click(env, env.$('btn-web')); await sleep(50);
    const sc = Array.from(w.document.querySelectorAll('script')).find(x => /search\.js\?v=/.test(x.getAttribute('src') || ''));
    ok(sc && !w.ChatterSearch, '点放大镜没有去下载 search.js');
    w.eval(fs.readFileSync(path.join(ROOT, 'search.js'), 'utf8')); sc.onload(); await sleep(50);
    const ws = env.$('ws'), on = v => ws.querySelector('.ws-v.on') && ws.querySelector('.ws-v.on').dataset.v;
    ok(ws && ws.classList.contains('on') && on() === 'home' && H.state && H.state.ws === 1, '搜索首页没打开：' + on() + ' ' + JSON.stringify(H.state));
    const f = ws.querySelector('[data-form="home"]'); f.querySelector('input').value = '测试'; calls.length = 0;
    f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(120);
    ok(calls[0] && calls[0].op === 'search' && calls[0].q === '测试' && calls[0].type === 'web' && calls[0].src === '' && calls[0].tbs === '', '搜索请求不对：' + JSON.stringify(calls[0]));
    ok(on() === 'res' && H.state.ws === 2, '没有进入结果页');
    const titles = Array.from(ws.querySelectorAll('.ws-r a.t')).map(a => a.textContent);
    ok(titles.join(',') === '置顶的,维基,普通,推特', '排序不对（应该：置顶的、维基、普通、推特；营销号隐藏）：' + titles.join(','));
    ok(/隐藏了 1 条营销号/.test(ws.textContent) && ws.querySelector('.ws-kg') && /词条/.test(ws.querySelector('.ws-kg').textContent), '营销号提示或百科卡片没显示');
    const rows = Array.from(ws.querySelectorAll('.ws-r'));
    click(env, rows[3]); await sleep(80);
    ok(!opened.length && on() === 'read' && H.state.ws === 3 && /不让别的 App 显示它的原网页/.test(ws.querySelector('.ws-v.on').textContent) && ws.querySelector('[data-r="rorig"]').textContent === '在浏览器打开', '不让嵌的网站：不该自动跳出去，应该在 App 里显示取来的内容、右上角给“在浏览器打开”：' + on() + ' ' + opened[0]);
    click(env, ws.querySelector('.ws-v.on [data-r="rorig"]')); await sleep(20);
    ok(opened[0] === 'https://x.com/a/status/1', '点“在浏览器打开”没打开：' + opened[0]);
    H.back(); await sleep(120);
    ok(on() === 'res' && H.state.ws === 2, '从取来的内容那一层返回没回到结果页：' + on());
    click(env, ws.querySelectorAll('.ws-r')[2]); await sleep(150);   // 返回结果页时列表重画过：重新取
    const rd = calls.filter(x => x.op === 'read').pop();
    ok(on() === 'read' && H.state.ws === 3 && rd && rd.url === 'https://a.example.com/1', '点结果没在 App 里显示取来的内容');
    const body = ws.querySelector('.ws-body');
    ok(body && /正文/.test(body.textContent) && !/script|onclick|onerror|javascript:|iframe|alert/.test(body.innerHTML), '正文没洗干净：' + (body && body.innerHTML));
    ok(body.querySelector('img').getAttribute('referrerpolicy') === 'no-referrer', '文章图片没加 no-referrer（会被防盗链拦）');
    H.back(); await sleep(80);
    ok(on() === 'res' && ws.querySelectorAll('.ws-r').length === 4, '从阅读页返回没回到结果页');
    click(env, ws.querySelector('.ws-r .ws-more')); await sleep(30);
    const blockBtn = Array.from(env.$('as-items').querySelectorAll('button')).find(b => /^不看 /.test(b.textContent));
    ok(blockBtn, '“⋯”菜单里没有“不看这个网站”');
    click(env, blockBtn); await sleep(950);
    ok(!Array.from(ws.querySelectorAll('.ws-r a.t')).some(a => a.textContent === '置顶的'), '“不看”之后还显示');
    const pr = env.db.search_prefs.find(x => x.uid === env.T.S.uid);
    ok(pr && pr.prefs && pr.prefs.block.indexOf('docs.pin.dev') >= 0, '规则没存到账号里：' + JSON.stringify(env.db.search_prefs));
    H.back(); await sleep(80);
    ok(on() === 'home', '结果页返回没回到首页');
    ok(/测试/.test(ws.querySelector('[data-r="home"]').textContent), '首页没有“最近搜过”');
    H.back(); await sleep(80);
    ok(!ws.classList.contains('on') && H.state && H.state.app, '首页返回没关掉搜索：' + JSON.stringify(H.state));
    click(env, env.$('btn-web')); await sleep(50);
    ok(ws.classList.contains('on'), '第二次点放大镜没打开');
    await env.T.openConv('bob::me', 'bob'); await sleep(200);
    ok(!ws.classList.contains('on') && env.T.S.conv === 'bob::me', '在搜索里打开聊天，搜索没收起（聊天会被盖住）');
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

test('拒绝好友申请：失败保留申请，重复点击只发送一次，成功后移除', async () => {
  const request = { id: '1', from_acc: 'bob', to_acc: ME, status: 'pending' };
  const db = baseDb(Date.now(), { friend_requests: [request] });
  let resolve, failUpdate = true;
  const env = makeEnv({ db, onQuery: q => {
    if (q.table === 'friend_requests' && q.op === 'update' && failUpdate) {
      return new Promise(r => { resolve = r; });
    }
  } });
  try {
    await env.login(); env.T.S.requests = [request];
    const action = env.T.declineRequest('1');
    await env.T.declineRequest('1');
    ok(env.log.filter(q => q.table === 'friend_requests' && q.op === 'update').length === 1, '重复提交');
    resolve({ error: { message: '离线' } });
    await action;
    ok(env.T.S.requests.length === 1 && request.status === 'pending', '失败把申请藏掉了');
    failUpdate = false;
    await env.T.declineRequest('1');
    ok(env.T.S.requests.length === 0 && request.status === 'declined', '成功后状态没有一致');
  } finally { env.close(); }
});

test('好友搜索：输入改回原文时，迟到的同一查询结果不能覆盖最新结果', async () => {
  let resolveOld, old = true;
  const env = makeEnv({ db: baseDb(Date.now()), onQuery: q => {
    if (q.table !== 'profiles' || !q.or?.startsWith('account_id.ilike')) return;
    if (old) {
      old = false;
      return new Promise(r => { resolveOld = r; });
    }
    return { data: [prof('new', '新结果')], error: null };
  } });
  try {
    await env.login();
    env.$('search-input').value = 'bob';
    const first = env.T.runSearch('bob');
    await sleep(0);
    await env.T.runSearch('bob');
    resolveOld({ data: [prof('old', '旧结果')], error: null });
    await first;
    ok(env.$('search-results').textContent.includes('新结果') && !env.$('search-results').textContent.includes('旧结果'), '显示了迟到的数据');
  } finally { env.close(); }
});

test('历史分页：同一时间戳的 93 条消息跨多页，ID 完整且顺序稳定', async () => {
  const t = Date.now();
  const expected = Array.from({ length: 93 }, (_, i) => uid(i + 1));
  const db = baseDb(t, { messages: expected.map((id, i) => msg(i + 1, 'bob', 'bob::me', id, t)).reverse() });
  const env = makeEnv({ db });
  try {
    await env.login();
    await env.T.openConv('bob::me', 'bob');
    ok(env.T.S.msgs.length === 40, '首屏消息数错误');
    await env.T.loadOlder();
    await env.T.loadOlder();
    ok(env.T.S.msgs.map(m => m.id).join() === expected.join(), '分页漏掉消息或者顺序错乱');
    ok(!env.T.S.hasMore, '最后一页仍然显示可继续翻页');
  } finally { env.close(); }
});

test('快速关闭并重开同一聊天：旧请求、旧媒体预览不能覆盖或发送', async () => {
  const t = Date.now();
  let resolveOld, queries = 0;
  const db = baseDb(t, { messages: [msg(71, 'bob', 'bob::me', '当前聊天数据', t)] });
  const env = makeEnv({ db, onQuery: q => {
    if (q.table === 'messages' && q.limit === 40 && ++queries === 1) return new Promise(r => { resolveOld = r; });
  } });
  try {
    await env.login();
    const first = env.T.openConv('bob::me', 'bob');
    await sleep(0);
    const pending = env.T.sendFiles([
      new env.w.File(['x'], 'photo.png', { type: 'image/png' }),
      new env.w.File(['y'], 'doc.txt', { type: 'text/plain' })
    ]);
    ok(env.$('ipv-sheet').classList.contains('active'), '图片预览未打开');
    env.T.closeChat();
    await env.T.openConv('bob::me', 'bob');
    click(env, env.$('ipv-send'));
    resolveOld({ data: [msg(77, 'bob', 'bob::me', '过期请求', t)], error: null });
    await Promise.all([pending, first]);
    ok(env.T.S.msgs.map(m => m.id).join() === uid(71), '旧回包污染重开的聊天');
    ok(db.messages.length === 1 && !env.$('ipv-sheet').classList.contains('active'), '关闭后的附件仍然发出');
  } finally { env.close(); }
});

test('删除一条消息（仅自己）：删的是最后一句时，消息页不再显示它，改成上一句；撤销删除又回来；全删光就空着', async () => {
  const t = Date.now();
  const db = baseDb(t);
  serverInsert(db, msg(901, 'bob', 'bob::me', '第一句话', t - 9000));
  serverInsert(db, msg(902, ME, 'bob::me', '要删掉的那句', t - 3000));
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(300); await env.T.openConv('bob::me', 'bob'); await sleep(500);
    const pv = () => { const el = Array.from(env.$('conv-list').querySelectorAll('.conv-item')).find(e => e.dataset.key === 'bob::me'); return el ? el.querySelector('.preview').textContent : '(没有这个会话)'; };
    ok(/要删掉的那句/.test(pv()), '（准备）消息页预览是最后一句：' + pv());
    env.T.menuAct(uid(902), 'del'); await sleep(150);
    ok(!/要删掉的那句/.test(pv()) && /第一句话/.test(pv()), '删掉最后一句以后，消息页预览改成上一句：' + pv());
    const undo = env.w.document.querySelector('.toast-act button');
    ok(!!undo, '删除后有“撤销”'); click(env, undo); await sleep(150); ok(/要删掉的那句/.test(pv()), '撤销删除：预览又回来：' + pv());
    env.T.menuAct(uid(902), 'del'); await sleep(150);
    env.T.S.conv = null; env.T.S.msgs = []; env.T.msgCacheClear(); env.T.renderList();   // 像 App 刚重开：聊天记录还没读进来
    ok(!/要删掉的那句/.test(pv()) && /第一句话/.test(pv()), 'App 重开、聊天记录还没读进来时：也不显示删掉的那句：' + pv());
    const c0 = conv(env, 'bob::me'); c0.last_ts = iso(Date.now() + 5000); c0.last_body = '后来的新消息'; env.T.renderList();
    ok(/后来的新消息/.test(pv()), '之后对方发来新消息：预览照常显示新消息：' + pv());
    c0.last_ts = iso(t - 3000); c0.last_body = '要删掉的那句';
    await env.T.openConv('bob::me', 'bob'); await sleep(400);
    env.T.menuAct(uid(901), 'del'); await sleep(150);
    ok(!/要删掉的那句|第一句话/.test(pv()), '两句都删了：预览空着，不显示删掉的话：' + pv());
  } finally { env.close(); }
});

test('清空聊天记录：服务器上会话时间比最后一条消息晚一点，同步以后旧的那句话也不会再冒出来', async () => {
  const t = Date.now();
  const env = makeEnv({ db: baseDb(t) });
  try {
    await env.login(); await sleep(200);
    const shown = () => Array.from(env.$('conv-list').querySelectorAll('.conv-item')).some(e => e.dataset.key === 'bob::me');
    ok(shown(), '（准备）和 bob 的会话在消息列表里');
    env.T.clearConv('bob::me'); env.T.renderList();
    ok(!shown(), '清空以后会话从列表里拿掉');
    const c = conv(env, 'bob::me'); c.last_ts = iso(t - 200); c.last_body = '删除前的话';   // 服务器同步回来：时间比本机记的最后一条晚 0.8 秒（但仍在清空之前）
    env.T.renderList();
    ok(!shown() && !/删除前的话/.test(env.$('conv-list').textContent), '同步以后旧的那句话没有回来');
    c.last_ts = iso(Date.now() + 5000); c.last_body = '清空以后的新消息'; env.T.renderList();
    ok(shown() && /清空以后的新消息/.test(env.$('conv-list').textContent), '清空以后对方发来的新消息照常出现');
  } finally { env.close(); }
});

test('发送结果丢失：同一 ID 重试读取已提交的行，只出现一条消息', async () => {
  const t = Date.now();
  let loseResponse = true;
  const db = baseDb(t);
  const env = makeEnv({ db, onQuery: (q, d) => {
    if (q.table !== 'messages' || q.op !== 'insert' || !loseResponse) return;
    loseResponse = false;
    d.messages.push({ ...q.rows, created_at: iso(t) });
    return { data: null, error: { message: 'Failed to fetch' } };
  } });
  try {
    await env.login(); await env.T.openConv('bob::me', 'bob');
    const m = env.T.newMsg('text', '已提交');
    env.T.addLocal(m);
    await sleep(30);
    ok(env.T.S.out.get(m.id)._st === 'failed', '丢失响应应进入重试队列');
    await env.T.deliver(m);
    const rows = env.T.S.msgs.filter(x => x.id === m.id);
    ok(rows.length === 1 && rows[0].created_at === iso(t) && !rows[0]._st, '没有恢复数据库中的发送结果');
    ok(db.messages.length === 1 && !env.T.S.out.has(m.id), '重复入库或待发队列未清理');
  } finally { env.close(); }
});

test('快速广播只按会话和发送人核验数据库，过期行不会盖掉撤回', async () => {
  const t = Date.now();
  const db = baseDb(t);
  const env = makeEnv({ db });
  try {
    await env.login(); await env.T.openConv('bob::me', 'bob');
    const hint = { id: uid(31), from: 'bob', to: ME, conv: 'bob::me', body: '广播内容' };
    await env.T.onFastMsg(hint);
    ok(!msgEl(env, uid(31)), '不存在于数据库的消息被展示');
    db.messages.push(msg(31, 'bob', 'bob::me', '服务器内容', t));
    await env.T.onFastMsg(hint);
    ok(msgEl(env, uid(31)).textContent.includes('服务器内容'), '展示了广播内容');
    await env.T.onFastRecall(hint);
    ok(env.T.S.msgs.find(m => m.id === hint.id).type === 'text', '数据库未撤回却显示撤回');
    db.messages[0] = { ...db.messages[0], type: 'recalled', body: '' };
    await env.T.onFastRecall(hint);
    env.rtFire('INSERT', 'messages', msg(31, 'bob', 'bob::me', '过期数据', t));
    ok(env.T.S.msgs.find(m => m.id === hint.id).type === 'recalled', '迟到的消息覆盖了撤回状态');
  } finally { env.close(); }
});

test('换账号：旧账号的查询回包不能渲染进新账号', async () => {
  let release, user = ME;
  const db = baseDb(Date.now(), { profiles: [prof(ME), prof('bob', 'Bob'), prof('other', '其他账户')] });
  const env = makeEnv({ db, onQuery: q => {
    if (q.table === 'profiles' && q.or?.startsWith('account_id.ilike')) return new Promise(r => { release = r; });
  }, onRpc: name => {
    if (name === 'bootstrap') return { data: { me: db.profiles.find(p => p.account_id === user),
      convs: [], friends: [], peers: [], requests: [] }, error: null };
  } });
  try {
    await env.login(); env.$('search-input').value = 'bob';
    const pending = env.T.runSearch('bob');
    await sleep(0);
    user = 'other';
    await env.T.onAuth('SIGNED_IN', { user: { id: 'u-other' }, access_token: 'test-another-token' });
    release({ data: [prof('old', '旧账号结果')], error: null });
    await pending;
    ok(env.T.S.me.account_id === 'other' && !env.T.S.profiles.old, '旧回包写入了新账号');
    ok(!env.$('search-results').textContent.includes('旧账号结果'), '串号后显示了旧账号结果');
  } finally { env.close(); }
});

test('动态点赞：数据库返回错误时恢复计数，可重新提交', async () => {
  let failLike = true;
  const env = makeEnv({ db: baseDb(Date.now()), onQuery: q => {
    if (q.table === 'moment_likes' && q.op === 'insert' && failLike) return { error: { message: '离线' } };
  } });
  try {
    await env.login();
    await env.T.toggleMomentLike('moment-1');
    ok(env.T.MO.likes['moment-1'].length === 0, '数据库错误后仍显示已点赞');
    failLike = false;
    await env.T.toggleMomentLike('moment-1');
    ok(env.T.MO.likes['moment-1'].includes(ME) && env.db.moment_likes.length === 1, '重试没有保存点赞');
  } finally { env.close(); }
});

test('应用页：底部菜单的“应用”是小组件 + 图标格子；点“音乐”才下载 music.js；请求并进通讯录（没有请求不占地方）；音乐请求直接发给 Audius', async () => {
  const fs = require('fs'), t = Date.now(), env = makeEnv({ db: baseDb(t) });
  try {
    await env.login(); await sleep(200);
    const w = env.w, H = w.history, d = w.document, calls = [];
    const resp = j => ({ ok: true, status: 200, json: async () => j });
    const TR = n => ({ id: 'tr' + n, title: '测试歌 ' + n, duration: 125 + n, permalink: '/u/song-' + n, access: { stream: true }, artwork: { '150x150': 'https://art.example/' + n + '/150.jpg', '480x480': 'https://art.example/' + n + '/480.jpg' }, user: { name: '歌手 ' + n, handle: 'u' + n } });
    w.fetch = async u => {
      u = String(u); calls.push(u);
      if (u === 'https://api.audius.co/') return resp({ data: ['https://api.audius.co'] });
      if (u.indexOf('https://api.audius.co/v1/tracks/trending') === 0) return resp({ data: [TR(1), TR(2), Object.assign(TR(3), { access: { stream: false } }), Object.assign(TR(4), { stream_conditions: { usdc_purchase: {} } })] });
      return resp({ sent: 1 });
    };
    const navs = Array.from(d.querySelectorAll('.app-nav button')).map(b => b.dataset.tab);
    ok(navs.join(',') === 'convs,contacts,apps,moments,me' && !env.$('btn-apps') && !env.$('tab-requests'), '底部菜单应该是：消息、通讯录、应用、朋友圈、我（“请求”不再单独占一页）：' + navs.join(','));
    // 请求：在通讯录顶上，没有请求时整块不显示；角标在“通讯录”上
    env.T.S.requests = []; env.T.renderRequests ? env.T.renderRequests() : null;
    ok(env.$('req-sec') && env.$('req-sec').hidden && env.$('req-sec').closest('#tab-contacts'), '没有好友请求时：通讯录里不显示“新的朋友”');
    env.T.S.requests = [{ id: 'r1', from_acc: 'zoe', from_name: '佐伊', to_acc: 'me', status: 'pending' }];
    if (env.T.renderRequests) env.T.renderRequests();
    const badge = env.$('req-badge');
    ok(!env.$('req-sec').hidden && /佐伊/.test(env.$('request-list').textContent) && badge && badge.closest('button').dataset.tab === 'contacts' && badge.style.display !== 'none' && badge.textContent === '1', '有好友请求时：通讯录顶上出现“新的朋友”，角标在“通讯录”上');
    env.T.S.requests = []; if (env.T.renderRequests) env.T.renderRequests();
    // 应用页
    click(env, d.querySelector('.app-nav button[data-tab="apps"]')); await sleep(30);
    const tab = env.$('tab-apps');
    ok(tab.classList.contains('active'), '点“应用”没打开应用页');
    const names = Array.from(tab.querySelectorAll('.ap-ic')).map(x => x.textContent.trim());
    ok(names.join(',') === '搜索,音乐,导航' && tab.querySelector('.apx.wide[data-app="search"]') && /听点什么/.test(tab.querySelector('[data-app="music"]').textContent) && !tab.querySelector('[data-app="last"]'), '应用页：搜索小组件（大）、音乐小组件、图标“搜索、音乐、导航”；没看过网页时不显示“接着看”：' + names.join(','));
    w.localStorage.setItem('ch2wsSeen:' + env.T.S.uid, JSON.stringify([{ u: 'https://news.example.com/a', t: '一篇新闻', m: 'web', c: 1 }, { u: 'https://news.example.com/b', t: '另一篇', m: 'web', c: 2 }, { u: 'https://wiki.example.org/x', t: '词条', m: 'read', c: 1 }]));
    click(env, d.querySelector('.app-nav button[data-tab="convs"]')); click(env, d.querySelector('.app-nav button[data-tab="apps"]')); await sleep(30);
    ok(/接着看[\s\S]*一篇新闻/.test(tab.querySelector('[data-app="last"]').textContent) && Array.from(tab.querySelectorAll('[data-app="site"]')).map(x => x.dataset.u).join(',') === 'https://news.example.com/,https://wiki.example.org/', '看过网页以后：“接着看”是上次看的那页，搜索小组件下面是常去的网站');
    ok(!Array.from(d.querySelectorAll('script')).some(x => /music\.js/.test(x.getAttribute('src') || '')), '还没点音乐就下载了 music.js');
    click(env, tab.querySelector('[data-app="music"]')); await sleep(30);
    const sc = Array.from(d.querySelectorAll('script')).find(x => /music\.js\?v=/.test(x.getAttribute('src') || ''));
    ok(sc && !w.ChatterMusic, '点音乐小组件没有去下载 music.js');
    w.eval(fs.readFileSync(path.join(ROOT, 'music.js'), 'utf8')); sc.onload(); await sleep(200);
    const mu = env.$('mu');
    ok(mu && mu.classList.contains('on') && H.state && H.state.mu === 1, '音乐首页没打开：' + JSON.stringify(H.state));
    const rows = Array.from(mu.querySelectorAll('.mu-row .mu-rt')).map(x => x.textContent);
    ok(rows.join(',') === '测试歌 1,测试歌 2', '热门列表不对（不能直接播的两首要去掉）：' + rows.join(','));
    ok(calls.some(u => /^https:\/\/api\.audius\.co\/v1\/tracks\/trending\?app_name=Chatter&time=week&limit=50$/.test(u)) && !calls.some(u => /functions\/v1/.test(u) && /audius/.test(u)), '热门应该直接问 Audius（带 app_name、本周、50 首）');
    H.back(); await sleep(150);
    ok(!mu.classList.contains('on') && tab.classList.contains('active'), '音乐首页返回：回到应用页');
    ok(d.querySelector('#app-view .app-nav') && !d.getElementById('mu-mini'), '没放过歌：不该出现迷你播放条');
  } finally { env.close(); }
});
test('主题：系统画的部分（键盘、输入框、网页框底色、状态栏）跟着“我”里的主题，不跟手机系统（手机深色、App 浅色时不再先黑一下）', async () => {
  const t = Date.now(), env = makeEnv({ db: baseDb(t) });
  try {
    await env.login(); await sleep(150);
    const d = env.w.document, cs = () => d.querySelector('meta[name="color-scheme"]').getAttribute('content'), tc = () => Array.from(d.querySelectorAll('meta[name="theme-color"]')).map(m => m.getAttribute('content')).join(',');
    if (!d.querySelector('meta[name="color-scheme"]')) {   // 测试页面没有 index.html 的 <head>：照着补上这三个标签
      d.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#f6f3ee" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12101c" media="(prefers-color-scheme: dark)"><meta name="color-scheme" content="light dark">');
    }
    const st = () => env.w.localStorage.getItem('ch2theme');
    const go = async want => { for (let i = 0; i < 4 && JSON.parse(st() || '"auto"') !== want; i++) { click(env, env.$('btn-theme')); await sleep(10); } };
    await go('light');
    ok(d.documentElement.getAttribute('data-theme') === 'light' && cs() === 'light' && tc() === '#f6f3ee,#f6f3ee', '选浅色：color-scheme、状态栏颜色都该是浅色：' + cs() + ' ' + tc());
    await go('dark');
    ok(d.documentElement.getAttribute('data-theme') === 'dark' && cs() === 'dark' && tc() === '#12101c,#12101c', '选深色：都该是深色：' + cs() + ' ' + tc());
    await go('auto');
    ok(!d.documentElement.hasAttribute('data-theme') && cs() === 'light dark' && tc() === '#f6f3ee,#12101c', '跟随系统：恢复成按系统：' + cs() + ' ' + tc());
    const html = require('fs').readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok(/html\[data-theme="light"\] \{\s*color-scheme: light;/.test(html) && /html\[data-theme="dark"\] \{\s*color-scheme: dark;/.test(html) && /meta\[name="color-scheme"\][\s\S]{0,80}setAttribute\('content', v\)/.test(html), 'index.html 开头没有先按 App 的主题定 color-scheme（重开时会先按系统画一帧）');
  } finally { env.close(); }
});
test('聊天里的网址：在 App 里打开（不跳到系统浏览器）；聊天图片、文件链接照旧', async () => {
  const fs = require('fs'), t = Date.now(), db = baseDb(t);
  serverInsert(db, msg(1, 'bob', 'bob::me', '看看这个 https://news.example.com/a 不错', t - 500));
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(200); await env.T.openConv('bob::me', 'bob'); await sleep(300);
    const w = env.w, opened = [], calls = [];
    w.open = u => { opened.push(u); return null; };
    w.fetch = async (u, o) => { if (String(u).indexOf('/functions/v1/chatter-search') > 0) { const b = JSON.parse(o.body); calls.push(b); return { ok: true, status: 200, json: async () => b.op === 'frame' ? { ok: true, frame: true, why: '', url: b.url } : { ok: true } }; } return { ok: true, status: 200, json: async () => ({}) }; };
    const a = env.$('chat-messages').querySelector('a[href="https://news.example.com/a"]');
    ok(a, '聊天里的网址没变成链接');
    const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(ev);
    ok(ev.defaultPrevented && !opened.length, '点聊天里的网址还是跳到了系统浏览器');
    const sc = Array.from(w.document.querySelectorAll('script')).find(x => /search\.js\?v=/.test(x.getAttribute('src') || ''));
    ok(sc, '没有去下载网页浏览（search.js）');
    w.eval(fs.readFileSync(path.join(ROOT, 'search.js'), 'utf8')); sc.onload(); await sleep(120);
    const ws = env.$('ws'), on = ws && ws.querySelector('.ws-v.on');
    ok(on && on.dataset.v === 'web' && calls.some(b => b.op === 'frame' && b.url === 'https://news.example.com/a'), '没在 App 里打开这个网址：' + (on && on.dataset.v));
    ok(ws.querySelector('[data-r="wbox"] iframe') && ws.querySelector('[data-r="wbox"] iframe').getAttribute('src') === 'https://news.example.com/a', '原网页没嵌进来');
    // 再点一次：search.js 已经下载过，直接打开
    w.ChatterSearch.closeNow();
    const ev2 = new w.MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(ev2); await sleep(80);
    ok(ev2.defaultPrevented && ws.classList.contains('on'), '第二次点没在 App 里打开');
    w.ChatterSearch.closeNow();
    // 自己存储里的图片链接（大图）不拦
    const img = w.document.createElement('a'); img.href = 'https://uaoiqbxptnbrvkzjwguc.supabase.co/storage/v1/object/public/chat-media/bob/x.jpg'; img.textContent = 'x';
    env.$('chat-messages').appendChild(img);
    const ev3 = new w.MouseEvent('click', { bubbles: true, cancelable: true }); img.dispatchEvent(ev3);
    ok(!ev3.defaultPrevented, '聊天图片、文件的链接不该被拦');
  } finally { env.close(); }
});

test('图片画质：默认发原图，聊天预览跟随画质设置，关闭发送前编辑后直接发送', async () => {
  const db = baseDb(Date.now());
  const env = makeEnv({ db });
  try {
    await env.login(); await sleep(200);
    const q = env.$('btn-imgq'), ed = env.$('btn-imgedit');
    const sheet = env.$('ipv-sheet'), orig = env.$('ipv-orig');
    const photo = new env.w.File(['图片'], 'photo.png', { type: 'image/png' });
    ok(q && ed, '设置里没有“图片”或“发送前编辑”按钮');
    ok(q.textContent === '🖼 图片：原图', '默认应该是原图：' + q.textContent);
    ok(ed.textContent === '✂️ 发送前编辑：开', '发送前编辑默认开：' + ed.textContent);
    await env.T.openConv('bob::me', 'bob');
    const originalPreview = env.T.sendFiles([photo]);
    ok(sheet.classList.contains('active') && orig.classList.contains('on'), '聊天图片预览默认应选中原图');
    click(env, env.$('ipv-cancel'));
    await originalPreview;
    click(env, q); await sleep(20);
    ok(q.textContent === '🖼 图片：压缩' && env.w.localStorage.getItem('ch2imgq') === '"auto"', '点一下应该改成压缩：' + q.textContent + ' ' + env.w.localStorage.getItem('ch2imgq'));
    const compressedPreview = env.T.sendFiles([photo]);
    ok(sheet.classList.contains('active') && !orig.classList.contains('on'), '预览应该跟随压缩设置');
    click(env, orig);
    ok(orig.classList.contains('on'), '应允许单张切回原图');
    click(env, env.$('ipv-cancel'));
    await compressedPreview;
    click(env, q); await sleep(20);
    ok(q.textContent === '🖼 图片：原图', '再点改回原图');
    click(env, ed);
    const directSend = env.T.sendFiles([photo]);
    ok(ed.textContent === '✂️ 发送前编辑：关' && !sheet.classList.contains('active'), '关闭编辑后不应再打开预览');
    await directSend;
    ok(db.messages.length === 1 && db.messages[0].type === 'image', '关闭编辑后应该直接发出图片');
  } finally { env.close(); }
});

test('朋友圈权限：四种可见范围、发出去再改、不看对方、不让对方看、转发前问服务器', async () => {
  const t = Date.now();
  const db = baseDb(t, {
    profiles: [prof(ME, '我'), prof('bob', 'Bob'), prof('carol', 'Carol')],
    friendships: [{ owner_acc: ME, friend_acc: 'bob', hide_moments: false, skip_moments: false }, { owner_acc: ME, friend_acc: 'carol', hide_moments: false, skip_moments: true }],
    moments: [
      { id: 'm-bob', author_acc: 'bob', body: 'bob 的', images: [], visibility: 'friends', created_at: iso(t - 1000), visible_to: null },
      { id: 'm-carol', author_acc: 'carol', body: 'carol 的', images: [], visibility: 'friends', created_at: iso(t - 2000), visible_to: null },
      { id: 'm-me', author_acc: ME, body: '我的', images: [], visibility: 'friends', created_at: iso(t - 3000), visible_to: null }
    ],
    moment_audience: [{ moment_id: 'm-me', only_accs: null, hide_accs: ['bob'] }]
  });
  const rpcs = [];
  const env = makeEnv({ db, onRpc: (name, args, d) => {
    if (name === 'chatter_schema') return { data: 8, error: null };
    if (name === 'moment_is_open') { rpcs.push(name); return { data: args.p_moment !== 'm-bob', error: null }; }
    if (name === 'set_moment_perm') {
      rpcs.push(name);
      const f = d.friendships.find(x => x.owner_acc === ME && x.friend_acc === args.p_friend);
      if (!f) return { data: null, error: { message: 'not friends' } };
      if (args.p_hide !== null) f.hide_moments = args.p_hide;
      if (args.p_skip !== null) f.skip_moments = args.p_skip;
      return { data: { hide: f.hide_moments, skip: f.skip_moments }, error: null };
    }
  } });
  try {
    await env.login(); await sleep(200);
    env.T.S.v7 = true; await env.T.loadRemarks();
    ok(env.T.S.v9 === true && env.T.S.mperm.carol && env.T.S.mperm.carol.s === true, '没读到好友的朋友圈权限', env.T.S.mperm);
    await env.T.momentsLoad(true);
    const shown = env.T.MO.list.map(m => m.id);
    ok(shown.indexOf('m-carol') < 0 && shown.indexOf('m-bob') >= 0, '“不看 carol”还显示了她的动态', shown);
    const meCard = env.$('moment-list').querySelector('.moment[data-id="m-me"] .mo-vis');
    ok(meCard && /不给 1 位好友看/.test(meCard.textContent), '自己的动态没显示“不给 1 位好友看”', meCard && meCard.textContent);
    ok(!env.$('moment-list').querySelector('.moment[data-id="m-bob"] .mo-vis'), '别人的动态不该显示可见范围');

    // 发表：不给谁看
    env.T.openMomentCompose();
    env.$('moment-text').value = '只是不给 bob 看';
    env.T.openVisPicker();
    ok(env.$('vis-list').style.display === 'none', '“公开”时不该列好友');
    env.$('vis-modes').querySelector('[data-mode="except"]').click();
    ok(env.$('vis-list').style.display === '' && env.$('vis-list').querySelectorAll('input').length === 2, '“不给谁看”没列出好友');
    await env.T.applyVis();
    ok(env.toasts.some(x => /勾选不给看的好友/.test(x)), '一个都没勾就确定，应该提示');
    const box = env.$('vis-list').querySelector('input[data-acc="bob"]'); box.checked = true; box.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    await env.T.applyVis();
    ok(/不给谁看：1 位好友/.test(env.$('moment-vis').textContent), '发表页的按钮没写“不给谁看：1 位好友”', env.$('moment-vis').textContent);
    await env.T.postMoment(); await sleep(50);
    const ins = env.db.moments.find(m => m.body === '只是不给 bob 看');
    ok(ins && Array.isArray(ins.hidden_from) && ins.hidden_from.join() === 'bob' && ins.visible_to == null && ins.visibility === 'friends', '发表时没把“不给 bob 看”交给数据库', ins);
    ok(env.T.momentVisText(ins) === '不给 1 位好友看', '刚发的动态标签不对', env.T.momentVisText(ins));

    // 发表：私密（原来的“仅自己可见”开关合进来了）
    env.T.openMomentCompose();
    env.$('moment-text').value = '私密的';
    env.T.openVisPicker(); env.$('vis-modes').querySelector('[data-mode="priv"]').click(); await env.T.applyVis();
    await env.T.postMoment(); await sleep(50);
    const pv = env.db.moments.find(m => m.body === '私密的');
    ok(pv && pv.visibility === 'private' && !pv.hidden_from && !pv.visible_to, '私密没发对', pv);
    ok(!env.$('moment-priv'), '旧的“仅自己可见”开关应该去掉了（合进了“谁可以看”）');

    // 发出去以后改成“部分可见”
    const mine = env.T.MO.list.find(m => m.id === 'm-me');
    env.T.openVisPicker(mine);
    ok(env.$('vis-title').textContent === '修改可见范围' && env.$('vis-modes').querySelector('[data-mode="except"]').classList.contains('on'), '改的时候没选中现在的范围');
    env.$('vis-modes').querySelector('[data-mode="only"]').click();
    const c2 = env.$('vis-list').querySelector('input[data-acc="carol"]'); c2.checked = true; c2.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    await env.T.applyVis(); await sleep(20);
    const upd = env.log.filter(q => q.table === 'moments' && q.op === 'update').pop();   // 假数据库返回的是同一个对象，看发给数据库的内容
    const row = (upd && upd.values) || {};
    ok(Array.isArray(row.visible_to) && row.visible_to.join() === 'carol' && 'hidden_from' in row && row.hidden_from === null && row.visibility === 'friends', '改可见范围时没把两个名单一起交给数据库（另一个要清空）');
    ok(/仅 1 位好友可见/.test(env.$('moment-list').querySelector('.moment[data-id="m-me"] .mo-vis').textContent), '改完卡片上的标签没更新');

    // 转发别人的：先问服务器
    env.$('moment-list').querySelector('.moment[data-id="m-bob"] .mo-fwd').click(); await sleep(30);
    ok(rpcs.includes('moment_is_open') && env.toasts.some(x => /作者设了可见范围，不能转发/.test(x)), '设了范围的别人的动态不该能转发');

    // 好友资料页：朋友圈权限
    env.T.openProfile('bob'); await sleep(20);
    ok(env.$('pf-mperm').style.display === '' && env.$('pf-mperm').textContent === '朋友圈权限', '好友资料页没有“朋友圈权限”');
    env.T.openMomentPerm('bob');
    env.$('as-items').querySelector('button[data-i="0"]').click(); await sleep(30);
    ok(env.db.friendships.find(f => f.friend_acc === 'bob').hide_moments === true && env.T.S.mperm.bob.h === true, '“不让对方看”没存上');
    ok(/不让对方看/.test(env.$('pf-mperm').textContent), '资料页没显示已设的权限', env.$('pf-mperm').textContent);
    env.T.openMomentPerm('carol');
    env.$('as-items').querySelector('button[data-i="1"]').click(); await sleep(80);
    ok(!env.T.S.mperm.carol && env.T.MO.list.some(m => m.id === 'm-carol'), '取消“不看 carol”后她的动态没回来', env.T.MO.list.map(m => m.id));
    env.T.openProfile('nobody'); await sleep(10);
    ok(env.$('pf-mperm').style.display === 'none', '不是好友不该显示朋友圈权限');
  } finally { env.close(); }
});

test('朋友圈权限：数据库还没更新时，旧功能照常，“不给谁看”不发（不会悄悄发给所有人）', async () => {
  const t = Date.now();
  const db = baseDb(t, { moments: [] });
  const env = makeEnv({ db, onQuery: q => {
    if (q.table === 'friendships' && q.op === 'select' && /hide_moments/.test(q.cols || '')) return { data: null, error: { message: 'column friendships.hide_moments does not exist' } };
    if (q.table === 'moments' && (q.op === 'insert' || q.op === 'update') && JSON.stringify(q.rows || q.values || {}).indexOf('hidden_from') >= 0) return { data: null, error: { message: "Could not find the 'hidden_from' column of 'moments'" } };
    if (q.table === 'moment_audience') return { data: null, error: { message: 'relation "public.moment_audience" does not exist' } };
  }, onRpc: name => { if (name === 'chatter_schema') return { data: 8, error: null }; if (name === 'set_moment_perm') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }; } });
  try {
    await env.login(); await sleep(200);
    env.T.S.v7 = true; await env.T.loadRemarks();
    ok(env.T.S.v9 === false, '没认出数据库还没更新');
    env.T.openMomentCompose(); env.$('moment-text').value = '部分可见';
    env.T.openVisPicker(); env.$('vis-modes').querySelector('[data-mode="only"]').click();
    const b = env.$('vis-list').querySelector('input[data-acc="bob"]'); b.checked = true; b.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    await env.T.applyVis(); await env.T.postMoment(); await sleep(50);
    const m = env.db.moments.find(x => x.body === '部分可见');
    ok(m && m.visible_to.join() === 'bob' && !('hidden_from' in m), '数据库没更新时“部分可见”应该照旧能发', m);
    env.T.openMomentCompose(); env.$('moment-text').value = '不给看';
    env.T.openVisPicker(); env.$('vis-modes').querySelector('[data-mode="except"]').click();
    const b2 = env.$('vis-list').querySelector('input[data-acc="bob"]'); b2.checked = true; b2.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    await env.T.applyVis();
    ok(env.toasts.some(x => /不给谁看.*11-19 的数据库更新/.test(x)), '数据库没更新时选“不给谁看”应该说明原因');
    ok(env.$('vis-sheet').classList.contains('active') && /全部好友/.test(env.$('moment-vis').textContent), '没生效时选择框应该还开着、按钮仍写“全部好友”（不会让人以为已经排除了）');
    await env.T.momentsLoad(true);
    ok(env.T.MO.list.length === 1, '数据库没更新时朋友圈照常显示');
    env.T.openMomentPerm('bob'); env.$('as-items').querySelector('button[data-i="0"]').click(); await sleep(30);
    ok(env.toasts.some(x => /先运行 11-19 的数据库更新/.test(x)), '朋友圈权限没说明要先更新数据库');
  } finally { env.close(); }
});

test('退出登录会清除本账号的离线文章和浏览记录，保留另一账号', async () => {
  const env = makeEnv({ db: baseDb(Date.now()) });
  try {
    await env.login();
    const me = env.T.S.uid, other = 'other-account';
    const db = await new Promise((resolve, reject) => {
      const q = env.w.indexedDB.open('chatter-ws', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('art', {keyPath:'k'}).createIndex('tm','tm');
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
    try {
      const key = u => u + '||https://sample.test/article';
      await new Promise((resolve, reject) => {
        const tx = db.transaction('art','readwrite');
        for (const uid of [me,other]) {
          tx.objectStore('art').put({k:key(uid),uid,tm:1});
          for (const prefix of ['ch2wsSeen','ch2wsFrm','ch2wsTabs','ch2muNow','ch2muRecent','ch2muLike','ch2mute'])
            env.w.localStorage.setItem(prefix+':'+uid,'[]');
        }
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      await env.T.onAuth('SIGNED_OUT', null);
      const readKeys = () => new Promise(resolve => { const q=db.transaction('art').objectStore('art').getAllKeys(); q.onsuccess=() => resolve(q.result); });
      for (let attempt=0; attempt<25 && (await readKeys()).includes(key(me)); attempt++) await sleep(20);
      ok((await readKeys()).join() === key(other), '离线文章清理的账号范围错误');
      for (const prefix of ['ch2wsSeen','ch2wsFrm','ch2wsTabs','ch2muNow','ch2muRecent'])
        ok(env.w.localStorage.getItem(prefix+':'+me) === null && env.w.localStorage.getItem(prefix+':'+other) === '[]', prefix+' 清理的账号范围错误');
      for (const prefix of ['ch2muLike','ch2mute']) ok(env.w.localStorage.getItem(prefix+':'+me) === '[]', '应保留本账号的收藏和设置');
    } finally { db.close(); }
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
  const res = await eslint.lintFiles(['app.js', 'sw.js', 'search.js', 'music.js']);
  const errs = [];
  res.forEach(r => r.messages.forEach(m => { if (m.severity === 2) errs.push(path.basename(r.filePath) + ' 第 ' + m.line + ' 行：' + m.message); }));
  return errs;
}

(async () => {
  let bad = 0;
  const t0 = Date.now();
  process.stdout.write('代码检查（app.js、sw.js、search.js、music.js）… ');
  try { const errs = await lint(); if (errs.length) { bad++; console.log('❌'); errs.slice(0, 30).forEach(e => console.log('   ' + e)); } else console.log('✅'); }
  catch (e) { bad++; console.log('❌ 代码检查没跑起来：' + e.message); }
  for (const tc of tests) {
    if (ONLY && tc.name.indexOf(ONLY) < 0) continue;
    if (QUICK && tc.slow) { console.log('⏭  ' + tc.name + '（--quick 跳过）'); continue; }
    const s = Date.now();
    try { await tc.fn(); console.log('✅ ' + tc.name + '（' + ((Date.now() - s) / 1000).toFixed(1) + ' 秒）'); }
    catch (e) { bad++; console.log('❌ ' + tc.name + '\n   → ' + (e && e.message || e)); }
  }
  console.log('\n' + (bad ? '❌ 有 ' + bad + ' 项没通过，先别推送。' : '✅ 全部通过。') + ' 用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  process.exit(bad ? 1 : 0);
})();
