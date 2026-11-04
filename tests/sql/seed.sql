-- 测试数据：三个账号（alice、bob 互为好友；carol 是外人）
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'), ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
insert into public.profiles (id, account_id, nickname) values ('11111111-1111-1111-1111-111111111111','alice','Alice'),('22222222-2222-2222-2222-222222222222','bob','Bob'),('33333333-3333-3333-3333-333333333333','carol','Carol');
insert into public.friendships (owner_acc, friend_acc) values ('alice','bob'),('bob','alice');
