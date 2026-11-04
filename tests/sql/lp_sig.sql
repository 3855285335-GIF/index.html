select pg_sleep(0.8);
select set_config('app.uid','11111111-1111-1111-1111-111111111111',false);
set role authenticated;
select public.send_signal('bob','{"t":"invite","id":"c9","sq":"z1"}');
