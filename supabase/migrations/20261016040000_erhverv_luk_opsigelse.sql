-- Erhverv: automatisk opsigelse af abonnementet, når en firmakonto lukkes
-- permanent, og nye adgangsregler for firmaer i admin (Filip, 10. okt. 2026).
--
--   1. Opsigelse ved permanent lukning. Når en firmakonto lukkes permanent
--      (users.konto_lukket_kl sættes af bruger_luk_konto_permanent - via
--      konto_lukning_godkend/3 advarsler eller DSA-indgrebet "luk konto"),
--      opsiger serveren abonnementet i Stripe MED DET SAMME (ingen refusion for
--      resten af perioden). Selve lukningen røres ikke her: fejler Stripe,
--      står kontoen stadig lukket, og betalings-cron'en prøver igen.
--      Kandidaterne findes ud fra TILSTANDEN (lukket konto + abonnement, der
--      ikke er afsluttet i Stripe), ikke ud fra en markering sat ved lukningen.
--      Så fanges alle veje til lukning - også fremtidige - og et abonnement,
--      der opstår efter lukningen (fx en åben Checkout, der betales bagefter).
--      Nye kolonner på firmaer (kun service role):
--        luk_opsigelse_forsoeg    antal mislykkede forsøg
--        luk_opsigelse_naeste_kl  tidligste næste forsøg (cron, eksponentiel
--                                 ventetid 5 min -> højst 6 timer)
--        luk_opsigelse_fejl       sidste fejl (til drift)
--        luk_opsigelse_kl         hvornår abonnementet blev opsagt pga. lukningen
--      Funktioner (kun service role):
--        firma_luk_opsigelse_kandidater(p_bruger, p_graense)
--        firma_luk_opsigelse_fejl(p_firma, p_subscription_id, p_fejl)
--        firma_luk_opsigelse_udfoert(p_firma, p_subscription_id)
--      bruger_luk_konto_permanent røres IKKE (en anden migration,
--      20261016020000, ændrer den).
--   2. "Både chefen og rollen sælger skal kunne gøre alt ved firmaer" (Filip,
--      10. okt. 2026): erhverv_firma_opdater kræver ikke længere chef for
--      pakke, status, firmanavn og CVR - chef og saelger må det samme
--      (erhverv_har_adgang uden p_kun_chef). Pakker og priser
--      (erhverv_pakke_gem) er stadig kun chef. Erstattes med md5-drift-tjek.
--
-- Idempotent (kan køres flere gange). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Opsigelse ved permanent lukning
-- ---------------------------------------------------------------------------
alter table public.firmaer add column if not exists luk_opsigelse_forsoeg integer not null default 0;
alter table public.firmaer add column if not exists luk_opsigelse_naeste_kl timestamptz;
alter table public.firmaer add column if not exists luk_opsigelse_fejl text;
alter table public.firmaer add column if not exists luk_opsigelse_kl timestamptz;

comment on column public.firmaer.luk_opsigelse_forsoeg is
  'Mislykkede forsøg på at opsige abonnementet i Stripe efter permanent lukning af kontoen. Kun service role.';
comment on column public.firmaer.luk_opsigelse_naeste_kl is
  'Tidligste næste forsøg på opsigelse efter lukning (betalings-cron). Kun service role.';
comment on column public.firmaer.luk_opsigelse_fejl is
  'Sidste fejl fra Stripe ved opsigelse efter lukning (uden persondata). Kun service role.';
comment on column public.firmaer.luk_opsigelse_kl is
  'Abonnementet blev opsagt med det samme i Stripe, fordi kontoen blev lukket permanent. Kun service role.';

-- Lukkede firmakonti, hvis abonnement ikke er afsluttet i Stripe.
-- p_bruger sat: kun den bruger og uden ventetid (serveren lige efter
-- lukningen). Ellers: dem, hvis ventetid er udløbet, ældste lukning først.
create or replace function public.firma_luk_opsigelse_kandidater(
  p_bruger uuid default null, p_graense integer default 20)
