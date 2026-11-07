-- ============================================================
-- Chatter 后端补丁 v6：表情包 + 发视频 + 发文件（可重复执行，不改动、不删除任何现有数据）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
--
-- 1. 消息类型新增“表情”（sticker）、“视频”（video）、“文件”（file），会话列表预览显示 [表情] / [视频] / [文件] 文件名
-- 2. 新建 stickers 表：每个人自己的表情（只能看、加、改、删自己的，最多 500 个）
-- 3. 文件桶单个文件上限从 20MB 提到 50MB（Supabase 免费版允许的最大值）
-- 4. chatter_schema()：返回后端版本号，网页用它判断这份 SQL 有没有运行过
-- ============================================================


-- 整份放在一个事务里：中间任何一句出错，前面做的也会全部撤销，不会只改一半
begin;

-- ========== 0. 先确认是 Chatter 的数据库（选错项目时直接报错，什么都不会改） ==========
do $$ begin
  if to_regclass('public.friendships') is null or to_regclass('public.messages') is null then
    raise exception '这不是 Chatter 的数据库：找不到 friendships / messages 表。请确认页面左上角选的是 Chatter 的项目（地址里应有 uaoiqbxptnbrvkzjwguc），这次什么都没有改动';
  end if;
end $$;


-- ========== 1. 消息类型 ==========
create or replace function public.messages_before_insert()
returns trigger language plpgsql as $$
begin
  new.conv_key := public.conv_key_of(new.from_acc, new.to_acc);
  if new.type not in ('text','image','voice','call','sticker','video','file') then
    raise exception 'invalid message type';
  end if;
  if new.type = 'text' and length(coalesce(new.body,'')) > 5000 then
    raise exception 'message too long';
  end if;
  if new.type in ('sticker','video') and length(coalesce(new.body,'')) > 500 then
    raise exception 'body too long';
  end if;
  -- 文件消息的内容是 {"u":"文件地址","n":"文件名","s":大小}，格式不对就拒绝
  if new.type = 'file' then
    if length(coalesce(new.body,'')) > 1000 then raise exception 'body too long'; end if;
    begin
      if jsonb_typeof(new.body::jsonb) <> 'object' or coalesce(new.body::jsonb ->> 'u', '') = '' then
        raise exception 'bad';
      end if;
    exception when others then
      raise exception 'invalid file body';
    end;
  end if;
  new.body := coalesce(new.body, '');
  return new;
end $$;

create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare prev text; inc integer;
begin
  prev := case new.type
            when 'text'    then left(coalesce(new.body, ''), 200)
            when 'image'   then '[图片]'
            when 'voice'   then '[语音]'
            when 'call'    then '[通话]'
            when 'sticker' then '[表情]'
            when 'video'   then '[视频]'
            when 'file'    then '[文件] ' || left(coalesce(new.body::jsonb ->> 'n', ''), 60)
            else '[消息]'
          end;
  inc := case when new.type = 'call' then 0 else 1 end;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, last_read_ts, unread)
  values (new.from_acc, new.conv_key, new.to_acc, prev, new.created_at, new.created_at, 0)
  on conflict (owner_acc, conv_key) do update
    set last_body = excluded.last_body, last_ts = excluded.last_ts,
        last_read_ts = excluded.last_read_ts, peer_acc = excluded.peer_acc, unread = 0;

  insert into public.conversations (owner_acc, conv_key, peer_acc, last_body, last_ts, unread)
  values (new.to_acc, new.conv_key, new.from_acc, prev, new.created_at, inc)
  on conflict (owner_acc, conv_key) do update
    set last_body = excluded.last_body, last_ts = excluded.last_ts,
        peer_acc = excluded.peer_acc, unread = public.conversations.unread + inc;

  return new;
end $$;


-- ========== 2. 我的表情 ==========
create table if not exists public.stickers (
  id         uuid primary key default gen_random_uuid(),
  owner_acc  text not null,
  url        text not null check (char_length(url) <= 500),
  kw         text not null default '' check (char_length(kw) <= 60),
  created_at timestamptz not null default now()
);
create index if not exists stickers_owner_idx on public.stickers (owner_acc, created_at desc);
alter table public.stickers enable row level security;

drop policy if exists stickers_select on public.stickers;
create policy stickers_select on public.stickers for select to authenticated
  using (owner_acc = public.my_acc());

-- 只能添加自己文件夹里的文件；每人最多 500 个
drop policy if exists stickers_insert on public.stickers;
create policy stickers_insert on public.stickers for insert to authenticated
  with check (
    owner_acc = public.my_acc()
    and position('/storage/v1/object/public/chat-media/' || public.my_acc() || '/' in url) > 0
    and (select count(*) from public.stickers s where s.owner_acc = public.my_acc()) < 500
  );

drop policy if exists stickers_update on public.stickers;
create policy stickers_update on public.stickers for update to authenticated
  using (owner_acc = public.my_acc()) with check (owner_acc = public.my_acc());

drop policy if exists stickers_delete on public.stickers;
create policy stickers_delete on public.stickers for delete to authenticated
  using (owner_acc = public.my_acc());

revoke all on table public.stickers from anon;
grant select, insert, update, delete on table public.stickers to authenticated;


-- ========== 3. 单个文件上限 50MB ==========
update storage.buckets set file_size_limit = 52428800 where id = 'chat-media';


-- ========== 4. 后端版本号 ==========
create or replace function public.chatter_schema()
returns integer language sql immutable as $$ select 6 $$;
revoke all on function public.chatter_schema() from public, anon;
grant execute on function public.chatter_schema() to authenticated;

commit;

-- 完成 ✅
