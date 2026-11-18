-- Chatter 11-18（Claude 整理）—— 第 1 步“自己的搜索”要用的数据库部分，可以重复执行
--   1. search_cache：搜索结果缓存 24 小时，同样的搜索不重复花额度（只有服务器能读写）
--   2. search_usage：每人每天搜索次数、每家搜索服务每月用了多少次（只有服务器能读写）
--   3. search_prefs：每个人自己的搜索规则（置顶网站、不想看的网站、开关），换手机也在
--   3b. search_keys：搜索服务的密钥（只有服务器能读）
--   4. app_config 里的 'search'：先用哪家、每人每天上限、营销号名单、优先网站名单、翻译设置、知名网站名单——以后改只要运行 SQL
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

-- ========== 3b. 搜索服务的密钥（Exa、Tavily 等）==========
-- 不放 app_config：那张表谁都能读。这张表开了行级安全、收回了手机端的全部权限，只有服务器函数能读。
-- 这里只建表，不写任何密钥；密钥用下面这种语句单独存（改了 1 分钟内生效，不用重新部署）：
--   insert into public.search_keys (name, value) values ('EXA_API_KEY', '你的密钥')
--   on conflict (name) do update set value = excluded.value, updated_at = now();
create table if not exists public.search_keys (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.search_keys enable row level security;
revoke all on public.search_keys from public, anon, authenticated;
grant select, insert, update, delete on public.search_keys to service_role;

-- ========== 4. 默认名单和上限（已经有就不覆盖，你改过的不会被冲掉） ==========
insert into public.app_config (key, value, updated_at) select 'search', jsonb_build_object(
  'enabled', true,
  'per_user_day', 1000000000,    -- 每人每天最多搜几次（10 亿 = 不限）（网页、图片、视频、新闻；搜过的词 24 小时内再搜不算）
  'read_per_user_day', 1000000000, -- 每人每天最多打开几次简洁阅读（含看存档）
  'deep_per_user_day', 1000000000, -- 每人每天最多“深挖”几次（含查历史版本；这些都免费，上限只是防止被滥用）
  'order', jsonb_build_array('exa', 'tavily'),       -- 网页、新闻、视频：先用 Exa，用完换 Tavily
  'img_order', jsonb_build_array('tavily', 'exa'),   -- 图片：先用 Tavily（它能从网页里找图）
  'exa_free', 2500,              -- 只用来在规则页显示“免费约多少次”，不限制使用
  'tavily_free', 1000,
  'farms', jsonb_build_array(    -- 营销号、内容农场：打开“隐藏营销号”时不显示
    'baijiahao.baidu.com', 'mbd.baidu.com', 'jingyan.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com',
    'toutiao.com', 'sohu.com/a/', '163.com/dy/', '360doc.com', 'docin.com', 'doc88.com', 'book118.com'),
  'clean', jsonb_build_array(    -- 打开“干净页面优先”时往前排（写后缀就行）
    'wikipedia.org', 'github.com', 'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org',
    'arxiv.org', 'britannica.com', 'nature.com', '.gov', '.edu', '.gov.cn', '.edu.cn'),
  'direct', jsonb_build_array(   -- 要登录或者不让服务器取内容的网站：点了直接用浏览器打开，不走简洁阅读
    'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'pinterest.com', 'quora.com',
    'tiktok.com', 'weibo.com', 'weibo.cn', 'xiaohongshu.com', 'douyin.com', 'zhihu.com')
), now()
where not exists (select 1 from public.app_config where key = 'search');

-- ========== 4b. 翻译设置、知名网站名单（11-18 下午加；已经有的不覆盖，只补没有的） ==========
update public.app_config set value = jsonb_build_object(
  'tr_order', jsonb_build_array('glm', 'groq'),                                   -- 翻译先用智谱（免费模型），被拒或太忙交给 Groq（没填密钥就跳过）
  'tr_models', jsonb_build_object('glm', 'glm-4-flash-250414', 'groq', 'openai/gpt-oss-120b'),   -- 用哪个模型；以后换模型只改这里
  'tr_par', 2,                                                                    -- 一次最多几组同时翻（智谱免费模型的并发上限官方没写，先保守用 2）
  'tr_per_user_day', 1000000000,                                                  -- 每人每天翻译请求上限（10 亿 = 不限）
  'popular', '[["bilibili.com", "哔哩哔哩"], ["baidu.com", "百度"], ["qq.com", "腾讯"], ["taobao.com", "淘宝"], ["tmall.com", "天猫"], ["jd.com", "京东"], ["zhihu.com", "知乎"], ["weibo.com", "微博"], ["douyin.com", "抖音"], ["xiaohongshu.com", "小红书"], ["163.com", "网易"], ["sina.com.cn", "新浪"], ["sohu.com", "搜狐"], ["douban.com", "豆瓣"], ["csdn.net", "CSDN"], ["iqiyi.com", "爱奇艺"], ["youku.com", "优酷"], ["pinduoduo.com", "拼多多"], ["meituan.com", "美团"], ["ctrip.com", "携程"], ["alipay.com", "支付宝"], ["12306.cn", "12306"], ["github.com", "GitHub"], ["google.com", "Google"], ["youtube.com", "YouTube"], ["youtu.be", "YouTube"], ["wikipedia.org", "维基百科"], ["twitter.com", "Twitter"], ["x.com", "X"], ["facebook.com", "Facebook"], ["instagram.com", "Instagram"], ["reddit.com", "Reddit"], ["amazon.com", "亚马逊"], ["apple.com", "苹果"], ["icloud.com", "iCloud"], ["microsoft.com", "微软"], ["outlook.com", "Outlook"], ["openai.com", "OpenAI"], ["chatgpt.com", "ChatGPT"], ["claude.ai", "Claude"], ["netflix.com", "Netflix"], ["tiktok.com", "TikTok"], ["telegram.org", "Telegram"], ["whatsapp.com", "WhatsApp"], ["paypal.com", "PayPal"], ["steampowered.com", "Steam"], ["stackoverflow.com", "Stack Overflow"], ["medium.com", "Medium"], ["pixiv.net", "pixiv"], ["acfun.cn", "AcFun"], ["hupu.com", "虎扑"], ["ithome.com", "IT之家"], ["sspai.com", "少数派"], ["v2ex.com", "V2EX"], ["nytimes.com", "纽约时报"], ["bbc.com", "BBC"], ["supabase.com", "Supabase"]]'::jsonb                                                    -- 知名网站：输入的网址和它们只差几个字母时提醒可能是仿冒的
) || value, updated_at = now()
where key = 'search';

-- ========== 检查表 ==========
insert into _chatter_1118
select 1, '搜索缓存表', case when to_regclass('public.search_cache') is not null then '是' else '否' end
union all
select 2, '用量计数（每人每天、每家每月）', case when to_regprocedure('public.search_bump(uuid,text,integer,boolean)') is not null then '是' else '否' end
union all
select 3, '个人搜索规则表（只能看到自己的）', case when exists (select 1 from pg_policies where tablename = 'search_prefs' and policyname = 'search_prefs_own') then '是' else '否' end
union all
select 4, '默认名单和上限', coalesce((select case when (value ->> 'per_user_day')::numeric >= 100000 then '每人每天不限次数' else '每人每天 ' || (value ->> 'per_user_day') || ' 次' end || '；先用 ' || initcap(value -> 'order' ->> 0) || '，用完换 ' || initcap(value -> 'order' ->> 1) from public.app_config where key = 'search'), '否')
union all
select 6, '翻译设置和知名网站名单', coalesce((select '先用 ' || (value -> 'tr_order' ->> 0) || '，模型 ' || (value -> 'tr_models' ->> 'glm') || '；知名网站 ' || jsonb_array_length(value -> 'popular') || ' 个' from public.app_config where key = 'search' and value ? 'popular'), '否')
union all
select 5, '密钥表（手机读不到）', case when to_regclass('public.search_keys') is not null and not has_table_privilege('anon', 'public.search_keys', 'select') and not has_table_privilege('authenticated', 'public.search_keys', 'select') then '是；已存 ' || (select count(*) from public.search_keys) || ' 个密钥' else '否' end;

commit;

select 序号, 项目, 结果 from _chatter_1118 order by 序号;
