begin;
set local lock_timeout = '5s';

revoke update on public.friend_requests from public, anon, authenticated;
grant update (status) on public.friend_requests to authenticated;

alter policy fr_update on public.friend_requests to authenticated
  using (to_acc = (select public.my_acc()) and status = 'pending')
  with check (to_acc = (select public.my_acc()) and status = 'declined');

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_req_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me text := public.my_acc();
  r  record;
  k  text;
begin
  if me is null then raise exception 'not authenticated'; end if;
  update public.friend_requests set status = 'accepted'
   where id::text = p_req_id and to_acc = me and status = 'pending'
   returning * into r;
  if not found then raise exception 'request not found'; end if;

  insert into public.friendships (owner_acc, friend_acc)
  values (me, r.from_acc), (r.from_acc, me)
  on conflict do nothing;

  k := public.conv_key_of(me, r.from_acc);
  insert into public.conversations (owner_acc, conv_key, peer_acc)
  values (me, k, r.from_acc), (r.from_acc, k, me)
  on conflict do nothing;
end $function$;

CREATE OR REPLACE FUNCTION public.send_friend_request(p_to text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me   text := public.my_acc();
  tgt  text := lower(trim(p_to));
  rid  text;
  r    record;
  nick text;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if tgt = me then return 'self'; end if;
  if not exists (select 1 from public.profiles where account_id = tgt) then return 'notfound'; end if;
  -- Serialize both directions before looking for a reciprocal request.
  perform pg_advisory_xact_lock(hashtextextended(public.conv_key_of(me, tgt), 0));
  if exists (select 1 from public.friendships where owner_acc = me and friend_acc = tgt) then return 'friends'; end if;

  select id::text into rid from public.friend_requests
   where from_acc = tgt and to_acc = me and status = 'pending' limit 1;
  if found then
    perform public.accept_friend_request(rid);
    return 'accepted';
  end if;

  select nickname into nick from public.profiles where account_id = me;

  select * into r from public.friend_requests where from_acc = me and to_acc = tgt
   order by (status = 'pending') desc, created_at desc, id desc limit 1;
  if found then
    if r.status = 'pending' then return 'exists'; end if;
    update public.friend_requests set status = 'pending', from_name = nick, created_at = now() where id = r.id;
    return 'ok';
  end if;

  insert into public.friend_requests (from_acc, to_acc, from_name, status)
  values (me, tgt, nick, 'pending');
  return 'ok';
end $function$;

commit;
