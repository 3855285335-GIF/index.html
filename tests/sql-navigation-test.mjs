import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const file = '20261120024725_chatter_navigation.sql';
const script = async (folder) =>
  db.exec(await readFile(new URL('../supabase/' + folder + '/' + file, import.meta.url), 'utf8'));
const query = async (sql, args) => (await db.query(sql, args)).rows;
const identity = async (who) => {
  await db.exec('reset role');
  await db.query("select set_config('test.account',$1,false)", [who]);
  await db.exec('set role authenticated');
};
const rpc = async (peer, action, id, value = null) =>
  (
    await query('select public.chatter_navigation($1,$2,$3,$4) as v', [
      peer,
      action,
      id,
      JSON.stringify(value)
    ])
  )[0].v;
try {
  await db.exec(
    "create role anon; create role authenticated; create table public.friendships(owner_acc text,friend_acc text,primary key(owner_acc,friend_acc)); insert into public.friendships values('alice','bob'),('bob','alice'),('alice','eve'),('eve','alice'); create function public.my_acc() returns text language sql stable as $$ select nullif(current_setting('test.account',true),'') $$"
  );
  await script('migrations');
  await script('migrations');
  const id = '12345678-1234-4234-8234-123456789abc',
    wrong = '12345678-1234-4234-8234-123456789abd';
  const place = { lat: 31.21, lon: 121.45, name: '东门' },
    fix = { lat: 31.2, lon: 121.4, accuracy: 15, time: Date.now() };
  await db.exec('set role anon');
  await assert.rejects(rpc('bob', 'read', null));
  await identity('alice');
  await assert.rejects(db.query('select * from chatter_navigation_private.trips'));
  await assert.rejects(rpc('bob', 'invite', id, { ...place, lat: 121.45 }));
  assert.equal((await rpc('bob', 'invite', id, place)).active, false);
  assert.equal((await rpc('bob', 'invite', id, place)).id, id);
  await assert.rejects(rpc('bob', 'fix', id, fix));
  await assert.rejects(rpc('bob', 'accept', id));
  await identity('eve');
  assert.equal(await rpc('alice', 'read', id), null);
  await assert.rejects(rpc('bob', 'read', id));
  await identity('bob');
  await db.exec("reset role;update chatter_navigation_private.trips set expires=now()+interval '1 minute'");
  await identity('bob');
  const accepted = await rpc('alice', 'accept', id);
  assert.equal(accepted.active, true);
  assert.ok(Date.parse(accepted.expires)-accepted.serverTime > 1799000);
  assert.equal((await rpc('alice', 'accept', id)).expires, accepted.expires);
  await identity('alice');
  const offer = await rpc('bob','offer_more',id);
  assert.equal(offer.expires, accepted.expires);
  await assert.rejects(rpc('bob','accept_more',id,{key:offer.renewKey}));
  await identity('bob');
  const longer = await rpc('alice','accept_more',id,{key:offer.renewKey});
  assert.equal(Date.parse(longer.expires)-Date.parse(accepted.expires),1800000);
  await assert.rejects(rpc('alice','accept_more',id,{key:offer.renewKey}));
  for(let i=0;i<4;i++){
    const pending=await rpc('alice','offer_more',id);
    await identity('alice');await rpc('bob','accept_more',id,{key:pending.renewKey});await identity('bob');
  }
  assert.equal((await rpc('alice','read',id)).canExtend,false);
  await assert.rejects(rpc('alice','offer_more',id));
  await rpc('alice', 'fix', id, fix);
  await rpc('alice', 'fix', id, { ...fix, lat: 0, time: fix.time - 1000 });
  await assert.rejects(rpc('alice', 'fix', id, { ...fix, time: Date.now() - 120000 }));
  await identity('alice');
  assert.equal((await rpc('bob', 'read', id)).peerFix.lat, fix.lat);
  await rpc('bob', 'wait', id, { ...place, name: '售票亭' });
  await rpc('bob', 'propose', id, { ...place, name: '西门' });
  const proposal = (await rpc('bob', 'read', id)).proposal;
  await assert.rejects(rpc('bob', 'agree', id, { key: proposal.key }));
  await identity('bob');
  await assert.rejects(rpc('alice', 'agree', id, { key: wrong }));
  assert.equal((await rpc('alice', 'read', id)).peerWait.name, '售票亭');
  assert.equal((await rpc('alice', 'agree', id, { key: proposal.key })).destination.name, '西门');
  assert.equal(await rpc('alice', 'end', wrong), null);
  assert.equal((await rpc('alice', 'read', id)).id, id);
  await db.exec("reset role;update chatter_navigation_private.trips set expires=now()-interval '1 second'");
  await identity('bob');
  assert.equal(await rpc('alice', 'read', id), null);
  await rpc('alice', 'invite', wrong, place);
  await db.exec("reset role;delete from public.friendships where owner_acc='alice' and friend_acc='bob'");
  assert.equal((await query('select * from chatter_navigation_private.trips')).length, 0);
  await script('rollback');
  await script('rollback');
  assert.equal((await query('select count(*)::int n from public.friendships'))[0].n, 3);
  console.log(
    '导航迁移与回滚通过：角色和好友、坐标、双向同意、过期/乱序定位、确认换入口、旧邀请、解除好友和临时数据清理。'
  );
} finally {
  await db.close();
}
