-- 11-19 晚：收回两个早期留下、App 已经不用的旧函数的调用权限
-- register_user(账号, 密码, 名字)：不用登录就能直接往登录系统里写一个“已确认”的账号，绕过注册频率限制，也不检查格式
-- account_exists(账号)：不用登录就能查某个账号存不存在
-- App 注册用的是 Supabase 自带的 sb.auth.signUp，不受影响。函数本身不删，撤销脚本可以原样恢复。
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.register_user(text,text,text)') is not null then
    revoke execute on function public.register_user(text, text, text) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.account_exists(text)') is not null then
    revoke execute on function public.account_exists(text) from public, anon, authenticated;
  end if;
end $$;
commit;
