-- Nye firmapakker (Filip, 26. okt. 2026) - database.
--
-- Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti" -> "NYE pakker og priser
-- (Filip, 26. okt. 2026)", "Sælger-rollen kan lige så meget som chefen på
-- firmasiden" og "Abonnementsbetaling med Stripe Billing". Stripe-delen:
-- src/lib/erhverv/betaling.ts og src/lib/erhverv/firmaPris.ts.
--
-- Indhold:
--   1. Pakkerne: Start (10 auktioner/md, 499 kr.), Butik (30/md, 999 kr.,
--      Ugens butik 50 % x 3/år, 5 fremhævninger/md, statistik) og Pro
--      (ubegrænset, 1.999 kr., Ugens butik 50 % x 5/år, 20 fremhævninger/md,
--      fuld statistik, fast kontaktperson). Alle priser ekskl. moms.
--      Basis/Plus/Pro/Max arkiveres (omdøbes til "<navn> (gammel)", aktiv =
--      false, arkiveret_kl) - de slettes ikke. Firmaerne flyttes: Basis ->
--      Start, Plus -> Butik, Pro/Max -> Pro. Ventende pakkeskift til/fra de
--      gamle pakker annulleres. Har et flyttet firma et abonnement i Stripe,
--      sættes stripe_pris_synk, og betalings-cron'en skifter prisen i Stripe
--      til den nye pakke (fra næste betaling, ingen proration).
--   2. Kvoten er pr. KALENDERMÅNED (dansk tid, nulstilles den 1.). Alle
--      auktioner oprettet i måneden tæller, også annullerede. Pakkens antal +
--      ekstra auktioner i måneden (firma_maaned_ekstra). null = ubegrænset.
--      BHE03: "Du har oprettet X af Y auktioner i denne måned. Du kan oprette
--      den næste den 1. <måned>."
--   3. Fremhævede auktioner (ny): et firma fremhæver en aktiv auktion i 7
--      dage inden for månedens kvote (pakke + ekstra). Ubrugte forsvinder ved
--      månedens udgang. Vises øverst i kategori og søgning (liste_top - samme
--      pulje, loft (4) og rotation (10 min.) som boost) og markeres
--      "Annonce" (aktive_annoncer).
--   4. Prøveperiode, introrabat, særpris, gratis periode og kort på firmaet
--      (spejlet fra Stripe - Stripe er sandheden). Staff-RPC'er (chef og
--      sælger-rollen) logger alt med navn og begrundelse i moderation_log.
--   5. Statistikniveau pr. pakke: 'ingen' | 'statistik' | 'fuld'
--      (firma_statistik følger det).
--
-- Idempotent: kan køres flere gange. Første gang tjekkes, at de funktioner,
-- der erstattes, er repoets (md5-drift-tjek).

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælpere og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

do $do$
declare
  r record;
  h text;
begin
  -- Kun første gang (tabellen herunder findes ikke endnu): funktionerne, der
  -- erstattes, skal være præcis dem, repoet kender. Ellers er der rettet i
  -- databasen uden en migration - stop, så intet overskrives i blinde.
  if to_regclass('public.firma_fremhaevninger') is not null then
    return;
  end if;
  for r in
    select * from (values
      ('public.erhverv_pakke_gem(uuid,uuid,text,text,numeric,integer,boolean,integer,integer,integer)', '0da934ec3b8f2c3c80d8927d13f26110'),
      ('public.erhverv_kvote(uuid,boolean)', '6b4e9cb0dc7d87023fcb79b687b32d6a'),
      ('public.auctions_erhverv()', '49181a9f6670eea767098d8b5a57af2a'),
      ('public.firma_oversigt()', 'e145e281666ba4e8e8c970089bec858c'),
      ('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid)', 'b035a7741e054fde23be35e45594321d'),
      ('public.erhverv_firma_opdater(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'e527386aa15002ad539685b35071b8f0'),
      ('public.erhverv_firmaer_liste(uuid)', 'bcd216bd662ccb7c8a6cbcc949f9063d'),
      ('public.firma_skift_pakke_server(uuid,uuid)', 'e6e829a1e824fc298923568c0fb5b598'),
      ('public.firma_stripe_abonnement_spejl(uuid,text,text,timestamp with time zone,timestamp with time zone,boolean,text)', '94ac14d93acb855abdf9ddf106e85b8a'),
      ('public.firma_statistik()', '1524a764909f2a0de1d92fa489192bc7'),
      ('public.erhverv_pakke_json(uuid)', 'b1b7e26121854bd0821939a1bdb6271a'),
      ('public.erhverv_pakker_liste(uuid)', '456c8221e6b887be8988457514e73b76'),
      ('public.firma_ugekvote()', '6503b73f70afdda6ece744510a172405')
    ) as t(fn, gammel)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere erhvervsmigrationer først', r.fn;
    end if;
    if h <> r.gammel then
      raise exception '%: md5 % passer ikke med repoet (%) - kontrollér funktionen, før migrationen køres', r.fn, h, r.gammel;
    end if;
  end loop;
end $do$;

-- moderation_log: nye handlinger (alle med staff som medarbejder_id).
select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['firma_gratis_periode', 'firma_introrabat', 'firma_saerpris', 'firma_ekstra_auktioner',
        'firma_ekstra_fremhaevninger', 'firma_pakke_skiftet', 'firma_pakker_flyttet',
        'firma_fremhaevning_stoppet', 'firma_regning_refunderet', 'firma_kort_mail']);

-- ===========================================================================
-- 1. Pakker: nye kolonner
-- ===========================================================================
alter table public.erhverv_pakker add column if not exists auktioner_pr_maaned integer;
alter table public.erhverv_pakker add column if not exists fremhaevninger_pr_maaned integer not null default 0;
alter table public.erhverv_pakker add column if not exists statistik text not null default 'ingen';
alter table public.erhverv_pakker add column if not exists fast_kontaktperson boolean not null default false;
alter table public.erhverv_pakker add column if not exists arkiveret_kl timestamptz;
-- Ugekvoten er afløst af månedskvoten: kolonnen bevares (historik), men nye
-- pakker har ingen ugekvote.
alter table public.erhverv_pakker alter column auktioner_pr_uge drop not null;

alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_auktioner_maaned;
alter table public.erhverv_pakker add constraint erhverv_pakker_auktioner_maaned
  check (auktioner_pr_maaned is null or auktioner_pr_maaned between 1 and 100000);
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_fremhaevninger;
alter table public.erhverv_pakker add constraint erhverv_pakker_fremhaevninger
  check (fremhaevninger_pr_maaned between 0 and 1000);
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_statistik;
alter table public.erhverv_pakker add constraint erhverv_pakker_statistik
  check (statistik in ('ingen', 'statistik', 'fuld'));
-- En arkiveret pakke tilbydes aldrig.
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_arkiveret_ikke_aktiv;

comment on column public.erhverv_pakker.auktioner_pr_maaned is
  'Auktioner pr. kalendermåned (dansk tid). null = ubegrænset (Pro). 20261102010000.';
comment on column public.erhverv_pakker.fremhaevninger_pr_maaned is
  'Fremhævede auktioner pr. kalendermåned (7 dage hver, markeret "Annonce"). Ubrugte forsvinder ved månedens udgang.';
comment on column public.erhverv_pakker.statistik is
  'ingen | statistik (månedstal) | fuld (månedstal + hver auktion). firma_statistik følger det.';
comment on column public.erhverv_pakker.arkiveret_kl is
  'Arkiveret pakke (fx Basis/Plus/Pro/Max fra 8. okt. 2026): kan ikke vælges eller ændres, men slettes aldrig.';

-- ===========================================================================
-- 2. Firmaer: prøveperiode, introrabat, særpris, kort, prissynk
-- ===========================================================================
alter table public.firmaer add column if not exists proeve_maaneder integer not null default 1;
alter table public.firmaer add column if not exists proeve_slut timestamptz;
alter table public.firmaer add column if not exists proeve_givet_kl timestamptz;
alter table public.firmaer add column if not exists intro_procent integer;
alter table public.firmaer add column if not exists intro_maaneder integer;
alter table public.firmaer add column if not exists intro_fra text;
alter table public.firmaer add column if not exists intro_status text;
alter table public.firmaer add column if not exists intro_noegle uuid;
alter table public.firmaer add column if not exists intro_coupon_id text;
alter table public.firmaer add column if not exists intro_til timestamptz;
alter table public.firmaer add column if not exists saerpris_oere bigint;
alter table public.firmaer add column if not exists saerpris_pakke_id uuid references public.erhverv_pakker(id);
alter table public.firmaer add column if not exists saerpris_aftale text;
alter table public.firmaer add column if not exists kort_maerke text;
alter table public.firmaer add column if not exists kort_sidste4 text;
alter table public.firmaer add column if not exists kort_udloeb_maaned integer;
alter table public.firmaer add column if not exists kort_udloeb_aar integer;
alter table public.firmaer add column if not exists kort_opdateret_kl timestamptz;
alter table public.firmaer add column if not exists stripe_pris_synk boolean not null default false;

alter table public.firmaer drop constraint if exists firmaer_proeve_maaneder;
alter table public.firmaer add constraint firmaer_proeve_maaneder check (proeve_maaneder between 0 and 24);
alter table public.firmaer drop constraint if exists firmaer_intro;
alter table public.firmaer add constraint firmaer_intro check (
  (intro_procent is null and intro_maaneder is null and intro_fra is null and intro_status is null)
  or (intro_procent between 1 and 100 and intro_maaneder between 1 and 24
      and intro_fra in ('efter_gratis', 'straks') and intro_status in ('planlagt', 'aktiv')));
