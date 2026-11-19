-- 撤销 20261119124000_chatter_revoke_old_rpcs：把两个旧函数的调用权限还回去（恢复成以前谁都能调用）
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.register_user(text,text,text)') is not null then
    grant execute on function public.register_user(text, text, text) to public, anon, authenticated;
  end if;
  if to_regprocedure('public.account_exists(text)') is not null then
    grant execute on function public.account_exists(text) to public, anon, authenticated;
  end if;
end $$;
commit;
