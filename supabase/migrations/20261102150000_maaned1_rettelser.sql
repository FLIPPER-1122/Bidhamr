-- Rettelser efter review af reglen for måned 1 (20261102070000).
--
-- Bygger på 20261102070000_maaned1_regel.sql (skal være kørt først). Rører
-- IKKE grants på users/auctions (20261102060000) og intet fra 120000-140000.
--
-- Indhold:
--   1. erhverv_har_betalt_abonnement(firma): ÉN definition af "har betalt for
--      abonnementet" - en regning af typen abonnement eller opgradering med
--      status betalt eller krediteret (betalt og senere refunderet) og beløb
--      > 0. Bruges af erhverv_faar_velkomst_gratis, erhverv_firma_opdater og
--      erhverv_firma_har_haft_abonnement.
--   2. erhverv_firma_har_haft_abonnement(firma): har firmaet haft et
--      abonnement? Stripe-abonnement, en gratis periode, en betalt regning
--      eller status aktiv/pauset. (Før: også abonnement_start - men den
--      kolonne er NOT NULL DEFAULT now() og derfor altid sat, så ALLE firmaer
--      med CVR'et talte - også et, der aldrig startede.)
--   3. erhverv_maaned1: et firma med særpris på sin pakke får INGEN
--      velkomstfordel (Filip, 27. okt. 2026: særprisen gælder fra første
--      betaling - hverken gratis Start-måned eller 50 % på Butik/Pro).
--   4. erhverv_firma_abonnement_json: samme regel (maaned1 'ingen' og ingen
--      velkomstmåned i gratis_maaneder_ved_start ved særpris).
--   5. CVR-historik (firma_cvr_historik): hver gang et firmas CVR ændres,
--      gemmes det gamle CVR (trigger på firmaer - alle veje til en ændring er
--      dækket), og om firmaet HAVDE haft et abonnement på det tidspunkt.
--      erhverv_cvr_tidligere_json slår også op i historikken, så reglen om
--      tidligere CVR ikke kan omgås ved at ændre CVR'et på det GAMLE firma.
--      Handelsdata slettes aldrig: historikken kan kun indsættes (ingen
--      update/delete-rettigheder). Valgt frem for at afvise CVR-skift: en
--      tastefejl i CVR'et kan stadig rettes, og intet går tabt.
--      Eksisterende CVR-skift fra moderation_log ("CVR ændret: X → Y",
--      20261102070000) lægges ind én gang.
--   6. erhverv_firma_opdater: "har betalt" = erhverv_har_betalt_abonnement.
--   7. Kun kort (laasKunKort): højst 3 forsøg pr. abonnement ved permanente
--      Stripe-fejl (firma_kort_laas_fejl), så drift-alarmen ikke gentages hver
--      kørsel. Kandidatlisten springer opgivne abonnementer over.
--
-- md5-drift-tjek: hver funktion, der erstattes, skal enten være
-- 20261102070000's (eller for erhverv_cvr_tidligere_json 20261102040000's)
-- eller allerede denne migrations. Ellers afbrydes (intet ændres).
-- Idempotent. Én transaktion. Kør først på testdatabasen. KØRES IKKE i
-- produktion uden Filips "ja".

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
begin
  if to_regprocedure('public.erhverv_maaned1(uuid)') is null
     or to_regprocedure('public.firma_kort_laas_kandidater(integer)') is null
     or to_regprocedure('public.erhverv_saerpris_gaelder(public.firmaer)') is null then
    raise exception 'Forudsætning mangler: kør 20261102050000-20261102070000 først';
  end if;
  for r in
    select * from (values
      -- (funktion, forrige migrations, denne migrations)
      ('public.erhverv_maaned1(uuid)', '24e300f4011e298eea0cf741ce8c0dd2', '47c17b77c095b80ffa281fa5b8f76726'),
      ('public.erhverv_faar_velkomst_gratis(uuid)', '8e5b6f6c9cf358c3f2464f07a94007be', 'a27872ee293058f8967446917e11a494'),
      ('public.erhverv_firma_abonnement_json(uuid)', 'cb42ee2f05003ac067e3adbc2bd48a02', '18c69445447e0ac186e362907fa88b3a'),
      ('public.erhverv_firma_opdater(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text)', '14c91b02360a6691dac4952afd2ae338', '6108621aaf83d963d33b57475e85eef0'),
      ('public.erhverv_cvr_tidligere_json(text)', '8ff536b05b05a83ddfe9d953f767df61', '7d49ca0fb1129571b8f2d1343bdf6dc5'),
      ('public.firma_kort_laas_kandidater(integer)', '8b98db5cfd17c5769b22b427ab8f72a1', 'd2ea7cf5f1647349ad1ea9c9b6cf4b3b')
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
end $do$;

-- ===========================================================================
-- 1. "Har betalt for abonnementet" - én definition
-- ===========================================================================
create or replace function public.erhverv_har_betalt_abonnement(p_firma uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.firma_regninger r
                  where r.firma_id = p_firma
                    and r.type in ('abonnement', 'opgradering')
                    and r.status in ('betalt', 'krediteret')
                    and r.beloeb_oere > 0);
$$;
revoke all on function public.erhverv_har_betalt_abonnement(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_har_betalt_abonnement(uuid) to service_role;
comment on function public.erhverv_har_betalt_abonnement(uuid) is
  'Har firmaet betalt for abonnementet? En regning (abonnement eller opgradering) med status betalt eller krediteret (betalt og refunderet) og beløb > 0. Én definition (velkomstfordel, CVR-skift, tidligere CVR). 20261102150000.';

-- ===========================================================================
-- 2. Har firmaet haft et abonnement?
-- ===========================================================================
create or replace function public.erhverv_firma_har_haft_abonnement(f public.firmaer)
returns boolean language sql stable security definer set search_path = '' as $$
  select f.stripe_subscription_id is not null
      or f.proeve_givet_kl is not null
      or f.abonnement_status in ('aktiv', 'pauset')
      or public.erhverv_har_betalt_abonnement(f.id);
$$;
revoke all on function public.erhverv_firma_har_haft_abonnement(public.firmaer) from public, anon, authenticated, service_role;
comment on function public.erhverv_firma_har_haft_abonnement(public.firmaer) is
  'Har firmaet haft et abonnement (Stripe-abonnement, gratis periode, betalt regning eller status aktiv/pauset)? abonnement_start bruges ikke - den er altid sat (default now()). 20261102150000.';

-- ===========================================================================
-- 3. Velkomstfordelen: brugt, når firmaet har betalt
-- ===========================================================================
create or replace function public.erhverv_faar_velkomst_gratis(p_firma uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select f.proeve_givet_kl is null and f.proeve_maaneder > 0
           and not public.erhverv_har_betalt_abonnement(f.id)
      from public.firmaer f where f.id = p_firma), false);
$$;
revoke all on function public.erhverv_faar_velkomst_gratis(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_faar_velkomst_gratis(uuid) to service_role;
comment on function public.erhverv_faar_velkomst_gratis(uuid) is
  'Har firmaet stadig ret til velkomstfordelen for måned 1? Kun når proeve_maaneder > 0 (0 for et CVR, der har haft abonnement før, uden særaftale), aldrig haft en gratis periode og aldrig betalt (erhverv_har_betalt_abonnement). Hvilken fordel: erhverv_maaned1. 20261102150000.';

-- ===========================================================================
-- 4. Regel for måned 1: særpris udelukker velkomstfordelen
-- ===========================================================================
create or replace function public.erhverv_maaned1(p_firma uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when not public.erhverv_faar_velkomst_gratis(f.id) then 'ingen'
                when public.erhverv_intro_gaelder(f) then 'ingen'
                when public.erhverv_saerpris_gaelder(f) then 'ingen'
                else coalesce(p.maaned1, 'halv') end
      from public.firmaer f
      left join public.erhverv_pakker p on p.id = f.pakke_id
     where f.id = p_firma), 'ingen');
$$;
revoke all on function public.erhverv_maaned1(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_maaned1(uuid) to service_role;
comment on function public.erhverv_maaned1(uuid) is
  'Velkomstfordelen i måned 1, når firmaet starter Checkout: gratis (Start), halv (Butik/Pro: 50 %) eller ingen. Introrabat eller særpris og velkomstfordel kombineres aldrig (Filip, 27. okt. 2026). 20261102150000.';

-- ===========================================================================
-- 5. Abonnement-JSON: samme regel
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
  -- (de erstatter 50 %-måneden). Særpris eller introrabat: ingen fordel.
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
    'introrabat', case when f.intro_procent is not null then jsonb_build_object(
                    'procent', f.intro_procent, 'maaneder', f.intro_maaneder, 'fra', f.intro_fra,
                    'status', f.intro_status, 'til', f.intro_til) end,
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
-- 6. CVR-historik
-- ===========================================================================
create table if not exists public.firma_cvr_historik (
  id                uuid primary key default gen_random_uuid(),
  firma_id          uuid not null references public.firmaer(id) on delete restrict,
  cvr               text not null check (cvr ~ '^[0-9]{8}$'),
  nyt_cvr           text not null check (nyt_cvr ~ '^[0-9]{8}$'),
  -- Havde firmaet haft et abonnement, da CVR'et blev ændret? (Kun da tæller
  -- det gamle CVR som "har haft abonnement før".)
  havde_abonnement  boolean not null,
  aendret_kl        timestamptz not null default now(),
  kilde             text not null default 'trigger' check (kilde in ('trigger', 'moderation_log'))
);
create unique index if not exists firma_cvr_historik_unik on public.firma_cvr_historik (firma_id, cvr, nyt_cvr, aendret_kl);
create index if not exists firma_cvr_historik_cvr_idx on public.firma_cvr_historik (cvr) where havde_abonnement;
comment on table public.firma_cvr_historik is
  'Tidligere CVR''er for et firma (handelsdata - slettes aldrig, kan kun indsættes). erhverv_cvr_tidligere_json slår også op her, så reglen om tidligere CVR (ingen velkomstfordel) ikke kan omgås ved at ændre CVR''et på det gamle firma. Kun service role. 20261102150000.';
alter table public.firma_cvr_historik enable row level security;
revoke all on public.firma_cvr_historik from public, anon, authenticated, service_role;
grant select on public.firma_cvr_historik to service_role;

create or replace function public.firmaer_cvr_historik_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.cvr is distinct from new.cvr and old.cvr ~ '^[0-9]{8}$' and new.cvr ~ '^[0-9]{8}$' then
    insert into public.firma_cvr_historik (firma_id, cvr, nyt_cvr, havde_abonnement)
    values (old.id, old.cvr, new.cvr, public.erhverv_firma_har_haft_abonnement(old))
    on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.firmaer_cvr_historik_trigger() from public, anon, authenticated, service_role;

drop trigger if exists firmaer_cvr_historik on public.firmaer;
create trigger firmaer_cvr_historik
  after update of cvr on public.firmaer
  for each row execute function public.firmaer_cvr_historik_trigger();

-- Eksisterende CVR-skift (logget af erhverv_firma_opdater siden
-- 20261102070000). Om firmaet havde haft et abonnement dengang, vides ikke -
-- firmaets tilstand nu bruges (forsigtigt: hellere ingen velkomstfordel end en
-- for meget). Én gang (unik på firma, CVR'er og tidspunkt).
insert into public.firma_cvr_historik (firma_id, cvr, nyt_cvr, havde_abonnement, aendret_kl, kilde)
select f.id, m[1], m[2], public.erhverv_firma_har_haft_abonnement(f), l.oprettet_kl, 'moderation_log'
  from public.moderation_log l
  cross join lateral regexp_matches(l.aarsag, 'CVR ændret: ([0-9]{8}) → ([0-9]{8})', 'g') as m
  join public.firmaer f on f.id = l.maal_id
 where l.maal_type = 'firma' and l.aarsag like '%CVR ændret:%'
on conflict do nothing;

-- Tidligere firmakonti med samme CVR, der har haft et abonnement - også et
-- firma, hvis CVR siden er ændret (historikken).
create or replace function public.erhverv_cvr_tidligere_json(p_cvr text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'firma_id', f.id, 'firmanavn', f.firmanavn, 'abonnement_status', f.abonnement_status,
           'abonnement_start', f.abonnement_start, 'opsagt_kl', f.opsagt_kl,
           'havde_gratis_periode', f.proeve_givet_kl is not null,
           'betalte_regninger', (select count(*) from public.firma_regninger r
                                  where r.firma_id = f.id and r.status = 'betalt' and r.beloeb_oere > 0),
           -- Sat, når firmaet har skiftet til et andet CVR siden.
           'nu_cvr', case when f.cvr <> p_cvr then f.cvr end)
         order by f.oprettet_kl desc), '[]'::jsonb)
    from public.firmaer f
   where (f.cvr = p_cvr and public.erhverv_firma_har_haft_abonnement(f))
      or exists (select 1 from public.firma_cvr_historik h
                  where h.firma_id = f.id and h.cvr = p_cvr and h.havde_abonnement);
