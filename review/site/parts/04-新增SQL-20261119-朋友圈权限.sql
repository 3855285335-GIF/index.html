-- Chatter 11-19（Claude）—— 朋友圈权限。现在就可以运行（和旧版 App 也兼容），可以重复执行
-- 在哪运行：https://supabase.com/dashboard/project/uaoiqbxptnbrvkzjwguc/sql/new
--   整份粘贴进去 → 点右下角“Run”（运行）；如果弹出“Potential issue detected with your query”（检测到查询可能有问题），点“Run this query”（运行此查询）
-- 做了什么：
--   1. 发朋友圈可以选“不给谁看”；“部分可见 / 不给谁看”的名单单独放一张表，只有作者自己读得到
--      （以前名单写在动态本身里，能看到这条的人都能读到整份名单——比如知道你排除了谁）
--   2. 好友资料页“朋友圈权限”：不让对方看我的朋友圈、不看对方的朋友圈
--   3. 评论只看得到自己好友的（加上作者的、自己的、回复自己的）；点赞所有能看到这条的人都看得到
--   4. 修了一个小漏洞：以前能拿别人的账号去问“他能不能看这条”，借此推出谁被排除了；现在只能问自己
-- 整份在一个事务里：出错会全部撤销，什么都不改。最后显示一张检查表，每行都是“是”就对了。
-- 撤销脚本在仓库 supabase/rollback/20261119150000_chatter_moment_privacy.sql（撤销时设过“不给谁看”的动态会改成仅自己可见，不会露给被排除的人）

begin;
set local lock_timeout = '5s';

alter table public.moments add column if not exists hidden_from text[];
alter table public.friendships add column if not exists hide_moments boolean not null default false;   -- 我这一行：不让他看我的朋友圈
alter table public.friendships add column if not exists skip_moments boolean not null default false;   -- 我这一行：不看他的朋友圈

-- 可见名单：只有作者能读；只能通过下面的触发器和函数写
create table if not exists public.moment_audience (
  moment_id  uuid primary key references public.moments(id) on delete cascade deferrable initially deferred,
  only_accs  text[],   -- 部分可见：只给这些人看
  hide_accs  text[],   -- 不给谁看
  updated_at timestamptz not null default now()
);
alter table public.moment_audience enable row level security;
revoke all on table public.moment_audience from public, anon, authenticated;
grant select on table public.moment_audience to authenticated;
grant all on table public.moment_audience to service_role;
drop policy if exists moment_audience_author on public.moment_audience;
create policy moment_audience_author on public.moment_audience for select to authenticated
  using (exists (select 1 from public.moments m where m.id = moment_audience.moment_id and m.author_acc = (select public.my_acc())));

-- 发表或修改时：把 visible_to / hidden_from 挪进名单表，moments 里不留（旧版 App 写的 visible_to 也一样挪走）
create or replace function public.moment_audience_capture()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  o text[] := (select array_agg(distinct x order by x) from unnest(coalesce(new.visible_to, '{}'::text[])) x where coalesce(x, '') <> '');
  h text[] := (select array_agg(distinct x order by x) from unnest(coalesce(new.hidden_from, '{}'::text[])) x where coalesce(x, '') <> '');
begin
  if o is not null or h is not null then
    insert into public.moment_audience (moment_id, only_accs, hide_accs) values (new.id, o, h)
    on conflict (moment_id) do update set only_accs = excluded.only_accs, hide_accs = excluded.hide_accs, updated_at = now();
  elsif tg_op = 'UPDATE' then
    delete from public.moment_audience where moment_id = new.id;   -- 改回“全部好友”
  end if;
  new.visible_to := null;
  new.hidden_from := null;
  return new;
end $$;
revoke all on function public.moment_audience_capture() from public, anon, authenticated;

