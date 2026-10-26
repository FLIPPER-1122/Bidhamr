-- KUN TESTDATABASEN "Bidhamr Test" (pjiigmzqwlfepxnjdvug). ALDRIG PRODUKTION.
-- Datatest af 20261031010000_ny_prismodel.sql (kør migrationen først).
-- Bruger pengetestenes faste testbrugere (tests/penge/brugere.ts): sælger
-- penge-saelger@test.bidhamr.dk og køber penge-koeber@test.bidhamr.dk.
-- Opretter auktioner, handler og betalinger som pengetestene (tests/penge/
-- handel.ts) med de GAMLE 5 %-beløb - triggeren skal regne dem om. Alt rulles
-- tilbage: blokken slutter med en BEVIDST exception, hvis tekst er resultatet.
--
-- Forventet:
--   gebyr: 100=1200/1000 200=1900/1500 7500=30000/9500 7501=24003/16502
--          10000=31500/21500 25000=65000/45000 erhverv(1000 kr.)=5000/5000
--   fragt: lille=4200 mellem=5200 stor=6700 (dør 6000/8500/null)
--   send: ny koeb=1200 saelg=1000 fragt=4200 besk=true/0 total=15400 udb=9000 fee=ok
--   afhent: ny fragt=0 besk=false/0 total=774103 (bud 7.501 kr.: 750100 + 24003)
--   erhverv: erhverv koeb=125000 saelg=125000 besk=false/0
--   skift: til_afhentning besk=false, tilbage besk=true, prismodel=ny
--   sag: ny=10000 (kun buddet)
--   loft: bud 25001 afvist (BHB05 "Det højeste tilladte bud er 25.000 kr.")
--   fmd5: alle 8 funktioner har "ny" md5 (se migrationen)
do $t$
declare
  v_saelger uuid := '11111111-1111-4111-8111-0000000005e1';
  v_koeber  uuid := '11111111-1111-4111-8111-0000000005e3';
  ud   text := '';
  r    record;
  a1 uuid; a2 uuid; a3 uuid;
  t1 uuid; t2 uuid; t3 uuid;
  b    record;
  v_kr int;
