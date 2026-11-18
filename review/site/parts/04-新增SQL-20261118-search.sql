-- Chatter 11-18（Claude 整理）—— 第 1 步“自己的搜索”要用的数据库部分，可以重复执行
--   1. search_cache：搜索结果缓存 24 小时，同样的搜索不重复花额度（只有服务器能读写）
--   2. search_usage：每人每天搜索次数、每月总次数（防止额度被一下子用光；只有服务器能读写）
--   3. search_prefs：每个人自己的搜索规则（置顶网站、不想看的网站、开关），换手机也在
--   4. app_config 里的 'search'：默认的营销号名单、优先网站名单、每人每天上限——以后改只要运行 SQL
-- 整份在一个事务里，出错会全部撤销。最后列一张检查表。

begin;

create temp table if not exists _chatter_1118 (序号 int, 项目 text, 结果 text) on commit preserve rows;
truncate _chatter_1118;

do $$
begin
  if to_regclass('public.app_config') is null or to_regclass('public.profiles') is null then
    raise exception '这不是 Chatter 的数据库（缺 app_config / profiles）。请确认网址里是 uaoiqbxptnbrvkzjwguc。这次什么都没改';
  end if;
end $$;

-- ========== 1. 搜索结果缓存 ==========
create table if not exists public.search_cache (
  k  text primary key,
  v  jsonb not null,
  at timestamptz not null default now()
);
alter table public.search_cache enable row level security;   -- 不建任何规则：手机上读不到，只有服务器函数能用
create index if not exists search_cache_at on public.search_cache (at);

-- ========== 2. 用量计数 ==========
create table if not exists public.search_usage (
  uid  uuid not null,
  day  date not null,
  kind text not null,
  n    integer not null default 0,
  primary key (uid, day, kind)
);
alter table public.search_usage enable row level security;   -- 同上，只有服务器函数能用

-- 加一次计数；已经到上限就不加，返回 -1。按北京时间算“每天”“每月”
create or replace function public.search_bump(p_uid uuid, p_kind text, p_limit integer, p_month boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Shanghai')::date; v integer;
begin
  if p_month then d := date_trunc('month', d)::date; end if;
  insert into public.search_usage (uid, day, kind, n) values (p_uid, d, p_kind, 1)
  on conflict (uid, day, kind) do update set n = search_usage.n + 1
    where search_usage.n < p_limit
  returning search_usage.n into v;
  return coalesce(v, -1);
end $$;
revoke all on function public.search_bump(uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.search_bump(uuid, text, integer, boolean) to service_role;

-- ========== 3. 个人搜索规则 ==========
create table if not exists public.search_prefs (
  uid        uuid primary key default auth.uid(),
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.search_prefs enable row level security;
drop policy if exists search_prefs_own on public.search_prefs;
create policy search_prefs_own on public.search_prefs for all to authenticated
  using (uid = auth.uid()) with check (uid = auth.uid());
grant select, insert, update on public.search_prefs to authenticated;

-- ========== 4. 默认名单和上限（已经有就不覆盖，你改过的不会被冲掉） ==========
insert into public.app_config (key, value, updated_at) values ('search', jsonb_build_object(
  'enabled', true,
  'per_user_day', 80,            -- 每人每天最多搜几次（缓存命中不算）
  'read_per_user_day', 300,      -- 每人每天最多打开几次简洁阅读
  'month_cap', 2400,             -- 每月总共最多搜几次（Serper 注册送 2500 次，留一点余量）
  'farms', jsonb_build_array(    -- 营销号、内容农场：打开“隐藏营销号”时不显示
    'baijiahao.baidu.com', 'mbd.baidu.com', 'jingyan.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com',
    'toutiao.com', 'sohu.com/a/', '163.com/dy/', '360doc.com', 'docin.com', 'doc88.com', 'book118.com'),
  'clean', jsonb_build_array(    -- 打开“干净页面优先”时往前排（写后缀就行）
    'wikipedia.org', 'github.com', 'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org',
    'arxiv.org', 'britannica.com', 'nature.com', '.gov', '.edu', '.gov.cn', '.edu.cn'),
  'direct', jsonb_build_array(   -- 要登录或者不让服务器取内容的网站：点了直接用浏览器打开，不走简洁阅读
    'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'pinterest.com', 'quora.com',
    'tiktok.com', 'weibo.com', 'weibo.cn', 'xiaohongshu.com', 'douyin.com', 'zhihu.com')
), now())
on conflict (key) do nothing;

-- ========== 检查表 ==========
insert into _chatter_1118
select 1, '搜索缓存表', case when to_regclass('public.search_cache') is not null then '是' else '否' end
union all
select 2, '用量计数（每人每天、每月总数）', case when to_regprocedure('public.search_bump(uuid,text,integer,boolean)') is not null then '是' else '否' end
union all
select 3, '个人搜索规则表（只能看到自己的）', case when exists (select 1 from pg_policies where tablename = 'search_prefs' and policyname = 'search_prefs_own') then '是' else '否' end
union all
select 4, '默认名单和上限', coalesce((select '每人每天 ' || (value ->> 'per_user_day') || ' 次，每月总共 ' || (value ->> 'month_cap') || ' 次' from public.app_config where key = 'search'), '否');

commit;

select 序号, 项目, 结果 from _chatter_1118 order by 序号;
