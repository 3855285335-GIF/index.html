-- Temporary local Supabase only. Never execute against the production project.
begin;
create table public.test_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_id text not null unique
);
revoke all on public.test_accounts from public, anon, authenticated;
grant all on public.test_accounts to service_role;
create or replace function public.my_acc()
returns text language sql stable security definer set search_path = '' as $$
  select a.account_id from public.test_accounts a where a.user_id = (select auth.uid()) limit 1
$$;
create or replace function public.session_alive()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.my_acc() is not null
$$;
create table public.app_config(key text primary key, value jsonb not null);
grant select on public.app_config to authenticated;
grant all on public.app_config to service_role;
create table public.chat_group_members (
  group_id uuid not null,
  account_id text not null,
  primary key (group_id,account_id)
);
alter table public.chat_group_members enable row level security;
create policy test_member on public.chat_group_members for select to authenticated
  using (account_id = (select public.my_acc()));
grant select on public.chat_group_members to authenticated;
grant all on public.chat_group_members to service_role;
create table public.messages (
  id uuid primary key,
  conv_key text not null,
  from_acc text not null,
  to_acc text not null,
  type text not null,
  body text not null default ''
);
alter table public.messages enable row level security;
create policy test_message_read on public.messages for select to authenticated
  using (
    from_acc = (select public.my_acc())
    or to_acc = (select public.my_acc())
    or (to_acc = conv_key and exists (
      select 1 from public.chat_group_members g
      where g.group_id = substring(conv_key from '^g:([a-f0-9-]+)$')::uuid
        and g.account_id = (select public.my_acc())
    ))
  );
create policy test_message_insert on public.messages for insert to authenticated
  with check (from_acc = (select public.my_acc()));
grant select,insert on public.messages to authenticated;
grant all on public.messages to service_role;
grant usage on schema public to authenticated, service_role;
grant execute on function public.my_acc(), public.session_alive() to authenticated, service_role;
insert into storage.buckets(id,name,public)
values('chat-media','chat-media',true)
on conflict(id)do nothing;
commit;
