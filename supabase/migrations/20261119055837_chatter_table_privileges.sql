-- Reconciled with the production ACL snapshot taken on 2026-11-19.
begin;
set local lock_timeout = '5s';

revoke truncate on table
  public.chat_group_members,
  public.chat_groups,
  public.conversations,
  public.friend_requests,
  public.friendships,
  public.group_invites,
  public.messages,
  public.profiles,
  public.search_cache,
  public.search_prefs,
  public.search_usage
from anon;

revoke truncate on table
  public.chat_backgrounds,
  public.chat_group_members,
  public.chat_groups,
  public.conversations,
  public.friend_requests,
  public.friendships,
  public.group_files,
  public.group_invites,
  public.group_notices,
  public.messages,
  public.moment_comments,
  public.moment_likes,
  public.moment_mentions,
  public.moment_views,
  public.moments,
  public.profiles,
  public.search_cache,
  public.search_prefs,
  public.search_usage,
  public.stickers,
  public.user_devices,
  public.user_mutes
from authenticated;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

commit;