-- 以前存在 visible_to 里的名单搬过去（先摘掉触发器再搬，否则清空 visible_to 时会把刚搬的名单删掉）
drop trigger if exists moments_audience_ins on public.moments;
drop trigger if exists moments_audience_upd on public.moments;
insert into public.moment_audience (moment_id, only_accs, hide_accs)
select id, nullif(visible_to, '{}'::text[]), nullif(hidden_from, '{}'::text[]) from public.moments
 where (visible_to is not null and cardinality(visible_to) > 0) or (hidden_from is not null and cardinality(hidden_from) > 0)
on conflict (moment_id) do nothing;
update public.moments set visible_to = null, hidden_from = null where visible_to is not null or hidden_from is not null;

create trigger moments_audience_ins before insert on public.moments
  for each row execute function public.moment_audience_capture();
create trigger moments_audience_upd before update of visible_to, hidden_from on public.moments
  for each row execute function public.moment_audience_capture();

-- 名单和“不让他看”的判断（内部用，手机不能直接调）
create or replace function public.moment_audience_ok_for(p_moment uuid, p_author text, p_acc text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_acc is not null
     and not exists (select 1 from public.friendships f where f.owner_acc = p_author and f.friend_acc = p_acc and f.hide_moments)
     and not exists (select 1 from public.moment_audience a where a.moment_id = p_moment
                      and ((a.only_accs is not null and not (p_acc = any(a.only_accs))) or p_acc = any(coalesce(a.hide_accs, '{}'::text[]))));
$$;
revoke all on function public.moment_audience_ok_for(uuid, text, text) from public, anon, authenticated;

-- 给朋友圈列表的规则用：只回答“我”
create or replace function public.moment_audience_ok(p_moment uuid, p_author text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.moment_audience_ok_for(p_moment, p_author, public.my_acc());
$$;
revoke all on function public.moment_audience_ok(uuid, text) from public, anon, authenticated;
grant execute on function public.moment_audience_ok(uuid, text) to authenticated, service_role;

-- 能不能看某条：手机上调用时 p_acc 必须是自己；服务器（service_role）和后台 SQL 可以查任何人
create or replace function public.can_see_moment(p_moment uuid, p_acc text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_acc is not null
     and (p_acc = public.my_acc() or coalesce(auth.jwt() ->> 'role', '') not in ('anon', 'authenticated'))
     and exists (
       select 1 from public.moments m
        where m.id = p_moment
          and (m.author_acc = p_acc
               or (m.visibility = 'friends'
                   and exists (select 1 from public.friendships f where f.owner_acc = p_acc and f.friend_acc = m.author_acc)
                   and (m.visible_to is null or p_acc = any(m.visible_to))
                   and not (p_acc = any(coalesce(m.hidden_from, '{}'::text[])))
                   and public.moment_audience_ok_for(m.id, m.author_acc, p_acc))));
$$;
revoke all on function public.can_see_moment(uuid, text) from public, anon;
grant execute on function public.can_see_moment(uuid, text) to authenticated, service_role;

-- 评论能不能看（看的人 = 我）：作者看全部；自己写的、回复自己的都看得到；
-- 其余的：写评论的人是作者或我的好友，而且（如果是回复）被回复的人也是作者或我的好友
create or replace function public.can_see_comment(p_moment uuid, p_author text, p_reply_to text)
returns boolean language sql stable security definer set search_path = '' as $$
  with me as (select public.my_acc() as acc),
       mo as (select m.author_acc from public.moments m where m.id = p_moment)
  select coalesce((
    select me.acc is not null and (
         mo.author_acc = me.acc or p_author = me.acc or p_reply_to = me.acc
      or ((p_author = mo.author_acc or exists (select 1 from public.friendships f where f.owner_acc = me.acc and f.friend_acc = p_author))
          and (p_reply_to is null or p_reply_to = mo.author_acc
               or exists (select 1 from public.friendships f where f.owner_acc = me.acc and f.friend_acc = p_reply_to))))
    from me, mo), false);
$$;
revoke all on function public.can_see_comment(uuid, text, text) from public, anon;
grant execute on function public.can_see_comment(uuid, text, text) to authenticated, service_role;

-- 转发别人的朋友圈前问一下：这条是不是对全部好友公开（只回答是或否，不透露名单）
create or replace function public.moment_is_open(p_moment uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_see_moment(p_moment, public.my_acc())
     and exists (select 1 from public.moments m where m.id = p_moment and m.visibility = 'friends')
     and not exists (select 1 from public.moment_audience a where a.moment_id = p_moment);
$$;
revoke all on function public.moment_is_open(uuid) from public, anon;
grant execute on function public.moment_is_open(uuid) to authenticated, service_role;

-- 好友朋友圈权限：null = 不改
create or replace function public.set_moment_perm(p_friend text, p_hide boolean default null, p_skip boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me text := public.my_acc(); h boolean; s boolean;
begin
  if me is null then raise exception 'not authenticated'; end if;
  update public.friendships
     set hide_moments = coalesce(p_hide, hide_moments), skip_moments = coalesce(p_skip, skip_moments)
   where owner_acc = me and friend_acc = p_friend
   returning hide_moments, skip_moments into h, s;
  if not found then raise exception 'not friends'; end if;
  return jsonb_build_object('hide', h, 'skip', s);
end $$;
revoke all on function public.set_moment_perm(text, boolean, boolean) from public, anon;
grant execute on function public.set_moment_perm(text, boolean, boolean) to authenticated, service_role;

-- 规则
drop policy if exists moments_select on public.moments;
create policy moments_select on public.moments for select to authenticated using (
  author_acc = (select public.my_acc())
  or (visibility = 'friends'
      and exists (select 1 from public.friendships f where f.owner_acc = (select public.my_acc()) and f.friend_acc = moments.author_acc)
      and visible_to is null and hidden_from is null
      and public.moment_audience_ok(id, author_acc))
);
drop policy if exists moment_comments_select on public.moment_comments;
create policy moment_comments_select on public.moment_comments for select to authenticated
  using (public.can_see_moment(moment_id, (select public.my_acc())) and public.can_see_comment(moment_id, author_acc, reply_to_acc));

-- ========== 检查表 ==========
create temp table if not exists _chatter_1119m (序号 int, 项目 text, 结果 text) on commit preserve rows;
truncate _chatter_1119m;
insert into _chatter_1119m
select 1, '名单表（只有作者读得到，手机不能直接写）', case when to_regclass('public.moment_audience') is not null
  and (select relrowsecurity from pg_class where oid = 'public.moment_audience'::regclass)
  and not has_table_privilege('authenticated', 'public.moment_audience', 'insert') and not has_table_privilege('anon', 'public.moment_audience', 'select') then '是' else '否' end
union all select 2, '发表、修改时名单自动挪走（触发器）', case when (select count(*) from pg_trigger where tgrelid = 'public.moments'::regclass and tgname in ('moments_audience_ins', 'moments_audience_upd')) = 2 then '是' else '否' end
union all select 3, '动态本身里不再留名单', case when not exists (select 1 from public.moments where visible_to is not null or hidden_from is not null) then '是；名单表里 ' || (select count(*) from public.moment_audience) || ' 条' else '否' end
union all select 4, '好友朋友圈权限（不让他看、不看他）', case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'friendships' and column_name = 'hide_moments')
  and has_function_privilege('authenticated', 'public.set_moment_perm(text,boolean,boolean)', 'execute') then '是' else '否' end
union all select 5, '朋友圈和评论的规则已换新', case when (select qual from pg_policies where tablename = 'moments' and policyname = 'moments_select') like '%moment_audience_ok%'
  and (select qual from pg_policies where tablename = 'moment_comments' and policyname = 'moment_comments_select') like '%can_see_comment%' then '是' else '否' end
union all select 6, '不能再拿别人的账号去试（没登录的也调不了）', case when not has_function_privilege('anon', 'public.can_see_moment(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.moment_audience_ok_for(uuid,text,text)', 'execute')
  and pg_get_functiondef('public.can_see_moment(uuid,text)'::regprocedure) like '%my_acc()%' then '是' else '否' end;

commit;

select 序号, 项目, 结果 from _chatter_1119m order by 序号;
