-- Erhvervsabonnement med Stripe Billing (Filip, 8. oktober 2026).
--
-- Stripe-koden ligger i src/lib/erhverv/betaling.ts og webhooken i
-- src/app/api/webhooks/stripe/route.ts. Her er databasedelen:
--
--  1. erhverv_pakker.stripe_price_id / stripe_price_oere - pakkens aktuelle
--     Stripe-pris (månedlig, DKK, ekskl. moms). Kun service role (ingen
--     grants til authenticated på tabellen). Ændres pakkens pris, laves en ny
--     Stripe-pris (priser kan ikke ændres i Stripe); eksisterende abonnementer
--     beholder deres pris, til firmaet skifter pakke.
--  2. firmaer: ny status 'afventer_betaling' (ny standard) - en ny firmakonto
--     kan ikke oprette auktioner, før første betaling er gennemført.
--     Nye kolonner, der spejler Stripe: stripe_abonnement_status,
--     opsiges_fra (cancel_at), periode_slut (current_period_end).
--  3. firma_pakkeskift.stripe_invoice_id - fakturaen for forskellen ved en
--     opgradering (webhook invoice.paid finder skiftet via den).
--  4. firma_regninger: beløb ekskl. moms, moms, hosted_url (Stripes
--     fakturaside) og status 'annulleret' (void).
--  5. Krogene (kun service role):
--       firma_faktura_spejl            - opret/opdatér regningen fra Stripe
--       firma_abonnement_betalt        - nu: første betaling aktiverer, og
--                                        regningen opdateres (ikke dublet)
--       firma_abonnement_mislykket     - regningen opdateres (ikke dublet)
--       firma_pakkeskift_betalt        - regningen opdateres (ikke dublet)
--       firma_stripe_abonnement_spejl  - abonnementets status/opsigelse
--  6. auctions_erhverv: tydelig fejl, når firmaet ikke har betalt endnu.
--  7. firma_oversigt: nye felter (rettes på stedet som i 20261010032000).
--
-- Eksisterende firmaer bevarer deres status (produktionen har ingen firmaer
-- 8. okt. 2026; testfirmaet er 'aktiv' som efter en manuel aftale).
-- Idempotent.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Pakker
-- ---------------------------------------------------------------------------
alter table public.erhverv_pakker add column if not exists stripe_price_id text;
alter table public.erhverv_pakker add column if not exists stripe_price_oere bigint;

comment on column public.erhverv_pakker.stripe_price_id is
  'Pakkens aktuelle Stripe-pris (lookup_key erhverv_pakke_<id>_<oere>). Sættes kun af serveren (service role). Ny pris i Stripe, når maanedspris ændres.';
comment on column public.erhverv_pakker.stripe_price_oere is
  'Beløbet (øre, ekskl. moms) som stripe_price_id er oprettet med. Afviger det fra maanedspris*100, laves en ny Stripe-pris.';

-- ---------------------------------------------------------------------------
-- 2. Firmaer
-- ---------------------------------------------------------------------------
alter table public.firmaer drop constraint if exists firmaer_abonnement_status_check;
alter table public.firmaer add constraint firmaer_abonnement_status_check
  check (abonnement_status in ('afventer_betaling', 'aktiv', 'pauset', 'opsagt'));
alter table public.firmaer alter column abonnement_status set default 'afventer_betaling';

alter table public.firmaer add column if not exists stripe_abonnement_status text;
alter table public.firmaer add column if not exists opsiges_fra timestamptz;
alter table public.firmaer add column if not exists periode_slut timestamptz;

comment on column public.firmaer.stripe_abonnement_status is
  'Spejl af Stripe-abonnementets status (active, past_due, unpaid, canceled ...). Kun service role.';
comment on column public.firmaer.opsiges_fra is
  'Abonnementet stopper denne dato (Stripe cancel_at_period_end). Kun service role.';
comment on column public.firmaer.periode_slut is
  'Slutningen af den nuværende betalingsperiode i Stripe. Kun service role.';

