-- Chatter 11-19 —— 安全修复（GPT 写的 6 份，Claude 核对线上后合成一份）。可以重复执行
-- 什么时候运行：等 App 新版本（20261119b）上线以后再运行。新版 App 不管有没有运行这份都能用；
--   旧版 App（还没自动更新的手机）运行后会有几样小功能出错（读不到“被踢时间”、好友申请点接受可能失败），重新打开 App 自动更新后就好。
-- 在哪运行：https://supabase.com/dashboard/project/uaoiqbxptnbrvkzjwguc/sql/new
--   整份粘贴进去 → 点右下角“Run”（运行）；如果弹出“Potential issue detected with your query”（检测到查询可能有问题），点“Run this query”（运行此查询）
-- 整份在一个事务里：任何一步出错都会全部撤销，什么都不改。最后显示一张检查表，每行都是“是”就对了。
-- 撤销脚本在仓库 supabase/rollback/ 下面（同名的 6 份，倒着运行）。
-- 我（Claude）核对过线上：里面提到的表、函数、规则名字都存在；数据库是 PostgreSQL 17（支持“实时通道只发部分字段”）。
-- 没核实的一点：Supabase 实时通道对“只发部分字段”的支持官方文档没写清楚；运行后请用两台手机试一下改头像、改昵称，对方能不能马上看到。

begin;
set local lock_timeout = '5s';

-- ========== 1. 收回手机端“清空整张表”（TRUNCATE）的权限（20261119055837_chatter_table_privileges.sql） ==========
-- Reconciled with the production ACL snapshot taken on 2026-11-19.

revoke truncate on table
  public.chat_group_members,
  public.chat_groups,
  public.conversations,
  public.friend_requests,
  public.friendships,
  public.group_invites,
  public.messages,
  public.profiles,
  public.search_cache,
  public.search_prefs,
  public.search_usage
from anon;

revoke truncate on table
  public.chat_backgrounds,
  public.chat_group_members,
  public.chat_groups,
  public.conversations,
  public.friend_requests,
  public.friendships,
  public.group_files,
  public.group_invites,
  public.group_notices,
  public.messages,
  public.moment_comments,
  public.moment_likes,
  public.moment_mentions,
  public.moment_views,
  public.moments,
  public.profiles,
  public.search_cache,
  public.search_prefs,
  public.search_usage,
  public.stickers,
  public.user_devices,
  public.user_mutes
from authenticated;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- ========== 2. 资料表的私密字段（被踢时间、登录设备、免打扰名单、朋友圈看到哪）别人读不到（20261119055838_chatter_profile_privacy.sql） ==========
-- Table-level SELECT overrides per-column restrictions.
revoke select on public.profiles from public, anon, authenticated;
grant select (id, account_id, nickname, avatar_url, signature, created_at,
              bg_url, cover_url, bubble_color)
  on public.profiles to anon, authenticated;

-- Bootstrap already returns the caller's own private fields. The device check
-- needs a narrow endpoint to read the current value without reloading bootstrap.
create or replace function public.my_kick_at()
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

do $$ begin   -- 实时通道只发公开字段（重复运行也行）
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime drop table public.profiles;
  end if;
  alter publication supabase_realtime add table public.profiles (id, account_id, nickname, avatar_url,
    signature, created_at, bg_url, cover_url, bubble_color);
end $$;

-- ========== 3. 上传文件只能传到自己的文件夹（以前有一条规则让任何登录的人能往任何地方传）（20261119055839_chatter_media_ownership.sql） ==========
-- Permissive RLS policies are ORed; the unrestricted legacy policy defeated
-- the ownership check. Keep public URLs working for old messages.
drop policy if exists "media insert" on storage.objects;
alter policy "chat-media insert own" on storage.objects to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = (select public.my_acc())
    and cardinality(storage.foldername(name)) = 1
    and storage.filename(name) not in ('', '.', '..')
    and (select public.session_alive())
  );

drop policy if exists "media read" on storage.objects;

-- ========== 4. 触发器函数手机调不了；被踢下线的设备连调用数据库函数也不行（20261119060035_chatter_function_privileges.sql） ==========
-- Trigger invocation is internal; client EXECUTE is unnecessary.
revoke execute on function
  public.group_delete_cleanup(),
  public.group_member_cleanup(),
  public.group_member_conv(),
  public.group_mute_guard(),
  public.guard_account_id(),
  public.guard_all_mention(),
  public.handle_new_user(),
  public.log_group_notice(),
  public.messages_after_insert(),
  public.messages_after_update(),
  public.messages_before_insert(),
  public.messages_before_update(),
  public.push_on_edit(),
  public.push_subs_guard(),
  public.refresh_conv_last_message(),
  public.sync_conversation_on_message()
from public, anon, authenticated;

alter function public.conv_key_of(text,text) set search_path = '';
alter function public.chatter_schema() set search_path = '';
alter function public.messages_before_insert() set search_path = '';
alter function public.messages_before_update() set search_path = '';

-- Existing JWTs issued by older auth deployments can omit session_id.
-- If a session ID is present, reject malformed IDs and mismatched users.
create or replace function public.session_alive()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid text := auth.jwt() ->> 'session_id';
begin
  if uid is null then return false; end if;
  if nullif(sid, '') is null then return true; end if;
  return exists (select 1 from auth.sessions s where s.id = sid::uuid and s.user_id = uid);
