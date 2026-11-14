-- Chatter 全部 SQL（按修改时间排序，含安全/免打扰/置顶补丁）

-- ============================================================
-- group-diagnose.sql
-- ============================================================
-- ============================================================
-- 群聊改造 · 第一步：只读诊断（不改任何数据）
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run
--      把结果里的每一行文字复制回来（4 行：COLS / POLICIES / TRIGGERS / FUNCTIONS）
-- 目的：看清群表策略、messages 上的触发器、群聊函数的真实定义，避免猜
-- ============================================================

with cols as (
  select coalesce(string_agg(
           table_name || '.' || column_name || ' ' || data_type ||
           case when is_nullable = 'NO' then ' not null' else '' end,
           E'\n' order by table_name, ordinal_position), '(无)') as d
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('chat_groups', 'chat_group_members', 'messages', 'conversations')
),
pol as (
  select coalesce(string_agg(
           tablename || ' [' || policyname || ' ' || cmd || ']' ||
           case when qual is not null then ' USING ' || qual else '' end ||
           case when with_check is not null then ' CHECK ' || with_check else '' end,
           E'\n'), '(无)') as d
  from pg_policies
  where schemaname = 'public'
    and tablename in ('chat_groups', 'chat_group_members', 'messages', 'conversations')
),
trg as (
  select coalesce(string_agg(pg_get_triggerdef(t.oid), E'\n'), '(无)') as d
  from pg_trigger t
  where t.tgrelid = 'public.messages'::regclass
    and not t.tgisinternal
),
fn as (
  select coalesce(string_agg(p.proname || E':\n' || pg_get_functiondef(p.oid), E'\n\n'), '(无)') as d
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('messages_before_insert', 'messages_after_insert', 'messages_after_update',
                      'send_group_msg', 'is_group_member', 'is_group_owner', 'my_acc')
)
select 'COLS' as k, d from cols
union all select 'POLICIES', d from pol
union all select 'TRIGGERS_messages', d from trg
union all select 'FUNCTIONS', d from fn;


-- ============================================================
-- diag-2.sql
-- ============================================================
select c.relname, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('chat_groups','chat_group_members','messages','conversations')
order by 1;

select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename in ('chat_groups','chat_group_members')
order by tablename, policyname;

select t.tgname, pg_get_triggerdef(t.oid) as def
from pg_trigger t
where t.tgrelid='public.chat_groups'::regclass and not t.tgisinternal;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public' and table_name in ('chat_groups','chat_group_members')
order by table_name, grantee, privilege_type;


-- ============================================================
-- group-patch-v1.sql
-- ============================================================
-- ============================================================
-- 群聊改造补丁 v1（幂等：可以重复执行）
-- 作用：
--   1. 群消息的 conv_key 保持 g:<群id>（原来被触发器改写，导致发送失败）
--   2. 群消息写入时给每个群成员更新会话行、未读数
--   3. 入群/退群自动建/删该成员的会话行
--   4. 撤回群消息时成员未读数 -1
--   5. 允许删除自己的会话行、群主解散群
-- 不改任何已有数据，只清理历史坏行（g:xxx::账号 这种）
-- ============================================================
begin;

-- ---------- 0. 清理历史坏数据（旧触发器写坏的会话键） ----------
delete from public.conversations where conv_key like 'g:%::%';
delete from public.conversations where owner_acc like 'g:%';
delete from public.messages      where conv_key like 'g:%::%';

-- ---------- 1. 插入消息：群消息保留 conv_key = to_acc ----------
create or replace function public.messages_before_insert()
returns trigger language plpgsql as $fn$
begin
  if left(coalesce(new.conv_key, ''), 2) = 'g:' and new.conv_key = new.to_acc then
    new.conv_key := new.to_acc;              -- 群聊：conv_key 就是 g:<群id>
  else
    new.conv_key := public.conv_key_of(new.from_acc, new.to_acc);
  end if;
  if new.type not in ('text','image','voice','call','sticker','video','file') then
    raise exception 'invalid message type';
  end if;
  if new.type = 'text' and length(coalesce(new.body,'')) > 5000 then
    raise exception 'message too long';
  end if;
  if new.type in ('sticker','video') and length(coalesce(new.body,'')) > 500 then
    raise exception 'body too long';
  end if;
  if new.type = 'file' then
    if length(coalesce(new.body,'')) > 1000 then raise exception 'body too long'; end if;
    begin
      if jsonb_typeof(new.body::jsonb) <> 'object' or coalesce(new.body::jsonb ->> 'u', '') = '' then
        raise exception 'bad';
      end if;
    exception when others then
      raise exception 'invalid file body';
    end;
  end if;
  new.body := coalesce(new.body, '');
  return new;
end $fn$;

-- ---------- 2. 插入后：群消息交给 sync_conversation_on_message 统一处理 ----------
create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare prev text; inc integer;
begin
  if left(new.conv_key, 2) = 'g:' then return new; end if;   -- 群聊：见 sync_conversation_on_message
  prev := case new.type
            when 'text'    then left(coalesce(new.body, ''), 200)
            when 'image'   then '[图片]'
            when 'voice'   then '[语音]'
            when 'call'    then '[通话]'
            when 'sticker' then '[表情]'
            when 'video'   then '[视频]'
            when 'file'    then '[文件] ' || left(coalesce(new.body::jsonb ->> 'n', ''), 60)
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
end $fn$;

-- ---------- 3. 撤回：群消息给每个成员的未读 -1 ----------
create or replace function public.messages_after_update()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if new.type = 'recalled' and old.type <> 'recalled' then
    if left(new.conv_key, 2) = 'g:' then
      update public.conversations
         set unread = greatest(unread - 1, 0)
       where conv_key = new.conv_key
         and owner_acc <> new.from_acc
         and old.type <> 'call' and unread > 0
         and (last_read_ts is null or old.created_at > last_read_ts);
    else
      update public.conversations
         set unread = greatest(unread - 1, 0)
       where owner_acc = new.to_acc and conv_key = new.conv_key
         and old.type <> 'call' and unread > 0
         and (last_read_ts is null or old.created_at > last_read_ts);
    end if;
    update public.conversations
       set last_body = '[已撤回]'
     where conv_key = new.conv_key and last_ts = new.created_at;
  end if;
  return new;
end $fn$;

-- ---------- 4. 会话同步：群消息给每个成员写会话行+未读 ----------
create or replace function public.sync_conversation_on_message()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_preview text;
  v_inc     integer;
  v_gid     uuid;
begin
  v_preview := case new.type
    when 'text'    then substr(coalesce(new.body, ''), 1, 50)
    when 'image'   then '[图片]'
    when 'voice'   then '[语音]'
    when 'call'    then '[通话]'
    when 'sticker' then '[表情]'
    when 'video'   then '[视频]'
    when 'file'    then '[文件] ' || left(coalesce(new.body::jsonb ->> 'n', ''), 60)
    else ''
  end;
  v_inc := case when new.type = 'call' then 0 else 1 end;

  if left(new.conv_key, 2) = 'g:' then
    v_gid := substring(new.conv_key from 3)::uuid;
    insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, unread)
    select m.account_id, new.conv_key, new.conv_key, v_preview, new.created_at,
           case when m.account_id = new.from_acc then 0 else v_inc end
      from public.chat_group_members m
     where m.group_id = v_gid
    on conflict (owner_acc, conv_key) do update
      set last_body = excluded.last_body,
          last_ts   = excluded.last_ts,
          peer_acc  = excluded.peer_acc,
          unread    = case when excluded.owner_acc = new.from_acc then 0
                           else conversations.unread + v_inc end;
    return new;
  end if;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts)
  values (new.from_acc, new.conv_key, new.to_acc, v_preview, new.created_at)
  on conflict (owner_acc, conv_key) do update set last_body = excluded.last_body, last_ts = excluded.last_ts;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts)
  values (new.to_acc, new.conv_key, new.from_acc, v_preview, new.created_at)
  on conflict (owner_acc, conv_key) do update set last_body = excluded.last_body, last_ts = excluded.last_ts;

  return new;
end $fn$;

-- ---------- 5. 入群：自动建这个人的会话行（带上群里最后一条消息的预览） ----------
create or replace function public.group_member_conv()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_prev text;
  v_ts   timestamptz;
begin
  select case m.type
           when 'text'    then left(coalesce(m.body, ''), 50)
           when 'image'   then '[图片]'
           when 'voice'   then '[语音]'
           when 'call'    then '[通话]'
           when 'sticker' then '[表情]'
           when 'video'   then '[视频]'
           when 'file'    then '[文件] ' || left(coalesce(m.body::jsonb ->> 'n', ''), 60)
           else '[消息]'
         end,
         m.created_at
    into v_prev, v_ts
    from public.messages m
   where m.conv_key = 'g:' || new.group_id
   order by m.created_at desc
   limit 1;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, unread)
  values (new.account_id, 'g:' || new.group_id, 'g:' || new.group_id, coalesce(v_prev, ''), v_ts, 0)
  on conflict (owner_acc, conv_key) do nothing;
  return new;
end $fn$;

drop trigger if exists trg_group_member_conv on public.chat_group_members;
create trigger trg_group_member_conv after insert on public.chat_group_members
  for each row execute function public.group_member_conv();

-- ---------- 6. 退群：自动删这个人的会话行 ----------
create or replace function public.group_member_cleanup()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  delete from public.conversations
   where owner_acc = old.account_id and conv_key = 'g:' || old.group_id;
  return old;
end $fn$;

drop trigger if exists trg_group_member_cleanup on public.chat_group_members;
create trigger trg_group_member_cleanup after delete on public.chat_group_members
  for each row execute function public.group_member_cleanup();

