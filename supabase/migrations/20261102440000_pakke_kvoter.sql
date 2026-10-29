-- Nye kvoter på firmapakkerne (Filip, 29. okt. 2026).
--
-- Regel: ROADMAP-BESLUTNINGER.md, "Erhvervskonti" -> "NYE pakker og priser",
-- note "Ændret (Filip, 29. okt. 2026)": Start 20 auktioner om måneden (før 10),
-- Butik 40 (før 30). Pro er uændret (ubegrænset). Priserne er uændrede.
--
-- Pakkerne blev oprettet i 20261102010000_firmapakker.sql med faste id'er
-- (7e57a000-...-0001 = Start, -0002 = Butik). Fandtes en ikke-arkiveret pakke
-- med navnet i forvejen, blev den brugt i stedet - derfor matches også på
-- navnet (kun ikke-arkiverede pakker).
--
-- Kun rækker, der stadig har den gamle værdi (10/30), opdateres, så en kvote,
-- chefen selv har sat i admin, ikke overskrives. Beskrivelsen rettes kun, hvis
-- den stadig er migrationens oprindelige tekst. Idempotent: anden kørsel
-- rammer ingen rækker.
--
-- Kvoten læses dynamisk (erhverv_kvote -> auktioner_pr_maaned), så firmaer på
-- pakkerne får de nye tal med det samme, også i indeværende måned. Stripe
-- berøres ikke (prisen er uændret).

set local lock_timeout = '5s';

update public.erhverv_pakker
   set auktioner_pr_maaned = 20, opdateret_kl = now()
 where arkiveret_kl is null
   and (id = '7e57a000-0000-4000-8000-000000000001'::uuid or lower(navn) = 'start')
   and auktioner_pr_maaned = 10;

update public.erhverv_pakker
   set auktioner_pr_maaned = 40, opdateret_kl = now()
 where arkiveret_kl is null
   and (id = '7e57a000-0000-4000-8000-000000000002'::uuid or lower(navn) = 'butik')
   and auktioner_pr_maaned = 30;

update public.erhverv_pakker
   set beskrivelse = 'Firmaprofil og Firma oversigt med salg, udbetalinger og regninger. 20 auktioner om måneden.',
       opdateret_kl = now()
 where arkiveret_kl is null
   and (id = '7e57a000-0000-4000-8000-000000000001'::uuid or lower(navn) = 'start')
   and beskrivelse = 'Firmaprofil og Firma oversigt med salg, udbetalinger og regninger. 10 auktioner om måneden.';

update public.erhverv_pakker
   set beskrivelse = 'Som Start + 40 auktioner om måneden, 5 fremhævede auktioner om måneden, statistik og 50 % rabat på Ugens butik de første 3 gange hvert år.',
       opdateret_kl = now()
 where arkiveret_kl is null
   and (id = '7e57a000-0000-4000-8000-000000000002'::uuid or lower(navn) = 'butik')
   and beskrivelse = 'Som Start + 30 auktioner om måneden, 5 fremhævede auktioner om måneden, statistik og 50 % rabat på Ugens butik de første 3 gange hvert år.';
