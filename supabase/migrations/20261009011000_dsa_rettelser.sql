-- Rettelser til 20261009010000_dsa.sql efter review (6. oktober 2026).
--
-- KUN TIL TESTDATABASEN. 20261009010000_dsa.sql er ikke kørt i produktion
-- endnu og er rettet direkte, så den giver samme slutresultat. Køres
-- 010000 (rettet) og derefter denne, er denne en no-op (idempotent).
--
--   K1  dsa_anmeldelse_opret: intet dublettjek på e-mail for anmeldere uden
--       login (afslørede andres sager). Uden login svarer funktionen altid
--       neutralt 'ok' uden sagsnummer, også når indholdet ikke findes, og når
--       e-mailen tilhører den, der ejer indholdet (så oprettes INGEN sag -
--       ejeren kan ikke følge en "anmeldelse" af sig selv). Indloggede får
--       stadig deres egen sag ('findes' kun for deres egen konto).
--   V5  Separate lofter i databasen for anmeldere med og uden login; misbrug
--       af børn tæller ikke med i (og stoppes ikke af) det fælles loft.
--   V1  dsa_klage_afgoer: alle inhabilitetstjek (også bedoemmelse_er_inhabil
--       og den bedømte) FØR første skrivning, og en fejl undervejs ruller
--       alt tilbage (raise). Medhold, hvor auktionen ikke kan genåbnes
--       (udløbet), markerer ikke afgørelsen ophævet. Medhold i en gammel
--       suspension ophæver ikke en nyere.
--       Spørgsmål + svar: skjules et spørgsmål med svar, får både spørgeren
--       og sælgeren en begrundelse (dsa_indgreb returnerer
--       'ekstra_afgoerelser').
--   Trigger dsa_marker_ophaevet: en udløbet suspension, der ryddes, fjerner
--       ikke klageretten; "Vis igen" på en fjernet (annulleret + skjult)
--       auktion markerer afgørelsen ophævet; lukket konto markeres ophævet,
--       når konto_lukket_kl ryddes.
--   dsa_oprydning_koer: anonymiserer også klager_id på anmelder-klager,
--       svar_til_anmelder og klagesvar til anmeldere, og fjerner e-mail og
--       telefonnumre fra interne noter (dsa_rens_kontakt). Kører i sit eget
--       cron-job 'dsa_oprydning', så den kører, selvom oprydning_koer fejler.
--
-- V2 (gamle funktioner kaldt direkte fra appen): konto_lukning_godkend,
-- skjul_bedoemmelse, skjul_spoergsmaal og bruger_luk_konto_permanent kan kun
-- kaldes af service_role (tjekket i test og produktion 6. oktober 2026) -
-- Expo-appen kan ikke kalde dem. Som reserve sender notifikations-cron'en
-- igen "Din konto er lukket", hvis en godkendt kontolukning ikke har fået en
-- DSA-begrundelse (src/lib/notifikationer/cron.ts).

-- ============================================================ Hjælper

