-- Rettelser til 20261004051000_anke_rettelser.sql efter review (runde 2).
--
-- 1. (K1) sag_afgoer faar parameteren p_retur_ikke_sendt boolean default
--    false. Naar sagen staar i 'afventer_retur', og udfaldet er 'saelger'
--    (pengene frigives til saelger) eller 'lukket' (frysningen fjernes), skal
--    medarbejderen bekraefte, at koeberen ikke har sendt varen retur (heller
--    ikke undervejs) - ellers ville saelgeren kunne faa baade varen og
--    pengene. Uden bekraeftelse: kode 'bekraeft_retur_ikke_sendt'. Gaelder
--    ALLE sager i 'afventer_retur' (med og uden anke). Bekraeftelsen logges i
--    moderation_log-teksten. Den gamle signatur (uuid, uuid, text, text,
--    text) droppes, saa der kun er een funktion (kun service_role).
--
-- 2. (M1) sag_retur_afleveret afviser med kode 'ankefrist_loeber' (+
--    'ankefrist_kl'), saa laenge ankefristen loeber (now() < afgjort_kl +
--    4 dage), og der ikke findes en anke (afgjort eller ej). Ellers kunne
--    staff registrere returen inden for fristen, og saelgerens ret til at
--    anke ville forsvinde (sag_anke_kan: 'retur_afleveret'). Findes der en
--    afgjort anke (stadfaestet), maa retur registreres som foer. En ventende
--    anke giver stadig 'anke_afventer'.
--
-- Genskrevet (praecise kopier af seneste definition + rettelserne ovenfor):
--   sag_afgoer          (seneste: 20261004051000)
--   sag_retur_afleveret (seneste: 20261004050000)
-- moderation_log_handling_check roeres ikke.
-- Koeres EFTER 20261004051000_anke_rettelser.sql.
-- Idempotent: drop ... if exists / create or replace. Ingen data aendres.

-- ============================================================ Staff: afgoer (retur-bekraeftelse)

drop function if exists public.sag_afgoer(uuid, uuid, text, text, text);

-- Som 20261004051000, men med p_retur_ikke_sendt (se punkt 1 ovenfor).
create or replace function public.sag_afgoer(
  p_medarbejder      uuid,
  p_sag              uuid,
  p_udfald           text,
  p_begrundelse      text,
  p_intern_note      text,
  p_retur_ikke_sendt boolean default false)
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
  -- Sagen har en afgjort anke (afgoerelsen paa anken er endelig).
  ak         record;
  v_anket    boolean := false;
  v_res      jsonb;
  -- NYT: tekst til moderation_log, naar medarbejderen har bekraeftet, at
  -- koeberen ikke har sendt varen retur.
  v_retur_tjek text := '';
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

  -- En anke venter: den skal afgoeres foerst.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

  -- Anken er afgjort, og afgoerelsen er endelig. Kun hvis sagen venter
  -- paa en retur, der ikke kommer (fx koeberen sender aldrig varen), maa en
  -- admin/chef afgoere den igen (til saelger eller lukke den - se
  -- statustjekket nedenfor) - og kun en anden end dem, der afgjorde sagen og
  -- anken. Der er ingen ny ankefrist: pengene flyttes straks.
  select * into ak from public.sag_anker where sag_id = s.id;
  if found then
    if s.status <> 'afventer_retur' then
      return jsonb_build_object('kode', 'anket');
    end if;
    if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
      return jsonb_build_object('kode', 'anke_endelig');
    end if;
    if p_medarbejder = ak.ankede_afgjort_af
       or p_medarbejder = ak.behandlet_af
       or p_medarbejder = s.afgjort_af then
      return jsonb_build_object('kode', 'samme_medarbejder');
    end if;
    v_anket := true;
    v_frist := now();
  end if;

  if s.status = 'aaben' then
    null;
  elsif s.status = 'afventer_retur' and p_udfald in ('saelger', 'lukket') then
    -- Fx koeberen sender aldrig varen retur.
    -- NYT: medarbejderen skal bekraefte, at koeberen ikke har sendt varen
    -- retur (heller ikke undervejs) - ellers kunne saelgeren faa baade varen
    -- og pengene (eller handlen fortsaette, mens varen er paa vej tilbage).
    if not coalesce(p_retur_ikke_sendt, false) then
      return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
    end if;
    v_retur_tjek := ' | Bekræftet af medarbejderen: køberen har ikke sendt varen retur (heller ikke undervejs)';
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
    v_log := case when v_anket
                  then 'Medhold til sælger efter anke - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - pengene frigives nu'
                  else 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage' end
             || coalesce(' (OBS: frigivelsen er blokeret lige nu: ' || v_advarsel || ')', '')
             || v_retur_tjek;

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
            left(case when v_anket
                      then 'Sag lukket efter anke uden at flytte penge - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - frysningen fjernes nu'
                      else 'Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage' end
                 || v_retur_tjek
                 || ' | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  -- Anket sag - ingen ny ankefrist, saa afgoerelsen gennemfoeres straks.
  -- Serveren kalder Stripe (udfoerSagAfvikling), naar afvikling.kode = 'ok';
  -- ellers proever cron igen (sag_afvikl_forfaldne).
  if v_anket then
    v_res := public.sag_afvikl(s.id);
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'penge_flyttes_efter_kl', v_frist,
    'endelig', v_anket, 'afvikling', v_res,
    'advarsel', v_advarsel, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text, boolean) to service_role;

-- ============================================================ Staff: retur afleveret (ankefrist)

-- Som 20261004050000, men afviser med 'ankefrist_loeber' (+ 'ankefrist_kl'),
-- saa laenge ankefristen loeber, og der ikke findes en anke. Ellers uaendret.
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

  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

  if s.status <> 'afventer_retur' or s.penge_handling is distinct from 'refunder' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  -- NYT: saelgeren kan anke indtil afgjort_kl + 4 dage (sag_anke_kan), men
  -- ikke naar returen er registreret. Saa laenge fristen loeber, og der ikke
  -- er anket, maa returen ikke registreres. Er anken afgjort (stadfaestet),
  -- er afgoerelsen endelig, og returen kan registreres som foer.
  if s.afgjort_kl is not null
     and now() < s.afgjort_kl + interval '4 days'
     and not exists (select 1 from public.sag_anker a where a.sag_id = s.id) then
    return jsonb_build_object('kode', 'ankefrist_loeber',
                              'ankefrist_kl', s.afgjort_kl + interval '4 days');
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
