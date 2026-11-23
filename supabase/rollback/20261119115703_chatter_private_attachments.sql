begin;
set local lock_timeout = '5s';

-- The safe rollback after enabling new uploads stops writes and preserves authenticated reads.
update public.app_config set value = '{"enabled":false}'::jsonb
where key = 'private_chat_attachments';

do $rollback$
declare
  linked_messages boolean := false;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'private_attachment_path') then
    execute 'select exists (select 1 from public.messages where private_attachment_path is not null)' into linked_messages;
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'chatter-private')
    or linked_messages then
    update public.app_config set value = '{"enabled":false,"paused":true}'::jsonb
    where key = 'private_chat_attachments';
    raise notice 'Private uploads stopped. Read policies retained to keep existing attachments available.';
    return;
  end if;

  drop policy if exists chatter_private_attachment_uploads on storage.objects;
  drop policy if exists chatter_private_attachment_reads on storage.objects;
  drop policy if exists chatter_private_attachment_write_operations on storage.objects;
  drop policy if exists chatter_private_attachment_read_operations on storage.objects;
  drop policy if exists chatter_private_attachment_anonymous on storage.objects;
  drop policy if exists chatter_private_attachment_delete on storage.objects;
  drop policy if exists chatter_private_attachment_delete_operations on storage.objects;
  alter table public.messages drop column if exists private_attachment_path;
  drop function if exists public.chatter_private_attachments_enabled();
  drop function if exists public.chatter_attachment_id(text);
  delete from public.app_config where key = 'private_chat_attachments';
  -- Supabase bucket deletion is done through its Storage API. Leave the empty private bucket inert.
end
$rollback$;

commit;
