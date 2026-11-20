begin;
do $$ declare job bigint; begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    for job in select jobid from cron.job where jobname='chatter-navigation-expiry' loop perform cron.unschedule(job); end loop;
  end if;
end $$;
drop function if exists public.chatter_navigation(text,text,uuid,jsonb);
drop table if exists chatter_navigation_private.trips;
drop schema if exists chatter_navigation_private;
notify pgrst,'reload schema';
commit;
