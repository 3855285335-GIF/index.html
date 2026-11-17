-- Chatter 11-17（Claude 整理）—— 三件事合在一份里，可以重复执行
--   1. 实时广播只能发给好友 / 群友（陌生人不能冒充“正在输入”、上线、来电）
--   2. 群消息补推：发消息时在线、随后离开 App 的成员，30 秒 / 80 秒后补推（看过的不推）
--   3. “退出其他设备”真正生效：其他设备立刻收不到通知，也读不到聊天记录
-- 整份在一个事务里：中间任何一句出错，前面的也全部撤销，不会只改一半。
-- 最后会列出一张检查表，全部是“是”就成功了。

begin;

create temp table if not exists _chatter_1117 (序号 int, 项目 text, 结果 text) on commit preserve rows;
truncate _chatter_1117;

-- ========== 0. 先确认是 Chatter 的数据库、而且之前的几份都运行过 ==========
do $$
begin
  if to_regclass('public.friendships') is null or to_regclass('public.chat_group_members') is null
     or to_regclass('public.push_subs') is null or to_regclass('public.push_log') is null
     or to_regclass('public.presence') is null or to_regclass('realtime.messages') is null then
    raise exception '这不是 Chatter 的数据库（缺表）。请确认网址里是 uaoiqbxptnbrvkzjwguc。这次什么都没改';
  end if;
  if to_regprocedure('public.push_job(uuid,text,text,text)') is null
     or to_regprocedure('public.push_job_base(uuid,text,text,text)') is null
     or to_regprocedure('public.my_acc()') is null
     or to_regprocedure('public.is_group_member(uuid,text)') is null then
    raise exception '缺少推送或账号函数。请把这句提示发给 Claude。这次什么都没改';
  end if;
  if position('push_job_edit' in pg_get_functiondef('public.push_job(uuid,text,text,text)'::regprocedure)) = 0 then
    raise exception '线上的 push_job 和预期的不一样（没有编辑推送那一段）。请把这句提示发给 Claude。这次什么都没改';
  end if;
end $$;


-- ========== 1. 登录是否还有效（被“退出其他设备”踢掉的，这里会变成“否”） ==========
-- 每个登录凭证里都带着 session_id；退出登录后 auth.sessions 里那一行会被删掉。
-- 查不了（权限、格式不对）一律当作有效：宁可不拦，也不能把所有人挡在外面。
create or replace function public.session_alive()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare sid text;
begin
  sid := nullif(coalesce(auth.jwt() ->> 'session_id', ''), '');
  if sid is null then return true; end if;
  return exists (select 1 from auth.sessions s where s.id = sid::uuid);
exception when others then
  return true;
end $$;
revoke all on function public.session_alive() from public, anon;
grant execute on function public.session_alive() to authenticated;

do $$
begin
  perform 1 from auth.sessions limit 1;
  insert into _chatter_1117 values (1, '能检查登录是否有效', '是');
exception when others then
  insert into _chatter_1117 values (1, '能检查登录是否有效', '否（' || sqlerrm || '）——退出其他设备只能做到不再收通知');
end $$;

