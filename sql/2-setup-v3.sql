-- ============================================================
-- Chatter 后端补丁 v3（在你已经运行过 setup.sql v2 的基础上追加，可重复执行）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
-- 不会改动、不会删除任何现有数据和策略。
--
-- 这个补丁带来：
--   1. 已读回执永久保存（对方离线时看过消息，你之后也能看到“已读”）
--   2. 已读时间改用服务器时间（不受手机时间不准影响）
--   3. “我的 → 存储空间”里可以查看并清理自己发送的图片/语音
-- ============================================================


-- ========== 1. 标记已读（服务器时间）==========
create or replace function public.mark_read(p_conv text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.my_acc();
begin
  if me is null then return; end if;
  update public.conversations
     set unread = 0, last_read_ts = now()
   where owner_acc = me and conv_key = p_conv;
end $$;


-- ========== 2. 查询对方已读到什么时候 ==========
-- 只有会话双方才能查询；返回对方在该会话里的 last_read_ts
create or replace function public.peer_read(p_conv text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select c2.last_read_ts
    from public.conversations c1
    join public.conversations c2
      on c2.conv_key = c1.conv_key and c2.owner_acc = c1.peer_acc
   where c1.owner_acc = public.my_acc()
     and c1.conv_key  = p_conv
$$;

revoke all on function public.mark_read(text)  from public, anon;
revoke all on function public.peer_read(text)  from public, anon;
grant execute on function public.mark_read(text)  to authenticated;
grant execute on function public.peer_read(text)  to authenticated;


-- ========== 3. 存储：允许列出 / 删除“自己文件夹”里的文件 ==========
drop policy if exists "chat-media select own" on storage.objects;
create policy "chat-media select own" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.my_acc());

drop policy if exists "chat-media delete own" on storage.objects;
create policy "chat-media delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.my_acc());

-- 完成 ✅
