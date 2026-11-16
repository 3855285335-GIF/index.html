-- Chatter 清理 SQL（2026-11-16 第二份，Claude 整理）—— 可以重复执行
begin;

-- ① 编辑预览只留一个触发器：保留 trg_conv_last_on_edit（和网页端的“（已编辑）”写法一致），
--    删掉另一个（它会把发送人自己的预览也加上“ · 已编辑”，还排在后面把前一个的结果盖掉）
drop trigger if exists trg_refresh_conv_last_edit on public.messages;
drop function if exists public.refresh_conv_last_on_edit();

-- ② 删掉 4 个重复的索引（每发一条消息都要多写一遍，白占空间）。
--    留下的索引已经覆盖同样的查询；删错了也能重建，不伤数据
drop index if exists public.idx_messages_conv_created;   -- 和 messages_conv_created_idx 完全一样
drop index if exists public.messages_conv_idx;           -- (conv_key, created_at) 被上面那个包含
drop index if exists public.idx_messages_from_acc;       -- 被 messages_from_idx (from_acc, created_at) 包含
drop index if exists public.idx_messages_to_acc;         -- 被 messages_to_idx (to_acc, created_at) 包含

-- ③ 群邀请口令一直生成失败：gen_random_bytes 装在 extensions 里，函数只在 public 里找（6 个群 0 个有口令）
create or replace function public.ensure_group_link(p_gid uuid)
returns text language plpgsql security definer set search_path to 'public' as $fn$
declare me text := public.my_acc(); tok text;
begin
  if me is null then return null; end if;
  if not exists (select 1 from public.chat_group_members where group_id = p_gid and account_id = me) then return null; end if;
  select link_token into tok from public.chat_groups where id = p_gid;
  if tok is null then
    tok := encode(extensions.gen_random_bytes(9), 'hex');   -- 18 位，和网页端的格式一致
    update public.chat_groups set link_token = tok where id = p_gid;
  end if;
  return tok;
end $fn$;

-- ④ 旧踢人函数不再让网页直接调用（它不记踢人名单，被踢的人能用链接回来）；
--    新版 kick_member_v2 是以数据库身份调用它的，不受影响
revoke execute on function public.kick_group_member(uuid, text) from public, anon, authenticated;

-- ⑤ 旧的单参数加群函数：已经不能调用了，直接删掉
drop function if exists public.join_group_by_link(uuid);

commit;

-- ⑥ 只读检查：看结果是否和预期一样
select '编辑触发器' as 项目, string_agg(t.tgname, '、') as 结果
  from pg_trigger t where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal and t.tgname like '%edit%'
union all
select 'messages 索引数', count(*)::text from pg_indexes where schemaname = 'public' and tablename = 'messages'
union all
select '旧踢人函数登录用户能调用', has_function_privilege('authenticated', 'public.kick_group_member(uuid,text)', 'execute')::text
union all
select '加群函数还有几个', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'join_group_by_link';
