\set ON_ERROR_STOP off
create function t_as(u uuid) returns void language plpgsql as $$ begin perform set_config('app.uid', u::text, false); end $$;
\echo '--- alice sends to bob'
set role authenticated;
select t_as('11111111-1111-1111-1111-111111111111');
insert into public.messages (conv_key, from_acc, to_acc, type, body) values (public.conv_key_of('alice','bob'),'alice','bob','text','hi');
select 'alice sees peer_read (expect NULL/ok):', public.peer_read(public.conv_key_of('alice','bob'));
\echo '--- bob unread, then mark_read'
select t_as('22222222-2222-2222-2222-222222222222');
select 'bob unread before:', unread from public.conversations where owner_acc='bob';
select public.mark_read(public.conv_key_of('alice','bob'));
select 'bob unread after:', unread, last_read_ts is not null as has_ts from public.conversations where owner_acc='bob';
\echo '--- alice reads bob last_read_ts'
select t_as('11111111-1111-1111-1111-111111111111');
select 'alice peer_read (expect non-null):', public.peer_read(public.conv_key_of('alice','bob')) is not null as ok;
\echo '--- carol (outsider) must get NULL'
select t_as('33333333-3333-3333-3333-333333333333');
select 'carol peer_read (expect NULL):', public.peer_read(public.conv_key_of('alice','bob')) is null as ok;
select 'carol mark_read on others conv changes nothing:'; select public.mark_read(public.conv_key_of('alice','bob'));
reset role;
select 'alice conv untouched by carol:', last_read_ts from public.conversations where owner_acc='alice';
\echo '--- anon cannot execute'
set role anon; select public.peer_read('x');
reset role;
\echo '--- storage: list/delete only own folder'
insert into storage.objects (bucket_id, name, metadata) values ('chat-media','alice/1_a.jpg','{"size":100}'),('chat-media','alice/2_b.jpg','{"size":200}'),('chat-media','bob/1_c.jpg','{"size":300}');
set role authenticated;
select t_as('11111111-1111-1111-1111-111111111111');
select 'alice sees files:', count(*) from storage.objects where bucket_id='chat-media';
delete from storage.objects where bucket_id='chat-media' and name='bob/1_c.jpg';
delete from storage.objects where bucket_id='chat-media' and name='alice/1_a.jpg';
reset role;
select 'remaining (expect alice/2_b.jpg, bob/1_c.jpg):', string_agg(name, ',' order by name) from storage.objects;
