\set ON_ERROR_STOP off
\echo '--- 登录用户能读到配置（顺序：ExpressTURN 在前）'
set role authenticated; select set_config('app.uid','11111111-1111-1111-1111-111111111111',false);
select jsonb_array_length(value->'turn') as n, value->'turn'->0->>'name' as first, value->'turn'->0->'urls'->>0 as url0 from public.app_config where key='ice';
\echo '--- 登录用户不能改（应报错）'
update public.app_config set value='{}' where key='ice';
insert into public.app_config values ('x','{}');
reset role;
\echo '--- 匿名不能读（应报错或读不到）'
set role anon; select count(*) from public.app_config; reset role;