alter table public.firmaer drop constraint if exists firmaer_saerpris;
alter table public.firmaer add constraint firmaer_saerpris check (
  (saerpris_oere is null and saerpris_pakke_id is null and saerpris_aftale is null)
  or (saerpris_oere between 100 and 100000000 and saerpris_oere % 100 = 0 and saerpris_pakke_id is not null
      and char_length(saerpris_aftale) between 3 and 500));
alter table public.firmaer drop constraint if exists firmaer_kort;
alter table public.firmaer add constraint firmaer_kort check (
  (kort_sidste4 is null or kort_sidste4 ~ '^[0-9]{4}$')
  and (kort_maerke is null or char_length(kort_maerke) <= 40)
  and (kort_udloeb_maaned is null or kort_udloeb_maaned between 1 and 12)
  and (kort_udloeb_aar is null or kort_udloeb_aar between 2000 and 2200));

comment on column public.firmaer.proeve_maaneder is
  'Gratis måneder, når abonnementet starter (1 for alle nye firmaer; staff kan give flere, før firmaet har startet). Bruges som trial_end i Stripe Checkout.';
comment on column public.firmaer.proeve_slut is
  'Spejl af Stripes trial_end (gratis periode slutter). Stripe er sandheden.';
comment on column public.firmaer.intro_status is
  'planlagt: aftalt, ikke sat på abonnementet endnu (sættes, når abonnementet findes). aktiv: kuponen er på abonnementet i Stripe (intro_coupon_id, intro_til = discount.end).';
comment on column public.firmaer.saerpris_oere is
  'Særpris ekskl. moms i øre for pakken saerpris_pakke_id (egen Stripe-pris for firmaet). Skifter firmaet pakke, bortfalder særprisen.';
-- Særprisen gælder kun den pakke, den er aftalt for: skifter firmaet pakke
-- (uanset hvordan - firmaets opgradering, nedgradering, staff), bortfalder
-- den. Ét sted, så ingen vej kan glemme det.
create or replace function public.firmaer_saerpris_bortfalder()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.pakke_id is distinct from old.pakke_id
     and new.saerpris_pakke_id is not null and new.saerpris_pakke_id is distinct from new.pakke_id then
    new.saerpris_oere := null;
    new.saerpris_pakke_id := null;
    new.saerpris_aftale := null;
  end if;
  return new;
end $$;
revoke all on function public.firmaer_saerpris_bortfalder() from public, anon, authenticated;
drop trigger if exists firmaer_saerpris_bortfalder on public.firmaer;
create trigger firmaer_saerpris_bortfalder
  before update of pakke_id on public.firmaer
  for each row execute function public.firmaer_saerpris_bortfalder();

comment on column public.firmaer.stripe_pris_synk is
  'Prisen i Stripe skal skiftes til firmaets pakke/særpris (fra næste betaling) - sat ved flytning af pakker; betalings-cron''en gør det.';

-- Ekstra auktioner og fremhævninger i en bestemt kalendermåned.
create table if not exists public.firma_maaned_ekstra (
  firma_id        uuid not null references public.firmaer(id),
  maaned          date not null,
  auktioner       integer not null default 0 check (auktioner between 0 and 100000),
  fremhaevninger  integer not null default 0 check (fremhaevninger between 0 and 1000),
  opdateret_af    uuid references public.users(id),
  opdateret_kl    timestamptz not null default now(),
  primary key (firma_id, maaned),
  constraint firma_maaned_ekstra_dag check (extract(day from maaned) = 1)
);
comment on table public.firma_maaned_ekstra is
  'Ekstra auktioner/fremhævninger i én kalendermåned (dansk tid), givet af chef eller sælger-rollen (erhverv_firma_ekstra_giv - logget). Slettes aldrig.';

-- Fremhævede auktioner.
create table if not exists public.firma_fremhaevninger (
  id            uuid primary key default gen_random_uuid(),
  firma_id      uuid not null references public.firmaer(id),
  auktion_id    uuid not null references public.auctions(id) on delete restrict,
  maaned        date not null,
  start_kl      timestamptz not null default now(),
  slut_kl       timestamptz not null,
  oprettet_af   uuid references public.users(id),
  stoppet_kl    timestamptz,
  stoppet_af    uuid references public.users(id),
  stoppet_aarsag text check (stoppet_aarsag is null or char_length(stoppet_aarsag) <= 500),
  -- Staff har stoppet den og givet den tilbage til månedens kvote.
  tilbagegivet  boolean not null default false,
  oprettet_kl   timestamptz not null default now(),
  constraint firma_fremhaevninger_tid check (slut_kl > start_kl),
  constraint firma_fremhaevninger_dag check (extract(day from maaned) = 1)
);
create index if not exists firma_fremhaevninger_firma_idx on public.firma_fremhaevninger (firma_id, maaned);
create index if not exists firma_fremhaevninger_aktive_idx on public.firma_fremhaevninger (slut_kl) where stoppet_kl is null;
comment on table public.firma_fremhaevninger is
  'Fremhævet auktion (7 dage, "Annonce"): øverst i kategori og søgning (liste_top). Tæller i måneden for start_kl. Slettes aldrig.';

alter table public.firma_maaned_ekstra enable row level security;
alter table public.firma_fremhaevninger enable row level security;
revoke all on public.firma_maaned_ekstra, public.firma_fremhaevninger from public, anon, authenticated;
grant all on public.firma_maaned_ekstra, public.firma_fremhaevninger to service_role;

do $$
declare t text;
begin
  foreach t in array array['firma_maaned_ekstra', 'firma_fremhaevninger'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_sletning', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_sletning', t);
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_truncate', t);
  end loop;
end $$;