-- ---------- 7. 策略：删自己的会话行 / 群主解散群 ----------
drop policy if exists conv_delete on public.conversations;
create policy conv_delete on public.conversations for delete to authenticated
  using (owner_acc = public.my_acc());

drop policy if exists grp_del on public.chat_groups;
create policy grp_del on public.chat_groups for delete to authenticated
  using (owner_acc = public.my_acc());

-- ---------- 8. 索引：按会话查最新消息（群轮询/补预览用） ----------
create index if not exists messages_conv_created_idx on public.messages (conv_key, created_at desc);

-- ---------- 9. 给已有群成员补会话行（不会覆盖已有会话） ----------
insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, unread)
select m.account_id, 'g:' || m.group_id, 'g:' || m.group_id, x.prev, x.ts, 0
  from public.chat_group_members m
  left join lateral (
    select case msg.type
             when 'text'    then left(coalesce(msg.body, ''), 50)
             when 'image'   then '[图片]'
             when 'voice'   then '[语音]'
             when 'call'    then '[通话]'
             when 'sticker' then '[表情]'
             when 'video'   then '[视频]'
             when 'file'    then '[文件] ' || left(coalesce(msg.body::jsonb ->> 'n', ''), 60)
             else '[消息]'
           end as prev,
           msg.created_at as ts
      from public.messages msg
     where msg.conv_key = 'g:' || m.group_id
     order by msg.created_at desc
     limit 1
  ) x on true
on conflict (owner_acc, conv_key) do nothing;

commit;


-- ============================================================
-- cleanup-tests.sql
-- ============================================================
begin;

-- 本次测试建的群（两个）
delete from public.messages          where conv_key in ('g:677abd53-c34f-4922-aba7-7799e03572b0', 'g:4491a713-bdf6-419d-b542-ae647cc255e7');
delete from public.conversations     where conv_key in ('g:677abd53-c34f-4922-aba7-7799e03572b0', 'g:4491a713-bdf6-419d-b542-ae647cc255e7');
delete from public.chat_group_members where group_id in ('677abd53-c34f-4922-aba7-7799e03572b0', '4491a713-bdf6-419d-b542-ae647cc255e7');
delete from public.chat_groups       where id in ('677abd53-c34f-4922-aba7-7799e03572b0', '4491a713-bdf6-419d-b542-ae647cc255e7');

-- 探针会话 + 探针/测试账号的数据
delete from public.conversations where owner_acc = 'gvprobe_fdbvr';
delete from public.messages      where from_acc like 'gv%' or to_acc like 'gv%';
delete from public.messages      where conv_key not like 'g:%' and (from_acc in ('uitabtje','uitbbtje') or to_acc in ('uitabtje','uitbbtje'));
delete from public.conversations where owner_acc like 'gv%' or owner_acc in ('uitabtje','uitbbtje');
delete from public.chat_group_members where account_id like 'gv%';
delete from public.friendships   where owner_acc like 'gv%' or friend_acc like 'gv%';

-- 临时账号（保留 uitabtje / uitbbtje 供以后测试）
delete from public.profiles where account_id like 'gv%';
delete from auth.users     where email like 'gv%@chatter.local';

delete from public.friendships where owner_acc in ('uitaezad','uitagc7r','uitbezad') or friend_acc in ('uitaezad','uitagc7r','uitbezad');
delete from public.profiles   where account_id in ('uitaezad','uitagc7r','uitbezad');
delete from auth.users        where email in ('uitaezad@chatter.local','uitagc7r@chatter.local','uitbezad@chatter.local');

commit;


-- ============================================================
-- group-patch-v2.sql
-- ============================================================
-- ============================================================
-- 群聊补丁 v2（幂等，可重复执行）
-- 1. 群邀请需对方同意：group_invites + 邀请/接受/拒绝 RPC
-- 2. 收紧成员插入权限：只能加自己（且必须是群主/成员）；别人必须走“接受邀请”
-- 3. 群消息推送：push_job 支持 gmsg（一次推给所有离线群成员）
-- 4. 群邀请推送：push_job 支持 ginv
-- 5. 解散群时清理消息和会话；群人数上限 100
-- ============================================================
begin;

-- ---------- 1. 群邀请表 ----------
create table if not exists public.group_invites (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.chat_groups(id) on delete cascade,
  from_acc    text not null,
  to_acc      text not null,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  responded_at timestamptz
);
alter table public.group_invites drop constraint if exists group_invites_status_check;
alter table public.group_invites add constraint group_invites_status_check
  check (status in ('pending', 'accepted', 'declined'));
create unique index if not exists group_invites_pending_uniq
  on public.group_invites (group_id, to_acc) where status = 'pending';
create index if not exists group_invites_to_idx on public.group_invites (to_acc, status, created_at desc);
create index if not exists group_invites_group_idx on public.group_invites (group_id, status);

alter table public.group_invites enable row level security;

drop policy if exists gi_select on public.group_invites;
create policy gi_select on public.group_invites for select to authenticated
  using (to_acc = public.my_acc() or from_acc = public.my_acc() or public.is_group_member(group_id, public.my_acc()));

-- ---------- 2. 收紧成员插入：只能加自己（且得是群主或群成员） ----------
drop policy if exists cgm_ins on public.chat_group_members;
create policy cgm_ins on public.chat_group_members for insert to authenticated
  with check (account_id = public.my_acc()
              and (public.is_group_owner(group_id, public.my_acc()) or public.is_group_member(group_id, public.my_acc())));

-- ---------- 3. 邀请 RPC ----------
create or replace function public.invite_to_group(p_gid uuid, p_acc text)
returns uuid language plpgsql security definer set search_path = 'public' as $fn$
declare
  me  text := public.my_acc();
  cnt integer;
  iid uuid;
begin
  if me is null then raise exception '未登录'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  if p_acc = '' then raise exception '账号为空'; end if;
  if not public.is_group_member(p_gid, me) then raise exception '你不是这个群的成员'; end if;
  if not exists (select 1 from public.profiles where account_id = p_acc) then raise exception '账号不存在'; end if;
  if not exists (select 1 from public.friendships where owner_acc = me and friend_acc = p_acc) then
    raise exception '只能邀请好友';
  end if;
  if exists (select 1 from public.chat_group_members where group_id = p_gid and account_id = p_acc) then
    raise exception '对方已经在群里';
  end if;
  select count(*) into cnt from public.chat_group_members where group_id = p_gid;
  if cnt >= 100 then raise exception '群人数已满（最多 100 人）'; end if;

  insert into public.group_invites (group_id, from_acc, to_acc)
  values (p_gid, me, p_acc)
  on conflict do nothing
  returning id into iid;

  if iid is null then
    select id into iid from public.group_invites
     where group_id = p_gid and to_acc = p_acc and status = 'pending' limit 1;
  end if;

  -- 之前拒绝过：重新发一条新的邀请
  if iid is null then
    insert into public.group_invites (group_id, from_acc, to_acc)
    values (p_gid, me, p_acc)
    returning id into iid;
  end if;
  return iid;
end $fn$;

create or replace function public.my_group_invites()
returns jsonb language sql stable security definer set search_path = 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'group_id', i.group_id,
           'name', g.name,
           'from_acc', i.from_acc,
           'from_name', p.nickname,
           'created_at', i.created_at
         ) order by i.created_at desc), '[]'::jsonb)
    from public.group_invites i
    join public.chat_groups g on g.id = i.group_id
    left join public.profiles p on p.account_id = i.from_acc
   where i.to_acc = public.my_acc() and i.status = 'pending';
$fn$;

create or replace function public.accept_group_invite(p_id uuid)
returns uuid language plpgsql security definer set search_path = 'public' as $fn$
declare
  me  text := public.my_acc();
  inv record;
  cnt integer;
begin
  if me is null then raise exception '未登录'; end if;
  select * into inv from public.group_invites
   where id = p_id and to_acc = me and status = 'pending'
   for update;
  if not found then raise exception '邀请不存在或已处理'; end if;
  if not exists (select 1 from public.chat_groups where id = inv.group_id) then
    update public.group_invites set status = 'declined', responded_at = now() where id = p_id;
    raise exception '群已经不存在';
  end if;
  select count(*) into cnt from public.chat_group_members where group_id = inv.group_id;
  if cnt >= 100 and not exists (select 1 from public.chat_group_members where group_id = inv.group_id and account_id = me) then
    raise exception '群人数已满（最多 100 人）';
  end if;
  insert into public.chat_group_members (group_id, account_id, role)
  values (inv.group_id, me, 'member')
  on conflict do nothing;
  update public.group_invites set status = 'accepted', responded_at = now()
   where group_id = inv.group_id and to_acc = me and status = 'pending';
  return inv.group_id;
end $fn$;

create or replace function public.decline_group_invite(p_id uuid)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare me text := public.my_acc();
begin
  if me is null then raise exception '未登录'; end if;
  update public.group_invites set status = 'declined', responded_at = now()
   where id = p_id and to_acc = me and status = 'pending';
end $fn$;

revoke all on function public.invite_to_group(uuid, text)   from public, anon;
revoke all on function public.my_group_invites()            from public, anon;
revoke all on function public.accept_group_invite(uuid)     from public, anon;
revoke all on function public.decline_group_invite(uuid)    from public, anon;
grant execute on function public.invite_to_group(uuid, text) to authenticated;
grant execute on function public.my_group_invites()          to authenticated;
grant execute on function public.accept_group_invite(uuid)   to authenticated;
grant execute on function public.decline_group_invite(uuid)  to authenticated;

-- ---------- 4. 解散群时清理消息/会话 ----------
create or replace function public.group_delete_cleanup()
returns trigger language plpgsql security definer set search_path = 'public' as $fn$
begin
  delete from public.messages      where conv_key = 'g:' || old.id;
  delete from public.conversations where conv_key = 'g:' || old.id;
  return old;
end $fn$;

