select set_config('app.uid','22222222-2222-2222-2222-222222222222',false);
set role authenticated;
\timing on
select jsonb_array_length(r->'msgs') as msgs, jsonb_array_length(r->'sigs') as sigs from (select public.poll_inbox(now(), 2500) r) x;
