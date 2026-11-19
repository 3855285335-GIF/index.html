// 11-19 SQL ③（收回两个旧函数）：在内存里的 PostgreSQL 上试跑迁移、给用户的可重复版本、检查表和撤销脚本
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NAME = '20261119124000_chatter_revoke_old_rpcs.sql';
const migration = read('supabase/migrations/' + NAME);
const rollback = read('supabase/rollback/' + NAME);
const review = read('review/site/parts/04-新增SQL-20261119-收回旧函数.sql');
const can = async (db, role, fn) => (await db.query(`select has_function_privilege('${role}', '${fn}', 'execute') as x`)).rows[0].x;
const REG = 'public.register_user(text,text,text)', EX = 'public.account_exists(text)', KA = 'public.keepalive()';
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('✅ ' + m); };

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table public.profiles (id uuid primary key, account_id text);
    create function public.handle_new_user() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
    create function public.register_user(p_acc text, p_pass text, p_name text) returns json language sql security definer as $$ select '{}'::json $$;
    create function public.account_exists(p_acc text) returns boolean language sql security definer as $$ select false $$;
    create function public.keepalive() returns json language sql security definer as $$ select '{}'::json $$;
    grant execute on function public.register_user(text,text,text), public.account_exists(text), public.keepalive() to anon, authenticated;
  `);
  return db;
}
const table = async db => (await db.query('select 序号, 结果 from _chatter_1119r order by 序号')).rows;

try {
  // 1. 迁移本身
  let db = await fresh();
  ok(await can(db, 'anon', REG) && await can(db, 'anon', EX), '起点：旧函数谁都能调用（和线上一样）');
  await db.exec(migration);
  ok(!await can(db, 'anon', REG) && !await can(db, 'authenticated', REG), '迁移后：没登录、登录了都不能调用“直接建账号”');
  ok(!await can(db, 'anon', EX) && !await can(db, 'authenticated', EX), '迁移后：不能再查“账号存不存在”');
  ok(await can(db, 'anon', KA), '迁移后：保活照常');
  await db.exec(rollback);
  ok(await can(db, 'anon', REG) && await can(db, 'authenticated', EX), '撤销脚本：权限原样还回去');
  await db.close();

  // 2. 给用户运行的那份：能重复运行，检查表全是“是”
  db = await fresh();
  for (const round of ['第一遍', '第二遍']) {
    await db.exec(review);
    const rows = await table(db);
    ok(rows.length === 5 && rows.every(r => r.结果 === '是'), round + '：检查表 5 项全是“是” ' + JSON.stringify(rows.map(r => r.结果)));
  }
  ok(!await can(db, 'anon', REG) && await can(db, 'anon', KA), '给用户的版本效果和迁移一样');
  await db.close();

  // 3. 线上万一已经没有这两个函数：照样能运行，不报错
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create function public.keepalive() returns json language sql as $$ select '{}'::json $$;
    grant execute on function public.keepalive() to anon;
    create table t (x int); create function f() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger on_auth_user_created after insert on t for each row execute function f();`);
  await db.exec(migration); await db.exec(review); await db.exec(rollback);
  ok((await table(db)).every(r => r.结果 === '是'), '函数不存在时也能运行（不会因为找不到函数整份失败）');
  await db.close();
  console.log('\n全部通过（' + n + ' 项）');
} catch (e) { console.error('❌', e.message); process.exit(1); }
