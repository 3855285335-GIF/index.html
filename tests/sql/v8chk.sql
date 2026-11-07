\set ON_ERROR_STOP off
create or replace function t_as(u uuid) returns void language plpgsql as $$ begin perform set_config('app.uid', u::text, false); end $$;
\set A '\'11111111-1111-1111-1111-111111111111\''
\set B '\'22222222-2222-2222-2222-222222222222\''
\set C '\'33333333-3333-3333-3333-333333333333\''
\set EPB '\'https://fcm.googleapis.com/fcm/send/bob-phone\''
\set EPX '\'https://fcm.googleapis.com/fcm/send/x\''
\set K '\'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM\''
\set S '\'tBHItJI5svbpez7KI4CCXg\''

\echo '=== 1) bob 登记手机（应成功）；地址不是 https、密钥格式不对（应各报一次 check 错误）'
set role authenticated; select t_as(:B);
select public.push_save(:EPB, :K, :S, true);
select public.push_save('http://evil.example/x', :K, :S, true);
select public.push_save('https://fcm.googleapis.com/fcm/send/bob-2', 'abc', :S, true);
\echo '--- push_status：n 应为 1、here 应为 true、preview true、keys false'
select public.push_status(:EPB);

\echo '=== 2) 网页（authenticated）不能读推送表，也不能调用服务端函数（下面 4 句都应报 permission denied）'
select count(*) from public.push_subs;
select public.push_job(:B::uuid, 'test', null, null);
select public.push_vapid();
select public.push_gone(array['x']);

\echo '=== 3) 每个账号最多 5 台：alice 登记 7 台，最后应只剩 5 台，并且是最近的 5 台（a3..a7）'
select t_as(:A);
select format('select public.push_save(%L, %L, %L, true)', 'https://fcm.googleapis.com/fcm/send/a' || g, :K, :S) from generate_series(1, 7) g \gexec
reset role;
select string_agg(right(endpoint, 2), ',' order by endpoint) as "alice 剩下的" from public.push_subs where acc = 'alice';

\echo '=== 4) 服务端：alice 给 bob 发文字，bob 不在线 → 应返回 1 个推送地址，标题 Alice，内容是消息'
insert into public.messages (id, conv_key, from_acc, to_acc, type, body) values ('aaaaaaaa-0000-0000-0000-000000000001', '', 'alice', 'bob', 'text', '晚上一起吃饭吗？');
set role service_role;
select j->>'title' as title, j->>'body' as body, j->>'hidden' as hidden, j->>'tag' as tag, j->>'url' as url, jsonb_array_length(j->'subs') as subs, j->>'badge' as badge
  from public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000001', 'bob') j;
\echo '--- 同一条消息再推一次：应 skip dup'
select public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000001', 'bob');

\echo '=== 5) 第二条：未读不止 1 条时，内容前面应有 [n条]（n 是 bob 这个聊天的未读数）；bob 给 alice 的备注“老婆”应作为标题'
reset role;
update public.friendships set remark = '老婆' where owner_acc = 'bob' and friend_acc = 'alice';
insert into public.messages (id, conv_key, from_acc, to_acc, type, body) values ('aaaaaaaa-0000-0000-0000-000000000002', '', 'alice', 'bob', 'image', 'https://x/y.jpg');
set role service_role;
select j->>'title' as title, j->>'body' as body, j->>'hidden' as hidden from public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000002', 'bob') j;

