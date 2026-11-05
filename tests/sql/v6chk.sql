\set ON_ERROR_STOP off
create or replace function t_as(u uuid) returns void language plpgsql as $$ begin perform set_config('app.uid', u::text, false); end $$;
set role authenticated;
select t_as('11111111-1111-1111-1111-111111111111');
\echo '--- 1) alice 给 bob 发表情、视频（应成功）'
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','sticker','😂');
insert into public.messages (conv_key, from_acc, to_acc, type, body, dur) values ('x','alice','bob','video','https://p.supabase.co/storage/v1/object/public/chat-media/alice/1_v.mp4', 12);
\echo '--- 1b) 发文件：格式正确应成功；不是 JSON、缺地址的应报错 invalid file body'
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','file','{"u":"https://p.supabase.co/storage/v1/object/public/chat-media/alice/2_f.pdf","n":"合同 最终版.pdf","s":12345}');
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','file','not json');
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','file','{"n":"没有地址.pdf"}');
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','file','[1,2]');
reset role;
\echo '--- 1c) bob 的会话预览应为：[文件] 合同 最终版.pdf'
select last_body from public.conversations where owner_acc='bob';
set role authenticated; select t_as('11111111-1111-1111-1111-111111111111');
\echo '--- 1d) 再发视频'
insert into public.messages (conv_key, from_acc, to_acc, type, body, dur) values ('x','alice','bob','video','https://p.supabase.co/storage/v1/object/public/chat-media/alice/3_v.mov', 5);
\echo '--- 2) 未知类型（应报错 invalid message type）'
insert into public.messages (conv_key, from_acc, to_acc, type, body) values ('x','alice','bob','exe','x');
reset role;
\echo '--- 3) bob 的会话预览应为 [视频]，未读 4（表情 1 + 视频 2 + 文件 1）'
select last_body, unread from public.conversations where owner_acc='bob';
set role authenticated; select t_as('11111111-1111-1111-1111-111111111111');
\echo '--- 4) alice 添加自己文件夹里的表情（应成功），添加别人文件夹的（应被拒绝）'
insert into public.stickers (owner_acc, url, kw) values ('alice', 'https://p.supabase.co/storage/v1/object/public/chat-media/alice/sticker_1.gif', '猫 可爱');
insert into public.stickers (owner_acc, url, kw) values ('alice', 'https://p.supabase.co/storage/v1/object/public/chat-media/bob/sticker_2.gif', '偷的');
insert into public.stickers (owner_acc, url, kw) values ('bob', 'https://p.supabase.co/storage/v1/object/public/chat-media/bob/sticker_3.gif', '冒充');
\echo '--- 5) alice 改关键词'
update public.stickers set kw = '猫猫 可爱 摸头' where owner_acc='alice';
select count(*) as alice_has, max(kw) as kw from public.stickers;
\echo '--- 6) bob 看不到、改不了、删不了 alice 的表情'
select t_as('22222222-2222-2222-2222-222222222222');
select count(*) as bob_sees from public.stickers;
update public.stickers set kw = 'hack';
delete from public.stickers;
reset role;
select count(*) as still_there, max(kw) as kw from public.stickers;
\echo '--- 7) 每人最多 500 个：再加 499 个后，第 501 个应被拒绝'
insert into public.stickers (owner_acc, url) select 'alice', 'https://p.supabase.co/storage/v1/object/public/chat-media/alice/sticker_x' || g || '.png' from generate_series(1,499) g;
set role authenticated; select t_as('11111111-1111-1111-1111-111111111111');
insert into public.stickers (owner_acc, url) values ('alice', 'https://p.supabase.co/storage/v1/object/public/chat-media/alice/sticker_over.png');
select count(*) as alice_total from public.stickers;
\echo '--- 8) alice 删除自己的表情'
delete from public.stickers where kw <> '';
select count(*) as after_delete from public.stickers;
\echo '--- 9) 版本号：登录用户能读，匿名不能'
select public.chatter_schema() as schema;
reset role;
set role anon; select public.chatter_schema(); reset role;
\echo '--- 10) 文件上限'
select file_size_limit from storage.buckets where id='chat-media';
