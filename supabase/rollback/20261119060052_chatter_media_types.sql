begin;
set local lock_timeout = '5s';

update storage.buckets set allowed_mime_types = null where id = 'chat-media';

commit;
