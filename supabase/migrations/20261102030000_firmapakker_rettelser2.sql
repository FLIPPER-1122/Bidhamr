-- Firmapakker: anden runde rettelser efter reviewerens gennemgang (27. okt. 2026).
--
-- Bygger på 20261102020000_firmapakker_rettelser.sql (rettes ikke - den er
-- kørt på testdatabasen). Stripe-delen: src/lib/erhverv/betaling.ts
-- (afstemGratisVedStart, efterStart, lukAabneCheckout, anvendIntro).
--
-- Indhold:
--   1. Gratis måneder, staff giver, mens firmaet har en åben Checkout-session
--      (fund 2). Staff-handlingen lukker nu firmaets åbne sessioner
--      (lukAabneCheckout), så næste session har det rigtige antal. Når firmaet
--      alligevel gennemfører en gammel session (eller webhooken kommer, efter
--      at staff har givet måneder), lægger afstemGratisVedStart de manglende
--      måneder på abonnementet ved start - i ÉT Stripe-kald, der også skriver
--      de nye antal i abonnementets metadata (gratis_velkomst, gratis_ekstra).
--      Databasen:
--        a. firma_gratis_ekstra_brugt(p_antal) betyder nu "i alt brugt på DETTE
--           abonnement" (fra abonnementets metadata gratis_ekstra): der trækkes
--           kun forskellen fra det, der allerede er trukket for abonnementet
--           (proeve_ekstra_sub_antal). Så kan måneder lægges på abonnementet
--           bagefter uden at blive trukket fra to gange - eller glemt.
--        b. firmaer.gratis_afstemt_sub: abonnementet er afstemt ved start
--           (gøres én gang). firma_gratis_afstemt kvitterer;
--           firma_gratis_afstem_kandidater giver betalings-cron'en dem, der
--           mangler (fx hvis webhooken ikke fik pakkeskift-låsen).
--        Eksisterende abonnementer uden ventende måneder markeres som afstemt
--        (intet at lægge på). Eksisterende proeve_ekstra_sub (brugt før denne
--        migration) får proeve_ekstra_sub_antal = 24, så der aldrig trækkes fra
--        en gang til for det abonnement.
--   2. Firmaoplysninger til Stripe (fund 3): firmaer, der har en Stripe-kunde,
--      og hvis oplysninger aldrig er sendt til Stripe (stripe_kunde_version =
--      stripe_kunde_synket_version = 0 - ændringer fra før 20261102020000
--      talte ikke), får stripe_kunde_version = 1, så betalings-cron'en
--      (koerAbonnementSynk -> synkKundeStripe) synker dem én gang.
--
-- md5-drift-tjek (mønstret fra 20261102020000): første gang (kolonnen
-- firmaer.gratis_afstemt_sub findes ikke endnu) skal funktionen, der
-- erstattes, være repoets. Ellers afbrydes migrationen (intet ændres).
-- Engangs-opdateringerne (markering og kundeversion) sker kun første gang.
-- Idempotent (kan køres igen). Én transaktion. Kør først på testdatabasen.
-- KØRES IKKE i produktion uden Filips "ja".

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
  if to_regclass('public.erhverv_staff_klik') is null then
    raise exception 'Forudsætning mangler: kør 20261102020000_firmapakker_rettelser.sql først';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'firmaer' and column_name = 'gratis_afstemt_sub') then
    return;
  end if;
  for r in
    select * from (values
      ('public.firma_gratis_ekstra_brugt(uuid,text,integer)', 'e173abd3849b99a184f7654d97330491')
    ) as t(fn, gammel)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
    end if;
    if h <> r.gammel then
      raise exception '%: md5 % passer ikke med repoet (%) - kontrollér funktionen, før migrationen køres', r.fn, h, r.gammel;
    end if;
  end loop;

  -- Første gang: kolonnerne og engangs-opdateringerne (dynamisk, da
  -- kolonnerne først findes nu).
  execute 'alter table public.firmaer add column proeve_ekstra_sub_antal integer not null default 0';
  execute 'alter table public.firmaer add column gratis_afstemt_sub text';
  -- Brugt før denne migration: aldrig trukket fra igen for det abonnement.
  execute 'update public.firmaer set proeve_ekstra_sub_antal = 24
            where proeve_ekstra_sub is not null and proeve_ekstra_sub_antal = 0';
  -- Abonnementer uden ventende måneder: intet at lægge på.
  execute 'update public.firmaer set gratis_afstemt_sub = stripe_subscription_id
            where stripe_subscription_id is not null and proeve_ekstra_ventende = 0';
  -- Fund 3: firmaoplysningerne er aldrig sendt til Stripe - synk én gang.
  -- (Triggeren firmaer_stripe_kunde_aendret reagerer kun på firmaoplysningerne,
  -- ikke på denne kolonne.)
  execute 'update public.firmaer set stripe_kunde_version = 1
            where stripe_customer_id is not null and stripe_kunde_version = 0 and stripe_kunde_synket_version = 0';