-- Fjerner e-mailadresser og telefonnumre fra fritekst (interne noter, der
-- bevares efter anonymiseringen).
create or replace function public.dsa_rens_kontakt(p_tekst text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_tekst is null then null else
    regexp_replace(
      regexp_replace(p_tekst, '[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+', '[e-mail fjernet]', 'g'),
      '(?<![\d-])(\+\d{2} ?)?\d{2}( ?\d{2}){3}(?![\d-])', '[nummer fjernet]', 'g')
  end;
$fn$;
revoke all on function public.dsa_rens_kontakt(text) from public, anon, authenticated;
grant execute on function public.dsa_rens_kontakt(text) to service_role;

-- ============================================================ K1 + V5: anmeld

create or replace function public.dsa_anmeldelse_opret(
  p_anmelder    uuid,
  p_type        text,
  p_id          uuid,
  p_placering   text,
  p_kategori    text,
  p_begrundelse text,
  p_navn        text,
  p_email       text,
  p_god_tro     boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_begr   text := btrim(coalesce(p_begrundelse, ''));
  v_navn   text := nullif(btrim(coalesce(p_navn, '')), '');
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_plac   text := btrim(coalesce(p_placering, ''));
  v_anonym boolean := p_anmelder is null;
  v_ejer   uuid;
  v_auk    uuid;
  v_frist  timestamptz;
  v_id     uuid;
  v_nr     text;
  n        integer;
  e        record;
begin
  if p_kategori is null or p_kategori not in
     ('forbudt_vare', 'falske_varer', 'svindel', 'ophavsret', 'personoplysninger',
      'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_type is null or p_type not in
     ('auktion', 'profil', 'spoergsmaal', 'spoergsmaal_svar', 'bedoemmelse', 'bedoemmelse_svar', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if char_length(v_begr) < 10 or char_length(v_begr) > 2000 then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_god_tro is not true then
    return jsonb_build_object('kode', 'god_tro');
  end if;
  if char_length(v_plac) < 1 or char_length(v_plac) > 500 then
    return jsonb_build_object('kode', 'ugyldig_placering');
  end if;
  if v_navn is not null and char_length(v_navn) > 100 then
    return jsonb_build_object('kode', 'navn_for_langt');
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;

  -- Indloggede: navn og e-mail fra kontoen (serveren sender dem med).
  if v_anonym and p_kategori <> 'misbrug_boern'
     and (v_navn is null or v_email is null) then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;
  if not v_anonym and not exists (select 1 from public.users u where u.id = p_anmelder) then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;

  if p_type <> 'andet' then
    select * into e from public.dsa_indhold_ejer(p_type, p_id) limit 1;
    if not found then
      -- Uden login afsløres det ikke, om indholdet findes.
      if v_anonym then return jsonb_build_object('kode', 'ok'); end if;
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    v_ejer := e.bruger_id;
    v_auk := e.auktion_id;
    if not v_anonym and v_ejer = p_anmelder then
      return jsonb_build_object('kode', 'sig_selv');
    end if;
    -- Uden login med ejerens egen e-mail: neutralt svar, ingen sag. Ejeren
    -- skal ikke kunne følge (eller klage over) en "anmeldelse" af sig selv.
    if v_anonym and v_email is not null
       and exists (select 1 from public.users u where u.id = v_ejer and lower(u.email) = v_email) then
      return jsonb_build_object('kode', 'ok');
    end if;
  end if;

  -- Dublet: KUN for indloggede (deres egen konto). Uden login kan en e-mail
  -- ikke bevise, hvem man er - et dublettjek ville afsløre andres sager.
  if not v_anonym then
    select a.id, a.sagsnummer into v_id, v_nr
      from public.dsa_anmeldelser a
     where a.status = 'ny'
       and a.indhold_type = p_type
       and a.indhold_id is not distinct from p_id
       and a.anmelder_id = p_anmelder
       and (p_type <> 'andet' or a.placering = v_plac)
     limit 1;
    if found then
      return jsonb_build_object('kode', 'findes', 'id', v_id, 'sagsnummer', v_nr);
    end if;
  end if;

  -- Grænser i databasen (serveren har også grænser pr. IP).
  if not v_anonym or v_email is not null then
    select count(*) into n from public.dsa_anmeldelser a
     where a.oprettet_kl > now() - interval '1 day'
       and ((not v_anonym and a.anmelder_id = p_anmelder)
            or (v_anonym and a.anmelder_id is null and a.anmelder_email = v_email));
    if n >= 20 then return jsonb_build_object('kode', 'for_mange'); end if;
  end if;
  -- Fælles loft, særskilt for med og uden login. Anmeldelser om misbrug af
  -- børn stoppes aldrig af det fælles loft (og tælles ikke med).
  if p_kategori <> 'misbrug_boern' then
    select count(*) into n from public.dsa_anmeldelser a
     where a.oprettet_kl > now() - interval '1 hour'
       and a.kategori <> 'misbrug_boern'
       and (a.anmelder_id is null) = v_anonym;
    if n >= (case when v_anonym then 500 else 1000 end) then
      return jsonb_build_object('kode', 'for_mange');
    end if;
  end if;

  -- Intern frist: 7 dage, men 24 timer ved misbrug af børn og hadefuld tale.
  v_frist := now() + case when p_kategori in ('misbrug_boern', 'hadefuld_tale')
                          then interval '24 hours' else interval '7 days' end;

  insert into public.dsa_anmeldelser
    (indhold_type, indhold_id, auktion_id, anmeldt_bruger_id, placering, kategori, begrundelse,
     anmelder_id, anmelder_navn, anmelder_email, god_tro, frist_kl)
  values
    (p_type, case when p_type = 'andet' then null else p_id end, v_auk, v_ejer, v_plac, p_kategori, v_begr,
     p_anmelder, v_navn, v_email, true, v_frist)
  returning id, sagsnummer into v_id, v_nr;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'sagsnummer', v_nr, 'frist_kl', v_frist);
end;
$fn$;
revoke all on function public.dsa_anmeldelse_opret(uuid, text, uuid, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.dsa_anmeldelse_opret(uuid, text, uuid, text, text, text, text, text, boolean)
  to service_role;

-- ============================================================ Indgreb (spørgsmål + svar)

create or replace function public.dsa_indgreb(
  p_medarbejder        uuid,
  p_type               text,
  p_id                 uuid,
  p_handling           text,
  p_regel              text,
  p_fakta              text,
  p_intern_note        text,
  p_anmeldelse         uuid,
  p_automatisk_opdaget boolean,
  p_ekstra             jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fakta   text := btrim(coalesce(p_fakta, ''));
  v_note    text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_ekstra  jsonb := coalesce(p_ekstra, '{}'::jsonb);
  v_regel   record;
  e         record;
  a         record;
  u         record;
  q         record;
  v_r       jsonb;
  v_foer    text;
  v_til     timestamptz;
  v_varig   text;
  v_grund   text;
  v_afg     uuid;
  v_nr      text;
  v_anm     uuid[];
  v_ekstra_afg uuid[] := '{}';
  v_x       uuid;
  v_svar    text := nullif(btrim(coalesce(v_ekstra->>'svar_til_anmelder', '')), '');
  v_auto    boolean := coalesce(p_automatisk_opdaget, false);
begin
  if p_handling is null or p_handling not in
     ('auktion_skjult', 'auktion_fjernet', 'auktion_annulleret', 'spoergsmaal_skjult',
      'bedoemmelse_skjult', 'bedoemmelse_svar_skjult', 'konto_suspenderet', 'konto_lukket') then
    return jsonb_build_object('kode', 'ugyldig_handling');
  end if;
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, public.dsa_min_rolle(p_handling)) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if not (
       (p_type = 'auktion' and p_handling in ('auktion_skjult', 'auktion_fjernet', 'auktion_annulleret'))
    or (p_type in ('spoergsmaal', 'spoergsmaal_svar') and p_handling = 'spoergsmaal_skjult')
    or (p_type = 'bedoemmelse' and p_handling = 'bedoemmelse_skjult')
    or (p_type = 'bedoemmelse_svar' and p_handling = 'bedoemmelse_svar_skjult')
    or (p_type = 'profil' and p_handling in ('konto_suspenderet', 'konto_lukket'))) then
    return jsonb_build_object('kode', 'ugyldig_handling');
  end if;

  select * into v_regel from public.dsa_regler() r where r.kode = p_regel;
  if not found then return jsonb_build_object('kode', 'ugyldig_regel'); end if;
  if v_fakta = '' then return jsonb_build_object('kode', 'fakta_mangler'); end if;
  if char_length(v_fakta) > 2000 or (v_note is not null and char_length(v_note) > 2000)
     or (v_svar is not null and char_length(v_svar) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into e from public.dsa_indhold_ejer(p_type, p_id) limit 1;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.dsa_er_inhabil(p_medarbejder, e.bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- Spørgsmål og svar skjules sammen: den anden part skal også have en
  -- begrundelse, og staff må heller ikke være inhabil over for den.
  if p_type in ('spoergsmaal', 'spoergsmaal_svar') then
    select x.asker_id, x.answer, x.auction_id, x.question, au.bruger_id as saelger_id into q
      from public.auction_questions x join public.auctions au on au.id = x.auction_id
     where x.id = p_id;
    if public.dsa_er_inhabil(p_medarbejder, q.asker_id) or public.dsa_er_inhabil(p_medarbejder, q.saelger_id) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
  end if;

  -- Anmeldelsen skal være åben og handle om det samme indhold.
  if p_anmeldelse is not null then
    perform 1 from public.dsa_anmeldelser x
     where x.id = p_anmeldelse and x.status = 'ny'
       and (x.indhold_id = p_id
            and (x.indhold_type = p_type
                 or (x.indhold_type in ('spoergsmaal', 'spoergsmaal_svar') and p_type in ('spoergsmaal', 'spoergsmaal_svar'))))
     for update;
    if not found then return jsonb_build_object('kode', 'anmeldelse_ugyldig'); end if;
    if exists (select 1 from public.dsa_anmeldelser x where x.id = p_anmeldelse and x.anmelder_id = p_medarbejder) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
  end if;

  -- ---------------------------------------------------------------- Udfør
  if p_type = 'auktion' then
    select x.id, x.bruger_id, x.status, x.skjult, x.slutter_kl into a
      from public.auctions x where x.id = p_id for update;
    v_foer := a.status;

    if p_handling = 'auktion_skjult' then
      if a.skjult then return jsonb_build_object('kode', 'uaendret'); end if;
      update public.auctions set skjult = true where id = p_id;
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (p_medarbejder, 'auktion_skjult', 'auktion', p_id, a.bruger_id,
              left('Skjulte auktion | ' || v_regel.navn || ' | ' || v_fakta, 4000));

    elsif p_handling = 'auktion_fjernet' then
      if exists (select 1 from public.trades t where t.auction_id = p_id) then
        return jsonb_build_object('kode', 'har_handel');
      end if;
      if a.status = 'afsluttet' then return jsonb_build_object('kode', 'afsluttet'); end if;
      if a.status = 'annulleret' and a.skjult then return jsonb_build_object('kode', 'uaendret'); end if;
      update public.auctions set status = 'annulleret', skjult = true
       where id = p_id and status in ('aktiv', 'annulleret');
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (p_medarbejder, 'slet_auktion', 'auktion', p_id, a.bruger_id,
              left('Fjernede auktion | ' || v_regel.navn || ' | ' || v_fakta, 4000));

    else -- auktion_annulleret
      if a.status <> 'aktiv' then return jsonb_build_object('kode', 'ikke_aktiv'); end if;
      update public.auctions set status = 'annulleret' where id = p_id and status = 'aktiv';
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (p_medarbejder, 'annuller_auktion', 'auktion', p_id, a.bruger_id,
              left('Annullerede auktion | ' || v_regel.navn || ' | ' || v_fakta, 4000));
    end if;

  elsif p_type in ('spoergsmaal', 'spoergsmaal_svar') then
    v_r := public.skjul_spoergsmaal(p_medarbejder, p_id, true, left(v_regel.navn || ': ' || v_fakta, 500));
    if v_r->>'kode' <> 'ok' then return v_r; end if;

  elsif p_type in ('bedoemmelse', 'bedoemmelse_svar') then
    v_grund := case p_regel
      when 'chikane' then 'groft_sprog'
      when 'hadefuld_tale' then 'groft_sprog'
      when 'personoplysninger' then 'personoplysninger'
      when 'kontaktinfo' then 'kontaktinfo'
      when 'ikke_relateret' then 'ikke_relateret'
      else 'andet' end;
    v_r := public.skjul_bedoemmelse(p_medarbejder, p_id,
             case when p_type = 'bedoemmelse' then 'bedoemmelse' else 'svar' end,
             true, v_grund, left(v_fakta, 500));
    if v_r->>'kode' <> 'ok' then return v_r; end if;

  else -- profil
    select x.id, x.rolle, x.suspenderet, x.konto_lukket_kl into u
      from public.users x where x.id = p_id for update;
    if u.rolle in ('admin', 'chef') or (p_handling = 'konto_lukket' and u.rolle = 'medarbejder') then
      return jsonb_build_object('kode', 'staff');
    end if;
    if u.konto_lukket_kl is not null then return jsonb_build_object('kode', 'allerede_lukket'); end if;

    if p_handling = 'konto_suspenderet' then
      v_varig := coalesce(v_ekstra->>'varighed', '');
      if v_varig not in ('1', '7', 'permanent') then
        return jsonb_build_object('kode', 'ugyldig_varighed');
      end if;
      v_til := case when v_varig = 'permanent' then null else now() + (v_varig || ' days')::interval end;
      update public.users
         set suspenderet = true,
             suspenderet_aarsag = left(v_regel.navn || ': ' || v_fakta, 1000),
             suspenderet_kl = now(),
             suspenderet_til = v_til
       where id = p_id;
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (p_medarbejder, 'suspender', 'bruger', p_id, p_id,
              left(v_regel.navn || ' | ' || v_fakta || ' (varighed: '
                   || case when v_varig = 'permanent' then 'permanent' else v_varig || ' dag(e)' end || ')', 4000));
    else
      v_r := public.bruger_luk_konto_permanent(p_medarbejder, p_id,
               left(v_regel.navn || ': ' || v_fakta, 1000),
               nullif(v_ekstra->>'sag_id', '')::uuid);
      if v_r->>'kode' <> 'ok' then return v_r; end if;
    end if;
  end if;

  -- ---------------------------------------------------------------- Begrundelsen
  insert into public.dsa_afgoerelser
    (bruger_id, indhold_type, indhold_id, auktion_id, indhold_tekst, handling, regel_kode, regel_tekst,
     grundlag, fakta, intern_note, automatisk_opdaget, automatisk_afgjort, anmeldelse_id, varighed_til,
     foer_status, medarbejder_id)
  values
    (e.bruger_id, p_type, p_id, e.auktion_id, e.tekst, p_handling, v_regel.kode,
     left(v_regel.navn || ' (' || v_regel.henvisning || ')', 500), v_regel.grundlag, v_fakta, v_note,
     v_auto, false, p_anmeldelse, v_til, v_foer, p_medarbejder)
  returning id, sagsnummer into v_afg, v_nr;

  -- Den anden part i et spørgsmål med svar (spørgeren eller sælgeren) får
  -- også en begrundelse - deres tekst er skjult sammen med den anden.
  if p_type in ('spoergsmaal', 'spoergsmaal_svar') then
   if q.answer is not null and q.asker_id is distinct from q.saelger_id then
    insert into public.dsa_afgoerelser
      (bruger_id, indhold_type, indhold_id, auktion_id, indhold_tekst, handling, regel_kode, regel_tekst,
       grundlag, fakta, intern_note, automatisk_opdaget, automatisk_afgjort, anmeldelse_id, varighed_til,
       foer_status, medarbejder_id)
    values
      (case when p_type = 'spoergsmaal' then q.saelger_id else q.asker_id end,
       case when p_type = 'spoergsmaal' then 'spoergsmaal_svar' else 'spoergsmaal' end,
       p_id, q.auction_id,
       left(case when p_type = 'spoergsmaal' then 'Svar på spørgsmål: ' || q.answer
                 else 'Spørgsmål: ' || q.question end, 300),
       p_handling, v_regel.kode,
       left(v_regel.navn || ' (' || v_regel.henvisning || ')', 500), v_regel.grundlag,
       left(case when p_type = 'spoergsmaal'
                 then 'Spørgsmålet, du svarede på, er skjult, og dit svar er derfor også skjult. Begrundelsen for spørgsmålet: '
                 else 'Svaret på dit spørgsmål er skjult, og dit spørgsmål er derfor også skjult. Begrundelsen for svaret: '
            end || v_fakta, 2000),
       v_note, v_auto, false, p_anmeldelse, null, null, p_medarbejder)
    returning id into v_x;
    v_ekstra_afg := array[v_x];
   end if;
  end if;

  -- Alle åbne anmeldelser af samme indhold afgøres med indgrebet.
  with luk as (
    update public.dsa_anmeldelser x
       set status = 'afgjort', udfald = 'indgreb', afgoerelse_id = v_afg,
           behandlet_af = p_medarbejder, behandlet_kl = now(),
           svar_til_anmelder = coalesce(v_svar, x.svar_til_anmelder),
           intern_note = coalesce(v_note, x.intern_note),
           politi_underrettet = x.politi_underrettet
             or (x.id = p_anmeldelse and coalesce((v_ekstra->>'politi_underrettet')::boolean, false))
     where x.status = 'ny'
       and x.indhold_id = p_id
       and (x.indhold_type = p_type
            or (x.indhold_type in ('spoergsmaal', 'spoergsmaal_svar') and p_type in ('spoergsmaal', 'spoergsmaal_svar'))
            or (p_type = 'profil' and x.indhold_type = 'profil'))
    returning x.id
  )
  select coalesce(array_agg(id), '{}') into v_anm from luk;

  if array_length(v_anm, 1) > 0 then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    select p_medarbejder, 'dsa_anmeldelse_afgjort', 'dsa', x, e.bruger_id,
           left('Anmeldelse afgjort med indgreb ' || v_nr, 4000)
      from unnest(v_anm) as x;
  end if;

  return jsonb_build_object('kode', 'ok', 'afgoerelse_id', v_afg, 'sagsnummer', v_nr,
                            'bruger_id', e.bruger_id, 'anmeldelser', to_jsonb(v_anm),
                            'ekstra_afgoerelser', to_jsonb(v_ekstra_afg));
end;
$fn$;
revoke all on function public.dsa_indgreb(uuid, text, uuid, text, text, text, text, uuid, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.dsa_indgreb(uuid, text, uuid, text, text, text, text, uuid, boolean, jsonb)
  to service_role;

-- ============================================================ V1: klage

create or replace function public.dsa_klage_afgoer(
  p_medarbejder uuid,
  p_klage       uuid,
  p_udfald      text,
  p_svar        text,
  p_intern_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_svar  text := btrim(coalesce(p_svar, ''));
  v_note  text := nullif(btrim(coalesce(p_intern_note, '')), '');
  k       record;
  af      record;
  an      record;
  v_rolle text := 'medarbejder';
  v_r     jsonb;
  v_genaabnet boolean := true;
  v_status text;
  v_slut   timestamptz;
  v_bruger uuid;
  v_til    uuid;
  v_saelger uuid;
begin
  if p_udfald is null or p_udfald not in ('medhold', 'fastholdt') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_svar = '' then return jsonb_build_object('kode', 'svar_mangler'); end if;
  if char_length(v_svar) > 2000 or (v_note is not null and char_length(v_note) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into k from public.dsa_klager x where x.id = p_klage for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if k.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;

  if k.afgoerelse_id is not null then
    select * into af from public.dsa_afgoerelser x where x.id = k.afgoerelse_id for update;
    v_rolle := public.dsa_min_rolle(af.handling);
    v_bruger := af.bruger_id;
  else
    select * into an from public.dsa_anmeldelser x where x.id = k.anmeldelse_id for update;
    v_bruger := an.anmeldt_bruger_id;
  end if;

  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, v_rolle) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  -- Inhabil - ALT tjekkes, før der skrives noget: den, der traf afgørelsen,
  -- klageren, den ramte, en, man har handlet med, og ved bedømmelser også
  -- begge parter i bedømmelsen (bedoemmelse_er_inhabil).
  if k.afgoerelse_id is not null then
    if p_medarbejder is not distinct from af.medarbejder_id
       or p_medarbejder = k.klager_id
       or public.dsa_er_inhabil(p_medarbejder, af.bruger_id)
       or exists (select 1 from public.dsa_anmeldelser x
                   where x.id = af.anmeldelse_id and x.anmelder_id = p_medarbejder) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
    if af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
      select r.til_bruger_id into v_til from public.ratings r where r.id = af.indhold_id;
      if public.bedoemmelse_er_inhabil(p_medarbejder, af.indhold_id)
         or public.dsa_er_inhabil(p_medarbejder, v_til) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    elsif af.handling = 'spoergsmaal_skjult' then
      select x.asker_id, au.bruger_id into v_til, v_saelger
        from public.auction_questions x join public.auctions au on au.id = x.auction_id
       where x.id = af.indhold_id;
      if public.dsa_er_inhabil(p_medarbejder, v_til) or public.dsa_er_inhabil(p_medarbejder, v_saelger) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    end if;
  else
    if p_medarbejder is not distinct from an.behandlet_af
       or p_medarbejder is not distinct from an.anmelder_id
       or public.dsa_er_inhabil(p_medarbejder, an.anmeldt_bruger_id) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
  end if;

  -- Herfra: en fejl ruller alt tilbage (raise), så der aldrig er delvise
  -- skrivninger.
  if p_udfald = 'medhold' then
    if k.afgoerelse_id is not null then
      -- Kan auktionen åbnes igen? Afgøres før noget skrives.
      if af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        select x.status, x.slutter_kl into v_status, v_slut from public.auctions x where x.id = af.indhold_id for update;
        v_genaabnet := (v_status = 'annulleret' and af.foer_status = 'aktiv' and v_slut > now())
                    or (af.handling = 'auktion_fjernet' and v_status = 'annulleret' and af.foer_status = 'annulleret');
      end if;

      -- Markér først, så triggerne ikke også markerer den som ophævet af
      -- staff. Kan indgrebet ikke tilbageføres (auktionen er udløbet), står
      -- afgørelsen ved magt - brugeren får besked om at sætte varen op igen.
      if v_genaabnet then
        update public.dsa_afgoerelser
           set ophaevet_kl = coalesce(ophaevet_kl, now()), ophaevet_grund = coalesce(ophaevet_grund, 'klage')
         where id = af.id;
      end if;

      if af.handling = 'auktion_skjult' then
        update public.auctions set skjult = false where id = af.indhold_id and skjult;
      elsif af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        if v_status = 'annulleret' and af.foer_status = 'aktiv' and v_slut > now() then
          update public.auctions set status = 'aktiv', skjult = false, arkiveret_kl = null where id = af.indhold_id;
        elsif v_genaabnet then
          update public.auctions set skjult = false where id = af.indhold_id;
        end if;
      elsif af.handling = 'spoergsmaal_skjult' then
        v_r := public.skjul_spoergsmaal(p_medarbejder, af.indhold_id, false, null);
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_spoergsmaal: %', v_r->>'kode';
        end if;
      elsif af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
        v_r := public.skjul_bedoemmelse(p_medarbejder, af.indhold_id,
                 case when af.handling = 'bedoemmelse_skjult' then 'bedoemmelse' else 'svar' end,
                 false, null, left('Medhold i klage ' || k.sagsnummer, 500));
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_bedoemmelse: %', v_r->>'kode';
        end if;
      elsif af.handling = 'konto_suspenderet' then
        -- Ophæv kun, hvis der ikke er kommet en nyere, gældende suspension.
        if not exists (select 1 from public.dsa_afgoerelser y
                        where y.bruger_id = af.bruger_id and y.id <> af.id
                          and y.handling in ('konto_suspenderet', 'konto_lukket')
                          and y.oprettet_kl > af.oprettet_kl and y.ophaevet_kl is null) then
          update public.users
             set suspenderet = false, suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
           where id = af.bruger_id and suspenderet and konto_lukket_kl is null;
        end if;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'ophaev_suspension', 'bruger', af.bruger_id, af.bruger_id,
                left('Suspension ophævet efter medhold i klage ' || k.sagsnummer, 4000));
      elsif af.handling = 'konto_lukket' then
        update public.users
           set konto_lukket_kl = null, konto_lukket_af = null, suspenderet = false,
               suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
         where id = af.bruger_id and konto_lukket_kl is not null and konto_slettet_kl is null;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'konto_genaabnet', 'bruger', af.bruger_id, af.bruger_id,
                left('Konto genåbnet efter medhold i klage ' || k.sagsnummer, 4000));
      end if;
    else
      -- Anmelderen fik medhold: anmeldelsen genåbnes og behandles igen.
      update public.dsa_anmeldelser
         set status = 'ny', udfald = null, behandlet_af = null, behandlet_kl = null,
             genaabnet_kl = now(), frist_kl = now() + interval '7 days', svar_sendt_kl = null
       where id = an.id;
    end if;
  end if;

  update public.dsa_klager
     set status = 'afgjort', udfald = p_udfald, svar = v_svar, intern_note = v_note,
         afgjort_af = p_medarbejder, afgjort_kl = now()
   where id = k.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when p_udfald = 'medhold' then 'dsa_klage_medhold' else 'dsa_klage_fastholdt' end,
          'dsa', k.id, v_bruger,
          left('Klage ' || k.sagsnummer || ': ' || case when p_udfald = 'medhold' then 'medhold' else 'afgørelsen fastholdt' end
               || case when p_udfald = 'medhold' and not v_genaabnet then ' (auktionen er udløbet og kan ikke åbnes igen)' else '' end
               || ' | ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'genaabnet', v_genaabnet,
                            'type', case when k.afgoerelse_id is not null then 'afgoerelse' else 'anmeldelse' end);
end;
$fn$;
revoke all on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Ophævet af staff

create or replace function public.dsa_marker_ophaevet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_table_name = 'auctions' then
    if old.skjult and not new.skjult then
      -- "Vis igen" ophæver både en skjult og en fjernet (annulleret + skjult)
      -- auktion - indholdet er synligt igen.
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'auktion' and indhold_id = new.id
         and handling in ('auktion_skjult', 'auktion_fjernet')
         and ophaevet_kl is null;
    end if;
    if old.status = 'annulleret' and new.status <> 'annulleret' then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'auktion' and indhold_id = new.id
         and handling in ('auktion_fjernet', 'auktion_annulleret') and ophaevet_kl is null;
    end if;
  elsif tg_table_name = 'auction_questions' then
    if old.hidden and not new.hidden then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type in ('spoergsmaal', 'spoergsmaal_svar') and indhold_id = new.id
         and ophaevet_kl is null;
    end if;
  elsif tg_table_name = 'ratings' then
    if old.skjult and not new.skjult then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'bedoemmelse' and indhold_id = new.id and ophaevet_kl is null;
    end if;
  elsif tg_table_name = 'bedoemmelse_svar' then
    if old.skjult and not new.skjult then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'bedoemmelse_svar' and indhold_id = new.rating_id and ophaevet_kl is null;
    end if;
  elsif tg_table_name = 'users' then
    -- En suspension, der er udløbet af sig selv, er ikke "ophævet" - brugeren
    -- beholder sin klageret.
    if old.suspenderet and not new.suspenderet then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where bruger_id = new.id and handling = 'konto_suspenderet' and ophaevet_kl is null
         and (varighed_til is null or varighed_til > now());
    end if;
    if old.konto_lukket_kl is not null and new.konto_lukket_kl is null then
      update public.dsa_afgoerelser set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where bruger_id = new.id and handling = 'konto_lukket' and ophaevet_kl is null;
    end if;
  end if;
  return null;
end;
$fn$;
revoke all on function public.dsa_marker_ophaevet() from public, anon, authenticated;

drop trigger if exists users_dsa_ophaevet on public.users;
create trigger users_dsa_ophaevet after update of suspenderet, konto_lukket_kl on public.users
  for each row when (old.suspenderet is distinct from new.suspenderet
                     or old.konto_lukket_kl is distinct from new.konto_lukket_kl)
  execute function public.dsa_marker_ophaevet();

-- ============================================================ Oprydning

create or replace function public.dsa_oprydning_koer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_anm integer := 0;
  v_kl  integer := 0;
begin
  update public.dsa_anmeldelser a
     set anmelder_navn = null, anmelder_email = null, anmelder_id = null,
         begrundelse = '(Slettet 12 måneder efter afgørelsen)',
         placering = case when a.indhold_type = 'andet' then '(slettet)' else a.placering end,
         svar_til_anmelder = case when a.svar_til_anmelder is null then null else '(slettet)' end,
         intern_note = public.dsa_rens_kontakt(a.intern_note),
         eskaleret_note = public.dsa_rens_kontakt(a.eskaleret_note),
         anonymiseret_kl = now()
   where a.id in (
           select x.id from public.dsa_anmeldelser x
            where x.anonymiseret_kl is null
              and x.status = 'afgjort'
              and x.behandlet_kl < now() - interval '12 months'
              and not exists (select 1 from public.dsa_klager k
                               where k.anmeldelse_id = x.id
                                 and (k.status = 'afventer' or k.afgjort_kl > now() - interval '12 months'))
            order by x.behandlet_kl
            limit 5000);
  get diagnostics v_anm = row_count;

  -- Anmelderens klage: e-mail, konto-kobling og fritekst (svaret er skrevet
  -- til anmelderen og kan nævne den).
  update public.dsa_klager k
     set klager_email = null,
         klager_id = null,
         begrundelse = '(Slettet 12 måneder efter afgørelsen)',
         svar = case when k.svar is null then null else '(slettet)' end,
         intern_note = public.dsa_rens_kontakt(k.intern_note),
         anonymiseret_kl = now()
   where k.id in (
           select x.id from public.dsa_klager x
            where x.anonymiseret_kl is null
              and x.anmeldelse_id is not null
              and x.status = 'afgjort'
              and x.afgjort_kl < now() - interval '12 months'
            limit 5000);
  get diagnostics v_kl = row_count;

  return jsonb_build_object('anmeldelser_anonymiseret', v_anm, 'klager_anonymiseret', v_kl);
end;
$fn$;
revoke all on function public.dsa_oprydning_koer() from public, anon, authenticated;
grant execute on function public.dsa_oprydning_koer() to service_role;

-- Eget cron-job, så DSA-oprydningen kører, selvom oprydning_koer fejler (og
-- omvendt). 'oprydning' sættes tilbage til, hvad den var før DSA.
select cron.schedule('oprydning', '17 * * * *', $$select public.oprydning_koer();$$);
select cron.schedule('dsa_oprydning', '47 3 * * *', $$select public.dsa_oprydning_koer();$$);
