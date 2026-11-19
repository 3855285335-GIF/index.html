-- 11-19 SQL ③：收回两个旧函数的调用权限（可以重复运行）
-- 打开 https://supabase.com/dashboard/project/uaoiqbxptnbrvkzjwguc/sql/new ，整份粘贴，点右下角“Run”（运行）；
-- 弹出“Potential issue detected with your query”（检测到查询可能有问题）时点“Run this query”（运行此查询）。
-- 整份在一个事务里：任何一步出错都会全部撤销，什么都不改。最后显示一张检查表，每行都是“是”就对了。
--
-- 为什么要收：
--   register_user：不用登录就能直接建一个“已确认”的账号，绕过注册的频率限制，账号名和密码也不检查。
--   account_exists：不用登录就能查某个账号存不存在。
--   App 现在都不用这两个（注册走 Supabase 自带的注册），收回后注册、登录照常。
-- 撤销：supabase/rollback/20261119124000_chatter_revoke_old_rpcs.sql
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

-- ========== 检查表 ==========
create temp table if not exists _chatter_1119r (序号 int, 项目 text, 结果 text) on commit preserve rows;
truncate _chatter_1119r;
insert into _chatter_1119r
select 1, '没登录的人不能再“直接建账号”', case when to_regprocedure('public.register_user(text,text,text)') is null
  or not has_function_privilege('anon', 'public.register_user(text,text,text)', 'execute') then '是' else '否' end
union all select 2, '登录的人也不能用这个旧函数', case when to_regprocedure('public.register_user(text,text,text)') is null
  or not has_function_privilege('authenticated', 'public.register_user(text,text,text)', 'execute') then '是' else '否' end
union all select 3, '没登录的人不能再查“账号存不存在”', case when to_regprocedure('public.account_exists(text)') is null
  or (not has_function_privilege('anon', 'public.account_exists(text)', 'execute')
      and not has_function_privilege('authenticated', 'public.account_exists(text)', 'execute')) then '是' else '否' end
union all select 4, '保活照常能用', case when to_regprocedure('public.keepalive()') is not null
  and has_function_privilege('anon', 'public.keepalive()', 'execute') then '是' else '否' end
union all select 5, '正常注册要用的“自动建资料”还在', case when exists (select 1 from pg_trigger
  where tgname = 'on_auth_user_created' and not tgisinternal) then '是' else '否' end;
commit;

select 序号, 项目, 结果 from _chatter_1119r order by 序号;
