-- KUN TESTDATABASEN "Bidhamr Test" (pjiigmzqwlfepxnjdvug). ALDRIG PRODUKTION.
-- Datatest af 20261021010000_fragt_dao_direkte.sql: labelgrænse for DAO, token
-- med lås-id, ukendte koder, efterlysning (samme frist som handel_auto_frigiv),
-- poison event, forældreløse og kapløbet med forsendelse_gem_oprettet i BEGGE
-- rækkefølger (gemt først -> ikke forældreløs; forældreløs først -> afvist).
-- Bruger to eksisterende testhandler (id'erne øverst - ret dem, hvis
-- testdata er nulstillet). Alt rulles tilbage: blokken slutter med en BEVIDST
-- exception. Forventet (13. okt. 2026):
--   9x ok, 3x for_mange_labels | shipmondo=for_mange_labels | tok1=0,tok2=null,
--   fremmedFejl=0,fremmedGem=false,laasStadigVores=true,gem=true,token=1234/null,
--   fejl1=1 | ukendt1=true,ukendt2=false | mulig13dage=false,mulig15dage=true,
--   kandidat=1,claim=ok,claim2=findes,afslut=true,afslut2=false,staff=true |
--   p1=false/false,p2=false/false,p3=true/true,p4=true/false,poisonStaff=true |
--   reg=true,reg2=false,a1..a4=igen,a5=opgivet,regAktiv=false,reg3=true,
--   gemForaeldreloes=afvist,gemNy=true,claimOrphan999=1 | stiUgyldig=afvist,
--   label=true,label2=false | slet=afvist
do $t$
declare
  v_trade uuid := 'c0a7bae8-945e-4e0d-9326-e13d830ebcd9';
  v_saelger uuid;
  r jsonb;
  ud text := '';
  i int;
  v_tok jsonb;
  v_tok2 jsonb;
  v_ok boolean;
  v_trade2 uuid := 'cdb0c191-9df1-4c8f-97eb-aa688cade440';
  v_f uuid;
  v_f2 uuid;
  v_e jsonb;
  v_o record;
  v_txt text;