drop trigger if exists trg_group_delete_cleanup on public.chat_groups;
create trigger trg_group_delete_cleanup after delete on public.chat_groups
  for each row execute function public.group_delete_cleanup();

-- ---------- 5. push_job：群消息 / 群邀请推送 ----------
create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text; tgt text; nm text; t text; b text; h text; tag text; url text; lref text;
  ttl integer := 86400; n integer; vid boolean; subs jsonb; m record; r record;
  gid uuid; gname text; sender text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;
  if p_kind not in ('msg', 'call', 'miss', 'req', 'test', 'gmsg', 'ginv') then return jsonb_build_object('skip', 'kind'); end if;

  -- 群消息：一次推给群里所有离线成员（不含发送者）
  if p_kind = 'gmsg' then
    if p_to is null or left(p_to, 2) <> 'g:' then return jsonb_build_object('skip', 'to'); end if;
    begin gid := substring(p_to from 3)::uuid; exception when others then return jsonb_build_object('skip', 'to'); end;
    if not public.is_group_member(gid, me) then return jsonb_build_object('skip', 'member'); end if;
    select * into m from public.messages
     where id::text = p_ref and conv_key = p_to and from_acc = me
       and created_at > now() - interval '3 minutes';
    if not found then return jsonb_build_object('skip', 'ref'); end if;
    if m.type not in ('text', 'image', 'voice', 'sticker', 'video', 'file') then return jsonb_build_object('skip', 'type'); end if;
    select name into gname from public.chat_groups where id = gid;
    if gname is null then return jsonb_build_object('skip', 'ref'); end if;
    sender := coalesce(nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);
    b := case m.type
           when 'text'    then left(btrim(regexp_replace(regexp_replace(coalesce(m.body, ''), '^\u2063Q[^\u2063]*\u2063[^\u2063]*\u2063', ''), '[\s\u2063]+', ' ', 'g')), 120)
           when 'image'   then '[图片]'
           when 'voice'   then '[语音]'
           when 'sticker' then '[表情]'
           when 'video'   then '[视频]'
           else '[文件] ' || left(coalesce(m.body::jsonb ->> 'n', ''), 60)
         end;
    b := sender || '：' || b;
    h := sender || ' 发来一条群消息';
    select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
      into subs
      from public.push_subs s
      join public.chat_group_members gm on gm.account_id = s.acc
     where gm.group_id = gid and s.acc <> me
       and gm.joined_at <= m.created_at
       and not exists (select 1 from public.presence pr
                        where pr.account_id = s.acc and pr.last_seen > now() - interval '75 seconds');
    if subs is null then return jsonb_build_object('skip', 'nosub'); end if;
    delete from public.push_log where at < now() - interval '1 hour';
    insert into public.push_log (ref, from_acc, to_acc)
    values ('g:' || m.id::text, me, p_to) on conflict (ref) do nothing;
    if not found then return jsonb_build_object('skip', 'dup'); end if;
    return jsonb_build_object('subs', subs, 'title', gname, 'body', b, 'hidden', h,
      'tag', 'g:' || gid, 'url', './#g=' || gid, 'ttl', ttl, 'kind', 'gmsg', 'from', me);
  end if;

  -- 群邀请
  if p_kind = 'ginv' then
    tgt := p_to;
    if tgt is null or tgt = '' then return jsonb_build_object('skip', 'to'); end if;
    if not exists (select 1 from public.friendships where owner_acc = tgt and friend_acc = me) then
      return jsonb_build_object('skip', 'friend');
    end if;
    if exists (select 1 from public.presence pr where pr.account_id = tgt and pr.last_seen > now() - interval '75 seconds') then
      return jsonb_build_object('skip', 'online');
    end if;
    select * into r from public.group_invites
     where id::text = p_ref and from_acc = me and to_acc = tgt and status = 'pending'
       and created_at > now() - interval '10 minutes';
    if not found then return jsonb_build_object('skip', 'ref'); end if;
    select name into gname from public.chat_groups where id = r.group_id;
    sender := coalesce(nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);
    select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
      into subs from public.push_subs s where s.acc = tgt;
    if subs is null then return jsonb_build_object('skip', 'nosub'); end if;
    delete from public.push_log where at < now() - interval '1 hour';
    insert into public.push_log (ref, from_acc, to_acc)
    values ('i:' || r.id::text, me, tgt) on conflict (ref) do nothing;
    if not found then return jsonb_build_object('skip', 'dup'); end if;
    return jsonb_build_object('subs', subs, 'title', '群邀请',
      'body', sender || ' 邀请你加入「' || coalesce(gname, '群聊') || '」',
      'hidden', sender || ' 邀请你加入一个群', 'tag', 'i:' || r.id, 'url', './#inv',
      'ttl', ttl, 'kind', 'ginv', 'from', me);
  end if;

  tgt := case when p_kind = 'test' then me else p_to end;
  if tgt is null or tgt = '' then return jsonb_build_object('skip', 'to'); end if;
  if p_kind = 'test' or p_kind = 'req' then null;
  elsif not exists (select 1 from public.friendships where owner_acc = tgt and friend_acc = me) then
    return jsonb_build_object('skip', 'friend');
  end if;
  if p_kind <> 'test' and exists (select 1 from public.presence where account_id = tgt and last_seen > now() - interval '75 seconds') then
    return jsonb_build_object('skip', 'online');
  end if;
  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
    into subs from public.push_subs s where s.acc = tgt;
  if subs is null then return jsonb_build_object('skip', 'nosub'); end if;

  nm := coalesce(nullif(btrim((select remark from public.friendships where owner_acc = tgt and friend_acc = me)), ''),
                 nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);

  if p_kind = 'msg' then
    select * into m from public.messages
     where id::text = p_ref and from_acc = me and to_acc = tgt and created_at > now() - interval '3 minutes';
    if not found then return jsonb_build_object('skip', 'ref'); end if;
    if m.type not in ('text', 'image', 'voice', 'sticker', 'video', 'file') then return jsonb_build_object('skip', 'type'); end if;
    b := case m.type
           when 'text'    then left(btrim(regexp_replace(regexp_replace(coalesce(m.body, ''), '^\u2063Q[^\u2063]*\u2063[^\u2063]*\u2063', ''), '[\s\u2063]+', ' ', 'g')), 120)
           when 'image'   then '[图片]'
           when 'voice'   then '[语音]'
           when 'sticker' then '[表情]'
           when 'video'   then '[视频]'
           else '[文件] ' || left(coalesce(m.body::jsonb ->> 'n', ''), 60)
         end;
    h := '发来一条新消息';
    select unread into n from public.conversations where owner_acc = tgt and conv_key = m.conv_key;
    if coalesce(n, 0) > 1 then b := '[' || n || '条] ' || b; h := '发来 ' || n || ' 条新消息'; end if;
    t := nm; tag := 'm:' || me; url := './#c=' || me; lref := 'm:' || m.id::text;
  elsif p_kind = 'call' then
    select s.payload into r from public.signals s
     where s.from_acc = me and s.to_acc = tgt and s.payload ->> 't' = 'invite' and s.payload ->> 'id' = p_ref
       and s.created_at > now() - interval '60 seconds'
     limit 1;
    if not found then return jsonb_build_object('skip', 'ref'); end if;
    vid := coalesce(r.payload ->> 'video', 'false') = 'true';
    t := nm; b := case when vid then '📹 邀请你视频通话' else '📞 邀请你语音通话' end; h := b;
    tag := 'c:' || me; url := './#call=' || me; ttl := 45; lref := 'c:' || p_ref;
  elsif p_kind = 'miss' then
    if not exists (select 1 from public.push_log where ref = 'c:' || p_ref and from_acc = me and to_acc = tgt) then
      return jsonb_build_object('skip', 'nocall');
    end if;
    t := nm; b := '[未接来电] 刚才给你打过电话'; h := b;
    tag := 'c:' || me; url := './#c=' || me; lref := 'x:' || p_ref;
  elsif p_kind = 'req' then
    select * into r from public.friend_requests
     where from_acc = me and to_acc = tgt and status = 'pending' and created_at > now() - interval '10 minutes'
     limit 1;
    if not found then return jsonb_build_object('skip', 'ref'); end if;
    nm := coalesce(nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);
    t := '新的好友请求'; b := nm || '（' || me || '）请求加你为好友'; h := b;
    tag := 'r:' || me; url := './#req'; lref := 'r:' || r.id::text || ':' || floor(extract(epoch from r.created_at))::bigint;
  else  -- test：发给自己，10 秒内只能发一次
    t := 'Chatter'; b := '通知已开启 ✅ 以后有新消息、来电都会这样提醒你'; h := b;
    tag := 'test'; url := './'; ttl := 120; lref := 't:' || me || ':' || floor(extract(epoch from now()) / 10)::bigint;
  end if;

  delete from public.push_log where at < now() - interval '1 hour';
  insert into public.push_log (ref, from_acc, to_acc) values (lref, me, tgt) on conflict (ref) do nothing;
  if not found then return jsonb_build_object('skip', 'dup'); end if;

  return jsonb_build_object(
    'subs', subs, 'title', t, 'body', b, 'hidden', h, 'tag', tag, 'url', url, 'ttl', ttl,
    'kind', p_kind, 'from', me,
    'badge', (select coalesce(sum(unread), 0) from public.conversations where owner_acc = tgt));
end $fn$;

commit;


-- ============================================================
-- group-patch-v3.sql
-- ============================================================
-- 文字消息上限从 5000 放宽到 20000（群聊/单聊都生效）
begin;

