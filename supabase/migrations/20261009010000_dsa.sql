-- Digital Services Act (DSA, forordning (EU) 2022/2065) – de tekniske dele.
-- Beslutningerne står i ROADMAP-BESLUTNINGER.md, afsnit "DSA" (foreslået af
-- Claude – afventer advokat).
--
--   1. public.dsa_anmeldelser   Anmeld ulovligt indhold (art. 16). Kan bruges
--      uden login. Oprettes KUN via serveren (service_role) efter rate limit
--      pr. IP, e-mail og bruger + honeypot/tidsfælde (src/app/actions/dsa.ts
--      og POST /api/dsa/anmeld til appen). Anmelderens navn og e-mail er
--      persondata: kun staff (service_role) kan læse dem - aldrig den anmeldte.
--      Anonymiseres 12 måneder efter afgørelsen (dsa_oprydning_koer, eget
--      cron-job 'dsa_oprydning').
--   2. public.dsa_afgoerelser   Begrundelse ved indgreb (art. 17). ÉN fælles
--      funktion dsa_indgreb() udfører indgrebet OG gemmer begrundelsen i samme
--      transaktion: skjul/fjern/annullér auktion, skjul spørgsmål/svar, skjul
--      bedømmelse/svar, suspendér og luk konto. Kontolukning efter 3 advarsler
--      går via dsa_konto_lukning_godkend() (wrapper om konto_lukning_godkend).
--      Brugeren får begrundelsen som notifikation (type 'afgoerelse', mail
--      sendes altid) med link til klage.
--   3. public.dsa_klager        Klage over en afgørelse (art. 20) inden for 6
--      måneder. Ét klagetrin pr. afgørelse (unique). Behandles af en ANDEN
--      medarbejder end den, der traf afgørelsen (dsa_er_inhabil). Medhold
--      tilbagefører indgrebet i samme transaktion. Anmelderen kan også klage
--      over en afgørelse om "ingen overtrædelse".
--   4. dsa_rapport(fra, til)     Tal til gennemsigtighedsrapporten (art. 15/24).
--   5. Triggere markerer en afgørelse som ophævet, når staff selv viser
--      indholdet igen / ophæver suspensionen (også fra appen eller SQL).
--
-- Alle tabeller: RLS slået til uden policies (ingen direkte adgang for anon og
-- authenticated). Brugeren læser sine egne ting via mine_dsa_afgoerelser() og
-- mine_dsa_anmeldelser() (udleder brugeren af auth.uid()) og klager via
-- dsa_klag(). Alt andet er kun service_role med rolletjek i funktionen.
-- Intet slettes (trigger) - anmelderens data anonymiseres.
--
-- FLETNINGER (nuværende værdier læses fra databasen og bevares altid):
--   moderation_log_handling_check  + auktion_skjult, auktion_vist,
--                                    dsa_anmeldelse_afgjort,
--                                    dsa_anmeldelse_videresendt,
--                                    dsa_klage_medhold, dsa_klage_fastholdt,
--                                    konto_genaabnet
--   moderation_log_maal_type_check + dsa
--   notifikation_paakraevet()      + 'afgoerelse' (påkrævet)
--   notifikation_kendt_type()      genskrives med sine nuværende værdier (den
--                                  kalder notifikation_paakraevet, så den nye
--                                  type er kendt automatisk)
-- Nyt cron-job 'dsa_oprydning' kører dsa_oprydning_koer() (eget job, så det
-- kører, selvom 'oprydning' fejler).
--
-- Idempotent. Kræver 20261007020000_bedoemmelse_svar.sql (skjul_bedoemmelse)
-- og 20261006040000_auktionsfunktioner.sql (skjul_spoergsmaal).

-- ============================================================ 0. Sekvenser

create sequence if not exists public.dsa_anmeldelse_nr;
create sequence if not exists public.dsa_afgoerelse_nr;
create sequence if not exists public.dsa_klage_nr;
revoke all on sequence public.dsa_anmeldelse_nr, public.dsa_afgoerelse_nr, public.dsa_klage_nr
  from public, anon, authenticated;

-- ============================================================ 1. Regler

-- Den regel/lov, et indgreb bygger på. Navn og henvisning gemmes som
-- øjebliksbillede i hver afgørelse (regel_tekst), så historikken ikke ændres,
-- hvis listen rettes. Spejles i src/lib/dsa/regler.ts.
-- Henvisningerne er foreløbige (afventer advokat).
create or replace function public.dsa_regler()
returns table (kode text, navn text, grundlag text, henvisning text)
language sql
immutable
set search_path = ''
as $fn$
  select * from (values
    ('forbudt_vare',            'Varen må ikke sælges på BidHamr',                    'vilkaar', 'BidHamrs regler om forbudte varer (bidhamr.dk/forbudte-varer)'),
    ('ulovlig_vare',            'Varen er ulovlig at sælge',                          'lov',     'Dansk lovgivning, fx våbenloven, lov om euforiserende stoffer og dyrevelfærdsloven'),
    ('falsk_vare',              'Kopivare eller krænkelse af et varemærke',           'lov',     'Varemærkeloven'),
    ('ophavsret',               'Krænkelse af ophavsret (fx kopierede billeder)',     'lov',     'Ophavsretsloven'),
    ('svindel',                 'Svindel eller vildledning',                          'lov',     'Straffeloven § 279 og BidHamrs regler'),
    ('personoplysninger',       'Deling af andres personoplysninger',                 'lov',     'Databeskyttelsesforordningen (GDPR)'),
    ('hadefuld_tale',           'Hadefuld eller truende tale',                        'lov',     'Straffeloven §§ 266 og 266 b'),
    ('misbrug_boern',           'Seksuelt misbrug af børn',                           'lov',     'Straffeloven § 235'),
    ('chikane',                 'Grove ord eller chikane',                            'vilkaar', 'BidHamrs regler for god opførsel'),
    ('kontaktinfo',             'Kontaktoplysninger eller handel uden om BidHamr',    'vilkaar', 'BidHamrs regler for handel på BidHamr'),
    ('ikke_relateret',          'Indholdet handler ikke om handlen',                  'vilkaar', 'BidHamrs regler for bedømmelser og spørgsmål'),
    ('spam',                    'Spam eller reklame',                                 'vilkaar', 'BidHamrs regler for god opførsel'),
    ('gentagne_overtraedelser', 'Gentagne overtrædelser (3 advarsler)',               'vilkaar', 'BidHamrs regler om advarsler'),
    ('andet',                   'Andet brud på BidHamrs regler',                      'vilkaar', 'BidHamrs regler')
  ) as r(kode, navn, grundlag, henvisning);
