-- ============================================================
-- Chatter 后端补丁 v7：好友备注 + 存储用量（可重复执行，不改动、不删除任何现有数据）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
-- 需要先运行过 5-setup-v6.sql
--
-- 1. 好友备注：每个人给自己的好友起一个只有自己看得到的名字（最多 20 个字），换手机也在
-- 2. storage_used()：统计聊天文件一共占了多少空间（两个人合计），用来在快满时提醒
-- 3. chatter_schema() 改为 7：网页用它判断这份 SQL 有没有运行过
-- ============================================================


-- 整份放在一个事务里：中间任何一句出错，前面做的也会全部撤销，不会只改一半
begin;

-- ========== 0. 先确认是 Chatter 的数据库（选错项目时直接报错，什么都不会改） ==========
do $$ begin
  if to_regclass('public.friendships') is null or to_regclass('public.messages') is null then
    raise exception '这不是 Chatter 的数据库：找不到 friendships / messages 表。请确认页面左上角选的是 Chatter 的项目（地址里应有 uaoiqbxptnbrvkzjwguc），这次什么都没有改动';
  end if;
  if to_regclass('public.stickers') is null then
    raise exception '请先运行 setup-v6.sql（表情包 / 视频 / 文件），再运行这一份。这次什么都没有改动';
  end if;
end $$;


-- ========== 1. 好友备注 ==========
alter table public.friendships add column if not exists remark text not null default '';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'friendships_remark_len') then
    alter table public.friendships add constraint friendships_remark_len check (char_length(remark) <= 20);
  end if;
end $$;

-- 只能改自己好友的备注；空字符串表示删除备注
create or replace function public.set_remark(p_friend text, p_remark text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc(); r text := btrim(coalesce(p_remark, ''));
begin
  if me is null then raise exception 'not authenticated'; end if;
  if char_length(r) > 20 then raise exception 'remark too long'; end if;
  update public.friendships set remark = r where owner_acc = me and friend_acc = p_friend;
  if not found then raise exception 'not friends'; end if;
end $$;
revoke all on function public.set_remark(text, text) from public, anon;
grant execute on function public.set_remark(text, text) to authenticated;


-- ========== 2. 存储用量（字节） ==========
create or replace function public.storage_used()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
    from storage.objects o
   where o.bucket_id = 'chat-media'
$$;
revoke all on function public.storage_used() from public, anon;
grant execute on function public.storage_used() to authenticated;


-- ========== 3. 后端版本号 ==========
create or replace function public.chatter_schema()
returns integer language sql immutable as $$ select 7 $$;
revoke all on function public.chatter_schema() from public, anon;
grant execute on function public.chatter_schema() to authenticated;

commit;

-- 完成 ✅