-- ===========================================================================
-- 3. Tid: kalendermåned i dansk tid
-- ===========================================================================
create or replace function public.erhverv_maaned_start(p_ts timestamptz)
returns timestamptz language sql stable set search_path = '' as $$
  select (date_trunc('month', p_ts at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
$$;

create or replace function public.erhverv_maaned_dato(p_ts timestamptz)
returns date language sql stable set search_path = '' as $$
  select date_trunc('month', p_ts at time zone 'Europe/Copenhagen')::date;
$$;

create or replace function public.erhverv_naeste_maaned(p_ts timestamptz)
returns timestamptz language sql stable set search_path = '' as $$
  select (date_trunc('month', p_ts at time zone 'Europe/Copenhagen') + interval '1 month') at time zone 'Europe/Copenhagen';
$$;

-- "november" (dansk månedsnavn, uafhængigt af serverens lc_time).
create or replace function public.erhverv_maaned_navn(p_ts timestamptz)
returns text language sql stable set search_path = '' as $$
  select (array['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august',
                'september', 'oktober', 'november', 'december'])
         [extract(month from p_ts at time zone 'Europe/Copenhagen')::int];
$$;

revoke all on function public.erhverv_maaned_start(timestamptz), public.erhverv_maaned_dato(timestamptz),
  public.erhverv_naeste_maaned(timestamptz), public.erhverv_maaned_navn(timestamptz) from public, anon, authenticated;
grant execute on function public.erhverv_maaned_start(timestamptz), public.erhverv_maaned_dato(timestamptz),
  public.erhverv_naeste_maaned(timestamptz), public.erhverv_maaned_navn(timestamptz) to service_role;

-- ===========================================================================
-- 4. Pakkerne: arkivér de gamle, opret de nye, flyt firmaerne
-- ===========================================================================
do $do$
declare
  v_start uuid;
  v_butik uuid;
  v_pro   uuid;
  v_ny    uuid;
  r       record;
  v_antal integer := 0;
  v_system uuid;
begin
  -- 4a. Arkivér Basis/Plus/Pro/Max (kun de gamle: de har en ugekvote og er
  -- ikke arkiveret). Navnet frigøres til den nye "Pro".
  update public.erhverv_pakker
     set navn = left(navn || ' (gammel)', 60), aktiv = false, arkiveret_kl = now(), opdateret_kl = now()
   where lower(navn) in ('basis', 'plus', 'pro', 'max')
     and arkiveret_kl is null and auktioner_pr_uge is not null and auktioner_pr_maaned is null;

  -- 4b. De nye pakker (faste id'er, så test og produktion har samme Stripe-
  -- produkt-id'er). Findes en ikke-arkiveret pakke med navnet allerede, bruges
  -- den og rettes til.
  for r in
    select * from (values
      ('7e57a000-0000-4000-8000-000000000001'::uuid, 'Start', 499, 10, 0, 'ingen', false, 0, 0, 10,
       'Firmaprofil og Firma oversigt med salg, udbetalinger og regninger. 10 auktioner om måneden.'),
      ('7e57a000-0000-4000-8000-000000000002'::uuid, 'Butik', 999, 30, 5, 'statistik', false, 50, 3, 20,
       'Som Start + 30 auktioner om måneden, 5 fremhævede auktioner om måneden, statistik og 50 % rabat på Ugens butik de første 3 gange hvert år.'),
      ('7e57a000-0000-4000-8000-000000000003'::uuid, 'Pro', 1999, null, 20, 'fuld', true, 50, 5, 30,
       'Ubegrænset antal auktioner, 20 fremhævede auktioner om måneden, fuld statistik, fast kontaktperson hos BidHamr og 50 % rabat på Ugens butik op til 5 gange hvert år.')
    ) as t(id, navn, pris, auktioner, fremh, stat, kontakt, ub_pct, ub_antal, sortering, beskrivelse)
  loop
    select p.id into v_ny from public.erhverv_pakker p
     where lower(p.navn) = lower(r.navn) and p.arkiveret_kl is null;
    if v_ny is null then
      insert into public.erhverv_pakker (id, navn, beskrivelse, maanedspris, auktioner_pr_uge, auktioner_pr_maaned,
                                         fremhaevninger_pr_maaned, statistik, fast_kontaktperson, aktiv, sortering,
                                         ugens_butik_rabat_procent, ugens_butik_rabat_antal)
      values (r.id, r.navn, r.beskrivelse, r.pris, null, r.auktioner, r.fremh, r.stat, r.kontakt, true, r.sortering,
              r.ub_pct, r.ub_antal)
      on conflict (id) do nothing;
      v_ny := r.id;
    end if;
    -- Kun første gang (pakken er ikke sat op endnu): bagefter er det chefens
    -- pakke, og en ny kørsel må ikke overskrive chefens rettelser.
    update public.erhverv_pakker
       set beskrivelse = r.beskrivelse, maanedspris = r.pris, auktioner_pr_uge = null,
           auktioner_pr_maaned = r.auktioner, fremhaevninger_pr_maaned = r.fremh, statistik = r.stat,
           fast_kontaktperson = r.kontakt, aktiv = true, sortering = r.sortering,
           ugens_butik_rabat_procent = r.ub_pct, ugens_butik_rabat_antal = r.ub_antal, opdateret_kl = now()
     where id = v_ny and auktioner_pr_uge is not null;
    if r.navn = 'Start' then v_start := v_ny; elsif r.navn = 'Butik' then v_butik := v_ny; else v_pro := v_ny; end if;
    v_ny := null;
  end loop;

  -- 4c. Flyt firmaerne fra de arkiverede pakker.
  v_system := case when to_regprocedure('public.bidhamr_system_id()') is not null
                   then public.bidhamr_system_id() end;
  for r in
    select f.id, f.bruger_id, f.firmanavn, f.cvr, f.pakke_id, p.navn as gammel_navn,
           case lower(regexp_replace(p.navn, ' \(gammel\)$', ''))
             when 'basis' then v_start when 'plus' then v_butik else v_pro end as ny_pakke,
           f.stripe_subscription_id
      from public.firmaer f
      join public.erhverv_pakker p on p.id = f.pakke_id
     where p.arkiveret_kl is not null
       and lower(regexp_replace(p.navn, ' \(gammel\)$', '')) in ('basis', 'plus', 'pro', 'max')
     for update of f
  loop
    update public.firma_pakkeskift
       set status = 'annulleret', behandlet_kl = now(),
           note = coalesce(note, 'Pakkerne er skiftet (26. okt. 2026) - vælg den nye pakke igen')
     where firma_id = r.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer
       set pakke_id = r.ny_pakke, naeste_pakke_id = null, naeste_pakke_fra = null,
           stripe_pris_synk = (r.stripe_subscription_id is not null), opdateret_kl = now()
     where id = r.id;
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl, note)
    values (r.id, r.pakke_id, r.ny_pakke, 'bidhamr', 'gennemfoert', null, now(),
            'Nye pakker (Filip, 26. okt. 2026): ' || r.gammel_navn || ' flyttet');
    if v_system is not null and exists (select 1 from public.users where id = v_system) then
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (v_system, 'firma_pakker_flyttet', 'firma', r.id, r.bruger_id,
              left(format('Nye pakker: %s -> %s; %s (CVR %s)', r.gammel_navn,
                          (select navn from public.erhverv_pakker where id = r.ny_pakke), r.firmanavn, r.cvr), 1000));
    end if;
    v_antal := v_antal + 1;
  end loop;
  -- En planlagt nedgradering til en arkiveret pakke kan ikke gennemføres.
  update public.firma_pakkeskift s
     set status = 'annulleret', behandlet_kl = now(),
         note = coalesce(s.note, 'Pakkerne er skiftet (26. okt. 2026) - vælg den nye pakke igen')
    from public.erhverv_pakker p
   where p.id = s.til_pakke_id and p.arkiveret_kl is not null and s.status in ('afventer_betaling', 'planlagt');
  update public.firmaer f set naeste_pakke_id = null, naeste_pakke_fra = null
    from public.erhverv_pakker p
   where p.id = f.naeste_pakke_id and p.arkiveret_kl is not null;
  raise notice 'Firmapakker: % firma(er) flyttet til de nye pakker', v_antal;
end $do$;

-- ===========================================================================
-- 5. Pakke-JSON, kvote og fremhævninger
-- ===========================================================================
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
                            'aktiv', p.aktiv,
                            'arkiveret', p.arkiveret_kl is not null)
    from public.erhverv_pakker p where p.id = p_pakke;
$$;
revoke all on function public.erhverv_pakke_json(uuid) from public, anon, authenticated;

-- Rækkefølge mellem pakker (opgradering = større pakke): flere auktioner
-- (ubegrænset størst), derefter flere fremhævninger, derefter højere pris.
create or replace function public.erhverv_pakke_rang(p_pakke uuid)
returns numeric[] language sql stable security definer set search_path = '' as $$
  select array[coalesce(p.auktioner_pr_maaned, 1000000000)::numeric,
               p.fremhaevninger_pr_maaned::numeric, coalesce(p.maanedspris, 0)]
    from public.erhverv_pakker p where p.id = p_pakke;
$$;
revoke all on function public.erhverv_pakke_rang(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_pakke_rang(uuid) to service_role;

-- Månedens kvote for et firma (intern). Pakken er den, der gælder nu (en
-- planlagt nedgradering, hvis dato er nået, tæller).
--   {pakke_id, pakke_maks (null = ubegrænset), ekstra, maks (null = ubegrænset),
--    brugt, fremhaevninger: {pakke, ekstra, maks, brugt, tilbage}, periode_start,
--    periode_slut}
create or replace function public.erhverv_firma_kvote_json(p_firma uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f        public.firmaer;
  p        public.erhverv_pakker;
  v_start  timestamptz := public.erhverv_maaned_start(now());
  v_slut   timestamptz := public.erhverv_naeste_maaned(now());
  v_md     date := public.erhverv_maaned_dato(now());
  v_ekstra_a integer := 0;
  v_ekstra_f integer := 0;
  v_brugt  integer;
  v_fbrugt integer;
begin
  select * into f from public.firmaer where id = p_firma;
  if f.id is null then
    return null;
  end if;
  select * into p from public.erhverv_pakker
   where id = case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                   then f.naeste_pakke_id else f.pakke_id end;
  select coalesce(e.auktioner, 0), coalesce(e.fremhaevninger, 0) into v_ekstra_a, v_ekstra_f
    from public.firma_maaned_ekstra e where e.firma_id = f.id and e.maaned = v_md;
  v_ekstra_a := coalesce(v_ekstra_a, 0);
  v_ekstra_f := coalesce(v_ekstra_f, 0);
  -- Alle auktioner oprettet i måneden tæller - også annullerede.
  select count(*) into v_brugt from public.auctions a
   where a.bruger_id = f.bruger_id and a.oprettet >= v_start;
  select count(*) into v_fbrugt from public.firma_fremhaevninger h
   where h.firma_id = f.id and h.maaned = v_md and not h.tilbagegivet;
  return jsonb_build_object(
    'pakke_id', p.id,
    'pakke_maks', p.auktioner_pr_maaned,
    'ekstra', v_ekstra_a,
    'maks', case when p.id is null then 0
                 when p.auktioner_pr_maaned is null then null
                 else p.auktioner_pr_maaned + v_ekstra_a end,
    'ubegraenset', p.id is not null and p.auktioner_pr_maaned is null,
    'brugt', v_brugt,
    'fremhaevninger', jsonb_build_object(
      'pakke', coalesce(p.fremhaevninger_pr_maaned, 0),
      'ekstra', v_ekstra_f,
      'maks', coalesce(p.fremhaevninger_pr_maaned, 0) + v_ekstra_f,
      'brugt', v_fbrugt,
      'tilbage', greatest(coalesce(p.fremhaevninger_pr_maaned, 0) + v_ekstra_f - v_fbrugt, 0)),
    'periode_start', v_start,
    'periode_slut', v_slut);
end $$;
revoke all on function public.erhverv_firma_kvote_json(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_kvote_json(uuid) to service_role;

-- Kvoten for en firmakonto (bruges af auctions_erhverv ved oprettelse, med
-- p_laas). Svar: {kode: ok|erhverv_kvote|erhverv_intet_abonnement, brugt,
-- max (null = ubegrænset), ekstra, ubegraenset, maaned_start, naeste_maaned,
-- naeste_ledige} + de gamle nøgler uge_start/naeste_uge (= måneden) for
-- bagudkompatibilitet.
create or replace function public.erhverv_kvote(p_bruger uuid, p_laas boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.firmaer;
  k        jsonb;
  v_start  timestamptz := public.erhverv_maaned_start(now());
  v_naeste timestamptz := public.erhverv_naeste_maaned(now());
  v_max    integer;
  v_brugt  integer;
  v_kode   text;
begin
  if p_laas then
    select * into f from public.firmaer where bruger_id = p_bruger for update;
    if f.id is not null and f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now() then
      perform public.firma_anvend_planlagt(f.id);
      select * into f from public.firmaer where id = f.id;
    end if;
  else
    select * into f from public.firmaer where bruger_id = p_bruger;
  end if;

  if f.id is null then
    return jsonb_build_object('kode', 'erhverv_intet_abonnement', 'brugt', 0, 'max', 0, 'ekstra', 0,
                              'ubegraenset', false, 'maaned_start', v_start, 'naeste_maaned', v_naeste,
                              'uge_start', v_start, 'naeste_uge', v_naeste, 'naeste_ledige', null);
  end if;

  k := public.erhverv_firma_kvote_json(f.id);
  v_max := (k->>'maks')::integer;
  v_brugt := (k->>'brugt')::integer;
  v_kode := case
    when f.abonnement_status <> 'aktiv' then 'erhverv_intet_abonnement'
    when v_max is not null and v_brugt >= v_max then 'erhverv_kvote'
    else 'ok' end;

  return jsonb_build_object(
    'kode', v_kode,
    'brugt', v_brugt,
    'max', v_max,
    'ekstra', (k->>'ekstra')::integer,
    'ubegraenset', (k->>'ubegraenset')::boolean,
    'maaned_start', v_start,
    'naeste_maaned', v_naeste,
    'uge_start', v_start,
    'naeste_uge', v_naeste,
    'naeste_ledige', case when v_kode = 'erhverv_intet_abonnement' then null
                          when v_kode = 'ok' then now() else v_naeste end);
end $$;

revoke all on function public.erhverv_kvote(uuid, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_kvote(uuid, boolean) to service_role;

-- Firmaets egen månedskvote (Firma oversigt, opret auktion og appen).
-- null, hvis brugeren ikke er en firmakonto.
create or replace function public.firma_kvote()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_fid uuid;
  k  jsonb;
  kj jsonb;
begin
  if v_uid is null then
    return null;
  end if;
  select id into v_fid from public.firmaer where bruger_id = v_uid;
  if v_fid is null then
    return null;
  end if;
  k := public.erhverv_kvote(v_uid, false);
  kj := public.erhverv_firma_kvote_json(v_fid);
  return jsonb_build_object(
    'brugt', k->'brugt', 'max', k->'max', 'ekstra', k->'ekstra', 'ubegraenset', k->'ubegraenset',
    'kan_oprette', k->>'kode' = 'ok',
    'naeste_ledige', k->'naeste_ledige',
    'maaned_start', k->'maaned_start', 'naeste_maaned', k->'naeste_maaned',
    -- Bagudkompatible nøgler (= måneden).
    'uge_start', k->'maaned_start', 'naeste_uge', k->'naeste_maaned',
    'aktivt_abonnement', k->>'kode' <> 'erhverv_intet_abonnement',
    'fremhaevninger', kj->'fremhaevninger');
end $$;
revoke all on function public.firma_kvote() from public, anon, authenticated;
grant execute on function public.firma_kvote() to authenticated, service_role;

-- Gammelt navn (appen): samme svar som firma_kvote().
create or replace function public.firma_ugekvote()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.firma_kvote();
$$;
revoke all on function public.firma_ugekvote() from public, anon, authenticated;
grant execute on function public.firma_ugekvote() to authenticated, service_role;

-- Oprettelse af en erhvervsauktion: abonnement og månedskvote (BHE02/BHE03).
create or replace function public.auctions_erhverv()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_k jsonb;
begin
  if tg_op = 'INSERT' then
    new.erhverv := coalesce((select u.konto_type = 'erhverv' from public.users u where u.id = new.bruger_id), false);
    if new.erhverv then
      if exists (select 1 from public.firmaer fa
                  where fa.bruger_id = new.bruger_id and fa.abonnement_status = 'afventer_betaling') then
        raise exception 'erhverv_intet_abonnement: Betal for din pakke under Abonnement i Firma oversigt, før du opretter auktioner.'
          using errcode = 'BHE02';
      end if;
      v_k := public.erhverv_kvote(new.bruger_id, true);
      if v_k->>'kode' = 'erhverv_intet_abonnement' then
        raise exception 'erhverv_intet_abonnement: Firmaet har ikke et aktivt abonnement. Kontakt BidHamr på erhverv@bidhamr.dk.'
          using errcode = 'BHE02';
      elsif v_k->>'kode' = 'erhverv_kvote' then
        raise exception 'erhverv_kvote: Du har oprettet % af % auktioner i denne måned. Du kan oprette den næste den 1. %.',
          v_k->>'brugt', v_k->>'max', public.erhverv_maaned_navn((v_k->>'naeste_maaned')::timestamptz)
          using errcode = 'BHE03';
      end if;
    end if;
  else
    new.erhverv := old.erhverv;
  end if;

  if not new.erhverv then
    new.producent := null;
    new.sikkerhedsoplysninger := null;
    return new;
  end if;

  new.producent := nullif(btrim(coalesce(new.producent, '')), '');
  new.sikkerhedsoplysninger := nullif(btrim(coalesce(new.sikkerhedsoplysninger, '')), '');

  if public.stand_normaliser(new.stand) = 'ny_med_maerke'
     and (tg_op = 'INSERT'
          or new.stand is distinct from old.stand
          or new.producent is distinct from old.producent
          or new.sikkerhedsoplysninger is distinct from old.sikkerhedsoplysninger)
     and (char_length(coalesce(new.producent, '')) < 3
          or char_length(coalesce(new.sikkerhedsoplysninger, '')) < 3) then
    raise exception 'erhverv_gpsr: Når varen er ny, skal du udfylde producent (navn og adresse) og sikkerhedsoplysninger.'
      using errcode = 'BHE04';
  end if;

  return new;
end $function$;
revoke all on function public.auctions_erhverv() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fremhævning af en auktion (firmaet selv)
-- ---------------------------------------------------------------------------
-- Regler: auktionen er firmaets egen, aktiv, synlig (ikke skjult, arkiveret,
-- på pause eller i kunst-kontrol), har mindst 1 time tilbage og er ikke
-- fremhævet i forvejen. Firmaet er aktivt og ikke spærret. Månedens kvote
-- (pakke + ekstra) må ikke være brugt. Fremhævningen varer 7 dage (stopper
-- med auktionen) og tæller i den måned, den startes.
-- Svar: {kode: 'ok', id, slut_kl, tilbage} eller {kode, besked} med
--   ikke_firma | spaerret | ikke_aktiv | ikke_fundet | ikke_din | ikke_aktiv_auktion |
--   for_kort_tid | allerede | kvote_brugt
create or replace function public.firma_fremhaev_auktion(p_auktion uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  u     record;
  f     public.firmaer;
  a     public.auctions;
  k     jsonb;
  v_id  uuid;
  v_slut timestamptz;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl into u from public.users where id = v_uid;
  select * into f from public.firmaer where bruger_id = v_uid for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_firma', 'besked', 'Kun firmakonti kan fremhæve auktioner.');
  end if;
  if u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now())) then
    return jsonb_build_object('kode', 'spaerret', 'besked', 'Din konto er spærret, så du kan ikke fremhæve auktioner.');
  end if;
  if f.abonnement_status <> 'aktiv' then
    return jsonb_build_object('kode', 'ikke_aktiv', 'besked', 'Dit abonnement er ikke aktivt, så du kan ikke fremhæve auktioner.');
  end if;
  select * into a from public.auctions where id = p_auktion for update;
  if a.id is null then
    return jsonb_build_object('kode', 'ikke_fundet', 'besked', 'Auktionen findes ikke.');
  end if;
  if a.bruger_id <> v_uid then
    return jsonb_build_object('kode', 'ikke_din', 'besked', 'Du kan kun fremhæve dine egne auktioner.');
  end if;
  if a.status <> 'aktiv' or coalesce(a.skjult, false) or a.arkiveret_kl is not null or a.pauset_kl is not null
     or (to_jsonb(a) ->> 'kunst_kontrol') is not distinct from 'afventer' then
    return jsonb_build_object('kode', 'ikke_aktiv_auktion', 'besked', 'Du kan kun fremhæve en aktiv auktion, som købere kan se.');
  end if;
  if a.slutter_kl <= now() + interval '1 hour' then
    return jsonb_build_object('kode', 'for_kort_tid', 'besked', 'Auktionen slutter om under 1 time og kan ikke fremhæves.');
  end if;
  if exists (select 1 from public.firma_fremhaevninger h
              where h.auktion_id = a.id and h.stoppet_kl is null and h.slut_kl > now()) then
    return jsonb_build_object('kode', 'allerede', 'besked', 'Auktionen er allerede fremhævet.');
  end if;
  k := public.erhverv_firma_kvote_json(f.id);
  if (k->'fremhaevninger'->>'tilbage')::integer <= 0 then
    return jsonb_build_object('kode', 'kvote_brugt',
      'besked', format('Du har brugt dine %s fremhævninger i denne måned. Du får nye den 1. %s.',
                       k->'fremhaevninger'->>'maks', public.erhverv_maaned_navn(public.erhverv_naeste_maaned(now()))));
  end if;
  v_slut := least(now() + interval '7 days', a.slutter_kl);
  insert into public.firma_fremhaevninger (firma_id, auktion_id, maaned, start_kl, slut_kl, oprettet_af)
  values (f.id, a.id, public.erhverv_maaned_dato(now()), now(), v_slut, v_uid)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'slut_kl', v_slut,
                            'tilbage', (k->'fremhaevninger'->>'tilbage')::integer - 1);
end $$;
revoke all on function public.firma_fremhaev_auktion(uuid) from public, anon, authenticated;
grant execute on function public.firma_fremhaev_auktion(uuid) to authenticated, service_role;

-- Firmaets fremhævninger: månedens kvote + aktive og seneste (højst 50).
create or replace function public.firma_fremhaevninger()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_fid uuid;
begin
  if v_uid is null then
    return null;
  end if;
  select id into v_fid from public.firmaer where bruger_id = v_uid;
  if v_fid is null then
    return null;
  end if;
  return jsonb_build_object(
    'kvote', public.erhverv_firma_kvote_json(v_fid)->'fremhaevninger',
    'naeste_maaned', public.erhverv_naeste_maaned(now()),
    'fremhaevninger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', h.id, 'auktion_id', h.auktion_id, 'titel', a.titel,
               'start_kl', h.start_kl, 'slut_kl', h.slut_kl, 'stoppet_kl', h.stoppet_kl,
               'aktiv', h.stoppet_kl is null and h.slut_kl > now() and a.status = 'aktiv')
             order by h.start_kl desc)
        from (select * from public.firma_fremhaevninger h0 where h0.firma_id = v_fid
               order by h0.start_kl desc limit 50) h
        join public.auctions a on a.id = h.auktion_id), '[]'::jsonb));
