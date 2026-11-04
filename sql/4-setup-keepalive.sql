-- ============================================================
-- Chatter 保活补丁（可重复执行，不改动任何现有数据）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
--
-- 作用：建一个“签到”函数 keepalive()。GitHub 上的定时任务每天调用它一次，
--       让 Supabase 认为项目一直有人在用，免费项目就不会因为 7 天不活跃被暂停。
-- 安全：签到表网页端读写不了；函数只会更新一行时间，1 分钟内重复调用不会重复写入。
-- ============================================================

create table if not exists public.keepalive_state (
  id        integer primary key default 1 check (id = 1),
  last_ping timestamptz not null default now(),
  pings     bigint not null default 0
);

alter table public.keepalive_state enable row level security;
-- 不建任何策略：网页端不能直接读写这张表，只能通过下面的函数签到
revoke all on table public.keepalive_state from anon, authenticated;

create or replace function public.keepalive()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.keepalive_state;
begin
  insert into public.keepalive_state as k (id, last_ping, pings)
  values (1, now(), 1)
  on conflict (id) do update
    set last_ping = now(), pings = k.pings + 1
    where k.last_ping < now() - interval '1 minute'
  returning * into r;
  if not found then
    select * into r from public.keepalive_state where id = 1;
  end if;
  return jsonb_build_object('ok', true, 'last_ping', r.last_ping, 'pings', r.pings);
end $$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;

-- 完成 ✅  运行后可以在 Table Editor 里看到 keepalive_state 表，last_ping 是最近一次签到时间
