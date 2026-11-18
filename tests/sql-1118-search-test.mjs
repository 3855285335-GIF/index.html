process.on('unhandledRejection', e => { console.log('出错：', e.message, e.where || '', e.internalQuery || ''); process.exit(1); });
// 11-18 搜索 SQL 试跑：在内存里的 PostgreSQL（PGlite）里模拟 Supabase 的登录角色，逐项验证
// 用法：cd tests && npm i --no-save @electric-sql/pglite@0.2.17 && node sql-1118-search-test.mjs
import { PGlite } from '@electric-sql/pglite'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), PARTS = path.join(HERE, '..', 'review', 'site', 'parts');
const FILE = process.argv[2] || path.join(PARTS, '04-新增SQL-20261118-search.sql');
const db = new PGlite();
const ME = '11111111-1111-4111-8111-111111111111', BOB = '22222222-2222-4222-8222-222222222222';
let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + m); };
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create table public.profiles(id uuid, account_id text);
create table public.app_config(key text, value jsonb, updated_at timestamptz default now());   -- 故意不设主键：线上表结构没核实，SQL 不能依赖它
alter table public.app_config enable row level security;
create policy app_config_read on public.app_config for select using (true);
insert into public.app_config values ('ice', '{"x":1}', now());
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on public.app_config to anon, authenticated;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);

// 换错数据库时应该直接停下、什么都不改
const wrong = new PGlite();
let stopped = false; try { await wrong.exec(fs.readFileSync(FILE, 'utf8')); } catch (e) { stopped = /不是 Chatter/.test(e.message); await wrong.exec('rollback'); }
ok(stopped && !(await wrong.query(`select to_regclass('public.search_cache') r`)).rows[0].r, '不是 Chatter 的数据库：直接停下，什么都没建');

const sql = fs.readFileSync(FILE, 'utf8');
let r = await db.exec(sql); console.log('第一遍：', JSON.stringify(r[r.length - 1].rows));
ok(r[r.length - 1].rows.length === 4 && r[r.length - 1].rows.every(x => x.结果 !== '否'), '检查表四行都不是“否”');
// 用户改过上限后再跑一遍，不能被冲掉
await db.exec(`update public.app_config set value = jsonb_set(value, '{per_user_day}', '5') where key = 'search'`);
r = await db.exec(sql); console.log('第二遍：', JSON.stringify(r[r.length - 1].rows));
ok((await db.query(`select value->>'per_user_day' v from public.app_config where key='search'`)).rows[0].v === '5', '重复运行不会冲掉你改过的上限');
ok((await db.query(`select value from public.app_config where key='ice'`)).rows[0].value.x === 1, '原来的 ice 配置没动');

const as = async (role, sub, q) => {
  await db.exec(`reset role; select set_config('request.jwt.claims', '${sub ? JSON.stringify({ sub }) : ''}', false); set role ${role};`);
  try { return { rows: (await db.query(q)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('reset role'); }
};
// 缓存和计数：手机上（登录用户、未登录）读写都不行
for (const role of ['anon', 'authenticated']) {
  const a = await as(role, role === 'authenticated' ? ME : null, `select * from public.search_cache`);
  const b = await as(role, role === 'authenticated' ? ME : null, `insert into public.search_cache(k, v) values ('x', '{}')`);
  ok((a.err || a.rows.length === 0) && b.err, role + '：读不到缓存、也写不进去');
  const c = await as(role, role === 'authenticated' ? ME : null, `select public.search_bump('${ME}', 'web', 100)`);
  ok(!!c.err, role + '：不能自己加计数（' + (c.err || '').slice(0, 40) + '）');
}
await db.exec(`insert into public.search_cache(k, v) values ('w|zh|天气', '{"a":1}')`);
const sc = await as('service_role', null, `select v from public.search_cache where k = 'w|zh|天气'`);
ok(sc.rows && sc.rows[0].v.a === 1, '服务器：能读缓存');

// 计数：到上限就返回 -1，不再增加
const bump = async (lim, kind = 'web', month = false) => (await as('service_role', null, `select public.search_bump('${ME}', '${kind}', ${lim}, ${month}) n`)).rows[0].n;
const seq = []; for (let i = 0; i < 4; i++) seq.push(await bump(3));
ok(JSON.stringify(seq) === '[1,2,3,-1]', '每天上限 3 次：第 4 次被拒 → ' + JSON.stringify(seq));
ok(await bump(3, 'read') === 1, '“简洁阅读”单独计数');
const m1 = await bump(2, 'month', true), m2 = await bump(2, 'month', true), m3 = await bump(2, 'month', true);
ok(m1 === 1 && m2 === 2 && m3 === -1, '每月总数也会封顶 → ' + [m1, m2, m3]);
const dm = (await db.query(`select day from public.search_usage where kind = 'month'`)).rows[0].day;
ok(new Date(dm).getUTCDate() === 1 || String(dm).includes('-01'), '每月计数记在当月 1 号 → ' + String(dm).slice(0, 15));

// 个人规则：只能看到、改自己的
const p1 = await as('authenticated', ME, `insert into public.search_prefs(prefs) values ('{"pin":["github.com"]}') returning uid`);
ok(p1.rows && p1.rows[0].uid === ME, '能存自己的规则（不用填自己的编号）');
const p2 = await as('authenticated', ME, `insert into public.search_prefs(uid, prefs) values ('${BOB}', '{}')`);
ok(!!p2.err, '不能替别人存规则');
const p3 = await as('authenticated', BOB, `select * from public.search_prefs`);
ok(p3.rows && p3.rows.length === 0, '别人看不到我的规则');
const p4 = await as('authenticated', BOB, `update public.search_prefs set prefs = '{}' where uid = '${ME}' returning uid`);
ok(p4.rows && p4.rows.length === 0, '别人改不了我的规则');
const p5 = await as('authenticated', ME, `insert into public.search_prefs(prefs) values ('{"pin":["a.com"]}') on conflict (uid) do update set prefs = excluded.prefs, updated_at = now() returning prefs`);
ok(p5.rows && p5.rows[0].prefs.pin[0] === 'a.com', '再存一次是覆盖（手机上用的就是这个写法）');
const p6 = await as('anon', null, `select * from public.search_prefs`);
ok(!!p6.err || p6.rows.length === 0, '没登录看不到任何人的规则');
const cfg = await as('anon', null, `select value from public.app_config where key = 'search'`);
ok(cfg.rows && cfg.rows[0].value.farms.length > 5, '默认名单谁都能读（手机上要用来显示）');

console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过'); process.exit(bad ? 1 : 0);