create or replace function public.messages_before_insert()
returns trigger language plpgsql as $fn$
begin
  if left(coalesce(new.conv_key, ''), 2) = 'g:' and new.conv_key = new.to_acc then
    new.conv_key := new.to_acc;
  else
    new.conv_key := public.conv_key_of(new.from_acc, new.to_acc);
  end if;
  if new.type not in ('text','image','voice','call','sticker','video','file') then
    raise exception 'invalid message type';
  end if;
  if new.type = 'text' and length(coalesce(new.body,'')) > 20000 then
    raise exception 'message too long';
  end if;
  if new.type in ('sticker','video') and length(coalesce(new.body,'')) > 500 then
    raise exception 'body too long';
  end if;
  if new.type = 'file' then
    if length(coalesce(new.body,'')) > 1000 then raise exception 'body too long'; end if;
    begin
      if jsonb_typeof(new.body::jsonb) <> 'object' or coalesce(new.body::jsonb ->> 'u', '') = '' then
        raise exception 'bad';
      end if;
    exception when others then
      raise exception 'invalid file body';
    end;
  end if;
  new.body := coalesce(new.body, '');
  return new;
end $fn$;

commit;


-- ============================================================
-- profile-signature-v1.sql
-- ============================================================
-- ============================================================
-- 个性签名补丁 v1（幂等，可重复执行）
-- profiles.signature 已存在于当前库；本文件用于新库/重建时补齐。
-- 前端：我 → 编辑 → 修改个性签名；资料卡显示。
-- ============================================================
begin;

alter table public.profiles add column if not exists signature text;
alter table public.profiles alter column signature set default '这个人很懒，什么都没写';

commit;


-- ============================================================
-- profile-signature-v2.sql
-- ============================================================
-- ============================================================
-- 个性签名补丁 v2（幂等）：bootstrap 返回好友/会话对端的签名
-- 这样打开资料卡时能先用缓存直接显示，不用等网络。
-- ============================================================
begin;

create or replace function public.bootstrap()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  me text := public.my_acc();
  res jsonb;
begin
  if me is null then return null; end if;
  select jsonb_build_object(
    'me', (select to_jsonb(p) - 'created_at' from public.profiles p where p.account_id = me),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'signature', p.signature))
                           from public.friendships f join public.profiles p on p.account_id = f.friend_acc
                          where f.owner_acc = me), '[]'::jsonb),
    'convs', coalesce((select jsonb_agg(to_jsonb(c) order by c.last_ts desc nulls last)
                         from (select conv_key, peer_acc, last_body, last_ts, last_read_ts, unread
                                 from public.conversations where owner_acc = me
                                 order by last_ts desc nulls last limit 200) c), '[]'::jsonb),
    'peers', coalesce((select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'nickname', p.nickname, 'avatar_url', p.avatar_url, 'signature', p.signature))
                         from public.profiles p
                        where p.account_id in (select peer_acc from public.conversations where owner_acc = me)), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc)
                            from (select id, from_acc, to_acc, from_name, status, created_at
                                    from public.friend_requests where to_acc = me and status = 'pending') r), '[]'::jsonb)
  ) into res;
  return res;
end $function$;

commit;


-- ============================================================
-- moments-v1.sql
-- ============================================================
-- ============================================================
-- 朋友圈 v1（幂等）：文字 + 最多 9 图、仅好友可见、点赞、评论
-- ============================================================
begin;

create table if not exists public.moments (
  id          uuid primary key default gen_random_uuid(),
  author_acc  text not null,
  body        text not null default '',
  images      jsonb not null default '[]'::jsonb,
  visibility  text not null default 'friends',
  created_at  timestamptz not null default now(),
  constraint moments_body_len check (char_length(body) <= 1000),
  constraint moments_images_len check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 9),
  constraint moments_vis_check check (visibility in ('friends', 'private'))
);
create index if not exists moments_created_idx on public.moments (created_at desc);
create index if not exists moments_author_idx on public.moments (author_acc, created_at desc);

create table if not exists public.moment_likes (
  moment_id  uuid not null references public.moments(id) on delete cascade,
  account_id text not null,
  created_at timestamptz not null default now(),
  primary key (moment_id, account_id)
);
create index if not exists moment_likes_acc_idx on public.moment_likes (account_id);

create table if not exists public.moment_comments (
  id         uuid primary key default gen_random_uuid(),
  moment_id  uuid not null references public.moments(id) on delete cascade,
  author_acc text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  constraint moment_comments_len check (char_length(body) between 1 and 300)
);
create index if not exists moment_comments_moment_idx on public.moment_comments (moment_id, created_at);

alter table public.moments enable row level security;
alter table public.moment_likes enable row level security;
alter table public.moment_comments enable row level security;

create or replace function public.can_see_moment(p_moment uuid, p_acc text)
returns boolean language sql stable security definer set search_path = 'public' as $fn$
  select exists (
    select 1 from public.moments m
     where m.id = p_moment
       and (
         m.author_acc = p_acc
         or (m.visibility = 'friends' and exists (
           select 1 from public.friendships f
            where f.owner_acc = p_acc and f.friend_acc = m.author_acc
         ))
       )
  );
$fn$;

drop policy if exists moments_select on public.moments;
create policy moments_select on public.moments for select to authenticated
  using (author_acc = public.my_acc() or (visibility = 'friends' and exists (
    select 1 from public.friendships f
     where f.owner_acc = public.my_acc() and f.friend_acc = moments.author_acc
  )));

drop policy if exists moments_insert on public.moments;
create policy moments_insert on public.moments for insert to authenticated
  with check (author_acc = public.my_acc());

drop policy if exists moments_update on public.moments;
create policy moments_update on public.moments for update to authenticated
  using (author_acc = public.my_acc()) with check (author_acc = public.my_acc());

drop policy if exists moments_delete on public.moments;
create policy moments_delete on public.moments for delete to authenticated
  using (author_acc = public.my_acc());

drop policy if exists moment_likes_select on public.moment_likes;
create policy moment_likes_select on public.moment_likes for select to authenticated
  using (public.can_see_moment(moment_id, public.my_acc()));

drop policy if exists moment_likes_insert on public.moment_likes;
create policy moment_likes_insert on public.moment_likes for insert to authenticated
  with check (account_id = public.my_acc() and public.can_see_moment(moment_id, public.my_acc()));

drop policy if exists moment_likes_delete on public.moment_likes;
create policy moment_likes_delete on public.moment_likes for delete to authenticated
  using (account_id = public.my_acc());

drop policy if exists moment_comments_select on public.moment_comments;
create policy moment_comments_select on public.moment_comments for select to authenticated
  using (public.can_see_moment(moment_id, public.my_acc()));

drop policy if exists moment_comments_insert on public.moment_comments;
create policy moment_comments_insert on public.moment_comments for insert to authenticated
  with check (author_acc = public.my_acc() and public.can_see_moment(moment_id, public.my_acc()));

drop policy if exists moment_comments_delete on public.moment_comments;
create policy moment_comments_delete on public.moment_comments for delete to authenticated
  using (author_acc = public.my_acc() or exists (
    select 1 from public.moments m where m.id = moment_id and m.author_acc = public.my_acc()
  ));

revoke all on table public.moments, public.moment_likes, public.moment_comments from anon;
grant select, insert, update, delete on table public.moments, public.moment_likes, public.moment_comments to authenticated;
grant execute on function public.can_see_moment(uuid, text) to authenticated;

commit;


-- ============================================================
-- group-roles-v1.sql
-- ============================================================
-- ============================================================
-- 群角色 / 头衔 / 禁言 / 群图标补丁 v1（幂等，可重复执行）
-- 依赖：chat_group_members.role 已允许 owner/admin/member
-- ============================================================
begin;

-- ---------- 1. 字段 ----------
alter table public.chat_groups add column if not exists avatar_url text;
alter table public.chat_groups add column if not exists mute_all boolean not null default false;
alter table public.chat_group_members add column if not exists title text;
alter table public.chat_group_members add column if not exists title_on boolean not null default true;
alter table public.chat_group_members add column if not exists muted_until timestamptz;