begin
  select seller_id into v_saelger from public.trades where id = v_trade;
  update public.forsendelser set status = 'annulleret', annulleret_kl = now() where trade_id = v_trade;
  update public.handel_levering set fragtfirma = 'dao' where trade_id = v_trade;

  -- DAO: annullerede DAO-labels tæller ikke; loft 10 i alt.
  for i in 1..12 loop
    r := public.forsendelse_claim(v_trade, v_saelger, 'udgaaende', 'dao', null);
    ud := ud || coalesce(r->>'kode', '?') || ',';
    if r->>'kode' = 'ok' then
      update public.forsendelser set status = 'annulleret', annulleret_kl = now(), forsendelses_id = 'DAO' || i, sporingsnummer = 'DAO' || i
       where id = (r->>'id')::uuid;
    end if;
  end loop;
  r := public.forsendelse_claim(v_trade, v_saelger, 'udgaaende', 'shipmondo', null);
  ud := ud || ' | shipmondo=' || coalesce(r->>'kode', '?') || ' | ';

  -- Token med lås-id.
  v_tok := public.fragt_sporing_token_claim('dao', 600);
  ud := ud || 'tok1=' || coalesce(v_tok->>'token', 'null') || ',';
  ud := ud || 'tok2=' || coalesce(public.fragt_sporing_token_claim('dao', 600)::text, 'null') || ',';
  ud := ud || 'fremmedFejl=' || public.fragt_sporing_token_fejl('dao', gen_random_uuid(), 'x')::text || ',';
  ud := ud || 'fremmedGem=' || public.fragt_sporing_token_gem('dao', gen_random_uuid(), '0', '55', 1)::text || ',';
  select coalesce(laas_id::text, 'null') into v_txt from public.fragt_sporing_token where fragtfirma = 'dao';
  ud := ud || 'laasStadigVores=' || (v_txt = v_tok->>'laas')::text || ',';
  ud := ud || 'gem=' || public.fragt_sporing_token_gem('dao', (v_tok->>'laas')::uuid, '0', '1234', 5)::text || ',';
  select token || '/' || coalesce(laas_id::text, 'null') into v_txt from public.fragt_sporing_token where fragtfirma = 'dao';
  ud := ud || 'token=' || v_txt || ',';
  update public.fragt_sporing_token set hentet_kl = now() - interval '1 hour' where fragtfirma = 'dao';
  v_tok2 := public.fragt_sporing_token_claim('dao', 600);
  ud := ud || 'fejl1=' || public.fragt_sporing_token_fejl('dao', (v_tok2->>'laas')::uuid, 'test')::text || ' | ';

  -- Ukendte koder.
  ud := ud || 'ukendt1=' || public.fragt_ukendt_kode_registrer('dao', '42', 'pakkeshop', 'Noget', 'ABC123456')::text || ',';
  ud := ud || 'ukendt2=' || public.fragt_ukendt_kode_registrer('dao', '42', 'pakkeshop', 'Noget', 'ABC123456')::text || ' | ';

  -- Efterlysning: samme frist som handel_auto_frigiv.
  insert into public.forsendelser (trade_id, type, fragtfirma, status, pakkestoerrelse, forsendelses_id, sporingsnummer, afleveret_kl)
  values (v_trade2, 'udgaaende', 'dao', 'i_transit', 'mellem', 'DAOEFT1234', 'DAOEFT1234', now() - interval '15 days')
  returning id into v_f;
  -- Testdata: handlens betaling er annulleret - sæt den betalt (rulles tilbage).
  update public.betalinger set status = 'betalt', betalt_kl = now() - interval '20 days' where trade_id = v_trade2;
  update public.trades set sendt_kl = now() - interval '13 days' where id = v_trade2;
  ud := ud || 'mulig13dage=' || public.fragt_efterlysning_mulig(v_f)::text || ',';
  update public.trades set sendt_kl = now() - interval '15 days' where id = v_trade2;
  ud := ud || 'mulig15dage=' || public.fragt_efterlysning_mulig(v_f)::text || ',';
  select count(*)::text into v_txt from public.fragt_efterlysning_kandidater(array['dao'], 10) k where k.forsendelse_id = v_f;
  ud := ud || 'kandidat=' || v_txt || ',';
  v_e := public.fragt_efterlysning_claim(v_f, true);
  ud := ud || 'claim=' || (v_e->>'kode') || ',claim2=' || (public.fragt_efterlysning_claim(v_f, true)->>'kode') || ',';
  ud := ud || 'afslut=' || public.fragt_efterlysning_afslut((v_e->>'id')::uuid, 'oprettet', null)::text || ',';
  ud := ud || 'afslut2=' || public.fragt_efterlysning_afslut((v_e->>'id')::uuid, 'afvist', null)::text || ',';
  select kraever_opmaerksomhed::text into v_txt from public.forsendelser where id = v_f;
  ud := ud || 'staff=' || v_txt || ' | ';

  -- Poison event: opgives efter 3 forsøg, staff markeres én gang.
  update public.forsendelser set kraever_opmaerksomhed = false, opmaerksomhed_tekst = null where id = v_f;
  for i in 1..4 loop
    r := public.fragt_feed_haendelse_fejl('dao', 'dao:X:1:t', v_f, 'kaput', 3);
    ud := ud || 'p' || i || '=' || (r->>'opgivet') || '/' || (r->>'nu') || ',';
  end loop;
  select kraever_opmaerksomhed::text into v_txt from public.forsendelser where id = v_f;
  ud := ud || 'poisonStaff=' || v_txt || ' | ';

  -- Forældreløse.
  ud := ud || 'reg=' || public.fragt_foraeldreloes_registrer(v_f, 'ORPHAN123')::text || ',';
  ud := ud || 'reg2=' || public.fragt_foraeldreloes_registrer(v_f, 'ORPHAN123')::text || ',';
  for i in 1..5 loop
    update public.fragt_foraeldreloese set forsoegt_kl = now() - interval '1 day' where forsendelse_id = v_f;
    select * into v_o from public.fragt_foraeldreloese_claim(v_f, 10) limit 1;
    ud := ud || 'a' || i || '=' || public.fragt_foraeldreloes_afslut(v_o.id, false, 'test') || ',';
  end loop;
  -- Rækkefølge 1: gem_oprettet FØRST, derefter registrer -> ikke forældreløs.
  ud := ud || 'regAktiv=' || public.fragt_foraeldreloes_registrer(v_f, 'DAOEFT1234')::text || ',';
  -- Rækkefølge 2: registrer FØRST, derefter gem_oprettet -> afvist.
  insert into public.forsendelser (trade_id, type, fragtfirma, status, pakkestoerrelse)
  values (v_trade2, 'retur', 'dao', 'opretter', 'mellem') returning id into v_f2;
  ud := ud || 'reg3=' || public.fragt_foraeldreloes_registrer(v_f2, 'ORPHAN999')::text || ',';
  begin
    perform public.forsendelse_gem_oprettet(v_f2, 'ORPHAN999', 'ORPHAN999', null, '1 2 3', null);
    ud := ud || 'gemForaeldreloes=TILLADT!,';
  exception when others then
    ud := ud || 'gemForaeldreloes=afvist,';
  end;
  ud := ud || 'gemNy=' || public.forsendelse_gem_oprettet(v_f2, 'NYKODE777', 'NYKODE777', null, '1 2 3', null)::text || ',';
  select count(*)::text into v_txt from public.fragt_foraeldreloese_claim(v_f2, 10) c where c.forsendelses_id = 'ORPHAN999';
  ud := ud || 'claimOrphan999=' || v_txt || ' | ';

  -- Label senere.
  begin
    perform public.forsendelse_gem_label(v_f, 'ugyldig');
    ud := ud || 'stiUgyldig=accepteret!,';
  exception when others then
    ud := ud || 'stiUgyldig=afvist,';
  end;
  ud := ud || 'label=' || public.forsendelse_gem_label(v_f, v_trade2 || '/' || v_f || '.pdf')::text || ',';
  ud := ud || 'label2=' || public.forsendelse_gem_label(v_f, v_trade2 || '/' || v_f || '.pdf')::text || ' | ';

  begin
    delete from public.fragt_efterlysninger where forsendelse_id = v_f;
    ud := ud || 'slet=TILLADT!';
  exception when others then
    ud := ud || 'slet=afvist';
  end;

  raise exception 'TESTRESULTAT: %', ud;
end $t$;