$fn$;

revoke all on function public.dsa_regler() from public, anon, authenticated;
grant execute on function public.dsa_regler() to service_role;

-- ============================================================ 2. Tabeller

create table if not exists public.dsa_afgoerelser (
  id                 uuid primary key default gen_random_uuid(),
  sagsnummer         text not null unique
                       default ('AFG-' || to_char(now() at time zone 'Europe/Copenhagen', 'YYYY') || '-'
                                || lpad(nextval('public.dsa_afgoerelse_nr')::text, 5, '0')),
  bruger_id          uuid not null references public.users(id) on delete restrict,
  indhold_type       text not null check (indhold_type in
                       ('auktion', 'profil', 'spoergsmaal', 'spoergsmaal_svar', 'bedoemmelse', 'bedoemmelse_svar')),
  indhold_id         uuid not null,
  auktion_id         uuid,
  -- Kort beskrivelse af indholdet (fx auktionens titel), så begrundelsen kan
  -- læses, selvom indholdet er skjult. Vises for brugeren.
  indhold_tekst      text check (indhold_tekst is null or char_length(indhold_tekst) <= 300),
  handling           text not null check (handling in
                       ('auktion_skjult', 'auktion_fjernet', 'auktion_annulleret', 'spoergsmaal_skjult',
                        'bedoemmelse_skjult', 'bedoemmelse_svar_skjult', 'konto_suspenderet', 'konto_lukket')),
  regel_kode         text not null,
  regel_tekst        text not null check (char_length(regel_tekst) <= 500),
  grundlag           text not null check (grundlag in ('lov', 'vilkaar')),
  -- Fakta og omstændigheder - vises for brugeren.
  fakta              text not null check (char_length(btrim(fakta)) between 1 and 2000),
  intern_note        text check (intern_note is null or char_length(intern_note) <= 2000),
  automatisk_opdaget boolean not null default false,
  automatisk_afgjort boolean not null default false,
  anmeldelse_id      uuid,
  varighed_til       timestamptz,
  foer_status        text,
  medarbejder_id     uuid references public.users(id) on delete restrict,
  oprettet_kl        timestamptz not null default now(),
  klage_frist_kl     timestamptz not null default (now() + interval '6 months'),
  ophaevet_kl        timestamptz,
  ophaevet_grund     text check (ophaevet_grund is null or ophaevet_grund in ('klage', 'staff')),
  notificeret_kl     timestamptz
);

create index if not exists dsa_afgoerelser_bruger_idx on public.dsa_afgoerelser (bruger_id, oprettet_kl desc);
create index if not exists dsa_afgoerelser_indhold_idx on public.dsa_afgoerelser (indhold_type, indhold_id);
create index if not exists dsa_afgoerelser_oprettet_idx on public.dsa_afgoerelser (oprettet_kl);

