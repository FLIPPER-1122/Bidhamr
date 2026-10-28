-- Køb af boost-point i appen via Apple In-App Purchase og Google Play Billing
-- (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER, "Køb af boost-point i appen").
--
-- Apple og Google er sælger over for køberen ved køb i appen (de opkræver
-- moms og udsteder kvitteringen). BidHamr udsteder INGEN faktura for disse
-- køb og sender ingen kvitteringsmail: købene ligger i deres egen tabel
-- (boost_iap_koeb), ikke i boost_koeb, så fakturakøen (faktura_planlaeg_boost)
-- og Stripe-flowet aldrig ser dem. Stripe-vejen på bidhamr.dk er uændret.
--
-- Pengestrømmen (point - ingen penge går gennem BidHamr her):
--   1. Appen køber et forbrugsprodukt hos Apple/Google og sender beviset til
--      POST /api/app/boost/iap (Bearer, kun private).
--   2. Serveren slår købet op hos Apple (App Store Server API, Get Transaction
--      Info - signeret JWS, kæden verificeret til Apple Root CA - G3) eller
--      Google (purchases.products.get) og tjekker app, produkt, miljø, at
--      købet er gennemført og ikke refunderet. Først derefter kaldes
--      boost_iap_krediter.
--   3. boost_iap_krediter låser brugerens pointkonto, gemmer købet ÉN gang
--      (unikt pr. platform + transaktion/ordre, og pr. Google-token) og
--      krediterer pointene med posteringstypen koeb_apple / koeb_google.
--      Samme køb kan aldrig give point to gange eller til en anden bruger.
--      Pointene bestemmes af produkt-id'et i boost_iap_produkter - aldrig af
--      klienten.
--   4. Google: serveren kalder consume, så produktet kan købes igen, og
--      gemmer resultatet (boost_iap_forbrug_resultat). Fejler det, prøver
--      cron'en igen.
--   5. Refusion (Apple REFUND, Google voidedPurchaseNotification og Googles
--      Voided Purchases API i den daglige cron): boost_iap_refusion trækker
--      pointene tilbage med refusion_apple / refusion_google. Er pointene
--      brugt, går saldoen i MINUS (beslutningen: "saldoen kan gå i minus, og
--      chefen får besked"). En negativ saldo blokerer nye boost af sig selv
--      (boost_brug kræver saldo >= prisen).
--
-- Ledgeren tillod hidtil aldrig minus (CHECK saldo_efter >= 0 og BHB01 i
-- triggeren). Den ændres, så KUN refusion_apple / refusion_google må føre
-- saldoen under 0. Alle andre udtræk (boost, staff-justering) afvises stadig,
-- hvis de ville gøre saldoen negativ eller mere negativ, og en tilbageførsel
-- (Stripe, salg) klippes som før til den positive saldo (0, når saldoen er i
-- minus). Indbetalinger (køb, optjening, henvisning, positiv staff-justering)
-- er altid tilladt - også når saldoen er i minus.
--
-- Indhold:
--   0. Hjælpere (kun i sessionen) med md5-drift-tjek som 20261026010000
--   1. boost_iap_produkter (de tre forbrugsprodukter -> point)
--   2. boost_iap_koeb (ét køb pr. transaktion/ordre - slettes aldrig)
--   3. boost_iap_notifikationer (webhook-idempotens) og boost_iap_cron
--   4. boost_posteringer: typerne koeb_apple, koeb_google, refusion_apple,
--      refusion_google + kolonnen iap_koeb_id; minus kun ved refusion
--   5. boost_posteringer_saldo (trigger) og boost_staff_justering rettet
--   6. Serverfunktionerne (kun service_role)
--   7. Chefens visning: boost_iap_admin_bruger og boost_salg_oversigt
--
-- Idempotent (kan køres igen). Én transaktion. Kun testdatabasen, indtil
-- Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.users') is null or to_regclass('public.boost_posteringer') is null
     or to_regclass('public.boost_pakker') is null or to_regclass('public.boost_koeb') is null then
    raise exception 'Forudsætning mangler: users, boost_posteringer, boost_koeb (20261023030000_boost.sql) og boost_pakker (20261026010000_boost_pakker.sql)';
  end if;
  if to_regprocedure('public.boost_bruger_spaerret(uuid)') is null
     or to_regprocedure('public.boost_laas_bruger(uuid)') is null
     or to_regprocedure('public.boost_saldo(uuid)') is null then
    raise exception 'Forudsætning mangler: boost_bruger_spaerret, boost_laas_bruger og boost_saldo';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) - som 20261026010000
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke - kør de tidligere boost-migrationer først', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- ===========================================================================
-- 1. Produkterne (forbrugsprodukter i App Store Connect og Play Console)
-- ===========================================================================
-- Samme produkt-id på begge platforme. Pointene står KUN her (klienten
-- bestemmer aldrig point eller pris). pakke_id peger på hjemmesidens pakke
-- med samme antal point - kun til rapporten (listepris), aldrig til prisen i
-- appen (den sætter Apple/Google ud fra price point i deres konsol).
-- Ændres med en migration; slettes aldrig (købene peger på dem) - sæt aktiv
-- = false.
create table if not exists public.boost_iap_produkter (
  produkt_id  text primary key,
  point       integer not null,
  pakke_id    text references public.boost_pakker(id) on delete restrict,
  aktiv       boolean not null default true,
  sortering   integer not null,
  oprettet_kl timestamptz not null default now(),
  constraint boost_iap_produkter_id_check check (produkt_id ~ '^dk\.bidhamr\.app\.[a-z0-9_]{1,40}$'),
  constraint boost_iap_produkter_tal_check check (point between 1 and 100000 and sortering between 0 and 10000)
);
comment on table public.boost_iap_produkter is
  'Boost-point i appen (Filip, 27. okt. 2026): forbrugsprodukterne hos Apple og Google (samme id på begge) og deres point. Serveren slår pointene op her - aldrig fra klienten. Slettes aldrig (sæt aktiv = false).';

