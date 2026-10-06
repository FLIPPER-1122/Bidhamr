-- Oprydning af pg_cron-historikken (cron.job_run_details) efter 14 dage.
--
-- Hvorfor: pg_cron gemmer en raekke pr. koersel. Med jobs hvert minut/5. minut
-- er det ca. 2.000 raekker i doegnet, og i produktion fyldte tabellen 82 MB af
-- databasens 102 MB (176.000 raekker siden juli). Free-planen har 500 MB.
-- drift_oprydning (20261005061000) sletter kun efter 90 dage og hoejst 10.000
-- raekker pr. doegn - det er for lidt til at holde trit.
--
-- Hvem laeser tabellen (tjekket 6. okt. 2026):
--   - admin_cron_status() (/admin/drift): seneste koersel, seneste OK/fejl og
--     koersler sidste 24 timer. Alle jobs koerer mindst dagligt, saa 14 dage
--     er rigeligt.
--   - drift_alarm (20261008010000): kun vinduet siden sidst daekket (minutter).
--   Intet laeser laengere tilbage end 24 timer.
--
-- net._http_response (pg_net) ryddes allerede af pg_net selv (pg_net.ttl =
-- 6 hours), saa den roeres ikke her.
--
-- Kun cron-logs slettes - aldrig handelsdata (bogfoeringsloven/DAC7).
-- Pladsen genbruges, naar autovacuum har koert; filen skrumper ikke uden
-- VACUUM FULL, som bevidst IKKE koeres her.
--
-- Idempotent: cron.schedule med samme navn opdaterer jobbet i stedet for at
-- lave et nyt.

-- Engangs-oprydning. En enkelt DELETE er ok ved ~150.000 raekker: tabellen
-- skrives kun af pg_cron (raekkelaase, ingen tabel-laas), og det tager sekunder.
delete from cron.job_run_details
 where coalesce(end_time, start_time) < now() - interval '14 days';

-- Dagligt job kl. 03:17 UTC. Daglig maengde er ~2.000 raekker, saa ingen batches.
select cron.schedule(
  'cron-log-oprydning',
  '17 3 * * *',
  $$delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '14 days'$$
);
