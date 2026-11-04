-- ============================================================
-- Chatter 后端脚本 v2（可重复执行，幂等）
-- 用法：Supabase 控制台 → SQL Editor → 新建 Query → 整段粘贴 → Run
--
-- ⚠️ 第 2 步会清除这 5 张表上【已有的所有 RLS 策略】再重建，
--    如果你手工加过别的策略，请先备份。
-- 这版比上一版新增：bootstrap() 一次拉全数据、conversations.unread 服务端未读数、
--    realtime.messages 策略（通话信令 / 极速消息通道必须有它）。
-- ============================================================


-- ========== 1. 建表 / 补列 ==========
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  account_id  text unique not null,
  nickname    text,
  avatar_url  text,
  created_at  timestamptz default now()
);
alter table public.profiles add column if not exists avatar_url text;

create table if not exists public.friend_requests (
  id         uuid primary key default gen_random_uuid(),
  from_acc   text not null,
  to_acc     text not null,
  from_name  text,
  status     text not null default 'pending',
  created_at timestamptz default now(),
  unique (from_acc, to_acc)
);
alter table public.friend_requests add column if not exists from_name text;
alter table public.friend_requests add column if not exists status text not null default 'pending';

create table if not exists public.friendships (
  owner_acc  text not null,
  friend_acc text not null,
  created_at timestamptz default now(),
  primary key (owner_acc, friend_acc)
);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  conv_key   text not null,
  from_acc   text not null,
  to_acc     text not null,
  type       text not null default 'text',
  body       text default '',
  dur        integer,
  created_at timestamptz not null default now()
);
alter table public.messages add column if not exists dur integer;
create index if not exists messages_conv_created_idx on public.messages (conv_key, created_at desc);
create index if not exists messages_to_idx on public.messages (to_acc, created_at desc);

create table if not exists public.conversations (
  owner_acc    text not null,
  conv_key     text not null,
  peer_acc     text,
  last_body    text,
  last_ts      timestamptz default now(),
  last_read_ts timestamptz,
  unread       integer not null default 0,
  primary key (owner_acc, conv_key)
);
alter table public.conversations add column if not exists peer_acc text;
alter table public.conversations add column if not exists last_body text;
alter table public.conversations add column if not exists last_ts timestamptz default now();
alter table public.conversations add column if not exists last_read_ts timestamptz;
alter table public.conversations add column if not exists unread integer not null default 0;
create unique index if not exists conversations_owner_conv_uniq on public.conversations (owner_acc, conv_key);
create unique index if not exists friendships_owner_friend_uniq on public.friendships (owner_acc, friend_acc);
create index if not exists friend_requests_to_idx on public.friend_requests (to_acc, status);

-- 旧数据：把未读数按 last_read_ts 重新算一遍（只算一次，之后由触发器维护）
update public.conversations c
   set unread = coalesce((
     select count(*) from public.messages m
      where m.conv_key = c.conv_key and m.to_acc = c.owner_acc
        and m.type not in ('recalled','call')
        and (c.last_read_ts is null or m.created_at > c.last_read_ts)
   ), 0)
 where c.unread = 0;


-- ========== 2. 清空旧策略，开启 RLS ==========
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','friend_requests','friendships','messages','conversations')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.profiles        enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships     enable row level security;
alter table public.messages        enable row level security;
alter table public.conversations   enable row level security;


-- ========== 3. 工具函数 ==========
create or replace function public.my_acc()
returns text language sql stable security definer set search_path = public as $$
  select account_id from public.profiles where id = auth.uid()
$$;

create or replace function public.conv_key_of(a text, b text)
returns text language sql immutable as $$
  select case when (a collate "C") < (b collate "C") then a || '::' || b else b || '::' || a end
$$;

create or replace function public.account_exists(p_acc text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where account_id = lower(trim(p_acc)))
$$;


-- ========== 4. RPC ==========
drop function if exists public.accept_friend_request(uuid);
drop function if exists public.accept_friend_request(bigint);
drop function if exists public.accept_friend_request(integer);
drop function if exists public.accept_friend_request(text);
drop function if exists public.remove_friendship(text, text);
drop function if exists public.send_friend_request(text);
drop function if exists public.bootstrap();

-- 一次请求拿回：我的档案、好友档案、会话（含未读数）、会话对方档案、待处理好友请求
create function public.bootstrap()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me text := public.my_acc();
  res jsonb;