insert into public.boost_iap_produkter (produkt_id, point, pakke_id, aktiv, sortering) values
  ('dk.bidhamr.app.boost100', 100, 'point_100', true, 10),
  ('dk.bidhamr.app.boost300', 300, 'point_300', true, 20),
  ('dk.bidhamr.app.boost700', 700, 'point_700', true, 30)
on conflict (produkt_id) do nothing;

alter table public.boost_iap_produkter enable row level security;
revoke all on public.boost_iap_produkter from public, anon, authenticated, service_role;
grant select on public.boost_iap_produkter to service_role;

create or replace function public.boost_iap_produkter_forbyd_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Boost-produkter i appen slettes ikke (købene peger på dem) - sæt aktiv = false';
end;
$fn$;
drop trigger if exists boost_iap_produkter_forbyd_sletning on public.boost_iap_produkter;
create trigger boost_iap_produkter_forbyd_sletning before delete on public.boost_iap_produkter
  for each row execute function public.boost_iap_produkter_forbyd_sletning();
drop trigger if exists boost_iap_produkter_ingen_truncate on public.boost_iap_produkter;
create trigger boost_iap_produkter_ingen_truncate before truncate on public.boost_iap_produkter
  for each statement execute function public.boost_forbyd_aendring();
-- Point på et produkt kan ikke ændres (gamle køb og refusioner bruger købets
-- egne låste point, men en ændring skal være et nyt produkt-id).
create or replace function public.boost_iap_produkter_laast()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.produkt_id <> old.produkt_id or new.point <> old.point then
    raise exception 'Et boost-produkts id og point kan ikke ændres - opret et nyt produkt-id';
  end if;
  return new;
end;
$fn$;
drop trigger if exists boost_iap_produkter_laast on public.boost_iap_produkter;
create trigger boost_iap_produkter_laast before update on public.boost_iap_produkter
  for each row execute function public.boost_iap_produkter_laast();

-- ===========================================================================
-- 2. Købene (ét pr. transaktion/ordre)
-- ===========================================================================
-- Kun det nødvendige gemmes - ingen hel kvittering og ingen persondata ud
-- over bruger-id'et:
--   ekstern_id           Apple transactionId / Google orderId (idempotens)
--   original_ekstern_id  Apple originalTransactionId (kun Apple)
--   google_token         Googles purchaseToken - skal bruges til consume og
--                        til at finde købet fra en RTDN (kun Google)
--   miljoe               'produktion' eller 'test' (Apple Sandbox / Googles
--                        licenstestere)
--   pris_milli, valuta   Apples pris i milliunits og valuta (Google oplyser
--                        ikke prisen på købet - null)
--   land                 Apples storefront (3 bogstaver) / Googles regionCode
--                        (2 bogstaver) - til bogføringen (moms afregnes af
--                        Apple/Google, men revisoren kan spørge om land)
create table if not exists public.boost_iap_koeb (
  id                    uuid primary key default gen_random_uuid(),
  platform              text not null,
  ekstern_id            text not null,
  original_ekstern_id   text,
  google_token          text,
  bruger_id             uuid not null references public.users(id) on delete restrict,
  produkt_id            text not null references public.boost_iap_produkter(produkt_id) on delete restrict,
  point                 integer not null,
  miljoe                text not null,
  koebt_kl              timestamptz not null,
  pris_milli            bigint,
  valuta                text,
  land                  text,
  krediteret_kl         timestamptz not null default now(),
  -- Google consume (Apple: altid null - appen afslutter selv transaktionen).
  forbrugt_kl           timestamptz,
  forbrug_forsoeg       integer not null default 0,
  forbrug_sidste_fejl   text,
  -- Refusion: point trukket tilbage i alt (kumulativt - en delvis refusion
  -- hos Apple kan følges af en fuld).
  refunderet_point      integer not null default 0,
  refunderet_kl         timestamptz,
  refusion_kilde        text,
  kraever_opmaerksomhed boolean not null default false,
  opmaerksomhed_tekst   text,
  opdateret             timestamptz not null default now(),
  constraint boost_iap_koeb_platform_check check (platform in ('ios', 'android')),
  constraint boost_iap_koeb_miljoe_check check (miljoe in ('produktion', 'test')),
  constraint boost_iap_koeb_ekstern_check check (char_length(ekstern_id) between 1 and 200
    and (original_ekstern_id is null or char_length(original_ekstern_id) between 1 and 200)),
  constraint boost_iap_koeb_token_check check (
    (platform = 'android' and google_token is not null and char_length(google_token) between 10 and 2000)
    or (platform = 'ios' and google_token is null)),
  constraint boost_iap_koeb_point_check check (point between 1 and 100000 and refunderet_point between 0 and point),
  constraint boost_iap_koeb_pris_check check (
    (pris_milli is null and valuta is null) or (pris_milli between 0 and 100000000000 and valuta ~ '^[A-Z]{3}$')),
  constraint boost_iap_koeb_land_check check (land is null or land ~ '^[A-Z]{2,3}$'),
  constraint boost_iap_koeb_forbrug_check check (platform = 'android' or forbrugt_kl is null),
  constraint boost_iap_koeb_refusion_check check (refunderet_point = 0 or refunderet_kl is not null),
  constraint boost_iap_koeb_kilde_check check (
    refusion_kilde is null or refusion_kilde in ('apple_notifikation', 'google_rtdn', 'google_voided', 'apple_opslag', 'google_opslag')),
  constraint boost_iap_koeb_tekst_check check (
    coalesce(char_length(forbrug_sidste_fejl), 0) <= 500 and coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000)
);
comment on table public.boost_iap_koeb is
  'Køb af boost-point i appen via Apple In-App Purchase / Google Play Billing (Filip, 27. okt. 2026). Ét køb pr. transaktion/ordre - kan aldrig give point to gange eller til en anden bruger. Apple/Google er sælger (moms og kvittering) - BidHamr laver ingen faktura. Skrives kun af security definer-funktionerne. Handelsdata - slettes aldrig.';