-- ---------- 2. 群主设/撤管理员 ----------
create or replace function public.set_group_admin(p_gid uuid, p_acc text, p_on boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  target_role text;
begin
  if me is null then raise exception '未登录'; end if;
  if not public.is_group_owner(p_gid, me) then raise exception '只有群主可以设置管理员'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  if p_acc = '' or p_acc = me then raise exception '不能设置自己'; end if;
  select role into target_role from public.chat_group_members where group_id = p_gid and account_id = p_acc;
  if target_role is null then raise exception '对方不在群里'; end if;
  if target_role = 'owner' then raise exception '不能修改群主的身份'; end if;
  update public.chat_group_members
     set role = case when p_on then 'admin' else 'member' end
   where group_id = p_gid and account_id = p_acc;
end $fn$;

-- ---------- 3. 移出成员（群主/管理员） ----------
create or replace function public.kick_group_member(p_gid uuid, p_acc text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
  target_role text;
begin
  if me is null then raise exception '未登录'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  if p_acc = '' or p_acc = me then raise exception '退出群聊请用退出按钮'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  select role into target_role from public.chat_group_members where group_id = p_gid and account_id = p_acc;
  if target_role is null then raise exception '对方不在群里'; end if;
  if target_role = 'owner' then raise exception '不能移出群主'; end if;
  if me_role = 'admin' and target_role <> 'member' then raise exception '管理员只能移出普通成员'; end if;
  delete from public.chat_group_members where group_id = p_gid and account_id = p_acc;
end $fn$;

-- ---------- 4. 头衔：群主/管理员给成员设，成员自己决定戴不戴 ----------
create or replace function public.set_member_title(p_gid uuid, p_acc text, p_title text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
  target_role text;
  t text;
begin
  if me is null then raise exception '未登录'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  select role into target_role from public.chat_group_members where group_id = p_gid and account_id = p_acc;
  if target_role is null then raise exception '对方不在群里'; end if;
  if target_role = 'owner' then raise exception '群主不需要自定义头衔'; end if;
  t := btrim(coalesce(p_title, ''));
  if char_length(t) > 12 then raise exception '头衔最多 12 个字'; end if;
  update public.chat_group_members
     set title = nullif(t, ''),
         title_on = case when t = '' then false else title_on end
   where group_id = p_gid and account_id = p_acc;
end $fn$;

create or replace function public.set_title_visible(p_gid uuid, p_visible boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare me text := public.my_acc();
begin
  if me is null then raise exception '未登录'; end if;
  update public.chat_group_members
     set title_on = coalesce(p_visible, true)
   where group_id = p_gid and account_id = me;
  if not found then raise exception '你不在这个群里'; end if;
end $fn$;

-- ---------- 5. 禁言 ----------
create or replace function public.set_group_mute_all(p_gid uuid, p_on boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
begin
  if me is null then raise exception '未登录'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  update public.chat_groups set mute_all = coalesce(p_on, false) where id = p_gid;
end $fn$;

create or replace function public.set_group_member_mute(p_gid uuid, p_acc text, p_minutes integer)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
  target_role text;
  mins integer := coalesce(p_minutes, 0);
begin
  if me is null then raise exception '未登录'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  if p_acc = me then raise exception '不能禁言自己'; end if;
  select role into target_role from public.chat_group_members where group_id = p_gid and account_id = p_acc;
  if target_role is null then raise exception '对方不在群里'; end if;
  if target_role = 'owner' then raise exception '不能禁言群主'; end if;
  if me_role = 'admin' and target_role = 'admin' then raise exception '管理员不能禁言其他管理员'; end if;
  if mins > 10080 then mins := 10080; end if;
  update public.chat_group_members
     set muted_until = case when mins > 0 then now() + make_interval(mins => mins) else null end
   where group_id = p_gid and account_id = p_acc;
end $fn$;

-- 数据库层拦截：被禁言/全员禁言时不能发群消息
create or replace function public.group_mute_guard()
returns trigger language plpgsql security definer set search_path = 'public' as $fn$
declare
  gid uuid;
  me_role text;
  until timestamptz;
  all_mute boolean;
begin
  if new.conv_key is null or new.conv_key not like 'g:%' then return new; end if;
  begin
    gid := substring(new.conv_key from 3)::uuid;
  exception when others then
    return new;
  end;
  select role, muted_until into me_role, until
    from public.chat_group_members
   where group_id = gid and account_id = new.from_acc;
  if me_role is null then raise exception '你不是这个群的成员'; end if;
  select mute_all into all_mute from public.chat_groups where id = gid;
  if me_role <> 'owner'
     and ((coalesce(all_mute, false) and me_role <> 'admin')
          or (until is not null and until > now())) then
    raise exception '你已被禁言，暂时不能发消息';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_zz_group_mute_guard on public.messages;
create trigger trg_zz_group_mute_guard
  before insert on public.messages
  for each row execute function public.group_mute_guard();

-- ---------- 6. 群名 / 群图标 / 转让群主 ----------
create or replace function public.set_group_name(p_gid uuid, p_name text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
  n text := btrim(coalesce(p_name, ''));
begin
  if me is null then raise exception '未登录'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  if char_length(n) < 1 or char_length(n) > 20 then raise exception '群名称 1-20 个字'; end if;
  update public.chat_groups set name = n where id = p_gid;
end $fn$;

create or replace function public.set_group_avatar(p_gid uuid, p_url text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  me_role text;
  u text := btrim(coalesce(p_url, ''));
begin
  if me is null then raise exception '未登录'; end if;
  select role into me_role from public.chat_group_members where group_id = p_gid and account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '没有权限'; end if;
  if char_length(u) > 600 then raise exception '地址太长'; end if;
  update public.chat_groups set avatar_url = nullif(u, '') where id = p_gid;
end $fn$;

create or replace function public.transfer_group_owner(p_gid uuid, p_acc text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
  target_role text;
begin
  if me is null then raise exception '未登录'; end if;
  if not public.is_group_owner(p_gid, me) then raise exception '只有群主可以转让'; end if;
  p_acc := lower(btrim(coalesce(p_acc, '')));
  if p_acc = '' or p_acc = me then raise exception '请选择另一位成员'; end if;
  select role into target_role from public.chat_group_members where group_id = p_gid and account_id = p_acc;
  if target_role is null then raise exception '对方不在群里'; end if;
  update public.chat_groups set owner_acc = p_acc where id = p_gid;
  update public.chat_group_members set role = 'owner' where group_id = p_gid and account_id = p_acc;
  update public.chat_group_members set role = 'admin', muted_until = null where group_id = p_gid and account_id = me;
end $fn$;

-- ---------- 7. 权限：只给登录用户 ----------
revoke all on function public.set_group_admin(uuid, text, boolean) from public, anon;
revoke all on function public.kick_group_member(uuid, text) from public, anon;
revoke all on function public.set_member_title(uuid, text, text) from public, anon;
revoke all on function public.set_title_visible(uuid, boolean) from public, anon;
revoke all on function public.set_group_mute_all(uuid, boolean) from public, anon;
revoke all on function public.set_group_member_mute(uuid, text, integer) from public, anon;
revoke all on function public.set_group_name(uuid, text) from public, anon;
revoke all on function public.set_group_avatar(uuid, text) from public, anon;
revoke all on function public.transfer_group_owner(uuid, text) from public, anon;

grant execute on function public.set_group_admin(uuid, text, boolean) to authenticated;
grant execute on function public.kick_group_member(uuid, text) to authenticated;
grant execute on function public.set_member_title(uuid, text, text) to authenticated;
grant execute on function public.set_title_visible(uuid, boolean) to authenticated;
grant execute on function public.set_group_mute_all(uuid, boolean) to authenticated;
grant execute on function public.set_group_member_mute(uuid, text, integer) to authenticated;
grant execute on function public.set_group_name(uuid, text) to authenticated;
grant execute on function public.set_group_avatar(uuid, text) to authenticated;
grant execute on function public.transfer_group_owner(uuid, text) to authenticated;

commit;


-- ============================================================
-- moments-notify-v1.sql
-- ============================================================
-- 朋友圈未读互动：记录用户上次看朋友圈互动的时间
begin;
alter table public.profiles add column if not exists moments_seen_at timestamptz not null default now();
commit;


-- ============================================================
-- covers-v1.sql
-- ============================================================
-- ============================================================
-- 独立个人页/朋友圈封面 + 好友专属聊天背景跨设备同步
-- ============================================================
begin;

alter table public.profiles add column if not exists cover_url text;

create table if not exists public.chat_backgrounds (
  owner_acc  text not null,
  peer_acc   text not null,
  url        text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_acc, peer_acc)
);
create index if not exists chat_backgrounds_owner_idx on public.chat_backgrounds (owner_acc);

alter table public.chat_backgrounds enable row level security;

drop policy if exists chat_bg_select on public.chat_backgrounds;
create policy chat_bg_select on public.chat_backgrounds for select to authenticated
  using (owner_acc = public.my_acc());

drop policy if exists chat_bg_insert on public.chat_backgrounds;
create policy chat_bg_insert on public.chat_backgrounds for insert to authenticated
  with check (owner_acc = public.my_acc());

drop policy if exists chat_bg_update on public.chat_backgrounds;
create policy chat_bg_update on public.chat_backgrounds for update to authenticated
  using (owner_acc = public.my_acc()) with check (owner_acc = public.my_acc());

drop policy if exists chat_bg_delete on public.chat_backgrounds;
create policy chat_bg_delete on public.chat_backgrounds for delete to authenticated
  using (owner_acc = public.my_acc());

revoke all on table public.chat_backgrounds from anon;
grant select, insert, update, delete on table public.chat_backgrounds to authenticated;

commit;


-- ============================================================
-- group-call-v1.sql
-- ============================================================
-- ============================================================
-- 群语音 v1 补丁（4 人以内，前台）
-- 只负责“谁在房间里、谁静音了”；真正的语音走 WebRTC mesh，
-- 信令仍然复用现有的 signals 通道（bcast + dbSignal 兜底）。
-- 幂等：可重复执行。
-- 依赖：chat_groups / chat_group_members / my_acc() / is_group_member()
--
-- 心跳：客户端每 2.5 秒 group_call_touch 一次；30 秒没心跳的成员不算在房间里。
-- 浏览器崩了/直接关掉不会把房间卡死，下一个人进来会把这个房间收掉重开。
-- ============================================================
begin;

-- ---------- 1. 表 ----------
create table if not exists public.group_calls (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.chat_groups(id) on delete cascade,
  host_acc    text not null,
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index if not exists group_calls_active_idx on public.group_calls(group_id, created_at desc);

create table if not exists public.group_call_members (
  call_id     uuid not null references public.group_calls(id) on delete cascade,
  acc         text not null,
  joined_at   timestamptz not null default now(),
  seen_at     timestamptz not null default now(),
  left_at     timestamptz,
  muted       boolean not null default false,
  primary key (call_id, acc)
);
alter table public.group_call_members add column if not exists seen_at timestamptz not null default now();

-- ---------- 2. 只允许通过下面的函数访问，不给直接读写 ----------
alter table public.group_calls enable row level security;
alter table public.group_call_members enable row level security;
revoke all on table public.group_calls from anon, authenticated;
revoke all on table public.group_call_members from anon, authenticated;

-- ---------- 3. 发起 / 加入（同一个群同一时间只有一个房间） ----------
create or replace function public.group_call_join(p_gid uuid)
returns uuid language plpgsql security definer set search_path = 'public' as $fn$
declare
  me  text := public.my_acc();
  cid uuid;
  n   int;
begin
  if me is null then raise exception '未登录'; end if;
  if not public.is_group_member(p_gid, me) then raise exception '你不在这个群里'; end if;

  perform pg_advisory_xact_lock(hashtext('gcall:' || p_gid::text));   -- 两个人同时点“加入”也不会开出两个房

  select id into cid from public.group_calls
   where group_id = p_gid and ended_at is null
   order by created_at desc limit 1;

  -- 房间还在，但里面的人都没心跳了（浏览器崩了/断网）：收掉，重新开
  if cid is not null and not exists (
    select 1 from public.group_call_members m
     where m.call_id = cid and m.left_at is null and m.seen_at > now() - interval '30 seconds'
  ) then
    update public.group_calls set ended_at = now() where id = cid;
    cid := null;
  end if;

  if cid is null then
    insert into public.group_calls(group_id, host_acc) values (p_gid, me) returning id into cid;
  end if;

  -- 已经在房间里：只更新心跳
  if exists (select 1 from public.group_call_members where call_id = cid and acc = me and left_at is null) then
    update public.group_call_members set seen_at = now() where call_id = cid and acc = me;
    return cid;
  end if;

  select count(*) into n from public.group_call_members
   where call_id = cid and left_at is null and seen_at > now() - interval '30 seconds';
  if n >= 4 then raise exception '群语音最多 4 人，现在满了'; end if;

  insert into public.group_call_members(call_id, acc, muted, seen_at)
  values (cid, me, false, now())
  on conflict (call_id, acc) do update set left_at = null, joined_at = now(), muted = false, seen_at = now();

  return cid;
end $fn$;

-- ---------- 4. 心跳：客户端每 2.5 秒调一次 ----------
create or replace function public.group_call_touch(p_cid uuid)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
begin
  if me is null then raise exception '未登录'; end if;
  update public.group_call_members set seen_at = now()
   where call_id = p_cid and acc = me and left_at is null;
end $fn$;

-- ---------- 5. 主动离开；最后一个人走掉就结束房间 ----------
create or replace function public.group_call_leave(p_cid uuid)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
begin
  if me is null then raise exception '未登录'; end if;
  update public.group_call_members set left_at = now()
   where call_id = p_cid and acc = me and left_at is null;
  if not exists (select 1 from public.group_call_members where call_id = p_cid and left_at is null) then
    update public.group_calls set ended_at = now() where id = p_cid and ended_at is null;
  end if;
end $fn$;

-- ---------- 6. 静音状态（房间里其他人能看到谁闭麦了） ----------
create or replace function public.group_call_mute(p_cid uuid, p_muted boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me text := public.my_acc();
begin
  if me is null then raise exception '未登录'; end if;
  update public.group_call_members
     set muted = coalesce(p_muted, false), seen_at = now()
   where call_id = p_cid and acc = me and left_at is null;
end $fn$;

-- ---------- 7. 房间状态：前端在群里每 2-3 秒拉一次 ----------
create or replace function public.group_call_state(p_gid uuid)
returns jsonb language plpgsql security definer set search_path = 'public' as $fn$
declare
  me  text := public.my_acc();
  cid uuid;
  out jsonb;
begin
  if me is null then raise exception '未登录'; end if;
  if not public.is_group_member(p_gid, me) then raise exception '你不在这个群里'; end if;

  select id into cid from public.group_calls
   where group_id = p_gid and ended_at is null
   order by created_at desc limit 1;
  if cid is null then return 'null'::jsonb; end if;

  select jsonb_build_object(
    'id', c.id,
    'group_id', c.group_id,
    'host', c.host_acc,
    'created_at', c.created_at,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('acc', m.acc, 'muted', m.muted, 'joined_at', m.joined_at) order by m.joined_at)
        from public.group_call_members m
       where m.call_id = c.id and m.left_at is null and m.seen_at > now() - interval '30 seconds'
    ), '[]'::jsonb)
  ) into out
  from public.group_calls c where c.id = cid;

  -- 房间里一个活人都没有了：当作没在通话，客户端会结束；下次加入时会把这条收掉
  if out is null or jsonb_array_length(out -> 'members') = 0 then return 'null'::jsonb; end if;

  return out;
end $fn$;

-- ---------- 8. 授权：只给登录用户，匿名一律不给 ----------
revoke all on function public.group_call_join(uuid) from public, anon;
revoke all on function public.group_call_touch(uuid) from public, anon;
revoke all on function public.group_call_leave(uuid) from public, anon;
revoke all on function public.group_call_mute(uuid, boolean) from public, anon;
revoke all on function public.group_call_state(uuid) from public, anon;
grant execute on function public.group_call_join(uuid) to authenticated;
grant execute on function public.group_call_touch(uuid) to authenticated;
grant execute on function public.group_call_leave(uuid) to authenticated;
grant execute on function public.group_call_mute(uuid, boolean) to authenticated;
grant execute on function public.group_call_state(uuid) to authenticated;

commit;


-- ============================================================
-- moments-reply-v1.sql
-- ============================================================
-- ============================================================
-- 朋友圈评论回复 v1（幂等，可重复执行）
-- 加两列：回复给谁（reply_to_acc）、挂在哪条评论下面（parent_id）
-- ============================================================
begin;

alter table public.moment_comments add column if not exists parent_id uuid;
alter table public.moment_comments add column if not exists reply_to_acc text;
create index if not exists moment_comments_parent_idx on public.moment_comments(parent_id);

commit;


-- ============================================================
-- group-join-approval-v1.sql
-- ============================================================
-- ============================================================
-- 群加入审批 v1（幂等）
-- 群主/管理员可以打开「新成员需要同意」：被邀请的人点加入后
-- 不会直接进群，而是进入等待，由群主/管理员同意后才进。
-- ============================================================
begin;

alter table public.chat_groups add column if not exists join_approval boolean not null default false;
alter table public.group_invites add column if not exists approved_by text;
alter table public.group_invites add column if not exists approved_at timestamptz;
alter table public.group_invites drop constraint if exists group_invites_status_check;
alter table public.group_invites add constraint group_invites_status_check
  check (status in ('pending', 'waiting', 'accepted', 'declined'));

-- ---------- 1. 我收到的邀请：pending + waiting 都返回，带 status ----------
create or replace function public.my_group_invites()
returns jsonb language sql stable security definer set search_path = 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'group_id', i.group_id,
           'name', g.name,
           'from_acc', i.from_acc,
           'from_name', p.nickname,
           'created_at', i.created_at,
           'status', i.status
         ) order by i.created_at desc), '[]'::jsonb)
    from public.group_invites i
    join public.chat_groups g on g.id = i.group_id
    left join public.profiles p on p.account_id = i.from_acc
   where i.to_acc = public.my_acc() and i.status in ('pending', 'waiting');
$fn$;

-- ---------- 2. 接受邀请：需要审批的群先进 waiting ----------
create or replace function public.group_invite_accept(p_id uuid)
returns jsonb language plpgsql security definer set search_path = 'public' as $fn$
declare
  me   text := public.my_acc();
  inv  record;
  cnt  integer;
  need boolean;
begin
  if me is null then raise exception '未登录'; end if;
  select * into inv from public.group_invites
   where id = p_id and to_acc = me and status in ('pending', 'waiting')
   for update;
  if not found then raise exception '邀请不存在或已处理'; end if;
  if inv.status = 'waiting' then
    return jsonb_build_object('status', 'waiting', 'group_id', inv.group_id);
  end if;
  if not exists (select 1 from public.chat_groups where id = inv.group_id) then
    update public.group_invites set status = 'declined', responded_at = now() where id = p_id;
    raise exception '群已经不存在';
  end if;
  select count(*) into cnt from public.chat_group_members where group_id = inv.group_id;
  if cnt >= 100 then raise exception '群人数已满（最多 100 人）'; end if;

  select coalesce(g.join_approval, false) into need from public.chat_groups g where g.id = inv.group_id;
  if need then
    update public.group_invites set status = 'waiting', responded_at = now() where id = p_id;
    return jsonb_build_object('status', 'waiting', 'group_id', inv.group_id);
  end if;

  insert into public.chat_group_members (group_id, account_id, role)
  values (inv.group_id, me, 'member')
  on conflict do nothing;
  update public.group_invites set status = 'accepted', responded_at = now()
   where group_id = inv.group_id and to_acc = me and status = 'pending';
  return jsonb_build_object('status', 'joined', 'group_id', inv.group_id);
end $fn$;

-- 老版本客户端还会调 accept_group_invite：需要审批的群必须拦住，不能绕过
create or replace function public.accept_group_invite(p_id uuid)
returns uuid language plpgsql security definer set search_path = 'public' as $fn$
declare
  me   text := public.my_acc();
  inv  record;
  cnt  integer;
begin
  if me is null then raise exception '未登录'; end if;
  select * into inv from public.group_invites
   where id = p_id and to_acc = me and status = 'pending'
   for update;
  if not found then raise exception '邀请不存在或已处理'; end if;
  if exists (select 1 from public.chat_groups g where g.id = inv.group_id and g.join_approval) then
    raise exception '这个群需要群主或管理员同意才能加入，请更新页面后再试';
  end if;
  select count(*) into cnt from public.chat_group_members where group_id = inv.group_id;
  if cnt >= 100 then raise exception '群人数已满（最多 100 人）'; end if;
  insert into public.chat_group_members (group_id, account_id, role)
  values (inv.group_id, me, 'member') on conflict do nothing;
  update public.group_invites set status = 'accepted', responded_at = now()
   where group_id = inv.group_id and to_acc = me and status = 'pending';
  return inv.group_id;
end $fn$;

-- ---------- 3. 群主/管理员：开关 + 看待审批 + 同意/拒绝 ----------
create or replace function public.set_group_join_approval(p_gid uuid, p_on boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me   text := public.my_acc();
  me_role text;
begin
  if me is null then raise exception '未登录'; end if;
  select m.role into me_role from public.chat_group_members m where m.group_id = p_gid and m.account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '只有群主或管理员可以设置'; end if;
  update public.chat_groups set join_approval = coalesce(p_on, false) where id = p_gid;
end $fn$;

create or replace function public.group_join_requests(p_gid uuid)
returns jsonb language plpgsql security definer set search_path = 'public' as $fn$
declare
  me   text := public.my_acc();
  me_role text;
  out  jsonb;
begin
  if me is null then raise exception '未登录'; end if;
  select m.role into me_role from public.chat_group_members m where m.group_id = p_gid and m.account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '只有群主或管理员可以查看'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'acc', i.to_acc, 'name', p.nickname,
           'from_acc', i.from_acc, 'created_at', i.created_at) order by i.created_at), '[]'::jsonb)
    into out
    from public.group_invites i
    left join public.profiles p on p.account_id = i.to_acc
   where i.group_id = p_gid and i.status = 'waiting';
  return coalesce(out, '[]'::jsonb);
end $fn$;

create or replace function public.group_invite_approve(p_id uuid, p_ok boolean)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me   text := public.my_acc();
  inv  record;
  me_role text;
  cnt  integer;
begin
  if me is null then raise exception '未登录'; end if;
  select * into inv from public.group_invites where id = p_id and status = 'waiting' for update;
  if not found then raise exception '这条申请已经处理过了'; end if;
  select m.role into me_role from public.chat_group_members m where m.group_id = inv.group_id and m.account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '只有群主或管理员可以处理'; end if;

  if p_ok then
    select count(*) into cnt from public.chat_group_members where group_id = inv.group_id;
    if cnt >= 100 then raise exception '群人数已满（最多 100 人）'; end if;
    insert into public.chat_group_members (group_id, account_id, role)
    values (inv.group_id, inv.to_acc, 'member') on conflict do nothing;
    update public.group_invites
       set status = 'accepted', approved_by = me, approved_at = now(), responded_at = now()
     where id = p_id;
  else
    update public.group_invites
       set status = 'declined', approved_by = me, approved_at = now(), responded_at = now()
     where id = p_id;
  end if;
end $fn$;

-- ---------- 4. 授权 ----------
revoke all on function public.group_invite_accept(uuid) from public, anon;
revoke all on function public.set_group_join_approval(uuid, boolean) from public, anon;
revoke all on function public.group_join_requests(uuid) from public, anon;
revoke all on function public.group_invite_approve(uuid, boolean) from public, anon;
grant execute on function public.group_invite_accept(uuid) to authenticated;
grant execute on function public.set_group_join_approval(uuid, boolean) to authenticated;
grant execute on function public.group_join_requests(uuid) to authenticated;
grant execute on function public.group_invite_approve(uuid, boolean) to authenticated;

commit;


-- ============================================================
-- group-notice-mentions-v1.sql
-- ============================================================
-- ============================================================
-- 群公告 + @某人（幂等）
-- chat_groups.notice：群公告（最多 300 字，群主/管理员可发）
-- messages.mentions：这条消息 @ 了谁（JSON 数组 [{acc,name}]）
-- ============================================================
begin;

alter table public.chat_groups add column if not exists notice text;
alter table public.chat_groups add column if not exists notice_at timestamptz;
alter table public.chat_groups add column if not exists notice_by text;
alter table public.messages add column if not exists mentions jsonb;

create or replace function public.set_group_notice(p_gid uuid, p_text text)
returns void language plpgsql security definer set search_path = 'public' as $fn$
declare
  me      text := public.my_acc();
  me_role text;
  t       text;
begin
  if me is null then raise exception '未登录'; end if;
  select m.role into me_role from public.chat_group_members m where m.group_id = p_gid and m.account_id = me;
  if me_role is null or me_role not in ('owner', 'admin') then raise exception '只有群主或管理员可以发布群公告'; end if;
  t := btrim(coalesce(p_text, ''));
  if length(t) > 300 then raise exception '群公告最多 300 字'; end if;
  update public.chat_groups
     set notice = nullif(t, ''),
         notice_at = case when t = '' then null else now() end,
         notice_by = case when t = '' then null else me end
   where id = p_gid;
end $fn$;

revoke all on function public.set_group_notice(uuid, text) from public, anon;
grant execute on function public.set_group_notice(uuid, text) to authenticated;

commit;


-- ============================================================
-- moments-visibility-v1.sql
-- ============================================================
-- ============================================================
-- 朋友圈分组可见（幂等）
-- moments.visible_to：null = 全部好友；数组 = 只有这些人能看
-- ============================================================
begin;

alter table public.moments add column if not exists visible_to text[];

create or replace function public.can_see_moment(p_moment uuid, p_acc text)
returns boolean language sql stable security definer set search_path = 'public' as $fn$
  select exists (
    select 1 from public.moments m
     where m.id = p_moment
       and (
         m.author_acc = p_acc
         or (m.visibility = 'friends'
             and exists (select 1 from public.friendships f where f.owner_acc = p_acc and f.friend_acc = m.author_acc)
             and (m.visible_to is null or p_acc = any(m.visible_to)))
       )
  );
$fn$;

drop policy if exists moments_select on public.moments;
create policy moments_select on public.moments for select using (
  author_acc = public.my_acc()
  or (visibility = 'friends'
      and exists (select 1 from public.friendships f where f.owner_acc = public.my_acc() and f.friend_acc = moments.author_acc)
      and (visible_to is null or public.my_acc() = any(visible_to)))
);

commit;


-- ============================================================
-- moments-video-v1.sql
-- ============================================================
-- 朋友圈视频（幂等）：一条动态最多一个视频，存在 chat-media
begin;
alter table public.moments add column if not exists video text;
commit;


-- ============================================================
-- self-chat-v1.sql
-- ============================================================
-- ============================================================
-- 我的备忘：允许给自己发消息（幂等）
-- 只放开“发给自己的消息”，不影响好友/群的原有权限
-- ============================================================
begin;

drop policy if exists msg_self_ins on public.messages;
create policy msg_self_ins on public.messages
  for insert to authenticated
  with check (from_acc = public.my_acc() and to_acc = public.my_acc());

commit;


-- ============================================================
-- group-files-v1.sql
-- ============================================================
-- ============================================================
-- 群文件 v1（幂等）
-- 表 + RLS：群成员能看/能传自己的；上传者、群主、管理员能删
-- 文件本体仍在 chat-media（公开 URL），这里只存索引
-- ============================================================
begin;

create table if not exists public.group_files (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.chat_groups(id) on delete cascade,
  uploader    text not null,
  name        text not null,
  size        bigint not null default 0,
  mime        text,
  path        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists group_files_gid_idx on public.group_files(group_id, created_at desc);

alter table public.group_files enable row level security;

grant select, insert, delete on public.group_files to authenticated;
revoke all on public.group_files from anon;

drop policy if exists gf_select on public.group_files;
create policy gf_select on public.group_files for select to authenticated
  using (public.is_group_member(group_id, public.my_acc()));

drop policy if exists gf_insert on public.group_files;
create policy gf_insert on public.group_files for insert to authenticated
  with check (uploader = public.my_acc() and public.is_group_member(group_id, public.my_acc()));

drop policy if exists gf_delete on public.group_files;
create policy gf_delete on public.group_files for delete to authenticated
  using (
    uploader = public.my_acc()
    or exists (
      select 1 from public.chat_group_members m
       where m.group_id = group_files.group_id
         and m.account_id = public.my_acc()
         and m.role in ('owner', 'admin')
    )
  );

commit;


-- ============================================================
-- moment-views-v1.sql
-- ============================================================
-- ============================================================
-- 朋友圈访客（幂等）
-- moment_views：谁看过哪条；只有作者能读；自己只能写自己的浏览
-- ============================================================
begin;

create table if not exists public.moment_views (
  id          uuid primary key default gen_random_uuid(),
  moment_id   uuid not null references public.moments(id) on delete cascade,
  viewer_acc  text not null,
  created_at  timestamptz not null default now(),
  unique (moment_id, viewer_acc)
);
create index if not exists moment_views_mid_idx on public.moment_views(moment_id, created_at desc);

alter table public.moment_views enable row level security;
grant select, insert on public.moment_views to authenticated;
revoke all on public.moment_views from anon;

drop policy if exists mv_ins on public.moment_views;
create policy mv_ins on public.moment_views for insert to authenticated
  with check (viewer_acc = public.my_acc() and public.can_see_moment(moment_id, public.my_acc()));

drop policy if exists mv_sel on public.moment_views;
create policy mv_sel on public.moment_views for select to authenticated
  using (exists (
    select 1 from public.moments m
     where m.id = moment_views.moment_id and m.author_acc = public.my_acc()
  ));

commit;


-- ============================================================
-- security-v1.sql
-- ============================================================
-- ============================================================
-- 安全加固 v1（幂等）
-- 1) 账号 ID 不允许含冒号/空白：防止把账号改成 "g:<群id>" 去读群消息
-- 2) @所有人 只在服务端放行群主/管理员：前端隐藏不算数
-- ============================================================
begin;

