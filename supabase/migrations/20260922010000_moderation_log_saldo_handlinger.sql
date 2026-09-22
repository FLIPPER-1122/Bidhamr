-- moderation_log.handling var laast til de seks oprindelige
-- moderationshandlinger. E-money tilfoejede tre pengehandlinger, som derfor
-- blev afvist af check-constrainten.
--
-- Fejlen var ekstra ubehagelig, fordi saldoen saettes FOER logningen: selve
-- aendringen lykkedes, hvorefter log-inserten kastede, og brugeren fik en
-- fejl for noget, der faktisk var gennemfoert.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion',
    'slet_anmeldelse',
    'suspender',
    'ophaev_suspension',
    'advarsel',
    'annuller_auktion',
    -- Pengehandlinger. Saldoaendringer skal altid kunne spores til en person.
    'saldo_sat',
    'saldo_tilfoert',
    'saldo_traukket'
  ));
