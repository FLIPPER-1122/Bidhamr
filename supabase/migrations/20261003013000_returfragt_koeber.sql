-- Returfragt: koeberen betaler selv (beslutning fra Filip, 3. oktober 2026).
--
-- Naar koeberen faar medhold i en sag om skadet / ikke som beskrevet og skal
-- sende varen retur, betaler KOEBEREN selv returfragten. Den refunderes ikke.
-- Hidtil stod der, at BidHamr betalte.
--
--   1. sager_returfragt_check tillader nu 'koeber'. 'bidhamr' beholdes, saa
--      eksisterende raekker (afgjort foer denne aendring) stadig er gyldige.
--      Eksisterende raekker aendres ikke - det var det, der blev lovet parterne.
--   2. sag_afgoer saetter returfragt_betaler = 'koeber' (begge steder, hvor
--      den foer satte 'bidhamr', ogsaa ved genaabning efter afleveret retur),
--      og logteksten siger "koeberen betaler selv returfragten".
--      Funktionen er ellers en praecis kopi af 20261003011000_sager_rettelser.sql.
--      Ingen andre funktioner saetter returfragt_betaler til andet end null.
--
-- Idempotent: drop constraint if exists + add / create or replace.

-- ============================================================ Constraint

alter table public.sager drop constraint if exists sager_returfragt_check;
alter table public.sager add constraint sager_returfragt_check check (
  returfragt_betaler is null or returfragt_betaler in ('koeber', 'bidhamr'));

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
--   'afvent_retur'        - koeberen skal sende varen retur (koeberen betaler selv
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
-- Som 20261003011000, men koeberen betaler selv returfragten.
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
                                       then 'koeber' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'koeber',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (køberen betaler selv returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
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
