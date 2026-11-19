begin;
set local lock_timeout = '5s';

-- Keep existing objects and permit arbitrary attachments as inert downloads.
-- The Storage API checks the declared MIME type, not the bytes.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/bmp', 'image/tiff', 'image/x-icon',
  'image/vnd.microsoft.icon', 'image/svg+xml', 'audio/*', 'video/*',
  'application/octet-stream', 'text/plain', 'application/pdf'
]
where id = 'chat-media' and allowed_mime_types is null;

commit;
