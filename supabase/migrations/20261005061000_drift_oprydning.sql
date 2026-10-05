-- Oprydning af driftsdata (Filip, 5. oktober 2026, se ROADMAP-BESLUTNINGER.md
-- "Driftsdata"): fejllog, cron-log og pg_cron-historik slettes automatisk
-- efter 90 dage. Det er IKKE handelsdata.
--
-- Roeres ikke: handelsdata, notifikation_afsendelser, moderation_log,
-- rapporter_arkiv m.m.
--
--   A. drift_oprydning_koer() - sletter hoejst 10.000 raekker pr. tabel pr.
--      koersel, saa et stort efterslaeb tages over flere dage uden lange laase.
--   B. pg_cron-job 'drift_oprydning' dagligt kl. 03:30 UTC.
--
-- Idempotent: create or replace + unschedule/schedule.

-- ============================================================ A. funktionen

create or replace function public.drift_oprydning_koer()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_graense  timestamptz := now() - interval '90 days';
  v_fejl     integer := 0;
  v_koersler integer := 0;
  v_pg_cron  integer := 0;
begin
  -- Fejllog: en raekke samler gentagelser (antal/senest_kl), saa den slettes
  -- foerst, naar fejlen ikke er set i 90 dage.
  delete from public.drift_fejl f
   where f.id in (
           select x.id
             from public.drift_fejl x
            where x.senest_kl < v_graense
            order by x.senest_kl
            limit 10000);
  get diagnostics v_fejl = row_count;

  -- Cron-log: afsluttede koersler efter sluttidspunkt; afbrudte (afsluttet_kl
  -- null) efter starttidspunkt.
  delete from public.drift_cron_koersler k
   where k.id in (
           select x.id
             from public.drift_cron_koersler x
            where coalesce(x.afsluttet_kl, x.startet_kl) < v_graense
            order by x.startet_kl
            limit 10000);
  get diagnostics v_koersler = row_count;

  -- pg_cron-historik (kun hvis pg_cron er slaaet til).
  if to_regclass('cron.job_run_details') is not null then
    delete from cron.job_run_details r
     where r.runid in (
             select x.runid
               from cron.job_run_details x
              where coalesce(x.end_time, x.start_time) < v_graense
              order by x.runid
              limit 10000);
    get diagnostics v_pg_cron = row_count;
  end if;

  return jsonb_build_object(
    'drift_fejl_slettet', v_fejl,
    'drift_cron_koersler_slettet', v_koersler,
    'cron_job_run_details_slettet', v_pg_cron);
end;
$fn$;

-- Intern funktion: kun pg_cron (koerer som ejeren) og service_role.
revoke all on function public.drift_oprydning_koer() from public, anon, authenticated;
grant execute on function public.drift_oprydning_koer() to service_role;

-- ============================================================ B. pg_cron-jobbet

select cron.unschedule('drift_oprydning')
 where exists (select 1 from cron.job where jobname = 'drift_oprydning');

select cron.schedule(
  'drift_oprydning',
  '30 3 * * *',
  $$select public.drift_oprydning_koer();$$
);