begin
  if me is null then return null; end if;
  select jsonb_build_object(
    'me', (select to_jsonb(p) - 'created_at' from public.profiles p where p.account_id = me),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'nickname', p.nickname, 'avatar_url', p.avatar_url))
                           from public.friendships f join public.profiles p on p.account_id = f.friend_acc
                          where f.owner_acc = me), '[]'::jsonb),
    'convs', coalesce((select jsonb_agg(to_jsonb(c) order by c.last_ts desc nulls last)
                         from (select conv_key, peer_acc, last_body, last_ts, last_read_ts, unread
                                 from public.conversations where owner_acc = me
                                 order by last_ts desc nulls last limit 200) c), '[]'::jsonb),
    'peers', coalesce((select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'nickname', p.nickname, 'avatar_url', p.avatar_url))
                         from public.profiles p
                        where p.account_id in (select peer_acc from public.conversations where owner_acc = me)), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc)
                            from (select id, from_acc, to_acc, from_name, status, created_at
                                    from public.friend_requests where to_acc = me and status = 'pending') r), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create function public.accept_friend_request(p_req_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me text := public.my_acc();
  r  record;
  k  text;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select * into r from public.friend_requests
   where id::text = p_req_id and to_acc = me and status = 'pending';
  if not found then raise exception 'request not found'; end if;

  update public.friend_requests set status = 'accepted' where id::text = p_req_id;

  insert into public.friendships (owner_acc, friend_acc)
  values (me, r.from_acc), (r.from_acc, me)
  on conflict do nothing;

  k := public.conv_key_of(me, r.from_acc);
  insert into public.conversations (owner_acc, conv_key, peer_acc)
  values (me, k, r.from_acc), (r.from_acc, k, me)
  on conflict do nothing;
end $$;

create function public.send_friend_request(p_to text)
returns text language plpgsql security definer set search_path = public as $$
declare
  me   text := public.my_acc();
  tgt  text := lower(trim(p_to));
  rid  text;
  r    record;
  nick text;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if tgt = me then return 'self'; end if;
  if not exists (select 1 from public.profiles where account_id = tgt) then return 'notfound'; end if;
  if exists (select 1 from public.friendships where owner_acc = me and friend_acc = tgt) then return 'friends'; end if;

  select id::text into rid from public.friend_requests
   where from_acc = tgt and to_acc = me and status = 'pending' limit 1;
  if found then
    perform public.accept_friend_request(rid);
    return 'accepted';
  end if;

  select nickname into nick from public.profiles where account_id = me;

  select * into r from public.friend_requests where from_acc = me and to_acc = tgt limit 1;
  if found then
    if r.status = 'pending' then return 'exists'; end if;
    update public.friend_requests set status = 'pending', from_name = nick, created_at = now() where id = r.id;
    return 'ok';
  end if;

  insert into public.friend_requests (from_acc, to_acc, from_name, status)
  values (me, tgt, nick, 'pending');
  return 'ok';
end $$;

create function public.remove_friendship(p_me text, p_peer text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then raise exception 'not authenticated'; end if;
  delete from public.friendships
   where (owner_acc = me and friend_acc = p_peer) or (owner_acc = p_peer and friend_acc = me);
  delete from public.friend_requests
   where (from_acc = me and to_acc = p_peer) or (from_acc = p_peer and to_acc = me);
end $$;

revoke all on function public.bootstrap()                   from public, anon;
revoke all on function public.accept_friend_request(text)   from public, anon;
revoke all on function public.send_friend_request(text)     from public, anon;
revoke all on function public.remove_friendship(text,text)  from public, anon;
grant execute on function public.bootstrap()                    to authenticated;
grant execute on function public.accept_friend_request(text)    to authenticated;
grant execute on function public.send_friend_request(text)      to authenticated;
grant execute on function public.remove_friendship(text,text)   to authenticated;
grant execute on function public.account_exists(text)           to anon, authenticated;
grant execute on function public.my_acc()                       to authenticated;


-- ========== 5. RLS 策略 ==========
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy fr_select on public.friend_requests for select to authenticated
  using (to_acc = public.my_acc() or from_acc = public.my_acc());
create policy fr_update on public.friend_requests for update to authenticated
  using (to_acc = public.my_acc()) with check (to_acc = public.my_acc());

create policy fs_select on public.friendships for select to authenticated
  using (owner_acc = public.my_acc());

create policy msg_select on public.messages for select to authenticated
  using (from_acc = public.my_acc() or to_acc = public.my_acc());
create policy msg_insert on public.messages for insert to authenticated
  with check (
    from_acc = public.my_acc()
    and exists (select 1 from public.friendships f
                where f.owner_acc = messages.from_acc and f.friend_acc = messages.to_acc)
  );
create policy msg_update on public.messages for update to authenticated
  using (from_acc = public.my_acc()) with check (from_acc = public.my_acc());

create policy conv_select on public.conversations for select to authenticated using (owner_acc = public.my_acc());
create policy conv_insert on public.conversations for insert to authenticated with check (owner_acc = public.my_acc());
create policy conv_update on public.conversations for update to authenticated
  using (owner_acc = public.my_acc()) with check (owner_acc = public.my_acc());


-- ========== 6. 触发器 ==========
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.profiles (id, account_id, nickname)
    values (
      new.id,
      lower(coalesce(new.raw_user_meta_data->>'account_id', 'user_' || left(new.id::text, 6))),
      coalesce(new.raw_user_meta_data->>'nickname', '新用户')
    )
    on conflict do nothing;
  exception when others then
    null;
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.messages_before_insert()
returns trigger language plpgsql as $$
begin
  new.conv_key := public.conv_key_of(new.from_acc, new.to_acc);
  if new.type not in ('text','image','voice','call') then
    raise exception 'invalid message type';
  end if;
  if new.type = 'text' and length(coalesce(new.body,'')) > 5000 then
    raise exception 'message too long';
  end if;
  new.body := coalesce(new.body, '');
  return new;
end $$;

drop trigger if exists trg_messages_before_insert on public.messages;
create trigger trg_messages_before_insert before insert on public.messages
  for each row execute function public.messages_before_insert();

create or replace function public.messages_before_update()
returns trigger language plpgsql as $$
begin
  if old.type = 'recalled' then raise exception 'already recalled'; end if;
  if new.type <> 'recalled' then raise exception 'only recall is allowed'; end if;
  if now() - old.created_at > interval '2 minutes 15 seconds' then
    raise exception 'recall window passed';
  end if;
  new.id := old.id; new.conv_key := old.conv_key; new.from_acc := old.from_acc;
  new.to_acc := old.to_acc; new.created_at := old.created_at; new.dur := old.dur;
  new.type := 'recalled'; new.body := '';
  return new;
end $$;

drop trigger if exists trg_messages_before_update on public.messages;
create trigger trg_messages_before_update before update on public.messages
  for each row execute function public.messages_before_update();

-- 新消息 → 同步双方会话行；接收方未读 +1（通话记录不计未读）
create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare prev text; inc integer;
begin
  prev := case new.type
            when 'text'  then left(coalesce(new.body, ''), 200)
            when 'image' then '[图片]'
            when 'voice' then '[语音]'
            when 'call'  then '[通话]'
            else '[消息]'
          end;
  inc := case when new.type = 'call' then 0 else 1 end;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, last_read_ts, unread)
  values (new.from_acc, new.conv_key, new.to_acc, prev, new.created_at, new.created_at, 0)
  on conflict (owner_acc, conv_key) do update
    set last_body = excluded.last_body, last_ts = excluded.last_ts,
        last_read_ts = excluded.last_read_ts, peer_acc = excluded.peer_acc, unread = 0;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, unread)
  values (new.to_acc, new.conv_key, new.from_acc, prev, new.created_at, inc)
  on conflict (owner_acc, conv_key) do update
    set last_body = excluded.last_body, last_ts = excluded.last_ts,
        peer_acc = excluded.peer_acc, unread = public.conversations.unread + inc;

  return new;
