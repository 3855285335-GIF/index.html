\set ON_ERROR_STOP off
create or replace function t_as(u uuid) returns void language plpgsql as $$ begin perform set_config('app.uid', u::text, false); end $$;
set role authenticated;
select t_as('11111111-1111-1111-1111-111111111111');
\echo '--- 1) alice 给好友 bob 设备注（应成功，前后空格会去掉）'
select public.set_remark('bob', '  老公  ');
\echo '--- 2) alice 读自己的好友备注：bob 应为“老公”'
select friend_acc, remark from public.friendships where owner_acc = 'alice' order by friend_acc;
\echo '--- 3) 备注超过 20 个字（应报错 remark too long）'
select public.set_remark('bob', repeat('长', 21));
\echo '--- 4) 给不是好友的人设备注（应报错 not friends）'
select public.set_remark('nobody', '路人');
\echo '--- 5) 不能直接改好友表（改了也不生效）'
update public.friendships set remark = '偷改' where owner_acc = 'alice';
select remark as "直接改之后，备注应仍是“老公”" from public.friendships where owner_acc = 'alice' and friend_acc = 'bob';
\echo '--- 6) bob 看不到 alice 给他的备注（bob 只能看自己的好友行，备注应为空）'
select t_as('22222222-2222-2222-2222-222222222222');
select owner_acc, friend_acc, remark from public.friendships;
\echo '--- 7) 清空备注'
select t_as('11111111-1111-1111-1111-111111111111');
select public.set_remark('bob', '');
select friend_acc, remark from public.friendships where owner_acc = 'alice';
\echo '--- 8) 存储用量：新加两个文件 300 + 700 字节（别的桶的 99999 不算），前后应正好差 1000'
select public.storage_used() as "加文件之前";
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('chat-media', 'alice/1_a.jpg', '{"size": 300}'), ('chat-media', 'bob/2_b.mov', '{"size": 700}'), ('other', 'x', '{"size": 99999}');
set role authenticated; select t_as('11111111-1111-1111-1111-111111111111');
select public.storage_used() as "加文件之后";
\echo '--- 9) 版本号应为 7；未登录（anon）不能调用'
select public.chatter_schema();
reset role; set role anon;
select public.storage_used();
select public.set_remark('bob', 'x');
reset role;
