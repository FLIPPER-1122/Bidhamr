-- "Behold Starts gratis måned + introrabat" (Filip, 29. okt. 2026).
--
-- Udvalgte firmaer på Start kan få en særaftale: 1 gratis måned (Starts
-- normale måned 1) og derefter introrabatten (standard 50 % i 6 måneder) fra
-- første betaling - måned 1 gratis, måned 2-7 til 50 %, fuld pris fra måned 8.
-- Før skulle staff gøre det i en bestemt rækkefølge (oprette uden introrabat,
-- lade firmaet betale i Checkout og først derefter sætte introrabatten); i
-- forkert rækkefølge forsvandt den gratis måned. Nu er det ét valg, staff
-- aktivt slår til (aldrig standard), med begrundelse og log - både i "Opret
-- firmakonto" og i Introrabat-kortet. Valget er IKKE en "gratis periode"
-- (proeve_ekstra_ventende / gratis_saeraftale): Checkout bruger Starts egen
-- velkomstmåned, så et skift op til Butik/Pro i den gratis måned følger de
-- almindelige regler.
--
-- Indhold:
--   1. firmaer.intro_behold_gratis (boolean, standard false). En trigger
--      nulstiller den, når introrabatten fjernes eller ikke længere gælder fra
--      første betaling (intro_fra <> 'efter_gratis') - så den kan aldrig
--      hænge ved en anden aftale.
--   2. erhverv_maaned1: en introrabat fjerner velkomstfordelen som før -
--      UNDTAGEN når intro_behold_gratis er sat, intro_fra = 'efter_gratis' og
--      pakken er gratis i måned 1 (Start). Så er måned 1 'gratis', og
--      startBetaling laver Checkout med 1 gratis måned og introkuponen, der
--      rammer præcis N betalte måneder efter den (introKuponMaanederCheckout).
--      Særpris og et brugt/manglende velkomst-tilgodehavende giver stadig
--      'ingen'.
--   3. erhverv_firma_abonnement_json: introrabat.behold_gratis og
--      behold_gratis_mulig (Start, intet abonnement endnu, velkomstmåneden til
--      gode, ingen særpris) til admin-kortet og firmaets abonnementsside.
--   4. erhverv_firma_intro_gem: ny parameter p_behold_gratis (standard false,
--      så gamle kald virker som før). Afvises: med 'Fra nu' (ugyldig_rabat),
--      på en pakke, der ikke er gratis i måned 1 (behold_kun_start), når
--      abonnementet er startet (behold_startet - så giver 'Fra første
--      betaling' allerede det rigtige), og når firmaet ikke har den gratis
--      måned til gode (behold_ingen_gratis). Logges med begrundelsen.
--   5. erhverv_firma_opret: nye parametre p_intro_behold_gratis og
--      p_intro_behold_begrundelse (5-500 tegn, logges med staffs navn).
--      Samme afvisninger (behold_kun_start, behold_ingen_gratis,
--      behold_begrundelse).
--
-- md5-drift-tjek: hver funktion, der erstattes, skal være den seneste
-- migrations (erhverv_maaned1 og erhverv_firma_abonnement_json: 20261102150000;
-- erhverv_firma_intro_gem: 20261102050000; erhverv_firma_opret:
-- 20261102070000) eller allerede denne migrations. To funktioner skifter
-- signatur: findes den nye, skal den være denne migrations; findes den gamle,
-- skal den være repoets. Ellers afbrydes (intet ændres). Idempotent. Én
-- transaktion. Kør først på testdatabasen. KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælper og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $do$
declare
  r record;
  h text;
  h_ny text;
  h_gl text;
begin
  if to_regprocedure('public.erhverv_faar_velkomst_gratis(uuid)') is null
     or to_regprocedure('public.erhverv_intro_gaelder(public.firmaer)') is null
     or to_regprocedure('public.erhverv_saerpris_gaelder(public.firmaer)') is null
     or to_regprocedure('public.erhverv_har_betalt_abonnement(uuid)') is null then
    raise exception 'Forudsætning mangler: kør 20261102050000-20261102150000 først';
  end if;

  -- Samme signatur.
  for r in
    select * from (values
      -- (funktion, forrige migrations, denne migrations)
      ('public.erhverv_maaned1(uuid)', '47c17b77c095b80ffa281fa5b8f76726', '272655457b96af7aea4668eb50aca132'),
      ('public.erhverv_firma_abonnement_json(uuid)', '18c69445447e0ac186e362907fa88b3a', '4b46b9569814d7710491f6854ba28dcc')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
    end if;
    if h <> r.gammel and h <> r.ny then
      raise exception '%: md5 % passer hverken med forrige migration (%) eller denne (%) - kontrollér funktionen, før migrationen køres',
        r.fn, h, r.gammel, r.ny;
    end if;
  end loop;

  -- Ny signatur.
  for r in
    select * from (values
      -- (gammel signatur, forrige migrations, ny signatur, denne migrations)
      ('public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid)', 'f36100c2a4efe4b2bceccc48e8afa897',
       'public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid,boolean)', 'd699ecffe31ff93a76616b5073b7467c'),
      ('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text)', '12c6c174d886f29ad7f87df4bf57e64d',
       'public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text,boolean,text)', '135ea4c5bcc95afc96ede6b400d9d178')
    ) as t(gl, gammel, ny_fn, ny)
  loop
    h_gl := pg_temp.krop_md5(r.gl);
    h_ny := pg_temp.krop_md5(r.ny_fn);
    if h_gl is null and h_ny is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.gl;
    end if;
    if h_gl is not null and h_gl <> r.gammel then
      raise exception '%: md5 % passer ikke med forrige migration (%) - kontrollér funktionen, før migrationen køres', r.gl, h_gl, r.gammel;
    end if;
    if h_ny is not null and h_ny <> r.ny then
      raise exception '%: md5 % passer ikke med denne migration (%) - kontrollér funktionen, før migrationen køres', r.ny_fn, h_ny, r.ny;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Valget på firmaet
-- ===========================================================================
alter table public.firmaer add column if not exists intro_behold_gratis boolean not null default false;
comment on column public.firmaer.intro_behold_gratis is
  'Staff har valgt "Behold Starts gratis måned + introrabat" (særaftale, aldrig standard): Start beholder sin gratis måned 1, og introrabatten gælder fra første betaling (måned 2-7 ved 6 måneder). Kun med intro_fra = ''efter_gratis'' - nulstilles af triggeren, når introrabatten fjernes eller ændres til ''straks''. Se erhverv_maaned1. 20261102450000.';

create or replace function public.firmaer_intro_behold_normaliser()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.intro_behold_gratis and (new.intro_procent is null or new.intro_fra is distinct from 'efter_gratis') then
    new.intro_behold_gratis := false;
  end if;
  return new;
end $$;
revoke all on function public.firmaer_intro_behold_normaliser() from public, anon, authenticated, service_role;

drop trigger if exists firmaer_intro_behold_normaliser on public.firmaer;
create trigger firmaer_intro_behold_normaliser
  before insert or update of intro_procent, intro_fra, intro_behold_gratis on public.firmaer
  for each row execute function public.firmaer_intro_behold_normaliser();

-- ===========================================================================
-- 2. Regel for måned 1
-- ===========================================================================
create or replace function public.erhverv_maaned1(p_firma uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when not public.erhverv_faar_velkomst_gratis(f.id) then 'ingen'
                when public.erhverv_intro_gaelder(f)
                     and not (f.intro_behold_gratis and f.intro_fra = 'efter_gratis'
                              and coalesce(p.maaned1, 'halv') = 'gratis') then 'ingen'
                when public.erhverv_saerpris_gaelder(f) then 'ingen'
                else coalesce(p.maaned1, 'halv') end
      from public.firmaer f
      left join public.erhverv_pakker p on p.id = f.pakke_id
     where f.id = p_firma), 'ingen');
$$;
revoke all on function public.erhverv_maaned1(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_maaned1(uuid) to service_role;
comment on function public.erhverv_maaned1(uuid) is
  'Velkomstfordelen i måned 1, når firmaet starter Checkout: gratis (Start), halv (Butik/Pro: 50 %) eller ingen. Introrabat eller særpris og velkomstfordel kombineres aldrig (Filip, 27. okt. 2026) - undtagen staffs valg "Behold Starts gratis måned + introrabat" (intro_behold_gratis, kun Start og intro_fra efter_gratis): så er måned 1 gratis, og introrabatten gælder fra første betaling. 20261102450000.';

-- ===========================================================================
-- 3. Abonnement-JSON
-- ===========================================================================
create or replace function public.erhverv_firma_abonnement_json(p_firma uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f public.firmaer;
  p public.erhverv_pakker;
  k jsonb;
  v_maaned1 text;
begin
  select * into f from public.firmaer where id = p_firma;
  if f.id is null then
    return null;
  end if;
  select * into p from public.erhverv_pakker where id = f.pakke_id;
  k := public.erhverv_firma_kvote_json(f.id);
  -- Samme regel som startBetaling: Start = velkomstmåneden + staff-måneder;
  -- Butik/Pro = 50 % i måned 1, medmindre staff har givet gratis måneder
  -- (de erstatter 50 %-måneden). Særpris eller introrabat: ingen fordel -
  -- undtagen "Behold Starts gratis måned + introrabat" (erhverv_maaned1).
  v_maaned1 := case when f.stripe_subscription_id is not null then null
                    when public.erhverv_saerpris_gaelder(f) then 'ingen'
                    else public.erhverv_maaned1(f.id) end;
  if v_maaned1 = 'halv' and f.proeve_ekstra_ventende > 0 then
    v_maaned1 := 'ingen';
  end if;
  return jsonb_build_object(
    -- Månedsprisen ekskl. moms i hele kroner, som firmaet betaler (særpris
    -- eller pakkens pris), før en evt. introrabat.
    'pris', case when f.saerpris_oere is not null and f.saerpris_pakke_id = f.pakke_id
                 then f.saerpris_oere / 100 else p.maanedspris end,
    'saerpris', case when f.saerpris_pakke_id = f.pakke_id then f.saerpris_oere / 100 end,
    'saerpris_aftale', case when f.saerpris_pakke_id = f.pakke_id then f.saerpris_aftale end,
    'gratis_til', case when f.stripe_abonnement_status = 'trialing' then f.proeve_slut end,
    'gratis_maaneder_ved_start', case when f.stripe_subscription_id is null
                                      then least((case when v_maaned1 = 'gratis' then least(f.proeve_maaneder, 1) else 0 end)
                                                 + f.proeve_ekstra_ventende, 24)
                                      else 0 end,
    -- Velkomstfordelen, når firmaet starter: 'gratis' | 'halv' | 'ingen'
    -- (null, når abonnementet er startet).
    'maaned1', v_maaned1,
    'gratis_brugt', f.proeve_givet_kl is not null and coalesce(f.stripe_abonnement_status, '') <> 'trialing',
    -- Kan staff vælge "Behold Starts gratis måned + introrabat"? Pakken er
    -- gratis i måned 1, abonnementet er ikke startet, firmaet har den gratis
    -- måned til gode, og der er ingen særpris.
    'behold_gratis_mulig', f.stripe_subscription_id is null
                           and coalesce(p.maaned1, 'halv') = 'gratis'
                           and public.erhverv_faar_velkomst_gratis(f.id)
                           and not public.erhverv_saerpris_gaelder(f),
    'introrabat', case when f.intro_procent is not null then jsonb_build_object(
                    'procent', f.intro_procent, 'maaneder', f.intro_maaneder, 'fra', f.intro_fra,
                    'status', f.intro_status, 'til', f.intro_til,
                    'behold_gratis', f.intro_behold_gratis) end,
    'kort', case when f.kort_sidste4 is not null then jsonb_build_object(
              'maerke', f.kort_maerke, 'sidste4', f.kort_sidste4,
              'udloeb', lpad(f.kort_udloeb_maaned::text, 2, '0') || '/' || right(f.kort_udloeb_aar::text, 2),
              'udloeber_snart', make_date(f.kort_udloeb_aar, f.kort_udloeb_maaned, 1) + interval '1 month'
                                 <= (now() at time zone 'Europe/Copenhagen') + interval '45 days') end,
    'kvote', jsonb_build_object('brugt', k->'brugt', 'max', k->'maks', 'pakke_max', k->'pakke_maks',
                                'ekstra', k->'ekstra', 'ubegraenset', k->'ubegraenset',
                                'periode_start', k->'periode_start', 'periode_slut', k->'periode_slut'),
    'fremhaevninger', k->'fremhaevninger');
end $$;

-- ===========================================================================
-- 4. Introrabat-kortet
-- ===========================================================================
create or replace function public.erhverv_firma_intro_gem(p_staff uuid, p_firma uuid, p_procent integer,
                                                          p_maaneder integer, p_fra text, p_begrundelse text,
                                                          p_klik uuid default null,
                                                          p_behold_gratis boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
  v_noegle uuid := gen_random_uuid();
  v_behold boolean := coalesce(p_behold_gratis, false);
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_begrundelse) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_procent is not null and (p_procent not between 1 and 100 or p_maaneder is null or p_maaneder not between 1 and 24
                                or coalesce(p_fra, '') not in ('efter_gratis', 'straks')) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  -- "Behold Starts gratis måned + introrabat" kun med en rabat fra første betaling.
  if v_behold and (p_procent is null or p_fra is distinct from 'efter_gratis') then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  -- Særpris og introrabat kan ikke kombineres (fjerne er altid tilladt).
  if p_procent is not null and public.erhverv_saerpris_gaelder(f) then
    return jsonb_build_object('kode', 'saerpris_aktiv');
  end if;
  if v_behold then
    -- Abonnementet er startet: 'Fra første betaling' gælder allerede efter
    -- en kørende gratis periode - valget har ingen virkning.
    if f.stripe_subscription_id is not null then
      return jsonb_build_object('kode', 'behold_startet');
    end if;
    if coalesce((select p.maaned1 from public.erhverv_pakker p where p.id = f.pakke_id), 'halv') <> 'gratis' then
      return jsonb_build_object('kode', 'behold_kun_start');
    end if;
    if not public.erhverv_faar_velkomst_gratis(f.id) then
      return jsonb_build_object('kode', 'behold_ingen_gratis');
    end if;
  end if;
  if not public.erhverv_staff_klik_tag(p_klik, 'firma_introrabat', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;
  if p_procent is null then
    update public.firmaer
       set intro_procent = null, intro_maaneder = null, intro_fra = null, intro_status = null,
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, intro_behold_gratis = false,
           opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat', 'Introrabat fjernet: ' || btrim(p_begrundelse));
  else
    update public.firmaer
       set intro_procent = p_procent, intro_maaneder = p_maaneder, intro_fra = p_fra, intro_status = 'planlagt',
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, intro_behold_gratis = v_behold,
           opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat',
      format('Introrabat %s %% i %s måned%s %s: %s', p_procent, p_maaneder, case when p_maaneder = 1 then '' else 'er' end,
             case when v_behold
                  then format('efter Starts gratis måned (måned 2-%s) - "Behold Starts gratis måned + introrabat" valgt', p_maaneder + 1)
                  when p_fra = 'straks' then 'fra nu'
                  else 'efter den gratis periode' end,
             btrim(p_begrundelse)));
  end if;
  return jsonb_build_object('kode', 'ok', 'noegle', v_noegle, 'behold_gratis', v_behold and p_procent is not null);
end $$;
drop function if exists public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid);
revoke all on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid, boolean) to service_role;
comment on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid, boolean) is
  'Sætter (planlagt) eller fjerner firmaets introrabat (chef og sælger-rollen; begrundelse og log). p_behold_gratis: "Behold Starts gratis måned + introrabat" - kun Start, før abonnementet er startet, med den gratis måned til gode og fra første betaling. 20261102450000.';