-- 1) 账号 ID 白名单
alter table public.profiles drop constraint if exists profiles_acc_safe;
alter table public.profiles add constraint profiles_acc_safe check (
  char_length(account_id) between 1 and 32
  and account_id !~ '[:[:space:]]'
);

-- 2) @所有人 服务端校验
create or replace function public.guard_all_mention() returns trigger
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if new.mentions is null or jsonb_typeof(new.mentions) <> 'array' then return new; end if;
  if not (new.mentions @> '[{"acc":"@all"}]'::jsonb) then return new; end if;
  if left(coalesce(new.conv_key, ''), 2) <> 'g:' then
    raise exception 'mention all is only for groups';
  end if;
  gid := substring(new.conv_key from 3)::uuid;
  if not exists (
    select 1 from public.chat_group_members m
     where m.group_id = gid and m.account_id = new.from_acc and m.role in ('owner', 'admin')
  ) then
    raise exception 'only owner or admin can mention all';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_all_mention on public.messages;
create trigger trg_guard_all_mention before insert on public.messages
  for each row execute function public.guard_all_mention();

commit;


-- ============================================================
-- security-v2.sql
-- ============================================================
-- ============================================================
-- 安全加固 v2（幂等）
-- 1) peer_read 只认「自己和对方」的真实会话，防止伪造会话行查别人的已读时间
-- 2) conversations 插入/更新：conv_key 必须由 (owner, peer) 推出来，或是自己所在群的 g:<gid>
-- ============================================================
begin;