end $$;
revoke all on function public.firma_fremhaevninger() from public, anon, authenticated;
grant execute on function public.firma_fremhaevninger() to authenticated, service_role;

-- Øverst i kategori og søgning: boostede (private) og fremhævede (firmaer)
-- auktioner i ÉN pulje - samme loft (boost_indstillinger.maks_pladser = 4) og
-- rotation (rotation_minutter = 10) som boost_top, sorteret efter start.
-- type: 'boost' (mærket "Boostet") | 'annonce' (mærket "Annonce").
-- Forsiden bruger stadig boost_top (sektionen "Boostede auktioner").
create or replace function public.liste_top(p_kategori text default null, p_soeg text default null)
returns table (auktion_id uuid, start_kl timestamptz, slut_kl timestamptz, type text)
language plpgsql stable security definer set search_path = '' as $fn$
#variable_conflict use_column
declare
  s public.boost_indstillinger%rowtype;
  v_soeg text := nullif(lower(btrim(left(coalesce(p_soeg, ''), 100))), '');
  v_kategori text := nullif(btrim(left(coalesce(p_kategori, ''), 100)), '');
  v_slot bigint;
begin
  select * into s from public.boost_indstillinger where id;
  if not found then return; end if;
  v_slot := floor(extract(epoch from now()) / (s.rotation_minutter * 60))::bigint;
  return query
  with alle as (
    select b.auktion_id, b.start_kl, b.slut_kl, 'boost'::text as type
      from public.auktion_boosts b
     where b.start_kl <= now() and b.slut_kl > now()
    union all
    select h.auktion_id, h.start_kl, h.slut_kl, 'annonce'::text
      from public.firma_fremhaevninger h
     where h.stoppet_kl is null and h.start_kl <= now() and h.slut_kl > now()
  ), k as (
    select x.auktion_id, x.start_kl, x.slut_kl, x.type,
           (row_number() over (order by x.start_kl, x.auktion_id) - 1)::bigint as nr,
           (count(*) over ())::bigint as n
      from alle x
      join public.auctions a on a.id = x.auktion_id
     where a.status = 'aktiv' and not coalesce(a.skjult, false) and a.arkiveret_kl is null
       and a.pauset_kl is null and a.slutter_kl > now()
       and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
       and (v_kategori is null or a.kategori = v_kategori)
       and (v_soeg is null or strpos(lower(a.titel), v_soeg) > 0)
  )
  select k.auktion_id, k.start_kl, k.slut_kl, k.type
    from k
   where k.n <= s.maks_pladser
      or ((k.nr - (v_slot * s.maks_pladser) % k.n) + k.n) % k.n < s.maks_pladser
   order by k.start_kl, k.auktion_id;
