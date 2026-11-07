-- ============================================================
-- Chatter 后端补丁 v8：消息 / 来电推送（可重复执行，不改动、不删除任何现有数据）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
-- 需要先运行过 6-setup-v7.sql
--
-- 1. push_subs：每台手机的推送地址（只存推送服务给的地址和加密公钥，不存别的）。每个账号最多 5 台
-- 2. push_keys：推送签名用的密钥，由推送函数第一次运行时自己生成，网页和任何人都读不到
-- 3. push_job()：推送函数调用它，检查“是不是好友、对方是不是不在线、消息是不是真的刚发出”，
--    再算出通知标题和内容。网页不能直接调用
-- 4. chatter_schema() 改为 8
-- ============================================================


-- 整份放在一个事务里：中间任何一句出错，前面做的也会全部撤销，不会只改一半
begin;

-- ========== 0. 先确认是 Chatter 的数据库（选错项目时直接报错，什么都不会改） ==========
do $$ begin
  if to_regclass('public.friendships') is null or to_regclass('public.messages') is null then
    raise exception '这不是 Chatter 的数据库：找不到 friendships / messages 表。请确认页面左上角选的是 Chatter 的项目（地址里应有 uaoiqbxptnbrvkzjwguc），这次什么都没有改动';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'friendships' and column_name = 'remark') then
    raise exception '请先运行 setup-v7.sql（好友备注 / 存储用量），再运行这一份。这次什么都没有改动';
  end if;
  if to_regclass('public.presence') is null or to_regclass('public.signals') is null then
    raise exception '请先运行 setup-v5.sql（国内模式），再运行这一份。这次什么都没有改动';
  end if;
end $$;


-- ========== 1. 表 ==========
create table if not exists public.push_subs (
  endpoint   text primary key check (char_length(endpoint) between 20 and 1000 and endpoint ~ '^https://'),
  acc        text not null,
  p256dh     text not null check (p256dh ~ '^[A-Za-z0-9_=+/-]{80,100}$'),
  auth       text not null check (auth ~ '^[A-Za-z0-9_=+/-]{16,32}$'),
  preview    boolean not null default true,      -- 通知里显示消息内容（每台手机自己设）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subs_acc_idx on public.push_subs (acc, updated_at desc);

create table if not exists public.push_keys (
  id         integer primary key default 1 check (id = 1),
  pub        text not null,
  priv       text not null,
  created_at timestamptz not null default now()
);

-- 推送记录：同一条消息 / 同一个来电只推一次（1 小时后自动清掉）
create table if not exists public.push_log (
  ref      text primary key,
  from_acc text not null,
  to_acc   text not null,
  at       timestamptz not null default now()
);

alter table public.push_subs enable row level security;
alter table public.push_keys enable row level security;
alter table public.push_log  enable row level security;
revoke all on table public.push_subs from anon, authenticated;
revoke all on table public.push_keys from anon, authenticated;
revoke all on table public.push_log  from anon, authenticated;


-- ========== 2. 网页调用：登记 / 取消这台手机 ==========
create or replace function public.push_save(p_endpoint text, p_p256dh text, p_auth text, p_preview boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then raise exception 'not authenticated'; end if;
  insert into public.push_subs (endpoint, acc, p256dh, auth, preview)
  values (p_endpoint, me, p_p256dh, p_auth, coalesce(p_preview, true))
  on conflict (endpoint) do update
    set acc = excluded.acc, p256dh = excluded.p256dh, auth = excluded.auth,
        preview = excluded.preview, updated_at = now();
  -- 每个账号只留最近用过的 5 台
  delete from public.push_subs
   where acc = me
     and endpoint not in (select endpoint from public.push_subs where acc = me order by updated_at desc limit 5);
end $$;

create or replace function public.push_remove(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then return; end if;
  delete from public.push_subs where endpoint = p_endpoint and acc = me;
end $$;

-- 这台手机登记了没有、一共几台
create or replace function public.push_status(p_endpoint text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'n',       (select count(*) from public.push_subs where acc = public.my_acc()),
    'here',    exists (select 1 from public.push_subs where acc = public.my_acc() and endpoint = p_endpoint),
    'preview', (select preview from public.push_subs where acc = public.my_acc() and endpoint = p_endpoint),
    'keys',    exists (select 1 from public.push_keys))
$$;


-- ========== 3. 推送函数调用（网页调不了） ==========
create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me text; tgt text; nm text; t text; b text; h text; tag text; url text; lref text;
  ttl integer := 86400; n integer; vid boolean; subs jsonb; m record; r record;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;
  if p_kind not in ('msg', 'call', 'miss', 'req', 'test') then return jsonb_build_object('skip', 'kind'); end if;
  tgt := case when p_kind = 'test' then me else p_to end;
  if tgt is null or tgt = '' then return jsonb_build_object('skip', 'to'); end if;
  if p_kind = 'test' or p_kind = 'req' then null;
  elsif not exists (select 1 from public.friendships where owner_acc = tgt and friend_acc = me) then
    return jsonb_build_object('skip', 'friend');
  end if;
  -- 对方 App 开着（75 秒内报到过）：App 自己会响铃 / 弹横幅，不用推送
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
           -- 引用回复的消息：去掉开头的引用部分，只留回复的话
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
    -- 只有推送过这个来电，才需要把它改成“未接来电”
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
end $$;

-- 推送服务说这台手机的地址已失效（卸载、关了通知、换了账号）：删掉
create or replace function public.push_gone(p_endpoints text[])
returns void language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = any(p_endpoints)
$$;

create or replace function public.push_vapid()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('pub', k.pub, 'priv', k.priv) from public.push_keys k where k.id = 1
$$;

-- 只在还没有密钥时写入（两次同时生成时，以先写进去的为准）
create or replace function public.push_set_vapid(p_pub text, p_priv text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  insert into public.push_keys (id, pub, priv) values (1, p_pub, p_priv) on conflict (id) do nothing;
  return public.push_vapid();
end $$;


-- ========== 4. 权限 ==========
revoke all on function public.push_save(text, text, text, boolean) from public, anon;
revoke all on function public.push_remove(text)                    from public, anon;
revoke all on function public.push_status(text)                    from public, anon;
grant execute on function public.push_save(text, text, text, boolean) to authenticated;
grant execute on function public.push_remove(text)                    to authenticated;
grant execute on function public.push_status(text)                    to authenticated;

revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.push_gone(text[])                from public, anon, authenticated;
revoke all on function public.push_vapid()                     from public, anon, authenticated;
revoke all on function public.push_set_vapid(text, text)       from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;
grant execute on function public.push_gone(text[])                to service_role;
grant execute on function public.push_vapid()                     to service_role;
grant execute on function public.push_set_vapid(text, text)       to service_role;


-- ========== 5. 后端版本号 ==========
create or replace function public.chatter_schema()
returns integer language sql immutable as $$ select 8 $$;
revoke all on function public.chatter_schema() from public, anon;
grant execute on function public.chatter_schema() to authenticated;

commit;

-- 完成 ✅