create or replace function public.peer_read(p_conv text)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select c2.last_read_ts
    from public.conversations c1
    join public.conversations c2
      on c2.conv_key = c1.conv_key and c2.owner_acc = c1.peer_acc
   where c1.owner_acc = public.my_acc()
     and c1.conv_key  = p_conv
     and c1.conv_key  = public.conv_key_of(c1.owner_acc, c1.peer_acc)
$$;

drop policy if exists conv_insert on public.conversations;
create policy conv_insert on public.conversations for insert to authenticated
  with check (
    owner_acc = public.my_acc()
    and (
      conv_key = public.conv_key_of(owner_acc, peer_acc)
      or (
        left(conv_key, 2) = 'g:'
        and conv_key = peer_acc
        and public.is_group_member(substring(conv_key from 3)::uuid, public.my_acc())
      )
    )
  );

drop policy if exists conv_update on public.conversations;
create policy conv_update on public.conversations for update to authenticated
  using (owner_acc = public.my_acc())
  with check (
    owner_acc = public.my_acc()
    and (
      conv_key = public.conv_key_of(owner_acc, peer_acc)
      or (
        left(conv_key, 2) = 'g:'
        and conv_key = peer_acc
        and public.is_group_member(substring(conv_key from 3)::uuid, public.my_acc())
      )
    )
  );

