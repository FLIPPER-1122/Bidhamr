-- Advarselssystem: rettelser efter review af 20261003050000_indpakning_advarsel.sql.
--
--   1. "Giv advarsel" fra brugersiden i admin indsatte direkte i
--      public.advarsler fra serverkoden uden tjek af inhabilitet eller
--      sig selv. Indsaettelsen sker nu i admin_advar_bruger (security
--      definer, kun service_role; serveren sender medarbejderens id fra
--      assertRole). Den tjekker rolle (medarbejder+), sig selv,
--      systembrugeren, staff-konti, inhabilitet og teksterne, og logger i
--      moderation_log som foer.
--      Inhabilitet: findes der en handel overhovedet mellem medarbejderen
--      og brugeren (begge retninger), er medarbejderen inhabil. Det er
--      bredere end bruger_luk_konto_permanent (sag paa en handel mellem dem)
--      og daekker den.
--   2. indpakning_vurder: ogsaa inhabil, hvis der findes en sag paa en
--      ANDEN handel mellem medarbejderen og saelgeren (samme exists-tjek som
--      konto_lukning_afvis). Ellers kopieret praecist fra 20261003050000.
--   3. konto_lukning_godkend: brugerraekken laases (for update) FOER
--      forslaget, saa laaserækkefoelgen er den samme som i triggeren
--      advarsler_tre_foreslaa_lukning (bruger -> forslag), og de to ikke kan
--      deadlocke. Ellers kopieret praecist fra 20261003050000.
--
-- Idempotent: kun create or replace + revoke/grant. Ingen data aendres.

-- ============================================================ 1. admin_advar_bruger

-- Medarbejder+ giver en advarsel fra brugersiden i admin.
-- Returnerer {"kode": "ok", "id", "advarsler_antal", "lukning_foreslaaet"}
-- eller fejlkoder: ingen_adgang, begrundelse_bruger_mangler,
-- begrundelse_bruger_for_lang, begrundelse_for_lang, ugyldig_bruger,
-- sig_selv, staff, inhabil, allerede_givet (dobbeltklik: samme medarbejder
-- gav samme advarsel til samme bruger inden for 30 sekunder).
-- 3-reglen (forslag til staff) koerer i triggeren
-- advarsler_tre_foreslaa_lukning.
create or replace function public.admin_advar_bruger(
  p_medarbejder        uuid,
  p_bruger             uuid,
  p_begrundelse_bruger text,
  p_intern_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  v_note   text := nullif(btrim(coalesce(p_intern_note, '')), '');
  u        record;
  v_id     uuid;
  v_antal  integer;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(v_bruger) > 1000 then
    return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;

  -- Laas brugeren i samme tilstand som triggeren advarsler_tre_foreslaa_lukning
  -- (for no key update), saa samtidige advarsler serialiseres, og
  -- dobbeltklik-tjekket nedenfor ser den foerste.
  select id, rolle into u from public.users where id = p_bruger for no key update;
  if not found then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  -- Staff-konti advares ikke fra brugersiden (som bruger_luk_konto_permanent).
  if u.rolle in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'staff');
  end if;
  -- Inhabil: medarbejderen har handlet med brugeren (begge retninger).
  if exists (
    select 1 from public.trades t
     where (t.buyer_id = p_medarbejder and t.seller_id = p_bruger)
        or (t.seller_id = p_medarbejder and t.buyer_id = p_bruger)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- Dobbeltklik: samme advarsel fra samme medarbejder lige foer.
  if exists (
    select 1 from public.advarsler
     where bruger_id = p_bruger
       and oprettet_af = p_medarbejder
       and begrundelse_bruger = v_bruger
       and oprettet_kl > now() - interval '30 seconds') then
    return jsonb_build_object('kode', 'allerede_givet');
  end if;

  insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger)
  values (p_bruger, p_medarbejder, v_note, v_bruger)
  returning id into v_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'bruger', p_bruger, p_bruger,
          left(coalesce(v_note || ' | ', '') || 'Til brugeren: ' || v_bruger, 4000));

  select count(*) into v_antal from public.advarsler where bruger_id = p_bruger;

  return jsonb_build_object(
    'kode', 'ok', 'id', v_id,
    'advarsler_antal', v_antal,
    'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag
                                   where bruger_id = p_bruger and status = 'afventer'));
