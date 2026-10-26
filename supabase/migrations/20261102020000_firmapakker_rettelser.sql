-- Firmapakker: rettelser efter reviewerens gennemgang (26. okt. 2026) +
-- små rettelser til Ugens butik og klage-loggen.
--
-- Bygger på 20261102010000_firmapakker.sql, 20261101060000_ugens_butik_rettelser.sql
-- og 20261101050000_erhverv_klage_koeber_email_saelger.sql. Stripe-delen:
-- src/lib/erhverv/betaling.ts (funktionerne nævnt herunder); staff-handlingerne:
-- src/app/actions/adminErhvervAbonnement.ts.
--
-- Indhold:
--   1. Gratis måneder til et firma UDEN abonnement (fund 2). Før: staff kunne
--      give +N måneder til et firma, der allerede havde haft et abonnement
--      (fx stoppet af Stripe pga. manglende betaling) - de blev lagt i
--      proeve_maaneder, men Checkout brugte dem aldrig (kun nye firmaer får
--      velkomstperioden), og firmaet fik alligevel en mail om dem.
--      Nu: erhverv_firma_gratis_gem lægger dem i
--        - proeve_maaneder, hvis firmaet får velkomstperioden
--          (erhverv_faar_velkomst_gratis - ÉN definition, som Checkout også
--          bruger), ellers i
--        - proeve_ekstra_ventende: staff-givne måneder, der lægges oven i,
--          næste gang firmaet starter Checkout (startBetaling). Når Stripe har
--          startet abonnementet med dem, trækkes de fra
--          (firma_gratis_ekstra_brugt - idempotent pr. abonnement).
--      Kan firmaet slet ikke starte et abonnement (fx opsagt, eller Stripe har
--      et afsluttet abonnement, som databasen ikke har spejlet endnu), afvises
--      handlingen ('kan_ikke_starte') - der gives intet, og der sendes ingen mail.
--   2. Dobbeltklik (fund 3): staff-hurtighandlingerne (gratis periode,
--      introrabat, særpris, ekstra auktioner/fremhævninger) tager et klik-id
--      (p_klik, UUID dannet, når formularen vises). Det gemmes i
--      erhverv_staff_klik (unik nøgle) i SAMME transaktion som ændringen; et
--      brugt klik-id giver 'allerede_udfoert', og intet ændres. Samme klik-id
--      bruges som idempotency key i Stripe. p_klik er valgfrit (null = som før).
--   3. Prissynk efter flytningen til de nye pakker (fund 4 + "sorter"):
--      kandidaterne tages i rækkefølge efter seneste forsøg
--      (stripe_synk_forsoegt_kl, aldrig forsøgt først) og opdateret_kl, så de
--      samme 20 aldrig blokerer resten. koerAbonnementSynk frigiver en gammel
--      plan og annullerer gamle opgraderingsfakturaer i Stripe, før prisen
--      skiftes (se betaling.ts).
--   4. Firmaets navn, CVR, adresse, telefon og e-mail i Stripe (fund 6): en
--      trigger tæller stripe_kunde_version op, når felterne ændres (uanset
--      hvilken vej - erhverv_firma_opdater eller andet). Betalings-cron'en
--      (koerAbonnementSynk) opdaterer Stripe-kunden og bytter momsnummeret
--      (tax id eu_vat DK+CVR) ud og kvitterer (firma_kunde_synk_udfoert).
--      En fejl i Stripe vælter aldrig databaseopdateringen - den prøves igen.
--   5. erhverv_firma_opret advarer, når CVR'et har haft et abonnement før
--      (p_cvr_bekraeftet): false = afvis med 'cvr_tidligere_abonnement' (staff
--      skal bekræfte), true = opret alligevel (logges), null = som før (kun et
--      flag i svaret - bagudkompatibelt med serveren, indtil den sender
--      parameteren). erhverv_cvr_tidligere: forhåndstjek til formularen.
--   6. Kolonne-rettigheder på firmaer: firmaet (authenticated) kan kun læse
--      de kolonner, det selv må se - ikke saerpris_aftale, interne nøgler,
--      låse, Stripe-id'er osv. (Firma oversigt bruger security definer-RPC'er.)
--   7. aktive_annoncer viser kun aktive auktioner (status 'aktiv', ikke slut) -
--      som liste_top (uændret, den tjekkede det allerede).
--   8. En arkiveret pakke kan ikke være aktiv (constraint
--      erhverv_pakker_arkiveret_ikke_aktiv). 20261102010000 droppede en
--      constraint med det navn, der aldrig fandtes, under kommentaren "En
--      arkiveret pakke tilbydes aldrig." - den er nu sand: alle
--      arkiverede pakker er inaktive, erhverv_pakke_gem afviser at ændre dem,
--      og alle visninger filtrerer på arkiveret_kl.
--   9. Ugens butik:
--      a. Loftet (4 uger i træk, 2 ugers pause) tæller også en reservation,
--         der er udløbet, men endnu ikke ryddet af cron'en (status stadig
--         'reserveret') - den kan stadig blive betalt (ugens_butik_holder).
--         Bliver netop sådan en reservation betalt, tjekkes loftet igen i
--         ugens_butik_registrer ('for_sent', grund 'loft' - refunderes).
--      b. firma_ugens_butik: 'bookinger' viser ikke annullerede staff-bookinger
--         uden betaling.
--      c. ugens_butik_admin: 'uger' får loft-status pr. booket uge
--         (i_traek, loft_brudt, loft_omgaaet).
--  10. Klager: visningen af købers e-mail logges med bruger_id = FIRMAETS konto
--      (klagen handler om firmaet) - ikke køberens, så handlingen ikke står på
--      køberens brugerside i admin. Køberen findes stadig via maal_id (klagen).
--      Eksisterende log-linjer rettes (kun bruger_id - intet slettes).
--
-- Rettede henvisninger: Stripe-delen ligger i src/lib/erhverv/betaling.ts
-- (20261102010000 nævnte en src/lib/erhverv/firmaPris.ts, som ikke findes).
--
-- md5-drift-tjek (mønstret fra 20261102010000): første gang (tabellen
-- erhverv_staff_klik findes ikke endnu) skal hver funktion, der erstattes,
-- være repoets. Ellers afbrydes migrationen (intet ændres). Idempotent (kan
-- køres igen). Én transaktion. Kør først på testdatabasen. KØRES IKKE i
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
  if to_regclass('public.firma_fremhaevninger') is null then
    raise exception 'Forudsætning mangler: kør 20261102010000_firmapakker.sql først';
  end if;
  if to_regclass('public.erhverv_staff_klik') is not null then
    return;
  end if;
  for r in
    select * from (values
      ('public.erhverv_firma_gratis_gem(uuid,uuid,integer,text,boolean,timestamp with time zone)', 'f0ad067f84080bbe891e50fbf6fbd125'),
      ('public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text)', 'cdffaa7a4a1ce07175f22b84a068bf9c'),
      ('public.erhverv_firma_saerpris_gem(uuid,uuid,bigint,uuid,text,text)', '914eca3925feba0bbdce18c958cf669c'),
      ('public.erhverv_firma_ekstra_giv(uuid,uuid,integer,integer,text)', 'f227865a0a3ee5e47e483b0bdd123fbc'),
      ('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer)', 'c64b32a7c1874929d85b9dbf13f658bd'),
      ('public.firma_pris_synk_kandidater(integer)', '51ad73f8c0c6cd9563ef0b23eda97a70'),
      ('public.aktive_annoncer(uuid[])', '393377f1933da652b8ba5de961322a30'),
      ('public.erhverv_firma_abonnement_json(uuid)', 'c1ca75f98a20bfa3c14028d12ce48699'),
      ('public.erhverv_klage_detalje(uuid,uuid)', '3e2cd7ec24ba51a3754b2cbcca1b4abe'),
      ('public.ugens_butik_holder(uuid,date,uuid)', 'd0c29e4c31f6852e3d6c7e6831f5c33d'),
      ('public.ugens_butik_registrer(text,text,text,bigint,text,text)', 'a39b26bbc6bc68c74b32b7d9b7a6f70e'),
      ('public.firma_ugens_butik()', '417979441b96ff457ae1bb3ff7e9c30b'),
      ('public.ugens_butik_admin(uuid)', 'afb4edec8b641521d573c71864e07d29')
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
end $do$;

-- ===========================================================================
-- 1. Nye kolonner og tabel
-- ===========================================================================
alter table public.firmaer add column if not exists proeve_ekstra_ventende integer not null default 0;
alter table public.firmaer add column if not exists proeve_ekstra_sub text;
alter table public.firmaer add column if not exists stripe_kunde_version integer not null default 0;
alter table public.firmaer add column if not exists stripe_kunde_synket_version integer not null default 0;
alter table public.firmaer add column if not exists stripe_synk_forsoegt_kl timestamptz;
alter table public.firmaer drop constraint if exists firmaer_proeve_ekstra;
alter table public.firmaer add constraint firmaer_proeve_ekstra check (proeve_ekstra_ventende between 0 and 24);

comment on column public.firmaer.proeve_ekstra_ventende is
  'Gratis måneder givet af staff til et firma, der IKKE får velkomstperioden (har haft et abonnement før) og intet abonnement har nu. Lægges oven i, når firmaet starter Checkout (startBetaling), og trækkes fra, når Stripe har startet abonnementet med dem (firma_gratis_ekstra_brugt). 20261102020000.';
comment on column public.firmaer.proeve_ekstra_sub is
  'Det abonnement, proeve_ekstra_ventende sidst blev brugt på (gør firma_gratis_ekstra_brugt idempotent).';
comment on column public.firmaer.stripe_kunde_version is
  'Tælles op af triggeren firmaer_stripe_kunde_aendret, når navn, CVR, adresse, telefon eller e-mail ændres. Er den større end stripe_kunde_synket_version, opdaterer betalings-cron''en Stripe-kunden (koerAbonnementSynk).';
comment on column public.firmaer.stripe_synk_forsoegt_kl is
  'Seneste forsøg i betalings-cron''ens Stripe-synk (pris, introrabat, kunde) - kun til rækkefølgen, så de samme firmaer ikke blokerer resten.';
comment on column public.firmaer.proeve_maaneder is
  'Gratis måneder i velkomstperioden (1 for alle nye firmaer; staff kan give flere, før firmaet har startet). Bruges som trial_end i Stripe Checkout, hvis erhverv_faar_velkomst_gratis. Staff-givne måneder til et firma, der har haft et abonnement før: proeve_ekstra_ventende.';

-- Klik-id'er fra staff-hurtighandlingerne (dobbeltklik giver ikke dobbelt effekt).
create table if not exists public.erhverv_staff_klik (
  klik_id     uuid primary key,
  handling    text not null check (char_length(handling) between 1 and 60),
  firma_id    uuid references public.firmaer(id) on delete restrict,
  staff_id    uuid references public.users(id) on delete set null,
  oprettet_kl timestamptz not null default now()
);
comment on table public.erhverv_staff_klik is
  'Brugte klik-id''er fra staff-hurtighandlingerne på et firma (gratis periode, introrabat, særpris, ekstra). Gemmes i samme transaktion som ændringen - et brugt klik-id afvises (''allerede_udfoert''). Samme id er idempotency key i Stripe. Slettes aldrig. 20261102020000.';
alter table public.erhverv_staff_klik enable row level security;
revoke all on public.erhverv_staff_klik from public, anon, authenticated;
grant select on public.erhverv_staff_klik to service_role;
drop trigger if exists erhverv_staff_klik_ingen_sletning on public.erhverv_staff_klik;
create trigger erhverv_staff_klik_ingen_sletning before delete on public.erhverv_staff_klik
  for each row execute function public.erhverv_ingen_sletning();
drop trigger if exists erhverv_staff_klik_ingen_truncate on public.erhverv_staff_klik;
create trigger erhverv_staff_klik_ingen_truncate before truncate on public.erhverv_staff_klik
  for each statement execute function public.erhverv_ingen_sletning();

-- En arkiveret pakke er aldrig aktiv (og tilbydes derfor aldrig).
update public.erhverv_pakker set aktiv = false, opdateret_kl = now() where arkiveret_kl is not null and aktiv;
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_arkiveret_ikke_aktiv;
alter table public.erhverv_pakker add constraint erhverv_pakker_arkiveret_ikke_aktiv
  check (arkiveret_kl is null or not aktiv);
comment on constraint erhverv_pakker_arkiveret_ikke_aktiv on public.erhverv_pakker is
  'En arkiveret pakke er altid inaktiv og tilbydes aldrig (erhverv_pakke_gem afviser at ændre den). 20261102020000.';

-- ===========================================================================
-- 2. Klik-id (dobbeltklik)
-- ===========================================================================
-- Tager klik-id'et i den kaldende transaktion. true = nyt (fortsæt), false =
-- allerede brugt (afvis). null = intet klik-id (som før).
create or replace function public.erhverv_staff_klik_tag(p_klik uuid, p_handling text, p_firma uuid, p_staff uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_klik is null then
    return true;
  end if;
  insert into public.erhverv_staff_klik (klik_id, handling, firma_id, staff_id)
  values (p_klik, left(p_handling, 60), p_firma, p_staff)
  on conflict (klik_id) do nothing;
  return found;
end $$;
revoke all on function public.erhverv_staff_klik_tag(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

-- Forhåndstjek før Stripe kaldes (serveren): er klik-id'et allerede brugt?
create or replace function public.erhverv_staff_klik_brugt(p_klik uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_klik is not null and exists (select 1 from public.erhverv_staff_klik k where k.klik_id = p_klik);
$$;
revoke all on function public.erhverv_staff_klik_brugt(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_staff_klik_brugt(uuid) to service_role;

-- ===========================================================================
-- 3. Gratis periode
-- ===========================================================================
-- Får firmaet velkomstperioden, når abonnementet starter i Checkout? Kun et
-- nyt firma: aldrig haft en gratis periode og aldrig betalt for abonnementet.
-- ÉN definition - bruges af startBetaling (src/lib/erhverv/betaling.ts) og
-- af erhverv_firma_gratis_gem.
create or replace function public.erhverv_faar_velkomst_gratis(p_firma uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select f.proeve_givet_kl is null and f.proeve_maaneder > 0
           and not exists (select 1 from public.firma_regninger r
                            where r.firma_id = f.id and r.type = 'abonnement' and r.status = 'betalt'
                              and r.beloeb_oere > 0)
      from public.firmaer f where f.id = p_firma), false);
$$;
revoke all on function public.erhverv_faar_velkomst_gratis(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_faar_velkomst_gratis(uuid) to service_role;

-- Gratis periode (+N måneder). Stripe først (src/lib/erhverv/betaling.ts,
-- givGratisPeriodeStripe):
--   p_stripe = true: abonnementets trial_end er forlænget i Stripe til
--     p_proeve_slut - her spejles og logges det.
--   p_stripe = false: firmaet har intet abonnement i Stripe. Kan firmaet
--     starte et (venter på første betaling, eller Stripe stoppede det pga.
--     manglende betaling), gælder månederne, når det starter Checkout:
--     velkomstperioden (proeve_maaneder) for et nyt firma, ellers
--     proeve_ekstra_ventende. Kan det ikke: 'kan_ikke_starte' (intet ændres).
-- p_klik: klik-id (dobbeltklik -> 'allerede_udfoert').
-- Svar: {kode: 'ok', proeve_maaneder, gratis_maaneder_ved_start, hvor:
-- 'stripe' | 'velkomst' | 'ventende'} | {kode: 'begrundelse' |
-- 'ugyldigt_antal' | 'ikke_fundet' | 'for_lang' | 'kan_ikke_starte' |
-- 'allerede_udfoert'}
drop function if exists public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz);
create or replace function public.erhverv_firma_gratis_gem(p_staff uuid, p_firma uuid, p_maaneder integer,
                                                           p_begrundelse text, p_stripe boolean,
                                                           p_proeve_slut timestamptz, p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f          public.firmaer;
  v_velkomst boolean := false;
  v_hvor     text;
  v_start    integer := 0;
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
    -- Kun hvis firmaet kan starte et abonnement i Checkout (samme regel som
    -- kanStarteAbonnement i betaling.ts).
    if f.stripe_subscription_id is not null
       or not (f.abonnement_status = 'afventer_betaling'
               or (f.abonnement_status = 'pauset' and f.pauset_aarsag = 'betaling')) then
      return jsonb_build_object('kode', 'kan_ikke_starte');
    end if;
    v_velkomst := public.erhverv_faar_velkomst_gratis(f.id);
    if v_velkomst then
      if f.proeve_maaneder + f.proeve_ekstra_ventende + p_maaneder > 24 then
        return jsonb_build_object('kode', 'for_lang');
      end if;
      v_hvor := 'velkomst';
      v_start := f.proeve_maaneder + f.proeve_ekstra_ventende + p_maaneder;
    else
      if f.proeve_ekstra_ventende + p_maaneder > 24 then
        return jsonb_build_object('kode', 'for_lang');
      end if;
      v_hvor := 'ventende';
      v_start := f.proeve_ekstra_ventende + p_maaneder;
    end if;
  end if;

  if not public.erhverv_staff_klik_tag(p_klik, 'firma_gratis_periode', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;

  if v_hvor = 'stripe' then
    update public.firmaer
       set proeve_slut = p_proeve_slut, stripe_abonnement_status = 'trialing',
           proeve_givet_kl = coalesce(proeve_givet_kl, now()), opdateret_kl = now()
     where id = f.id;
  elsif v_hvor = 'velkomst' then
    update public.firmaer set proeve_maaneder = proeve_maaneder + p_maaneder, opdateret_kl = now()
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
                            'proeve_maaneder', f.proeve_maaneder + case when v_hvor = 'velkomst' then p_maaneder else 0 end,
                            'gratis_maaneder_ved_start', v_start);
end $$;
revoke all on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) to service_role;
comment on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz, uuid) is
  'Staff giver +N gratis måneder (chef og sælger-rollen). Stripe-delen: givGratisPeriodeStripe i src/lib/erhverv/betaling.ts. Uden abonnement: velkomstperioden eller proeve_ekstra_ventende - eller ''kan_ikke_starte''. 20261102020000.';

-- Stripe har startet abonnementet med de ventende staff-måneder (Checkout-
-- metadata gratis_ekstra): de trækkes fra. Idempotent pr. abonnement.
create or replace function public.firma_gratis_ekstra_brugt(p_firma uuid, p_subscription_id text, p_antal integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_subscription_id is null or btrim(p_subscription_id) = '' or p_antal is null or p_antal not between 1 and 24 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  update public.firmaer
     set proeve_ekstra_ventende = greatest(proeve_ekstra_ventende - p_antal, 0),
         proeve_ekstra_sub = left(p_subscription_id, 255), opdateret_kl = now()
   where id = p_firma and proeve_ekstra_sub is distinct from p_subscription_id;
  return jsonb_build_object('kode', case when found then 'ok' else 'allerede' end);
end $$;
revoke all on function public.firma_gratis_ekstra_brugt(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.firma_gratis_ekstra_brugt(uuid, text, integer) to service_role;

-- ===========================================================================
-- 4. Introrabat, særpris og ekstra - med klik-id
-- ===========================================================================
drop function if exists public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text);
create or replace function public.erhverv_firma_intro_gem(p_staff uuid, p_firma uuid, p_procent integer,
                                                          p_maaneder integer, p_fra text, p_begrundelse text,
                                                          p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
  v_noegle uuid := gen_random_uuid();
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
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if not public.erhverv_staff_klik_tag(p_klik, 'firma_introrabat', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;
  if p_procent is null then
    update public.firmaer
       set intro_procent = null, intro_maaneder = null, intro_fra = null, intro_status = null,
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat', 'Introrabat fjernet: ' || btrim(p_begrundelse));
  else
    update public.firmaer
       set intro_procent = p_procent, intro_maaneder = p_maaneder, intro_fra = p_fra, intro_status = 'planlagt',
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat',
      format('Introrabat %s %% i %s måned%s %s: %s', p_procent, p_maaneder, case when p_maaneder = 1 then '' else 'er' end,
             case when p_fra = 'straks' then 'fra nu' else 'efter den gratis periode' end, btrim(p_begrundelse)));
  end if;
  return jsonb_build_object('kode', 'ok', 'noegle', v_noegle);
end $$;
revoke all on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid) to service_role;

drop function if exists public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text);
create or replace function public.erhverv_firma_saerpris_gem(p_staff uuid, p_firma uuid, p_oere bigint,
                                                             p_pakke uuid, p_aftale text, p_fra text,
                                                             p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_aftale) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_oere is not null and (p_oere < 100 or p_oere > 100000000 or p_oere % 100 <> 0) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_oere is not null and p_pakke is distinct from f.pakke_id then
    return jsonb_build_object('kode', 'pakke_skiftet');
  end if;
  if not public.erhverv_staff_klik_tag(p_klik, 'firma_saerpris', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;
  update public.firmaer
     set saerpris_oere = p_oere,
         saerpris_pakke_id = case when p_oere is null then null else p_pakke end,
         saerpris_aftale = case when p_oere is null then null else btrim(p_aftale) end,
         opdateret_kl = now()
   where id = f.id;
  perform public.erhverv_firma_log(p_staff, f.id, 'firma_saerpris',
    case when p_oere is null then 'Særpris fjernet (pakkens pris gælder): ' || btrim(p_aftale)
         else format('Særpris %s kr./md. ekskl. moms på %s (%s): %s', p_oere / 100,
                     (select navn from public.erhverv_pakker where id = p_pakke),
                     case when p_fra = 'straks' then 'fra nu - forskellen afregnes på næste regning' else 'fra næste betaling' end,
                     btrim(p_aftale)) end);
  return jsonb_build_object('kode', 'ok');
end $$;
revoke all on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text, uuid) to service_role;

drop function if exists public.erhverv_firma_ekstra_giv(uuid, uuid, integer, integer, text);
create or replace function public.erhverv_firma_ekstra_giv(p_staff uuid, p_firma uuid, p_auktioner integer,
                                                           p_fremhaevninger integer, p_begrundelse text,
                                                           p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f   public.firmaer;
  v_md date := public.erhverv_maaned_dato(now());
  e   public.firma_maaned_ekstra;
  v_a integer := coalesce(p_auktioner, 0);
  v_f integer := coalesce(p_fremhaevninger, 0);
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_begrundelse) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if (v_a = 0 and v_f = 0) or abs(v_a) > 1000 or abs(v_f) > 100 then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  insert into public.firma_maaned_ekstra (firma_id, maaned, auktioner, fremhaevninger, opdateret_af)
  values (f.id, v_md, 0, 0, p_staff)
  on conflict (firma_id, maaned) do nothing;
  select * into e from public.firma_maaned_ekstra where firma_id = f.id and maaned = v_md for update;
  if e.auktioner + v_a < 0 or e.fremhaevninger + v_f < 0 then
    return jsonb_build_object('kode', 'under_nul', 'auktioner', e.auktioner, 'fremhaevninger', e.fremhaevninger);
  end if;
  if not public.erhverv_staff_klik_tag(p_klik,
           case when v_a <> 0 then 'firma_ekstra_auktioner' else 'firma_ekstra_fremhaevninger' end, f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert', 'auktioner', e.auktioner, 'fremhaevninger', e.fremhaevninger);
  end if;
  update public.firma_maaned_ekstra
     set auktioner = auktioner + v_a, fremhaevninger = fremhaevninger + v_f,
         opdateret_af = p_staff, opdateret_kl = now()
   where firma_id = f.id and maaned = v_md
  returning * into e;
  if v_a <> 0 then
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_ekstra_auktioner',
      format('%s%s ekstra auktioner i %s %s (i alt %s ekstra): %s', case when v_a > 0 then '+' else '' end, v_a,
             public.erhverv_maaned_navn(now()), extract(year from now() at time zone 'Europe/Copenhagen'),
             e.auktioner, btrim(p_begrundelse)));
  end if;
  if v_f <> 0 then
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_ekstra_fremhaevninger',
      format('%s%s ekstra fremhævninger i %s %s (i alt %s ekstra): %s', case when v_f > 0 then '+' else '' end, v_f,
             public.erhverv_maaned_navn(now()), extract(year from now() at time zone 'Europe/Copenhagen'),
             e.fremhaevninger, btrim(p_begrundelse)));
  end if;
  return jsonb_build_object('kode', 'ok', 'auktioner', e.auktioner, 'fremhaevninger', e.fremhaevninger);
end $$;
revoke all on function public.erhverv_firma_ekstra_giv(uuid, uuid, integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_ekstra_giv(uuid, uuid, integer, integer, text, uuid) to service_role;

-- ===========================================================================
-- 5. Betalings-cron'ens Stripe-synk: rækkefølge, prissynk og kunden
-- ===========================================================================
-- Prissynk-kandidater: aldrig forsøgt først, derefter ældste forsøg og
-- ældste ændring - så de samme 20 ikke blokerer resten.
create or replace function public.firma_pris_synk_kandidater(p_graense integer default 20)
returns table (firma_id uuid, subscription_id text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_subscription_id from public.firmaer f
   where f.stripe_pris_synk and f.stripe_subscription_id is not null
   order by f.stripe_synk_forsoegt_kl nulls first, f.opdateret_kl
   limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;

-- Cron'en forsøger nu (kun til rækkefølgen).
create or replace function public.firma_synk_forsoegt(p_firma uuid)
returns void language sql security definer set search_path = '' as $$
  update public.firmaer set stripe_synk_forsoegt_kl = now() where id = p_firma;
$$;
revoke all on function public.firma_synk_forsoegt(uuid) from public, anon, authenticated;
grant execute on function public.firma_synk_forsoegt(uuid) to service_role;

-- Navn, CVR, adresse, telefon eller e-mail ændret: Stripe-kunden skal opdateres.
create or replace function public.firmaer_stripe_kunde_aendret()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.firmanavn, new.cvr, new.adresse, new.postnummer, new.bynavn, new.telefon, new.kontakt_email)
     is distinct from
     (old.firmanavn, old.cvr, old.adresse, old.postnummer, old.bynavn, old.telefon, old.kontakt_email) then
    new.stripe_kunde_version := old.stripe_kunde_version + 1;
  end if;
  return new;
end $$;
revoke all on function public.firmaer_stripe_kunde_aendret() from public, anon, authenticated;
drop trigger if exists firmaer_stripe_kunde_aendret on public.firmaer;
create trigger firmaer_stripe_kunde_aendret
  before update of firmanavn, cvr, adresse, postnummer, bynavn, telefon, kontakt_email on public.firmaer
  for each row execute function public.firmaer_stripe_kunde_aendret();

create or replace function public.firma_kunde_synk_kandidater(p_graense integer default 20)
returns table (firma_id uuid, version integer)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_kunde_version from public.firmaer f
   where f.stripe_customer_id is not null and f.stripe_kunde_version > f.stripe_kunde_synket_version
   order by f.stripe_synk_forsoegt_kl nulls first, f.opdateret_kl
   limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;
create or replace function public.firma_kunde_synk_udfoert(p_firma uuid, p_version integer)
returns void language sql security definer set search_path = '' as $$
  update public.firmaer set stripe_kunde_synket_version = greatest(stripe_kunde_synket_version, p_version)
   where id = p_firma;
$$;
revoke all on function public.firma_kunde_synk_kandidater(integer), public.firma_kunde_synk_udfoert(uuid, integer) from public, anon, authenticated;
grant execute on function public.firma_kunde_synk_kandidater(integer), public.firma_kunde_synk_udfoert(uuid, integer) to service_role;

-- ===========================================================================
-- 6. Oprettelse: advarsel, når CVR'et har haft et abonnement før
-- ===========================================================================
-- Tidligere firmakonti med samme CVR, der har haft et abonnement (startet,
-- haft en gratis periode eller betalt en regning).
create or replace function public.erhverv_cvr_tidligere_json(p_cvr text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'firma_id', f.id, 'firmanavn', f.firmanavn, 'abonnement_status', f.abonnement_status,
           'abonnement_start', f.abonnement_start, 'opsagt_kl', f.opsagt_kl,
           'havde_gratis_periode', f.proeve_givet_kl is not null,
           'betalte_regninger', (select count(*) from public.firma_regninger r
                                  where r.firma_id = f.id and r.status in ('betalt', 'krediteret') and r.beloeb_oere > 0))
         order by f.oprettet_kl desc), '[]'::jsonb)
    from public.firmaer f
   where f.cvr = p_cvr
     and (f.stripe_subscription_id is not null or f.abonnement_start is not null or f.proeve_givet_kl is not null
          or exists (select 1 from public.firma_regninger r
                      where r.firma_id = f.id and r.status in ('betalt', 'krediteret') and r.beloeb_oere > 0));
$$;
revoke all on function public.erhverv_cvr_tidligere_json(text) from public, anon, authenticated, service_role;

-- Forhåndstjek til opret-formularen (chef og sælger-rollen).
-- Svar {kode: 'ok', tidligere: boolean, firmaer: [...]} | {kode: 'ugyldigt_cvr'}
create or replace function public.erhverv_cvr_tidligere(p_staff uuid, p_cvr text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  v := public.erhverv_cvr_tidligere_json(p_cvr);
  return jsonb_build_object('kode', 'ok', 'tidligere', jsonb_array_length(v) > 0, 'firmaer', v);
end $$;
revoke all on function public.erhverv_cvr_tidligere(uuid, text) from public, anon, authenticated;
grant execute on function public.erhverv_cvr_tidligere(uuid, text) to service_role;

-- p_cvr_bekraeftet: null = som før (svaret får flaget cvr_tidligere_abonnement),
-- false = afvis med {kode: 'cvr_tidligere_abonnement', firmaer}, true = staff
-- har bekræftet (logges).
drop function if exists public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer);
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text,
  p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid default null,
  p_intro_procent integer default null, p_intro_maaneder integer default null,
  p_cvr_bekraeftet boolean default null)
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
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
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
  if jsonb_array_length(v_tidligere) > 0 and p_cvr_bekraeftet is false then
    return jsonb_build_object('kode', 'cvr_tidligere_abonnement', 'firmaer', v_tidligere);
  end if;
  if not exists (select 1 from public.erhverv_pakker p where p.id = p_pakke and p.arkiveret_kl is null) then
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

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af,
                                proeve_maaneder, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff, 1, p_intro_procent, p_intro_maaneder,
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

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || '), pakke '
               || (select navn from public.erhverv_pakker where id = p_pakke) || ', 1 gratis måned'
               || case when p_intro_procent is not null
                       then format(', introrabat %s %% i %s måneder efter den gratis måned', p_intro_procent, p_intro_maaneder)
                       else '' end
               || case when jsonb_array_length(v_tidligere) > 0
                       then case when p_cvr_bekraeftet then '; CVR''et har haft et abonnement før - bekræftet af staff'
                                 else '; CVR''et har haft et abonnement før' end
                       else '' end, 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id,
                            'cvr_tidligere_abonnement', jsonb_array_length(v_tidligere) > 0);