create unique index if not exists boost_iap_koeb_ekstern on public.boost_iap_koeb (platform, ekstern_id);
create unique index if not exists boost_iap_koeb_token on public.boost_iap_koeb (google_token) where google_token is not null;
create index if not exists boost_iap_koeb_bruger on public.boost_iap_koeb (bruger_id, krediteret_kl desc);
create index if not exists boost_iap_koeb_original on public.boost_iap_koeb (original_ekstern_id) where original_ekstern_id is not null;
create index if not exists boost_iap_koeb_mangler_forbrug on public.boost_iap_koeb (krediteret_kl)
  where platform = 'android' and forbrugt_kl is null;
create index if not exists boost_iap_koeb_krediteret on public.boost_iap_koeb (krediteret_kl);

create or replace function public.boost_iap_koeb_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.platform <> old.platform or new.ekstern_id <> old.ekstern_id
     or new.original_ekstern_id is distinct from old.original_ekstern_id
     or new.google_token is distinct from old.google_token
     or new.bruger_id <> old.bruger_id or new.produkt_id <> old.produkt_id or new.point <> old.point
     or new.miljoe <> old.miljoe or new.koebt_kl <> old.koebt_kl
     or new.pris_milli is distinct from old.pris_milli or new.valuta is distinct from old.valuta
     or new.land is distinct from old.land or new.krediteret_kl <> old.krediteret_kl
     -- Refunderede point kan kun gå op.
     or new.refunderet_point < old.refunderet_point
     or (old.forbrugt_kl is not null and new.forbrugt_kl is distinct from old.forbrugt_kl) then
    raise exception 'Købets platform, transaktion, køber, produkt, point og pris kan ikke ændres';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;
drop trigger if exists boost_iap_koeb_laaste_felter on public.boost_iap_koeb;
create trigger boost_iap_koeb_laaste_felter before update on public.boost_iap_koeb
  for each row execute function public.boost_iap_koeb_laaste_felter();
drop trigger if exists boost_iap_koeb_forbyd_sletning on public.boost_iap_koeb;
create trigger boost_iap_koeb_forbyd_sletning before delete on public.boost_iap_koeb
  for each row execute function public.boost_koeb_forbyd_sletning();
drop trigger if exists boost_iap_koeb_ingen_truncate on public.boost_iap_koeb;
create trigger boost_iap_koeb_ingen_truncate before truncate on public.boost_iap_koeb
  for each statement execute function public.boost_forbyd_aendring();

alter table public.boost_iap_koeb enable row level security;
-- Brugeren kan læse sine egne køb (kun de viste kolonner - ikke token).
drop policy if exists boost_iap_koeb_egne on public.boost_iap_koeb;
create policy boost_iap_koeb_egne on public.boost_iap_koeb
  for select to authenticated using (bruger_id = (select auth.uid()));
revoke all on public.boost_iap_koeb from public, anon, authenticated, service_role;
grant select on public.boost_iap_koeb to service_role;
grant select (id, platform, produkt_id, point, koebt_kl, krediteret_kl, refunderet_point, refunderet_kl)
  on public.boost_iap_koeb to authenticated;

-- ===========================================================================
-- 3. Webhook-idempotens og den daglige cron
-- ===========================================================================
-- Én række pr. notifikation (Apple notificationUUID, Google Pub/Sub
-- messageId). En notifikation, der er behandlet, behandles ikke igen.
-- Refusionen er desuden idempotent i sig selv (kumulativt mål pr. køb).
create table if not exists public.boost_iap_notifikationer (
  platform        text not null,
  notifikation_id text not null,
  type            text not null,
  modtaget_kl     timestamptz not null default now(),
  forsoeg         integer not null default 1,
  behandlet_kl    timestamptz,
  resultat        text,
  primary key (platform, notifikation_id),
  constraint boost_iap_notifikationer_platform_check check (platform in ('ios', 'android')),
  constraint boost_iap_notifikationer_tekst_check check (
    char_length(notifikation_id) between 1 and 200 and char_length(type) between 1 and 80
    and coalesce(char_length(resultat), 0) <= 200)
);
comment on table public.boost_iap_notifikationer is
  'Webhooks fra Apple (App Store Server Notifications V2) og Google (RTDN via Pub/Sub): én række pr. notifikation, så samme notifikation kun behandles én gang. Kun id, type og resultat - ingen kvittering.';
