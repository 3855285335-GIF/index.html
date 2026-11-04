\set ON_ERROR_STOP off
create or replace function t_as(u uuid) returns void language plpgsql as $$ begin perform set_config('app.uid', u::text, false); end $$;
set role authenticated;
\echo '--- alice 给好友 bob 发两条信号'
select t_as('11111111-1111-1111-1111-111111111111');
select public.send_signal('bob', '{"t":"invite","id":"c1","sq":"a1"}');
select public.send_signal('bob', '{"t":"ice","id":"c1","sq":"a2"}');
\echo '--- alice 给非好友 carol 发（应报错 not friends）'
select public.send_signal('carol', '{"t":"invite"}');
\echo '--- carol 冒充：给 bob 发（carol 不是 bob 好友，应报错）'
select t_as('33333333-3333-3333-3333-333333333333');
select public.send_signal('bob', '{"t":"invite"}');
\echo '--- carol 取信号：应为空（不能取别人的）'
select count(*) as carol_got from public.take_signals();
\echo '--- carol 直接读表（应被拒绝）'
select * from public.signals;
\echo '--- bob 取信号：应按顺序拿到 2 条，from_acc 为 alice'
select t_as('22222222-2222-2222-2222-222222222222');
select id, from_acc, payload->>'t' as t from public.take_signals();
\echo '--- bob 再取：应为空（取完即删）'
select count(*) as again from public.take_signals();
reset role;
\echo '--- 过期信号：2 分钟前的来电不应再返回，但会被删掉'
insert into public.signals (to_acc, from_acc, payload, created_at) values ('bob','alice','{"t":"invite","id":"old"}', now() - interval '2 minutes');
set role authenticated; select t_as('22222222-2222-2222-2222-222222222222');
select count(*) as stale_returned from public.take_signals();
reset role;
select count(*) as left_in_table from public.signals;
\echo '--- 10 分钟前的旧信号会在下次发送时被清理'
insert into public.signals (to_acc, from_acc, payload, created_at) values ('alice','bob','{"t":"x"}', now() - interval '11 minutes');
set role authenticated; select t_as('22222222-2222-2222-2222-222222222222');
select public.send_signal('alice', '{"t":"ice","sq":"b1"}');
reset role;
select count(*) as alice_queue from public.signals where to_acc='alice';
\echo '--- 在线状态'
set role authenticated; select t_as('11111111-1111-1111-1111-111111111111');
select public.heartbeat();
select t_as('22222222-2222-2222-2222-222222222222');
select * from public.friends_seen();
select t_as('11111111-1111-1111-1111-111111111111'); select public.heartbeat(false);
select t_as('22222222-2222-2222-2222-222222222222');
select * from public.friends_seen();
\echo '--- carol 查在线：她没有好友，应为空（看不到 alice）'
select t_as('33333333-3333-3333-3333-333333333333');
select count(*) as carol_sees from public.friends_seen();
reset role;
\echo '--- 匿名不能调用'
set role anon; select public.take_signals(); reset role;
set role anon; select public.heartbeat(); reset role;
\echo '--- 原有数据没动'
select count(*) as profiles, (select count(*) from public.messages) as messages from public.profiles;