end $do$;

-- ===========================================================================
-- 1. Kolonner
-- ===========================================================================
alter table public.firmaer add column if not exists proeve_ekstra_sub_antal integer not null default 0;
alter table public.firmaer add column if not exists gratis_afstemt_sub text;
alter table public.firmaer drop constraint if exists firmaer_proeve_ekstra_sub_antal;
alter table public.firmaer add constraint firmaer_proeve_ekstra_sub_antal check (proeve_ekstra_sub_antal between 0 and 24);

comment on column public.firmaer.proeve_ekstra_sub_antal is
  'Hvor mange ventende gratis måneder (proeve_ekstra_ventende) der i alt er trukket fra for abonnementet proeve_ekstra_sub. firma_gratis_ekstra_brugt trækker kun forskellen fra. 20261102030000.';
comment on column public.firmaer.gratis_afstemt_sub is
  'Abonnementet, hvis start er afstemt: gratis måneder, staff gav, mens Checkout var åben, er lagt på i Stripe (afstemGratisVedStart i src/lib/erhverv/betaling.ts). 20261102030000.';

-- ===========================================================================
-- 2. Funktioner
-- ===========================================================================
-- Stripe har startet (eller udvidet) abonnementet med ventende staff-måneder:
-- p_antal = i alt brugt på abonnementet (metadata gratis_ekstra). Der trækkes
-- kun forskellen fra det, der allerede er trukket for samme abonnement.
-- Idempotent: samme p_antal igen = 'allerede'.
create or replace function public.firma_gratis_ekstra_brugt(p_firma uuid, p_subscription_id text, p_antal integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f      public.firmaer;
  v_fra  integer;
begin
  if p_subscription_id is null or btrim(p_subscription_id) = '' or p_antal is null or p_antal not between 1 and 24 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if f.proeve_ekstra_sub is not distinct from p_subscription_id then
    v_fra := p_antal - f.proeve_ekstra_sub_antal;
  else
    v_fra := p_antal;
  end if;
  if v_fra <= 0 then
    return jsonb_build_object('kode', 'allerede');
  end if;
  update public.firmaer
     set proeve_ekstra_ventende = greatest(proeve_ekstra_ventende - v_fra, 0),
         proeve_ekstra_sub = left(p_subscription_id, 255),
         proeve_ekstra_sub_antal = p_antal,
         opdateret_kl = now()
   where id = f.id;
  return jsonb_build_object('kode', 'ok', 'trukket', v_fra);
end $$;
revoke all on function public.firma_gratis_ekstra_brugt(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.firma_gratis_ekstra_brugt(uuid, text, integer) to service_role;
comment on function public.firma_gratis_ekstra_brugt(uuid, text, integer) is
  'Ventende staff-måneder brugt på et abonnement (p_antal = i alt på abonnementet). Trækker kun forskellen fra. 20261102030000.';

-- Abonnementets start er afstemt (kun hvis det stadig er firmaets abonnement).
create or replace function public.firma_gratis_afstemt(p_firma uuid, p_subscription_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.firmaer set gratis_afstemt_sub = left(p_subscription_id, 255)
   where id = p_firma and stripe_subscription_id = p_subscription_id
     and gratis_afstemt_sub is distinct from p_subscription_id;
  return jsonb_build_object('kode', case when found then 'ok' else 'allerede' end);
end $$;
revoke all on function public.firma_gratis_afstemt(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_gratis_afstemt(uuid, text) to service_role;

-- Startede abonnementer, der ikke er afstemt endnu (betalings-cron'en).
create or replace function public.firma_gratis_afstem_kandidater(p_graense integer default 20)
returns table (firma_id uuid, subscription_id text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_subscription_id from public.firmaer f
   where f.stripe_subscription_id is not null
     and f.gratis_afstemt_sub is distinct from f.stripe_subscription_id
     and f.stripe_abonnement_status in ('trialing', 'active')
   order by f.stripe_synk_forsoegt_kl nulls first, f.opdateret_kl
   limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;
revoke all on function public.firma_gratis_afstem_kandidater(integer) from public, anon, authenticated;
grant execute on function public.firma_gratis_afstem_kandidater(integer) to service_role;