$$;
revoke all on function public.erhverv_cvr_tidligere_json(text) from public, anon, authenticated, service_role;
comment on function public.erhverv_cvr_tidligere_json(text) is
  'Tidligere firmakonti med samme CVR, der har haft et abonnement (erhverv_firma_har_haft_abonnement) - også via CVR-historikken (firma_cvr_historik). betalte_regninger = regninger med status betalt og beløb > 0. 20261102150000.';

-- ===========================================================================
-- 7. Firmaoplysninger: én definition af "har betalt"
-- ===========================================================================
create or replace function public.erhverv_firma_opdater(p_staff uuid, p_firma uuid, p_pakke uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_firmanavn text DEFAULT NULL::text, p_cvr text DEFAULT NULL::text, p_adresse text DEFAULT NULL::text, p_postnummer text DEFAULT NULL::text, p_by text DEFAULT NULL::text, p_telefon text DEFAULT NULL::text, p_kontakt_email text DEFAULT NULL::text, p_kontaktperson text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f        public.firmaer;
  v_tekst  text[] := '{}';
  v_pakke  uuid;
  v_status text;
  v_navn   text := nullif(btrim(p_firmanavn), '');
  v_cvr    text;
  v_fjern_velkomst boolean := false;
begin
  -- Chef og saelger (Filip, 10. okt. 2026: begge må alt ved firmaer).
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_status is not null and p_status not in ('aktiv', 'pauset', 'opsagt') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if p_pakke is not null and p_pakke is distinct from f.pakke_id
     and not exists (select 1 from public.erhverv_pakker where id = p_pakke and arkiveret_kl is null) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_cvr is not null and p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;

  -- Kun egentlige ændringer tæller (en formular sender ofte alle felter).
  v_pakke  := case when p_pakke is distinct from f.pakke_id then p_pakke end;
  v_status := case when p_status is distinct from f.abonnement_status then p_status end;
  v_cvr    := case when p_cvr is distinct from f.cvr then p_cvr end;
  if v_navn is not distinct from f.firmanavn then
    v_navn := null;
  end if;

  -- Nyt CVR, der har haft et abonnement før, på et firma, der ikke er
  -- startet: ingen velkomstfordel (som ved oprettelse uden særaftale - Filip,
  -- 27. okt. 2026). Tjekkes FØR opdateringen (så firmaet selv ikke tæller).
  -- Det gamle CVR gemmes i firma_cvr_historik (trigger), så det stadig tæller
  -- som "har haft abonnement", hvis firmaet havde et.
  if v_cvr is not null
     and f.stripe_subscription_id is null
     and f.proeve_givet_kl is null
     and f.proeve_maaneder > 0
     and not public.erhverv_har_betalt_abonnement(f.id)
     and jsonb_array_length(public.erhverv_cvr_tidligere_json(v_cvr)) > 0 then
    v_fjern_velkomst := true;
  end if;

  begin
    update public.firmaer
       set firmanavn      = coalesce(v_navn, firmanavn),
           cvr            = coalesce(v_cvr, cvr),
           adresse        = coalesce(nullif(btrim(p_adresse), ''), adresse),
           postnummer     = coalesce(nullif(btrim(p_postnummer), ''), postnummer),
           bynavn         = coalesce(nullif(btrim(p_by), ''), bynavn),
           telefon        = coalesce(nullif(btrim(p_telefon), ''), telefon),
           kontakt_email  = coalesce(lower(nullif(btrim(p_kontakt_email), '')), kontakt_email),
           kontaktperson  = coalesce(nullif(btrim(p_kontaktperson), ''), kontaktperson),
           abonnement_status = coalesce(v_status, abonnement_status),
           pauset_aarsag  = case when v_status is null then pauset_aarsag
                                 when v_status = 'pauset' then 'bidhamr' else null end,
           opsagt_kl      = case when v_status = 'opsagt' then coalesce(opsagt_kl, now())
                                 when v_status is not null then null else opsagt_kl end,
           pakke_id       = coalesce(v_pakke, pakke_id),
           naeste_pakke_id  = case when v_pakke is not null then null else naeste_pakke_id end,
           naeste_pakke_fra = case when v_pakke is not null then null else naeste_pakke_fra end,
           saerpris_oere    = case when v_pakke is not null then null else saerpris_oere end,
           saerpris_pakke_id = case when v_pakke is not null then null else saerpris_pakke_id end,
           saerpris_aftale  = case when v_pakke is not null then null else saerpris_aftale end,
           proeve_maaneder = case when v_fjern_velkomst then 0 else proeve_maaneder end,
           opdateret_kl   = now()
     where id = p_firma;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  if v_navn is not null then
    update public.users set navn = left(v_navn, 200) where id = f.bruger_id;
  end if;

  if v_pakke is not null then
    update public.firma_pakkeskift
       set status = case when til_pakke_id = v_pakke and status = 'afventer_betaling' then 'gennemfoert' else 'annulleret' end,
           behandlet_kl = now(),
           note = coalesce(note, 'Afgjort af BidHamr')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl, note)
    values (f.id, f.pakke_id, v_pakke, 'bidhamr', 'gennemfoert', p_staff, now(), left(p_note, 1000));
    v_tekst := v_tekst || ('Pakke ændret: ' || coalesce((select navn from public.erhverv_pakker where id = f.pakke_id), '?')
                           || ' → ' || coalesce((select navn from public.erhverv_pakker where id = v_pakke), '?')
                           || case when f.saerpris_oere is not null then ' (særprisen er bortfaldet)' else '' end);
  end if;
  if v_status is not null then
    v_tekst := v_tekst || ('Status: ' || f.abonnement_status || ' → ' || v_status);
  end if;
  -- Gammelt og nyt CVR logges altid.
  if v_cvr is not null then
    v_tekst := v_tekst || ('CVR ændret: ' || f.cvr || ' → ' || v_cvr);
  end if;
  if v_fjern_velkomst then
    v_tekst := v_tekst || 'Velkomstfordelen for måned 1 er fjernet, fordi det nye CVR har haft et abonnement før (giv evt. gratis måneder som særaftale)'::text;
  end if;
  if coalesce(v_navn, v_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, case when v_pakke is not null then 'firma_pakke_skiftet' else 'firma_opdateret' end,
          'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok', 'velkomst_fjernet', v_fjern_velkomst);