create table if not exists public.dsa_anmeldelser (
  id                  uuid primary key default gen_random_uuid(),
  sagsnummer          text not null unique
                        default ('ANM-' || to_char(now() at time zone 'Europe/Copenhagen', 'YYYY') || '-'
                                 || lpad(nextval('public.dsa_anmeldelse_nr')::text, 5, '0')),
  indhold_type        text not null check (indhold_type in
                        ('auktion', 'profil', 'spoergsmaal', 'spoergsmaal_svar', 'bedoemmelse', 'bedoemmelse_svar', 'andet')),
  indhold_id          uuid,
  auktion_id          uuid,
  anmeldt_bruger_id   uuid references public.users(id) on delete restrict,
  placering           text not null check (char_length(placering) between 1 and 500),
  kategori            text not null check (kategori in
                        ('forbudt_vare', 'falske_varer', 'svindel', 'ophavsret', 'personoplysninger',
                         'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'andet')),
  begrundelse         text not null check (char_length(btrim(begrundelse)) between 10 and 2000),
  anmelder_id         uuid references public.users(id) on delete restrict,
  anmelder_navn       text check (anmelder_navn is null or char_length(anmelder_navn) between 1 and 100),
  anmelder_email      text check (anmelder_email is null or char_length(anmelder_email) between 3 and 254),
  god_tro             boolean not null check (god_tro),
  status              text not null default 'ny' check (status in ('ny', 'afgjort')),
  frist_kl            timestamptz not null,
  eskaleret_kl        timestamptz,
  eskaleret_af        uuid references public.users(id) on delete restrict,
  eskaleret_note      text check (eskaleret_note is null or char_length(eskaleret_note) <= 2000),
  udfald              text check (udfald is null or udfald in ('indgreb', 'ingen_overtraedelse', 'ikke_fundet')),
  afgoerelse_id       uuid references public.dsa_afgoerelser(id) on delete restrict,
  svar_til_anmelder   text check (svar_til_anmelder is null or char_length(svar_til_anmelder) <= 2000),
  intern_note         text check (intern_note is null or char_length(intern_note) <= 2000),
  politi_underrettet  boolean not null default false,
  behandlet_af        uuid references public.users(id) on delete restrict,
  behandlet_kl        timestamptz,
  genaabnet_kl        timestamptz,
  kvittering_sendt_kl timestamptz,
  svar_sendt_kl       timestamptz,
  anonymiseret_kl     timestamptz,
  oprettet_kl         timestamptz not null default now(),
  constraint dsa_anmeldelser_afgjort check (
    status = 'ny' or (udfald is not null and behandlet_kl is not null)),
  constraint dsa_anmeldelser_indgreb check (udfald is distinct from 'indgreb' or afgoerelse_id is not null),
  -- Art. 16(2)(c): navn og e-mail kræves, undtagen ved misbrug af børn.
  constraint dsa_anmeldelser_anmelder check (
    anonymiseret_kl is not null or kategori = 'misbrug_boern'
    or anmelder_id is not null or (anmelder_navn is not null and anmelder_email is not null)),
  constraint dsa_anmeldelser_indhold check (indhold_type = 'andet' or indhold_id is not null)
);

create index if not exists dsa_anmeldelser_aabne_idx on public.dsa_anmeldelser (frist_kl) where status = 'ny';
create index if not exists dsa_anmeldelser_indhold_idx on public.dsa_anmeldelser (indhold_type, indhold_id);
create index if not exists dsa_anmeldelser_anmelder_idx on public.dsa_anmeldelser (anmelder_id, oprettet_kl desc);
create index if not exists dsa_anmeldelser_oprettet_idx on public.dsa_anmeldelser (oprettet_kl);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dsa_afgoerelser_anmeldelse_fk') then
    alter table public.dsa_afgoerelser
      add constraint dsa_afgoerelser_anmeldelse_fk
      foreign key (anmeldelse_id) references public.dsa_anmeldelser(id) on delete restrict;
  end if;
end $$;

create table if not exists public.dsa_klager (
  id             uuid primary key default gen_random_uuid(),
  sagsnummer     text not null unique
                   default ('KLG-' || to_char(now() at time zone 'Europe/Copenhagen', 'YYYY') || '-'
                            || lpad(nextval('public.dsa_klage_nr')::text, 5, '0')),
  -- Ét klagetrin: højst én klage pr. afgørelse og pr. anmeldelse.
  afgoerelse_id  uuid unique references public.dsa_afgoerelser(id) on delete restrict,
  anmeldelse_id  uuid unique references public.dsa_anmeldelser(id) on delete restrict,
  klager_id      uuid references public.users(id) on delete restrict,
  klager_email   text check (klager_email is null or char_length(klager_email) <= 254),
  begrundelse    text not null check (char_length(btrim(begrundelse)) between 10 and 2000),
  status         text not null default 'afventer' check (status in ('afventer', 'afgjort')),
  udfald         text check (udfald is null or udfald in ('medhold', 'fastholdt')),
  svar           text check (svar is null or char_length(svar) <= 2000),
  intern_note    text check (intern_note is null or char_length(intern_note) <= 2000),
  afgjort_af     uuid references public.users(id) on delete restrict,
  afgjort_kl     timestamptz,
  frist_kl       timestamptz not null default (now() + interval '14 days'),
  svar_sendt_kl  timestamptz,
  anonymiseret_kl timestamptz,
  oprettet_kl    timestamptz not null default now(),
  constraint dsa_klager_et_maal check ((afgoerelse_id is null) <> (anmeldelse_id is null)),
  constraint dsa_klager_afgjort check (
    status = 'afventer' or (udfald is not null and svar is not null and afgjort_af is not null and afgjort_kl is not null))
);

create index if not exists dsa_klager_aabne_idx on public.dsa_klager (frist_kl) where status = 'afventer';
create index if not exists dsa_klager_oprettet_idx on public.dsa_klager (oprettet_kl);

-- RLS uden policies: ingen direkte adgang for anon/authenticated.
alter table public.dsa_anmeldelser enable row level security;
alter table public.dsa_afgoerelser enable row level security;
alter table public.dsa_klager enable row level security;

revoke all on table public.dsa_anmeldelser, public.dsa_afgoerelser, public.dsa_klager
  from public, anon, authenticated;
revoke all on table public.dsa_anmeldelser, public.dsa_afgoerelser, public.dsa_klager
  from service_role;
grant select, insert, update on table public.dsa_anmeldelser, public.dsa_afgoerelser, public.dsa_klager
  to service_role;

-- Intet slettes (dokumentation for afgørelser og til rapporten).
create or replace function public.dsa_slettes_aldrig()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'DSA-data slettes aldrig – anonymisér i stedet.' using errcode = '42501';
end;
$fn$;
revoke all on function public.dsa_slettes_aldrig() from public, anon, authenticated;

drop trigger if exists dsa_anmeldelser_slettes_aldrig on public.dsa_anmeldelser;
create trigger dsa_anmeldelser_slettes_aldrig before delete on public.dsa_anmeldelser
  for each row execute function public.dsa_slettes_aldrig();
drop trigger if exists dsa_afgoerelser_slettes_aldrig on public.dsa_afgoerelser;
create trigger dsa_afgoerelser_slettes_aldrig before delete on public.dsa_afgoerelser
  for each row execute function public.dsa_slettes_aldrig();
drop trigger if exists dsa_klager_slettes_aldrig on public.dsa_klager;
create trigger dsa_klager_slettes_aldrig before delete on public.dsa_klager
  for each row execute function public.dsa_slettes_aldrig();

-- ============================================================ 3. Fletninger

do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_handling_check'
     and c.conrelid = 'public.moderation_log'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array[
      'auktion_skjult', 'auktion_vist', 'dsa_anmeldelse_afgjort', 'dsa_anmeldelse_videresendt',
      'dsa_klage_medhold', 'dsa_klage_fastholdt', 'konto_genaabnet',
      -- bruges allerede af funktionerne nedenfor:
      'slet_auktion', 'annuller_auktion', 'suspender', 'ophaev_suspension'])
  ) s;

  alter table public.moderation_log drop constraint if exists moderation_log_handling_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))',
    v_vals);

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_maal_type_check'
     and c.conrelid = 'public.moderation_log'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array['auktion', 'anmeldelse', 'bruger', 'handel', 'samtale', 'sag', 'dsa'])
  ) s;

  alter table public.moderation_log drop constraint if exists moderation_log_maal_type_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_maal_type_check check (maal_type = any (%L::text[]))',
    v_vals);
