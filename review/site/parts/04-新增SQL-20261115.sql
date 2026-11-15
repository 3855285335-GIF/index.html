-- 2026-11-15 今天新增/修改的 SQL（全部已在线执行，幂等）



-- ===== sql\poll-inbox-group-v1.sql =====
create or replace function public.poll_inbox(p_since timestamptz, p_wait_ms integer default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  me text := public.my_acc();
  since timestamptz := coalesce(p_since, now() - interval '15 seconds');
  deadline timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_wait_ms,0),0),2500)/1000.0);
  gids text[];
  msgs jsonb; sigs jsonb; fresh integer;
begin
  if me is null then return null; end if;
  select coalesce(array_agg('g:'||m.group_id::text), '{}') into gids
    from public.chat_group_members m where m.account_id = me;
  loop
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb),
           count(*) filter (where x.created_at > since)
      into msgs, fresh
      from (select * from public.messages
             where (to_acc = me or conv_key = any(gids))
               and created_at > since - interval '15 seconds'
             order by created_at limit 100) x;
    loop
      exit when fresh > 0;
      exit when clock_timestamp() >= deadline;
      perform pg_sleep(0.2);
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb),
             count(*) filter (where x.created_at > since)
        into msgs, fresh
        from (select * from public.messages
               where (to_acc = me or conv_key = any(gids))
                 and created_at > since - interval '15 seconds'
               order by created_at limit 100) x;
    end loop;
    with d as (
      delete from public.signals s where s.to_acc = me
      returning s.id, s.from_acc, s.payload, s.created_at
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'from_acc', d.from_acc, 'payload', d.payload) order by d.id)
                    filter (where d.created_at > now() - interval '60 seconds'), '[]'::jsonb)
      into sigs from d;
    exit when fresh > 0 or jsonb_array_length(sigs) > 0 or clock_timestamp() >= deadline;
    perform pg_sleep(0.2);
  end loop;
  return jsonb_build_object('msgs', msgs, 'sigs', sigs);
end $fn$;


-- ===== sql\poll-inbox-group-v2.sql =====
create or replace function public.poll_inbox(p_since timestamptz, p_wait_ms integer default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  me text := public.my_acc();
  since timestamptz := coalesce(p_since, now() - interval '15 seconds');
  deadline timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_wait_ms,0),0),8000)/1000.0);
  gids text[];
  msgs jsonb := '[]'::jsonb; sigs jsonb := '[]'::jsonb; fresh integer := 0;
begin
  if me is null then return null; end if;
  select coalesce(array_agg('g:'||m.group_id::text), '{}') into gids
    from public.chat_group_members m where m.account_id = me;
  loop
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb),
           count(*) filter (where x.created_at > since)
      into msgs, fresh
      from (select * from public.messages
             where (to_acc = me or conv_key = any(gids))
               and created_at > since - interval '15 seconds'
             order by created_at limit 100) x;
    with d as (
      delete from public.signals s where s.to_acc = me
      returning s.id, s.from_acc, s.payload, s.created_at
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'from_acc', d.from_acc, 'payload', d.payload) order by d.id)
                    filter (where d.created_at > now() - interval '60 seconds'), '[]'::jsonb)
      into sigs from d;
    exit when fresh > 0 or jsonb_array_length(sigs) > 0 or clock_timestamp() >= deadline;
    perform pg_sleep(0.2);
  end loop;
  return jsonb_build_object('msgs', msgs, 'sigs', sigs);
end $fn$;


-- ===== sql\push-edit-v1.sql =====
-- 「编辑消息」单独一条推送通道（原来的 push_job 只认 3 分钟内的新消息，编辑过的老消息一律被当成 dup 丢掉）
-- 幂等，可重复执行

