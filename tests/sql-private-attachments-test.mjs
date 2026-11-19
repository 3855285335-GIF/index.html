// Runs the shipped SQL with PostgreSQL RLS. The Storage operation and session are fixture inputs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const file = '20261119115703_chatter_private_attachments.sql';
const load = dir => readFileSync(new URL(`../supabase/${dir}/${file}`, import.meta.url), 'utf8');
const migration = load('migrations'), rollback = load('rollback');
const id = 'b28ab89a-3e24-49a8-a93b-7c5f6cc97d03';
const path = 'alice/' + id + '.png';
const selectObjects = () => db.query('select name from storage.objects order by name').then(r => r.rows.map(row => row.name));

async function enter(account, operation, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('test.account',$1,false),set_config('storage.operation',$2,false)", [account, operation]);
  await db.exec('set role ' + role);
}

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(bucket_id text not null, name text not null primary key);
    create table public.app_config(key text primary key, value jsonb);
    create table public.messages(id uuid primary key, from_acc text not null, to_acc text not null, conv_key text not null, type text not null);
    create function public.session_alive() returns boolean language sql stable as
      $$select coalesce(nullif(current_setting('test.account',true),''),'') <> ''$$;
    create function public.my_acc() returns text language sql stable as
      $$select nullif(current_setting('test.account',true),'')$$;
    create function storage.operation() returns text language sql stable as
      $$select current_setting('storage.operation',true)$$;
    grant usage on schema storage to anon, authenticated;
    grant select, insert on storage.objects to authenticated;
    grant select on storage.objects to anon;
    grant select on public.app_config to authenticated;
    grant select, insert on public.messages to authenticated;
    alter table storage.objects enable row level security;
    alter table public.messages enable row level security;
    create policy msg_read on public.messages for select to authenticated using (public.my_acc() in (from_acc,to_acc));
    create policy msg_insert on public.messages for insert to authenticated with check (public.my_acc() = from_acc);
    create policy legacy_read on storage.objects for select using (bucket_id = 'chat-media');
    insert into storage.buckets values ('chat-media','chat-media',true,52428800,null);
    insert into storage.objects values ('chat-media','alice/legacy.png');
  `);
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(rollback);
  await db.exec(rollback);
  assert.equal((await db.query("select to_regprocedure('public.chatter_private_attachments_enabled()') as fn")).rows[0].fn, null);
  await db.exec(migration);
  // Include deliberately broad policies to prove the private bucket restrictions take precedence.
  await db.exec('create policy broad_read on storage.objects for select using (true); create policy broad_insert on storage.objects for insert with check (true)');
  const insertObject = key => db.query("insert into storage.objects values ('chatter-private',$1)", [key]);
  await enter('alice', 'storage.object.upload');
  assert.equal((await db.query('select public.chatter_private_attachments_enabled() as enabled')).rows[0].enabled, false);
  await assert.rejects(insertObject(path), { code:'42501' });
  await db.exec(`reset role; update public.app_config set value='{"enabled":true}' where key='private_chat_attachments'`);
  await enter('other', 'storage.object.upload');
  await assert.rejects(insertObject(path), { code:'42501' });
  await enter('alice', 'storage.object.upload');
  await assert.rejects(insertObject('alice/invalid.png'), { code:'42501' });
  await assert.rejects(insertObject('alice/extra/' + id + '.png'), { code:'42501' });
  await insertObject(path);
  await insertObject(path + '.t');
  await insertObject(path.replace('.png','.pdf'));

  const bind = from => db.query("insert into public.messages values ($1,$2,'bob','alice::bob','image',$3)", [id, from, path]);
  await enter('other', 'object.get_authenticated');
  await assert.rejects(bind('alice'), { code:'42501' });
  await assert.rejects(bind('other'), { code:'23514' });
  assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  await enter('alice', 'object.get_authenticated');
  await bind('alice');
  await enter('bob', 'storage.object.get_authenticated');
  assert.deepEqual(await selectObjects(), [path,path+'.t','alice/legacy.png']);
  for (const op of ['storage.object.sign','storage.object.sign_many','storage.object.list','storage.object.copy','']) {
    await enter('bob', op);
    assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  }
  await enter('alice', 'storage.object.sign');
  assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  await enter('', 'storage.object.get_authenticated', 'anon');
  assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  await enter('', 'storage.object.get_authenticated');
  assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  await db.exec('reset role');
  await db.query("update public.messages set type='recalled' where id=$1", [id]);
  await enter('bob', 'storage.object.get_authenticated');
  assert.deepEqual(await selectObjects(), ['alice/legacy.png']);
  await db.exec('reset role');
  await db.query("update public.messages set type='image' where id=$1", [id]);
  await db.exec(rollback);
  await enter('bob', 'storage.object.get_authenticated');
  assert.deepEqual(await selectObjects(), [path,path+'.t','alice/legacy.png']);
  await enter('alice', 'storage.object.upload');
  await assert.rejects(insertObject(path.replace('.png','.webp')), { code:'42501' });
  console.log('通过：默认关闭、收发身份、精确对象绑定、缩略图、匿名和陌生人、签名和列举、撤回、兼容和两种回滚。');
} finally {
  await db.close();
}