-- 被踢掉的设备：读不到聊天、会话、信令、朋友圈（只加一道“登录还有效”的门，原来的规则不变）
do $$
declare t text;
begin
  foreach t in array array['messages', 'conversations', 'signals', 'moments', 'moment_comments'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists chatter_session_alive on public.%I', t);
      execute format('create policy chatter_session_alive on public.%I as restrictive for all to authenticated
                        using ((select public.session_alive())) with check ((select public.session_alive()))', t);
    end if;
  end loop;
end $$;

-- 被踢掉的设备：不能再登记推送（不然它回到前台又把自己加回去）
create or replace function public.push_subs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.session_alive() then
    raise exception '这台设备已经退出登录' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_push_subs_guard on public.push_subs;
create trigger trg_push_subs_guard before insert or update on public.push_subs
  for each row execute function public.push_subs_guard();


-- ========== 2. 退出其他设备 ==========
alter table public.profiles add column if not exists kick_at timestamptz;

-- 记下踢人时间（用服务器时间，手机时间不准也没关系），并删掉本机以外所有设备的推送登记
create or replace function public.kick_others(p_keep text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc(); t timestamptz := date_trunc('milliseconds', now());
begin
  if me is null then raise exception 'not authenticated'; end if;
  update public.profiles set kick_at = t where id = auth.uid();
  delete from public.push_subs where acc = me and endpoint is distinct from p_keep;
  return t;
end $$;
revoke all on function public.kick_others(text) from public, anon;
grant execute on function public.kick_others(text) to authenticated;


-- ========== 3. 实时广播：只能发给自己、好友、同群的人 ==========
create or replace function public.rt_can_send(p_topic text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare me text; tgt text;
begin
  if p_topic is null or left(p_topic, 2) <> 'u:' then return false; end if;
  me := public.my_acc();
  if me is null or not public.session_alive() then return false; end if;
  tgt := substring(p_topic from 3);
  if tgt = me then return true; end if;
  if exists (select 1 from public.friendships f
              where (f.owner_acc = me and f.friend_acc = tgt) or (f.owner_acc = tgt and f.friend_acc = me)) then
    return true;
  end if;
  return exists (select 1 from public.chat_group_members a
                   join public.chat_group_members b on b.group_id = a.group_id
                  where a.account_id = me and b.account_id = tgt);   -- 群语音的信令要发给不是好友的群友
end $$;
revoke all on function public.rt_can_send(text) from public, anon;
grant execute on function public.rt_can_send(text) to authenticated;

-- 去掉会让上面这条失效的旧规则（以前是“谁都能往任何 u: 频道发”）；别的项目留下的规则不动，列在检查表里
do $$
declare p record; gone text := ''; kept text := '';
begin
  for p in select policyname, permissive, cmd, coalesce(qual, '') q, coalesce(with_check, '') w
             from pg_policies where schemaname = 'realtime' and tablename = 'messages' loop
    if p.policyname in ('chatter_rt_send', 'chatter_rt_receive') then continue; end if;
    if p.permissive = 'PERMISSIVE' and p.cmd in ('INSERT', 'SELECT', 'ALL')
       and (position('u:' in p.q || p.w) > 0 or btrim(p.q) in ('', 'true') and btrim(p.w) in ('', 'true')) then
      execute format('drop policy %I on realtime.messages', p.policyname);
      gone := gone || p.policyname || ' ';
    else
      kept := kept || p.policyname || ' ';
    end if;
  end loop;
  insert into _chatter_1117 values (5, '删掉的旧实时规则', coalesce(nullif(btrim(gone), ''), '没有'));
  insert into _chatter_1117 values (6, '保留的其他实时规则', coalesce(nullif(btrim(kept), ''), '没有'));
end $$;

drop policy if exists chatter_rt_send on realtime.messages;
create policy chatter_rt_send on realtime.messages
  for insert to authenticated
  with check ( public.rt_can_send(realtime.topic()) );

drop policy if exists chatter_rt_receive on realtime.messages;
create policy chatter_rt_receive on realtime.messages
  for select to authenticated
  using ( realtime.topic() = 'u:' || public.my_acc() and public.session_alive() );


-- ========== 4. 群消息补推 ==========
-- 以前：一条群消息只推一次，当时在线（75 秒内有心跳）的成员跳过，之后就再也不推了。
-- 现在：按“每个成员”记录推没推过。App 会在 30 秒、80 秒后各再问一次：
--   当时在线、现在离开了、还没看过这条的成员会补上通知；看过的、推过的、设了免打扰的不推。
create or replace function public.push_job_gmsg(p_uid uuid, p_ref text, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  me text; gid uuid; m record; gname text; sender text; b text; h text;
  subs jsonb; accs text[]; n_on integer;
begin
  select account_id into me from public.profiles where id = p_uid;
  if me is null then return jsonb_build_object('skip', 'auth'); end if;
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

  -- 还需要通知的成员：有推送登记、发消息前就在群里、没设免打扰、这条还没推过、也还没看过
  with cand as (
    select gm.account_id as acc,
           exists (select 1 from public.presence pr
                    where pr.account_id = gm.account_id and pr.last_seen > now() - interval '75 seconds') as online
      from public.chat_group_members gm
     where gm.group_id = gid and gm.account_id <> me
       and gm.joined_at <= m.created_at
       and exists (select 1 from public.push_subs s where s.acc = gm.account_id)
       and not exists (select 1 from public.user_mutes um where um.owner_acc = gm.account_id and um.conv_key = p_to)
       and not exists (select 1 from public.profiles pf where pf.account_id = gm.account_id and coalesce(pf.mutes, '{}'::jsonb) ? p_to)
       and not exists (select 1 from public.push_log pl where pl.ref = 'g:' || m.id::text || ':' || gm.account_id)
       and not exists (select 1 from public.conversations c
                        where c.owner_acc = gm.account_id and c.conv_key = p_to
                          and c.last_read_ts is not null and c.last_read_ts >= m.created_at)
  )
  select array_agg(acc) filter (where not online), count(*) filter (where online)
    into accs, n_on from cand;

  if accs is null then
    return jsonb_build_object('skip', case when coalesce(n_on, 0) > 0 then 'online' else 'done' end);
  end if;

  delete from public.push_log where at < now() - interval '1 hour';
  with ins as (
    insert into public.push_log (ref, from_acc, to_acc)
    select 'g:' || m.id::text || ':' || a, me, a from unnest(accs) a
    on conflict (ref) do nothing
    returning to_acc
  )
  select array_agg(to_acc) into accs from ins;   -- 同时来了两次请求：只推没被另一次抢先记下的
  if accs is null then return jsonb_build_object('skip', 'dup'); end if;

  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'preview', s.preview))
    into subs from public.push_subs s where s.acc = any(accs);
  if subs is null then return jsonb_build_object('skip', 'nosub'); end if;

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
  return jsonb_build_object('subs', subs, 'title', gname, 'body', b, 'hidden', h,
    'tag', 'g:' || gid, 'url', './#g=' || gid, 'ttl', 86400, 'kind', 'gmsg', 'from', me);
end $fn$;
revoke all on function public.push_job_gmsg(uuid, text, text) from public, anon, authenticated;
grant execute on function public.push_job_gmsg(uuid, text, text) to service_role;

-- push_job 外壳里加一个分支：群消息走上面的新函数（外壳其余部分原样保留）
do $$
declare def text; nw text;
begin
  def := pg_get_functiondef('public.push_job(uuid,text,text,text)'::regprocedure);
  if position('push_job_gmsg' in def) = 0 then
    nw := replace(def, $x$  if p_kind = 'edit' then$x$, $x$  if p_kind = 'gmsg' then
    return public.push_job_gmsg(p_uid, p_ref, p_to);   -- 群消息：按成员记录，支持补推
  end if;

  if p_kind = 'edit' then$x$);
    if nw = def then raise exception '没找到 push_job 里放群消息分支的位置。请把这句提示发给 Claude。这次什么都没改'; end if;
    execute nw;
  end if;
end $$;
revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;


-- ========== 检查表 ==========
insert into _chatter_1117
select 2, '实时广播只能发给好友/群友',
       case when exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                          and policyname = 'chatter_rt_send' and with_check like '%rt_can_send%') then '是' else '否' end
union all
select 3, '群消息补推',
       case when position('push_job_gmsg' in pg_get_functiondef('public.push_job(uuid,text,text,text)'::regprocedure)) > 0
            then '是' else '否' end
union all
select 4, '退出其他设备（停推送 + 读不到聊天）',
       case when to_regprocedure('public.kick_others(text)') is not null
             and (select count(*) from pg_policies where schemaname = 'public' and policyname = 'chatter_session_alive') >= 4
            then '是' else '否' end;

commit;

select 序号, 项目, 结果 from _chatter_1117 order by 序号;
