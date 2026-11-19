begin;
set local lock_timeout = '5s';

alter policy "chat-media insert own" on storage.objects to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = public.my_acc()
  );
create policy "media insert" on storage.objects for insert to public
  with check (bucket_id = 'chat-media' and auth.role() = 'authenticated');

create policy "media read" on storage.objects for select to public
  using (bucket_id = 'chat-media');

commit;