end $$;

-- Notifikationstype 'afgoerelse' (påkrævet). Begge funktioner læses og
-- genskrives med deres nuværende værdier + den nye.
do $do$
declare
  v_src  text;
  v_vals text[];
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure('public.notifikation_paakraevet(text)');

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([a-z0-9_]+)''', 'g') as m
    union
    select unnest(array['vundet', 'betalingsfrist', 'betaling_modtaget', 'pakke_sendt',
                        'pakke_leveret', 'udbetaling', 'sag', 'advarsel', 'andenchance',
                        'afgoerelse'])
  ) s;

  execute format($f$
    create or replace function public.notifikation_paakraevet(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $b$
      select p_type = any (array[%s]);
    $b$
    $f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) as v));

  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure('public.notifikation_kendt_type(text)');

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([a-z0-9_]+)''', 'g') as m
    union
    select unnest(array['overbudt', 'bud_paa_egen', 'like', 'fulgt_slutter_snart',
                        'ny_auktion_fulgt_saelger', 'ny_besked', 'spoergsmaal'])
  ) s;

  execute format($f$
    create or replace function public.notifikation_kendt_type(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $b$
      select public.notifikation_paakraevet(p_type) or p_type = any (array[%s]);
    $b$
    $f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) as v));
end $do$;

grant execute on function public.notifikation_paakraevet(text) to anon, authenticated, service_role;
grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- ============================================================ 4. Hjælpere

