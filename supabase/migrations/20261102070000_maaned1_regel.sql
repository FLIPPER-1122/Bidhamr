-- Ny regel for måned 1 (Filip, 27. okt. 2026) - erstatter "1 måned gratis på
-- alle pakker":
--   - Start: måned 1 er gratis (trial på 1 måned i Stripe Checkout).
--   - Butik og Pro: ingen gratis måned. Måned 1 koster 50 % (engangskupon
--     bidhamr_velkomst_50_once, duration 'once', sat på i Checkout), og fra
--     måned 2 fuld pris. Firmaet får aldrig Butik/Pro gratis.
--   - Introrabat (firmaer, Filip selv har kontaktet): 50 % i måned 1-6 på enhver
--     pakke og INGEN velkomstfordel oveni. Fra måned 7 fuld pris.
--   - CVR, der har haft abonnement før: ingen velkomstfordel (proeve_maaneder =
--     0), medmindre staff giver en særaftale - så gælder pakkens regel.
--   - Staffs "gratis periode" er stadig en bevidst særaftale (rigtige gratis
--     måneder). Får et Butik/Pro-firma staff-givne gratis måneder før start,
--     erstatter de 50 %-måneden (ingen dobbelt rabat).
--
-- Bygger på 20261102010000-20261102050000 (rettes ikke). Rører IKKE grants på
-- users/auctions (20261102060000_sikkerhed_stramning.sql).
--
-- Indhold:
--   1. erhverv_pakker.maaned1 ('gratis' | 'halv', standard 'halv' - en ny
--      pakke er aldrig gratis i måned 1). Start (7e57a000-...-0001) = 'gratis'.
--   2. firmaer.kort_laast_sub: abonnementet er låst til kun kort i Stripe
--      (payment_settings.payment_method_types = ['card']). Betalings-cron'en
--      tager dem, der mangler (firma_kort_laas_kandidater / firma_kort_laast).
--   3. proeve_maaneder betyder nu kun "har ret til velkomstfordelen" (0/1).
--      Staff-givne måneder før start lægges altid i proeve_ekstra_ventende
--      (erhverv_firma_gratis_gem). Eksisterende firmaer uden abonnement med
--      proeve_maaneder > 1 flyttes: overskydende måneder -> proeve_ekstra_ventende.
--   4. erhverv_faar_velkomst_gratis: et firma, der har betalt en regning, som
--      siden er refunderet (krediteret), har også brugt velkomstfordelen.
--   5. erhverv_maaned1(firma): 'gratis' | 'halv' | 'ingen' - ÉN definition, som
--      startBetaling (src/lib/erhverv/betaling.ts) og Firma oversigt bruger.
--   6. erhverv_firma_abonnement_json: gratis_maaneder_ved_start og maaned1.
--   7. erhverv_firma_opret: logtekst og svar efter den nye regel (maaned1).
--   8. erhverv_firma_opdater (review af 20261102050000): ændres CVR'et på et
--      firma, der ikke er startet, til et CVR, der har haft abonnement før,
--      fjernes velkomstfordelen (som ved oprettelse uden særaftale). Gammelt og
--      nyt CVR logges altid.
--
-- md5-drift-tjek: hver funktion, der erstattes, skal enten være repoets
-- (seneste migration) eller allerede denne migrations. Ellers afbrydes (intet
-- ændres). Idempotent. Én transaktion. Kør først på testdatabasen. KØRES IKKE
-- i produktion uden Filips "ja".

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
  if to_regprocedure('public.erhverv_cvr_tidligere_json(text)') is null
     or to_regprocedure('public.erhverv_intro_gaelder(public.firmaer)') is null
     or to_regprocedure('public.firma_gratis_afstemt(uuid,text)') is null then
    raise exception 'Forudsætning mangler: kør 20261102020000-20261102050000 først';
  end if;
  for r in
    select * from (values
      -- (funktion, repoets, denne migrations)
      ('public.erhverv_pakke_json(uuid)', '2c2657449c70284977e335a511c75955', '7d6d56b17b62ecab27dbba4f548f996a'),
      ('public.erhverv_faar_velkomst_gratis(uuid)', '651348446c205d41dfabeca2452e3cb0', '8e5b6f6c9cf358c3f2464f07a94007be'),
      ('public.erhverv_firma_gratis_gem(uuid,uuid,integer,text,boolean,timestamptz,uuid)', 'c358f5e2b52c0c7c0ea07c175b39d40a', '31e13403010f172d2495d880455cdb24'),
      ('public.erhverv_firma_abonnement_json(uuid)', '4553e215f6ea0634747ff417fcd2de34', 'cb42ee2f05003ac067e3adbc2bd48a02'),
      ('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text)', '46cbc2c677a240e8368ef8736a523009', '12c6c174d886f29ad7f87df4bf57e64d'),
      ('public.erhverv_firma_opdater(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'df967d6473927589bb83acda8e55d1a5', '14c91b02360a6691dac4952afd2ae338')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
    end if;
    if h <> r.gammel and h <> r.ny then
      raise exception '%: md5 % passer hverken med repoet (%) eller denne migration (%) - kontrollér funktionen, før migrationen køres',
        r.fn, h, r.gammel, r.ny;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Pakkens regel for måned 1
-- ===========================================================================
alter table public.erhverv_pakker add column if not exists maaned1 text not null default 'halv';
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_maaned1_check;
alter table public.erhverv_pakker add constraint erhverv_pakker_maaned1_check check (maaned1 in ('gratis', 'halv'));
update public.erhverv_pakker set maaned1 = 'gratis'
 where id = '7e57a000-0000-4000-8000-000000000001'::uuid and maaned1 <> 'gratis';
comment on column public.erhverv_pakker.maaned1 is
  'Velkomstfordelen i måned 1 (Filip, 27. okt. 2026): ''gratis'' (Start: første måned gratis) eller ''halv'' (Butik/Pro: første måned til 50 %). Standard ''halv'' - en ny pakke er aldrig gratis. 20261102070000.';

-- Pakke-JSON med regel for måned 1 (pakkeoversigt, Opret firmakonto).
create or replace function public.erhverv_pakke_json(p_pakke uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'navn', p.navn, 'beskrivelse', p.beskrivelse,
                            'maanedspris', p.maanedspris,
                            -- Bagudkompatibelt felt (ugekvoten er afløst af månedskvoten).
                            'auktioner_pr_uge', p.auktioner_pr_uge,
                            'auktioner_pr_maaned', p.auktioner_pr_maaned,
                            'ubegraenset', p.auktioner_pr_maaned is null,
                            'fremhaevninger_pr_maaned', p.fremhaevninger_pr_maaned,
                            'statistik', p.statistik,
                            'fast_kontaktperson', p.fast_kontaktperson,
                            'ugens_butik_rabat_procent', p.ugens_butik_rabat_procent,
                            'ugens_butik_rabat_antal', p.ugens_butik_rabat_antal,
                            'maaned1', p.maaned1,
                            'aktiv', p.aktiv,
                            'arkiveret', p.arkiveret_kl is not null)
    from public.erhverv_pakker p where p.id = p_pakke;
$$;
revoke all on function public.erhverv_pakke_json(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 2. Abonnementet låst til kun kort
-- ===========================================================================
alter table public.firmaer add column if not exists kort_laast_sub text;
comment on column public.firmaer.kort_laast_sub is
  'Det abonnement, der er låst til kun kort i Stripe (payment_settings.payment_method_types = [card]). Intern - kun service role. 20261102070000.';

create or replace function public.firma_kort_laas_kandidater(p_graense integer default 20)
returns table (firma_id uuid, subscription_id text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_subscription_id from public.firmaer f
   where f.stripe_subscription_id is not null
     and f.kort_laast_sub is distinct from f.stripe_subscription_id
     and coalesce(f.stripe_abonnement_status, '') not in ('canceled', 'incomplete_expired')
   order by f.stripe_synk_forsoegt_kl nulls first, f.opdateret_kl
   limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;
revoke all on function public.firma_kort_laas_kandidater(integer) from public, anon, authenticated;
grant execute on function public.firma_kort_laas_kandidater(integer) to service_role;

create or replace function public.firma_kort_laast(p_firma uuid, p_subscription_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.firmaer set kort_laast_sub = left(p_subscription_id, 255)
   where id = p_firma and stripe_subscription_id = p_subscription_id
     and kort_laast_sub is distinct from p_subscription_id;
  return jsonb_build_object('kode', case when found then 'ok' else 'allerede' end);
end $$;
revoke all on function public.firma_kort_laast(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_kort_laast(uuid, text) to service_role;

-- Fakturaen: alle Stripe-kunder sendes igen én gang (CVR som eget felt på
-- fakturaen - synkKundeStripe), markeret med stripe_kunde_felter = 1.
alter table public.firmaer add column if not exists stripe_kunde_felter integer not null default 0;
comment on column public.firmaer.stripe_kunde_felter is
  'Version af fakturafelterne på Stripe-kunden (1 = CVR som eget felt, 20261102070000). Intern.';
update public.firmaer
   set stripe_kunde_version = stripe_kunde_version + 1, stripe_kunde_felter = 1
 where stripe_customer_id is not null and stripe_kunde_felter < 1;

-- ===========================================================================
-- 3. Staff-givne måneder før start: altid proeve_ekstra_ventende
-- ===========================================================================
-- Eksisterende firmaer, der ikke er startet: velkomst = 1, resten venter.
update public.firmaer
   set proeve_ekstra_ventende = least(proeve_ekstra_ventende + (proeve_maaneder - 1), 24),
       proeve_maaneder = 1,
       opdateret_kl = now()
 where stripe_subscription_id is null
   and proeve_givet_kl is null
   and proeve_maaneder > 1;

-- ===========================================================================
-- 4. Velkomstfordelen er brugt, når firmaet har betalt (også refunderet)
-- ===========================================================================
create or replace function public.erhverv_faar_velkomst_gratis(p_firma uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select f.proeve_givet_kl is null and f.proeve_maaneder > 0
           and not exists (select 1 from public.firma_regninger r
                            where r.firma_id = f.id and r.type = 'abonnement'
                              and r.status in ('betalt', 'krediteret')
                              and r.beloeb_oere > 0)
      from public.firmaer f where f.id = p_firma), false);
$$;
revoke all on function public.erhverv_faar_velkomst_gratis(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_faar_velkomst_gratis(uuid) to service_role;
comment on function public.erhverv_faar_velkomst_gratis(uuid) is
  'Har firmaet stadig ret til velkomstfordelen for måned 1? Kun når proeve_maaneder > 0 (0 for et CVR, der har haft abonnement før, uden særaftale), aldrig haft en gratis periode og aldrig betalt (heller ikke refunderet). Hvilken fordel: erhverv_maaned1. 20261102070000.';

-- ===========================================================================
-- 5. Regel for måned 1 for et firma
-- ===========================================================================
-- 'gratis': Start - første måned gratis (trial 1 måned).
-- 'halv'  : Butik/Pro - første måned til 50 % (engangskupon).
-- 'ingen' : ingen velkomstfordel (brugt, tidligere CVR uden særaftale, eller en
--           introrabat, der gælder fra måned 1 i stedet).
-- Staff-givne gratis måneder (proeve_ekstra_ventende) er særaftaler og
-- regnes ikke med her (startBetaling: får et 'halv'-firma dem, erstatter de
-- 50 %-måneden).
create or replace function public.erhverv_maaned1(p_firma uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when not public.erhverv_faar_velkomst_gratis(f.id) then 'ingen'
                when public.erhverv_intro_gaelder(f) then 'ingen'
                else coalesce(p.maaned1, 'halv') end
      from public.firmaer f
      left join public.erhverv_pakker p on p.id = f.pakke_id
     where f.id = p_firma), 'ingen');
$$;
revoke all on function public.erhverv_maaned1(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_maaned1(uuid) to service_role;
comment on function public.erhverv_maaned1(uuid) is
  'Velkomstfordelen i måned 1, når firmaet starter Checkout: gratis (Start), halv (Butik/Pro: 50 %) eller ingen. Introrabat og velkomstfordel kombineres aldrig. 20261102070000.';

-- ===========================================================================
-- 6. Gratis periode uden abonnement: altid ventende (særaftale)
-- ===========================================================================
create or replace function public.erhverv_firma_gratis_gem(p_staff uuid, p_firma uuid, p_maaneder integer,
                                                           p_begrundelse text, p_stripe boolean,
                                                           p_proeve_slut timestamptz, p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f          public.firmaer;
  v_hvor     text;
  v_start    integer := 0;
  v_maaned1  text;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_begrundelse) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_maaneder is null or p_maaneder not between 1 and 12 then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_stripe then
    if p_proeve_slut is null then
      raise exception 'Mangler trial_end fra Stripe';
    end if;
    v_hvor := 'stripe';
  else
    if f.stripe_subscription_id is not null
       or not (f.abonnement_status = 'afventer_betaling'
               or (f.abonnement_status = 'pauset' and f.pauset_aarsag = 'betaling')) then
      return jsonb_build_object('kode', 'kan_ikke_starte');
    end if;
    -- Staff-givne måneder er en særaftale og venter altid til Checkout
    -- (20261102070000). Start lægger velkomstmåneden oveni; for Butik/Pro
    -- erstatter de 50 %-måneden.
    v_maaned1 := public.erhverv_maaned1(f.id);
    v_start := f.proeve_ekstra_ventende + p_maaneder
               + (case when v_maaned1 = 'gratis' then least(f.proeve_maaneder, 1) else 0 end);
    if v_start > 24 then
      return jsonb_build_object('kode', 'for_lang');
    end if;
    v_hvor := 'ventende';
  end if;

  if not public.erhverv_staff_klik_tag(p_klik, 'firma_gratis_periode', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;

  if v_hvor = 'stripe' then
    update public.firmaer
       set proeve_slut = p_proeve_slut, stripe_abonnement_status = 'trialing',
           proeve_givet_kl = coalesce(proeve_givet_kl, now()), opdateret_kl = now()
     where id = f.id;
  else
    update public.firmaer set proeve_ekstra_ventende = proeve_ekstra_ventende + p_maaneder, opdateret_kl = now()
     where id = f.id;
  end if;
  perform public.erhverv_firma_log(p_staff, f.id, 'firma_gratis_periode',
    format('+%s gratis måned%s%s: %s', p_maaneder, case when p_maaneder = 1 then '' else 'er' end,
           case when v_hvor = 'stripe'
                then ' (gratis til ' || to_char(p_proeve_slut at time zone 'Europe/Copenhagen', 'DD.MM.YYYY') || ')'
                else format(' (%s gratis måneder, når abonnementet starter)', v_start) end,
           btrim(p_begrundelse)));
  return jsonb_build_object('kode', 'ok', 'hvor', v_hvor,
                            'proeve_maaneder', f.proeve_maaneder,
                            'gratis_maaneder_ved_start', v_start);
end $$;
revoke all on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) to service_role;
comment on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) is
  'Staff giver +N gratis måneder (chef og sælger-rollen) - en særaftale. Stripe-delen: givGratisPeriodeStripe i src/lib/erhverv/betaling.ts. Uden abonnement: proeve_ekstra_ventende (bruges i Checkout) - eller ''kan_ikke_starte''. 20261102070000.';

-- ===========================================================================
-- 7. Abonnement-JSON: gratis måneder ved start og regel for måned 1
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
  -- (de erstatter 50 %-måneden).
  v_maaned1 := case when f.stripe_subscription_id is not null then null
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
-- 8. Oprettelse: logtekst og svar efter reglen for måned 1
-- ===========================================================================
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text,
  p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid default null,
  p_intro_procent integer default null, p_intro_maaneder integer default null,
  p_cvr_bekraeftet boolean default null,
  p_saeraftale_gratis boolean default false, p_saeraftale_begrundelse text default null)
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
  -- Start gratis, Butik/Pro 50 %. En introrabat erstatter fordelen.
  v_saeraftale_brugt := v_har_tidligere and v_saeraftale;
  v_gratis := case when not v_har_tidligere or v_saeraftale_brugt then 1 else 0 end;
  v_maaned1 := case when v_gratis = 0 or p_intro_procent is not null then 'ingen' else v_pakke_maaned1 end;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af,
                                proeve_maaneder, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff, v_gratis, p_intro_procent, p_intro_maaneder,
            case when p_intro_procent is not null then 'efter_gratis' end,
            case when p_intro_procent is not null then 'planlagt' end,
            case when p_intro_procent is not null then gen_random_uuid() end)
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
               || case when p_intro_procent is not null
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
                            'saeraftale', v_saeraftale_brugt);
end $function$;
revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) to service_role;
comment on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) is
  'Opretter en firmakonto (chef og sælger-rollen). Velkomstfordel for måned 1 efter pakken (Start gratis, Butik/Pro 50 %); et CVR, der har haft et abonnement før, får ingen (proeve_maaneder = 0) - kun som særaftale (begrundelse 5-500 tegn, logges med staffs navn). En introrabat gælder fra måned 1 i stedet. Svar: maaned1. 20261102070000.';

comment on column public.firmaer.proeve_maaneder is
  'Ret til velkomstfordelen for måned 1: 1 for nye CVR''er, 0 for et CVR, der har haft et abonnement før (medmindre staff gav en særaftale). Fordelen afgøres af pakken (erhverv_maaned1: Start gratis, Butik/Pro 50 %). Staff-givne gratis måneder: proeve_ekstra_ventende. 20261102070000.';

-- ===========================================================================
-- 9. Firmaoplysninger: CVR-skift kan ikke omgå reglen om tidligere CVR
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
  if v_cvr is not null
     and f.stripe_subscription_id is null
     and f.proeve_givet_kl is null
     and f.proeve_maaneder > 0
     and not exists (select 1 from public.firma_regninger r
                      where r.firma_id = f.id and r.status in ('betalt', 'krediteret') and r.beloeb_oere > 0)
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

notify pgrst, 'reload schema';
