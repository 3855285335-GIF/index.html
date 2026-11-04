\set ON_ERROR_STOP off
\echo '--- anon (GitHub 定时任务用的身份) 调用签到'
set role anon;
select public.keepalive() as first_call;
select public.keepalive() as second_call_within_1min;
\echo '--- anon 直接读表（应该被拒绝）'
select * from public.keepalive_state;
\echo '--- anon 直接改表（应该被拒绝）'
update public.keepalive_state set pings = 999;
reset role;
\echo '--- 模拟 2 分钟后再签到：计数应 +1'
update public.keepalive_state set last_ping = now() - interval '2 minutes';
set role anon;
select public.keepalive() as after_2min;
reset role;
\echo '--- 登录用户也能调用'
set role authenticated;
select (public.keepalive())->>'ok' as authed_ok;
reset role;
\echo '--- 表里只有一行'
select count(*) as rows, max(pings) as pings from public.keepalive_state;
\echo '--- 原有数据没有被动'
select count(*) as profiles from public.profiles;
