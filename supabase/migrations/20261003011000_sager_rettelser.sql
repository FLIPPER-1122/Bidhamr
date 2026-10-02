-- Rettelser til sager (20261003010000_sager.sql) efter review.
--
--   M-A  betaling_refusion_fejlet (ny): en refusion, der var registreret som
--        gennemfoert ('refunderet'), men som derefter fejler hos Stripe
--        (refund.failed / canceled), saetter betalingen tilbage til 'betalt'
--        med refusionen stadig claimet (refusion_anmodet_kl, refusion_oere),
--        saa cron proever igen (refunderSagerVentende) og admin ser den.
--        Handlen forbliver annulleret, og sagen forbliver afviklet - pengene
--        er stadig paa vej tilbage til koeberen. Intet kan frigives/overfoeres
--        imens (refusion_anmodet_kl blokerer alle pengeveje).
--   M-B  Inhabilitet: sag_afgoer, sag_retur_afleveret og sag_genaabn afviser
--        med kode 'inhabil', hvis medarbejderen selv er koeber eller saelger
--        paa handlen. bruger_luk_konto_permanent afviser, hvis medarbejderen
--        er part i den angivne sag, eller har en sag med brugeren i det hele
--        taget (ogsaa uden p_sag).
--   L-1  Backfill: trades.sendt_kl for handler, der allerede er sendt.
--   L-3  handel_auto_frigiv: indsigelser og sager, der holder pengene,
--        frasorteres allerede i kandidat-forespoergslen, og hver raekke koerer
--        i sin egen undertransaktion, saa een fejl ikke stopper batchen.
--   L-4  betaling_registrer_refunderet: ogsaa 'leveret' annulleres.
--
-- Idempotent: create or replace / update ... where ... is null. Ingen
-- handelsdata slettes.

-- ============================================================ L-1 backfill

-- Handler sendt foer trades.sendt_kl fandtes. Det rigtige afsendelsestidspunkt
-- kendes ikke, saa sendt_kl saettes til tidspunktet, hvor denne migration
-- koeres, og uret starter forfra derfra - for begge parter:
--   - koeberen skal vente 7 dage fra migrationens koersel, foer der kan
--     oprettes en bortkommet-sag (ogsaa selvom pakken reelt blev sendt
--     tidligere),
--   - saelgeren kan komme til at vente op til 14 dage fra migrationens
--     koersel paa automatisk frigivelse (hvis koeberen ikke trykker
--     "modtaget" eller opretter en sag inden da).
update public.trades
   set sendt_kl = now()
 where status = 'pakke_sendt'
   and sendt_kl is null;

-- ============================================================ Staff: afgoer

