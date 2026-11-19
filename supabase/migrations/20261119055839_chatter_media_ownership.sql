begin;
set local lock_timeout = '5s';

-- Permissive RLS policies are ORed; the unrestricted legacy policy defeated
-- the ownership check. Keep public URLs working for old messages.
drop policy "media insert" on storage.objects;
alter policy "chat-media insert own" on storage.objects to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = (select public.my_acc())
    and cardinality(storage.foldername(name)) = 1
    and storage.filename(name) not in ('', '.', '..')
    and (select public.session_alive())
  );

drop policy "media read" on storage.objects;

commit;
