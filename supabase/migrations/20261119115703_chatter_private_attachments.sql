begin;
set local lock_timeout = '5s';

-- Leave the existing bucket and all historical URLs intact. Publishing the frontend and
-- enabling new uploads are separate steps. Existing private objects remain readable if disabled.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chatter-private', 'chatter-private', false, 52428800, array[
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
  'image/bmp', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon',
  'audio/*', 'video/*', 'application/octet-stream', 'text/plain', 'application/pdf'
]) on conflict (id) do nothing;

do $check$
begin
  if exists (select 1 from storage.buckets where id = 'chatter-private' and public) then
    raise exception 'chatter-private already exists as a public bucket';
  end if;
end
$check$;

insert into public.app_config (key, value)
values ('private_chat_attachments', '{"enabled":false}'::jsonb)
on conflict (key) do nothing;

create or replace function public.chatter_private_attachments_enabled()
returns boolean language sql stable set search_path = '' as $function$
  select coalesce((select c.value -> 'enabled' = 'true'::jsonb
    from public.app_config c where c.key = 'private_chat_attachments'), false)
$function$;

create or replace function public.chatter_attachment_id(object_path text)
returns uuid language sql immutable strict set search_path = '' as $function$
  select substring(object_path from '^[a-z0-9_]{3,20}/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})[.][a-z0-9]{1,8}([.](t|jpg))?$')::uuid
$function$;

revoke execute on function public.chatter_private_attachments_enabled(), public.chatter_attachment_id(text) from public, anon;
grant execute on function public.chatter_private_attachments_enabled(), public.chatter_attachment_id(text) to authenticated, service_role;

-- Keep an exact primary object binding next to the message. Object ids are UUIDs and the
-- sender owns the prefix. A fabricated message cannot grant access to another sender's object.
alter table public.messages add column if not exists private_attachment_path text;
alter table public.messages drop constraint if exists messages_private_attachment_path_check;
alter table public.messages add constraint messages_private_attachment_path_check check (
  private_attachment_path is null or (
    public.chatter_attachment_id(private_attachment_path) is not null
    and public.chatter_attachment_id(private_attachment_path) = id
    and split_part(private_attachment_path, '/', 1) = from_acc
    and private_attachment_path ~ '^[^/]+/[^.]+[.][a-z0-9]{1,8}$'
    and (
      (to_acc ~ '^[a-z0-9_]{3,20}$' and conv_key = least(from_acc collate "C", to_acc collate "C") || '::' || greatest(from_acc collate "C", to_acc collate "C"))
      or (to_acc = conv_key and conv_key ~ '^g:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    )
  )
);

-- RLS SELECT is also used by the sign and list APIs. Gate on the actual Storage operation;
-- a bearer URL, a bucket listing and object copying are not part of recipient access.
drop policy if exists chatter_private_attachment_reads on storage.objects;
create policy chatter_private_attachment_reads on storage.objects for select to authenticated using (bucket_id = 'chatter-private');

-- Restrictive rules apply even if another permissive Storage rule is added later.
drop policy if exists chatter_private_attachment_read_operations on storage.objects;
create policy chatter_private_attachment_read_operations on storage.objects as restrictive for select to authenticated using (
  bucket_id <> 'chatter-private' or (
    (select public.session_alive())
    and (
      (split_part(name, '/', 1) = (select public.my_acc()) and replace((select storage.operation()), 'storage.', '') in (
        'object.list', 'object.list_v2', 'object.delete', 'object.delete_many'
      ))
      or (replace((select storage.operation()), 'storage.', '') in (
        'object.get_authenticated', 'object.info_authenticated', 'object.get_authenticated_info', 'object.head_authenticated_info'
      ) and (split_part(name, '/', 1) = (select public.my_acc()) or exists (
        select 1 from public.messages m
        where m.id = public.chatter_attachment_id(storage.objects.name)
          and (
            m.to_acc = (select public.my_acc())
            or (m.to_acc = m.conv_key and exists (
              select 1 from public.chat_group_members g
              where g.group_id = substring(m.conv_key from '^g:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$')::uuid
                and g.account_id = (select public.my_acc())
            ))
          )
          and m.type in ('image', 'voice', 'video', 'file')
          and (
            storage.objects.name = m.private_attachment_path
            or (m.type = 'image' and storage.objects.name = m.private_attachment_path || '.t')
            or (m.type = 'video' and storage.objects.name = m.private_attachment_path || '.jpg')
          )
      )))
    )
  )
);

drop policy if exists chatter_private_attachment_uploads on storage.objects;
create policy chatter_private_attachment_uploads on storage.objects for insert to authenticated with check (bucket_id = 'chatter-private');

drop policy if exists chatter_private_attachment_write_operations on storage.objects;
create policy chatter_private_attachment_write_operations on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'chatter-private'
  or (
    (select public.session_alive())
    and (select public.chatter_private_attachments_enabled())
    and replace((select storage.operation()), 'storage.', '') = 'object.upload'
    and split_part(name, '/', 1) = (select public.my_acc())
    and public.chatter_attachment_id(name) is not null
  )
);

drop policy if exists chatter_private_attachment_anonymous on storage.objects;
create policy chatter_private_attachment_anonymous on storage.objects as restrictive for all to anon
  using (bucket_id <> 'chatter-private') with check (bucket_id <> 'chatter-private');

drop policy if exists chatter_private_attachment_delete on storage.objects;
create policy chatter_private_attachment_delete on storage.objects for delete to authenticated using (bucket_id = 'chatter-private');

drop policy if exists chatter_private_attachment_delete_operations on storage.objects;
create policy chatter_private_attachment_delete_operations on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'chatter-private' or (
    (select public.session_alive())
    and split_part(name, '/', 1) = (select public.my_acc())
    and replace((select storage.operation()), 'storage.', '') in ('object.delete', 'object.delete_many')
  )
);

commit;