create index if not exists boost_iap_notifikationer_modtaget on public.boost_iap_notifikationer (modtaget_kl);
alter table public.boost_iap_notifikationer enable row level security;
revoke all on public.boost_iap_notifikationer from public, anon, authenticated, service_role;
grant select on public.boost_iap_notifikationer to service_role;

create table if not exists public.boost_iap_cron (
  id            boolean primary key default true,
  sidst_start_kl timestamptz,
  sidst_ok_kl    timestamptz,
  constraint boost_iap_cron_en check (id)
);
insert into public.boost_iap_cron (id) values (true) on conflict (id) do nothing;
alter table public.boost_iap_cron enable row level security;
revoke all on public.boost_iap_cron from public, anon, authenticated, service_role;
grant select on public.boost_iap_cron to service_role;

-- ===========================================================================
-- 4. Pointkontoen: nye typer og minus kun ved refusion i appen
-- ===========================================================================
alter table public.boost_posteringer
  add column if not exists iap_koeb_id uuid references public.boost_iap_koeb(id) on delete restrict;

-- Typerne: de eksisterende (fra CHECK'en, som den står nu - med eller uden
-- 'henvisning') + de fire nye.
do $do$
declare
  v_def  text;
  v_typer text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.boost_posteringer'::regclass and c.conname = 'boost_posteringer_type_check';
  if v_def is null then raise exception 'boost_posteringer_type_check mangler'; end if;
  -- Allerede udvidet (genkørsel): intet.
  if position('koeb_apple' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_typer
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m;
  v_typer := array(select distinct unnest(v_typer || array['koeb_apple', 'koeb_google', 'refusion_apple', 'refusion_google']) order by 1);
  if not (v_typer @> array['koeb', 'optjening', 'forbrug', 'tilbagefoersel', 'staff']) then
    raise exception 'boost_posteringer_type_check har ikke de forventede typer: %', v_def;
  end if;
  alter table public.boost_posteringer drop constraint boost_posteringer_type_check;
  execute format('alter table public.boost_posteringer add constraint boost_posteringer_type_check check (type = any (%L::text[]))', v_typer);
end $do$;

-- Formen: den eksisterende (uændret) ELLER en af de nye. Bygges ud fra den
-- nuværende CHECK, så de eksisterende former (også 'henvisning') bevares
-- præcis. Allerede udvidet (genkørsel): intet.
do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.boost_posteringer'::regclass and c.conname = 'boost_posteringer_form';
  if v_def is null then raise exception 'boost_posteringer_form mangler'; end if;
  if position('koeb_apple' in v_def) > 0 then return; end if;
  if v_def !~ '^CHECK \(' then raise exception 'boost_posteringer_form har en uventet form: %', left(v_def, 200); end if;
  alter table public.boost_posteringer drop constraint boost_posteringer_form;
  execute format(
    'alter table public.boost_posteringer add constraint boost_posteringer_form check (%s or %s)',
    substring(v_def from 7),
    $c$(
      (type in ('koeb_apple', 'koeb_google') and point > 0)
      or (type in ('refusion_apple', 'refusion_google') and point < 0)
    ) and iap_koeb_id is not null and boost_koeb_id is null and betaling_id is null and boost_id is null
      and staff_id is null and oensket_point is null and idempotens_noegle is null$c$);
end $do$;

-- iap_koeb_id bruges kun af de nye typer.
alter table public.boost_posteringer drop constraint if exists boost_posteringer_iap_kun_type;
alter table public.boost_posteringer add constraint boost_posteringer_iap_kun_type
  check (iap_koeb_id is null or type in ('koeb_apple', 'koeb_google', 'refusion_apple', 'refusion_google'));
-- henvisning_id (20261102230000) er null for de nye typer via formen; den
-- eksisterende boost_posteringer_henvisning_kun_type er uændret.
do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'boost_posteringer' and column_name = 'henvisning_id') then
    alter table public.boost_posteringer drop constraint if exists boost_posteringer_iap_ingen_henvisning;
    alter table public.boost_posteringer add constraint boost_posteringer_iap_ingen_henvisning
      check (iap_koeb_id is null or henvisning_id is null);
  end if;
end $do$;

-- Saldoen må kun blive negativ ved en refusion i appen. En indbetaling (point
-- >= 0) er altid tilladt, også når saldoen allerede er i minus.
alter table public.boost_posteringer drop constraint if exists boost_posteringer_saldo_check;
alter table public.boost_posteringer add constraint boost_posteringer_saldo_check
  check (saldo_efter >= 0 or point >= 0 or type in ('refusion_apple', 'refusion_google'));

-- Ét køb i appen giver point én gang.
create unique index if not exists boost_post_iap_koeb on public.boost_posteringer (iap_koeb_id)
  where type in ('koeb_apple', 'koeb_google');
