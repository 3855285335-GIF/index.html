// PostgreSQL ACL behavior test in isolated PGlite, never production.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const script = filename => readFileSync(new URL('../review/security/' + filename, import.meta.url), 'utf8');
const protect = script('20261123-匿名函数权限候选.sql');
const rollback = script('20261123-匿名函数权限回滚.sql');
const functions = ['public.is_group_member(uuid, text)','public.is_group_owner(uuid, text)','public.send_group_msg(text, text)','public.my_acc()'];
const execute = async (role, signature) => (await db.query("select has_function_privilege($1,$2,'EXECUTE') as ok",[role,signature])).rows[0].ok;
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create function public.is_group_member(gid uuid, acc text) returns boolean language sql security definer as 'select false';
    create function public.is_group_owner(gid uuid, acc text) returns boolean language sql security definer as 'select false';
    create function public.send_group_msg(conv text, msg text) returns void language plpgsql security definer as 'begin null; end';
    create function public.my_acc() returns text language sql security definer as 'select null::text';
    create function public.keepalive() returns integer language sql security definer as 'select 1';
    grant execute on all functions in schema public to public, anon, authenticated, service_role;
  `);
  for (const f of functions) assert.equal(await execute('anon',f),true,'initial permission mismatch: '+f);
  await db.exec(protect);
  await db.exec(protect);
  for (const f of functions) {
    assert.equal(await execute('anon',f),false,'anonymous still executable: '+f);
    assert.equal(await execute('authenticated',f),true,'authenticated lost access: '+f);
    assert.equal(await execute('service_role',f),true,'service role lost access: '+f);
  }
  assert.equal(await execute('anon','public.keepalive()'),true,'keepalive must remain accessible');
  await db.exec(rollback);
  for (const f of functions) assert.equal(await execute('anon',f),true,'rollback failed: '+f);
  console.log('PGlite role behavior passed: block anon, allow signed-in and server, keep keepalive, repeat and roll back.');
} finally { await db.close(); }