end;
$fn$;

revoke all on function public.admin_advar_bruger(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_advar_bruger(uuid, uuid, text, text) to service_role;

-- ============================================================ 2. indpakning_vurder

-- Som 20261003050000, men ogsaa inhabil ved en sag paa en anden handel
-- mellem medarbejderen og saelgeren.

-- Staff (medarbejder+) vurderer, at saelgeren har pakket daarligt i en sag.
-- Saelgeren findes via sagens handel.
--   Ingen tidligere indpaknings-paamindelse -> paamindelse (taeller ikke).
--   Ellers                                   -> advarsel (taeller med; 3-reglen
--                                               giver et forslag til staff via triggeren).
-- Een vurdering pr. sag: en ny vurdering paa samme sag afvises med
-- 'allerede_vurderet' (og hvad der skete foerste gang).
--
-- Returnerer {"kode": "ok", "resultat": "paamindelse"|"advarsel", "id",
-- "saelger_id", "trade_id", "advarsler_antal", "lukning_foreslaaet"} eller
-- fejlkoder: ingen_adgang, begrundelse_bruger_mangler,
-- begrundelse_bruger_for_lang, for_lang_tekst, ikke_fundet, inhabil,
-- afhentning, allerede_vurderet (+ "resultat").
create or replace function public.indpakning_vurder(
  p_medarbejder        uuid,
  p_sag                uuid,
  p_begrundelse_bruger text,
  p_intern_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger  text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  v_note    text := nullif(btrim(coalesce(p_intern_note, '')), '');
  s         record;
  t         record;
  v_id      uuid;
  v_antal   integer;
  v_forslag boolean;
  standard  constant text := 'Dårlig indpakning';
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(v_bruger) > 1000 then
    return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  -- Laas sagen: samtidige vurderinger af samme sag serialiseres.
  select id, trade_id into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select id, buyer_id, seller_id, afhentning into t
    from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  -- Ingen maa behandle en sag, hvor han selv er koeber eller saelger.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- Heller ikke, hvis der findes en sag paa en anden handel mellem
  -- medarbejderen og saelgeren (som konto_lukning_afvis).
  if exists (
    select 1 from public.sager s2 join public.trades t2 on t2.id = s2.trade_id
     where (t2.buyer_id = p_medarbejder and t2.seller_id = t.seller_id)
        or (t2.seller_id = p_medarbejder and t2.buyer_id = t.seller_id)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- Ved afhentning er der ingen indpakning at vurdere.
  if coalesce(t.afhentning, false) then
    return jsonb_build_object('kode', 'afhentning');
  end if;
  if t.seller_id = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Idempotent: een vurdering pr. sag.
  if exists (select 1 from public.paamindelser where sag_id = s.id) then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'paamindelse');
  end if;
  if exists (select 1 from public.advarsler
              where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'advarsel');
  end if;

  -- Laas saelgeren: samtidige vurderinger paa FORSKELLIGE sager med samme
  -- saelger maa ikke begge give "foerste gang" (paamindelse).
  perform 1 from public.users where id = t.seller_id for no key update;

  if not exists (select 1 from public.paamindelser
                  where bruger_id = t.seller_id and grund = 'daarlig_indpakning') then
    insert into public.paamindelser (
      bruger_id, grund, sag_id, trade_id, begrundelse_bruger, intern_note, oprettet_af)
    values (
      t.seller_id, 'daarlig_indpakning', s.id, t.id, v_bruger, v_note, p_medarbejder)
    returning id into v_id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'indpakning_paamindelse', 'sag', s.id, t.seller_id,
            left('Påmindelse: dårlig indpakning' || coalesce(' | ' || v_note, '')
                 || ' | Til sælgeren: ' || v_bruger, 4000));

    select count(*) into v_antal from public.advarsler where bruger_id = t.seller_id;
    return jsonb_build_object(
      'kode', 'ok', 'resultat', 'paamindelse', 'id', v_id,
      'saelger_id', t.seller_id, 'trade_id', t.id,
      'advarsler_antal', v_antal,
      'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag
                                     where bruger_id = t.seller_id and status = 'afventer'));
  end if;

  -- Advarsel. 3-reglen (forslag til staff) koerer i triggeren
  -- advarsler_tre_foreslaa_lukning. Kontoen lukkes ALDRIG her.
  insert into public.advarsler (
    bruger_id, oprettet_af, aarsag, begrundelse_bruger, grund, sag_id, trade_id)
  values (
    t.seller_id, p_medarbejder, coalesce(v_note, standard), v_bruger,
    'daarlig_indpakning', s.id, t.id)
  returning id into v_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'sag', s.id, t.seller_id,
          left('Advarsel: dårlig indpakning' || coalesce(' | ' || v_note, '')
               || ' | Til sælgeren: ' || v_bruger, 4000));

  select count(*) into v_antal from public.advarsler where bruger_id = t.seller_id;
  v_forslag := exists (select 1 from public.konto_lukning_forslag
                        where bruger_id = t.seller_id and status = 'afventer');

  return jsonb_build_object(
    'kode', 'ok', 'resultat', 'advarsel', 'id', v_id,
    'saelger_id', t.seller_id, 'trade_id', t.id,
    'advarsler_antal', v_antal,
    'lukning_foreslaaet', v_forslag);