returns table (firma_id uuid, bruger_id uuid, subscription_id text, forsoeg integer, konto_lukket_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.bruger_id, f.stripe_subscription_id, f.luk_opsigelse_forsoeg, u.konto_lukket_kl
    from public.firmaer f
    join public.users u on u.id = f.bruger_id
   where u.konto_lukket_kl is not null
     and f.stripe_subscription_id is not null
     and coalesce(f.stripe_abonnement_status, '') not in ('canceled', 'incomplete_expired')
     and (case when p_bruger is not null then f.bruger_id = p_bruger
               else f.luk_opsigelse_naeste_kl is null or f.luk_opsigelse_naeste_kl <= now() end)
   order by f.luk_opsigelse_naeste_kl nulls first, u.konto_lukket_kl
   limit greatest(1, least(coalesce(p_graense, 20), 100));
$$;

revoke all on function public.firma_luk_opsigelse_kandidater(uuid, integer) from public, anon, authenticated;
grant execute on function public.firma_luk_opsigelse_kandidater(uuid, integer) to service_role;

-- Stripe-kaldet fejlede: tæl op og vent (5 min, 10, 20 ... højst 6 timer).
-- Kun når abonnementet stadig er firmaets. Svar: {kode, forsoeg}.
create or replace function public.firma_luk_opsigelse_fejl(
  p_firma uuid, p_subscription_id text, p_fejl text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_forsoeg integer;
begin
  update public.firmaer
     set luk_opsigelse_forsoeg = luk_opsigelse_forsoeg + 1,
         luk_opsigelse_naeste_kl = now() + least(interval '6 hours',
                                                 interval '5 minutes' * power(2, least(luk_opsigelse_forsoeg, 10))),
         luk_opsigelse_fejl = left(coalesce(p_fejl, 'Ukendt fejl'), 1000),
         opdateret_kl = now()
   where id = p_firma
     and stripe_subscription_id = p_subscription_id
  returning luk_opsigelse_forsoeg into v_forsoeg;
  if not found then
    return jsonb_build_object('kode', 'ukendt_abonnement');
  end if;
  return jsonb_build_object('kode', 'ok', 'forsoeg', v_forsoeg);
end $$;

revoke all on function public.firma_luk_opsigelse_fejl(uuid, text, text) from public, anon, authenticated;
grant execute on function public.firma_luk_opsigelse_fejl(uuid, text, text) to service_role;

-- Abonnementet er afsluttet i Stripe (serveren har tjekket det). Spejlingen
-- af selve statussen sker i firma_stripe_abonnement_spejl (webhooken og
-- serveren); her nulstilles forsøgene, og det logges én gang.
-- Svar: {kode: 'ok' | 'allerede' | 'ukendt_abonnement'}.
create or replace function public.firma_luk_opsigelse_udfoert(
  p_firma uuid, p_subscription_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null or f.stripe_subscription_id is distinct from p_subscription_id then
    return jsonb_build_object('kode', 'ukendt_abonnement');
  end if;
  if f.luk_opsigelse_kl is not null and f.luk_opsigelse_forsoeg = 0 then
    return jsonb_build_object('kode', 'allerede');
  end if;
  update public.firmaer
     set luk_opsigelse_kl = coalesce(luk_opsigelse_kl, now()),
         luk_opsigelse_forsoeg = 0,
         luk_opsigelse_naeste_kl = null,
         luk_opsigelse_fejl = null,
         opdateret_kl = now()
   where id = f.id;
  if f.luk_opsigelse_kl is null then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'firma_opdateret', 'firma', f.id, f.bruger_id,
            left('Abonnementet er afsluttet i Stripe (kontoen er lukket permanent); '
                 || f.firmanavn || ' (CVR ' || f.cvr || ')', 1000));
  end if;
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.firma_luk_opsigelse_udfoert(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_luk_opsigelse_udfoert(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. erhverv_firma_opdater: chef og saelger må det samme
-- ---------------------------------------------------------------------------
-- Drift-tjek: kroppen skal være den fra 20261010031000 (gammel) eller den
-- herunder (ny - så filen kan køres igen). md5 af prosrc med LF-linjeskift.
do $$
declare
  v_md5 text;
begin
  select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_md5
    from pg_proc p
   where p.oid = 'public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text)'::regprocedure;
  if v_md5 is distinct from '43870dfc3b3783e80ffb93305224c493'
     and v_md5 is distinct from 'aee2b50af3dc7a44ddbb93a4f23d85c7' then
    raise exception 'erhverv_firma_opdater er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

-- Som 20261010031000, men uden 'kun_chef': chef og saelger må ændre pakke,
-- status, firmanavn, CVR, adresse og kontaktoplysninger.
create or replace function public.erhverv_firma_opdater(
  p_staff uuid, p_firma uuid, p_pakke uuid default null, p_status text default null,
  p_firmanavn text default null, p_cvr text default null, p_adresse text default null,
  p_postnummer text default null, p_by text default null, p_telefon text default null,
  p_kontakt_email text default null, p_kontaktperson text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.firmaer;
  v_tekst  text[] := '{}';
  v_pakke  uuid;
  v_status text;
  v_navn   text := nullif(btrim(p_firmanavn), '');
  v_cvr    text;
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
  if p_pakke is not null and not exists (select 1 from public.erhverv_pakker where id = p_pakke) then
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
    v_tekst := v_tekst || 'Pakke ændret'::text;
  end if;
  if v_status is not null then
    v_tekst := v_tekst || ('Status: ' || f.abonnement_status || ' → ' || v_status);
  end if;
  if coalesce(v_navn, v_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_opdateret', 'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;
