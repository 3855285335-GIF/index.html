begin;
set local lock_timeout = '5s';
drop function if exists public.bootstrap_contacts();
-- 有人已经使用时保留设置，以便重新启用时恢复。好友关系和聊天记录均独立于此表。
do $$
begin
  if to_regclass('public.contacts_only_chats') is not null then
    revoke all on public.contacts_only_chats from public, anon, authenticated;
    if not exists (select from public.contacts_only_chats) then drop table public.contacts_only_chats; end if;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