create or replace function public.push_job_edit(p_uid uuid, p_ref text, p_to text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  me text; tgt text := p_to; nm text; b text; h text; m record; subs jsonb; lref text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;
  if tgt is null or tgt = '' then return jsonb_build_object('skip', 'to'); end if;
  if not exists (select 1 from public.friendships where owner_acc = tgt and friend_acc = me) then
    return jsonb_build_object('skip', 'friend');
  end if;

  select * into m from public.messages
   where id::text = p_ref and from_acc = me and to_acc = tgt
     and edited_at is not null and edited_at > now() - interval '5 minutes';
  if not found then return jsonb_build_object('skip', 'ref'); end if;

  if exists (select 1 from public.user_mutes um where um.owner_acc = tgt and um.conv_key = m.conv_key) then
    return jsonb_build_object('skip', 'muted');
  end if;
  if exists (select 1 from public.profiles pf where pf.account_id = tgt and coalesce(pf.mutes, '{}'::jsonb) ? m.conv_key) then
    return jsonb_build_object('skip', 'muted');
  end if;
  if exists (select 1 from public.presence pr where pr.account_id = tgt and pr.last_seen > now() - interval '75 seconds') then
    return jsonb_build_object('skip', 'online');
  end if;

  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
    into subs from public.push_subs s where s.acc = tgt;
  if subs is null then return jsonb_build_object('skip', 'nosub'); end if;

  nm := coalesce(nullif(btrim((select remark from public.friendships where owner_acc = tgt and friend_acc = me)), ''),
                 nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);
  b := case m.type
         when 'text'  then left(btrim(coalesce(m.body, '')), 120)
         when 'image' then '[图片]'
         when 'voice' then '[语音]'
         when 'video' then '[视频]'
         else '[消息]'
       end;
  h := nm || ' 修改了一条消息';
  b := nm || ' 修改了消息：' || b;

  delete from public.push_log where at < now() - interval '1 hour';
  lref := 'e:' || m.id::text || ':' || floor(extract(epoch from m.edited_at))::bigint;   -- 每次编辑一个 ref：同一次不重复推，改两次能推两次
  insert into public.push_log (ref, from_acc, to_acc) values (lref, me, tgt) on conflict (ref) do nothing;
  if not found then return jsonb_build_object('skip', 'dup'); end if;

  return jsonb_build_object('subs', subs, 'title', nm, 'body', b, 'hidden', h,
    'tag', 'e:' || m.id::text, 'url', './#c=' || me, 'ttl', 86400, 'kind', 'msg', 'from', me);
end $fn$;

revoke all on function public.push_job_edit(uuid, text, text) from public, anon, authenticated;

-- push_job 加一个 edit 分支（其余逻辑原样）
create or replace function public.push_job(p_uid uuid, p_kind text, p_ref text, p_to text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me text; ck text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;

  if p_kind = 'edit' then
    return public.push_job_edit(p_uid, p_ref, p_to);
  end if;

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
end $function$;



-- ===== sql\push-edit-v2.sql =====
-- 编辑推送 v2：① 推送正文去掉引用前缀 ② 编辑改由数据库触发器发起（kind='edit'）
-- 幂等

create or replace function public.push_on_edit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare uid uuid;
begin
  if new.type <> 'text' or new.body is not distinct from old.body then return new; end if;
  if new.to_acc is null or new.to_acc = '' or new.to_acc like 'g:%' then return new; end if;
  begin
    select p.id into uid from public.profiles p where p.account_id = new.from_acc;
    if uid is not null then perform public.push_job(uid, 'edit', new.id::text, new.to_acc); end if;   -- 走编辑专用通道
  exception when others then null;   -- 推送出任何错都不许影响消息本身
  end;
  return new;
end $fn$;

create or replace function public.push_job_edit(p_uid uuid, p_ref text, p_to text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  me text; tgt text := p_to; nm text; b text; h text; m record; subs jsonb; lref text;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;
  if tgt is null or tgt = '' then return jsonb_build_object('skip', 'to'); end if;
  if not exists (select 1 from public.friendships where owner_acc = tgt and friend_acc = me) then
    return jsonb_build_object('skip', 'friend');
  end if;

  select * into m from public.messages
   where id::text = p_ref and from_acc = me and to_acc = tgt
     and edited_at is not null and edited_at > now() - interval '5 minutes';
  if not found then return jsonb_build_object('skip', 'ref'); end if;

  if exists (select 1 from public.user_mutes um where um.owner_acc = tgt and um.conv_key = m.conv_key) then
    return jsonb_build_object('skip', 'muted');
  end if;
  if exists (select 1 from public.profiles pf where pf.account_id = tgt and coalesce(pf.mutes, '{}'::jsonb) ? m.conv_key) then
    return jsonb_build_object('skip', 'muted');
  end if;
  if exists (select 1 from public.presence pr where pr.account_id = tgt and pr.last_seen > now() - interval '75 seconds') then
    return jsonb_build_object('skip', 'online');
  end if;

  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
    into subs from public.push_subs s where s.acc = tgt;
  if subs is null then return jsonb_build_object('skip', 'nosub'); end if;

  nm := coalesce(nullif(btrim((select remark from public.friendships where owner_acc = tgt and friend_acc = me)), ''),
                 nullif(btrim((select nickname from public.profiles where account_id = me)), ''), me);

  -- 引用消息的正文前面带 \u2063Q...\u2063 前缀，必须跟 push_job_base 一样去掉，否则通知里是一串乱码
  b := left(btrim(regexp_replace(regexp_replace(coalesce(m.body, ''), '^\u2063Q[^\u2063]*\u2063[^\u2063]*\u2063', ''), '[\s\u2063]+', ' ', 'g')), 120);

  h := nm || ' 修改了一条消息';
  b := nm || ' 修改了消息：' || b;

  delete from public.push_log where at < now() - interval '1 hour';
  lref := 'e:' || m.id::text || ':' || floor(extract(epoch from m.edited_at))::bigint;
  insert into public.push_log (ref, from_acc, to_acc) values (lref, me, tgt) on conflict (ref) do nothing;
  if not found then return jsonb_build_object('skip', 'dup'); end if;

  return jsonb_build_object('subs', subs, 'title', nm, 'body', b, 'hidden', h,
    'tag', 'e:' || m.id::text, 'url', './#c=' || me, 'ttl', 86400, 'kind', 'msg', 'from', me);
end $fn$;

revoke all on function public.push_job_edit(uuid, text, text) from public, anon, authenticated;



-- ===== sql\edit-guard-v2.sql =====
-- 编辑/撤回守卫收紧（幂等）
-- 新增：① 编辑后正文长度 1–20000 字 ② 撤回时清掉封面/提及/时长等残留
create or replace function public.messages_before_update()
 returns trigger
 language plpgsql
as $fn$
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
    if old.edited_at is not null then raise exception 'already edited once'; end if;
    if new.cover is distinct from old.cover or new.mentions is distinct from old.mentions then raise exception 'only body edit'; end if;
    if length(coalesce(new.body, '')) > 20000 then raise exception 'too long'; end if;
    if btrim(coalesce(new.body, '')) = '' then raise exception 'empty body'; end if;
    new.edited_at := now();
    return new;
  end if;
  if new.type <> 'recalled' then raise exception 'only recall is allowed'; end if;
  if now() - old.created_at > interval '2 minutes 15 seconds' then raise exception 'recall window passed'; end if;
  new.id := old.id; new.conv_key := old.conv_key; new.from_acc := old.from_acc;
  new.to_acc := old.to_acc; new.created_at := old.created_at; new.dur := old.dur;
  new.type := 'recalled'; new.body := '';
  new.cover := null;        -- 撤回后不要把封面地址留在行里
  new.mentions := null;
  return new;
end $fn$;



-- ===== sql\security-edit-index-v1.sql =====
-- 关掉旧的单参数 join_group_by_link（新客户端都用带 p_token 的两参数版本）
-- 旧版在网上还能被 aauthenticated 调用 = 绕过入群审批 / 被踢后直接重进
revoke execute on function public.join_group_by_link(uuid) from public, anon, authenticated;

-- editWatch 按 edited_at 查：加个部分索引，消息多了也不会越查越慢
create index if not exists idx_messages_edited_at on public.messages (edited_at) where edited_at is not null;
