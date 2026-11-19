-- 撤销 11-19 朋友圈权限。注意：撤销后“不给谁看”“不让他看”都不再生效；
-- 为了不把内容露给被排除的人，设过“不给谁看”的动态撤销时改成“仅自己可见”。
begin;
set local lock_timeout = '5s';

drop policy if exists moments_select on public.moments;
create policy moments_select on public.moments for select to public using (
  (author_acc = my_acc()) or ((visibility = 'friends'::text) and (exists (select 1 from friendships f
    where ((f.owner_acc = my_acc()) and (f.friend_acc = moments.author_acc)))) and ((visible_to is null) or (my_acc() = any (visible_to))))
);
drop policy if exists moment_comments_select on public.moment_comments;
create policy moment_comments_select on public.moment_comments for select to authenticated
  using (can_see_moment(moment_id, my_acc()));

drop trigger if exists moments_audience_ins on public.moments;
drop trigger if exists moments_audience_upd on public.moments;

update public.moments m set visible_to = a.only_accs from public.moment_audience a
 where a.moment_id = m.id and a.only_accs is not null and a.hide_accs is null;
update public.moments m set visibility = 'private' from public.moment_audience a
 where a.moment_id = m.id and a.hide_accs is not null;

CREATE OR REPLACE FUNCTION public.can_see_moment(p_moment uuid, p_acc text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.moments m
     where m.id = p_moment
       and (
         m.author_acc = p_acc
         or (m.visibility = 'friends'
             and exists (select 1 from public.friendships f where f.owner_acc = p_acc and f.friend_acc = m.author_acc)
             and (m.visible_to is null or p_acc = any(m.visible_to)))
       )
  );
$function$;
grant execute on function public.can_see_moment(uuid, text) to public, anon, authenticated;

drop function if exists public.set_moment_perm(text, boolean, boolean);
drop function if exists public.moment_is_open(uuid);
drop function if exists public.can_see_comment(uuid, text, text);
drop function if exists public.moment_audience_ok(uuid, text);
drop function if exists public.moment_audience_ok_for(uuid, text, text);
drop function if exists public.moment_audience_capture();
drop table if exists public.moment_audience;
alter table public.friendships drop column if exists skip_moments;
alter table public.friendships drop column if exists hide_moments;
alter table public.moments drop column if exists hidden_from;

commit;