begin
  -- Gebyrfunktionerne.
  foreach v_kr in array array[100, 200, 7500, 7501, 10000, 25000] loop
    ud := ud || format('%s=%s/%s ', v_kr, public.koebergebyr_oere(v_kr * 100, false),
                       public.saelgergebyr_oere(v_kr * 100, false));
  end loop;
  ud := ud || format('erhverv(1000 kr.)=%s/%s | ', public.koebergebyr_oere(100000, true),
                     public.saelgergebyr_oere(100000, true));

  -- Fragt.
  for r in select kode, pakkeshop_oere, doer_oere from public.fragt_pakkestoerrelser order by sortering loop
    ud := ud || format('%s=%s(%s) ', r.kode, r.pakkeshop_oere, coalesce(r.doer_oere::text, 'null'));
  end loop;
  ud := ud || '| ';

  -- Tre auktioner som pengetestene (afsluttede, vinder sat, uden for
  -- afslut_udloebne_auktioners 7 dage).
  insert into public.auctions (bruger_id, titel, beskrivelse, billeder, startpris, kategori, postnummer, lokation,
                               forsendelse_mulig, afhentning_mulig, stand, varighed_dage, forbudt_bekraeftet,
                               pakkestoerrelse, vaegt_gram, slutter_kl, status, vinder_id, afsluttet_kl)
  values (v_saelger, 'TEST prismodel: send', 'TEST', '{}', 1, 'Andet', '2100', 'København Ø',
          true, true, 'god', 3, true, 'lille', 500, now() - interval '8 days', 'afsluttet', v_koeber, now() - interval '8 days')
  returning id into a1;
  insert into public.auctions (bruger_id, titel, beskrivelse, billeder, startpris, kategori, postnummer, lokation,
                               forsendelse_mulig, afhentning_mulig, stand, varighed_dage, forbudt_bekraeftet,
                               slutter_kl, status, vinder_id, afsluttet_kl)
  values (v_saelger, 'TEST prismodel: afhent', 'TEST', '{}', 1, 'Andet', '2100', 'København Ø',
          false, true, 'god', 3, true, now() - interval '8 days', 'afsluttet', v_koeber, now() - interval '8 days')
  returning id into a2;
  insert into public.auctions (bruger_id, titel, beskrivelse, billeder, startpris, kategori, postnummer, lokation,
                               forsendelse_mulig, afhentning_mulig, stand, varighed_dage, forbudt_bekraeftet,
                               pakkestoerrelse, vaegt_gram, slutter_kl, status, vinder_id, afsluttet_kl)
  values (v_saelger, 'TEST prismodel: erhverv', 'TEST', '{}', 1, 'Andet', '2100', 'København Ø',
          true, false, 'god', 3, true, 'stor', 9000, now() - interval '8 days', 'afsluttet', v_koeber, now() - interval '8 days')
  returning id into a3;
  -- Erhverv-flaget sættes direkte (testen tester gebyret, ikke firmaflowet).
  update public.auctions set erhverv = true where id = a3;

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (a1, v_saelger, v_koeber, 100, 'afventer_betaling') returning id into t1;
  insert into public.trades (auction_id, seller_id, buyer_id, amount, status, afhentning)
  values (a2, v_saelger, v_koeber, 7501, 'afventer_betaling', true) returning id into t2;
  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (a3, v_saelger, v_koeber, 25000, 'afventer_betaling') returning id into t3;

  -- Gamle 5 %-beløb og et tilkøbt Beskyttelse-beløb: skal regnes om.
  insert into public.betalinger (trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere,
                                 beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere,
                                 betal_senest, vundet_mail_sendt_kl)
  values (t1, a1, v_koeber, v_saelger, 10000, 500, 3500, true, 2500, 16500, 500, 9500, now() + interval '48 hours', now()),
         (t2, a2, v_koeber, v_saelger, 750100, 37505, 0, false, 0, 787605, 37505, 712595, now() + interval '48 hours', now()),
         (t3, a3, v_koeber, v_saelger, 2500000, 125000, 3500, true, 25000, 2653500, 125000, 2375000, now() + interval '48 hours', now());

  select * into b from public.betalinger where trade_id = t1;
  ud := ud || format('send: %s koeb=%s saelg=%s fragt=%s besk=%s/%s total=%s udb=%s ',
                     b.prismodel, b.koebergebyr_oere, b.saelgergebyr_oere, b.fragt_oere, b.beskyttelse,
                     b.beskyttelse_oere, b.total_oere, b.udbetaling_oere);
  -- Application fee (CHECK betalinger_destination_gebyr_stemmer).
  update public.betalinger set application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere
   where id = b.id;
  begin
    update public.betalinger set application_fee_oere = application_fee_oere + 1 where id = b.id;
    ud := ud || 'fee=FEJL(forkert gebyr accepteret) | ';
  exception when check_violation then
    ud := ud || 'fee=ok | ';
  end;

  select * into b from public.betalinger where trade_id = t2;
  ud := ud || format('afhent: %s fragt=%s besk=%s/%s total=%s | ', b.prismodel, b.fragt_oere, b.beskyttelse,
                     b.beskyttelse_oere, b.total_oere);
  select * into b from public.betalinger where trade_id = t3;
  ud := ud || format('erhverv: %s koeb=%s saelg=%s besk=%s/%s | ', b.prismodel, b.koebergebyr_oere,
                     b.saelgergebyr_oere, b.beskyttelse, b.beskyttelse_oere);

  -- Skift leveringsform (som handel_gem_levering: beskyttelse = v_besk > 0 = false).
  select * into b from public.betalinger where trade_id = t1;
  update public.betalinger set fragt_oere = 0, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere,
         application_fee_oere = koebergebyr_oere + saelgergebyr_oere where id = b.id;
  select * into b from public.betalinger where id = b.id;
  ud := ud || format('skift: til_afhentning besk=%s, ', b.beskyttelse);
  update public.betalinger set fragt_oere = 4200, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere + 4200,
         application_fee_oere = koebergebyr_oere + saelgergebyr_oere + 4200, prismodel = 'gammel' where id = b.id;
  select * into b from public.betalinger where id = b.id;
  ud := ud || format('tilbage besk=%s, prismodel=%s | ', b.beskyttelse, b.prismodel);

  -- Sag med medhold: kun buddet (samme funktion som sag_claim_refusion).
  ud := ud || format('sag: ny=%s | ', public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere));

  -- Beløbsloftet (et bud på en afsluttet auktion kan også afvises af
  -- handle_new_bid - teksten viser, hvilken trigger der svarede).
  begin
    insert into public.bids (auktion_id, bruger_id, "beløb") values (a1, v_koeber, 25001);
    ud := ud || 'loft: FEJL(bud over 25.000 accepteret) | ';
  exception when others then
    ud := ud || format('loft: afvist (%s %s) | ', sqlstate, sqlerrm);
  end;

  -- md5 af de rettede funktioner (skal være "ny" i migrationen).
  ud := ud || 'fmd5: ';
  for r in
    select p.oid::regprocedure::text as fn,
           md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g'))) as h
      from pg_proc p
     where p.oid in ('public.afslut_udloebne_auktioner()'::regprocedure,
                     'public.andenchance_svar(uuid,uuid,boolean)'::regprocedure,
                     'public.saet_maksimum(uuid,numeric,boolean,timestamp with time zone)'::regprocedure,
                     'public.sag_claim_refusion(uuid)'::regprocedure,
                     'public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)'::regprocedure,
                     'public.saelger_udbetaling_claim(uuid,text,uuid[])'::regprocedure,
                     'public.handel_udbetalingsstatus(uuid)'::regprocedure,
                     'public.faktura_planlaeg(integer)'::regprocedure)
     order by 1
  loop
    ud := ud || format('%s=%s ', r.fn, r.h);
  end loop;

  raise exception 'RESULTAT (rulles tilbage): %', ud;
end $t$;