create index if not exists boost_post_iap on public.boost_posteringer (iap_koeb_id) where iap_koeb_id is not null;

grant select (iap_koeb_id) on public.boost_posteringer to authenticated;

comment on table public.boost_posteringer is
  'Boost-pointkontoen (append-only ledger): køb (Stripe, Apple, Google), optjening, forbrug, tilbageførsel, refusion i appen, henvisning og staff-justering. Saldoen er summen af point. Kan ALDRIG ændres eller slettes. Hver postering låser brugerens konto og gemmer saldo_efter. Kun refusion_apple/refusion_google kan føre saldoen under 0 (Filip, 27. okt. 2026).';

-- ===========================================================================
-- 5. Triggeren og staff-justeringen
-- ===========================================================================
-- boost_posteringer_saldo: den kendte udgave fra 20261023030000 (md5 som i
-- produktion og test 27. okt. 2026) eller denne. Andet afbryder migrationen.
do $do$
declare
  h text := pg_temp.krop_md5('public.boost_posteringer_saldo()');
begin
  if h is null then raise exception 'boost_posteringer_saldo() mangler'; end if;
  if h not in ('f5717557e71a8b600234c2190d27bdb8', '9b27407ea5df280bba8ee508f1572514') then
    raise exception 'boost_posteringer_saldo(): md5 % er hverken den kendte eller den nye - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

create or replace function public.boost_posteringer_saldo()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_saldo integer;
begin
  perform public.boost_laas_bruger(new.bruger_id);
  select coalesce(sum(p.point), 0)::integer into v_saldo
    from public.boost_posteringer p where p.bruger_id = new.bruger_id;
  if new.type = 'tilbagefoersel' then
    new.point := -least(coalesce(new.oensket_point, 0), greatest(v_saldo, 0));
  end if;
  if new.point < 0 and v_saldo + new.point < 0
     and new.type not in ('refusion_apple', 'refusion_google') then
    raise exception 'boost_saldo: der er ikke point nok (saldo %, postering %)', v_saldo, new.point
      using errcode = 'BHB01';
  end if;
  new.saldo_efter := v_saldo + new.point;
  new.oprettet_kl := now();
  return new;
end;
$fn$;
revoke all on function public.boost_posteringer_saldo() from public, anon, authenticated, service_role;

-- Chefens justering: et negativt antal må stadig ikke føre saldoen under 0,
-- men et positivt antal er altid tilladt (også når saldoen er i minus efter
-- en refusion i appen - fx for at nulstille den).
do $do$
begin
  raise notice 'boost_staff_justering: %', pg_temp.ps_ret(
    'public.boost_staff_justering(uuid,uuid,integer,text,uuid)',
    '9cba3c12c35ed44fed60df8ce13dd4bb',
    '514305a239de7fa85da7b20ce2499701',
    jsonb_build_array(jsonb_build_array(
      $g$if v_saldo + p_point < 0 then$g$,
      $n$if p_point < 0 and v_saldo + p_point < 0 then$n$, 1)));
end $do$;

-- ===========================================================================
-- 6. Serverfunktionerne (kun service_role)
-- ===========================================================================
-- Krediterer et køb, som SERVEREN har slået op hos Apple/Google (gennemført,
-- ikke refunderet, rigtig app, rigtigt miljø). p_bruger SKAL være
-- verificeret af serveren (Bearer-token). Svar {kode, ...}:
--   'ok'            id, point, saldo                       nyt køb, point krediteret
--   'allerede'      id, point, saldo, forbrugt, refunderet  samme bruger har fået det
--   'anden_bruger'                                         købet tilhører en anden konto
--   'erhverv' | 'spaerret' | 'ikke_fundet'                 kontoen kan ikke få point
--   'produkt_ukendt' | 'ugyldig'
create or replace function public.boost_iap_krediter(
  p_bruger uuid, p_platform text, p_ekstern_id text, p_original_id text, p_google_token text,
  p_produkt text, p_miljoe text, p_koebt_kl timestamptz, p_pris_milli bigint, p_valuta text, p_land text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_spaerret text;
  v_point integer;
  v_id uuid;
  k record;
begin
  if p_bruger is null or p_platform not in ('ios', 'android') or coalesce(p_ekstern_id, '') = ''
     or p_miljoe not in ('produktion', 'test') or p_koebt_kl is null
     or (p_platform = 'android') <> (p_google_token is not null) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  -- Låserækkefølge som ledgeren: brugerens pointkonto først.
  perform public.boost_laas_bruger(p_bruger);
  -- Samme transaktion/ordre eller samme Google-token: aldrig igen, aldrig til
  -- en anden bruger.
  select x.id, x.bruger_id, x.point, x.forbrugt_kl, x.refunderet_point into k
    from public.boost_iap_koeb x
   where (x.platform = p_platform and x.ekstern_id = p_ekstern_id)
      or (p_google_token is not null and x.google_token = p_google_token)
   limit 1;
  if k.id is not null then
    if k.bruger_id <> p_bruger then return jsonb_build_object('kode', 'anden_bruger'); end if;
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'point', k.point,
                              'forbrugt', k.forbrugt_kl is not null, 'refunderet', k.refunderet_point > 0,
                              'saldo', public.boost_saldo(p_bruger));
  end if;
  v_spaerret := public.boost_bruger_spaerret(p_bruger);
  if v_spaerret is not null then return jsonb_build_object('kode', v_spaerret); end if;
  -- Point fra produktet (også et produkt, der er slået fra - købet er betalt).
  select pr.point into v_point from public.boost_iap_produkter pr where pr.produkt_id = p_produkt;
  if v_point is null then return jsonb_build_object('kode', 'produkt_ukendt'); end if;

  insert into public.boost_iap_koeb (platform, ekstern_id, original_ekstern_id, google_token, bruger_id, produkt_id,
                                     point, miljoe, koebt_kl, pris_milli, valuta, land)
  values (p_platform, p_ekstern_id, nullif(p_original_id, ''), p_google_token, p_bruger, p_produkt,
          v_point, p_miljoe, p_koebt_kl, p_pris_milli, case when p_pris_milli is null then null else p_valuta end,
          nullif(upper(coalesce(p_land, '')), ''))
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    -- Samtidigt kald fra en anden bruger (anden lås) nåede først.
    select x.id, x.bruger_id into k from public.boost_iap_koeb x
     where (x.platform = p_platform and x.ekstern_id = p_ekstern_id)
        or (p_google_token is not null and x.google_token = p_google_token)
     limit 1;
    if k.bruger_id is distinct from p_bruger then return jsonb_build_object('kode', 'anden_bruger'); end if;
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'saldo', public.boost_saldo(p_bruger));
  end if;
  insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, iap_koeb_id)
  values (p_bruger, case when p_platform = 'ios' then 'koeb_apple' else 'koeb_google' end, v_point, 0, v_id);
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'point', v_point, 'saldo', public.boost_saldo(p_bruger));
end;
$fn$;