-- Ejeren af et stykke indhold og den auktion, det hører til. Ingen række,
-- hvis indholdet ikke findes.
create or replace function public.dsa_indhold_ejer(p_type text, p_id uuid)
returns table (bruger_id uuid, auktion_id uuid, tekst text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.bruger_id, a.id, left(a.titel, 300)
    from public.auctions a where p_type = 'auktion' and a.id = p_id
  union all
  select u.id, null::uuid, left(coalesce(u.navn, 'Profil'), 300)
    from public.users u
   where p_type = 'profil' and u.id = p_id and u.id <> public.bidhamr_system_id()
  union all
  select q.asker_id, q.auction_id, left('Spørgsmål: ' || q.question, 300)
    from public.auction_questions q where p_type = 'spoergsmaal' and q.id = p_id
  union all
  select a.bruger_id, q.auction_id, left('Svar på spørgsmål: ' || q.answer, 300)
    from public.auction_questions q join public.auctions a on a.id = q.auction_id
   where p_type = 'spoergsmaal_svar' and q.id = p_id and q.answer is not null
  union all
  select r.fra_bruger_id, r.auktion_id, left('Bedømmelse: ' || coalesce(r.kommentar, '(kun stjerner)'), 300)
    from public.ratings r where p_type = 'bedoemmelse' and r.id = p_id
  union all
  select s.saelger_id, r.auktion_id, left('Svar på bedømmelse: ' || s.tekst, 300)
    from public.bedoemmelse_svar s join public.ratings r on r.id = s.rating_id
   where p_type = 'bedoemmelse_svar' and s.rating_id = p_id and s.slettet_kl is null;
$fn$;
revoke all on function public.dsa_indhold_ejer(text, uuid) from public, anon, authenticated;
grant execute on function public.dsa_indhold_ejer(text, uuid) to service_role;

-- Inhabil: man behandler ikke noget om sig selv eller om en, man har handlet
-- med (samme mønster som advarsler og sager).
create or replace function public.dsa_er_inhabil(p_medarbejder uuid, p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_medarbejder is not null and p_bruger is not null and (
    p_medarbejder = p_bruger
    or exists (select 1 from public.trades t
                where (t.buyer_id = p_medarbejder and t.seller_id = p_bruger)
                   or (t.seller_id = p_medarbejder and t.buyer_id = p_bruger)));
$fn$;
revoke all on function public.dsa_er_inhabil(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dsa_er_inhabil(uuid, uuid) to service_role;

-- Mindste rolle for at træffe (og behandle klage over) en afgørelse. Auktioner
-- og kontolukning kræver admin (som i resten af admin), resten medarbejder.
create or replace function public.dsa_min_rolle(p_handling text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_handling in ('auktion_skjult', 'auktion_fjernet', 'auktion_annulleret', 'konto_lukket')
              then 'admin' else 'medarbejder' end;
$fn$;
revoke all on function public.dsa_min_rolle(text) from public, anon, authenticated;
grant execute on function public.dsa_min_rolle(text) to service_role;

-- ============================================================ 5. Anmeld (art. 16)

-- Kaldes KUN af serveren (service_role) efter rate limit og spamtjek.
-- p_anmelder er den indloggede bruger (verificeret af serveren) eller null.
-- Returnerer {kode, id, sagsnummer, frist_kl}. Koder: ok, findes,
-- ugyldig_kategori, ugyldig_type, ikke_fundet, sig_selv, begrundelse,
-- god_tro, anmelder_mangler, for_mange, ugyldig_placering.
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

-- ============================================================ 6. Indgreb + begrundelse (art. 17)

-- ÉN fælles funktion for alle indgreb. Udfører indgrebet, gemmer
-- begrundelsen (dsa_afgoerelser), logger i moderation_log og lukker
-- anmeldelser på samme indhold - alt i samme transaktion.
--
-- p_ekstra: {"varighed": "1"|"7"|"permanent"} ved konto_suspenderet,
--           {"sag_id": uuid} ved konto_lukket fra en sag,
--           {"svar_til_anmelder": text, "politi_underrettet": bool}.
-- Koder: ok, uaendret, ingen_adgang, ugyldig_handling, ugyldig_regel,
-- fakta_mangler, for_lang_tekst, ikke_fundet, inhabil, staff, har_handel,
-- afsluttet, ikke_aktiv, allerede_lukket, anmeldelse_ugyldig, ugyldig_varighed.
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

-- Kontolukning efter 3 advarsler (konto_lukning_godkend) + begrundelse.
create or replace function public.dsa_konto_lukning_godkend(p_medarbejder uuid, p_forslag uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_r     jsonb;
  v_regel record;
  v_afg   uuid;
  v_antal integer;
begin
  v_r := public.konto_lukning_godkend(p_medarbejder, p_forslag, p_note);
  if v_r->>'kode' <> 'ok' then return v_r; end if;

  select * into v_regel from public.dsa_regler() r where r.kode = 'gentagne_overtraedelser';
  select count(*) into v_antal from public.advarsler a where a.bruger_id = (v_r->>'bruger_id')::uuid;

  insert into public.dsa_afgoerelser
    (bruger_id, indhold_type, indhold_id, indhold_tekst, handling, regel_kode, regel_tekst, grundlag, fakta,
     intern_note, medarbejder_id)
  values
    ((v_r->>'bruger_id')::uuid, 'profil', (v_r->>'bruger_id')::uuid, 'Din konto', 'konto_lukket', v_regel.kode,
     left(v_regel.navn || ' (' || v_regel.henvisning || ')', 500), v_regel.grundlag,
     format('Din konto har fået %s advarsler fra BidHamr. Efter vores regler lukkes en konto permanent, når den har fået 3 advarsler. Du kan se begrundelsen for hver advarsel under Min konto.', v_antal),
     nullif(btrim(coalesce(p_note, '')), ''), p_medarbejder)
  returning id into v_afg;

  return v_r || jsonb_build_object('afgoerelse_id', v_afg);
end;
$fn$;
revoke all on function public.dsa_konto_lukning_godkend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dsa_konto_lukning_godkend(uuid, uuid, text) to service_role;

-- ============================================================ 7. Anmeldelse uden indgreb

-- Udfald: ingen_overtraedelse | ikke_fundet. p_svar (til anmelderen) kræves.
create or replace function public.dsa_anmeldelse_afgoer(
  p_medarbejder uuid,
  p_anmeldelse  uuid,
  p_udfald      text,
  p_svar        text,
  p_intern_note text,
  p_politi      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_svar text := btrim(coalesce(p_svar, ''));
  v_note text := nullif(btrim(coalesce(p_intern_note, '')), '');
  x      record;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('ingen_overtraedelse', 'ikke_fundet') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_svar = '' then return jsonb_build_object('kode', 'svar_mangler'); end if;
  if char_length(v_svar) > 2000 or (v_note is not null and char_length(v_note) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into x from public.dsa_anmeldelser a where a.id = p_anmeldelse for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.status <> 'ny' then return jsonb_build_object('kode', 'behandlet'); end if;
  if x.anmelder_id = p_medarbejder or public.dsa_er_inhabil(p_medarbejder, x.anmeldt_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.dsa_anmeldelser
     set status = 'afgjort', udfald = p_udfald, svar_til_anmelder = v_svar,
         intern_note = coalesce(v_note, intern_note), behandlet_af = p_medarbejder, behandlet_kl = now(),
         politi_underrettet = politi_underrettet or coalesce(p_politi, false)
   where id = x.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'dsa_anmeldelse_afgjort', 'dsa', x.id, x.anmeldt_bruger_id,
          left('Anmeldelse ' || x.sagsnummer || ' afsluttet uden indgreb ('
               || case p_udfald when 'ikke_fundet' then 'indholdet findes ikke' else 'ingen overtrædelse' end
               || '): ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'id', x.id);
end;
$fn$;
revoke all on function public.dsa_anmeldelse_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.dsa_anmeldelse_afgoer(uuid, uuid, text, text, text, boolean) to service_role;

-- Videresend til admin (fx en auktion, som kun admin kan fjerne).
create or replace function public.dsa_anmeldelse_videresend(p_medarbejder uuid, p_anmeldelse uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := btrim(coalesce(p_note, ''));
  x      record;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note = '' then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into x from public.dsa_anmeldelser a where a.id = p_anmeldelse for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.status <> 'ny' then return jsonb_build_object('kode', 'behandlet'); end if;
  if x.eskaleret_kl is not null then return jsonb_build_object('kode', 'uaendret'); end if;

  update public.dsa_anmeldelser
     set eskaleret_kl = now(), eskaleret_af = p_medarbejder, eskaleret_note = v_note
   where id = x.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'dsa_anmeldelse_videresendt', 'dsa', x.id, x.anmeldt_bruger_id,
          left('Anmeldelse ' || x.sagsnummer || ' videresendt til admin: ' || v_note, 4000));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;
revoke all on function public.dsa_anmeldelse_videresend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dsa_anmeldelse_videresend(uuid, uuid, text) to service_role;

-- ============================================================ 8. Klage (art. 20)

-- Den ramte bruger klager over en afgørelse. Serveren har verificeret, at
-- p_bruger er brugeren (session eller signeret link).
create or replace function public.dsa_klage_indgiv(p_bruger uuid, p_afgoerelse uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_begr text := btrim(coalesce(p_begrundelse, ''));
  x      record;
  v_id   uuid;
  v_nr   text;
begin
  if p_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if char_length(v_begr) < 10 or char_length(v_begr) > 2000 then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  select * into x from public.dsa_afgoerelser a where a.id = p_afgoerelse for update;
  if not found or x.bruger_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if exists (select 1 from public.dsa_klager k where k.afgoerelse_id = x.id) then
    return jsonb_build_object('kode', 'findes');
  end if;
  if x.ophaevet_kl is not null then return jsonb_build_object('kode', 'ophaevet'); end if;
  if now() > x.klage_frist_kl then return jsonb_build_object('kode', 'frist_udloebet'); end if;

  insert into public.dsa_klager (afgoerelse_id, klager_id, begrundelse)
  values (x.id, p_bruger, v_begr)
  returning id, sagsnummer into v_id, v_nr;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'sagsnummer', v_nr);
end;
$fn$;
revoke all on function public.dsa_klage_indgiv(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_indgiv(uuid, uuid, text) to service_role;

-- Samme for appen: udleder brugeren af auth.uid().
create or replace function public.dsa_klag(p_afgoerelse uuid, p_begrundelse text)
returns jsonb
language sql
security definer
set search_path = ''
as $fn$
  select public.dsa_klage_indgiv(auth.uid(), p_afgoerelse, p_begrundelse);
$fn$;
revoke all on function public.dsa_klag(uuid, text) from public, anon;
grant execute on function public.dsa_klag(uuid, text) to authenticated, service_role;

-- Anmelderen klager over, at der ikke blev grebet ind. Serveren har
-- verificeret anmelderen (session eller signeret link).
create or replace function public.dsa_klage_indgiv_anmelder(p_anmeldelse uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_begr text := btrim(coalesce(p_begrundelse, ''));
  x      record;
  v_id   uuid;
  v_nr   text;
begin
  if char_length(v_begr) < 10 or char_length(v_begr) > 2000 then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  select * into x from public.dsa_anmeldelser a where a.id = p_anmeldelse for update;
  if not found or x.anonymiseret_kl is not null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.status <> 'afgjort' or x.udfald = 'indgreb' then return jsonb_build_object('kode', 'kan_ikke_klage'); end if;
  if exists (select 1 from public.dsa_klager k where k.anmeldelse_id = x.id) then
    return jsonb_build_object('kode', 'findes');
  end if;
  if now() > x.behandlet_kl + interval '6 months' then return jsonb_build_object('kode', 'frist_udloebet'); end if;

  insert into public.dsa_klager (anmeldelse_id, klager_id, klager_email, begrundelse)
  values (x.id, x.anmelder_id, case when x.anmelder_id is null then x.anmelder_email end, v_begr)
  returning id, sagsnummer into v_id, v_nr;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'sagsnummer', v_nr);
end;
$fn$;
revoke all on function public.dsa_klage_indgiv_anmelder(uuid, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_indgiv_anmelder(uuid, text) to service_role;

-- Staff afgør en klage. Medhold tilbagefører indgrebet (eller genåbner
-- anmeldelsen). Behandles af en ANDEN end den, der traf afgørelsen.
-- Koder: ok, ingen_adgang, ugyldigt_udfald, svar_mangler, for_lang_tekst,
-- ikke_fundet, behandlet, inhabil.
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

-- ============================================================ 9. Brugerens egne

-- Afgørelser om brugeren selv. Ingen medarbejder-id, ingen intern note og
-- aldrig anmelderens identitet - kun om afgørelsen kom efter en anmeldelse.
create or replace function public.mine_dsa_afgoerelser()
returns table (
  id uuid, sagsnummer text, indhold_type text, indhold_id uuid, auktion_id uuid, indhold_tekst text,
  handling text, regel_tekst text, grundlag text, fakta text, automatisk_opdaget boolean,
  automatisk_afgjort boolean, efter_anmeldelse boolean, varighed_til timestamptz, oprettet_kl timestamptz,
  klage_frist_kl timestamptz, ophaevet_kl timestamptz, klage_status text, klage_udfald text, klage_svar text,
  klage_oprettet_kl timestamptz, klage_afgjort_kl timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.sagsnummer, a.indhold_type, a.indhold_id, a.auktion_id, a.indhold_tekst, a.handling,
         a.regel_tekst, a.grundlag, a.fakta, a.automatisk_opdaget, a.automatisk_afgjort,
         a.anmeldelse_id is not null, a.varighed_til, a.oprettet_kl, a.klage_frist_kl, a.ophaevet_kl,
         k.status, k.udfald, k.svar, k.oprettet_kl, k.afgjort_kl
    from public.dsa_afgoerelser a
    left join public.dsa_klager k on k.afgoerelse_id = a.id
   where auth.uid() is not null and a.bruger_id = auth.uid()
   order by a.oprettet_kl desc
   limit 200;
$fn$;
revoke all on function public.mine_dsa_afgoerelser() from public, anon;
grant execute on function public.mine_dsa_afgoerelser() to authenticated, service_role;

-- Anmeldelser, brugeren selv har lavet (indlogget). Ingen oplysninger om den
-- anmeldte ud over placeringen, anmelderen selv har angivet.
create or replace function public.mine_dsa_anmeldelser()
returns table (
  id uuid, sagsnummer text, indhold_type text, placering text, kategori text, status text, udfald text,
  svar_til_anmelder text, oprettet_kl timestamptz, behandlet_kl timestamptz, klage_status text,
  klage_udfald text, klage_svar text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.sagsnummer, a.indhold_type, a.placering, a.kategori, a.status, a.udfald,
         case when a.status = 'afgjort' then a.svar_til_anmelder end,
         a.oprettet_kl, a.behandlet_kl, k.status, k.udfald, k.svar
    from public.dsa_anmeldelser a
    left join public.dsa_klager k on k.anmeldelse_id = a.id
   where auth.uid() is not null and a.anmelder_id = auth.uid()
   order by a.oprettet_kl desc
   limit 200;
$fn$;
revoke all on function public.mine_dsa_anmeldelser() from public, anon;
grant execute on function public.mine_dsa_anmeldelser() to authenticated, service_role;

-- ============================================================ 10. Ophævet af staff

-- Viser staff indholdet igen / ophæver suspensionen (fra admin, appen eller
-- SQL), markeres den åbne afgørelse som ophævet. Klage-medhold markerer selv
-- først, så den her ikke rører den.
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

drop trigger if exists auctions_dsa_ophaevet on public.auctions;
create trigger auctions_dsa_ophaevet after update of skjult, status on public.auctions
  for each row when (old.skjult is distinct from new.skjult or old.status is distinct from new.status)
  execute function public.dsa_marker_ophaevet();
drop trigger if exists auction_questions_dsa_ophaevet on public.auction_questions;
create trigger auction_questions_dsa_ophaevet after update of hidden on public.auction_questions
  for each row when (old.hidden is distinct from new.hidden)
  execute function public.dsa_marker_ophaevet();
drop trigger if exists ratings_dsa_ophaevet on public.ratings;
create trigger ratings_dsa_ophaevet after update of skjult on public.ratings
  for each row when (old.skjult is distinct from new.skjult)
  execute function public.dsa_marker_ophaevet();
drop trigger if exists bedoemmelse_svar_dsa_ophaevet on public.bedoemmelse_svar;
create trigger bedoemmelse_svar_dsa_ophaevet after update of skjult on public.bedoemmelse_svar
  for each row when (old.skjult is distinct from new.skjult)
  execute function public.dsa_marker_ophaevet();
drop trigger if exists users_dsa_ophaevet on public.users;
create trigger users_dsa_ophaevet after update of suspenderet, konto_lukket_kl on public.users
  for each row when (old.suspenderet is distinct from new.suspenderet
                     or old.konto_lukket_kl is distinct from new.konto_lukket_kl)
  execute function public.dsa_marker_ophaevet();

-- ============================================================ 11. Gennemsigtighedsrapport

-- Tal for perioden [p_fra, p_til). Kun service_role; siden kræver admin/chef.
-- Ingen persondata - kun antal.
create or replace function public.dsa_rapport(p_fra timestamptz, p_til timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with
  anm as (select * from public.dsa_anmeldelser a where a.oprettet_kl >= p_fra and a.oprettet_kl < p_til),
  afg as (select * from public.dsa_afgoerelser a where a.oprettet_kl >= p_fra and a.oprettet_kl < p_til),
  kl  as (select * from public.dsa_klager k where k.oprettet_kl >= p_fra and k.oprettet_kl < p_til),
  rap as (
    select r.category, r.reporter_id from public.reports r
     where r.created_at >= p_fra and r.created_at < p_til
    union all
    select r.category, r.reporter_id from public.rapporter_arkiv r
     where r.created_at >= p_fra and r.created_at < p_til
  )
  select jsonb_build_object(
    'fra', p_fra,
    'til', p_til,
    'anmeldelser', jsonb_build_object(
      'i_alt', (select count(*) from anm),
      'aabne', (select count(*) from anm where status = 'ny'),
      'uden_login', (select count(*) from anm where anmelder_id is null),
      'videresendt', (select count(*) from anm where eskaleret_kl is not null),
      'politi_underrettet', (select count(*) from anm where politi_underrettet),
      'median_timer', (select round((percentile_cont(0.5) within group (
                          order by extract(epoch from behandlet_kl - oprettet_kl)) / 3600)::numeric, 1)
                         from anm where behandlet_kl is not null),
      'pr_kategori', coalesce((select jsonb_agg(x order by x->>'kategori') from (
          select jsonb_build_object(
                   'kategori', kategori,
                   'antal', count(*),
                   'indgreb', count(*) filter (where udfald = 'indgreb'),
                   'ingen_overtraedelse', count(*) filter (where udfald = 'ingen_overtraedelse'),
                   'ikke_fundet', count(*) filter (where udfald = 'ikke_fundet'),
                   'aabne', count(*) filter (where status = 'ny')) as x
            from anm group by kategori) s), '[]'::jsonb),
      'pr_indhold', coalesce((select jsonb_agg(jsonb_build_object('indhold_type', indhold_type, 'antal', n)
                                               order by indhold_type)
                                from (select indhold_type, count(*) n from anm group by indhold_type) s), '[]'::jsonb)
    ),
    'indgreb', jsonb_build_object(
      'i_alt', (select count(*) from afg),
      'efter_anmeldelse', (select count(*) from afg where anmeldelse_id is not null),
      'eget_initiativ', (select count(*) from afg where anmeldelse_id is null),
      'automatisk_opdaget', (select count(*) from afg where automatisk_opdaget),
      'manuelt_opdaget', (select count(*) from afg where not automatisk_opdaget),
      'automatisk_afgjort', (select count(*) from afg where automatisk_afgjort),
      'ophaevet', (select count(*) from afg where ophaevet_kl is not null),
      'pr_handling', coalesce((select jsonb_agg(jsonb_build_object('handling', handling, 'antal', n) order by handling)
                                 from (select handling, count(*) n from afg group by handling) s), '[]'::jsonb),
      'pr_regel', coalesce((select jsonb_agg(jsonb_build_object('regel', regel_kode, 'grundlag', grundlag, 'antal', n)
                                             order by n desc, regel_kode)
                              from (select regel_kode, grundlag, count(*) n from afg group by regel_kode, grundlag) s), '[]'::jsonb),
      'pr_grundlag', jsonb_build_object(
        'lov', (select count(*) from afg where grundlag = 'lov'),
        'vilkaar', (select count(*) from afg where grundlag = 'vilkaar'))
    ),
    'suspenderinger', jsonb_build_object(
      'midlertidige', (select count(*) from afg where handling = 'konto_suspenderet' and varighed_til is not null),
      'permanente', (select count(*) from afg where handling = 'konto_suspenderet' and varighed_til is null),
      'lukkede_konti', (select count(*) from afg where handling = 'konto_lukket')
    ),
    'klager', jsonb_build_object(
      'i_alt', (select count(*) from kl),
      'over_indgreb', (select count(*) from kl where afgoerelse_id is not null),
      'fra_anmeldere', (select count(*) from kl where anmeldelse_id is not null),
      'medhold', (select count(*) from kl where udfald = 'medhold'),
      'fastholdt', (select count(*) from kl where udfald = 'fastholdt'),
      'aabne', (select count(*) from kl where status = 'afventer'),
      'median_timer', (select round((percentile_cont(0.5) within group (
                          order by extract(epoch from afgjort_kl - oprettet_kl)) / 3600)::numeric, 1)
                         from kl where afgjort_kl is not null)
    ),
    -- Det gamle rapport-system (appen og automatiske kontroller).
    'oevrige_rapporter', jsonb_build_object(
      'auktioner_fra_brugere', (select count(*) from rap where reporter_id is distinct from public.bidhamr_system_id()),
      'auktioner_automatisk', (select count(*) from rap where reporter_id = public.bidhamr_system_id()),
      'brugere_og_bedoemmelser', (select count(*) from public.bruger_rapporter b
                                   where b.created_at >= p_fra and b.created_at < p_til and b.kilde = 'bruger'),
      'spamfilter', (select count(*) from public.bruger_rapporter b
                      where b.created_at >= p_fra and b.created_at < p_til and b.kilde = 'auto')
    )
  );
$fn$;
revoke all on function public.dsa_rapport(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.dsa_rapport(timestamptz, timestamptz) to service_role;

-- ============================================================ 12. Oprydning

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

-- Anmelderens navn, e-mail og konto-kobling samt fritekst slettes 12
-- måneder efter afgørelsen. Statistikken (kategori, tider, udfald) bevares.
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
-- omvendt).
select cron.schedule('dsa_oprydning', '47 3 * * *', $$select public.dsa_oprydning_koer();$$);

comment on table public.dsa_anmeldelser is
  'DSA art. 16: anmeldelser af ulovligt indhold. Kun service_role. Anmelderens navn/e-mail ses kun af staff og anonymiseres 12 mdr. efter afgørelsen (dsa_oprydning_koer).';
comment on table public.dsa_afgoerelser is
  'DSA art. 17: begrundelser for indgreb (oprettes af dsa_indgreb / dsa_konto_lukning_godkend). Slettes aldrig.';
comment on table public.dsa_klager is
  'DSA art. 20: klager over afgørelser. Ét klagetrin pr. afgørelse/anmeldelse. Afgøres af en anden medarbejder (dsa_klage_afgoer).';