exception when invalid_text_representation then
  return false;
end;
$$;

-- Existing RPCs use my_acc() for authorization, including functions that
-- bypass table RLS. Apply the session check before returning an identity.
create or replace function public.my_acc()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.account_id
  from public.profiles p
  where p.id = (select auth.uid()) and (select public.session_alive())
  limit 1;
$$;

-- ========== 5. 存储只收常见的图片、音视频、PDF、文本和普通文件（网页文件不能当网页打开）（20261119060052_chatter_media_types.sql） ==========
-- Keep existing objects and permit arbitrary attachments as inert downloads.
-- The Storage API checks the declared MIME type, not the bytes.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/bmp', 'image/tiff', 'image/x-icon',
  'image/vnd.microsoft.icon', 'image/svg+xml', 'audio/*', 'video/*',
  'application/octet-stream', 'text/plain', 'application/pdf'
]
where id = 'chat-media' and allowed_mime_types is null;

-- ========== 6. 好友申请只能“拒绝”（接受走服务器函数）；两人同时互加不会出错（20261119060908_chatter_friend_request_transitions.sql） ==========
revoke update on public.friend_requests from public, anon, authenticated;
grant update (status) on public.friend_requests to authenticated;

alter policy fr_update on public.friend_requests to authenticated
  using (to_acc = (select public.my_acc()) and status = 'pending')
  with check (to_acc = (select public.my_acc()) and status = 'declined');

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_req_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me text := public.my_acc();
  r  record;
  k  text;
begin
  if me is null then raise exception 'not authenticated'; end if;
  update public.friend_requests set status = 'accepted'
   where id::text = p_req_id and to_acc = me and status = 'pending'
   returning * into r;
  if not found then raise exception 'request not found'; end if;

  insert into public.friendships (owner_acc, friend_acc)
  values (me, r.from_acc), (r.from_acc, me)
  on conflict do nothing;

  k := public.conv_key_of(me, r.from_acc);
  insert into public.conversations (owner_acc, conv_key, peer_acc)
  values (me, k, r.from_acc), (r.from_acc, k, me)
  on conflict do nothing;
end $function$;

CREATE OR REPLACE FUNCTION public.send_friend_request(p_to text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Serialize both directions before looking for a reciprocal request.
  perform pg_advisory_xact_lock(hashtextextended(public.conv_key_of(me, tgt), 0));
  if exists (select 1 from public.friendships where owner_acc = me and friend_acc = tgt) then return 'friends'; end if;

  select id::text into rid from public.friend_requests
   where from_acc = tgt and to_acc = me and status = 'pending' limit 1;
  if found then
    perform public.accept_friend_request(rid);
    return 'accepted';
  end if;

  select nickname into nick from public.profiles where account_id = me;

  select * into r from public.friend_requests where from_acc = me and to_acc = tgt
   order by (status = 'pending') desc, created_at desc, id desc limit 1;
  if found then
    if r.status = 'pending' then return 'exists'; end if;
    update public.friend_requests set status = 'pending', from_name = nick, created_at = now() where id = r.id;
    return 'ok';
  end if;

  insert into public.friend_requests (from_acc, to_acc, from_name, status)
  values (me, tgt, nick, 'pending');
  return 'ok';
end $function$;

-- ========== 检查表 ==========
create temp table if not exists _chatter_1119s (序号 int, 项目 text, 结果 text) on commit preserve rows;
truncate _chatter_1119s;
insert into _chatter_1119s
select 1, '手机端不能清空整张表', case when not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'TRUNCATE') then '是' else '否' end
union all select 2, '资料表私密字段别人读不到', case when not has_column_privilege('authenticated', 'public.profiles', 'kick_at', 'select') and not has_column_privilege('authenticated', 'public.profiles', 'devices', 'select')
  and has_column_privilege('authenticated', 'public.profiles', 'nickname', 'select') and to_regprocedure('public.my_kick_at()') is not null then '是' else '否' end
union all select 3, '实时通道只发公开字段', case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profiles' and not ('kick_at' = any(attnames)) and 'nickname' = any(attnames)) then '是' else '否' end
union all select 4, '上传只能传到自己的文件夹', case when not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('media insert', 'media read')) then '是' else '否' end
union all select 5, '被踢的设备调用函数也不行', case when pg_get_functiondef('public.my_acc()'::regprocedure) like '%session_alive%' and pg_get_functiondef('public.session_alive()'::regprocedure) like '%user_id = uid%' then '是' else '否' end
union all select 6, '触发器函数手机调不了', case when not has_function_privilege('authenticated', 'public.guard_account_id()', 'execute') then '是' else '否' end
union all select 7, '存储只收常见文件类型', case when exists (select 1 from storage.buckets where id = 'chat-media' and allowed_mime_types is not null and not ('text/html' = any(allowed_mime_types))) then '是' else '否' end
union all select 8, '好友申请只能改“状态”，只能改成拒绝', case when not has_column_privilege('authenticated', 'public.friend_requests', 'from_acc', 'update') and has_column_privilege('authenticated', 'public.friend_requests', 'status', 'update') then '是' else '否' end;

commit;

select 序号, 项目, 结果 from _chatter_1119s order by 序号;
