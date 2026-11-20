begin;
create schema if not exists chatter_navigation_private;
revoke all on schema chatter_navigation_private from public, anon, authenticated;
create unlogged table if not exists chatter_navigation_private.trips (
  left_acc text not null, right_acc text not null, id uuid not null unique,
  inviter text not null, accepted boolean not null default false,
  destination jsonb not null, proposal jsonb, left_wait jsonb, right_wait jsonb, left_fix jsonb, right_fix jsonb,
  expires timestamptz not null default (now() + interval '30 minutes'),
  primary key(left_acc,right_acc), check (left_acc < right_acc),
  foreign key(left_acc,right_acc) references public.friendships(owner_acc,friend_acc) on delete cascade,
  foreign key(right_acc,left_acc) references public.friendships(owner_acc,friend_acc) on delete cascade
);
alter table chatter_navigation_private.trips
  add column if not exists accepted_at timestamptz,
  add column if not exists renew_by text,
  add column if not exists renew_key uuid;
-- 兼容已在隔离环境运行的上一版。保留现有会合期限。
update chatter_navigation_private.trips set accepted_at=expires-interval '30 minutes'
  where accepted and accepted_at is null;
alter table chatter_navigation_private.trips enable row level security;
revoke all on chatter_navigation_private.trips from public, anon, authenticated;
create index if not exists chatter_navigation_expiry on chatter_navigation_private.trips(expires);

