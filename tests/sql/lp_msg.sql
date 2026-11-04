select pg_sleep(0.6);
insert into public.messages (conv_key, from_acc, to_acc, type, body) values (public.conv_key_of('alice','bob'),'alice','bob','text','长轮询测试');
