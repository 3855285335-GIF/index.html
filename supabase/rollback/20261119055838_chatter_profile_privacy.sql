begin;
set local lock_timeout = '5s';

revoke select (id, account_id, nickname, avatar_url, signature, created_at,
               bg_url, cover_url, bubble_color)
  on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
drop function public.my_kick_at();

alter publication supabase_realtime drop table public.profiles;
alter publication supabase_realtime add table public.profiles;

commit;