-- ---------------------------------------------------------------------------
-- 3. Pakkeskift
-- ---------------------------------------------------------------------------
alter table public.firma_pakkeskift add column if not exists stripe_invoice_id text;
create unique index if not exists firma_pakkeskift_stripe_invoice_unik
  on public.firma_pakkeskift (stripe_invoice_id) where stripe_invoice_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Regninger
-- ---------------------------------------------------------------------------
alter table public.firma_regninger add column if not exists beloeb_ekskl_moms_oere bigint;
alter table public.firma_regninger add column if not exists moms_oere bigint;
alter table public.firma_regninger add column if not exists hosted_url text;

alter table public.firma_regninger drop constraint if exists firma_regninger_hosted_url_https;
alter table public.firma_regninger add constraint firma_regninger_hosted_url_https
  check (hosted_url is null or hosted_url ~ '^https://');
alter table public.firma_regninger drop constraint if exists firma_regninger_status_check;
alter table public.firma_regninger add constraint firma_regninger_status_check
  check (status in ('afventer', 'betalt', 'mislykket', 'krediteret', 'annulleret'));

comment on column public.firma_regninger.beloeb_oere is 'Beløb i øre INKL. moms (Stripe invoice.total).';
comment on column public.firma_regninger.beloeb_ekskl_moms_oere is 'Beløb i øre ekskl. moms (Stripe invoice.total_excluding_tax).';
comment on column public.firma_regninger.moms_oere is 'Moms i øre (25 %).';

-- ---------------------------------------------------------------------------
-- 5. Krogene
-- ---------------------------------------------------------------------------