end $function$;
revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean) to service_role;

-- ===========================================================================
-- 7. Abonnement-JSON: gratis måneder ved start (velkomst + ventende)
-- ===========================================================================
create or replace function public.erhverv_firma_abonnement_json(p_firma uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f public.firmaer;
  p public.erhverv_pakker;
  k jsonb;
begin
  select * into f from public.firmaer where id = p_firma;
  if f.id is null then
    return null;
  end if;
  select * into p from public.erhverv_pakker where id = f.pakke_id;
  k := public.erhverv_firma_kvote_json(f.id);
  return jsonb_build_object(
    -- Månedsprisen ekskl. moms i hele kroner, som firmaet betaler (særpris
    -- eller pakkens pris), før en evt. introrabat.
    'pris', case when f.saerpris_oere is not null and f.saerpris_pakke_id = f.pakke_id
                 then f.saerpris_oere / 100 else p.maanedspris end,
    'saerpris', case when f.saerpris_pakke_id = f.pakke_id then f.saerpris_oere / 100 end,
    'saerpris_aftale', case when f.saerpris_pakke_id = f.pakke_id then f.saerpris_aftale end,
    'gratis_til', case when f.stripe_abonnement_status = 'trialing' then f.proeve_slut end,
    -- De gratis måneder, firmaet får, når det starter Checkout (samme regel
    -- som startBetaling): velkomstperioden + staff-givne ventende måneder.
    'gratis_maaneder_ved_start', case when f.stripe_subscription_id is null
                                      then least((case when public.erhverv_faar_velkomst_gratis(f.id)
                                                       then f.proeve_maaneder else 0 end)
                                                 + f.proeve_ekstra_ventende, 24)
                                      else 0 end,
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
-- 8. Kolonne-rettigheder på firmaer (firmaet selv, authenticated)
-- ===========================================================================
-- Firmaet læser kun sin egen række (RLS firmaer_select_egen) og kun disse
-- kolonner. Interne staff-kolonner (saerpris_aftale, oprettet_af,
-- henvendelse_id, intro_noegle/intro_coupon_id, låse, Stripe-id'er,
-- lukke-forsøg, synk-felter, proeve_givet_kl ...) kan ikke læses. Nye kolonner
-- er IKKE med automatisk. anon har ingen adgang. RLS-politikkerne på
-- firma_pakkeskift og firma_regninger bruger id og bruger_id (med på listen).
do $do$
declare
  v_alle   text;
  v_tilladt text;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_alle
    from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'firmaer';
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_tilladt
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'firmaer'
     and c.column_name in (
       'id', 'bruger_id', 'firmanavn', 'cvr', 'adresse', 'postnummer', 'bynavn', 'telefon', 'kontakt_email',
       'kontaktperson', 'pakke_id', 'naeste_pakke_id', 'naeste_pakke_fra', 'abonnement_status', 'abonnement_start',
       'betalt_til', 'periode_slut', 'opsiges_fra', 'opsagt_kl', 'pauset_aarsag', 'betaling_mislykket_kl',
       'stripe_abonnement_status', 'proeve_maaneder', 'proeve_slut', 'intro_procent', 'intro_maaneder', 'intro_fra',
       'intro_status', 'intro_til', 'saerpris_oere', 'saerpris_pakke_id', 'kort_maerke', 'kort_sidste4',
       'kort_udloeb_maaned', 'kort_udloeb_aar', 'bruger_brugtmoms', 'oprettet_kl', 'opdateret_kl');
  execute 'revoke select on public.firmaer from authenticated, anon';
  execute format('revoke select (%s) on public.firmaer from authenticated, anon', v_alle);
  execute format('grant select (%s) on public.firmaer to authenticated', v_tilladt);
end $do$;

-- ===========================================================================
-- 9. Annonce-mærket: kun aktive auktioner
-- ===========================================================================
create or replace function public.aktive_annoncer(p_auktioner uuid[])
returns table (auktion_id uuid, slut_kl timestamptz)
language sql stable security definer set search_path = '' as $fn$
  select h.auktion_id, max(h.slut_kl)
    from public.firma_fremhaevninger h
    join public.auctions a on a.id = h.auktion_id
   where h.auktion_id = any ((coalesce(p_auktioner, '{}'::uuid[]))[1:500])
     and a.status = 'aktiv' and a.slutter_kl > now()
     and not coalesce(a.skjult, false) and a.arkiveret_kl is null and a.pauset_kl is null
     and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
     and h.stoppet_kl is null and h.start_kl <= now() and h.slut_kl > now()
   group by h.auktion_id;
$fn$;

-- ===========================================================================
-- 10. Ugens butik
-- ===========================================================================
-- a. Holder firmaet ugen? betalt, manuel, behandles og reserveret - også en
-- reservation, der er udløbet, men endnu ikke ryddet af cron'en (den kan
-- stadig blive betalt). p_undtagen: en booking, der ikke skal tælles med.
create or replace function public.ugens_butik_holder(p_firma uuid, p_uge date, p_undtagen uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.ugens_butik_bookinger b
     where b.firma_id = p_firma and b.uge_start = p_uge and b.id is distinct from p_undtagen
       and b.status in ('reserveret', 'behandles', 'betalt', 'manuel'));
$fn$;

-- Antal uger i træk, firmaet holder, inkl. p_uge (0, hvis firmaet ikke
-- holder p_uge). Til admin.
create or replace function public.ugens_butik_stribe(p_firma uuid, p_uge date)
returns integer language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_n integer;
  v_u date;
begin
  if p_firma is null or p_uge is null or not public.ugens_butik_holder(p_firma, p_uge, null) then
    return 0;
  end if;
  v_n := 1;
  v_u := p_uge - 7;
  while v_n < 60 and public.ugens_butik_holder(p_firma, v_u, null) loop
    v_n := v_n + 1;
    v_u := v_u - 7;
  end loop;
  v_u := p_uge + 7;
  while v_n < 60 and public.ugens_butik_holder(p_firma, v_u, null) loop
    v_n := v_n + 1;
    v_u := v_u + 7;
  end loop;
  return v_n;
end;
$fn$;
revoke all on function public.ugens_butik_stribe(uuid, date) from public, anon, authenticated, service_role;

-- Spejler PaymentIntentens status (uændret fra 20261101060000, undtagen):
-- betales en reservation, der er udløbet, men ikke ryddet af cron'en, tjekkes
-- loftet igen ('for_sent', grund 'loft' - hele beløbet refunderes).
create or replace function public.ugens_butik_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text, p_valuta text default 'dkk')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k       record;
  v_k     uuid;
  v_firma uuid;
  v_uge   date;
  v_grund text;
  v_afv   boolean;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  -- Låserækkefølge: firmaet, ugen, rækken. Firma og uge slås op uden lås.
  select b.firma_id, b.uge_start into v_firma, v_uge
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi;
  if v_firma is null then
    select b.id into v_k from public.ugens_butik_bookinger b where p_pi = any(b.tidligere_payment_intents) limit 1;
    if v_k is not null then
      -- Den kasserede PaymentIntent er måske udløbet-reservationens: er
      -- bookingen udløbet med netop denne som seneste, og er ugen ledig,
      -- firmaet aktivt og loftet overholdt, får firmaet ugen alligevel.
      select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.id = v_k;
      perform public.ugens_butik_laas_firma(v_firma);
      perform public.ugens_butik_laas_uge(v_uge);
      select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl, b.bruger_id, b.loft_omgaaet,
             b.tidligere_payment_intents[array_length(b.tidligere_payment_intents, 1)] as seneste
        into k from public.ugens_butik_bookinger b where b.id = v_k for update;
      if p_status = 'succeeded' and k.status = 'udloebet' and k.seneste = p_pi and k.betalt_kl is null then
        if p_beloeb is distinct from k.beloeb_oere or p_valuta is distinct from 'dkk' then
          update public.ugens_butik_bookinger
             set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(), kraever_opmaerksomhed = true,
                 opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
                   'Ugens butik er betalt med et andet beløb (eller en anden valuta) end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
           where id = k.id;
          return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
        end if;
        v_grund := case
          when k.slut_kl <= now() then 'uge_slut'
          when public.ugens_butik_firma_spaerret(k.bruger_id) is not null then 'ikke_aktiv'
          when exists (select 1 from public.ugens_butik_bookinger b
                        where b.uge_start = v_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then 'optaget'
          when not k.loft_omgaaet and public.ugens_butik_loft_brudt(v_firma, v_uge, k.id) then 'loft'
        end;
        if v_grund is null then
          update public.ugens_butik_bookinger
             set status = 'betalt', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 udloebet_kl = null, sidste_fejl = null
           where id = k.id;
          return jsonb_build_object('kode', 'betalt', 'id', k.id);
        end if;
        update public.ugens_butik_bookinger
           set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
               tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
               stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
               refusion_aarsag = 'for_sent', refusion_anmodet_kl = now(), kraever_opmaerksomhed = true,
               opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
                 format('Ugens butik er betalt efter, at reservationen udløb (%s) - ugen er ikke givet, og hele beløbet refunderes automatisk.', v_grund)), 4000)
         where id = k.id;
        return jsonb_build_object('kode', 'for_sent', 'id', k.id, 'grund', v_grund);
      end if;
      if p_status = 'succeeded' then return jsonb_build_object('kode', 'kasseret', 'id', v_k); end if;
      return jsonb_build_object('kode', 'uaendret', 'id', v_k);
    end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl, b.bruger_id, b.reserveret_til, b.loft_omgaaet into k
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi for update;
  if k.id is null then return jsonb_build_object('kode', 'ukendt'); end if;

  if p_status = 'succeeded' then
    if k.betalt_kl is not null then return jsonb_build_object('kode', 'allerede', 'id', k.id); end if;
    v_afv := p_beloeb is distinct from k.beloeb_oere or p_valuta is distinct from 'dkk';
    if v_afv then
      update public.ugens_butik_bookinger
         set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null, refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(),
             kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
               'Ugens butik er betalt med et andet beløb (eller en anden valuta) end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
       where id = k.id;
      return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
    end if;
    v_grund := case
      when k.status not in ('reserveret', 'behandles') then 'annulleret'
      when k.slut_kl <= now() then 'uge_slut'
      when public.ugens_butik_firma_spaerret(k.bruger_id) is not null then 'ikke_aktiv'
      -- Udløbet, men ikke ryddet af cron'en: loftet tjekkes igen.
      when k.status = 'reserveret' and k.reserveret_til <= now() and not k.loft_omgaaet
           and public.ugens_butik_loft_brudt(v_firma, v_uge, k.id) then 'loft'
    end;
    if v_grund is null then
      update public.ugens_butik_bookinger
         set status = 'betalt', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null
       where id = k.id;
      return jsonb_build_object('kode', 'betalt', 'id', k.id);
    end if;
    -- Annulleret (staff), udløbet, ugen er slut, loftet, eller firmaet er
    -- ikke aktivt længere: pengene sendes tilbage (hele beløbet).
    update public.ugens_butik_bookinger
       set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, refusion_aarsag = 'for_sent', refusion_anmodet_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or v_grund <> 'annulleret',
           opmaerksomhed_tekst = case when v_grund = 'annulleret' then opmaerksomhed_tekst
                                      else left(concat_ws(E'\n', opmaerksomhed_tekst,
                                        case v_grund
                                          when 'uge_slut' then 'Ugens butik er betalt, efter at ugen var slut - ugen er ikke givet, og hele beløbet refunderes automatisk.'
                                          when 'loft' then 'Ugens butik er betalt, efter at reservationen var udløbet, og firmaet ville dermed få mere end 4 uger i træk (eller under 2 ugers pause efter 4 i træk) - ugen er ikke givet, og hele beløbet refunderes automatisk.'
                                          else 'Ugens butik er betalt, mens firmaet ikke var aktivt (pause, suspenderet eller lukket) - ugen er ikke givet, og hele beløbet refunderes automatisk.' end), 4000) end
     where id = k.id;
    return jsonb_build_object('kode', 'for_sent', 'id', k.id, 'grund', v_grund);
  elsif p_status = 'processing' then
    update public.ugens_butik_bookinger set status = 'behandles' where id = k.id and status = 'reserveret';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'requires_payment_method' then
    update public.ugens_butik_bookinger set status = 'reserveret', sidste_fejl = left(p_fejl, 500)
     where id = k.id and status in ('reserveret', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'canceled' then
    if k.status in ('reserveret', 'behandles') then
      update public.ugens_butik_bookinger
         set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
             stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1, status = 'reserveret'
       where id = k.id;
      return jsonb_build_object('kode', 'nulstillet', 'id', k.id);
    end if;
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', k.id);
end;
$fn$;

-- c. Admin: 'uger' får loft-status for hver booket uge (i_traek = uger i
-- træk inkl. denne, loft_brudt = firmaets uger omkring denne bryder reglen
-- (fx fordi staff har omgået loftet), loft_omgaaet = staff omgik loftet ved
-- netop denne booking).
create or replace function public.ugens_butik_admin(p_staff uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  s    public.ugens_butik_indstillinger%rowtype;
  v_nu date := public.ugens_butik_uge(now());
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  return jsonb_build_object(
    'rolle', public.ugens_butik_staff_rolle(p_staff),
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere,
                               'moms_oere', public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'opdateret_kl', s.opdateret_kl),
    'loft', jsonb_build_object('maks_uger_i_traek', 4, 'pause_uger', 2),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'igangvaerende', g.uge = v_nu,
               'booking_id', b.id, 'status', b.status, 'firma_id', b.firma_id, 'firmanavn', f.firmanavn,
               'i_traek', case when b.id is not null then public.ugens_butik_stribe(b.firma_id, g.uge) end,
               'loft_brudt', case when b.id is not null then public.ugens_butik_loft_brudt(b.firma_id, g.uge, b.id) end,
               'loft_omgaaet', b.loft_omgaaet)
             order by g.uge)
        from generate_series(v_nu, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
        left join public.firmaer f on f.id = b.firma_id), '[]'::jsonb),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'firma_id', b.firma_id, 'firmanavn', f.firmanavn, 'firma_bruger_id', b.bruger_id,
               'kilde', b.kilde, 'betaling', b.betaling, 'status', b.status,
               'reserveret_til', b.reserveret_til, 'beloeb_oere', b.beloeb_oere, 'modtaget_oere', b.modtaget_oere, 'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl, 'refusion_aarsag', b.refusion_aarsag,
               'annulleret_kl', b.annulleret_kl, 'annullering_begrundelse', b.annullering_begrundelse,
               'note', b.note, 'oprettet_af_navn', su.navn, 'oprettet_kl', b.oprettet_kl,
               'loft_omgaaet', b.loft_omgaaet,
               'kraever_opmaerksomhed', b.kraever_opmaerksomhed, 'opmaerksomhed_tekst', b.opmaerksomhed_tekst,
               'stripe_payment_intent_id', b.stripe_payment_intent_id)
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x order by x.uge_start desc, x.oprettet_kl desc limit 300) b
        left join public.firmaer f on f.id = b.firma_id
        left join public.users su on su.id = b.oprettet_af), '[]'::jsonb),
    'firmaer', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'firmanavn', f.firmanavn, 'aktiv', f.abonnement_status = 'aktiv',
                                          'abonnement_status', f.abonnement_status,
                                          'pakke_rabat_procent', coalesce(p.ugens_butik_rabat_procent, 0),
                                          'pakke_rabat_antal', coalesce(p.ugens_butik_rabat_antal, 0),
                                          'egen_rabat', case when o.rabat_procent is null then null
                                                             else jsonb_build_object('procent', o.rabat_procent, 'antal', o.rabat_antal,
                                                                                     'begrundelse', o.begrundelse, 'opdateret_kl', o.opdateret_kl,
                                                                                     'opdateret_af_navn', ou.navn) end)
             order by f.firmanavn)
        from public.firmaer f
        join public.users u on u.id = f.bruger_id
        left join public.erhverv_pakker p on p.id = f.pakke_id
        left join public.ugens_butik_firma_rabat o on o.firma_id = f.id
        left join public.users ou on ou.id = o.opdateret_af
       where u.konto_lukket_kl is null and u.konto_slettet_kl is null), '[]'::jsonb));