end;
$fn$;
revoke all on function public.liste_top(text, text) from public;
grant execute on function public.liste_top(text, text) to anon, authenticated, service_role;

-- Hvilke af auktionerne er fremhævet ("Annonce") lige nu?
create or replace function public.aktive_annoncer(p_auktioner uuid[])
returns table (auktion_id uuid, slut_kl timestamptz)
language sql stable security definer set search_path = '' as $fn$
  select h.auktion_id, max(h.slut_kl)
    from public.firma_fremhaevninger h
    join public.auctions a on a.id = h.auktion_id
   where h.auktion_id = any ((coalesce(p_auktioner, '{}'::uuid[]))[1:500])
     and not coalesce(a.skjult, false) and a.arkiveret_kl is null and a.pauset_kl is null
     and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
     and h.stoppet_kl is null and h.start_kl <= now() and h.slut_kl > now()
   group by h.auktion_id;
$fn$;
revoke all on function public.aktive_annoncer(uuid[]) from public;
grant execute on function public.aktive_annoncer(uuid[]) to anon, authenticated, service_role;

-- ===========================================================================
-- 6. Pakker (kun chef)
-- ===========================================================================
drop function if exists public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer, integer, integer);

-- p_ubegraenset = true: ubegrænset antal auktioner (p_auktioner_pr_maaned
-- ignoreres). null i de valgfrie felter = uændret (ny pakke: standard).
create or replace function public.erhverv_pakke_gem(
  p_staff uuid,
  p_id uuid,
  p_navn text,
  p_beskrivelse text,
  p_maanedspris numeric,
  p_auktioner_pr_maaned integer,
  p_ubegraenset boolean default false,
  p_fremhaevninger_pr_maaned integer default null,
  p_statistik text default null,
  p_fast_kontaktperson boolean default null,
  p_aktiv boolean default true,
  p_sortering integer default 0,
  p_ugens_butik_rabat_procent integer default null,
  p_ugens_butik_rabat_antal integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_navn text := btrim(coalesce(p_navn, ''));
  v_id   uuid;
  v_pct  integer;
  v_ant  integer;
  v_auk  integer := case when coalesce(p_ubegraenset, false) then null else p_auktioner_pr_maaned end;
  r      public.erhverv_pakker;
begin
  if not public.erhverv_har_adgang(p_staff, true) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if char_length(v_navn) < 1 or char_length(v_navn) > 60 then
    return jsonb_build_object('kode', 'ugyldigt_navn');
  end if;
  if p_beskrivelse is not null and char_length(p_beskrivelse) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if p_maanedspris is not null and (p_maanedspris < 0 or p_maanedspris > 1000000 or p_maanedspris <> trunc(p_maanedspris)) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  if not coalesce(p_ubegraenset, false)
     and (p_auktioner_pr_maaned is null or p_auktioner_pr_maaned < 1 or p_auktioner_pr_maaned > 100000) then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  if p_fremhaevninger_pr_maaned is not null and p_fremhaevninger_pr_maaned not between 0 and 1000 then
    return jsonb_build_object('kode', 'ugyldige_fremhaevninger');
  end if;
  if p_statistik is not null and p_statistik not in ('ingen', 'statistik', 'fuld') then
    return jsonb_build_object('kode', 'ugyldig_statistik');
  end if;
  if (p_ugens_butik_rabat_procent is null) <> (p_ugens_butik_rabat_antal is null)
     or (p_ugens_butik_rabat_procent is not null
         and (p_ugens_butik_rabat_procent not between 0 and 90 or p_ugens_butik_rabat_antal not between 0 and 52)) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  if exists (select 1 from public.erhverv_pakker where lower(navn) = lower(v_navn) and id is distinct from p_id) then
    return jsonb_build_object('kode', 'navn_findes');
  end if;

  if p_id is null then
    insert into public.erhverv_pakker (navn, beskrivelse, maanedspris, auktioner_pr_uge, auktioner_pr_maaned,
                                       fremhaevninger_pr_maaned, statistik, fast_kontaktperson, aktiv, sortering,
                                       oprettet_af, opdateret_af, ugens_butik_rabat_procent, ugens_butik_rabat_antal)
    values (v_navn, nullif(btrim(coalesce(p_beskrivelse, '')), ''), p_maanedspris, null, v_auk,
            coalesce(p_fremhaevninger_pr_maaned, 0), coalesce(p_statistik, 'ingen'), coalesce(p_fast_kontaktperson, false),
            coalesce(p_aktiv, true), coalesce(p_sortering, 0), p_staff, p_staff,
            coalesce(p_ugens_butik_rabat_procent, 0), coalesce(p_ugens_butik_rabat_antal, 0))
    returning * into r;
  else
    select * into r from public.erhverv_pakker where id = p_id for update;
    if r.id is null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    if r.arkiveret_kl is not null then
      return jsonb_build_object('kode', 'arkiveret');
    end if;
    update public.erhverv_pakker
       set navn = v_navn, beskrivelse = nullif(btrim(coalesce(p_beskrivelse, '')), ''),
           maanedspris = p_maanedspris, auktioner_pr_maaned = v_auk,
           fremhaevninger_pr_maaned = coalesce(p_fremhaevninger_pr_maaned, fremhaevninger_pr_maaned),
           statistik = coalesce(p_statistik, statistik),
           fast_kontaktperson = coalesce(p_fast_kontaktperson, fast_kontaktperson),
           aktiv = coalesce(p_aktiv, aktiv), sortering = coalesce(p_sortering, sortering),
           ugens_butik_rabat_procent = coalesce(p_ugens_butik_rabat_procent, ugens_butik_rabat_procent),
           ugens_butik_rabat_antal = coalesce(p_ugens_butik_rabat_antal, ugens_butik_rabat_antal),
           opdateret_af = p_staff, opdateret_kl = now()
     where id = p_id
    returning * into r;
  end if;
  v_id := r.id; v_pct := r.ugens_butik_rabat_procent; v_ant := r.ugens_butik_rabat_antal;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_pakke_gemt', 'erhverv_pakke', v_id, null,
          left(format('%s: %s auktioner/md., %s fremhævninger/md., statistik %s, %s kr./md. ekskl. moms, %s, Ugens butik-rabat %s',
                      v_navn, coalesce(r.auktioner_pr_maaned::text, 'ubegrænset'), r.fremhaevninger_pr_maaned,
                      r.statistik, coalesce(p_maanedspris::text, 'pris ikke sat'),
                      case when r.aktiv then 'aktiv' else 'ikke aktiv' end,
                      case when v_pct > 0 and v_ant > 0 then format('%s %% de første %s uger pr. kalenderår', v_pct, v_ant)
                           else 'ingen' end), 1000));

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end $function$;