-- Spejler en Stripe-faktura (invoice.finalized/paid/payment_failed) i
-- firma_regninger. Sætter ALDRIG status 'betalt' - det gør kun
-- firma_abonnement_betalt/firma_pakkeskift_betalt, så en betaling altid
-- behandles af krogen (som også aktiverer pakken/abonnementet).
-- p_stripe_status: Stripes invoice.status (draft|open|paid|void|uncollectible).
create or replace function public.firma_faktura_spejl(
  p_firma uuid, p_stripe_invoice_id text, p_nummer text, p_type text,
  p_periode_fra timestamptz, p_periode_til timestamptz,
  p_beloeb_oere bigint, p_ekskl_moms_oere bigint, p_moms_oere bigint,
  p_stripe_status text, p_pdf_url text, p_hosted_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_pdf    text := case when p_pdf_url ~ '^https://' then left(p_pdf_url, 2000) end;
  v_hosted text := case when p_hosted_url ~ '^https://' then left(p_hosted_url, 2000) end;
begin
  if p_stripe_invoice_id is null or btrim(p_stripe_invoice_id) = '' then
    raise exception 'Mangler faktura-id';
  end if;
  -- Lås firmaet: webhooks for samme faktura kan komme samtidig.
  perform 1 from public.firmaer where id = p_firma for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_stripe_status = 'draft' then
    return jsonb_build_object('kode', 'kladde');
  end if;
  v_status := case p_stripe_status
    when 'void' then 'annulleret'
    when 'uncollectible' then 'mislykket'
    else 'afventer' end;

  insert into public.firma_regninger as r (firma_id, nummer, type, periode_fra, periode_til, beloeb_oere,
                                           beloeb_ekskl_moms_oere, moms_oere, status, stripe_invoice_id,
                                           pdf_url, hosted_url)
  values (p_firma, left(p_nummer, 50), case when p_type in ('abonnement', 'opgradering') then p_type else 'andet' end,
          (p_periode_fra at time zone 'Europe/Copenhagen')::date,
          (p_periode_til at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), p_ekskl_moms_oere, p_moms_oere, v_status,
          p_stripe_invoice_id, v_pdf, v_hosted)
  on conflict (stripe_invoice_id) do update
     set nummer = coalesce(excluded.nummer, r.nummer),
         type = excluded.type,
         periode_fra = coalesce(excluded.periode_fra, r.periode_fra),
         periode_til = coalesce(excluded.periode_til, r.periode_til),
         beloeb_oere = excluded.beloeb_oere,
         beloeb_ekskl_moms_oere = coalesce(excluded.beloeb_ekskl_moms_oere, r.beloeb_ekskl_moms_oere),
         moms_oere = coalesce(excluded.moms_oere, r.moms_oere),
         pdf_url = coalesce(excluded.pdf_url, r.pdf_url),
         hosted_url = coalesce(excluded.hosted_url, r.hosted_url),
         -- 'betalt' ændres aldrig herfra. 'paid' (open i excluded) ændrer
         -- intet - krogen sætter 'betalt'. En mislykket regning bliver ved
         -- med at være mislykket, til den er betalt eller annulleret.
         status = case
           when r.status = 'betalt' then 'betalt'
           when p_stripe_status = 'paid' then r.status
           when excluded.status = 'afventer' and r.status = 'mislykket' then 'mislykket'
           else excluded.status end
   where r.firma_id = p_firma;

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.firma_faktura_spejl(uuid, text, text, text, timestamptz, timestamptz, bigint, bigint, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.firma_faktura_spejl(uuid, text, text, text, timestamptz, timestamptz, bigint, bigint, bigint, text, text, text) to service_role;

-- Månedens abonnement betalt (Stripe invoice.paid, billing_reason
-- subscription_create/subscription_cycle). Idempotent på fakturaen: er den
-- allerede registreret som betalt, sker der intet.
--  - Første betaling: 'afventer_betaling' -> 'aktiv', abonnement_start = periodens start.
--  - Betalingspause ophæves, når der ikke er flere mislykkede abonnementsregninger.
--  - Planlagt nedgradering gennemføres ved periodeskift (som før).
create or replace function public.firma_abonnement_betalt(
  p_firma uuid, p_periode_start timestamptz, p_periode_slut timestamptz, p_beloeb_oere bigint,
  p_stripe_reference text, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
  v_flere_fejl boolean;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if exists (select 1 from public.firma_regninger r
              where r.firma_id = f.id and r.status = 'betalt'
                and ((p_stripe_invoice_id is not null and r.stripe_invoice_id = p_stripe_invoice_id)
                     or r.stripe_reference = 'abon:' || p_stripe_reference)) then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;

  insert into public.firma_regninger as r (firma_id, type, periode_fra, periode_til, beloeb_oere, status,
                                           stripe_invoice_id, stripe_reference, betalt_kl)
  values (f.id, 'abonnement', (p_periode_start at time zone 'Europe/Copenhagen')::date,
          (p_periode_slut at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'abon:' || p_stripe_reference, now())
  on conflict (stripe_invoice_id) do update
     set status = 'betalt',
         type = 'abonnement',
         betalt_kl = coalesce(r.betalt_kl, now()),
         beloeb_oere = excluded.beloeb_oere,
         periode_fra = coalesce(r.periode_fra, excluded.periode_fra),
         periode_til = coalesce(r.periode_til, excluded.periode_til),
         stripe_reference = coalesce(r.stripe_reference, excluded.stripe_reference)
   where r.firma_id = f.id;

  v_flere_fejl := exists (select 1 from public.firma_regninger r
                           where r.firma_id = f.id and r.type = 'abonnement' and r.status = 'mislykket');

  update public.firmaer
     set betalt_til = greatest(coalesce(betalt_til, p_periode_slut), p_periode_slut),
         betaling_mislykket_kl = case when v_flere_fejl then betaling_mislykket_kl else null end,
         abonnement_start = case when abonnement_status = 'afventer_betaling' then p_periode_start
                                 else abonnement_start end,
         abonnement_status = case
           when abonnement_status = 'afventer_betaling' then 'aktiv'
           when abonnement_status = 'pauset' and pauset_aarsag = 'betaling' and not v_flere_fejl then 'aktiv'
           else abonnement_status end,
         pauset_aarsag = case
           when abonnement_status = 'pauset' and pauset_aarsag = 'betaling' and not v_flere_fejl then null
           else pauset_aarsag end,
         opdateret_kl = now()
   where id = f.id;

  -- Planlagt nedgradering: gælder fra den periode, der nu er betalt.
  update public.firmaer set naeste_pakke_fra = least(naeste_pakke_fra, p_periode_start)
   where id = f.id and naeste_pakke_fra is not null and naeste_pakke_fra <= p_periode_start + interval '1 day';
  perform public.firma_anvend_planlagt(f.id);

  return jsonb_build_object('kode', 'ok', 'foerste', f.abonnement_status = 'afventer_betaling');
end $$;

revoke all on function public.firma_abonnement_betalt(uuid, timestamptz, timestamptz, bigint, text, text) from public, anon, authenticated;
grant execute on function public.firma_abonnement_betalt(uuid, timestamptz, timestamptz, bigint, text, text) to service_role;

-- Mislykket abonnementsbetaling. Som 20261010031000, men regningen
-- opdateres (status 'mislykket'), hvis den allerede findes fra
-- firma_faktura_spejl - i stedet for at blive sprunget over.
create or replace function public.firma_abonnement_mislykket(
  p_firma uuid, p_stripe_reference text, p_beloeb_oere bigint default null,
  p_stripe_invoice_id text default null, p_periode_slut timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if (p_periode_slut is not null and f.betalt_til is not null and f.betalt_til >= p_periode_slut)
     or (p_stripe_invoice_id is not null and exists (
           select 1 from public.firma_regninger r
            where r.firma_id = f.id and r.stripe_invoice_id = p_stripe_invoice_id and r.status = 'betalt')) then
    return jsonb_build_object('kode', 'allerede_betalt', 'betalt_til', f.betalt_til);
  end if;
  update public.firmaer
     set betaling_mislykket_kl = coalesce(betaling_mislykket_kl, now()), opdateret_kl = now()
   where id = f.id;
  if p_stripe_invoice_id is not null then
    insert into public.firma_regninger as r (firma_id, type, beloeb_oere, status, stripe_invoice_id)
    values (f.id, 'abonnement', greatest(coalesce(p_beloeb_oere, 0), 0), 'mislykket', p_stripe_invoice_id)
    on conflict (stripe_invoice_id) do update
       set status = case when r.status = 'betalt' then 'betalt' else 'mislykket' end
     where r.firma_id = f.id;
  elsif p_stripe_reference is not null then
    insert into public.firma_regninger (firma_id, type, beloeb_oere, status, stripe_reference)
    values (f.id, 'abonnement', greatest(coalesce(p_beloeb_oere, 0), 0), 'mislykket', 'fejl:' || p_stripe_reference)
    on conflict do nothing;
  end if;
  return jsonb_build_object('kode', 'ok', 'pause_fra', coalesce(f.betaling_mislykket_kl, now()) + interval '7 days');
end $$;

revoke all on function public.firma_abonnement_mislykket(uuid, text, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.firma_abonnement_mislykket(uuid, text, bigint, text, timestamptz) to service_role;

-- Opgradering betalt. Som 20261010031000, men regningen fra
-- firma_faktura_spejl opdateres til 'betalt' (i stedet for at blive
-- sprunget over).
create or replace function public.firma_pakkeskift_betalt(
  p_skift uuid, p_stripe_reference text, p_beloeb_oere bigint, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.firma_pakkeskift;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into s from public.firma_pakkeskift where id = p_skift for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status = 'gennemfoert' and s.stripe_reference = p_stripe_reference then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;
  if s.status <> 'afventer_betaling' then
    perform public.drift_fejl_log(
      'webhook', 'firma_pakkeskift_betalt',
      left(format('Opgradering betalt, men pakkeskiftet afventer ikke længere (status %s) - '
                  || 'refundér eller undersøg i Stripe. Skift %s, firma %s, reference %s, faktura %s, beløb %s øre.',
                  s.status, s.id, s.firma_id, p_stripe_reference, coalesce(p_stripe_invoice_id, '-'),
                  coalesce(p_beloeb_oere::text, '-')), 1000),
      'pakkeskift_betalt:' || s.id::text || ':' || p_stripe_reference,
      null);
    return jsonb_build_object('kode', 'betalt_men_ikke_afventende', 'status', s.status,
                              'firma_id', s.firma_id, 'skal_undersoeges', true);
  end if;

  perform 1 from public.firmaer where id = s.firma_id for update;

  update public.firma_pakkeskift
     set status = 'gennemfoert', behandlet_kl = now(), stripe_reference = p_stripe_reference,
         stripe_invoice_id = coalesce(stripe_invoice_id, p_stripe_invoice_id)
   where id = s.id;
  update public.firmaer
     set pakke_id = s.til_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = s.firma_id;
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = s.firma_id and status = 'planlagt';

  insert into public.firma_regninger as r (firma_id, type, periode_fra, beloeb_oere, status,
                                           stripe_invoice_id, stripe_reference, betalt_kl)
  values (s.firma_id, 'opgradering', (now() at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'skift:' || p_stripe_reference, now())
  on conflict (stripe_invoice_id) do update
     set status = 'betalt', type = 'opgradering', betalt_kl = coalesce(r.betalt_kl, now()),
         beloeb_oere = excluded.beloeb_oere,
         stripe_reference = coalesce(r.stripe_reference, excluded.stripe_reference)
   where r.firma_id = s.firma_id;

  return jsonb_build_object('kode', 'ok', 'firma_id', s.firma_id);
end $$;

revoke all on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) to service_role;

-- Spejler Stripe-abonnementet (customer.subscription.created/updated/deleted).
-- Svar:
--   ok                 - spejlet
--   andet_abonnement   - firmaet har allerede et andet (ikke afsluttet)
--                        abonnement: serveren opsiger det nye og logger en
--                        drift-alarm (fx to Checkout-betalinger på samme tid)
--   ukendt_abonnement  - sletning af et abonnement, firmaet ikke (længere) har
--   opsagt             - abonnementet er afsluttet efter opsigelse -> opsagt
--   pause_betaling     - Stripe har afsluttet abonnementet pga. manglende
--                        betaling -> pause; firmaet kan betale på ny (Checkout)
create or replace function public.firma_stripe_abonnement_spejl(
  p_firma uuid, p_subscription_id text, p_stripe_status text, p_opsiges_fra timestamptz,
  p_periode_slut timestamptz, p_slettet boolean default false, p_aarsag text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
begin
  if p_subscription_id is null or btrim(p_subscription_id) = '' then
    raise exception 'Mangler abonnements-id';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if p_slettet then
    if f.stripe_subscription_id is distinct from p_subscription_id then
      return jsonb_build_object('kode', 'ukendt_abonnement');
    end if;
    if coalesce(p_aarsag, '') = 'cancellation_requested' or f.opsiges_fra is not null then
      update public.firmaer
         set abonnement_status = 'opsagt', opsagt_kl = coalesce(opsagt_kl, now()), pauset_aarsag = null,
             stripe_abonnement_status = 'canceled', opsiges_fra = null,
             naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
       where id = f.id;
      update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now(),
             note = coalesce(note, 'Abonnementet er opsagt')
       where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
      return jsonb_build_object('kode', 'opsagt');
    end if;
    -- Afsluttet af Stripe pga. manglende betaling: pause, og et nyt
    -- abonnement kan startes med "Betal for din pakke".
    update public.firmaer
       set stripe_subscription_id = null, stripe_abonnement_status = 'canceled', periode_slut = null,
           abonnement_status = case when abonnement_status = 'aktiv' then 'pauset' else abonnement_status end,
           pauset_aarsag = case when abonnement_status = 'aktiv' then 'betaling' else pauset_aarsag end,
           opdateret_kl = now()
     where id = f.id;
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now(),
           note = coalesce(note, 'Abonnementet blev afsluttet af Stripe')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null where id = f.id;
    return jsonb_build_object('kode', 'pause_betaling');
  end if;

  if f.stripe_subscription_id is not null and f.stripe_subscription_id <> p_subscription_id then
    return jsonb_build_object('kode', 'andet_abonnement', 'nuvaerende', f.stripe_subscription_id);
  end if;

  update public.firmaer
     set stripe_subscription_id = p_subscription_id,
         stripe_abonnement_status = left(p_stripe_status, 40),
         opsiges_fra = p_opsiges_fra,
         periode_slut = coalesce(p_periode_slut, periode_slut),
         opdateret_kl = now()
   where id = f.id;
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.firma_stripe_abonnement_spejl(uuid, text, text, timestamptz, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.firma_stripe_abonnement_spejl(uuid, text, text, timestamptz, timestamptz, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. auctions_erhverv: tydelig besked før første betaling (samme præfiks og
--    errcode BHE02 som før, så appen er uændret). Rettes på stedet.
-- ---------------------------------------------------------------------------
do $do$
declare
  v_def text := pg_get_functiondef('public.auctions_erhverv()'::regprocedure);
  v_gl constant text := $t$v_k := public.erhverv_kvote(new.bruger_id, true);$t$;
  v_ny constant text := $t$if exists (select 1 from public.firmaer fa
                  where fa.bruger_id = new.bruger_id and fa.abonnement_status = 'afventer_betaling') then
        raise exception 'erhverv_intet_abonnement: Betal for din pakke under Abonnement i Firma oversigt, før du opretter auktioner.'
          using errcode = 'BHE02';
      end if;
      v_k := public.erhverv_kvote(new.bruger_id, true);$t$;
begin
  if position('afventer_betaling' in v_def) > 0 then
    return;
  end if;
  if position(v_gl in v_def) = 0 then
    raise exception 'auctions_erhverv: forventet tekst blev ikke fundet';
  end if;
  execute replace(v_def, v_gl, v_ny);
end;
$do$;

-- ---------------------------------------------------------------------------
-- 7. firma_oversigt: nye felter. Rettes på stedet i den nuværende definition
--    (tekst-erstatning, afbryder hvis teksten ikke findes).
--    firma: opsiges_fra, periode_slut, har_stripe_abonnement,
--           stripe_abonnement_status; naeste_periode følger Stripe.
--    afventende_opgradering: faktura_url (Stripes fakturaside).
--    regninger: hosted_url, beloeb_ekskl_moms_oere, moms_oere.
-- ---------------------------------------------------------------------------
do $do$
declare
  v_def text := pg_get_functiondef('public.firma_oversigt()'::regprocedure);
  v_gl1 constant text := $t$'pauset_aarsag', f.pauset_aarsag, 'naeste_periode', public.firma_naeste_periode(f.abonnement_start)),$t$;
  v_ny1 constant text := $t$'pauset_aarsag', f.pauset_aarsag,
      'naeste_periode', coalesce(f.periode_slut, public.firma_naeste_periode(f.abonnement_start)),
      'periode_slut', f.periode_slut, 'opsiges_fra', f.opsiges_fra,
      'har_stripe_abonnement', f.stripe_subscription_id is not null,
      'stripe_abonnement_status', f.stripe_abonnement_status),$t$;
  v_gl2 constant text := $t$|| jsonb_build_object('skift_id', s.id, 'anmodet_kl', s.oprettet_kl)$t$;
  v_ny2 constant text := $t$|| jsonb_build_object('skift_id', s.id, 'anmodet_kl', s.oprettet_kl,
                                         'faktura_url', (select r2.hosted_url from public.firma_regninger r2
                                                          where s.stripe_invoice_id is not null
                                                            and r2.stripe_invoice_id = s.stripe_invoice_id
                                                            and r2.status in ('afventer', 'mislykket')))$t$;
  v_gl3 constant text := $t$'pdf_url', r.pdf_url,$t$;
  v_ny3 constant text := $t$'pdf_url', r.pdf_url, 'hosted_url', r.hosted_url,
        'beloeb_ekskl_moms_oere', r.beloeb_ekskl_moms_oere, 'moms_oere', r.moms_oere,$t$;
begin
  if position('har_stripe_abonnement' in v_def) > 0 then
    return;
  end if;
  if position(v_gl1 in v_def) = 0 or position(v_gl2 in v_def) = 0 or position(v_gl3 in v_def) = 0 then
    raise exception 'firma_oversigt: forventet tekst blev ikke fundet';
  end if;
  execute replace(replace(replace(v_def, v_gl1, v_ny1), v_gl2, v_ny2), v_gl3, v_ny3);
end;
$do$;
