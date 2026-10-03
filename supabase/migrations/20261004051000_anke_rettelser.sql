-- Rettelser til 20261004050000_anke.sql efter review.
--
-- 1. Ankeafgoerelsen er endelig (sag_afgoer). Naar sagen har en AFGJORT
--    anke, kan den kun afgoeres igen, hvis den staar i 'afventer_retur' (fx
--    koeberen sender aldrig returen), og kun af en admin/chef, som hverken
--    afgjorde sagen oprindeligt (sag_anker.ankede_afgjort_af) eller behandlede
--    anken (sag_anker.behandlet_af). Nye fejlkoder:
--      anket             - sagen er anket og staar ikke i 'afventer_retur'
--      anke_endelig      - kun admin/chef kan aendre en anket sag
--      samme_medarbejder - (findes) afgjorde sagen eller behandlede anken
--    Der er ingen ny ankefrist (een anke pr. sag): penge_flyttes_efter_kl =
--    nu, og sagen afvikles straks (sag_afvikl) som i sag_anke_afgoer. Svaret
--    faar "endelig": true og "afvikling" (svaret fra sag_afvikl).
--    Logges med de eksisterende handlinger ('sag_afgjort_saelger' /
--    'sag_lukket') og en tekst, der siger, at sagen er anket.
--
-- 2. sag_anke_afgoer faar parameteren p_retur_ikke_sendt boolean default
--    false. Ved 'omgoer', naar sagen staar i 'afventer_retur' (saelgeren har
--    anket et medhold til koeberen med retur), skal den vaere true - ellers
--    'bekraeft_retur_ikke_sendt'. Bekraeftelsen logges i moderation_log.
--    Den gamle signatur (uuid, uuid, text, text, text) droppes, saa der kun
--    er een funktion. Kald uden p_retur_ikke_sendt virker som foer.
--
-- Genskrevet (praecise kopier af seneste definition i 20261004050000 +
-- rettelserne ovenfor): sag_anke_afgoer, sag_afgoer.
-- moderation_log_handling_check roeres ikke.
-- Koeres EFTER 20261004050000_anke.sql.
-- Idempotent: drop ... if exists / create or replace. Ingen data aendres.

-- ============================================================ Staff: afgoer anke

drop function if exists public.sag_anke_afgoer(uuid, uuid, text, text, text);