commit;


-- ============================================================
-- mute-push-v1.sql
-- ============================================================
-- ============================================================
-- 免打扰同步 + 推送端拦截（幂等）
-- profiles.mutes: {"conv_key": 1}
-- push_job 变成包装层：先查目标用户的 mutes，命中就 skip='muted'
-- ============================================================
begin;

alter table public.profiles add column if not exists mutes jsonb not null default '{}'::jsonb;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'push_job'
  ) then
    alter function public.push_job(uuid, text, text, text) rename to push_job_base;
  end if;
end $$;

create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; ck text; muted jsonb;
begin
  select account_id, coalesce(mutes, '{}'::jsonb) into me, muted
    from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;

  if p_kind = 'gmsg' then
    ck := p_to;
  elsif p_kind in ('msg', 'call', 'miss') then
    if p_to is null or p_to = '' then ck := null; else ck := public.conv_key_of(me, p_to); end if;
  else
    ck := null;
  end if;

  if ck is not null and (muted ? ck) then
    return jsonb_build_object('skip', 'muted');
  end if;

  return public.push_job_base(p_uid, p_kind, p_ref, p_to);
end $$;

commit;


-- ============================================================
-- mute-push-v2.sql
-- ============================================================
-- ============================================================
-- 免打扰 v2：按“收件人”的 mutes 判断（v1 错判成了发送者）
-- 1) push_job 包装层：msg/call/miss 用 p_to（收件人）的 mutes
-- 2) push_job_base 的 gmsg 查询里排除把该群设为免打扰的成员
-- ============================================================
begin;

create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; ck text; muted jsonb;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;

  if p_kind in ('msg', 'call', 'miss') and p_to is not null and p_to <> '' then
    select coalesce(mutes, '{}'::jsonb) into muted from public.profiles where account_id = p_to;
    ck := public.conv_key_of(me, p_to);
    if muted is not null and (muted ? ck) then
      return jsonb_build_object('skip', 'muted');
    end if;
  end if;

  return public.push_job_base(p_uid, p_kind, p_ref, p_to);
end $$;

do $$
declare def text; nw text;
begin
  select pg_get_functiondef('public.push_job_base(uuid,text,text,text)'::regprocedure) into def;
  nw := replace(def,
    'where gm.group_id = gid and s.acc <> me',
    'where gm.group_id = gid and s.acc <> me
       and not exists (select 1 from public.profiles pf where pf.account_id = s.acc and pf.mutes ? (''g:'' || gid))');
  if nw = def then
    raise exception 'push_job_base gmsg pattern not found';
  end if;
  execute nw;
end $$;

commit;


-- ============================================================
-- security-v3.sql
-- ============================================================
-- ============================================================
-- 安全加固 v3（幂等）
-- 1) push_job 收回 anon/authenticated 执行权，只给 service_role
-- 2) 免打扰从 profiles.mutes（所有人可读）搬到 user_mutes（仅本人可读）
-- 3) push 包装层改读 user_mutes；群推送按成员排除
-- 4) 账号 ID 不可修改（触发器）
-- ============================================================
begin;

revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;

create table if not exists public.user_mutes (
  owner_acc text not null,
  conv_key  text not null,
  primary key (owner_acc, conv_key)
);
alter table public.user_mutes enable row level security;
grant select, insert, delete on public.user_mutes to authenticated;
revoke all on public.user_mutes from anon;

drop policy if exists um_sel on public.user_mutes;
create policy um_sel on public.user_mutes for select to authenticated using (owner_acc = public.my_acc());
drop policy if exists um_ins on public.user_mutes;
create policy um_ins on public.user_mutes for insert to authenticated with check (owner_acc = public.my_acc());
drop policy if exists um_del on public.user_mutes;
create policy um_del on public.user_mutes for delete to authenticated using (owner_acc = public.my_acc());

-- 把旧的 profiles.mutes 迁过来（只迁自己的；以 profile 所有者为 owner_acc）
insert into public.user_mutes (owner_acc, conv_key)
select p.account_id, k
  from public.profiles p, jsonb_object_keys(coalesce(p.mutes, '{}'::jsonb)) k
on conflict do nothing;

-- 迁移完把旧列清空，避免继续泄露
update public.profiles set mutes = '{}'::jsonb where coalesce(mutes, '{}'::jsonb) <> '{}'::jsonb;

create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; ck text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;

  if p_kind in ('msg', 'call', 'miss') and p_to is not null and p_to <> '' then
    ck := public.conv_key_of(me, p_to);
    if exists (select 1 from public.user_mutes um where um.owner_acc = p_to and um.conv_key = ck) then
      return jsonb_build_object('skip', 'muted');
    end if;
  end if;

  return public.push_job_base(p_uid, p_kind, p_ref, p_to);
end $$;

revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;

do $$
declare def text; nw text;
begin
  select pg_get_functiondef('public.push_job_base(uuid,text,text,text)'::regprocedure) into def;
  nw := replace(def,
    'and not exists (select 1 from public.profiles pf where pf.account_id = s.acc and pf.mutes ? (''g:'' || gid))',
    'and not exists (select 1 from public.user_mutes um where um.owner_acc = s.acc and um.conv_key = ''g:'' || gid)');
  if nw = def then raise notice 'gmsg mute clause not found'; else execute nw; end if;
end $$;

-- 账号 ID 不可修改
create or replace function public.guard_account_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.account_id is distinct from old.account_id then
    raise exception 'account id cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_account_id on public.profiles;
create trigger trg_guard_account_id before update on public.profiles
  for each row execute function public.guard_account_id();

commit;


-- ============================================================
-- mute-push-v3.sql
-- ============================================================
-- ============================================================
-- 免打扰兼容 v4（幂等）
-- 旧版客户端写的是 profiles.mutes，新版写 user_mutes；推送时两边都认
-- ============================================================
begin;

create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; ck text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;

  if p_kind in ('msg', 'call', 'miss') and p_to is not null and p_to <> '' then
    ck := public.conv_key_of(me, p_to);
    if exists (select 1 from public.user_mutes um where um.owner_acc = p_to and um.conv_key = ck) then
      return jsonb_build_object('skip', 'muted');
    end if;
    if exists (select 1 from public.profiles pf where pf.account_id = p_to and coalesce(pf.mutes, '{}'::jsonb) ? ck) then
      return jsonb_build_object('skip', 'muted');
    end if;
  end if;

  return public.push_job_base(p_uid, p_kind, p_ref, p_to);
end $$;

revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;

do $$
declare def text; nw text;
begin
  select pg_get_functiondef('public.push_job_base(uuid,text,text,text)'::regprocedure) into def;
  nw := replace(def,
    'and not exists (select 1 from public.user_mutes um where um.owner_acc = s.acc and um.conv_key = ''g:'' || gid)',
    'and not exists (select 1 from public.user_mutes um where um.owner_acc = s.acc and um.conv_key = ''g:'' || gid)
       and not exists (select 1 from public.profiles pf where pf.account_id = s.acc and coalesce(pf.mutes, ''{}''::jsonb) ? (''g:'' || gid))');
  if nw = def then raise notice 'gmsg clause already patched or not found'; else execute nw; end if;
end $$;

-- 清掉测试留下的假订阅、测试群、测试静音
delete from public.push_subs where endpoint like 'https://fcm.example/%';
delete from public.user_mutes where conv_key like 'g:4a805265-%';
delete from public.chat_groups where name = '__mute_gmsg__';
delete from public.chat_groups where name = '__shot_grp__';
delete from public.chat_groups where name = '__selfcard_test__';
delete from public.chat_groups where name = '__gf_probe__';

commit;


-- ============================================================
-- pin-sync-v1.sql
-- ============================================================
-- 置顶跨设备同步（2026-11-14）
alter table public.conversations add column if not exists pinned_at timestamptz;

