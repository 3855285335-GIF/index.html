begin;
set local lock_timeout = '5s';

-- Trigger invocation is internal; client EXECUTE is unnecessary.
revoke execute on function
  public.group_delete_cleanup(),
  public.group_member_cleanup(),
  public.group_member_conv(),
  public.group_mute_guard(),
  public.guard_account_id(),
  public.guard_all_mention(),
  public.handle_new_user(),
  public.log_group_notice(),
  public.messages_after_insert(),
  public.messages_after_update(),
  public.messages_before_insert(),
  public.messages_before_update(),
  public.push_on_edit(),
  public.push_subs_guard(),
  public.refresh_conv_last_message(),
  public.sync_conversation_on_message()
from public, anon, authenticated;

alter function public.conv_key_of(text,text) set search_path = '';
alter function public.chatter_schema() set search_path = '';
alter function public.messages_before_insert() set search_path = '';
alter function public.messages_before_update() set search_path = '';

-- Existing JWTs issued by older auth deployments can omit session_id.
-- If a session ID is present, reject malformed IDs and mismatched users.
create or replace function public.session_alive()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid text := auth.jwt() ->> 'session_id';
begin
  if uid is null then return false; end if;
  if nullif(sid, '') is null then return true; end if;
  return exists (select 1 from auth.sessions s where s.id = sid::uuid and s.user_id = uid);
exception when invalid_text_representation then
  return false;
end;
$$;

-- Existing RPCs use my_acc() for authorization, including functions that
-- bypass table RLS. Apply the session check before returning an identity.
create or replace function public.my_acc()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.account_id
  from public.profiles p
  where p.id = (select auth.uid()) and (select public.session_alive())
  limit 1;
$$;

commit;