end;
$fn$;

-- b. Firma oversigt: 'bookinger' viser ikke annullerede bookinger uden
-- betaling (fx en staff-booking, der blev annulleret, før den blev betalt).
create or replace function public.firma_ugens_butik()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  s       public.ugens_butik_indstillinger%rowtype;
  v_nu    date := public.ugens_butik_uge(now());
  v_moms  bigint;
  v_aaben uuid;
begin
  if v_uid is null then return null; end if;
  select f.id into v_firma from public.firmaer f join public.users u on u.id = f.bruger_id
   where f.bruger_id = v_uid and u.konto_type = 'erhverv';
  if v_firma is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  v_moms := public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere);
  select b.id into v_aaben from public.ugens_butik_bookinger b
   where b.firma_id = v_firma and b.status in ('reserveret', 'behandles') limit 1;
  return jsonb_build_object(
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere, 'moms_oere', v_moms,
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + v_moms),
    'reservation_minutter', s.reservation_minutter,
    'loft', jsonb_build_object('maks_uger_i_traek', 4, 'pause_uger', 2),
    -- Rabatten (firmaets egen eller pakkens) og hvor mange rabat-uger, der
    -- er brugt i år (året for den igangværende uges mandag).
    'rabat', (select jsonb_build_object('procent', r.procent, 'antal_pr_aar', r.antal, 'brugt_i_aar', r.brugt,
                                        'tilbage_i_aar', greatest(r.antal - r.brugt, 0))
                from public.ugens_butik_rabat(v_firma, v_nu) r),
    'kan_koebe', public.ugens_butik_firma_spaerret(v_uid) is null,
    'grund', public.ugens_butik_firma_spaerret(v_uid),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'start_kl', public.ugens_butik_uge_start_kl(g.uge),
               'slut_kl', public.ugens_butik_uge_start_kl(g.uge + 7),
               'igangvaerende', g.uge = v_nu,
               'status', case when b.id is null then
                                (case when public.ugens_butik_loft_brudt(v_firma, g.uge, v_aaben) then 'loft' else 'ledig' end)
                              when b.firma_id = v_firma and b.status in ('reserveret', 'behandles') then 'din_reservation'
                              when b.firma_id = v_firma then 'din'
                              else 'optaget' end,
               -- Prisen for netop denne uge (rabat efter ugens kalenderår).
               'pris_inkl_moms_oere', pf.inkl_oere, 'pris_ekskl_moms_oere', pf.ekskl_oere,
               'rabat_procent', pf.rabat_procent)
             order by g.uge)
        from generate_series(v_nu, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        cross join lateral public.ugens_butik_pris_for(v_firma, g.uge) pf
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
         and not (b.status = 'reserveret' and b.reserveret_til <= now())), '[]'::jsonb),
    'aaben', (
      select jsonb_build_object('id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
                                'status', b.status, 'kilde', b.kilde, 'reserveret_til', b.reserveret_til,
                                'beloeb_oere', b.beloeb_oere, 'rabat_procent', b.rabat_procent)
        from public.ugens_butik_bookinger b
       where b.firma_id = v_firma and b.status in ('reserveret', 'behandles')
         and (b.status = 'behandles' or (b.reserveret_til > now() and b.slut_kl > now()))),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'aar', to_char(b.uge_start, 'IYYY')::int, 'start_kl', b.start_kl, 'slut_kl', b.slut_kl,
               'status', b.status, 'kilde', b.kilde, 'beloeb_oere', b.beloeb_oere,
               'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'aktiv_nu', b.status in ('betalt', 'manuel') and b.start_kl <= now() and b.slut_kl > now())
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x
               where x.firma_id = v_firma and x.status in ('betalt', 'manuel', 'refunderes', 'refunderet', 'annulleret')
                 and (x.status <> 'annulleret' or x.betalt_kl is not null)
               order by x.uge_start desc limit 100) b), '[]'::jsonb));