revoke all on function public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer, text, boolean, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer, text, boolean, boolean, integer, integer, integer) to service_role;

create or replace function public.erhverv_pakker_liste(p_staff uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id)
                     || jsonb_build_object('sortering', p.sortering,
                                           'antal_firmaer', (select count(*) from public.firmaer f
                                                              where f.pakke_id = p.id and f.abonnement_status <> 'opsagt'))
                     order by (p.arkiveret_kl is not null), p.sortering, public.erhverv_pakke_rang(p.id), p.navn)
                     from public.erhverv_pakker p), '[]'::jsonb);
end $function$;
revoke all on function public.erhverv_pakker_liste(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_pakker_liste(uuid) to service_role;

-- ===========================================================================
-- 7. Pakkeskift (firmaet selv) - månedspakkerne
-- ===========================================================================
create or replace function public.firma_skift_pakke_server(p_bruger uuid, p_pakke uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  f       public.firmaer;
  nu      public.erhverv_pakker;
  ny      public.erhverv_pakker;
  u       record;
  v_fra   timestamptz;
  v_id    uuid;
  v_snap  jsonb;
  v_laas  uuid := gen_random_uuid();
begin
  if p_bruger is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl into u
    from public.users where id = p_bruger;
  if not found or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now())) then
    raise exception 'erhverv_konto_spaerret: Din konto er spærret, så du kan ikke skifte pakke. Skriv til erhverv@bidhamr.dk.'
      using errcode = 'BHE06';
  end if;
  select * into f from public.firmaer where bruger_id = p_bruger for update;
  if f.id is null then
    raise exception 'erhverv_intet_abonnement: Kun firmakonti har et abonnement.' using errcode = 'BHE02';
  end if;
  if f.pakkeskift_i_gang_kl is not null and f.pakkeskift_i_gang_kl > now() - interval '5 minutes' then
    raise exception 'erhverv_skift_i_gang: Vi er ved at skifte din pakke. Vent et øjeblik, og opdater siden.'
      using errcode = 'BHE07';
  end if;
  if not public.rate_limit_tjek('firma_skift_pakke:' || p_bruger::text, 10, 3600) then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'BHR01';
  end if;
  if f.abonnement_status <> 'aktiv' then
    raise exception 'erhverv_intet_abonnement: Abonnementet er ikke aktivt. Kontakt BidHamr på erhverv@bidhamr.dk.'
      using errcode = 'BHE02';
  end if;

  perform public.firma_anvend_planlagt(f.id);
  select * into f from public.firmaer where id = f.id;

  v_snap := jsonb_build_object(
    'naeste_pakke_id', f.naeste_pakke_id,
    'naeste_pakke_fra', f.naeste_pakke_fra,
    'planlagt', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'planlagt'),
    'afventer', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'afventer_betaling'));

  select * into ny from public.erhverv_pakker where id = p_pakke and aktiv and arkiveret_kl is null;
  if ny.id is null then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  select * into nu from public.erhverv_pakker where id = f.pakke_id;

  if ny.id = nu.id then
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    return jsonb_build_object('kode', 'uaendret', 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  -- Større pakke (flere auktioner, så fremhævninger, så pris) = opgradering.
  -- En arkiveret nuværende pakke (bør ikke ske efter flytningen) regnes som
  -- mindst, så firmaet altid kan komme op på en ny pakke.
  if nu.arkiveret_kl is not null or public.erhverv_pakke_rang(ny.id) > public.erhverv_pakke_rang(nu.id) then
    update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
     where firma_id = f.id and status = 'afventer_betaling';
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status = 'planlagt';
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af)
    values (f.id, nu.id, ny.id, 'opgradering', 'afventer_betaling', p_bruger)
    returning id into v_id;
    return jsonb_build_object('kode', 'opgradering_afventer_betaling', 'skift_id', v_id,
                              'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  if f.opsiges_fra is not null then
    raise exception 'erhverv_opsagt: Dit abonnement er opsagt og stopper %. Du kan ikke skifte til en mindre pakke. Skriv til erhverv@bidhamr.dk, hvis du vil fortsætte.',
      to_char(f.opsiges_fra at time zone 'Europe/Copenhagen', 'DD.MM.YYYY')
      using errcode = 'BHE08';
  end if;

  v_fra := coalesce(f.periode_slut, f.betalt_til, public.firma_naeste_periode(f.abonnement_start));
  update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
   where firma_id = f.id and status = 'planlagt';
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = f.id and status = 'afventer_betaling';
  update public.firmaer set naeste_pakke_id = ny.id, naeste_pakke_fra = v_fra, opdateret_kl = now(),
         pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
   where id = f.id;
  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, gaelder_fra, anmodet_af)
  values (f.id, nu.id, ny.id, 'nedgradering', 'planlagt', v_fra, p_bruger)
  returning id into v_id;
  return jsonb_build_object('kode', 'nedgradering_planlagt', 'skift_id', v_id, 'gaelder_fra', v_fra,
                            'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
end $function$;
revoke all on function public.firma_skift_pakke_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.firma_skift_pakke_server(uuid, uuid) to service_role;

-- Pakkeskift i den gratis periode: Stripe har skiftet prisen uden betaling
-- (proration 'none' - perioden er gratis), så skiftet gennemføres med det
-- samme - både opgradering og nedgradering. Ingen regning (intet er betalt).
-- Kun service role. Idempotent.
create or replace function public.firma_pakkeskift_uden_betaling(p_skift uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.firma_pakkeskift;
begin
  select * into s from public.firma_pakkeskift where id = p_skift for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status = 'gennemfoert' then
    return jsonb_build_object('kode', 'allerede_registreret', 'firma_id', s.firma_id);
  end if;
  if s.status not in ('afventer_betaling', 'planlagt') then
    return jsonb_build_object('kode', 'ikke_afventende', 'status', s.status);
  end if;
  perform 1 from public.firmaer where id = s.firma_id for update;
  update public.firma_pakkeskift
     set status = 'gennemfoert', behandlet_kl = now(), gaelder_fra = now(),
         note = left(coalesce(nullif(btrim(p_note), ''), 'Skiftet i den gratis periode'), 1000)
   where id = s.id;
  update public.firmaer
     set pakke_id = s.til_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null,
         saerpris_oere = case when saerpris_pakke_id = s.til_pakke_id then saerpris_oere end,
         saerpris_aftale = case when saerpris_pakke_id = s.til_pakke_id then saerpris_aftale end,
         saerpris_pakke_id = case when saerpris_pakke_id = s.til_pakke_id then saerpris_pakke_id end,
         opdateret_kl = now()
   where id = s.firma_id;
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = s.firma_id and id <> s.id and status in ('afventer_betaling', 'planlagt');
  return jsonb_build_object('kode', 'ok', 'firma_id', s.firma_id);
end $$;
revoke all on function public.firma_pakkeskift_uden_betaling(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_uden_betaling(uuid, text) to service_role;

-- ===========================================================================
-- 8. Stripe-spejl: abonnement (med prøveperiode), introrabat og kort
-- ===========================================================================
drop function if exists public.firma_stripe_abonnement_spejl(uuid, text, text, timestamptz, timestamptz, boolean, text);

create or replace function public.firma_stripe_abonnement_spejl(
  p_firma uuid, p_subscription_id text, p_stripe_status text, p_opsiges_fra timestamptz,
  p_periode_slut timestamptz, p_slettet boolean default false, p_aarsag text default null,
  p_proeve_slut timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
             stripe_abonnement_status = 'canceled', opsiges_fra = null, proeve_slut = null,
             naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
       where id = f.id;
      update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now(),
             note = coalesce(note, 'Abonnementet er opsagt')
       where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
      return jsonb_build_object('kode', 'opsagt');
    end if;
    update public.firmaer
       set stripe_subscription_id = null, stripe_abonnement_status = 'canceled', periode_slut = null,
           proeve_slut = null,
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
         -- Uden p_proeve_slut (fx en server med den gamle kode under en
         -- udrulning) bevares den kendte dato.
         proeve_slut = case when p_stripe_status = 'trialing' then coalesce(p_proeve_slut, proeve_slut) else null end,
         proeve_givet_kl = case when p_proeve_slut is not null then coalesce(proeve_givet_kl, now())
                                else proeve_givet_kl end,
         opdateret_kl = now()
   where id = f.id;
  return jsonb_build_object('kode', 'ok');
end $function$;
revoke all on function public.firma_stripe_abonnement_spejl(uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.firma_stripe_abonnement_spejl(uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz) to service_role;

-- Introrabatten er sat på abonnementet i Stripe (eller fjernet / brugt op).
-- p_noegle: den aftale (intro_noegle), Stripe-kaldet hørte til - er aftalen
-- ændret imens, røres intet ('aendret'). p_status: 'aktiv' | 'faerdig'.
create or replace function public.firma_intro_spejl(p_firma uuid, p_noegle uuid, p_status text,
                                                    p_coupon text, p_til timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if f.intro_noegle is distinct from p_noegle then
    return jsonb_build_object('kode', 'aendret');
  end if;
  if p_status = 'faerdig' then
    update public.firmaer
       set intro_procent = null, intro_maaneder = null, intro_fra = null, intro_status = null,
           intro_coupon_id = null, intro_til = null, opdateret_kl = now()
     where id = f.id;
  elsif p_status = 'aktiv' then
    update public.firmaer
       set intro_status = 'aktiv', intro_coupon_id = left(p_coupon, 255), intro_til = p_til, opdateret_kl = now()
     where id = f.id;
  else
    raise exception 'Ugyldig status %', p_status;
  end if;
  return jsonb_build_object('kode', 'ok');
end $$;
revoke all on function public.firma_intro_spejl(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.firma_intro_spejl(uuid, uuid, text, text, timestamptz) to service_role;

-- Firmaets betalingskort (kun mærke, sidste 4 cifre og udløb - fra Stripe).
create or replace function public.firma_kort_spejl(p_firma uuid, p_maerke text, p_sidste4 text,
                                                   p_udloeb_maaned integer, p_udloeb_aar integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.firmaer
     set kort_maerke = left(nullif(btrim(p_maerke), ''), 40),
         kort_sidste4 = case when p_sidste4 ~ '^[0-9]{4}$' then p_sidste4 end,
         kort_udloeb_maaned = case when p_udloeb_maaned between 1 and 12 then p_udloeb_maaned end,
         kort_udloeb_aar = case when p_udloeb_aar between 2000 and 2200 then p_udloeb_aar end,
         kort_opdateret_kl = now()
   where id = p_firma;
  return jsonb_build_object('kode', case when found then 'ok' else 'ikke_fundet' end);
end $$;
revoke all on function public.firma_kort_spejl(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.firma_kort_spejl(uuid, text, text, integer, integer) to service_role;

-- Prissynk efter flytningen (betalings-cron'en): kandidater og kvittering.
create or replace function public.firma_pris_synk_kandidater(p_graense integer default 20)
returns table (firma_id uuid, subscription_id text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.stripe_subscription_id from public.firmaer f
   where f.stripe_pris_synk and f.stripe_subscription_id is not null
   order by f.opdateret_kl limit greatest(least(coalesce(p_graense, 20), 100), 1);
$$;
create or replace function public.firma_pris_synk_udfoert(p_firma uuid)
returns void language sql security definer set search_path = '' as $$
  update public.firmaer set stripe_pris_synk = false where id = p_firma;
$$;
revoke all on function public.firma_pris_synk_kandidater(integer), public.firma_pris_synk_udfoert(uuid) from public, anon, authenticated;
grant execute on function public.firma_pris_synk_kandidater(integer), public.firma_pris_synk_udfoert(uuid) to service_role;

-- ===========================================================================
-- 9. Staff-handlinger på et firma (chef og sælger-rollen; kun service role)
-- ===========================================================================
-- Fælles: staff skal have adgang, begrundelsen skal være 3-500 tegn.
create or replace function public.erhverv_begrundelse_ok(p_tekst text)
returns boolean language sql immutable set search_path = '' as $$
  select char_length(btrim(coalesce(p_tekst, ''))) between 3 and 500;
$$;
revoke all on function public.erhverv_begrundelse_ok(text) from public, anon, authenticated;

create or replace function public.erhverv_firma_log(p_staff uuid, p_firma uuid, p_handling text, p_tekst text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, p_handling, 'firma', p_firma, f.bruger_id,
          left(concat_ws('; ', nullif(btrim(p_tekst), ''), f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));
end $$;
revoke all on function public.erhverv_firma_log(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_log(uuid, uuid, text, text) to service_role;

-- Ekstra auktioner/fremhævninger i INDEVÆRENDE måned (lægges til; et negativt
-- tal trækker fra, men aldrig under 0). Svar: {kode, auktioner, fremhaevninger}
-- (månedens samlede ekstra efter ændringen).
create or replace function public.erhverv_firma_ekstra_giv(p_staff uuid, p_firma uuid, p_auktioner integer,
                                                           p_fremhaevninger integer, p_begrundelse text)
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
revoke all on function public.erhverv_firma_ekstra_giv(uuid, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_ekstra_giv(uuid, uuid, integer, integer, text) to service_role;

-- Gratis periode (+N måneder). Stripe først (src/lib/erhverv/firmaPris.ts):
--   p_stripe = true: abonnementets trial_end er forlænget i Stripe til
--     p_proeve_slut - her spejles og logges det.
--   p_stripe = false: firmaet har intet abonnement endnu - proeve_maaneder
--     øges, så Checkout starter med en længere gratis periode.
create or replace function public.erhverv_firma_gratis_gem(p_staff uuid, p_firma uuid, p_maaneder integer,
                                                           p_begrundelse text, p_stripe boolean,
                                                           p_proeve_slut timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
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
    update public.firmaer
       set proeve_slut = p_proeve_slut, stripe_abonnement_status = 'trialing',
           proeve_givet_kl = coalesce(proeve_givet_kl, now()), opdateret_kl = now()
     where id = f.id;
  else
    if f.proeve_maaneder + p_maaneder > 24 then
      return jsonb_build_object('kode', 'for_lang');
    end if;
    update public.firmaer set proeve_maaneder = proeve_maaneder + p_maaneder, opdateret_kl = now()
     where id = f.id;
  end if;
  perform public.erhverv_firma_log(p_staff, f.id, 'firma_gratis_periode',
    format('+%s gratis måned%s%s: %s', p_maaneder, case when p_maaneder = 1 then '' else 'er' end,
           case when p_stripe then ' (gratis til ' || to_char(p_proeve_slut at time zone 'Europe/Copenhagen', 'DD.MM.YYYY') || ')'
                else format(' (%s gratis måneder, når abonnementet starter)', f.proeve_maaneder + p_maaneder) end,
           btrim(p_begrundelse)));
  return jsonb_build_object('kode', 'ok',
                            'proeve_maaneder', case when p_stripe then f.proeve_maaneder else f.proeve_maaneder + p_maaneder end);
end $$;
revoke all on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.erhverv_firma_gratis_gem(uuid, uuid, integer, text, boolean, timestamptz) to service_role;

-- Introrabat: sæt (p_procent/p_maaneder) eller fjern (p_procent null).
-- Gemmes som 'planlagt' med en ny intro_noegle; Stripe-delen sætter kuponen
-- på abonnementet bagefter (firma_intro_spejl). Fjernes den, har Stripe-delen
-- allerede fjernet kuponen (p_stripe_fjernet).
create or replace function public.erhverv_firma_intro_gem(p_staff uuid, p_firma uuid, p_procent integer,
                                                          p_maaneder integer, p_fra text, p_begrundelse text)
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
revoke all on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text) to service_role;

-- Særpris (fast pris ekskl. moms) for firmaets NUVÆRENDE pakke, eller fjern
-- (p_oere null). Stripe først (firmaets egen pris er sat på abonnementet).
create or replace function public.erhverv_firma_saerpris_gem(p_staff uuid, p_firma uuid, p_oere bigint,
                                                             p_pakke uuid, p_aftale text, p_fra text)
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
revoke all on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text) to service_role;

-- Staff stopper en fremhævning (fx forkert auktion). p_tilbage: giv den
-- tilbage til månedens kvote.
create or replace function public.erhverv_fremhaevning_stop(p_staff uuid, p_id uuid, p_tilbage boolean, p_begrundelse text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  h public.firma_fremhaevninger;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_begrundelse) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  select * into h from public.firma_fremhaevninger where id = p_id for update;
  if h.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if h.stoppet_kl is not null then
    return jsonb_build_object('kode', 'allerede');
  end if;
  update public.firma_fremhaevninger
     set stoppet_kl = now(), stoppet_af = p_staff, stoppet_aarsag = left(btrim(p_begrundelse), 500),
         tilbagegivet = coalesce(p_tilbage, false)
   where id = h.id;
  perform public.erhverv_firma_log(p_staff, h.firma_id, 'firma_fremhaevning_stoppet',
    format('Fremhævning stoppet%s: %s', case when p_tilbage then ' og givet tilbage' else '' end, btrim(p_begrundelse)));
  return jsonb_build_object('kode', 'ok');
end $$;
revoke all on function public.erhverv_fremhaevning_stop(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.erhverv_fremhaevning_stop(uuid, uuid, boolean, text) to service_role;

-- ===========================================================================
-- 10. Oprettelse og ændring af firmaer
-- ===========================================================================
drop function if exists public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid);

create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text,
  p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid default null,
  p_intro_procent integer default null, p_intro_maaneder integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
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
                       else '' end, 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id);
end $function$;
revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer) to service_role;

-- Staff ændrer et firma (uændret signatur). Nyt: en arkiveret pakke kan ikke
-- vælges, og skiftes pakken, bortfalder en særpris for den gamle pakke.
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
  if coalesce(v_navn, v_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, case when v_pakke is not null then 'firma_pakke_skiftet' else 'firma_opdateret' end,
          'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $function$;
revoke all on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- Firmaets abonnement til admin og Firma oversigt (fælles felter).
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
    'gratis_maaneder_ved_start', case when f.stripe_subscription_id is null and f.proeve_givet_kl is null
                                      then f.proeve_maaneder else 0 end,
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
revoke all on function public.erhverv_firma_abonnement_json(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_abonnement_json(uuid) to service_role;

create or replace function public.erhverv_firmaer_liste(p_staff uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(f)
        || jsonb_build_object(
             'login_email', u.email,
             'har_logget_ind', au.last_sign_in_at is not null,
             'pakke', public.erhverv_pakke_json(f.pakke_id),
             'naeste_pakke', public.erhverv_pakke_json(f.naeste_pakke_id),
             'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                               || jsonb_build_object('skift_id', s.id)
                                          from public.firma_pakkeskift s
                                         where s.firma_id = f.id and s.status = 'afventer_betaling'),
             'aktive_auktioner', (select count(*) from public.auctions a
                                   where a.bruger_id = f.bruger_id and a.status = 'aktiv'),
             'oprettet_af_navn', s.navn)
        || public.erhverv_firma_abonnement_json(f.id)
        order by f.oprettet_kl desc)
      from public.firmaer f
      join public.users u on u.id = f.bruger_id
      left join auth.users au on au.id = f.bruger_id
      left join public.users s on s.id = f.oprettet_af), '[]'::jsonb);
end $function$;
revoke all on function public.erhverv_firmaer_liste(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firmaer_liste(uuid) to service_role;

-- ===========================================================================
-- 11. Firma oversigt og statistik
-- ===========================================================================
create or replace function public.firma_oversigt()
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  v_uid     uuid := auth.uid();
  f         public.firmaer;
  v_maaned  timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
  v_pakke   uuid;
  v_kvote   jsonb;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into f from public.firmaer where bruger_id = v_uid;
  if f.id is null then
    return null;
  end if;
  v_pakke := case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                  then f.naeste_pakke_id else f.pakke_id end;
  v_kvote := public.firma_kvote();

  return jsonb_build_object(
    'firma', jsonb_build_object(
      'id', f.id, 'firmanavn', f.firmanavn, 'cvr', f.cvr, 'adresse', f.adresse,
      'postnummer', f.postnummer, 'by', f.bynavn, 'telefon', f.telefon,
      'kontakt_email', f.kontakt_email, 'kontaktperson', f.kontaktperson,
      'abonnement_status', f.abonnement_status, 'abonnement_start', f.abonnement_start,
      'betalt_til', f.betalt_til, 'betaling_mislykket_kl', f.betaling_mislykket_kl,
      'pauset_aarsag', f.pauset_aarsag,
      'naeste_periode', coalesce(f.periode_slut, public.firma_naeste_periode(f.abonnement_start)),
      'periode_slut', f.periode_slut, 'opsiges_fra', f.opsiges_fra,
      'har_stripe_abonnement', f.stripe_subscription_id is not null,
      'stripe_abonnement_status', f.stripe_abonnement_status),
    'abonnement', public.erhverv_firma_abonnement_json(f.id) - 'saerpris_aftale',
    'pakke', public.erhverv_pakke_json(v_pakke),
    'naeste_pakke', case when v_pakke = f.pakke_id and f.naeste_pakke_id is not null
                         then public.erhverv_pakke_json(f.naeste_pakke_id)
                              || jsonb_build_object('fra', f.naeste_pakke_fra) end,
    'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                      || jsonb_build_object('skift_id', s.id, 'anmodet_kl', s.oprettet_kl,
                                         'faktura_url', (select r2.hosted_url from public.firma_regninger r2
                                                          where s.stripe_invoice_id is not null
                                                            and r2.stripe_invoice_id = s.stripe_invoice_id
                                                            and r2.status in ('afventer', 'mislykket')))
                                 from public.firma_pakkeskift s
                                where s.firma_id = f.id and s.status = 'afventer_betaling'),
    'pakker', coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id) order by p.sortering, public.erhverv_pakke_rang(p.id), p.navn)
                          from public.erhverv_pakker p where p.aktiv and p.arkiveret_kl is null), '[]'::jsonb),
    'kvote', v_kvote,
    -- Bagudkompatibelt navn (samme indhold som 'kvote' - pr. kalendermåned).
    'ugekvote', v_kvote,
    'auktioner', (select jsonb_build_object(
        'aktive', count(*) filter (where a.status = 'aktiv'),
        'i_alt', count(*),
        'visninger', (select count(*) from public.auction_views v
                       join public.auctions a2 on a2.id = v.auktion_id
                      where a2.bruger_id = v_uid),
        'visninger_aktive', (select count(*) from public.auction_views v
                              join public.auctions a2 on a2.id = v.auktion_id
                             where a2.bruger_id = v_uid and a2.status = 'aktiv'),
        'bud', coalesce(sum(a.antal_bud), 0))
      from public.auctions a where a.bruger_id = v_uid),
    'salg', (select jsonb_build_object(
        'solgte_i_alt', count(*),
        'solgte_denne_maaned', count(*) filter (where t.created_at >= v_maaned),
        'omsaetning_i_alt', coalesce(sum(t.amount), 0),
        'omsaetning_denne_maaned', coalesce(sum(t.amount) filter (where t.created_at >= v_maaned), 0),
        'afsluttede_i_alt', count(*) filter (where t.status = 'afsluttet'),
        'omsaetning_afsluttede_i_alt', coalesce(sum(t.amount) filter (where t.status = 'afsluttet'), 0))
      from public.trades t where t.seller_id = v_uid and t.status <> 'annulleret'),
    'udbetalinger', (select jsonb_build_object(
        'udbetalt_i_alt_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is not null), 0),
        'udbetalt_denne_maaned_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl >= v_maaned), 0),
        'paa_vej_oere', coalesce(sum(b.udbetaling_oere) filter (
            where b.status = 'betalt' and b.overfoert_kl is null and b.refunderet_kl is null
              and b.annulleret_kl is null and b.refusion_anmodet_kl is null
              and b.afsendelsesfrist_annulleret_kl is null and b.afhentningsfrist_annulleret_kl is null
              and b.indsigelse_tabt_kl is null
              and not exists (select 1 from public.trades t2
                               where t2.id = b.trade_id and t2.status = 'annulleret')), 0))
      from public.betalinger b where b.seller_id = v_uid),
    'venter_paa_dig', coalesce((select jsonb_agg(jsonb_build_object(
        'trade_id', t.id, 'auktion_id', t.auction_id, 'titel', a.titel, 'beloeb', t.amount,
        'afhentning', t.afhentning, 'status', t.status, 'oprettet', t.created_at) order by t.created_at)
      from public.trades t left join public.auctions a on a.id = t.auction_id
     where t.seller_id = v_uid and t.status = 'betaling_modtaget'), '[]'::jsonb),
    'ubesvarede_spoergsmaal', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'auktion_id', q.auction_id, 'titel', a.titel, 'spoergsmaal', q.question,
        'stillet_kl', q.asked_at) order by q.asked_at)
      from public.auction_questions q join public.auctions a on a.id = q.auction_id
     where a.bruger_id = v_uid and a.status = 'aktiv' and q.answer is null
       and not coalesce(q.hidden, false)), '[]'::jsonb),
    'regninger', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'nummer', r.nummer, 'type', r.type, 'periode_fra', r.periode_fra,
        'periode_til', r.periode_til, 'beloeb_oere', r.beloeb_oere, 'status', r.status,
        'pdf_url', r.pdf_url, 'hosted_url', r.hosted_url,
        'beloeb_ekskl_moms_oere', r.beloeb_ekskl_moms_oere, 'moms_oere', r.moms_oere, 'betalt_kl', r.betalt_kl, 'oprettet', r.oprettet_kl) order by r.oprettet_kl desc)
      from public.firma_regninger r where r.firma_id = f.id), '[]'::jsonb),
    'kontakt_bidhamr', 'erhverv@bidhamr.dk'
  );
