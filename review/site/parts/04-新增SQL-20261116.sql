-- Chatter 修复 SQL（2026-11-16，Claude 整理）—— 可以重复执行，跑两次也没关系
-- 只做两件事：① 去掉会吞掉“编辑推送”的触发器（如果有）② 编辑消息后，会话列表的预览跟着变
begin;

-- ① 编辑推送：通知是网页端 firePush('edit') 叫推送函数发出去的。
--    如果数据库里还挂着调用 push_on_edit 的触发器，它会先把“这次编辑已推过”记进 push_log，
--    但触发器自己发不出通知，等网页端真去推的时候就被当成重复跳过了 → 对方永远收不到。
do $$
declare r record;
begin
  for r in
    select t.tgname
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace n on n.oid = p.pronamespace
     where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal
       and n.nspname = 'public' and p.proname = 'push_on_edit'
  loop
    execute format('drop trigger %I on public.messages', r.tgname);
    raise notice '已删除触发器 %', r.tgname;
  end loop;
end $$;

-- ② 编辑后会话预览：只有改的是“这个会话最后一条”才改预览；收到的人看到“（已编辑）…”，发的人看到新内容
create or replace function public.conv_last_on_edit()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare t text;
begin
  if new.type <> 'text' or old.type <> 'text' or new.body is not distinct from old.body then return new; end if;
  begin
    -- 去掉引用前缀（⁣Q…），跟推送正文同一个写法
    t := btrim(regexp_replace(regexp_replace(coalesce(new.body, ''), '^⁣Q[^⁣]*⁣[^⁣]*⁣', ''), '[\s⁣]+', ' ', 'g'));
    if left(new.conv_key, 2) = 'g:' then
      update public.conversations
         set last_body = substr(case when owner_acc = new.from_acc then t else '（已编辑）' || t end, 1, 50)
       where conv_key = new.conv_key and last_ts = new.created_at;
    else
      update public.conversations
         set last_body = left(case when owner_acc = new.from_acc then t else '（已编辑）' || t end, 200)
       where conv_key = new.conv_key and last_ts = new.created_at;
    end if;
  exception when others then null;   -- 预览没改成也不许影响编辑本身
  end;
  return new;
end $fn$;
revoke all on function public.conv_last_on_edit() from public, anon, authenticated;

drop trigger if exists trg_conv_last_on_edit on public.messages;
create trigger trg_conv_last_on_edit after update of body on public.messages
  for each row execute function public.conv_last_on_edit();

commit;

-- ③ 只读检查（不改任何东西）：把结果整张截图发给 Claude
select 1 as 序号, f.oid::regprocedure::text as 项目,
       case when has_function_privilege('authenticated', f.oid, 'execute') then '登录用户能调用' else '登录用户不能调用' end as 状态
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
 where n.nspname = 'public'
   and f.proname in ('join_group_by_link', 'kick_group_member', 'kick_member_v2', 'ensure_group_link', 'group_link_info', 'push_job_edit')
union all
select 2, 'join_group_by_link(uuid,text) 查了踢人名单/链接口令',
       case when bool_or(pg_get_functiondef(f.oid) ilike '%group_kicks%') then '查了踢人名单' else '没查踢人名单' end || ' / ' ||
       case when bool_or(pg_get_functiondef(f.oid) ilike '%p_token%') then '查了口令' else '没查口令' end
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
 where n.nspname = 'public' and f.proname = 'join_group_by_link' and f.pronargs = 2
union all
select 3, 'messages 上的触发器：' || t.tgname, p.proname
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal
union all
select 4, 'messages 上的索引：' || indexname, left(indexdef, 120)
  from pg_indexes where schemaname = 'public' and tablename = 'messages'
order by 1, 2;
