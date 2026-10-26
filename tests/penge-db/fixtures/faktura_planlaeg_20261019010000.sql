-- faktura_planlaeg, som den ser ud efter 20261019010000 (20261016030000 +
-- ps_ret-rettelsen i 20261019010000, rekonstrueret fra repoet - md5
-- eaccfc18b96f7d35e32abfd591253bbc, samme som "ny" i 20261019010000). Bruges af
-- tests/penge-db/nyPrismodel.test.ts.
create or replace function public.faktura_planlaeg(p_graense integer default 200)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense  integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura  integer := 0;
  v_kredit   integer := 0;
  v_abon     integer := 0;
  v_retur    integer := 0;
  v_returfragt integer := 0;
  n          integer;
  rb         record;
  rf         record;
  rr         record;
  v_linjer   jsonb;
  v_status   text;
  v_manuel   boolean;
  v_fejl     text;
  v_dato     date;
  v_tekst    text;
  v_maade    text;
  v_fragt    text;
  v_moder    text := 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.';
  v_ia_fejl  text := 'Pakken blev ikke afhentet, men refusionen hos Stripe passer ikke med planen (gebyr, tilbageførsel eller beløb) - kontrollér refusionen og lav dokumentet manuelt i Dinero.';
begin
  -- 0) Kreditnotaer/modposteringer, der venter, men hvis faktura/bilag
  --    siden er håndteret manuelt (eller stoppet som manuel): de kan ikke
  --    laves automatisk (dokumentet findes ikke sikkert i Dinero med vores
  --    guid) -> kræver handling, manuel. Drift-alarmen gives af serveren
  --    (én pr. dokument, alarm_kl).
  update public.fakturaer k
     set status = 'kraever_handling',
         manuel = true,
         sidste_fejl = case when k.dokument = 'kreditnota' then v_moder
                            else 'Bilaget blev håndteret manuelt – lav modposteringen manuelt i Dinero.' end
    from public.fakturaer m
   where m.id = k.krediterer_id
     and k.status = 'venter'
     and (k.laas_til is null or k.laas_til < now())
     and (m.status = 'haandteret_manuelt' or (m.manuel and m.status = 'kraever_handling'));

  -- 1) Fakturaer: betalte destination-betalinger, hvor BidHamrs gebyr er
  --    trukket og spejlet fra Stripe.
  for rb in
    select x.*
      from public.betalinger x
     where x.pengemodel = 'destination'
       and x.betalt_kl is not null
       and x.application_fee_oere is not null
       and x.stripe_application_fee_id is not null
       and ((x.koebergebyr_oere + x.fragt_oere + x.beskyttelse_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'koeber' and f.dokument = 'faktura'
                                and f.slags = 'salg'))
         or (x.saelgergebyr_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'saelger' and f.dokument = 'faktura'
                                and f.slags = 'salg')))
     order by x.betalt_kl
     limit v_graense
  loop
    v_dato := (rb.betalt_kl at time zone 'Europe/Copenhagen')::date;
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rb.application_fee_oere <> rb.koebergebyr_oere + rb.saelgergebyr_oere + rb.fragt_oere + rb.beskyttelse_oere then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'BidHamrs gebyr hos Stripe passer ikke med handlens købergebyr, sælgergebyr, fragt og BidHamr Beskyttelse - lav fakturaen manuelt i Dinero.';
    end if;

    -- Fragtlinjen efter købers leveringsvalg i checkout (handel_levering,
    -- 20261012010000_fragt_dao_shipmondo.sql). fragt_oere er låst ved betalingen.
    v_maade := null;
    if rb.fragt_oere > 0 and to_regclass('public.handel_levering') is not null then
      execute 'select maade from public.handel_levering where trade_id = $1' into v_maade using rb.trade_id;
    end if;
    v_fragt := case v_maade when 'pakkeshop' then 'Fragt (levering til pakkeshop)'
                            when 'doer' then 'Fragt (levering til døren)'
                            else 'Fragt' end;

    -- Køberen: købergebyr + fragt + BidHamr Beskyttelse.
    select coalesce(jsonb_agg(v.l order by v.o), '[]'::jsonb) into v_linjer
      from (values (1, public.faktura_linje('koebergebyr', 'Købergebyr (5 %)', rb.koebergebyr_oere)),
                   (2, public.faktura_linje('fragt', v_fragt, rb.fragt_oere)),
                   (3, public.faktura_linje('beskyttelse', 'BidHamr Beskyttelse', rb.beskyttelse_oere))) v(o, l)
     where v.l is not null;
    if jsonb_array_length(v_linjer) > 0 then
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
      values ('faktura', 'koeber', rb.buyer_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl, 'salg')
      on conflict do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;

    -- Sælgeren: sælgergebyret.
    if rb.saelgergebyr_oere > 0 then
      v_linjer := jsonb_build_array(public.faktura_linje('saelgergebyr', 'Sælgergebyr (5 %)', rb.saelgergebyr_oere));
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
      values ('faktura', 'saelger', rb.seller_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl, 'salg')
      on conflict do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;
  end loop;

  -- 2) Kreditnotaer: betalingen er refunderet. Krediteret = det, BidHamr
  --    faktisk har givet tilbage af sit gebyr (refusion_gebyr_oere, trin 4):
  --      hele gebyret              -> alle linjer (køber og sælger)
  --      gebyret - Beskyttelse     -> alt undtagen BidHamr Beskyttelse
  --                                   (sag med medhold - BidHamr beholder den)
  --      ikke afhentet             -> kun sælgerens faktura (helt); købers
  --                                   faktura krediteres ikke
  --      andet / ikke registreret  -> kræver handling (laves manuelt)
  for rf in
    select fa.id, fa.part, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer,
           fa.manuel as moder_manuel, fa.status as moder_status,
           x.refunderet_kl, x.gebyr_refunderet_kl, x.refusion_gebyr_oere, x.application_fee_oere,
           x.beskyttelse_oere, x.stripe_refund_id, x.refusion_aarsag,
           public.faktura_ikke_afhentet_ok(x.id) as ia_ok,
           x.bidhamr_daekker_refund_id, x.bidhamr_daekker_oere, x.total_oere
      from public.fakturaer fa
      join public.betalinger x on x.id = fa.betaling_id
     where fa.dokument = 'faktura'
       and fa.slags = 'salg'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
       -- Ikke afhentet: købers gebyrer og fragt refunderes ikke - ingen kreditnota.
       and not (x.refusion_aarsag is not distinct from 'ikke_afhentet' and fa.part = 'koeber')
       -- BidHamr dækker (20261019010000): sælgeren fik sin udbetaling - hans faktura står.
       and not (x.bidhamr_daekker_refund_id is not null and fa.part = 'saelger')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rf.moder_manuel or rf.moder_status in ('kraever_handling', 'haandteret_manuelt') then
      -- Fakturaen findes ikke (sikkert) i Dinero med vores guid.
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := v_moder;
    elsif rf.bidhamr_daekker_refund_id is not null then
      -- BidHamr dækker: købers gebyrer, fragt (og Beskyttelse, medmindre den
      -- blev beholdt ved en sag) er givet tilbage af BidHamr.
      if rf.bidhamr_daekker_oere = rf.total_oere then
        v_linjer := rf.linjer;
      elsif rf.beskyttelse_oere > 0 and rf.bidhamr_daekker_oere = rf.total_oere - rf.beskyttelse_oere then
        select coalesce(jsonb_agg(l), '[]'::jsonb) into v_linjer
          from jsonb_array_elements(rf.linjer) l
         where l->>'kode' <> 'beskyttelse';
      else
        v_linjer := rf.linjer;
        v_status := 'kraever_handling';
        v_manuel := true;
        v_fejl := 'BidHamr dækkede refusionen med et beløb, der ikke passer med en fuld refusion eller en refusion uden BidHamr Beskyttelse - lav kreditnotaen manuelt i Dinero.';
      end if;
    elsif rf.gebyr_refunderet_kl is null or rf.refusion_gebyr_oere is null then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Betalingen er refunderet, men BidHamrs gebyr-refusion er ikke registreret - kontrollér refusionen hos Stripe og lav kreditnotaen manuelt i Dinero.';
    elsif rf.refusion_aarsag is not distinct from 'ikke_afhentet' then
      -- Sælgerens faktura (sælgergebyret) krediteres helt: sælgeren fik intet.
      v_linjer := rf.linjer;
      if not rf.ia_ok then
        v_status := 'kraever_handling';
        v_manuel := true;
        v_fejl := v_ia_fejl;
      end if;
    elsif rf.refusion_gebyr_oere = rf.application_fee_oere then
      v_linjer := rf.linjer;
    elsif rf.beskyttelse_oere > 0 and rf.refusion_gebyr_oere = rf.application_fee_oere - rf.beskyttelse_oere then
      select coalesce(jsonb_agg(l), '[]'::jsonb) into v_linjer
        from jsonb_array_elements(rf.linjer) l
       where l->>'kode' <> 'beskyttelse';
    else
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Den refunderede del af BidHamrs gebyr passer ikke med en fuld refusion eller en refusion uden BidHamr Beskyttelse - lav kreditnotaen manuelt i Dinero.';
    end if;
    if jsonb_array_length(v_linjer) = 0 then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Intet at kreditere på fakturaen - kontrollér refusionen.';
    end if;

    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('kreditnota', rf.part, rf.bruger_id, rf.betaling_id, rf.trade_id, rf.id, v_linjer,
            public.faktura_sum(v_linjer), public.faktura_moms(v_linjer),
            (rf.refunderet_kl at time zone 'Europe/Copenhagen')::date, rf.stripe_refund_id,
            v_status, v_manuel, v_fejl)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  -- 2b) Ikke afhentet: returfragten, der blev trukket fra købers refusion, er
  --     BidHamrs ydelse og faktureres køberen (fragtkonto). Dateres på
  --     refusionsdagen. Kun når refusionen er gennemført (ved R = 0: når
  --     sælgerens del er tilbageført). Beløbet er den beholdte returfragt -
  --     højst buddet; er returfragten større, dækker BidHamr resten.
  for rf in
    select x.id, x.buyer_id, x.trade_id, x.refunderet_kl, x.stripe_charge_id, x.stripe_payment_intent_id,
           -- Den returfragt, der faktisk er beholdt (højst buddet - resten dækker BidHamr).
           ia.total_oere - ia.koebergebyr_oere - ia.beskyttelse_oere - ia.fragt_oere - ia.refusion_oere as returfragt_oere,
           public.faktura_ikke_afhentet_ok(x.id) as ia_ok
      from public.handel_ikke_afhentet ia
      join public.betalinger x on x.id = ia.betaling_id
     where ia.total_oere - ia.koebergebyr_oere - ia.beskyttelse_oere - ia.fragt_oere - ia.refusion_oere > 0
       and x.pengemodel = 'destination'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and x.refusion_aarsag is not distinct from 'ikke_afhentet'
       and not exists (select 1 from public.fakturaer f
                        where f.betaling_id = x.id and f.part = 'koeber' and f.dokument = 'faktura'
                          and f.slags = 'returfragt')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_linjer := jsonb_build_array(public.faktura_linje('fragt', 'Returfragt (pakken blev ikke afhentet)', rf.returfragt_oere));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
    values ('faktura', 'koeber', rf.buyer_id, rf.id, rf.trade_id, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (rf.refunderet_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(rf.stripe_charge_id, rf.stripe_payment_intent_id),
            case when rf.ia_ok then 'venter' else 'kraever_handling' end, not rf.ia_ok,
            case when rf.ia_ok then null else v_ia_fejl end, 'returfragt')
    on conflict do nothing;
    get diagnostics n = row_count;
    v_returfragt := v_returfragt + n;
  end loop;

  -- 3) Erhvervsabonnement: betalte Stripe-fakturaer bogføres som finansbilag.
  for rr in
    select rg.*, fm.bruger_id
      from public.firma_regninger rg
      join public.firmaer fm on fm.id = rg.firma_id
     where rg.betalt_kl is not null
       and rg.status in ('betalt', 'krediteret')
       and rg.beloeb_oere > 0
       and not exists (select 1 from public.fakturaer f
                        where f.firma_regning_id = rg.id and f.dokument = 'abonnement')
     order by rg.betalt_kl
     limit v_graense
  loop
    v_tekst := case rr.type when 'opgradering' then 'Opgradering af erhvervsabonnement'
                           when 'andet' then 'BidHamr erhverv'
                           else 'Erhvervsabonnement' end
               || coalesce(' - Stripe-faktura ' || rr.nummer, '');
    v_linjer := jsonb_build_array(jsonb_build_object('kode', 'abonnement', 'tekst', left(v_tekst, 200),
                                                     'beloeb_oere', rr.beloeb_oere));
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rr.moms_oere is not null and rr.moms_oere <> public.faktura_moms(v_linjer) then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Momsen på Stripe-fakturaen er ikke 25 % af beløbet - bogfør den manuelt i Dinero.';
    end if;
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, linjer, beloeb_oere, moms_oere,
                                  betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('abonnement', 'firma', rr.bruger_id, rr.id, v_linjer, rr.beloeb_oere,
            coalesce(rr.moms_oere, public.faktura_moms(v_linjer)),
            (rr.betalt_kl at time zone 'Europe/Copenhagen')::date, rr.stripe_invoice_id,
            v_status, v_manuel, v_fejl)
    on conflict (firma_regning_id, dokument) where firma_regning_id is not null do nothing;
    get diagnostics n = row_count;
    v_abon := v_abon + n;
  end loop;

  -- 3b) Refunderet abonnementsfaktura (krediteret efter betaling): modpostering.
  for rf in
    select fa.id, fa.bruger_id, fa.firma_regning_id, fa.linjer, fa.beloeb_oere, fa.moms_oere, fa.stripe_reference,
           fa.manuel as moder_manuel, fa.status as moder_status, rg.krediteret_kl
      from public.fakturaer fa
      join public.firma_regninger rg on rg.id = fa.firma_regning_id
     where fa.dokument = 'abonnement'
       and rg.status = 'krediteret'
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
     limit v_graense
  loop
    v_manuel := rf.moder_manuel or rf.moder_status in ('kraever_handling', 'haandteret_manuelt');
    -- Delvis refusion hos Stripe kontrolleres, før modposteringen bogføres
    -- (src/lib/faktura/koe.ts) - passer beløbet ikke, stoppes den til staff.
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, krediterer_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('abonnement_retur', 'firma', rf.bruger_id, rf.firma_regning_id, rf.id, rf.linjer, rf.beloeb_oere,
            rf.moms_oere, (coalesce(rf.krediteret_kl, now()) at time zone 'Europe/Copenhagen')::date, rf.stripe_reference,
            case when v_manuel then 'kraever_handling' else 'venter' end, v_manuel,
            case when v_manuel then 'Bilaget blev håndteret manuelt – lav modposteringen manuelt i Dinero.' end)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_retur := v_retur + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit,
                            'abonnement', v_abon, 'abonnement_retur', v_retur,
                            'returfragt', v_returfragt);
end
$fn$;
