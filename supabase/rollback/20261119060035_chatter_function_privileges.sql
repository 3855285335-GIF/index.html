begin;
set local lock_timeout = '5s';

grant execute on function
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
to public, anon, authenticated;

alter function public.conv_key_of(text,text) reset search_path;
alter function public.chatter_schema() reset search_path;
alter function public.messages_before_insert() reset search_path;
alter function public.messages_before_update() reset search_path;

CREATE OR REPLACE FUNCTION public.session_alive()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sid text;
begin
  sid := nullif(coalesce(auth.jwt() ->> 'session_id', ''), '');
  if sid is null then return true; end if;
  return exists (select 1 from auth.sessions s where s.id = sid::uuid);
exception when others then
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.my_acc()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select account_id from public.profiles where id = auth.uid() limit 1
$function$;

commit;