end;
$fn$;

-- ===========================================================================
-- 11. Klager: visningen af købers e-mail logges på firmaet
-- ===========================================================================
create or replace function public.erhverv_klage_detalje(p_staff uuid, p_klage uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chef    boolean;
  v_inhabil boolean;
  v_email   text;
  v_rolle   text;
  k         record;
  fm        record;
  fs        record;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  v_chef := public.erhverv_har_adgang(p_staff, true);

  select * into k from public.erhverv_klager where id = p_klage;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select * into fm from public.firmaer where id = k.firma_id;
  select * into fs from public.erhverv_advarsel_forslag
   where firma_id = k.firma_id and status = 'afventer';
  -- Inhabil (har handlet med firmaet eller er køberen): beskrivelse,
  -- billeder og købers e-mail vises ikke.
  v_inhabil := public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) or p_staff = k.koeber_id;

  -- Købers e-mail: chef og saelger (Filip, 26. okt. 2026) - ikke ved inhabilitet.
  if not v_inhabil then
    select coalesce(nullif(btrim(u.email), ''),
                    (select au.email::text from auth.users au where au.id = u.id))
      into v_email
      from public.users u where u.id = k.koeber_id;
  end if;

  -- Visningen logges (GDPR: dokumentation af, hvem der har set købers
  -- e-mail). bruger_id = FIRMAETS konto (klagen handler om firmaet) - så
  -- linjen ikke står på køberens brugerside. Køberen findes via maal_id.
  if v_email is not null then
    select u.rolle into v_rolle from public.users u where u.id = p_staff;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_staff, 'erhverv_klage_koeber_email_vist', 'erhverv_klage', k.id, k.firma_bruger_id,
            left('Købers e-mail vist i klage nr. ' || k.nummer
                 || ' (rolle: ' || coalesce(v_rolle, '?') || ')', 1000));
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'er_chef', v_chef,
    'inhabil', v_inhabil,
    'klage', jsonb_build_object(
      'id', k.id, 'nummer', k.nummer, 'trade_id', k.trade_id, 'kategori', k.kategori,
      'beskrivelse', case when v_inhabil then null else k.beskrivelse end,
      'status', k.status, 'afgoerelse', k.afgoerelse,
      'begrundelse', k.begrundelse, 'oprettet_kl', k.oprettet_kl, 'afgjort_kl', k.afgjort_kl,
      'afgjort_af_navn', (select u.navn from public.users u where u.id = k.afgjort_af),
      'behandles_af_navn', (select u.navn from public.users u where u.id = k.behandles_af),
      'behandling_startet_kl', k.behandling_startet_kl,
      'forslag_id', k.forslag_id),
    'billeder', case when v_inhabil then '[]'::jsonb else
                coalesce((select jsonb_agg(b.sti order by b.oprettet_kl)
                            from public.erhverv_klage_billeder b where b.klage_id = k.id), '[]'::jsonb) end,
    'noter', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'type', n.type, 'kanal', n.kanal, 'tekst', n.tekst,
               'oprettet_kl', n.oprettet_kl, 'staff_navn', u.navn)
             order by n.oprettet_kl)
        from public.erhverv_klage_noter n
        left join public.users u on u.id = n.staff_id
       where n.klage_id = k.id), '[]'::jsonb),
    'handel', (
      select jsonb_build_object(
               'id', t.id, 'titel', a.titel, 'beloeb', t.amount, 'status', t.status,
               'oprettet_kl', t.created_at, 'afhentning', coalesce(t.afhentning, false),
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at)
        from public.trades t
        left join public.auctions a on a.id = t.auction_id
        left join public.betalinger b on b.trade_id = t.id
       where t.id = k.trade_id),
    'firma', jsonb_build_object(
      'id', fm.id, 'bruger_id', fm.bruger_id, 'firmanavn', fm.firmanavn, 'cvr', fm.cvr,
      'kontaktperson', fm.kontaktperson, 'telefon', fm.telefon, 'kontakt_email', fm.kontakt_email,
      'adresse', fm.adresse, 'postnummer', fm.postnummer, 'bynavn', fm.bynavn,
      'abonnement_status', fm.abonnement_status,
      'konto_lukket', exists (select 1 from public.users u where u.id = fm.bruger_id and u.konto_lukket_kl is not null)),
    'koeber', (
      select jsonb_build_object('id', u.id, 'navn', u.navn, 'email', v_email)
        from public.users u where u.id = k.koeber_id),
    'statistik', jsonb_build_object(
      'klager_i_alt', (select count(*) from public.erhverv_klager x where x.firma_id = k.firma_id),
      'berettigede_12_mdr', (select count(*) from public.erhverv_klager x
                              where x.firma_id = k.firma_id and x.afgoerelse = 'berettiget'
                                and x.afgjort_kl > now() - interval '12 months'),
      'advarsler_antal', (select count(*) from public.advarsler a where a.bruger_id = k.firma_bruger_id),
      'afventende_forslag', case when fs.id is null then null else jsonb_build_object(
                              'id', fs.id, 'grundlag', fs.grundlag, 'antal_klager', fs.antal_klager,
                              'oprettet_kl', fs.oprettet_kl) end,
      'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag l
                                     where l.bruger_id = k.firma_bruger_id and l.status = 'afventer')));
