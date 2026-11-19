begin;
set local lock_timeout = '5s';

create table if not exists public.contacts_only_chats (
  owner_acc text not null,
  friend_acc text not null,
  primary key (owner_acc, friend_acc),
  foreign key (owner_acc, friend_acc) references public.friendships(owner_acc, friend_acc) on delete cascade,
  check (owner_acc <> friend_acc)
);
alter table public.contacts_only_chats enable row level security;
revoke all on public.contacts_only_chats from public, anon, authenticated;
grant select, insert, delete on public.contacts_only_chats to authenticated;

drop policy if exists contacts_only_owner on public.contacts_only_chats;
create policy contacts_only_owner on public.contacts_only_chats to authenticated
  using (owner_acc = (select public.my_acc()))
  with check (owner_acc = (select public.my_acc()));

-- 一次请求取回账号数据和自己的显示设置，首屏即可过滤。
create or replace function public.bootstrap_contacts()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.bootstrap() || jsonb_build_object('contacts_only', coalesce(
    (select jsonb_agg(friend_acc order by friend_acc) from public.contacts_only_chats
      where owner_acc = (select public.my_acc())), '[]'::jsonb))
$$;
revoke all on function public.bootstrap_contacts() from public, anon;
grant execute on function public.bootstrap_contacts() to authenticated;
notify pgrst, 'reload schema';
commit;


select
  to_regclass('public.contacts_only_chats') is not null as "好友显示设置表已建立",
  (select relrowsecurity from pg_class where oid = 'public.contacts_only_chats'::regclass) as "已启用按账号隔离",
  has_table_privilege('authenticated', 'public.contacts_only_chats', 'SELECT')
    and not has_table_privilege('anon', 'public.contacts_only_chats', 'SELECT') as "须登录才能读取",
  not has_table_privilege('authenticated', 'public.contacts_only_chats', 'TRUNCATE') as "手机不能清空设置",
  not has_function_privilege('anon', 'public.bootstrap_contacts()', 'EXECUTE') as "匿名不能调用新入口";