end $$;

drop trigger if exists trg_messages_after_insert on public.messages;
create trigger trg_messages_after_insert after insert on public.messages
  for each row execute function public.messages_after_insert();

-- 撤回 → 未读数 -1（若这条还没被读），最后一条被撤回则预览改成 [已撤回]
create or replace function public.messages_after_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'recalled' and old.type <> 'recalled' then
    update public.conversations
       set unread = greatest(unread - 1, 0)
     where owner_acc = new.to_acc and conv_key = new.conv_key
       and old.type <> 'call' and unread > 0
       and (last_read_ts is null or old.created_at > last_read_ts);
    update public.conversations
       set last_body = '[已撤回]'
     where conv_key = new.conv_key and last_ts = new.created_at;
  end if;
  return new;
end $$;

drop trigger if exists trg_messages_after_update on public.messages;
create trigger trg_messages_after_update after update on public.messages
  for each row execute function public.messages_after_update();


-- ========== 7. Realtime：数据库变更推送 ==========
do $$
declare t text;
begin
  foreach t in array array['messages','conversations','friendships','friend_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ========== 8. Realtime：私有广播通道（通话信令 / 极速消息；频道名 u:<账号>）==========
-- 没有这两条策略，通话和"几乎同步"的极速消息通道都会被拒绝。
drop policy if exists chatter_rt_receive on realtime.messages;
create policy chatter_rt_receive on realtime.messages
  for select to authenticated
  using ( realtime.topic() = 'u:' || public.my_acc() );

drop policy if exists chatter_rt_send on realtime.messages;
create policy chatter_rt_send on realtime.messages
  for insert to authenticated
  with check ( realtime.topic() like 'u:%' );


-- ========== 9. Storage：图片 / 语音桶 ==========
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-media', 'chat-media', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

drop policy if exists "chat-media insert own" on storage.objects;
create policy "chat-media insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.my_acc());

-- 完成 ✅
