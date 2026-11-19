// 朋友圈权限 SQL（supabase/migrations/20261119150000_chatter_moment_privacy.sql）在内存 PostgreSQL 里试跑：
// 按线上现在的表和规则造一份假库，连跑两遍迁移（确认能重复执行），逐项检查谁能看什么，最后跑撤销脚本。
// 运行：npm i --no-save @electric-sql/pglite@0.2.17 && node sql-moment-privacy-test.mjs
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const FILE = '20261119150000_chatter_moment_privacy.sql';
const up = readFileSync(new URL('../supabase/migrations/' + FILE, import.meta.url), 'utf8');
const down = readFileSync(new URL('../supabase/rollback/' + FILE, import.meta.url), 'utf8');
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg, extra === undefined ? '' : JSON.stringify(extra)); } };
const U = { alice: 'a', bob: 'b', carol: 'c', dave: 'd', erin: 'e', frank: 'f' };
const uid = n => '00000000-0000-4000-8000-00000000000' + U[n];
async function as(name, fn) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid(name), role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rows = async (q, p) => (await db.query(q, p)).rows;
const ids = async (name, q) => as(name, async () => (await rows(q)).map(r => Object.values(r)[0]).sort());
const rejects = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub', '')::uuid $$;
    create table public.profiles (id uuid primary key, account_id text unique, nickname text);
    create function public.my_acc() returns text language sql stable security definer set search_path = public as $$
      select account_id from public.profiles where id = auth.uid() limit 1 $$;
    create table public.friendships (owner_acc text, friend_acc text, created_at timestamptz default now(), remark text, primary key (owner_acc, friend_acc));
    alter table public.friendships enable row level security;
    create policy fs_select on public.friendships for select to authenticated using (owner_acc = my_acc());
    create table public.moments (id uuid primary key default gen_random_uuid(), author_acc text, body text, images jsonb default '[]',
      visibility text default 'friends', created_at timestamptz default now(), visible_to text[], video text, cover text);
    alter table public.moments enable row level security;
    create policy moments_insert on public.moments for insert to authenticated with check (author_acc = my_acc());
    create policy moments_update on public.moments for update to authenticated using (author_acc = my_acc()) with check (author_acc = my_acc());
    create policy moments_delete on public.moments for delete to authenticated using (author_acc = my_acc());
    create policy moments_select on public.moments for select to public using ((author_acc = my_acc()) OR ((visibility = 'friends') AND (EXISTS (SELECT 1 FROM friendships f WHERE f.owner_acc = my_acc() AND f.friend_acc = moments.author_acc)) AND ((visible_to IS NULL) OR (my_acc() = ANY (visible_to)))));
    create function public.can_see_moment(p_moment uuid, p_acc text) returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.moments m where m.id = p_moment and (m.author_acc = p_acc or (m.visibility = 'friends'
        and exists (select 1 from public.friendships f where f.owner_acc = p_acc and f.friend_acc = m.author_acc)
        and (m.visible_to is null or p_acc = any(m.visible_to))))) $$;
    create table public.moment_comments (id uuid primary key default gen_random_uuid(), moment_id uuid references public.moments(id) on delete cascade,
      author_acc text, body text, created_at timestamptz default now(), parent_id uuid, reply_to_acc text);
    alter table public.moment_comments enable row level security;
    create policy moment_comments_select on public.moment_comments for select to authenticated using (can_see_moment(moment_id, my_acc()));
    create policy moment_comments_insert on public.moment_comments for insert to authenticated with check (author_acc = my_acc() and can_see_moment(moment_id, my_acc()));
    create table public.moment_likes (moment_id uuid references public.moments(id) on delete cascade, account_id text, created_at timestamptz default now(), primary key (moment_id, account_id));
    alter table public.moment_likes enable row level security;
    create policy moment_likes_select on public.moment_likes for select to authenticated using (can_see_moment(moment_id, my_acc()));
    create policy moment_likes_insert on public.moment_likes for insert to authenticated with check (account_id = my_acc() and can_see_moment(moment_id, my_acc()));
    grant select, insert, update, delete on public.friendships, public.moments, public.moment_comments, public.moment_likes, public.profiles to authenticated;
  `);
  for (const n of Object.keys(U)) await db.query('insert into public.profiles values ($1, $2, $2)', [uid(n), n]);
  const friends = [['alice', 'bob'], ['alice', 'carol'], ['alice', 'dave'], ['alice', 'erin'], ['bob', 'dave']];
  for (const [x, y] of friends) await db.query('insert into public.friendships (owner_acc, friend_acc) values ($1, $2), ($2, $1)', [x, y]);
  // 迁移前已有一条“部分可见”（旧版 App 写在 visible_to 里）
  const legacy = (await rows("insert into public.moments (author_acc, body, visible_to) values ('alice', 'legacy', '{bob}') returning id"))[0].id;

  await db.exec(up);
  await db.exec(up);   // 能重复执行
  ok(true, '迁移连跑两遍不报错');
  const moved = await rows('select m.visible_to, a.only_accs from public.moments m join public.moment_audience a on a.moment_id = m.id where m.id = $1', [legacy]);
  ok(moved.length === 1 && moved[0].visible_to === null && moved[0].only_accs.join() === 'bob', '旧的 visible_to 名单搬进名单表，moments 里清空', moved);

  const post = (who, extra) => as(who, async () => (await rows('insert into public.moments (author_acc, body' + (extra ? ', ' + extra.cols : '') + ") values (my_acc(), 'x'" + (extra ? ', ' + extra.vals : '') + ') returning id, visible_to, hidden_from'))[0]);
  const m1 = await post('alice');
  const m2 = await post('alice', { cols: 'hidden_from', vals: "'{dave}'" });
  const m3 = await post('alice', { cols: 'visible_to', vals: "'{bob}'" });
  ok(m2.hidden_from === null && m3.visible_to === null, '发表时返回的行里不带名单（名单不存在 moments 表）', [m2, m3]);

  const see = who => ids(who, 'select id from public.moments');
  ok((await see('bob')).length === 4, 'bob（好友）看得到全部 4 条（含只给他看的）');
  ok(!(await see('dave')).includes(m2.id) && (await see('dave')).includes(m1.id), 'dave 看不到“不给 dave 看”的那条，别的照常');
  ok(!(await see('carol')).includes(m3.id) && !(await see('carol')).includes(legacy), 'carol 看不到“只给 bob 看”的两条');
  ok((await see('frank')).length === 0, '不是好友的 frank 一条都看不到');
  ok((await see('alice')).length === 4, '作者自己全看得到');

  // 名单只有作者能读
  ok((await ids('alice', 'select moment_id from public.moment_audience')).length === 3, '作者能读自己的名单');
  ok((await ids('bob', 'select moment_id from public.moment_audience')).length === 0, '别人读不到名单（bob 在名单里也读不到）');
  ok((await as('bob', () => rows('select visible_to, hidden_from from public.moments where id = $1', [m3.id])))[0].visible_to === null, 'bob 从 moments 表也看不到名单');
  ok(await as('bob', () => rejects(() => db.query("insert into public.moment_audience values ($1, null, '{carol}')", [m1.id]))), '手机不能直接写名单表');

  // 不能拿别人的账号去试
  ok((await as('bob', () => rows('select can_see_moment($1, $2) as v', [m2.id, 'dave'])))[0].v === false, 'bob 不能替 dave 查能不能看（以前能，可以借此推出谁被排除了）');
  ok((await as('bob', () => rows('select can_see_moment($1, $2) as v', [m2.id, 'bob'])))[0].v === true, '查自己照常');
  ok((await rows('select can_see_moment($1, $2) as v', [m2.id, 'dave']))[0].v === false, '后台（没有登录身份）可以查任何人：dave 看不到 m2');
  ok((await as('bob', () => rows('select moment_is_open($1) a, moment_is_open($2) b', [m1.id, m2.id])))[0].a === true, '对全部好友公开的可以转发');
  ok((await as('bob', () => rows('select moment_is_open($1) b', [m2.id])))[0].b === false, '设了可见范围的不能转发（只说是或否）');

  // 不让他看我的朋友圈
  ok(await as('erin', () => rejects(() => db.query("update public.friendships set hide_moments = true where owner_acc = 'alice'"))) || (await rows("select hide_moments from public.friendships where owner_acc = 'alice' and friend_acc = 'erin'"))[0].hide_moments === false, '别人改不了我的好友权限');
  const r1 = (await as('alice', () => rows("select set_moment_perm('erin', true, null) as r")))[0].r;
  ok(r1.hide === true && r1.skip === false, '设“不让 erin 看”', r1);
  ok((await see('erin')).length === 0, 'erin 现在一条都看不到');
  ok(await as('alice', () => rejects(() => db.query("select set_moment_perm('frank', true, null)"))), '不是好友不能设');
  await as('alice', () => rows("select set_moment_perm('erin', false, true)"));
  ok((await see('erin')).length === 2, '取消后 erin 又看得到（全部好友可见的两条）');
  ok((await as('erin', () => rows("select skip_moments from public.friendships where owner_acc = 'alice'"))).length === 0, '“不看他”记在 alice 自己那一行，erin 读不到');
  ok((await as('alice', () => rows("select skip_moments from public.friendships where friend_acc = 'erin'")))[0].skip_moments === true, 'alice 能读到自己设的“不看 erin”');

  // 评论：只看好友的
  const cm = (who, body, reply) => as(who, async () => (await rows('insert into public.moment_comments (moment_id, author_acc, body, reply_to_acc) values ($1, my_acc(), $2, $3) returning id', [m1.id, body, reply || null]))[0].id);
  await cm('bob', 'B说');
  await cm('carol', 'C说');
  await cm('alice', 'A回C', 'carol');
  await cm('alice', 'A回B', 'bob');
  await cm('carol', 'C回B', 'bob');
  await cm('dave', 'D说');
  const bodies = who => ids(who, 'select body from public.moment_comments');
  ok((await bodies('alice')).length === 6, '作者看得到全部评论');
  ok(JSON.stringify(await bodies('bob')) === JSON.stringify(['A回B', 'B说', 'C回B', 'D说'].sort()), 'bob：看不到不是好友的 carol 的评论、也看不到作者回 carol 的；carol 回复他的看得到', await bodies('bob'));
  ok(JSON.stringify(await bodies('carol')) === JSON.stringify(['A回C', 'C回B', 'C说'].sort()), 'carol：只看得到自己的和作者回自己的', await bodies('carol'));
  ok(JSON.stringify(await bodies('dave')) === JSON.stringify(['A回B', 'B说', 'D说'].sort()), 'dave：看得到好友 bob 的和作者回 bob 的', await bodies('dave'));

  // 点赞：都看得到
  await as('bob', () => db.query('insert into public.moment_likes (moment_id, account_id) values ($1, my_acc())', [m1.id]));
  await as('carol', () => db.query('insert into public.moment_likes (moment_id, account_id) values ($1, my_acc())', [m1.id]));
  ok((await ids('bob', 'select account_id from public.moment_likes')).join() === 'bob,carol', 'bob 看得到不是好友的 carol 点的赞');
  ok(await as('dave', () => rejects(() => db.query('insert into public.moment_likes (moment_id, account_id) values ($1, my_acc())', [m2.id]))), '看不到的那条点不了赞');
  ok(await as('dave', () => rejects(() => db.query("insert into public.moment_comments (moment_id, author_acc, body) values ($1, my_acc(), 'x')", [m2.id]))), '看不到的那条评论不了');
  ok((await ids('dave', `select account_id from public.moment_likes where moment_id = '${m2.id}'`)).length === 0, '看不到的那条也读不到它的赞');

  // 作者改可见范围
  await as('alice', () => db.query('update public.moments set visible_to = null, hidden_from = null where id = $1', [m2.id]));
  ok((await see('dave')).includes(m2.id), '作者把“不给 dave 看”改回全部好友后 dave 看得到');
  await as('alice', () => db.query("update public.moments set hidden_from = '{carol}' where id = $1", [m1.id]));
  ok(!(await see('carol')).includes(m1.id) && (await see('dave')).includes(m1.id), '发出去以后再设“不给 carol 看”也生效');
  await as('alice', () => db.query("update public.moments set body = 'edited' where id = $1", [m1.id]));
  ok(!(await see('carol')).includes(m1.id), '只改别的字段不会把名单清掉');
  ok(await as('bob', async () => (await rows("update public.moments set hidden_from = '{bob}' where id = $1 returning id", [m1.id])).length === 0), '别人改不了我的可见范围');

  // 撤销
  await db.exec(down);
  const after = await rows('select id, visibility, visible_to from public.moments order by created_at');
  ok(after.find(r => r.id === m1.id).visibility === 'private', '撤销时设过“不给谁看”的改成仅自己可见（不把内容露给被排除的人）');
  ok(after.find(r => r.id === m3.id).visible_to.join() === 'bob', '撤销时“部分可见”的名单搬回 visible_to');
  ok((await rows("select to_regclass('public.moment_audience') as t"))[0].t === null, '撤销后名单表删掉');
  await db.exec(up);
  ok((await rows('select count(*)::int as n from public.moment_audience'))[0].n >= 2, '撤销后再执行一遍迁移也能用');
  // 给你在 Supabase 运行的那份（带检查表）：在已经装好的库上再跑一遍，检查表每行都是“是”
  const review = readFileSync(new URL('../review/site/parts/04-新增SQL-20261119-朋友圈权限.sql', import.meta.url), 'utf8');
  const res = await db.exec(review);
  const table = res[res.length - 1].rows;
  ok(table.length === 6 && table.every(r => /^是/.test(r['结果'])), '交给你运行的 SQL（带检查表）能重复执行，检查表全是“是” → ' + table.map(r => r['序号'] + r['结果']).join(' '));
} catch (e) {
  fail++; console.log('❌ 出错：', e && e.message);
} finally {
  await db.close();
}
console.log(fail ? '\n❌ ' + fail + ' 项没通过（通过 ' + pass + ' 项）' : '\n全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
