-- Chatter 2026-11-14 晚 新增数据库改动（已在本项目执行过；给审查用）
-- 1) 消息：编辑时间、视频封面
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists cover text;

-- 2) 会话：跨设备草稿
alter table public.conversations add column if not exists draft text;

-- 3) 资料：气泡颜色、登录设备、踢下线时间
alter table public.profiles alter column bubble_color set default 'violet';
update public.profiles set bubble_color = 'violet' where bubble_color is null;
alter table public.profiles add column if not exists devices jsonb default '{}'::jsonb;
alter table public.profiles add column if not exists kick_at timestamptz;

-- 4) 朋友圈：自定义视频封面
alter table public.moments add column if not exists cover text;

-- 5) 群公告历史
create table if not exists public.group_notices (
  id bigserial primary key,
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  body text not null,
  author_acc text,
  created_at timestamptz not null default now()
);
alter table public.group_notices enable row level security;
grant select on public.group_notices to authenticated;
revoke all on public.group_notices from anon;
drop policy if exists gn_sel on public.group_notices;
create policy gn_sel on public.group_notices for select to authenticated
  using (exists (select 1 from public.chat_group_members m where m.group_id = public.group_notices.group_id and m.account_id = public.my_acc()));

create or replace function public.log_group_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.notice is distinct from old.notice and coalesce(new.notice, '') <> '' then
    insert into public.group_notices(group_id, body, author_acc) values (new.id, new.notice, public.my_acc());
  end if;
  return new;
end $$;
drop trigger if exists trg_log_group_notice on public.chat_groups;
create trigger trg_log_group_notice after update of notice on public.chat_groups
  for each row execute function public.log_group_notice();

-- 6) 群链接：加入、取群信息
create or replace function public.join_group_by_link(p_gid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc(); cnt int;
begin
  if me is null then return 'auth'; end if;
  if not exists (select 1 from public.chat_groups where id = p_gid) then return 'nogroup'; end if;
  if exists (select 1 from public.chat_group_members where group_id = p_gid and account_id = me) then return 'member'; end if;
  select count(*) into cnt from public.chat_group_members where group_id = p_gid;
  if cnt >= 100 then return 'full'; end if;
  insert into public.chat_group_members(group_id, account_id, role) values (p_gid, me, 'member');
  return 'ok';
end $$;
revoke all on function public.join_group_by_link(uuid) from public, anon;
grant execute on function public.join_group_by_link(uuid) to authenticated;

create or replace function public.group_link_info(p_gid uuid) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'name', g.name,
    'avatar', g.avatar_url,
    'count', (select count(*) from public.chat_group_members m where m.group_id = g.id),
    'member', exists(select 1 from public.chat_group_members m where m.group_id = g.id and m.account_id = public.my_acc())
  ) from public.chat_groups g where g.id = p_gid;
$$;
revoke all on function public.group_link_info(uuid) from public, anon;
grant execute on function public.group_link_info(uuid) to authenticated;

-- 7) 实时发布（之前就有，这里补记）
-- alter publication supabase_realtime add table public.profiles;
-- alter publication supabase_realtime add table public.conversations;
-- alter publication supabase_realtime add table public.user_mutes;

-- 8) 登录设备（独立表：只有本人能读自己的设备）
create table if not exists public.user_devices (
  account text not null,
  device_id text not null,
  ua text,
  last_at timestamptz not null default now(),
  primary key (account, device_id)
);
alter table public.user_devices enable row level security;
grant select, insert, update, delete on public.user_devices to authenticated;
revoke all on public.user_devices from anon, public;
create policy ud_sel on public.user_devices for select to authenticated using (account = public.my_acc());
create policy ud_ins on public.user_devices for insert to authenticated with check (account = public.my_acc());
create policy ud_upd on public.user_devices for update to authenticated using (account = public.my_acc()) with check (account = public.my_acc());
create policy ud_del on public.user_devices for delete to authenticated using (account = public.my_acc());
-- 9) 消息更新守卫：允许发送者 1 分钟内改正文；撤回逻辑不变
CREATE OR REPLACE FUNCTION public.messages_before_update() RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  if new.conv_key <> old.conv_key or new.from_acc <> old.from_acc or new.to_acc <> old.to_acc or new.created_at <> old.created_at then
    raise exception 'immutable fields';
  end if;
  if old.type = 'recalled' then raise exception 'already recalled'; end if;
  if new.type = old.type then
    if old.from_acc <> public.my_acc() then raise exception 'not yours'; end if;
    if now() - old.created_at > interval '1 minute' then raise exception 'edit window passed'; end if;
    if new.cover is distinct from old.cover then raise exception 'only body edit'; end if;
    return new;
  end if;
  if new.type <> 'recalled' then raise exception 'only recall is allowed'; end if;
  if now() - old.created_at > interval '2 minutes 15 seconds' then raise exception 'recall window passed'; end if;
  new.id := old.id; new.conv_key := old.conv_key; new.from_acc := old.from_acc;
  new.to_acc := old.to_acc; new.created_at := old.created_at; new.dur := old.dur;
  new.type := 'recalled'; new.body := '';
  return new;
end $function$;
-- 10) 修正：策略可重跑 + 编辑守卫收紧（只允许文字、数据库写编辑时间）
drop policy if exists ud_sel on public.user_devices;
drop policy if exists ud_ins on public.user_devices;
drop policy if exists ud_upd on public.user_devices;
drop policy if exists ud_del on public.user_devices;
create policy ud_sel on public.user_devices for select to authenticated using (account = public.my_acc());
create policy ud_ins on public.user_devices for insert to authenticated with check (account = public.my_acc());
create policy ud_upd on public.user_devices for update to authenticated using (account = public.my_acc()) with check (account = public.my_acc());
create policy ud_del on public.user_devices for delete to authenticated using (account = public.my_acc());

CREATE OR REPLACE FUNCTION public.messages_before_update() RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  if new.id <> old.id or new.conv_key <> old.conv_key or new.from_acc <> old.from_acc or new.to_acc <> old.to_acc
     or new.created_at <> old.created_at or new.dur is distinct from old.dur then
    raise exception 'immutable fields';
  end if;
  if old.type = 'recalled' then raise exception 'already recalled'; end if;
  if new.type = old.type then
    if old.type <> 'text' then raise exception 'only text editable'; end if;
    if old.from_acc <> public.my_acc() then raise exception 'not yours'; end if;
    if now() - old.created_at > interval '1 minute' then raise exception 'edit window passed'; end if;
    if new.cover is distinct from old.cover or new.mentions is distinct from old.mentions then raise exception 'only body edit'; end if;
    new.edited_at := now();
    return new;
  end if;
  if new.type <> 'recalled' then raise exception 'only recall is allowed'; end if;
  if now() - old.created_at > interval '2 minutes 15 seconds' then raise exception 'recall window passed'; end if;
  new.id := old.id; new.conv_key := old.conv_key; new.from_acc := old.from_acc;
  new.to_acc := old.to_acc; new.created_at := old.created_at; new.dur := old.dur;
  new.type := 'recalled'; new.body := '';
  return new;
end $function$;