end $function$;
revoke all on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ===========================================================================
-- 8. Kun kort: højst 3 forsøg pr. abonnement ved permanente Stripe-fejl
-- ===========================================================================
alter table public.firmaer add column if not exists kort_laas_fejl_sub text;
alter table public.firmaer add column if not exists kort_laas_forsoeg integer not null default 0;
comment on column public.firmaer.kort_laas_fejl_sub is
  'Abonnementet, som låsen til kun kort fejlede på (permanent Stripe-fejl). Intern. 20261102150000.';
comment on column public.firmaer.kort_laas_forsoeg is
  'Antal permanente fejl ved låsen til kun kort på kort_laas_fejl_sub. Ved 3 opgives det (én drift-alarm). Intern. 20261102150000.';

create or replace function public.firma_kort_laas_kandidater(p_graense integer default 20)
returns table (firma_id uuid, subscription_id text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_subscription_id from public.firmaer f
   where f.stripe_subscription_id is not null
     and f.kort_laast_sub is distinct from f.stripe_subscription_id
     and coalesce(f.stripe_abonnement_status, '') not in ('canceled', 'incomplete_expired')
     -- Opgivet efter 3 permanente fejl på netop dette abonnement.
     and not (f.kort_laas_fejl_sub is not distinct from f.stripe_subscription_id and f.kort_laas_forsoeg >= 3)
   order by f.stripe_synk_forsoegt_kl nulls first, f.opdateret_kl
   limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;
revoke all on function public.firma_kort_laas_kandidater(integer) from public, anon, authenticated;
grant execute on function public.firma_kort_laas_kandidater(integer) to service_role;

-- En permanent fejl: tæller op (nulstilles for et nyt abonnement). Svar:
-- forsoeg (antal nu) og opgivet (true netop ved 3. fejl - så gives én alarm).
create or replace function public.firma_kort_laas_fejl(p_firma uuid, p_subscription_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_antal integer;
begin
  update public.firmaer
     set kort_laas_forsoeg = case when kort_laas_fejl_sub is not distinct from p_subscription_id
                                  then kort_laas_forsoeg + 1 else 1 end,
         kort_laas_fejl_sub = left(p_subscription_id, 255)
   where id = p_firma and stripe_subscription_id = p_subscription_id
  returning kort_laas_forsoeg into v_antal;
  if v_antal is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  return jsonb_build_object('kode', 'ok', 'forsoeg', v_antal, 'opgivet', v_antal >= 3);
end $$;
revoke all on function public.firma_kort_laas_fejl(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_kort_laas_fejl(uuid, text) to service_role;

-- Er låsen opgivet for abonnementet? (webhooken prøver så ikke igen.)
create or replace function public.firma_kort_laas_opgivet(p_firma uuid, p_subscription_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select f.kort_laas_fejl_sub is not distinct from p_subscription_id and f.kort_laas_forsoeg >= 3
                     from public.firmaer f where f.id = p_firma), false);
$$;
revoke all on function public.firma_kort_laas_opgivet(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_kort_laas_opgivet(uuid, text) to service_role;

notify pgrst, 'reload schema';
