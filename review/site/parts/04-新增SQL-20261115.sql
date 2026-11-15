-- 2026-11-15 新增：朋友圈评论真 @（moment_mentions）
-- 已在 Supabase 执行成功（幂等，可重跑）

-- moment-mentions-v1.sql
-- 朋友圈评论「真 @」：被 @ 的人在「最近互动」里看到提醒（App 内红点）
-- 幂等，可重复执行

begin;

create table if not exists public.moment_mentions (
  id uuid primary key default gen_random_uuid(),
  moment_id uuid not null references public.moments(id) on delete cascade,
  comment_id uuid,
  from_acc text not null,
  to_acc text not null,
  body text not null default '',
  created_at timestamptz not null default now(),
  seen_at timestamptz
);

create index if not exists moment_mentions_to_idx on public.moment_mentions(to_acc, created_at desc);
create index if not exists moment_mentions_from_idx on public.moment_mentions(from_acc, created_at desc);

alter table public.moment_mentions enable row level security;

revoke all on public.moment_mentions from anon;
grant select, insert, update, delete on public.moment_mentions to authenticated;

-- 只有被 @ 的人能读自己的
drop policy if exists mm_sel on public.moment_mentions;
create policy mm_sel on public.moment_mentions for select to authenticated
  using (to_acc = public.my_acc());

-- 只能以自己身份 @ 一条自己能看见的朋友圈
drop policy if exists mm_ins on public.moment_mentions;
create policy mm_ins on public.moment_mentions for insert to authenticated
  with check (from_acc = public.my_acc() and public.can_see_moment(moment_id, public.my_acc()));

-- 只能标记自己那条为已读（前端只改 seen_at）
drop policy if exists mm_upd on public.moment_mentions;
create policy mm_upd on public.moment_mentions for update to authenticated
  using (to_acc = public.my_acc())
  with check (to_acc = public.my_acc());

drop policy if exists mm_del on public.moment_mentions;
create policy mm_del on public.moment_mentions for delete to authenticated
  using (from_acc = public.my_acc());

commit;
