-- ============================================================
-- Chatter 后端补丁 v4：国内模式（可重复执行，不改动任何现有数据）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
--
-- 国内网络会拦截 Supabase 的“实时通道”（WebSocket），但普通请求是通的。
-- 这个补丁让通话信号、“正在输入”、在线状态可以改走普通请求：
--   1. signals 表 + send_signal() / take_signals()：通话信号的“信箱”
--   1.5 poll_inbox()：长轮询收件箱，有新消息/信号立刻返回（代替实时通道）
--   2. presence 表 + heartbeat() / friends_seen()：在线状态
-- 两张表网页端都不能直接读写，只能通过这几个函数，且只能发给好友、只能收自己的。
-- ============================================================


-- ========== 1. 通话信号信箱 ==========
create table if not exists public.signals (
  id         bigserial primary key,
  to_acc     text not null,
  from_acc   text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists signals_to_idx on public.signals (to_acc, id);
alter table public.signals enable row level security;
revoke all on table public.signals from anon, authenticated;

-- 发信号：只能发给自己的好友；顺手清理 10 分钟前没人取走的旧信号
create or replace function public.send_signal(p_to text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.friendships where owner_acc = me and friend_acc = p_to) then
    raise exception 'not friends';
  end if;
  if octet_length(p_payload::text) > 60000 then raise exception 'payload too large'; end if;
  delete from public.signals where created_at < now() - interval '10 minutes';
  insert into public.signals (to_acc, from_acc, payload) values (p_to, me, p_payload);
end $$;

-- 取信号：取走发给自己的全部信号（取完即删），只返回 1 分钟内的（过期的来电不会再响）
create or replace function public.take_signals()
returns table (id bigint, from_acc text, payload jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then return; end if;
  return query
    with d as (
      delete from public.signals s where s.to_acc = me
      returning s.id, s.from_acc, s.payload, s.created_at
    )
    select d.id, d.from_acc, d.payload, d.created_at from d
     where d.created_at > now() - interval '60 seconds'
     order by d.id;
end $$;


-- ========== 2.5 收件箱长轮询：有新消息/信号立刻返回，没有就最多等 2.5 秒 ==========
-- 国内网络下用它代替实时通道：手机拿到结果后马上再问，所以消息几乎是到了就显示
create or replace function public.poll_inbox(p_since timestamptz, p_wait_ms integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me       text := public.my_acc();
  since    timestamptz := coalesce(p_since, now() - interval '60 seconds');
  deadline timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_wait_ms, 0), 0), 2500) / 1000.0);
  msgs     jsonb;
  sigs     jsonb;
  fresh    integer;
begin
  if me is null then return null; end if;
  loop
    -- 新消息（往回多给 15 秒，客户端会去重，防止漏掉同一时刻提交的消息）
    select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at), '[]'::jsonb),
           count(*) filter (where m.created_at > since)
      into msgs, fresh
      from (select * from public.messages
             where to_acc = me and created_at > since - interval '15 seconds'
             order by created_at limit 100) m;
    -- 信号：取走即删，只返回 1 分钟内的
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
end $$;


-- ========== 2. 在线状态 ==========
create table if not exists public.presence (
  account_id text primary key,
  last_seen  timestamptz
);
alter table public.presence enable row level security;
revoke all on table public.presence from anon, authenticated;

-- 报到：App 打开时每 30 秒调用一次；切到后台时调用 heartbeat(false) 标记离线
create or replace function public.heartbeat(p_online boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then return; end if;
  insert into public.presence (account_id, last_seen)
  values (me, case when p_online then now() else null end)
  on conflict (account_id) do update set last_seen = excluded.last_seen;
end $$;

-- 查好友在线：75 秒内报到过算在线（由服务器判断，不受手机时间影响）
create or replace function public.friends_seen()
returns table (account_id text, online boolean)
language sql stable security definer set search_path = public as $$
  select f.friend_acc,
         coalesce(p.last_seen > now() - interval '75 seconds', false)
    from public.friendships f
    left join public.presence p on p.account_id = f.friend_acc
   where f.owner_acc = public.my_acc()
$$;


-- ========== 3. 权限：只有登录用户能调用 ==========
revoke all on function public.send_signal(text, jsonb) from public, anon;
revoke all on function public.take_signals()           from public, anon;
revoke all on function public.poll_inbox(timestamptz, integer) from public, anon;
revoke all on function public.heartbeat(boolean)        from public, anon;
revoke all on function public.friends_seen()            from public, anon;
grant execute on function public.send_signal(text, jsonb) to authenticated;
grant execute on function public.take_signals()           to authenticated;
grant execute on function public.poll_inbox(timestamptz, integer) to authenticated;
grant execute on function public.heartbeat(boolean)        to authenticated;
grant execute on function public.friends_seen()            to authenticated;

-- 完成 ✅
