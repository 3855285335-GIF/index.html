-- Chatter 推送：对方已经读过的消息不再推（2026-11-16 第三份，Claude 整理）—— 可以重复执行
-- 只在 push_job 外壳里加一段“已读就跳过”，其余逻辑原样
do $$
begin
  if position('push_job_edit' in pg_get_functiondef('public.push_job(uuid,text,text,text)'::regprocedure)) = 0 then
    raise exception '线上的 push_job 和预期的不一样，这次先不改，请把这句提示发给 Claude';
  end if;
end $$;

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

  -- 新增：对方已经读到这条了（在 App 里看过），就别再推通知
  if p_kind = 'msg' and p_ref is not null and p_to is not null and p_to <> '' then
    if exists (select 1 from public.messages m
                 join public.conversations c on c.owner_acc = p_to and c.conv_key = m.conv_key
                where m.id::text = p_ref and c.last_read_ts is not null and c.last_read_ts >= m.created_at) then
      return jsonb_build_object('skip', 'read');
    end if;
  end if;

  return public.push_job_base(p_uid, p_kind, p_ref, p_to);
end $function$;

revoke all on function public.push_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.push_job(uuid, text, text, text) to service_role;

select '推送外壳已更新' as 结果, position('skip'', ''read' in pg_get_functiondef('public.push_job(uuid,text,text,text)'::regprocedure)) > 0 as 有已读判断;