end;
$fn$;

revoke all on function public.indpakning_vurder(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.indpakning_vurder(uuid, uuid, text, text) to service_role;

-- ============================================================ 3. konto_lukning_godkend

-- Som 20261003050000, men brugeren laases foer forslaget.
-- Admin/chef godkender: kontoen lukkes via den eksisterende
-- bruger_luk_konto_permanent (rolle admin+, sig_selv, staff, inhabil gaelder
-- uaendret). Brugeren ser aarsagen '3 advarsler' ved login; p_note er intern.
-- Koder: ok, ingen_adgang, ikke_fundet, behandlet, for_lang_tekst,
-- bortfaldet (kontoen var allerede lukket - forslaget markeres bortfaldet),
-- + alle koder fra bruger_luk_konto_permanent (sig_selv, staff, inhabil, ...).
create or replace function public.konto_lukning_godkend(
  p_medarbejder uuid,
  p_forslag     uuid,
  p_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f      record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  r      jsonb;
  v_bruger uuid;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  -- Laas brugeren FOER forslaget (samme raekkefoelge som triggeren
  -- advarsler_tre_foreslaa_lukning: bruger -> forslag). bruger_id paa et
  -- forslag kan ikke aendres (konto_lukning_forslag_beskyt).
  select bruger_id into v_bruger from public.konto_lukning_forslag where id = p_forslag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform 1 from public.users where id = v_bruger for update;

  select * into f from public.konto_lukning_forslag where id = p_forslag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', f.status);
  end if;

  r := public.bruger_luk_konto_permanent(p_medarbejder, f.bruger_id, '3 advarsler', null);

  if r->>'kode' = 'allerede_lukket' then
    update public.konto_lukning_forslag
       set status = 'bortfaldet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           begrundelse = coalesce(v_note, 'Kontoen var allerede lukket.'), opdateret_kl = now()
     where id = f.id and status = 'afventer';
    return jsonb_build_object('kode', 'bortfaldet', 'bruger_id', f.bruger_id);
  end if;
  if r->>'kode' <> 'ok' then
    return r;
  end if;

  update public.konto_lukning_forslag
     set status = 'godkendt', behandlet_af = p_medarbejder, behandlet_kl = now(),
         begrundelse = v_note, opdateret_kl = now()
   where id = f.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'bruger_id', f.bruger_id, 'forslag_id', f.id);
end;
$fn$;

revoke all on function public.konto_lukning_godkend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.konto_lukning_godkend(uuid, uuid, text) to service_role;