\echo '=== 6) 冒名：carol 拿 alice 的消息号让推送（应 skip friend）；alice 拿不存在的消息号（应 skip ref）'
select public.push_job(:C::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000002', 'bob');
select public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-00000000ffff', 'bob');
\echo '--- 4 分钟前的旧消息（应 skip ref）；通话记录类消息（应 skip type）'
reset role;
insert into public.messages (id, conv_key, from_acc, to_acc, type, body, created_at) values ('aaaaaaaa-0000-0000-0000-000000000003', '', 'alice', 'bob', 'text', '旧的', now() - interval '4 minutes');
insert into public.messages (id, conv_key, from_acc, to_acc, type, body) values ('aaaaaaaa-0000-0000-0000-000000000004', '', 'alice', 'bob', 'call', 'audio');
set role service_role;
select public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000003', 'bob');
select public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000004', 'bob');

\echo '--- 引用回复的消息：通知里只显示回复的话（应为“好呀 七点见”）'
reset role;
insert into public.messages (id, conv_key, from_acc, to_acc, type, body) values ('aaaaaaaa-0000-0000-0000-000000000006', '', 'alice', 'bob', 'text', U&'\2063Qaaaaaaaa-0000\2063晚上一起吃饭吗？\2063好呀\000a七点见');
set role service_role;
select regexp_replace(j->>'body', '^\[\d+条\] ', '') as "引用回复" from public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000006', 'bob') j;

\echo '=== 7) bob 在线（刚报到）→ 应 skip online；切到后台（last_seen 为空）→ 又能推'
reset role;
insert into public.messages (id, conv_key, from_acc, to_acc, type, body) values ('aaaaaaaa-0000-0000-0000-000000000005', '', 'alice', 'bob', 'file', '{"u":"https://x/f.pdf","n":"合同.pdf","s":1}');
insert into public.presence (account_id, last_seen) values ('bob', now()) on conflict (account_id) do update set last_seen = now();
set role service_role;
select public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000005', 'bob');
reset role; update public.presence set last_seen = null where account_id = 'bob'; set role service_role;
select j->>'body' as "文件消息" from public.push_job(:A::uuid, 'msg', 'aaaaaaaa-0000-0000-0000-000000000005', 'bob') j;

\echo '=== 8) 来电：信箱里有 alice 发给 bob 的视频邀请 → 应是“📹 邀请你视频通话”，ttl 45，url ./#call=alice'
reset role;
insert into public.signals (to_acc, from_acc, payload) values ('bob', 'alice', '{"t":"invite","id":"call-1","video":true}');
set role service_role;
select j->>'body' as body, j->>'ttl' as ttl, j->>'url' as url, j->>'tag' as tag from public.push_job(:A::uuid, 'call', 'call-1', 'bob') j;
\echo '--- 信箱里没有的来电号（应 skip ref）'
select public.push_job(:A::uuid, 'call', 'call-zzz', 'bob');
\echo '--- 未接来电：推过的 call-1 → 应是 [未接来电]，tag 和来电一样 c:alice；没推过的 call-2 → skip nocall'
select j->>'body' as body, j->>'tag' as tag from public.push_job(:A::uuid, 'miss', 'call-1', 'bob') j;
select public.push_job(:A::uuid, 'miss', 'call-2', 'bob');

\echo '=== 9) 好友请求：carol 请求加 bob → 标题“新的好友请求”；没有请求时 → skip ref'
reset role;
insert into public.friend_requests (from_acc, to_acc, from_name, status) values ('carol', 'bob', 'Carol', 'pending');
set role service_role;
select j->>'title' as title, j->>'body' as body, j->>'url' as url from public.push_job(:C::uuid, 'req', null, 'bob') j;
select public.push_job(:C::uuid, 'req', null, 'alice');

\echo '=== 10) 测试通知：发给自己（alice 有 5 台），10 秒内第二次应 skip dup'
select j->>'body' as body, jsonb_array_length(j->'subs') as subs from public.push_job(:A::uuid, 'test', null, 'whoever') j;
select public.push_job(:A::uuid, 'test', null, null);
\echo '--- carol 没登记手机：给自己发测试 → skip nosub；不存在的用户 → skip auth；乱写类型 → skip kind'
select public.push_job(:C::uuid, 'test', null, null);
select public.push_job('44444444-4444-4444-4444-444444444444', 'test', null, null);
select public.push_job(:A::uuid, 'hack', null, 'bob');

\echo '=== 11) 密钥：第一次写入成功，第二次不覆盖（pub 应仍是 P1）'
select public.push_set_vapid('P1', 'D1')->>'pub' as first;
select public.push_set_vapid('P2', 'D2')->>'pub' as second;
\echo '--- 失效地址清理：删掉 bob 的手机后，bob 应 0 台'
select public.push_gone(array[:EPB]);
reset role;
select count(*) as "bob 剩几台" from public.push_subs where acc = 'bob';

\echo '=== 12) 取消登记：只能删自己的（alice 删 bob 的不生效）；版本号应为 8；未登录（anon）不能登记'
set role authenticated; select t_as(:B);
select public.push_save(:EPB, :K, :S, false);
select t_as(:A); select public.push_remove(:EPB);
select t_as(:B); select public.push_status(:EPB) as "bob 的手机应还在，preview 为 false";
select public.push_remove(:EPB);
select public.push_status(:EPB) as "删掉之后 n=0";
select public.chatter_schema();
reset role; set role anon;
select public.push_save(:EPX, :K, :S, true);
reset role;