end $function$;
revoke all on function public.firma_oversigt() from public, anon, authenticated;
grant execute on function public.firma_oversigt() to authenticated, service_role;

-- Statistik efter pakkens niveau: 'ingen' -> tomme lister, 'statistik' ->
-- månedstal (12 måneder), 'fuld' -> månedstal + hver auktion (seneste 100).
create or replace function public.firma_statistik()
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen') - interval '11 months')
                         at time zone 'Europe/Copenhagen';
  v_niveau text;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select coalesce(p.statistik, 'ingen') into v_niveau
    from public.firmaer f left join public.erhverv_pakker p on p.id = f.pakke_id
   where f.bruger_id = v_uid;
  if not found then
    return null;
  end if;
  if v_niveau = 'ingen' then
    return jsonb_build_object('niveau', v_niveau, 'maaneder', '[]'::jsonb, 'auktioner', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'niveau', v_niveau,
    'maaneder', (
      select jsonb_agg(jsonb_build_object(
               'maaned', to_char(m.maaned, 'YYYY-MM'),
               'visninger', (select count(*) from public.auction_views v
                               join public.auctions a on a.id = v.auktion_id
                              where a.bruger_id = v_uid
                                and v.foerste_visning >= m.fra and v.foerste_visning < m.til),
               'bud', (select count(*) from public.bids b
                         join public.auctions a on a.id = b.auktion_id
                        where a.bruger_id = v_uid
                          and b.oprettet >= m.fra and b.oprettet < m.til),
               'solgte', (select count(*) from public.trades t
                           where t.seller_id = v_uid and t.status <> 'annulleret'
                             and t.created_at >= m.fra and t.created_at < m.til),
               'omsaetning', (select coalesce(sum(t.amount), 0) from public.trades t
                               where t.seller_id = v_uid and t.status <> 'annulleret'
                                 and t.created_at >= m.fra and t.created_at < m.til))
             order by m.maaned)
        from (select s.maaned,
                     s.maaned at time zone 'Europe/Copenhagen' as fra,
                     (s.maaned + interval '1 month') at time zone 'Europe/Copenhagen' as til
                from generate_series(v_start at time zone 'Europe/Copenhagen',
                                     date_trunc('month', now() at time zone 'Europe/Copenhagen'),
                                     interval '1 month') as s(maaned)) m),
    'auktioner', case when v_niveau <> 'fuld' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'titel', a.titel, 'status', a.status, 'oprettet', a.oprettet,
               'slutter_kl', a.slutter_kl, 'bud', coalesce(a.antal_bud, 0),
               'visninger', (select count(*) from public.auction_views v where v.auktion_id = a.id),
               'solgt_for', (select t.amount from public.trades t
                              where t.auction_id = a.id and t.status <> 'annulleret'
                              order by t.created_at desc limit 1))
             order by a.oprettet desc)
        from (select * from public.auctions a0 where a0.bruger_id = v_uid
               order by a0.oprettet desc limit 100) a), '[]'::jsonb) end
  );
end;
$function$;
revoke all on function public.firma_statistik() from public, anon, authenticated;
grant execute on function public.firma_statistik() to authenticated, service_role;