end;
$$;
comment on function public.erhverv_klage_detalje(uuid, uuid) is
  'Én klage over et firma til admin (chef og saelger). Købers e-mail vises for chef og saelger, men ikke ved inhabilitet; hver visning logges i moderation_log (erhverv_klage_koeber_email_vist, bruger_id = firmaets konto - 20261102020000). Kun service_role - p_staff sættes af serveren efter rolletjek.';

-- Eksisterende linjer: bruger_id flyttes fra køberen til firmaets konto
-- (intet slettes; samme linje, rettet emne).
update public.moderation_log l
   set bruger_id = k.firma_bruger_id
  from public.erhverv_klager k
 where l.handling = 'erhverv_klage_koeber_email_vist'
   and l.maal_type = 'erhverv_klage' and l.maal_id = k.id
   and l.bruger_id is distinct from k.firma_bruger_id;

-- ===========================================================================
-- 12. Rettigheder (erstattede funktioner med uændret signatur beholder
-- deres - de sættes igen for en sikkerheds skyld)
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.firma_pris_synk_kandidater(integer)',
    'public.erhverv_firma_abonnement_json(uuid)',
    'public.ugens_butik_registrer(text, text, text, bigint, text, text)',
    'public.ugens_butik_admin(uuid)',
    'public.firma_ugens_butik()',
    'public.erhverv_klage_detalje(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
revoke all on function public.ugens_butik_holder(uuid, date, uuid) from public, anon, authenticated, service_role;
grant execute on function public.firma_ugens_butik() to authenticated;
revoke all on function public.aktive_annoncer(uuid[]) from public;
grant execute on function public.aktive_annoncer(uuid[]) to anon, authenticated, service_role;

drop function pg_temp.krop_md5(text);