-- 仅此接口代表当前登录的好友访问临时位置。坐标从不写入聊天或广播。
create or replace function public.chatter_navigation(p_peer text, p_action text default 'read', p_id uuid default null, p_value jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := public.my_acc(); a text; b text;
  trip chatter_navigation_private.trips%rowtype;
  value jsonb; peer_fix jsonb; stamp timestamptz := clock_timestamp();
begin
  if me is null or p_peer is null or me = p_peer or not exists(
    select 1 from public.friendships where owner_acc=me and friend_acc=p_peer)
    or not exists(select 1 from public.friendships where owner_acc=p_peer and friend_acc=me)
  then raise insufficient_privilege using message='仅限当前好友'; end if;
  a := least(me,p_peer); b := greatest(me,p_peer);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(a,b)::text,0));
  delete from chatter_navigation_private.trips where expires <= stamp;
  select * into trip from chatter_navigation_private.trips where left_acc=a and right_acc=b for update;
  if p_action in ('invite','fix','propose','wait') then
    if jsonb_typeof(p_value->'lat') is distinct from 'number' or jsonb_typeof(p_value->'lon') is distinct from 'number'
       or abs((p_value->>'lat')::numeric)>90 or abs((p_value->>'lon')::numeric)>180
    then raise exception '无效坐标'; end if;
    value := jsonb_build_object('lat',p_value->'lat','lon',p_value->'lon');
  end if;
  if p_action='invite' then
    if p_id is null or nullif(trim(p_value->>'name'),'') is null then raise exception '缺少目的地'; end if;
    if trip.id is null then
      insert into chatter_navigation_private.trips(left_acc,right_acc,id,inviter,destination)
      values(a,b,p_id,me,value || jsonb_build_object('name',left(trim(p_value->>'name'),120))) returning * into trip;
    elsif trip.id<>p_id or trip.inviter<>me then raise exception '已有同行邀请，请重新查看'; end if;
  elsif p_action='read' then
    if trip.id is null or (p_id is not null and p_id<>trip.id) then return null; end if;
  else
    if trip.id is null or trip.id is distinct from p_id then return null; end if;
    case p_action
      when 'accept' then
        if trip.inviter=me then raise insufficient_privilege; end if;
        if not trip.accepted then
          update chatter_navigation_private.trips set accepted=true, accepted_at=stamp, expires=stamp+interval '30 minutes'
            where id=p_id returning * into trip;
        end if;
      when 'offer_more' then
        if not trip.accepted or trip.expires >= trip.accepted_at + interval '3 hours' then raise exception '无法再延长同行'; end if;
        if trip.renew_by is null then
          update chatter_navigation_private.trips set renew_by=me,renew_key=gen_random_uuid() where id=p_id returning * into trip;
        end if;
      when 'accept_more' then
        if not trip.accepted or trip.renew_by is null or trip.renew_by=me or
           trip.renew_key::text is distinct from (p_value->>'key') then raise exception '续时邀请已变化'; end if;
        update chatter_navigation_private.trips set expires=least(expires+interval '30 minutes',accepted_at+interval '3 hours'),
          renew_by=null,renew_key=null where id=p_id returning * into trip;
      when 'propose' then
        if not trip.accepted or nullif(trim(p_value->>'name'),'') is null then raise exception '先接受同行并核对地点'; end if;
        update chatter_navigation_private.trips set proposal=value||jsonb_build_object('name',left(trim(p_value->>'name'),120),'by',me,'key',gen_random_uuid())
          where id=p_id returning * into trip;
      when 'agree' then
        if not trip.accepted or trip.proposal is null or trip.proposal->>'by'=me or
           (trip.proposal->>'key') is distinct from (p_value->>'key') then raise exception '换点提议已变化'; end if;
        update chatter_navigation_private.trips set destination=proposal-'by'-'key',proposal=null where id=p_id returning * into trip;
      when 'wait' then
        if not trip.accepted or nullif(trim(p_value->>'name'),'') is null then raise exception '先加入同行并写明等候点'; end if;
        value:=value||jsonb_build_object('name',left(trim(p_value->>'name'),80),'time',extract(epoch from stamp)*1000);
        update chatter_navigation_private.trips set left_wait=case when me=a then value else left_wait end,
          right_wait=case when me=b then value else right_wait end where id=p_id returning * into trip;
      when 'end' then
        delete from chatter_navigation_private.trips where id=p_id;
        return null;
      when 'fix' then
        if not trip.accepted then raise insufficient_privilege; end if;
        if jsonb_typeof(p_value->'accuracy') is distinct from 'number' or (p_value->>'accuracy')::numeric not between 0 and 100000
          or jsonb_typeof(p_value->'time') is distinct from 'number' then raise exception '无效定位精度或时间'; end if;
        -- 浏览器过时的 GPS 读数不能被标为刚刚获取的实时位置。
        if (p_value->>'time')::numeric not between extract(epoch from stamp)*1000-90000 and extract(epoch from stamp)*1000+10000 then raise exception '定位已过期'; end if;
        value := value || jsonb_build_object('accuracy',p_value->'accuracy','time',least((p_value->>'time')::numeric,extract(epoch from stamp)*1000));
        if me=a then
          update chatter_navigation_private.trips set left_fix=value where id=p_id and coalesce((left_fix->>'time')::numeric,0)<(value->>'time')::numeric;
        else
          update chatter_navigation_private.trips set right_fix=value where id=p_id and coalesce((right_fix->>'time')::numeric,0)<(value->>'time')::numeric;
        end if;
      else raise exception '未知操作';
    end case;
  end if;
  peer_fix := case when me=a then trip.right_fix else trip.left_fix end;
  if not trip.accepted or (peer_fix->>'time')::numeric < extract(epoch from stamp)*1000-90000 then peer_fix:=null; end if;
  return jsonb_build_object('id',trip.id,'inviter',trip.inviter,'active',trip.accepted,'destination',trip.destination,
                            'expires',trip.expires,'serverTime',floor(extract(epoch from stamp)*1000),
                            'canExtend',trip.accepted and trip.expires<trip.accepted_at+interval '3 hours',
                            'renewBy',trip.renew_by,'renewKey',trip.renew_key,'peerFix',peer_fix,'proposal',trip.proposal,
                            'myWait',case when me=a then trip.left_wait else trip.right_wait end,
                            'peerWait',case when me=a then trip.right_wait else trip.left_wait end);
end $$;
revoke all on function public.chatter_navigation(text,text,uuid,jsonb) from public,anon;
grant execute on function public.chatter_navigation(text,text,uuid,jsonb) to authenticated;
-- Supabase 启用 pg_cron 时每分钟清理到期会话；未启用时仍禁止读取过期位置。
do $$ begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') and not exists(select 1 from pg_extension where extname='pg_cron') then
    create extension pg_cron;
  end if;
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('chatter-navigation-expiry','* * * * *',
      'delete from chatter_navigation_private.trips where expires <= now()');
  end if;
end $$;
notify pgrst,'reload schema';
commit;