-- p_udfald: 'koeber' | 'saelger' | 'lukket'.
-- ANKEFRIST: ingen penge flyttes her. Afgoerelsen planlaegges til
-- penge_flyttes_efter_kl = nu + 4 dage; sag_afvikl (cron) flytter pengene
-- derefter. trades.sag_aaben forbliver true (frosset) imens, og admin kan
-- genaabne sagen (sag_genaabn), hvilket annullerer den planlagte flytning.
--
-- Returnerer {"kode": "ok", "handling", "penge_flyttes_efter_kl",
-- "advarsel"?, "betaling_id"?, "trade_id", "buyer_id", "seller_id",
-- "auction_id", "type", "version"} hvor handling er:
--   'planlagt_refusion'   - koeberen refunderes efter fristen (svindel/bortkommet,
--                           eller skadet/ikke som beskrevet, hvor returpakken
--                           allerede er registreret som afleveret)
--   'afvent_retur'        - koeberen skal sende varen retur (BidHamr betaler
--                           fragten); refusion naar retur er afleveret OG
--                           fristen er udloebet
--   'planlagt_frigivelse' - saelgeren faar pengene efter fristen
--   'lukket'              - ingen penge flyttes; frysningen fjernes efter fristen
-- advarsel (kun saelger): 'indsigelse' | 'refusion' | 'ikke_betalt' |
--   'ingen_betaling' - frigivelsen vil vaere blokeret, hvis det stadig gaelder
--   naar fristen udloeber (staff skal foelge op).
-- Fejlkoder: ingen_adgang, ugyldigt_udfald, begrundelse_mangler,
-- for_lang_tekst, ikke_fundet, inhabil (medarbejderen er selv koeber eller
-- saelger paa handlen), forkert_status, indsigelse, ikke_mulig.
-- Logger i moderation_log (uden beloeb - medarbejdere kan se loggen).
-- Som 20261003010000, men med inhabilitetstjek.
create or replace function public.sag_afgoer(
  p_medarbejder uuid,
  p_sag         uuid,
  p_udfald      text,
  p_begrundelse text,
  p_intern_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_frist    timestamptz := now() + interval '4 days';
  v_trade    uuid;
  s          record;
  t          record;
  b          record;
  v_handling text;
  v_advarsel text;
  v_log      text;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('koeber', 'saelger', 'lukket') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  -- Ingen maa afgoere en sag, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if s.status = 'aaben' then
    null;
  elsif s.status = 'afventer_retur' and p_udfald in ('saelger', 'lukket') then
    -- Fx koeberen sender aldrig varen retur.
    null;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if p_udfald = 'koeber' then
    -- Tjek allerede nu, at en refusion vil vaere mulig (ingen indsigelse,
    -- intet overfoert). sag_afvikl tjekker igen, naar fristen er udloebet.
    if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;
    if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
      return jsonb_build_object('kode', 'indsigelse');
    end if;
    if b.status <> 'betalt'
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null then
      return jsonb_build_object('kode', 'ikke_mulig');
    end if;

    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur. (Er returpakken allerede
      -- registreret - sagen er genaabnet efter retur - venter vi ikke igen.)
      update public.sager
         set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             retur_kraeves = (s.retur_afleveret_kl is not null),
             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then 'bidhamr' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'bidhamr',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (BidHamr betaler returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
    end if;
    -- trades.sag_aaben forbliver true: pengene er frosset til sag_afvikl.

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_koeber', 'sag', s.id, t.buyer_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  elsif p_udfald = 'saelger' then
    update public.sager
       set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'frigiv', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    -- Vil frigivelsen vaere blokeret? (samme regler som sag_afvikl)
    v_advarsel := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      else null end;

    v_handling := 'planlagt_frigivelse';
    v_log := 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage'
             || coalesce(' (OBS: frigivelsen er blokeret lige nu: ' || v_advarsel || ')', '');

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_saelger', 'sag', s.id, t.seller_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  else
    update public.sager
       set status = 'lukket', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'ingen', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    v_handling := 'lukket';
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, t.buyer_id,
            left('Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'penge_flyttes_efter_kl', v_frist,
    'advarsel', v_advarsel, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Staff: retur afleveret

-- Staff registrerer, at returpakken er afleveret (indtil GLS-sporingen er
-- bygget). Sagen afgoeres til koeberen. Refusionen sker, naar BAADE retur er
-- afleveret OG ankefristen er udloebet: er fristen allerede udloebet, afvikles
-- sagen straks (sag_afvikl), ellers tager cron den.
-- Returnerer {"kode": "ok", "handling", "grund"?, "penge_flyttes_efter_kl",
-- "betaling_id", ...} hvor handling er 'refunder' (claimet - serveren kalder
-- Stripe), 'planlagt_refusion' (venter paa fristen) eller 'refusion_blokeret'
-- (grund som i sag_afvikl). Fejlkoder: ingen_adgang, for_lang_tekst,
-- ikke_fundet, inhabil, forkert_status.
-- Som 20261003010000, men med inhabilitetstjek.
create or replace function public.sag_retur_afleveret(
  p_medarbejder uuid,
  p_sag         uuid,
  p_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  v_res   jsonb;
  v_handling text;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if s.status <> 'afventer_retur' or s.penge_handling is distinct from 'refunder' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  update public.sager
     set status = 'afgjort_koeber',
         retur_afleveret_kl = now(),
         retur_registreret_af = p_medarbejder,
         intern_note = case when v_note is null then intern_note
                            else left(coalesce(intern_note || chr(10), '') || 'Retur: ' || v_note, 4000) end
   where id = s.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret', 'sag', s.id, t.buyer_id,
          left('Returpakken er afleveret - refusion til køber (alt undtagen BidHamr Beskyttelse)'
               || case when s.penge_flyttes_efter_kl > now()
                       then ', når ankefristen er udløbet' else '' end
               || coalesce(' | ' || v_note, ''), 4000));

  if s.penge_flyttes_efter_kl <= now() then
    v_res := public.sag_afvikl(s.id);
    v_handling := case v_res->>'kode' when 'ok' then 'refunder' else 'refusion_blokeret' end;
  else
    v_handling := 'planlagt_refusion';
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'grund', v_res->>'grund',
    'penge_flyttes_efter_kl', s.penge_flyttes_efter_kl, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_retur_afleveret(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_retur_afleveret(uuid, uuid, text) to service_role;

-- ============================================================ Admin: genaabn

-- Admin/chef genaabner en afgjort eller lukket sag (anke-knappen er ikke
-- bygget endnu). Kun naar ingen penge er flyttet: ingen refusion, intet
-- overfoert/paabegyndt, og handlen er ikke annulleret. Inden for ankefristen
-- annulleres den planlagte refusion/frigivelse. Pengene fryses (igen).
-- Returnerer {"kode": "ok", "annulleret_planlagt", ...} eller ingen_adgang,
-- begrundelse_mangler, for_lang_tekst, ikke_fundet, inhabil, forkert_status,
-- penge_flyttet, findes (en anden aaben sag).
-- Som 20261003010000, men med inhabilitetstjek.
create or replace function public.sag_genaabn(
  p_medarbejder uuid,
  p_sag         uuid,
  p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  if t.status = 'annulleret'
     or b.id is null
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    return jsonb_build_object('kode', 'penge_flyttet');
  end if;

  begin
    update public.sager
       set status = 'aaben', afgjort_af = null, afgjort_kl = null, begrundelse = null,
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = null, penge_flyttes_efter_kl = null,
           afviklet_kl = null, penge_fejl = null,
           genaabnet_antal = genaabnet_antal + 1, genaabnet_kl = now()
     where id = s.id;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  update public.trades
     set sag_aaben = true,
         sag_note = coalesce(sag_note, 'Sag fra køberen (genåbnet)'),
         sag_aabnet_at = now()
   where id = t.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_genaabnet', 'sag', s.id, t.buyer_id,
          left('Sag genåbnet (tidligere status: ' || s.status || ')'
               || case when s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null
                       then ' - den planlagte ' || case s.penge_handling when 'refunder'
                            then 'refusion' else 'udbetaling' end || ' er annulleret'
                       else '' end
               || ' | ' || v_grund, 4000));

  return jsonb_build_object(
    'kode', 'ok',
    'annulleret_planlagt', s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal + 1);
end;
$fn$;

revoke all on function public.sag_genaabn(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_genaabn(uuid, uuid, text) to service_role;

-- ============================================================ Konto lukket permanent

-- Admin/chef lukker en konto permanent (suspenderet uden slutdato + aarsag).
-- p_sag er valgfri (logges). Returnerer {"kode": "ok"|"allerede_lukket"} eller
-- ingen_adgang, aarsag_mangler, ugyldig_bruger, sig_selv, staff (staff-konti
-- lukkes ikke herfra), ugyldig_sag, inhabil.
-- Som 20261003010000, men inhabil, hvis medarbejderen er part i p_sag, eller
-- hvis der findes en sag paa en handel mellem medarbejderen og brugeren
-- (ogsaa naar p_sag udelades - ellers kunne tjekket omgaas).
create or replace function public.bruger_luk_konto_permanent(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_aarsag      text,
  p_sag         uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_aarsag text := nullif(btrim(coalesce(p_aarsag, '')), '');
  u        record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_aarsag is null then return jsonb_build_object('kode', 'aarsag_mangler'); end if;
  if char_length(v_aarsag) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;

  select * into u from public.users where id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  if u.rolle in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'staff');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;
  if p_sag is not null and not exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where s.id = p_sag and (t.buyer_id = p_bruger or t.seller_id = p_bruger)) then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;
  if exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where (s.id = p_sag
            and (t.buyer_id = p_medarbejder or t.seller_id = p_medarbejder))
        or (t.buyer_id = p_medarbejder and t.seller_id = p_bruger)
        or (t.seller_id = p_medarbejder and t.buyer_id = p_bruger)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.users
     set suspenderet = true,
         suspenderet_aarsag = v_aarsag,
         suspenderet_kl = now(),
         suspenderet_til = null,
         konto_lukket_kl = now(),
         konto_lukket_af = p_medarbejder
   where id = p_bruger;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'konto_lukket', 'bruger', p_bruger, p_bruger,
          left('Konto lukket permanent' || coalesce(' (sag ' || p_sag::text || ')', '')
               || ' | ' || v_aarsag, 4000));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  to service_role;

-- ============================================================ Automatisk frigivelse

-- Cron. Frigiver pengene til saelgeren (samme sti som handel_godkend /
-- admin_frigiv_handel: trades.status 'leveret' + betalinger.frigivet_kl;
-- serveren overfoerer derefter med overfoerTilSaelger), naar:
--   (a) koeberen trykkede "modtaget" for over 48 timer siden, eller
--   (b) pakken blev sendt for over 14 dage siden (sendt_kl, ellers betalt_kl
--       for handler sendt foer sendt_kl fandtes), og koeberen hverken har
--       trykket "modtaget" eller oprettet en sag (indtil GLS-sporing).
-- Kun naar: betalt, ikke frigivet/refunderet/overfoert, ingen blokerende
-- indsigelse, ingen frysning (sag_aaben) og ingen sag, der holder pengene.
-- Idempotent: raekkerne laases og betingelserne tjekkes igen i samme
-- transaktion; frigivet_kl saettes kun, hvis det er tomt.
-- Returnerer jsonb-array: [{betaling_id, trade_id, buyer_id, seller_id,
-- auction_id, grund: '48_timer' | '14_dage'}].
-- Som 20261003010000, men indsigelser og sager, der holder pengene,
-- frasorteres allerede i kandidat-forespoergslen, og hver raekke koerer i sin
-- egen undertransaktion.
create or replace function public.handel_auto_frigiv()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k      record;
  b      record;
  t      record;
  v_grund text;
  v_ud   jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null
       and not coalesce(tr.sag_aaben, false)
       -- Frasorteres her, saa de ikke fylder de 200 pladser hver gang.
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not exists (
         select 1 from public.sager s
          where s.trade_id = tr.id
            and (s.status in ('aaben', 'afventer_retur')
                 or (s.penge_handling is not null and s.afviklet_kl is null)))
       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')
            or (tr.status = 'pakke_sendt'
                and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'))
     order by tr.id
     limit 200
  loop
    -- Hver raekke i sin egen undertransaktion: een fejl (fx en constraint)
    -- ruller kun den raekke tilbage og stopper ikke resten af batchen.
    begin
      -- Laaseraekkefoelge: betaling, handel. Alt tjekkes igen under laas.
      select * into b from public.betalinger where id = k.betaling_id for update;
      select * into t from public.trades where id = k.trade_id for update;

      if b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or coalesce(t.sag_aaben, false)
         or public.sag_holder_pengene(t.id) then
        continue;
      end if;

      if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then
        v_grund := '48_timer';
      elsif t.status = 'pakke_sendt'
            and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '14 days' then
        v_grund := '14_dage';
      else
        continue;
      end if;

      update public.trades
         set status = 'leveret', received_at = coalesce(received_at, now())
       where id = t.id and status = t.status;
      if not found then continue; end if;

      update public.betalinger
         set frigivet_kl = now(), opdateret = now()
       where id = b.id and frigivet_kl is null;

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id, 'grund', v_grund));
    exception when others then
      raise warning 'handel_auto_frigiv: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.handel_auto_frigiv() from public, anon, authenticated;
grant execute on function public.handel_auto_frigiv() to service_role;

-- charge.refunded (fuld refusion, eller sagens delvise refusion gennemfoert).
-- Som 20261001020000, men en sag, der stadig holder pengene, afsluttes
-- automatisk: en aaben sag lukkes ("Afsluttet ved refusion"), og en planlagt
-- afgoerelse markeres som afviklet - pengene er jo allerede refunderet. Saa
-- efterlades sagen aldrig aaben, og handlen kan annulleres (frys-triggeren
-- tillader annullering).
-- Som 20261003010000, men en handel i 'leveret' annulleres ogsaa (pengene er
-- refunderet til koeberen; er de ogsaa overfoert, markeres betalingen til
-- admin som foer).
create or replace function public.betaling_registrer_refunderet(
  p_payment_intent text,
  p_refund         text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  s record;
begin
  update public.betaling_afvigelser
     set refunderet_kl = coalesce(refunderet_kl, now()),
         stripe_refund_id = coalesce(p_refund, stripe_refund_id),
         sidste_fejl = null,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
  if found then return 'afvigelse_refunderet'; end if;

  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  update public.betalinger
     set status = 'refunderet',
         refunderet_kl = now(),
         stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'stripe'),
         kraever_opmaerksomhed = kraever_opmaerksomhed
                                 or stripe_transfer_id is not null
                                 or overfoersel_paabegyndt_kl is not null,
         sidste_fejl = case
           when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null
             then 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe'
           else sidste_fejl end,
         opdateret = now()
   where id = b.id;

  -- Sager, der stadig holder pengene (laases efter betaling og handel).
  perform 1 from public.trades where id = b.trade_id for update;
  for s in
    select * from public.sager
     where trade_id = b.trade_id
       and (status in ('aaben', 'afventer_retur')
            or (penge_handling is not null and afviklet_kl is null))
     for update
  loop
    if s.status in ('aaben', 'afventer_retur') then
      update public.sager
         set status = 'lukket',
             afgjort_af = public.bidhamr_system_id(),
             afgjort_kl = now(),
             begrundelse = 'Afsluttet ved refusion',
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = null, penge_flyttes_efter_kl = null,
             afviklet_kl = now(), penge_fejl = null,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Afsluttet automatisk: betalingen er refunderet hos Stripe.', 4000)
       where id = s.id;
    else
      update public.sager
         set afviklet_kl = now(),
             penge_fejl = case when penge_handling = 'refunder' then null
                               else 'refunderet_hos_stripe' end,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Betalingen er refunderet hos Stripe, før ankefristen var udløbet.', 4000)
       where id = s.id;
    end if;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'sag_lukket', 'sag', s.id, b.buyer_id,
            'Afsluttet ved refusion - betalingen er refunderet hos Stripe');
  end loop;

  if coalesce(b.refusion_aarsag, '') <> 'beloeb_afviger' then
    update public.trades
       set status = 'annulleret', sag_aaben = false
     where id = b.trade_id
       and status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget','leveret');
  end if;

  return 'refunderet';
end;
$fn$;

revoke all on function public.betaling_registrer_refunderet(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_refunderet(text, text) to service_role;

-- ============================================================ M-A refusion fejlet

-- En refusion, der var registreret som gennemfoert (status 'refunderet'), er
-- bagefter fejlet eller annulleret hos Stripe (refund.failed/canceled - fx
-- koeberens kort er lukket). Pengene er altsaa IKKE kommet tilbage.
-- Betalingen saettes tilbage til 'betalt' med refusionen stadig claimet:
--   - refusion_anmodet_kl, refusion_aarsag og refusion_oere beholdes, saa
--     ingen frigivelse/overfoersel kan ske (alle pengeveje kraever, at
--     refusion_anmodet_kl er tom), og samme beloeb refunderes igen.
--   - stripe_refund_id nulstilles og refusion_forsoeg taelles op, saa naeste
--     forsoeg (refunderBetaling) faar en ny idempotency key og ikke blot faar
--     den fejlede refusion tilbage fra Stripe.
--   - kraever_opmaerksomhed + sidste_fejl (uden beloeb - vises for staff).
-- Sagsrefusioner (refusion_aarsag 'sag') proeves igen af cron
-- (refunderSagerVentende); andre ses af admin under betalinger.
-- Handlen forbliver annulleret, og en afviklet sag forbliver afviklet - pengene
-- skal stadig tilbage til koeberen, og trades.sag_aaben er allerede fjernet.
-- Kun naar refusionen er vores: stripe_refund_id er tom eller er p_refund (en
-- gammel, allerede erstattet refusion ignoreres). Serveren tjekker desuden hos
-- Stripe, at chargen ikke stadig er refunderet.
-- Laaseraekkefoelge: betaling, handel. Idempotent (where status = 'refunderet').
-- Returnerer 'genaabnet' | 'ikke_refunderet' | 'erstattet' | 'ukendt'.
create or replace function public.betaling_refusion_fejlet(
  p_betaling uuid,
  p_refund   text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  b record;
begin
  if p_betaling is null or nullif(btrim(coalesce(p_refund, '')), '') is null then
    return 'ukendt';
  end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return 'ukendt'; end if;
  if b.status <> 'refunderet' then return 'ikke_refunderet'; end if;
  if b.stripe_refund_id is not null and b.stripe_refund_id <> p_refund then
    return 'erstattet';
  end if;

  perform 1 from public.trades where id = b.trade_id for update;

  update public.betalinger
     set status = 'betalt',
         refunderet_kl = null,
         stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         kraever_opmaerksomhed = true,
         sidste_fejl = 'Refusion fejlede hos Stripe – prøves igen',
         opdateret = now()
   where id = b.id
     and status = 'refunderet';
  if not found then return 'ikke_refunderet'; end if;

  return 'genaabnet';
end;
$fn$;

revoke all on function public.betaling_refusion_fejlet(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_refusion_fejlet(uuid, text) to service_role;