-- Resultatet af Googles consume (true = forbrugt). Idempotent.
create or replace function public.boost_iap_forbrug_resultat(p_id uuid, p_ok boolean, p_fejl text default null)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  if p_ok then
    update public.boost_iap_koeb set forbrugt_kl = now(), forbrug_sidste_fejl = null
     where id = p_id and platform = 'android' and forbrugt_kl is null;
  else
    update public.boost_iap_koeb
       set forbrug_forsoeg = forbrug_forsoeg + 1, forbrug_sidste_fejl = left(coalesce(p_fejl, 'ukendt fejl'), 500)
     where id = p_id and platform = 'android' and forbrugt_kl is null;
  end if;
  return found;
end;
$fn$;

-- Google-køb, der ikke er forbrugt endnu (cron: prøv consume igen). Højst 20
-- forsøg, kun køb fra de seneste 7 dage og ikke helt refunderede.
create or replace function public.boost_iap_mangler_forbrug(p_graense integer default 50)
returns table (id uuid, produkt_id text, google_token text)
language sql stable security definer set search_path = '' as $fn$
  select x.id, x.produkt_id, x.google_token
    from public.boost_iap_koeb x
   where x.platform = 'android' and x.forbrugt_kl is null and x.forbrug_forsoeg < 20
     and x.refunderet_point < x.point and x.krediteret_kl > now() - interval '7 days'
   order by x.krediteret_kl
   limit least(greatest(coalesce(p_graense, 50), 1), 500);
$fn$;

-- Refusion/void: trækker pointene tilbage, til i alt p_andel_milli af købets
-- point er trukket (milliunits som Apples revocationPercentage: 100000 = hele
-- købet, 50000 = halvdelen - rundet op). Kumulativt: en delvis refusion kan
-- følges af en fuld, og samme andel igen trækker intet. Saldoen MÅ gå i
-- minus. Findes
-- købet på (platform, ekstern_id) eller Google-token. Idempotent: samme mål
-- igen trækker intet. Svar {kode, ...}:
--   'tilbagefoert'  bruger_id, point (trukket nu), saldo, i_minus, id
--   'allerede'      bruger_id, saldo, id      (målet er allerede nået)
--   'ukendt'                                  købet er ikke krediteret hos os
--   'ugyldig'
-- Parameternavnet er ændret undervejs på testdatabasen - genskab altid.
drop function if exists public.boost_iap_refusion(text, text, text, integer, text);
create or replace function public.boost_iap_refusion(
  p_platform text, p_ekstern_id text, p_google_token text, p_andel_milli integer, p_kilde text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_bruger uuid;
  k record;
  v_maal integer;
  v_delta integer;
  v_saldo integer;
begin
  if p_platform not in ('ios', 'android') or p_andel_milli is null or p_andel_milli not between 1 and 100000
     or (coalesce(p_ekstern_id, '') = '' and coalesce(p_google_token, '') = '')
     or p_kilde not in ('apple_notifikation', 'google_rtdn', 'google_voided', 'apple_opslag', 'google_opslag') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  select x.bruger_id into v_bruger from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((coalesce(p_ekstern_id, '') <> '' and x.ekstern_id = p_ekstern_id)
          or (coalesce(p_google_token, '') <> '' and x.google_token = p_google_token))
   limit 1;
  if v_bruger is null then return jsonb_build_object('kode', 'ukendt'); end if;
  -- Låserækkefølge: pointkontoen, så rækken.
  perform public.boost_laas_bruger(v_bruger);
  select x.id, x.point, x.refunderet_point, x.bruger_id into k from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((coalesce(p_ekstern_id, '') <> '' and x.ekstern_id = p_ekstern_id)
          or (coalesce(p_google_token, '') <> '' and x.google_token = p_google_token))
   limit 1
   for update;
  v_maal := least(ceil(k.point::numeric * p_andel_milli / 100000)::integer, k.point);
  v_delta := v_maal - k.refunderet_point;
  if v_delta <= 0 then
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'bruger_id', k.bruger_id,
                              'saldo', public.boost_saldo(k.bruger_id));
  end if;
  insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, iap_koeb_id)
  values (k.bruger_id, case when p_platform = 'ios' then 'refusion_apple' else 'refusion_google' end, -v_delta, 0, k.id);
  v_saldo := public.boost_saldo(k.bruger_id);
  update public.boost_iap_koeb
     set refunderet_point = v_maal, refunderet_kl = coalesce(refunderet_kl, now()),
         refusion_kilde = coalesce(refusion_kilde, p_kilde),
         kraever_opmaerksomhed = kraever_opmaerksomhed or v_saldo < 0,
         opmaerksomhed_tekst = case when v_saldo < 0 then left(concat_ws(E'\n', opmaerksomhed_tekst,
           format('%s har refunderet købet - %s point er trukket tilbage, og saldoen er nu %s (i minus). Nye boost er blokeret, til saldoen er over prisen for et boost.',
                  case when p_platform = 'ios' then 'Apple' else 'Google' end, v_delta, v_saldo)), 4000)
                                    else opmaerksomhed_tekst end
   where id = k.id;
  return jsonb_build_object('kode', 'tilbagefoert', 'id', k.id, 'bruger_id', k.bruger_id, 'point', v_delta,
                            'saldo', v_saldo, 'i_minus', v_saldo < 0);
