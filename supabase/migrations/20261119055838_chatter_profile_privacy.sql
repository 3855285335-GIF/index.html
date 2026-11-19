begin;
set local lock_timeout = '5s';

-- Table-level SELECT overrides per-column restrictions.
revoke select on public.profiles from public, anon, authenticated;
grant select (id, account_id, nickname, avatar_url, signature, created_at,
              bg_url, cover_url, bubble_color)
  on public.profiles to anon, authenticated;

-- Bootstrap already returns the caller's own private fields. The device check
-- needs a narrow endpoint to read the current value without reloading bootstrap.
create function public.my_kick_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select p.kick_at from public.profiles p where p.id = (select auth.uid());
$$;
revoke execute on function public.my_kick_at() from public, anon, authenticated;
grant execute on function public.my_kick_at() to authenticated;

alter publication supabase_realtime drop table public.profiles;
alter publication supabase_realtime add table public.profiles (id, account_id, nickname, avatar_url,
  signature, created_at, bg_url, cover_url, bubble_color);

commit;