-- Admin/chef afgoer en anke. p_udfald: 'stadfaest' | 'omgoer'.
--   stadfaest - afgoerelsen staar. penge_flyttes_efter_kl = nu, og sagen
--               afvikles straks (sag_afvikl). Venter sagen paa retur, sker
--               refusionen, saa snart returpakken er registreret.
--   omgoer    - modsat udfald, afgjort af behandleren (sager.afgjort_af/kl/
--               begrundelse = ankens afgoerelse; den oprindelige afgoerelse er
--               gemt i sag_anker.ankede_*). Pengene flyttes straks - ingen ny
--               ankefrist:
--                 saelgeren ankede -> medhold til saelger (frigivelse)
--                 koeberen ankede  -> medhold til koeber: svindel/bortkommet
--                     refunderes straks; skadet/ikke som beskrevet -> varen
--                     sendes retur (koeberen betaler selv returfragten), og
--                     refusionen sker, saa snart returpakken er registreret.
-- Afgoerelsen er endelig (sag_anker_beskyt).
-- Returnerer {"kode": "ok", "udfald", "handling", "afvikling"?, "anke_id",
-- "part", "sag_id", "trade_id", "buyer_id", "seller_id", "auction_id",
-- "type", "version"} hvor handling er:
--   'refunder' | 'frigiv'  - sag_afvikl gennemfoerte (afvikling.kode = 'ok');
--                            serveren kalder Stripe (udfoerSagAfvikling)
--   'afvent_retur'         - venter paa returpakken
--   'blokeret'             - afvikling.grund (fx indsigelse); cron proever igen
--   'allerede_afviklet'    - pengene var allerede flyttet (fx refunderet hos
--                            Stripe imens) - kun ved stadfaest
-- Fejlkoder: ingen_adgang (kun admin/chef), ugyldigt_udfald,
-- begrundelse_mangler, for_lang_tekst, ikke_fundet, behandlet, inhabil,
-- samme_medarbejder, penge_flyttet, retur_afleveret, indsigelse, ikke_mulig,
-- bekraeft_retur_ikke_sendt.
-- NYT (20261004051000): p_retur_ikke_sendt. Omgoeres en afgoerelse, mens
-- sagen staar i 'afventer_retur' (saelgeren ankede et medhold til koeberen
-- med retur), skal behandleren bekraefte, at koeberen ikke har sendt varen
-- retur - ellers ville saelgeren kunne faa baade varen og pengene.
create or replace function public.sag_anke_afgoer(
  p_medarbejder      uuid,
  p_anke             uuid,
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
  v_sag      uuid;
  v_trade    uuid;
  a          record;
  s          record;
  t          record;
  b          record;
  v_res      jsonb;
  v_handling text;
  v_hvem     text;
  v_log      text;
  v_retur    boolean := false;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('stadfaest', 'omgoer') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select sag_id, trade_id into v_sag, v_trade from public.sag_anker where id = p_anke;
  if v_sag is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag, anke.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = v_sag for update;
  select * into a from public.sag_anker where id = p_anke for update;

  if a.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;
  -- Ingen maa behandle en anke, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- En anden end den, der afgjorde sagen.
  if p_medarbejder = a.ankede_afgjort_af or p_medarbejder = s.afgjort_af then
    return jsonb_build_object('kode', 'samme_medarbejder');
  end if;

  v_hvem := case a.part when 'koeber' then 'køberens' else 'sælgerens' end;

  if p_udfald = 'stadfaest' then
    update public.sag_anker
       set status = 'stadfaestet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_stadfaestet', 'sag', s.id, a.indgivet_af,
            left('Anken (' || v_hvem || ') er afvist - afgørelsen står og er endelig. Pengene flyttes nu'
                 || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if s.afviklet_kl is not null or s.penge_handling is null then
      v_handling := 'allerede_afviklet';
    else
      update public.sager set penge_flyttes_efter_kl = now() where id = s.id;
      if s.status = 'afventer_retur' then
        v_handling := 'afvent_retur';
      else
        v_res := public.sag_afvikl(s.id);
        v_handling := case v_res->>'kode' when 'ok' then s.penge_handling else 'blokeret' end;
      end if;
    end if;

  else
    -- Omgoer: kun hvis pengene ikke er flyttet.
    if s.afviklet_kl is not null
       or b.id is null
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null
       or b.status <> 'betalt' then
      return jsonb_build_object('kode', 'penge_flyttet');
    end if;

    if a.part = 'saelger' then
      -- Saelgeren faar medhold. Har han allerede faaet varen retur, ville han
      -- faa baade varen og pengene.
      if s.retur_afleveret_kl is not null then
        return jsonb_build_object('kode', 'retur_afleveret');
      end if;
      -- NYT: venter sagen paa retur, kan koeberen have sendt varen (pakken
      -- er bare ikke registreret endnu). Behandleren skal bekraefte, at den
      -- ikke er sendt.
      if s.status = 'afventer_retur' and not coalesce(p_retur_ikke_sendt, false) then
        return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
      end if;
      update public.sager
         set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund,
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = 'frigiv', penge_flyttes_efter_kl = now(),
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_log := 'Anken (sælgerens) er godkendt - afgørelsen er ændret til medhold til sælger og er endelig. Pengene frigives til sælger nu'
               || case when s.status = 'afventer_retur'
                       then ' | Bekræftet af behandleren: køberen har ikke sendt varen retur' else '' end;
    else
      -- Koeberen faar medhold. Samme forhaandstjek som sag_afgoer.
      if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
        return jsonb_build_object('kode', 'indsigelse');
      end if;
      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager
           set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = (s.retur_afleveret_kl is not null),
               returfragt_betaler = case when s.retur_afleveret_kl is not null then 'koeber' end,
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion (alt undtagen BidHamr Beskyttelse) nu';
      else
        v_retur := true;
        update public.sager
           set status = 'afventer_retur', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = true, returfragt_betaler = 'koeber',
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur (køberen betaler selv returfragten); refusion, så snart returpakken er registreret';
      end if;
    end if;

    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_omgjort', 'sag', s.id, a.indgivet_af,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if v_retur then
      v_handling := 'afvent_retur';
    else
      v_res := public.sag_afvikl(s.id);
      v_handling := case v_res->>'kode'
                      when 'ok' then case a.part when 'saelger' then 'frigiv' else 'refunder' end
                      else 'blokeret' end;
    end if;
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'udfald', p_udfald, 'handling', v_handling, 'afvikling', v_res,
    'anke_id', a.id, 'part', a.part, 'sag_id', s.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean) to service_role;

-- ============================================================ Staff: afgoer (anke endelig)

-- Som 20261004050000, men en sag med en AFGJORT anke kan kun afgoeres igen,
-- naar den staar i 'afventer_retur' (til saelger eller lukket), af en
-- admin/chef, der hverken afgjorde sagen eller anken ('anket',
-- 'anke_endelig', 'samme_medarbejder'). Ingen ny ankefrist: sagen afvikles
-- straks, og svaret har "endelig": true og "afvikling". Ellers uaendret.

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
  -- NYT: sagen har en afgjort anke (afgoerelsen paa anken er endelig).
  ak         record;
  v_anket    boolean := false;
  v_res      jsonb;
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

  -- NYT: anken er afgjort, og afgoerelsen er endelig. Kun hvis sagen venter
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
    v_log := case when v_anket
                  then 'Medhold til sælger efter anke - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - pengene frigives nu'
                  else 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage' end
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
            left(case when v_anket
                      then 'Sag lukket efter anke uden at flytte penge - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - frysningen fjernes nu'
                      else 'Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage' end
                 || ' | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  -- NYT: anket sag - ingen ny ankefrist, saa afgoerelsen gennemfoeres straks.
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

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text) to service_role;