end;
$fn$;

-- En note til chefen på købet (Apple REFUND_REVERSED, CONSUMPTION_REQUEST).
-- Svar: bruger_id eller null (ukendt køb).
create or replace function public.boost_iap_opmaerksomhed(p_platform text, p_ekstern_id text, p_tekst text)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
  v_bruger uuid;
begin
  update public.boost_iap_koeb
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst, left(coalesce(p_tekst, ''), 500)), 4000)
   where platform = p_platform and ekstern_id = p_ekstern_id
     and position(left(coalesce(p_tekst, ''), 500) in coalesce(opmaerksomhed_tekst, '')) = 0
  returning bruger_id into v_bruger;
  if v_bruger is null then
    select x.bruger_id into v_bruger from public.boost_iap_koeb x where x.platform = p_platform and x.ekstern_id = p_ekstern_id;
  end if;
  return v_bruger;
end;
$fn$;

-- Webhook: 'ny' (behandl den), 'gentaget' (set før, men ikke færdig -
-- behandl igen) eller 'behandlet' (gør intet, svar 200).
create or replace function public.boost_iap_notifikation_start(p_platform text, p_id text, p_type text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  v_behandlet timestamptz;
  v_ny boolean;
begin
  insert into public.boost_iap_notifikationer (platform, notifikation_id, type)
  values (p_platform, left(p_id, 200), left(coalesce(nullif(p_type, ''), 'ukendt'), 80))
  on conflict (platform, notifikation_id) do update set forsoeg = public.boost_iap_notifikationer.forsoeg + 1
  returning behandlet_kl, (xmax = 0) into v_behandlet, v_ny;
  if v_behandlet is not null then return 'behandlet'; end if;
  return case when v_ny then 'ny' else 'gentaget' end;
end;
$fn$;

create or replace function public.boost_iap_notifikation_slut(p_platform text, p_id text, p_resultat text)
returns void language sql security definer set search_path = '' as $fn$
  update public.boost_iap_notifikationer
     set behandlet_kl = coalesce(behandlet_kl, now()), resultat = left(coalesce(p_resultat, 'ok'), 200)
   where platform = p_platform and notifikation_id = left(p_id, 200);
$fn$;

-- Den daglige cron (Googles Voided Purchases og consume-genforsøg): true =
-- kør nu (sidste start er over p_timer timer siden). Atomisk claim.
create or replace function public.boost_iap_cron_claim(p_timer integer default 20)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  update public.boost_iap_cron
     set sidst_start_kl = now()
   where id and (sidst_start_kl is null
                 or sidst_start_kl <= now() - make_interval(hours => least(greatest(coalesce(p_timer, 20), 1), 168))
                 -- En kørsel, der ikke blev færdig, prøves igen efter 2 timer.
                 or (coalesce(sidst_ok_kl, '-infinity') < sidst_start_kl and sidst_start_kl <= now() - interval '2 hours'));
  return found;
end;
$fn$;

create or replace function public.boost_iap_cron_ok()
returns void language sql security definer set search_path = '' as $fn$
  update public.boost_iap_cron set sidst_ok_kl = now() where id;
$fn$;

do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_iap_krediter(uuid, text, text, text, text, text, text, timestamptz, bigint, text, text)',
    'public.boost_iap_forbrug_resultat(uuid, boolean, text)',
    'public.boost_iap_mangler_forbrug(integer)',
    'public.boost_iap_refusion(text, text, text, integer, text)',
    'public.boost_iap_opmaerksomhed(text, text, text)',
    'public.boost_iap_notifikation_start(text, text, text)',
    'public.boost_iap_notifikation_slut(text, text, text)',
    'public.boost_iap_cron_claim(integer)',
    'public.boost_iap_cron_ok()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.boost_iap_produkter_forbyd_sletning()', 'public.boost_iap_produkter_laast()',
    'public.boost_iap_koeb_laaste_felter()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $do$;

-- ===========================================================================
-- 7. Chefens visning
-- ===========================================================================
-- En brugers køb i appen (Admin -> brugeren -> Boost-point). null = ingen
-- adgang (kun chef).
create or replace function public.boost_iap_admin_bruger(p_staff uuid, p_bruger uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', k.id, 'platform', k.platform, 'produkt_id', k.produkt_id, 'point', k.point,
             'miljoe', k.miljoe, 'koebt_kl', k.koebt_kl, 'krediteret_kl', k.krediteret_kl,
             'pris_milli', k.pris_milli, 'valuta', k.valuta, 'ekstern_id', k.ekstern_id,
             'forbrugt_kl', k.forbrugt_kl, 'refunderet_point', k.refunderet_point, 'refunderet_kl', k.refunderet_kl,
             'kraever_opmaerksomhed', k.kraever_opmaerksomhed, 'opmaerksomhed_tekst', k.opmaerksomhed_tekst)
           order by k.krediteret_kl desc)
      from (select * from public.boost_iap_koeb x where x.bruger_id = p_bruger order by x.krediteret_kl desc limit 50) k),
    '[]'::jsonb);
