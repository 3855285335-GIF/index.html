-- 2026-11-15 今天新增/修改的 SQL（都已在线执行过，幂等）



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