-- ===========================================================================
-- 5. Opret firmakonto
-- ===========================================================================
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text,
  p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid default null,
  p_intro_procent integer default null, p_intro_maaneder integer default null,
  p_cvr_bekraeftet boolean default null,
  p_saeraftale_gratis boolean default false, p_saeraftale_begrundelse text default null,
  p_intro_behold_gratis boolean default false, p_intro_behold_begrundelse text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
  v_tidligere jsonb;
  v_har_tidligere boolean;
  v_saeraftale boolean := coalesce(p_saeraftale_gratis, false);
  v_saeraftale_brugt boolean;
  v_behold boolean := coalesce(p_intro_behold_gratis, false);
  v_gratis integer;
  v_staff_navn text;
  v_pakke_maaned1 text;
  v_maaned1 text;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if v_saeraftale and char_length(btrim(coalesce(p_saeraftale_begrundelse, ''))) not between 5 and 500 then
    return jsonb_build_object('kode', 'saeraftale_begrundelse');
  end if;
  if v_behold and char_length(btrim(coalesce(p_intro_behold_begrundelse, ''))) not between 5 and 500 then
    return jsonb_build_object('kode', 'behold_begrundelse');
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'bruger_findes_ikke');
  end if;
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or u.oprettet < now() - interval '1 hour'
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;
  if not exists (select 1 from auth.users au
                  where au.id = p_bruger
                    and au.invited_at is not null
                    and au.last_sign_in_at is null
                    and coalesce(au.encrypted_password, '') = ''
                    and au.created_at > now() - interval '1 hour') then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;

  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  if exists (select 1 from public.firmaer f where f.cvr = p_cvr and f.abonnement_status <> 'opsagt') then
    return jsonb_build_object('kode', 'cvr_findes');
  end if;
  v_tidligere := public.erhverv_cvr_tidligere_json(p_cvr);
  v_har_tidligere := jsonb_array_length(v_tidligere) > 0;
  if v_har_tidligere and p_cvr_bekraeftet is false then
    return jsonb_build_object('kode', 'cvr_tidligere_abonnement', 'firmaer', v_tidligere);
  end if;
  select coalesce(p.maaned1, 'halv') into v_pakke_maaned1
    from public.erhverv_pakker p where p.id = p_pakke and p.arkiveret_kl is null;
  if not found then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if (p_intro_procent is null) <> (p_intro_maaneder is null)
     or (p_intro_procent is not null and (p_intro_procent not between 1 and 100 or p_intro_maaneder not between 1 and 24)) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  -- "Behold Starts gratis måned + introrabat": kun med en introrabat og kun på
  -- en pakke, der er gratis i måned 1 (Start).
  if v_behold and p_intro_procent is null then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  if v_behold and v_pakke_maaned1 <> 'gratis' then
    return jsonb_build_object('kode', 'behold_kun_start');
  end if;
  if p_henvendelse is not null then
    select * into h from public.erhverv_henvendelser where id = p_henvendelse for update;
    if h.id is null then
      return jsonb_build_object('kode', 'henvendelse_findes_ikke');
    end if;
    if exists (select 1 from public.firmaer f where f.henvendelse_id = p_henvendelse) then
      return jsonb_build_object('kode', 'henvendelse_brugt');
    end if;
  end if;

  -- Velkomstfordel for måned 1: nye CVR'er altid; et CVR, der har haft et
  -- abonnement før, kun med en særaftale (Filip, 27. okt. 2026). Hvilken
  -- fordel afgøres af pakken, når firmaet starter (erhverv_maaned1):
  -- Start gratis, Butik/Pro 50 %. En introrabat erstatter fordelen -
  -- undtagen med "Behold Starts gratis måned + introrabat".
  v_saeraftale_brugt := v_har_tidligere and v_saeraftale;
  v_gratis := case when not v_har_tidligere or v_saeraftale_brugt then 1 else 0 end;
  -- Ingen gratis måned til gode (tidligere CVR uden særaftale): intet at beholde.
  if v_behold and v_gratis = 0 then
    return jsonb_build_object('kode', 'behold_ingen_gratis');
  end if;
  v_maaned1 := case when v_gratis = 0 then 'ingen'
                    when p_intro_procent is not null and not v_behold then 'ingen'
                    else v_pakke_maaned1 end;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af,
                                proeve_maaneder, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle,
                                intro_behold_gratis)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff, v_gratis, p_intro_procent, p_intro_maaneder,
            case when p_intro_procent is not null then 'efter_gratis' end,
            case when p_intro_procent is not null then 'planlagt' end,
            case when p_intro_procent is not null then gen_random_uuid() end,
            v_behold)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  update public.users
     set konto_type = 'erhverv',
         navn = left(btrim(p_firmanavn), 200),
         fornavn = null,
         efternavn = null,
         telefon = btrim(p_telefon)
   where id = p_bruger;

  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl)
  values (v_id, null, p_pakke, 'start', 'gennemfoert', p_staff, now());

  if p_henvendelse is not null then
    update public.erhverv_henvendelser
       set status = 'godkendt', behandlet_af = p_staff, behandlet_kl = now(), opdateret_kl = now()
     where id = p_henvendelse;
  end if;

  select coalesce(nullif(btrim(navn), ''), 'staff') into v_staff_navn from public.users where id = p_staff;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || '), pakke '
               || (select navn from public.erhverv_pakker where id = p_pakke)
               || case when p_intro_procent is not null and v_behold
                       then format(', første måned gratis og derefter introrabat %s %% i måned 2-%s ("Behold Starts gratis måned + introrabat" valgt af %s: %s)',
                                   p_intro_procent, p_intro_maaneder + 1, v_staff_navn, btrim(p_intro_behold_begrundelse))
                       when p_intro_procent is not null
                       then format(', introrabat %s %% i måned 1-%s (ingen velkomstfordel oveni)', p_intro_procent, p_intro_maaneder)
                       when v_maaned1 = 'gratis' then ', første måned gratis'
                       when v_maaned1 = 'halv' then ', første måned til halv pris'
                       else ', ingen velkomstfordel i måned 1' end
               || case when v_har_tidligere
                       then case when p_cvr_bekraeftet then '; CVR''et har haft et abonnement før - bekræftet af staff'
                                 else '; CVR''et har haft et abonnement før' end
                       else '' end
               || case when v_saeraftale_brugt
                       then '; velkomstrabatten for måned 1 givet som særaftale af ' || v_staff_navn || ': '
                            || btrim(p_saeraftale_begrundelse)
                       else '' end, 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id,
                            'cvr_tidligere_abonnement', v_har_tidligere,
                            'gratis_maaneder', case when v_maaned1 = 'gratis' then 1 else 0 end,
                            'maaned1', v_maaned1,
                            'saeraftale', v_saeraftale_brugt,
                            'behold_gratis', v_behold);
end $function$;
drop function if exists public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text);
revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text, boolean, text) to service_role;
comment on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text, boolean, text) is
  'Opretter en firmakonto (chef og sælger-rollen). Velkomstfordel for måned 1 efter pakken (Start gratis, Butik/Pro 50 %); et CVR, der har haft et abonnement før, får ingen (proeve_maaneder = 0) - kun som særaftale (begrundelse 5-500 tegn, logges med staffs navn). En introrabat gælder fra måned 1 i stedet - undtagen med "Behold Starts gratis måned + introrabat" (p_intro_behold_gratis, kun Start, begrundelse 5-500 tegn): måned 1 gratis, introrabatten fra første betaling. Svar: maaned1, behold_gratis. 20261102450000.';