end;
$fn$;

-- Boost-salget i en periode, delt på Stripe (bidhamr.dk), Apple og Google
-- (Admin -> Penge). Kun chef (ellers null). p_fra null = fra start.
--   stripe: antal betalte køb, brutto_oere (betalt beløb), refunderet_antal,
--           refunderet_oere
--   apple / google: antal, point, brutto_oere (kun køb i DKK med kendt pris -
--           Google oplyser ikke prisen), ukendt_pris (antal uden pris i DKK),
--           listepris_oere (hjemmesidens pris for samme pakke - til
--           sammenligning), refunderet_antal, refunderet_point, test_antal
--           (Sandbox/licenstestere - tæller ikke med i resten), i_minus
--           (brugere med negativ saldo nu)
create or replace function public.boost_salg_oversigt(p_staff uuid, p_fra timestamptz, p_til timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_til timestamptz := coalesce(p_til, now());
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return null;
  end if;
  return jsonb_build_object(
    'stripe', (
      select jsonb_build_object(
               'antal', count(*),
               'brutto_oere', coalesce(sum(coalesce(b.modtaget_oere, b.beloeb_oere)), 0),
               'refunderet_antal', count(*) filter (where b.refunderet_kl is not null),
               'refunderet_oere', coalesce(sum(coalesce(b.modtaget_oere, b.beloeb_oere)) filter (where b.refunderet_kl is not null), 0))
        from public.boost_koeb b
       where b.betalt_kl is not null and b.status in ('betalt', 'refunderes', 'refunderet')
         and (p_fra is null or b.betalt_kl >= p_fra) and b.betalt_kl < v_til),
    'apple', public.boost_salg_iap_platform('ios', p_fra, v_til),
    'google', public.boost_salg_iap_platform('android', p_fra, v_til),
    'i_minus', (select count(*) from (select p.bruger_id from public.boost_posteringer p
                                        group by p.bruger_id having sum(p.point) < 0) m));
end;
$fn$;

create or replace function public.boost_salg_iap_platform(p_platform text, p_fra timestamptz, p_til timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
           'antal', count(*) filter (where k.miljoe = 'produktion'),
           'point', coalesce(sum(k.point) filter (where k.miljoe = 'produktion'), 0),
           'brutto_oere', coalesce(sum(k.pris_milli / 10) filter (where k.miljoe = 'produktion' and k.valuta = 'DKK'), 0),
           'ukendt_pris', count(*) filter (where k.miljoe = 'produktion' and k.valuta is distinct from 'DKK'),
           'listepris_oere', coalesce(sum(bp.pris_oere) filter (where k.miljoe = 'produktion'), 0),
           'refunderet_antal', count(*) filter (where k.miljoe = 'produktion' and k.refunderet_point > 0),
           'refunderet_point', coalesce(sum(k.refunderet_point) filter (where k.miljoe = 'produktion'), 0),
           'refunderet_oere', coalesce(sum(k.pris_milli / 10 * k.refunderet_point / k.point)
                                         filter (where k.miljoe = 'produktion' and k.valuta = 'DKK' and k.refunderet_point > 0), 0),
           'test_antal', count(*) filter (where k.miljoe = 'test'))
    from public.boost_iap_koeb k
    left join public.boost_iap_produkter pr on pr.produkt_id = k.produkt_id
    left join public.boost_pakker bp on bp.id = pr.pakke_id
   where k.platform = p_platform and (p_fra is null or k.krediteret_kl >= p_fra) and k.krediteret_kl < p_til;
$fn$;

do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_iap_admin_bruger(uuid, uuid)',
    'public.boost_salg_oversigt(uuid, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke all on function public.boost_salg_iap_platform(text, timestamptz, timestamptz) from public, anon, authenticated, service_role';
end $do$;
