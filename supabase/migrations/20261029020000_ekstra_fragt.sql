-- For lille pakkestørrelse - sælgeren betaler forskellen (Filip, 21. okt.
-- 2026; ROADMAP-BESLUTNINGER, "Fragtfirma og priser"; ROADMAP fase 2).
--
-- Opkræver fragtfirmaet ekstra, fordi pakken var større/tungere end den
-- valgte størrelse (typisk på BidHamrs månedsfaktura, uger efter
-- udbetalingen), registrerer staff en EKSTRAREGNING på handlens udgående
-- forsendelse med fragtfirmaets faktura som dokumentation. Sælgeren får besked
-- og en betalingsknap. Der trækkes ALDRIG automatisk i sælgerens penge.
--
-- Pengestrømmen:
--   - Sælgeren betaler en PaymentIntent på BidHamrs PLATFORMSKONTO (ingen
--     on_behalf_of, ingen transfer_data, intet application fee): beløbet er
--     BidHamrs fragtindtægt (BidHamr har betalt fragtfirmaets faktura). Samme
--     betalingsmetoder som returfragt (card, mobilepay, revolut_pay - aldrig
--     Link/Klarna; src/lib/betaling/betalingsmetoder.ts) med tvungen 3D
--     Secure. Metadata: type 'ekstra_fragt', ekstra_fragt_id, trade_id,
--     saelger_id, bidhamr_db. Idempotency key pr. regning og forsøg (koden).
--   - Beløbet (øre, inkl. moms) er låst på rækken, når staff opretter den.
--   - Webhooken (payment_intent.*) spejler betalingen (ekstra_fragt_registrer);
--     mistet webhook: cron'en slår PaymentIntenten op efter 15 minutter.
--   - Faktura: sælgeren får en faktura på fragtkontoen med moms (slags
--     'ekstra_fragt', part 'saelger', fakturaer.ekstra_fragt_id). Refunderes
--     betalingen (kun i Stripe-dashboardet), krediteres den helt.
--
-- Status:
--   afventer_betaling -> behandles -> betalt          (sælgeren betaler)
--   afventer_betaling -> indsigelse                   (sælgeren, ÉN gang, med tekst,
--                                                     kun FØR fristen)
--   indsigelse -> afventer_betaling (fastholdt)       (staff, begrundelse vises for sælgeren)
--   indsigelse -> frafaldet                           (staff, begrundelse vises for sælgeren)
--   afventer_betaling -> frafaldet                    (staff, grund vises for sælgeren)
--   betalt -> refunderet                              (kun spejlet fra Stripe)
--   betalt -> afventer_betaling (genåbnet)            (staff, kun efter en TABT
--                                                     bankindsigelse - se nedenfor)
--   betalt (tabt bankindsigelse) forbliver betalt     (staff: "Afslut uden genåbning")
-- Frist: 14 dage fra oprettelsen. Fastholdes en indsigelse, er fristen mindst
-- 7 dage fra afgørelsen. Genåbnet: 14 dage fra genåbningen.
--
-- Spærring (fejlkode BHX01, som DAC7's BHD01): har sælgeren en regning i
-- 'afventer_betaling' efter fristen, afviser databasen nye auktioner (også
-- "sæt op igen") og "tilbud til næste byder". Mens en betaling behandles er
-- der ingen spærring, og heller ikke under en indsigelse (som kun kan gøres
-- FØR fristen - Filip, 21. okt. 2026; efter fristen afvises den med
-- 'frist_overskredet', og er sælgeren uenig, kontakter han BidHamr, og staff
-- afgør det manuelt, fx ved frafald). Spærringen gælder, indtil regningen er
-- betalt eller frafaldet (den beregnes - der er intet flag at nulstille).
--
-- Bankindsigelse (chargeback) på en betalt regning: spejles fra Stripe
-- (ekstra_fragt_registrer_bankindsigelse). Tabes den, sker i samme
-- transaktion: regningen markeres (bankindsigelse_tabt_kl - admin-lampen), og
-- der laves AUTOMATISK en kreditnota for rundens faktura (dateret på
-- tabsdagen, reference = indsigelsens id - pengene er hentet tilbage af
-- kortudstederen; idempotent: aldrig to kreditnotaer). Staff får en alarm.
-- Regningen genåbnes ALDRIG automatisk (Filip, 21. okt. 2026). Staff vælger:
--   "Genåbn regning" (ekstra_fragt_genaabn): sælgeren skal betale igen - ny
--     frist, ny betalingsrunde (runde + 1, ny PaymentIntent med ny
--     idempotency key) og en ny faktura, når sælgeren betaler. Laver ikke en
--     kreditnota igen.
--   "Afslut uden genåbning" (ekstra_fragt_bankindsigelse_afslut): regningen
--     forbliver lukket, sælgeren opkræves ikke igen, lampen slukkes
--     (bankindsigelse_haandteret_kl/_af/_begrundelse - intern begrundelse).
-- Den tilbageførte PaymentIntent/charge gemmes ved genåbning i
-- tilbagefoerte_payment_intents/-charges og adopteres ALDRIG igen.
--
-- Oprydning: dokumentationsfiler i bucket'en, som ingen regning bruger, og
-- som er over 7 dage gamle, slettes én gang om måneden
-- (ekstra_fragt_ubrugte_filer + src/lib/ekstraFragt/oprydning.ts).
--
-- Dokumentation: staff uploader fragtfirmaets faktura (PDF/billede - kun
-- udsnittet med pakken) til den private bucket 'ekstra-fragt-dokumentation'
-- (kun service role; serveren giver signerede links til staff og til
-- sælgeren selv). Stien er <handels-id>/<uuid>.<endelse>, og databasen tjekker,
-- at filen findes, og at dens filtype (storage-metadata) passer, før
-- regningen oprettes.
--
-- Beskeder til sælgeren (ny regning, påmindelse efter 7 dage, spærret ved
-- fristen, indsigelse afgjort, frafaldet, betalt) sendes fra serveren
-- (src/lib/ekstraFragt/notifikationer.ts) ud fra tidsstemplerne.
--
-- Ændrer INGEN eksisterende funktioner. Ændrer på eksisterende tabeller: nye
-- triggere på auctions og andenchance_tilbud (spærringen), nye kolonner
-- (fakturaer.ekstra_fragt_id og ekstra_fragt_runde), CHECK
-- og unikke indeks på fakturaer, flettede CHECK'er på moderation_log.
-- Idempotent (kan køres igen). Én transaktion. KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.forsendelser') is null or to_regclass('public.trades') is null
     or to_regclass('public.betalinger') is null or to_regclass('public.fakturaer') is null
     or to_regclass('public.auctions') is null or to_regclass('public.andenchance_tilbud') is null
     or to_regclass('public.moderation_log') is null then
    raise exception 'Forudsætning mangler: forsendelser, trades, betalinger, fakturaer, auctions, andenchance_tilbud, moderation_log';
  end if;
  if to_regprocedure('public.er_staff()') is null
     or to_regprocedure('public.penge_inhabil(uuid,uuid,uuid)') is null
     or to_regprocedure('public.bidhamr_system_id()') is null
     or to_regprocedure('public.faktura_linje(text,text,bigint)') is null then
    raise exception 'Forudsætning mangler: er_staff, penge_inhabil, bidhamr_system_id, faktura_linje';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'fakturaer' and column_name = 'boost_koeb_id') then
    raise exception 'Forudsætning mangler: fakturaer.boost_koeb_id (20261023030000_boost.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Storage: privat bucket til dokumentationen (kun service role)
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ekstra-fragt-dokumentation', 'ekstra-fragt-dokumentation', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ===========================================================================
-- 2. Tabellen
-- ===========================================================================
create table if not exists public.ekstra_fragt_regninger (
  id                        uuid primary key default gen_random_uuid(),
  trade_id                  uuid not null references public.trades(id) on delete restrict,
  forsendelse_id            uuid not null references public.forsendelser(id) on delete restrict,
  saelger_id                uuid not null references public.users(id) on delete restrict,
  -- Handlens betaling (fakturaen hænger på den, som de øvrige fakturaer).
  betaling_id               uuid not null references public.betalinger(id) on delete restrict,
  transportoer              text,
  sporingsnummer            text,
  -- Den størrelse, sælgeren valgte (forsendelsen), og fragtfirmaets måling.
  valgt_stoerrelse          text not null,
  maalt_stoerrelse          text,
  maalt_vaegt_gram          integer,
  maalt_maal                text,
  -- Låst beløb i øre inkl. moms (forskellen, fragtfirmaet har opkrævet).
  beloeb_oere               bigint not null,
  valuta                    text not null default 'dkk',
  fragtfirma_fakturanummer  text not null,
  -- Til sælgeren (valgfri): fx "DAO målte 7,2 kg".
  forklaring                text,
  dokumentation_sti         text not null,
  dokumentation_type        text not null,
  dokumentation_navn        text,
  status                    text not null default 'afventer_betaling',
  frist                     timestamptz not null,
  oprettet_af               uuid not null references public.users(id) on delete restrict,
  oprettet_kl               timestamptz not null default now(),
  -- Betalingen (spejlet fra Stripe).
  stripe_payment_intent_id  text,
  -- Kasserede PaymentIntents (indsigelse, frafald, annulleret hos Stripe):
  -- betales en alligevel, adopteres den (regningen er stadig skyldig) eller
  -- refunderes som dobbeltbetaling (regningen er betalt/frafaldet).
  tidligere_payment_intents text[] not null default '{}',
  -- En kasseret PaymentIntent, der endnu ikke er annulleret hos Stripe
  -- (serveren gør det med det samme; cron'en tager resten).
  annuller_pi               text,
  pi_forsoeg                integer not null default 0,
  stripe_charge_id          text,
  modtaget_oere             bigint,
  sidste_fejl               text,
  betalt_kl                 timestamptz,
  synket_kl                 timestamptz,
  -- Indsigelse (sælgeren, én gang).
  indsigelse_tekst          text,
  indsigelse_kl             timestamptz,
  -- Staffs afgørelse af indsigelsen (begrundelsen vises for sælgeren).
  afgoerelse                text,
  afgoerelse_begrundelse    text,
  afgjort_kl                timestamptz,
  afgjort_af                uuid references public.users(id) on delete restrict,
  -- Frafald (med eller uden indsigelse; grunden vises for sælgeren).
  frafaldet_kl              timestamptz,
  frafaldet_af              uuid references public.users(id) on delete restrict,
  frafald_grund             text,
  -- Refusion (kun spejlet fra Stripe - BidHamr refunderer ikke selv).
  refunderet_kl             timestamptz,
  stripe_refund_id          text,
  -- Staff.
  kraever_opmaerksomhed     boolean not null default false,
  opmaerksomhed_tekst       text,
  intern_note               text,
  opdateret_kl              timestamptz not null default now(),
  constraint ekstra_fragt_status_check check (
    status in ('afventer_betaling', 'behandles', 'betalt', 'indsigelse', 'frafaldet', 'refunderet')),
  -- Stripes mindstebeløb (DKK 2,50) med margin; højst 10.000 kr.
  constraint ekstra_fragt_beloeb_check check (beloeb_oere between 300 and 1000000),
  constraint ekstra_fragt_valuta_check check (valuta = 'dkk'),
  constraint ekstra_fragt_stoerrelse_check check (
    valgt_stoerrelse in ('lille', 'mellem', 'stor')
    and (maalt_stoerrelse is null or maalt_stoerrelse in ('lille', 'mellem', 'stor', 'over_stor'))
    and (maalt_vaegt_gram is null or maalt_vaegt_gram between 1 and 1000000)
    and (maalt_stoerrelse is not null or maalt_vaegt_gram is not null)),
  constraint ekstra_fragt_afgoerelse_check check (
    (afgoerelse is null or afgoerelse in ('frafaldet', 'fastholdt'))
    and ((afgoerelse is null) = (afgjort_kl is null))
    and (afgoerelse is null or (afgjort_af is not null and afgoerelse_begrundelse is not null and indsigelse_kl is not null))),
  constraint ekstra_fragt_indsigelse_check check ((indsigelse_kl is null) = (indsigelse_tekst is null)),
  constraint ekstra_fragt_betalt_check check (status not in ('betalt', 'refunderet') or betalt_kl is not null),
  constraint ekstra_fragt_frafaldet_check check (
    status <> 'frafaldet' or (frafaldet_kl is not null and frafaldet_af is not null and frafald_grund is not null)),
  constraint ekstra_fragt_refunderet_check check (status <> 'refunderet' or refunderet_kl is not null),
  constraint ekstra_fragt_dokumentation_check check (
    dokumentation_sti ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$'
    and dokumentation_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  constraint ekstra_fragt_tekst_laengde check (
    char_length(fragtfirma_fakturanummer) between 1 and 100
    and coalesce(char_length(maalt_maal), 0) <= 100
    and coalesce(char_length(forklaring), 0) <= 1000
    and coalesce(char_length(dokumentation_navn), 0) <= 200
    and coalesce(char_length(indsigelse_tekst), 0) <= 2000
    and coalesce(char_length(afgoerelse_begrundelse), 0) <= 2000
    and coalesce(char_length(frafald_grund), 0) <= 1000
    and coalesce(char_length(sidste_fejl), 0) <= 500
    and coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000
    and coalesce(char_length(intern_note), 0) <= 4000
    and coalesce(char_length(transportoer), 0) <= 20
    and coalesce(char_length(sporingsnummer), 0) <= 100)
);

comment on table public.ekstra_fragt_regninger is
  'Ekstra fragt ved for lille pakkestørrelse (Filip, 21. okt. 2026; 20261029020000): staff registrerer fragtfirmaets ekstraopkrævning, sælgeren betaler til BidHamrs platformskonto. Aldrig automatisk træk. Én åben pr. forsendelse. Skrives kun af security definer-funktionerne. Staff læser alt; sælgeren kun offentlige felter via mine_ekstra_fragt_regninger(). Handelsdata - slettes aldrig.';
comment on column public.ekstra_fragt_regninger.intern_note is 'Kun staff. Vises aldrig for sælgeren.';

-- Bankindsigelse og genåbning (tilføjet i samme migration - "add column if
-- not exists", så filen også kan køres oven på en tidligere udgave).
alter table public.ekstra_fragt_regninger
  -- Betalingsrunde: 0 første gang, + 1 ved hver genåbning. Fakturaerne
  -- hænger på (regning, runde).
  add column if not exists runde integer not null default 0,
  -- PaymentIntents/charges, hvis betaling er tilbageført efter en tabt
  -- bankindsigelse (regningen er genåbnet). Adopteres aldrig igen.
  add column if not exists tilbagefoerte_payment_intents text[] not null default '{}',
  add column if not exists tilbagefoerte_charges text[] not null default '{}',
  -- Seneste bankindsigelse (chargeback) på regningens charge - spejlet fra Stripe.
  add column if not exists bankindsigelse_id text,
  add column if not exists bankindsigelse_status text,
  add column if not exists bankindsigelse_beloeb_oere bigint,
  -- Sat, når indsigelsen er tabt (admin-lampen). Ryddes ved genåbning.
  add column if not exists bankindsigelse_tabt_kl timestamptz,
  -- Seneste genåbning (staff; begrundelsen vises for sælgeren).
  add column if not exists genaabnet_kl timestamptz,
  add column if not exists genaabnet_af uuid references public.users(id) on delete restrict,
  add column if not exists genaabn_begrundelse text,
  -- Staff har afsluttet den tabte bankindsigelse UDEN genåbning (sælgeren
  -- opkræves ikke igen; lampen slukkes). Intern begrundelse (kun staff).
  add column if not exists bankindsigelse_haandteret_kl timestamptz,
  add column if not exists bankindsigelse_haandteret_af uuid references public.users(id) on delete restrict,
  add column if not exists bankindsigelse_haandteret_begrundelse text;

alter table public.ekstra_fragt_regninger drop constraint if exists ekstra_fragt_genaabn_check;
alter table public.ekstra_fragt_regninger add constraint ekstra_fragt_genaabn_check check (
  runde >= 0
  and ((genaabnet_kl is null) = (genaabnet_af is null))
  and ((genaabnet_kl is null) = (genaabn_begrundelse is null))
  and (runde = 0 or genaabnet_kl is not null)
  and coalesce(char_length(genaabn_begrundelse), 0) <= 1000
  and coalesce(char_length(bankindsigelse_id), 0) <= 100
  and coalesce(char_length(bankindsigelse_status), 0) <= 40
  and (bankindsigelse_tabt_kl is null or bankindsigelse_id is not null)
  and ((bankindsigelse_haandteret_kl is null) = (bankindsigelse_haandteret_af is null))
  and ((bankindsigelse_haandteret_kl is null) = (bankindsigelse_haandteret_begrundelse is null))
  and (bankindsigelse_haandteret_kl is null or bankindsigelse_tabt_kl is not null)
  and coalesce(char_length(bankindsigelse_haandteret_begrundelse), 0) <= 1000);

-- Én åben regning pr. forsendelse.
create unique index if not exists ekstra_fragt_en_aaben
  on public.ekstra_fragt_regninger (forsendelse_id)
  where status in ('afventer_betaling', 'behandles', 'indsigelse');
-- Samme faktura fra fragtfirmaet opkræves aldrig to gange for samme pakke.
create unique index if not exists ekstra_fragt_faktura_en_gang
  on public.ekstra_fragt_regninger (forsendelse_id, lower(fragtfirma_fakturanummer))
  where status <> 'frafaldet';
create unique index if not exists ekstra_fragt_dokumentation_unik
  on public.ekstra_fragt_regninger (dokumentation_sti);
create unique index if not exists ekstra_fragt_pi
  on public.ekstra_fragt_regninger (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists ekstra_fragt_charge on public.ekstra_fragt_regninger (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists ekstra_fragt_saelger on public.ekstra_fragt_regninger (saelger_id, status, frist);
create index if not exists ekstra_fragt_trade on public.ekstra_fragt_regninger (trade_id);
create index if not exists ekstra_fragt_opdateret on public.ekstra_fragt_regninger (opdateret_kl);
create index if not exists ekstra_fragt_tidligere on public.ekstra_fragt_regninger using gin (tidligere_payment_intents);
create index if not exists ekstra_fragt_tilbagefoerte_pi on public.ekstra_fragt_regninger using gin (tilbagefoerte_payment_intents);
create index if not exists ekstra_fragt_tilbagefoerte_charges on public.ekstra_fragt_regninger using gin (tilbagefoerte_charges);
create index if not exists ekstra_fragt_bankindsigelse_tabt on public.ekstra_fragt_regninger (bankindsigelse_tabt_kl)
  where bankindsigelse_tabt_kl is not null;

-- Ingen sletning; faste felter; en indsigelse kan ikke ændres.
create or replace function public.ekstra_fragt_beskyt()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Handelsdata må ikke slettes (ekstra fragt)' using errcode = '42501';
  end if;
  if new.id <> old.id or new.trade_id <> old.trade_id or new.forsendelse_id <> old.forsendelse_id
     or new.saelger_id <> old.saelger_id or new.betaling_id <> old.betaling_id
     or new.beloeb_oere <> old.beloeb_oere or new.valuta <> old.valuta
     or new.valgt_stoerrelse <> old.valgt_stoerrelse
     or new.maalt_stoerrelse is distinct from old.maalt_stoerrelse
     or new.maalt_vaegt_gram is distinct from old.maalt_vaegt_gram
     or new.maalt_maal is distinct from old.maalt_maal
     or new.fragtfirma_fakturanummer <> old.fragtfirma_fakturanummer
     or new.dokumentation_sti <> old.dokumentation_sti or new.dokumentation_type <> old.dokumentation_type
     or new.dokumentation_navn is distinct from old.dokumentation_navn
     or new.oprettet_af <> old.oprettet_af or new.oprettet_kl <> old.oprettet_kl then
    raise exception 'Ekstraregningens beløb, parter og dokumentation kan ikke ændres' using errcode = '42501';
  end if;
  if old.indsigelse_kl is not null and (new.indsigelse_kl is distinct from old.indsigelse_kl
     or new.indsigelse_tekst is distinct from old.indsigelse_tekst) then
    raise exception 'Indsigelsen kan ikke ændres' using errcode = '42501';
  end if;
  -- Runden tæller kun op, og tilbageførte betalinger glemmes aldrig.
  if new.runde < old.runde
     or not (old.tilbagefoerte_payment_intents <@ new.tilbagefoerte_payment_intents)
     or not (old.tilbagefoerte_charges <@ new.tilbagefoerte_charges) then
    raise exception 'Ekstraregningens betalingshistorik kan ikke ændres' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;
revoke all on function public.ekstra_fragt_beskyt() from public, anon, authenticated;
drop trigger if exists ekstra_fragt_beskyt on public.ekstra_fragt_regninger;
create trigger ekstra_fragt_beskyt before update or delete on public.ekstra_fragt_regninger
  for each row execute function public.ekstra_fragt_beskyt();

-- RLS: staff (rolle + aal2) læser alt direkte. Ingen skrivning udefra - heller
-- ikke service role direkte (kun via funktionerne nedenfor).
alter table public.ekstra_fragt_regninger enable row level security;
revoke all on public.ekstra_fragt_regninger from public, anon, authenticated, service_role;
grant select on public.ekstra_fragt_regninger to authenticated, service_role;
drop policy if exists ekstra_fragt_select_staff on public.ekstra_fragt_regninger;
create policy ekstra_fragt_select_staff on public.ekstra_fragt_regninger
  for select to authenticated using ((select public.er_staff()));
-- service role (serveren) læser alt - RLS gælder ikke for service role.

-- ===========================================================================
-- 3. moderation_log: nye handlinger (flettes ind i den nuværende liste)
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_nye  text[] := array[
    'ekstra_fragt_oprettet', 'ekstra_fragt_frafaldet', 'ekstra_fragt_fastholdt',
    'ekstra_fragt_indsigelse', 'ekstra_fragt_betalt', 'ekstra_fragt_note',
    'ekstra_fragt_bankindsigelse_tabt', 'ekstra_fragt_genaabnet', 'ekstra_fragt_bankindsigelse_afsluttet'];
  v_gl   text[];
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is null then
    raise exception 'moderation_log_handling_check findes ikke';
  end if;
  v_gl := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m) s
     where x <> '' order by 1);
  if cardinality(v_gl) = 0 then
    raise exception 'Kunne ikke læse moderation_log_handling_check: %', v_def;
  end if;
  if not (v_nye <@ v_gl) then
    v_vals := array(select distinct x from unnest(v_gl || v_nye) x order by 1);
    alter table public.moderation_log drop constraint moderation_log_handling_check;
    execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
    if not ((v_gl || v_nye) <@ array(
              select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
                from regexp_matches(v_def, '''([^'']+)''', 'g') as m)) then
      raise exception 'moderation_log_handling_check blev ikke flettet korrekt: %', v_def;
    end if;
  end if;

  -- maal_type 'handel' (tilføjet af 20261022010000_returfragt_betaling.sql).
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_maal_type_check';
  if v_def is not null and v_def not like '%''handel''%' and v_def not like '%handel,%' and v_def not like '%,handel}%' then
    v_vals := array(
      select distinct x from (
        select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
          from regexp_matches(v_def, '''([^'']+)''', 'g') as m
        union select 'handel') s
       where x <> '' order by 1);
    alter table public.moderation_log drop constraint moderation_log_maal_type_check;
    execute format('alter table public.moderation_log add constraint moderation_log_maal_type_check check (maal_type = any (%L::text[]))', v_vals);
  end if;
end $do$;

-- ===========================================================================
-- 4. Hjælpere (interne)
-- ===========================================================================
create or replace function public.ekstra_fragt_log(
  p_medarbejder uuid, p_handling text, p_trade uuid, p_saelger uuid, p_tekst text)
returns void
language sql
security definer
set search_path = ''
as $fn$
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, p_handling, 'handel', p_trade, p_saelger, left(coalesce(p_tekst, '-'), 4000));
$fn$;
revoke all on function public.ekstra_fragt_log(uuid, text, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.ekstra_fragt_kr(p_oere bigint)
returns text language sql immutable set search_path = '' as $fn$
  select replace(to_char(p_oere / 100.0, 'FM999999990.00'), '.', ',') || ' kr.';
$fn$;
revoke all on function public.ekstra_fragt_kr(bigint) from public, anon;

-- Fælles tjek for staff: kalderen (auth.uid()) er staff med aal2, regningen
-- findes (låses), og kalderen er ikke inhabil. kode = null ved ok.
create or replace function public.ekstra_fragt_tjek(p_id uuid, out kode text, out r public.ekstra_fragt_regninger)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  t record;
begin
  if auth.uid() is null or not public.er_staff() then
    kode := 'ingen_adgang'; return;
  end if;
  select * into r from public.ekstra_fragt_regninger where id = p_id for update;
  if not found then kode := 'ikke_fundet'; return; end if;
  select buyer_id, seller_id into t from public.trades where id = r.trade_id;
  if public.penge_inhabil(auth.uid(), t.buyer_id, t.seller_id) then
    kode := 'inhabil'; return;
  end if;
  kode := null;
end;
$fn$;
revoke all on function public.ekstra_fragt_tjek(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 5. Spærringen (BHX01)
-- ===========================================================================
-- Spærrer denne regning? Ubetalt ('afventer_betaling') efter fristen. En
-- indsigelse (kun mulig før fristen) spærrer ikke, mens den behandles.
-- Samme regel i ekstra_fragt_spaerret, mine_ekstra_fragt_regninger og
-- min_ekstra_fragt_status. (En tidligere udgave havde en tredje parameter -
-- den fjernes; alle kaldere genskabes nedenfor i samme transaktion.)
drop function if exists public.ekstra_fragt_regning_spaerrer(text, timestamptz, timestamptz);
create or replace function public.ekstra_fragt_regning_spaerrer(p_status text, p_frist timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce(p_status = 'afventer_betaling' and p_frist <= now(), false);
$fn$;
revoke all on function public.ekstra_fragt_regning_spaerrer(text, timestamptz) from public, anon, authenticated;

-- Er sælgeren spærret?
create or replace function public.ekstra_fragt_spaerret(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_bruger is not null and exists (
    select 1 from public.ekstra_fragt_regninger r
     where r.saelger_id = p_bruger and r.status = 'afventer_betaling'
       and public.ekstra_fragt_regning_spaerrer(r.status, r.frist));
$fn$;
revoke all on function public.ekstra_fragt_spaerret(uuid) from public, anon, authenticated;
grant execute on function public.ekstra_fragt_spaerret(uuid) to service_role;

create or replace function public.ekstra_fragt_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then return; end if;
  if public.ekstra_fragt_spaerret(p_bruger) then
    raise exception 'ekstra_fragt_ubetalt: Du har en ubetalt regning for ekstra fragt, og betalingsfristen er overskredet. Betal regningen på handlen under Mine handler, før du kan sætte flere varer til salg eller tilbyde en vare til næste byder.'
      using errcode = 'BHX01';
  end if;
end;
$fn$;
revoke all on function public.ekstra_fragt_kraev(uuid) from public, anon, authenticated;

create or replace function public.auctions_ekstra_fragt()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.ekstra_fragt_kraev(new.bruger_id);
  return new;
end;
$fn$;
revoke all on function public.auctions_ekstra_fragt() from public, anon, authenticated;
drop trigger if exists auctions_a1_ekstra_fragt on public.auctions;
create trigger auctions_a1_ekstra_fragt
  before insert on public.auctions
  for each row execute function public.auctions_ekstra_fragt();

-- "Tilbud til næste byder" er et nyt salg fra samme sælger (som DAC7).
create or replace function public.andenchance_ekstra_fragt()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.ekstra_fragt_kraev(new.seller_id);
  return new;
end;
$fn$;
revoke all on function public.andenchance_ekstra_fragt() from public, anon, authenticated;
drop trigger if exists a1_andenchance_ekstra_fragt on public.andenchance_tilbud;
create trigger a1_andenchance_ekstra_fragt
  before insert on public.andenchance_tilbud
  for each row execute function public.andenchance_ekstra_fragt();

-- ===========================================================================
-- 6. Staff: opret, frafald, afgør indsigelse, note
-- ===========================================================================
-- Opret ekstraregning på en udgående forsendelse. Dokumentationen er uploadet
-- af serveren til <handels-id>/<uuid>.<endelse> i bucket'en først.
-- Koder: ok (+ id, trade_id, saelger_id) | ingen_adgang | ikke_fundet |
-- inhabil | ikke_udgaaende | ikke_sendt | afhentning | ingen_betaling |
-- ugyldigt_beloeb | maaling_mangler | ugyldig_stoerrelse | ugyldig_vaegt |
-- fakturanummer_mangler | for_lang_tekst | dokumentation_mangler |
-- findes_allerede | faktura_brugt
create or replace function public.ekstra_fragt_opret(
  p_forsendelse uuid, p_beloeb_oere bigint, p_maalt_stoerrelse text, p_maalt_vaegt_gram integer,
  p_maalt_maal text, p_fakturanummer text, p_forklaring text,
  p_dokumentation_sti text, p_dokumentation_type text, p_dokumentation_navn text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := auth.uid();
  f      record;
  t      record;
  v_bet  uuid;
  v_id   uuid;
  v_nr   text := nullif(btrim(coalesce(p_fakturanummer, '')), '');
  v_maal text := nullif(btrim(coalesce(p_maalt_maal, '')), '');
  v_fork text := nullif(btrim(coalesce(p_forklaring, '')), '');
  v_navn text := nullif(left(btrim(coalesce(p_dokumentation_navn, '')), 200), '');
  v_ms   text := nullif(btrim(coalesce(p_maalt_stoerrelse, '')), '');
begin
  if v_uid is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_forsendelse is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select fo.id, fo.trade_id, fo.type, fo.status, fo.pakkestoerrelse, fo.sporingsnummer,
         coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) as transportoer
    into f
    from public.forsendelser fo where fo.id = p_forsendelse for update;
  if f.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.type <> 'udgaaende' then return jsonb_build_object('kode', 'ikke_udgaaende'); end if;
  if f.status in ('opretter', 'fejlet') then return jsonb_build_object('kode', 'ikke_sendt'); end if;

  select tr.id, tr.buyer_id, tr.seller_id, tr.afhentning into t from public.trades tr where tr.id = f.trade_id;
  if t.id is null or t.seller_id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.penge_inhabil(v_uid, t.buyer_id, t.seller_id) then return jsonb_build_object('kode', 'inhabil'); end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;

  select b.id into v_bet from public.betalinger b
   where b.trade_id = t.id and b.betalt_kl is not null order by b.betalt_kl desc limit 1;
  if v_bet is null then return jsonb_build_object('kode', 'ingen_betaling'); end if;

  if p_beloeb_oere is null or p_beloeb_oere < 300 or p_beloeb_oere > 1000000 then
    return jsonb_build_object('kode', 'ugyldigt_beloeb', 'min_oere', 300, 'maks_oere', 1000000);
  end if;
  if v_ms is null and p_maalt_vaegt_gram is null then return jsonb_build_object('kode', 'maaling_mangler'); end if;
  if v_ms is not null and v_ms not in ('lille', 'mellem', 'stor', 'over_stor') then
    return jsonb_build_object('kode', 'ugyldig_stoerrelse');
  end if;
  if p_maalt_vaegt_gram is not null and (p_maalt_vaegt_gram < 1 or p_maalt_vaegt_gram > 1000000) then
    return jsonb_build_object('kode', 'ugyldig_vaegt');
  end if;
  if v_nr is null then return jsonb_build_object('kode', 'fakturanummer_mangler'); end if;
  if char_length(v_nr) > 100 or char_length(coalesce(v_maal, '')) > 100 or char_length(coalesce(v_fork, '')) > 1000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  -- Dokumentationen: rigtig sti for handlen, tilladt type, filen findes, og
  -- dens filtype i Storage (sat ved uploaden) er den angivne (HEIC/HEIF er
  -- samme format).
  if p_dokumentation_sti is null
     or p_dokumentation_sti !~ ('^' || t.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$')
     or p_dokumentation_type is null
     or p_dokumentation_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'ekstra-fragt-dokumentation' and o.name = p_dokumentation_sti
                       and (lower(o.metadata->>'mimetype') = p_dokumentation_type
                            or (p_dokumentation_type in ('image/heic', 'image/heif')
                                and lower(o.metadata->>'mimetype') in ('image/heic', 'image/heif')))) then
    return jsonb_build_object('kode', 'dokumentation_mangler');
  end if;

  if exists (select 1 from public.ekstra_fragt_regninger x
              where x.forsendelse_id = f.id and x.status in ('afventer_betaling', 'behandles', 'indsigelse')) then
    return jsonb_build_object('kode', 'findes_allerede');
  end if;
  if exists (select 1 from public.ekstra_fragt_regninger x
              where x.forsendelse_id = f.id and lower(x.fragtfirma_fakturanummer) = lower(v_nr)
                and x.status <> 'frafaldet') then
    return jsonb_build_object('kode', 'faktura_brugt');
  end if;
  if exists (select 1 from public.ekstra_fragt_regninger x where x.dokumentation_sti = p_dokumentation_sti) then
    return jsonb_build_object('kode', 'dokumentation_mangler');
  end if;

  insert into public.ekstra_fragt_regninger (
    trade_id, forsendelse_id, saelger_id, betaling_id, transportoer, sporingsnummer,
    valgt_stoerrelse, maalt_stoerrelse, maalt_vaegt_gram, maalt_maal, beloeb_oere,
    fragtfirma_fakturanummer, forklaring, dokumentation_sti, dokumentation_type, dokumentation_navn,
    frist, oprettet_af)
  values (
    t.id, f.id, t.seller_id, v_bet, left(f.transportoer, 20), left(f.sporingsnummer, 100),
    f.pakkestoerrelse, v_ms, p_maalt_vaegt_gram, v_maal, p_beloeb_oere,
    v_nr, v_fork, p_dokumentation_sti, p_dokumentation_type, v_navn,
    now() + interval '14 days', v_uid)
  returning id into v_id;

  perform public.ekstra_fragt_log(v_uid, 'ekstra_fragt_oprettet', t.id, t.seller_id,
    'Ekstraregning ' || public.ekstra_fragt_kr(p_beloeb_oere) || ' (valgt ' || f.pakkestoerrelse
    || coalesce(', målt ' || v_ms, '') || coalesce(', ' || p_maalt_vaegt_gram || ' g', '')
    || ') | Fragtfirmaets faktura: ' || v_nr);
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'trade_id', t.id, 'saelger_id', t.seller_id);
end;
$fn$;

-- Frafald (grund vises for sælgeren). Fra afventer_betaling eller indsigelse.
-- En åben PaymentIntent kasseres (annuller_pi) - serveren annullerer den hos
-- Stripe. Svar ved ok: {kode, annuller_pi?, trade_id, saelger_id}.
-- Koder: + grund_mangler | for_lang_tekst | behandles | forkert_status (+ status)
create or replace function public.ekstra_fragt_frafald(p_id uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c       record;
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  select * into c from public.ekstra_fragt_tjek(p_id);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status = 'behandles' then return jsonb_build_object('kode', 'behandles'); end if;
  if (c.r).status not in ('afventer_betaling', 'indsigelse') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  update public.ekstra_fragt_regninger
     set status = 'frafaldet', frafaldet_kl = now(), frafaldet_af = auth.uid(), frafald_grund = v_grund,
         -- Under indsigelse er frafaldet også afgørelsen.
         afgoerelse = case when status = 'indsigelse' then 'frafaldet' else afgoerelse end,
         afgoerelse_begrundelse = case when status = 'indsigelse' then v_grund else afgoerelse_begrundelse end,
         afgjort_kl = case when status = 'indsigelse' then now() else afgjort_kl end,
         afgjort_af = case when status = 'indsigelse' then auth.uid() else afgjort_af end,
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         annuller_pi = coalesce(stripe_payment_intent_id, annuller_pi),
         -- Ny idempotency key, hvis regningen senere skal betales (genåbning).
         pi_forsoeg = pi_forsoeg + case when stripe_payment_intent_id is null then 0 else 1 end,
         stripe_payment_intent_id = null
   where id = (c.r).id and status in ('afventer_betaling', 'indsigelse');
  perform public.ekstra_fragt_log(auth.uid(), 'ekstra_fragt_frafaldet', (c.r).trade_id, (c.r).saelger_id,
    'Ekstraregning ' || public.ekstra_fragt_kr((c.r).beloeb_oere) || ' frafaldet (status var ' || (c.r).status
    || ') | Til sælgeren: ' || v_grund);
  return jsonb_build_object('kode', 'ok', 'annuller_pi', (c.r).stripe_payment_intent_id,
                            'trade_id', (c.r).trade_id, 'saelger_id', (c.r).saelger_id);
end;
$fn$;

-- Afgør sælgerens indsigelse: p_udfald 'frafald' | 'fasthold'. Begrundelsen
-- vises for sælgeren. Fastholdt: tilbage til afventer_betaling, og fristen er
-- mindst 7 dage fra nu. Koder: + ugyldigt_udfald | begrundelse_mangler |
-- for_lang_tekst | forkert_status (+ status)
create or replace function public.ekstra_fragt_afgoer_indsigelse(p_id uuid, p_udfald text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c     record;
  v_beg text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_frist timestamptz;
begin
  select * into c from public.ekstra_fragt_tjek(p_id);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if p_udfald is null or p_udfald not in ('frafald', 'fasthold') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status <> 'indsigelse' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if p_udfald = 'frafald' then
    return public.ekstra_fragt_frafald(p_id, v_beg);
  end if;
  v_frist := greatest((c.r).frist, now() + interval '7 days');
  update public.ekstra_fragt_regninger
     set status = 'afventer_betaling', afgoerelse = 'fastholdt', afgoerelse_begrundelse = v_beg,
         afgjort_kl = now(), afgjort_af = auth.uid(), frist = v_frist
   where id = (c.r).id and status = 'indsigelse';
  perform public.ekstra_fragt_log(auth.uid(), 'ekstra_fragt_fastholdt', (c.r).trade_id, (c.r).saelger_id,
    'Indsigelsen er afvist - ekstraregningen (' || public.ekstra_fragt_kr((c.r).beloeb_oere)
    || ') er fastholdt. Ny frist ' || to_char(v_frist at time zone 'Europe/Copenhagen', 'DD-MM-YYYY')
    || ' | Til sælgeren: ' || v_beg);
  return jsonb_build_object('kode', 'ok', 'frist', v_frist, 'trade_id', (c.r).trade_id, 'saelger_id', (c.r).saelger_id);
end;
$fn$;

-- Intern note (erstatter den forrige; tom tekst rydder). Kun staff ser den.
create or replace function public.ekstra_fragt_gem_note(p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c      record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into c from public.ekstra_fragt_tjek(p_id);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_note is not null and char_length(v_note) > 4000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).intern_note is not distinct from v_note then return jsonb_build_object('kode', 'ok', 'uaendret', true); end if;
  update public.ekstra_fragt_regninger set intern_note = v_note where id = (c.r).id;
  perform public.ekstra_fragt_log(auth.uid(), 'ekstra_fragt_note', (c.r).trade_id, (c.r).saelger_id,
    'Intern note: ' || coalesce(v_note, '(ryddet)'));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Genåbn en BETALT regning, hvis betaling er tilbageført efter en TABT
-- bankindsigelse (Filip, 21. okt. 2026: kun staff - aldrig automatisk).
-- Begrundelsen vises for sælgeren. Kreditnotaen for den tilbageførte betaling
-- er allerede lavet, da den tabte indsigelse blev registreret
-- (ekstra_fragt_registrer_bankindsigelse) - her sikres kun, at den findes
-- (idempotent: aldrig en kreditnota mere). I én transaktion: regningen sættes
-- til afventer_betaling, frist 14 dage, runde + 1, den tilbageførte
-- PaymentIntent/charge flyttes til tilbagefoerte_* (adopteres aldrig igen),
-- pi_forsoeg + 1 (ny idempotency key), betalingsfelterne og markeringen
-- ryddes. Betaler sælgeren igen, laver fakturakøen rundens nye faktura.
-- En regning kan altid genåbnes - også efter "Afslut uden genåbning" (Filip,
-- 21. okt. 2026); afslutningen ryddes så (historikken står i moderation_log).
-- Svar ved ok: {kode, frist, runde, trade_id, saelger_id}.
-- Koder: + begrundelse_mangler | for_lang_tekst | forkert_status (+ status) |
-- ingen_tabt_bankindsigelse | delvis_bankindsigelse | findes_allerede
create or replace function public.ekstra_fragt_genaabn(p_regning uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c       record;
  v_beg   text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_frist timestamptz := now() + interval '14 days';
begin
  select * into c from public.ekstra_fragt_tjek(p_regning);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status <> 'betalt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).bankindsigelse_tabt_kl is null or (c.r).stripe_charge_id is null then
    return jsonb_build_object('kode', 'ingen_tabt_bankindsigelse');
  end if;
  -- Kun en tilbageførsel af hele det modtagne beløb (en delvis håndteres manuelt).
  if (c.r).bankindsigelse_beloeb_oere is distinct from coalesce((c.r).modtaget_oere, (c.r).beloeb_oere) then
    return jsonb_build_object('kode', 'delvis_bankindsigelse');
  end if;
  if exists (select 1 from public.ekstra_fragt_regninger x
              where x.forsendelse_id = (c.r).forsendelse_id and x.id <> (c.r).id
                and x.status in ('afventer_betaling', 'behandles', 'indsigelse')) then
    return jsonb_build_object('kode', 'findes_allerede');
  end if;

  -- Rundens kreditnota er lavet ved tabet; findes den ikke (fx en regning
  -- markeret før denne udgave), laves den nu. Aldrig to.
  if public.ekstra_fragt_bankindsigelse_kreditnota((c.r).id) is null then
    raise exception 'Kreditnotaen for den tilbageførte betaling kunne ikke laves (%)', (c.r).id;
  end if;

  -- Regningen åbnes igen (ny runde).
  update public.ekstra_fragt_regninger
     set status = 'afventer_betaling', frist = v_frist, runde = runde + 1,
         genaabnet_kl = now(), genaabnet_af = auth.uid(), genaabn_begrundelse = v_beg,
         tilbagefoerte_payment_intents = case when stripe_payment_intent_id is null then tilbagefoerte_payment_intents
                                              else array_append(tilbagefoerte_payment_intents, stripe_payment_intent_id) end,
         tilbagefoerte_charges = array_append(tilbagefoerte_charges, stripe_charge_id),
         stripe_payment_intent_id = null, stripe_charge_id = null,
         pi_forsoeg = pi_forsoeg + 1,
         betalt_kl = null, modtaget_oere = null, sidste_fejl = null, synket_kl = null,
         bankindsigelse_id = null, bankindsigelse_status = null, bankindsigelse_beloeb_oere = null,
         bankindsigelse_tabt_kl = null,
         bankindsigelse_haandteret_kl = null, bankindsigelse_haandteret_af = null,
         bankindsigelse_haandteret_begrundelse = null
   where id = (c.r).id and status = 'betalt';
  if not found then raise exception 'Ekstraregningen blev ændret under genåbningen (%)', (c.r).id; end if;

  perform public.ekstra_fragt_log(auth.uid(), 'ekstra_fragt_genaabnet', (c.r).trade_id, (c.r).saelger_id,
    'Ekstraregningen (' || public.ekstra_fragt_kr((c.r).beloeb_oere) || ') er genåbnet efter en tabt bankindsigelse ('
    || (c.r).bankindsigelse_id || '). Runde ' || (c.r).runde || ' er krediteret, ny frist '
    || to_char(v_frist at time zone 'Europe/Copenhagen', 'DD-MM-YYYY') || ' | Til sælgeren: ' || v_beg);
  return jsonb_build_object('kode', 'ok', 'frist', v_frist, 'runde', (c.r).runde + 1,
                            'trade_id', (c.r).trade_id, 'saelger_id', (c.r).saelger_id);
end;
$fn$;

-- Afslut en tabt bankindsigelse UDEN genåbning (staff): regningen forbliver
-- lukket (betalt - betalingen er tilbageført og krediteret ved tabet), sælgeren
-- opkræves ikke igen, og admin-lampen slukkes. Begrundelsen er intern (kun
-- staff). Kreditnotaen sikres (idempotent - laves kun, hvis den mangler).
-- Svar ved ok: {kode, trade_id, saelger_id} (+ uaendret, hvis allerede afsluttet).
-- Koder: + begrundelse_mangler | for_lang_tekst | forkert_status (+ status) |
-- ingen_tabt_bankindsigelse
create or replace function public.ekstra_fragt_bankindsigelse_afslut(p_regning uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c     record;
  v_beg text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  select * into c from public.ekstra_fragt_tjek(p_regning);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status <> 'betalt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).bankindsigelse_tabt_kl is null then
    return jsonb_build_object('kode', 'ingen_tabt_bankindsigelse');
  end if;
  if (c.r).bankindsigelse_haandteret_kl is not null then
    return jsonb_build_object('kode', 'ok', 'uaendret', true,
                              'trade_id', (c.r).trade_id, 'saelger_id', (c.r).saelger_id);
  end if;
  if public.ekstra_fragt_bankindsigelse_kreditnota((c.r).id) is null then
    raise exception 'Kreditnotaen for den tilbageførte betaling kunne ikke laves (%)', (c.r).id;
  end if;
  update public.ekstra_fragt_regninger
     set bankindsigelse_haandteret_kl = now(), bankindsigelse_haandteret_af = auth.uid(),
         bankindsigelse_haandteret_begrundelse = v_beg
   where id = (c.r).id and status = 'betalt' and bankindsigelse_haandteret_kl is null;
  if not found then raise exception 'Ekstraregningen blev ændret under afslutningen (%)', (c.r).id; end if;
  perform public.ekstra_fragt_log(auth.uid(), 'ekstra_fragt_bankindsigelse_afsluttet', (c.r).trade_id, (c.r).saelger_id,
    'Tabt bankindsigelse ' || (c.r).bankindsigelse_id || ' på ekstraregningen ('
    || public.ekstra_fragt_kr((c.r).beloeb_oere) || ') er afsluttet uden genåbning - sælgeren opkræves ikke igen. Begrundelse: '
    || v_beg);
  return jsonb_build_object('kode', 'ok', 'trade_id', (c.r).trade_id, 'saelger_id', (c.r).saelger_id);
end;
$fn$;

-- Dokumentationens sti til staff (serveren laver et signeret link).
create or replace function public.ekstra_fragt_dokumentation_staff(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  r record;
begin
  if auth.uid() is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  select x.dokumentation_sti, x.dokumentation_type, x.dokumentation_navn into r
    from public.ekstra_fragt_regninger x where x.id = p_id;
  if r.dokumentation_sti is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  return jsonb_build_object('kode', 'ok', 'sti', r.dokumentation_sti, 'type', r.dokumentation_type,
                            'navn', r.dokumentation_navn);
end;
$fn$;

-- Admin-lampe (alle staff). Ikke-staff: alt 0.
create or replace function public.ekstra_fragt_antal()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  -- tabte_bankindsigelser: betalte regninger, hvor betalingen er tilbageført
  -- efter en tabt bankindsigelse, og som staff ikke har håndteret endnu
  -- (genåbn eller afslut uden genåbning).
  select case when not public.er_staff() then
           jsonb_build_object('afventer_betaling', 0, 'forfaldne', 0, 'indsigelser', 0, 'kraever_opmaerksomhed', 0,
                              'tabte_bankindsigelser', 0)
         else jsonb_build_object(
           'afventer_betaling', (select count(*) from public.ekstra_fragt_regninger where status = 'afventer_betaling'),
           'forfaldne', (select count(*) from public.ekstra_fragt_regninger
                          where status = 'afventer_betaling' and frist <= now()),
           'indsigelser', (select count(*) from public.ekstra_fragt_regninger where status = 'indsigelse'),
           'kraever_opmaerksomhed', (select count(*) from public.ekstra_fragt_regninger where kraever_opmaerksomhed),
           'tabte_bankindsigelser', (select count(*) from public.ekstra_fragt_regninger
                                      where bankindsigelse_tabt_kl is not null and status = 'betalt'
                                        and bankindsigelse_haandteret_kl is null))
         end;
$fn$;

-- ===========================================================================
-- 7. Sælgeren: indsigelse, visning, dokumentation, status
-- ===========================================================================
-- Indsigelse mod målingen (ÉN gang, kun mens regningen afventer betaling, og
-- kun FØR fristen - Filip, 21. okt. 2026). Efter fristen: 'frist_overskredet'
-- (sælgeren kontakter BidHamr; staff kan frafalde regningen).
-- En åben PaymentIntent kasseres (annuller_pi) - serveren annullerer den.
-- Koder: ok (+ annuller_pi?) | ingen_adgang | ikke_fundet | tekst_mangler |
-- for_kort | for_lang_tekst | allerede_indsigelse | behandles | forkert_status |
-- frist_overskredet
create or replace function public.mit_ekstra_fragt_indsigelse(p_id uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  r       record;
  v_tekst text := nullif(btrim(coalesce(p_tekst, '')), '');
begin
  if v_uid is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  select * into r from public.ekstra_fragt_regninger where id = p_id for update;
  -- Samme svar, uanset om den ikke findes eller ikke er din.
  if r.id is null or r.saelger_id <> v_uid then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_tekst is null then return jsonb_build_object('kode', 'tekst_mangler'); end if;
  if char_length(v_tekst) < 10 then return jsonb_build_object('kode', 'for_kort'); end if;
  if char_length(v_tekst) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if r.indsigelse_kl is not null then return jsonb_build_object('kode', 'allerede_indsigelse'); end if;
  if r.status = 'behandles' then return jsonb_build_object('kode', 'behandles'); end if;
  if r.status <> 'afventer_betaling' then
    return jsonb_build_object('kode', 'forkert_status', 'status', r.status);
  end if;
  if r.frist <= now() then return jsonb_build_object('kode', 'frist_overskredet'); end if;
  update public.ekstra_fragt_regninger
     set status = 'indsigelse', indsigelse_tekst = v_tekst, indsigelse_kl = now(),
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         annuller_pi = coalesce(stripe_payment_intent_id, annuller_pi),
         -- Fastholdes regningen, laves en ny PaymentIntent med en ny
         -- idempotency key (den kasserede er annulleret hos Stripe).
         pi_forsoeg = pi_forsoeg + case when stripe_payment_intent_id is null then 0 else 1 end,
         stripe_payment_intent_id = null
   where id = r.id and status = 'afventer_betaling';
  perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_indsigelse', r.trade_id, r.saelger_id,
    'Sælgeren har gjort indsigelse mod ekstraregningen (' || public.ekstra_fragt_kr(r.beloeb_oere) || '): ' || v_tekst);
  return jsonb_build_object('kode', 'ok', 'annuller_pi', r.stripe_payment_intent_id);
end;
$fn$;

-- Sælgerens egne regninger (offentlige felter). p_trade = null: alle.
-- spaerrer: regningen spærrer lige nu (ubetalt efter fristen).
-- kan_goere_indsigelse: kun før fristen og kun én gang.
-- genaabnet_kl/genaabn_begrundelse: regningen er åbnet igen, fordi betalingen
-- blev tilbageført efter en bankindsigelse.
-- (Returtypen er udvidet - derfor drop først, så filen kan køres igen.)
drop function if exists public.mine_ekstra_fragt_regninger(uuid);
create function public.mine_ekstra_fragt_regninger(p_trade uuid default null)
returns table (
  id uuid, trade_id uuid, forsendelse_id uuid, titel text, transportoer text, sporingsnummer text,
  valgt_stoerrelse text, maalt_stoerrelse text, maalt_vaegt_gram integer, maalt_maal text,
  beloeb_oere bigint, fragtfirma_fakturanummer text, forklaring text, har_dokumentation boolean,
  status text, frist timestamptz, spaerrer boolean, kan_betale boolean, kan_goere_indsigelse boolean,
  indsigelse_tekst text, indsigelse_kl timestamptz, afgoerelse text, afgoerelse_begrundelse text,
  afgjort_kl timestamptz, frafald_grund text, frafaldet_kl timestamptz, betalt_kl timestamptz,
  refunderet_kl timestamptz, oprettet_kl timestamptz,
  genaabnet_kl timestamptz, genaabn_begrundelse text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.id, r.trade_id, r.forsendelse_id, a.titel, r.transportoer, r.sporingsnummer,
         r.valgt_stoerrelse, r.maalt_stoerrelse, r.maalt_vaegt_gram, r.maalt_maal,
         r.beloeb_oere, r.fragtfirma_fakturanummer, r.forklaring, true,
         r.status, r.frist, public.ekstra_fragt_regning_spaerrer(r.status, r.frist),
         r.status = 'afventer_betaling',
         r.status = 'afventer_betaling' and r.indsigelse_kl is null and r.frist > now(),
         r.indsigelse_tekst, r.indsigelse_kl, r.afgoerelse, r.afgoerelse_begrundelse,
         r.afgjort_kl, r.frafald_grund, r.frafaldet_kl, r.betalt_kl, r.refunderet_kl, r.oprettet_kl,
         r.genaabnet_kl, r.genaabn_begrundelse
    from public.ekstra_fragt_regninger r
    left join public.trades t on t.id = r.trade_id
    left join public.auctions a on a.id = t.auction_id
   where auth.uid() is not null
     and r.saelger_id = auth.uid()
     and (p_trade is null or r.trade_id = p_trade)
   order by r.oprettet_kl desc
   limit 200;
$fn$;

-- Dokumentationens sti til sælgeren selv (serveren laver et signeret link).
create or replace function public.min_ekstra_fragt_dokumentation(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when x.id is null then jsonb_build_object('kode', 'ikke_fundet')
              else jsonb_build_object('kode', 'ok', 'sti', x.dokumentation_sti, 'type', x.dokumentation_type,
                                      'navn', x.dokumentation_navn) end
    from (select 1) d
    left join public.ekstra_fragt_regninger x
      on x.id = p_id and auth.uid() is not null and x.saelger_id = auth.uid();
$fn$;

-- Sælgerens status (fx til "Opret auktion"): spærret, og hvad der skyldes.
create or replace function public.min_ekstra_fragt_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'spaerret', coalesce(bool_or(public.ekstra_fragt_regning_spaerrer(r.status, r.frist)), false),
    'ubetalte', count(*) filter (where r.status in ('afventer_betaling', 'behandles')),
    'ubetalt_oere', coalesce(sum(r.beloeb_oere) filter (where r.status in ('afventer_betaling', 'behandles')), 0),
    'indsigelser', count(*) filter (where r.status = 'indsigelse'),
    'naeste_frist', min(r.frist) filter (where r.status = 'afventer_betaling'))
    from public.ekstra_fragt_regninger r
   where auth.uid() is not null and r.saelger_id = auth.uid()
     and r.status in ('afventer_betaling', 'behandles', 'indsigelse');
$fn$;

-- ===========================================================================
-- 8. Betalingen (service role - p_saelger SKAL være verificeret af serveren)
-- ===========================================================================
-- Svar: {kode: 'ok', id, beloeb_oere, pi, pi_forsoeg} | {kode: 'betalt'} |
-- {kode: 'behandles' | 'indsigelse' | 'frafaldet' | 'refunderet' | 'ikke_fundet' | 'ugyldig'}
create or replace function public.ekstra_fragt_betal_start(p_id uuid, p_saelger uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r record;
begin
  if p_id is null or p_saelger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select x.id, x.saelger_id, x.status, x.beloeb_oere, x.stripe_payment_intent_id, x.pi_forsoeg into r
    from public.ekstra_fragt_regninger x where x.id = p_id for update;
  if r.id is null or r.saelger_id <> p_saelger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if r.status <> 'afventer_betaling' then return jsonb_build_object('kode', r.status, 'id', r.id); end if;
  return jsonb_build_object('kode', 'ok', 'id', r.id, 'beloeb_oere', r.beloeb_oere,
                            'pi', r.stripe_payment_intent_id, 'pi_forsoeg', r.pi_forsoeg);
end;
$fn$;

-- PaymentIntenten gemmes kun, hvis regningen stadig afventer betaling med
-- samme forsøg og uden PaymentIntent.
create or replace function public.ekstra_fragt_gem_pi(p_id uuid, p_pi text, p_forsoeg integer)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_pi is null or p_pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then return false; end if;
  update public.ekstra_fragt_regninger
     set stripe_payment_intent_id = p_pi
   where id = p_id and stripe_payment_intent_id is null and pi_forsoeg = p_forsoeg and status = 'afventer_betaling';
  return found;
end;
$fn$;

-- En PaymentIntent, der er annulleret hos Stripe, kasseres (pi_forsoeg + 1).
create or replace function public.ekstra_fragt_nulstil_pi(p_id uuid, p_pi text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.ekstra_fragt_regninger
     set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
         stripe_payment_intent_id = null,
         pi_forsoeg = pi_forsoeg + 1
   where id = p_id and stripe_payment_intent_id = p_pi and status = 'afventer_betaling';
  return found;
end;
$fn$;

-- Den kasserede PaymentIntent er annulleret hos Stripe (eller kan ikke
-- annulleres, fordi den er betalt/annulleret): ryd annuller_pi.
create or replace function public.ekstra_fragt_pi_annulleret(p_id uuid, p_pi text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.ekstra_fragt_regninger set annuller_pi = null
   where id = p_id and annuller_pi = p_pi;
  return found;
end;
$fn$;

-- Spejl fra Stripe (webhooken og cron'en). p_status = PaymentIntentens status.
-- Svar {kode, id?, annuller_pi?}:
--   'betalt'          registreret nu (også en adopteret kasseret PaymentIntent)
--   'beloeb_afviger'  betalt med et andet beløb: registreret som betalt og
--                     markeret til staff (fakturaen kræver handling)
--   'allerede'        var allerede registreret
--   'kasseret'        en kasseret PaymentIntent er betalt, men regningen er
--                     betalt/frafaldet/refunderet: refunderes af koden
--   'tilbagefoert'    PaymentIntenten er tilbageført efter en tabt
--                     bankindsigelse (regningen er genåbnet) - intet sker
--   'behandles' | 'afventer' | 'nulstillet' | 'uaendret' | 'ukendt'
create or replace function public.ekstra_fragt_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  r      record;
  v_gl   text;
  v_note text;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  select x.id, x.status, x.beloeb_oere, x.stripe_payment_intent_id, x.trade_id, x.saelger_id into r
    from public.ekstra_fragt_regninger x where x.stripe_payment_intent_id = p_pi for update;

  if r.id is null then
    -- Tilbageført efter en tabt bankindsigelse (regningen er genåbnet): den
    -- betaling tæller aldrig igen - heller ikke ved et gentaget event.
    select x.id into r from public.ekstra_fragt_regninger x
     where x.tilbagefoerte_payment_intents @> array[p_pi] limit 1;
    if r.id is not null then return jsonb_build_object('kode', 'tilbagefoert', 'id', r.id); end if;
    select x.id, x.status, x.beloeb_oere, x.stripe_payment_intent_id, x.trade_id, x.saelger_id into r
      from public.ekstra_fragt_regninger x where x.tidligere_payment_intents @> array[p_pi] limit 1 for update;
    if r.id is null then return jsonb_build_object('kode', 'ukendt'); end if;
    if p_status <> 'succeeded' then return jsonb_build_object('kode', 'uaendret', 'id', r.id); end if;
    -- Regningen skyldes stadig (og beløbet passer): betalingen adopteres, så
    -- sælgeren aldrig betaler to gange og aldrig får en skyldig regning
    -- refunderet. En evt. nyere åben PaymentIntent kasseres og annulleres.
    if r.status in ('afventer_betaling', 'behandles', 'indsigelse') and p_beloeb is not distinct from r.beloeb_oere then
      v_gl := r.stripe_payment_intent_id;
      v_note := case when r.status = 'indsigelse'
                     then 'Sælgeren har betalt ekstraregningen, mens indsigelsen var åben - indsigelsen er bortfaldet.' end;
      update public.ekstra_fragt_regninger
         set stripe_payment_intent_id = p_pi,
             tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi)
                                         || case when v_gl is null then '{}'::text[] else array[v_gl] end,
             annuller_pi = case when v_gl is not null then v_gl
                                when annuller_pi = p_pi then null else annuller_pi end,
             status = 'betalt', betalt_kl = coalesce(betalt_kl, now()),
             stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb, sidste_fejl = null,
             kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
             opmaerksomhed_tekst = case when v_note is null then opmaerksomhed_tekst
                                        else left(concat_ws(E'\n', opmaerksomhed_tekst, v_note), 4000) end
       where id = r.id;
      perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_betalt', r.trade_id, r.saelger_id,
        'Sælgeren har betalt ekstraregningen (' || public.ekstra_fragt_kr(p_beloeb) || ', PaymentIntent ' || p_pi || ')');
      return jsonb_build_object('kode', 'betalt', 'id', r.id, 'annuller_pi', v_gl);
    end if;
    return jsonb_build_object('kode', 'kasseret', 'id', r.id);
  end if;

  if p_status = 'succeeded' then
    if r.status in ('betalt', 'refunderet') then return jsonb_build_object('kode', 'allerede', 'id', r.id); end if;
    if r.status not in ('afventer_betaling', 'behandles') then
      return jsonb_build_object('kode', 'kasseret', 'id', r.id);
    end if;
    v_note := case when p_beloeb is distinct from r.beloeb_oere
                   then 'Ekstraregningen er betalt med et andet beløb end regningen - kontrollér betalingen i Stripe.' end;
    update public.ekstra_fragt_regninger
       set status = 'betalt', betalt_kl = coalesce(betalt_kl, now()), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, sidste_fejl = null,
           kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
           opmaerksomhed_tekst = case when v_note is null then opmaerksomhed_tekst
                                      else left(concat_ws(E'\n', opmaerksomhed_tekst, v_note), 4000) end
     where id = r.id;
    perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_betalt', r.trade_id, r.saelger_id,
      'Sælgeren har betalt ekstraregningen (' || public.ekstra_fragt_kr(coalesce(p_beloeb, 0)) || ', PaymentIntent ' || p_pi || ')');
    return jsonb_build_object('kode', case when v_note is null then 'betalt' else 'beloeb_afviger' end, 'id', r.id);
  elsif p_status = 'processing' then
    update public.ekstra_fragt_regninger set status = 'behandles' where id = r.id and status = 'afventer_betaling';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', r.id);
  elsif p_status = 'requires_payment_method' then
    update public.ekstra_fragt_regninger set status = 'afventer_betaling', sidste_fejl = left(p_fejl, 500)
     where id = r.id and status in ('afventer_betaling', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', r.id);
  elsif p_status = 'canceled' then
    update public.ekstra_fragt_regninger
       set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
           stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1,
           status = 'afventer_betaling'
     where id = r.id and status in ('afventer_betaling', 'behandles');
    return jsonb_build_object('kode', case when found then 'nulstillet' else 'uaendret' end, 'id', r.id);
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', r.id);
end;
$fn$;

-- charge.refunded på regningens charge (fx en refusion i Stripe-dashboardet -
-- BidHamr refunderer ikke selv). Fuld: 'refunderet' (+ staff markeres).
-- Delvis: kun staff. 'refunderet' | 'allerede' | 'markeret' | 'ukendt'
create or replace function public.ekstra_fragt_registrer_charge_refusion(p_charge text, p_refund text, p_fuld boolean)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
begin
  select x.id, x.status into r from public.ekstra_fragt_regninger x where x.stripe_charge_id = p_charge for update;
  if r.id is null then return 'ukendt'; end if;
  if r.status = 'refunderet' then return 'allerede'; end if;
  if r.status <> 'betalt' then return 'ukendt'; end if;
  if not p_fuld then
    update public.ekstra_fragt_regninger
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Ekstraregningen er delvist refunderet hos Stripe uden om BidHamr - kontrollér den.'), 4000)
     where id = r.id;
    return 'markeret';
  end if;
  update public.ekstra_fragt_regninger
     set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
           'Ekstraregningen er refunderet hos Stripe (uden om BidHamr) - fakturaen krediteres automatisk.'), 4000)
   where id = r.id;
  return 'refunderet';
end;
$fn$;

-- Bankindsigelse (chargeback) på regningens charge - spejlet fra Stripe
-- (webhooken, charge.dispute.*). p_status = disputens status, p_beloeb =
-- disputens beløb (øre). Idempotent. En tabt indsigelse markeres
-- (bankindsigelse_tabt_kl) og overskrives ikke af en senere status, og i samme
-- transaktion laves kreditnotaen for rundens faktura (dateret på tabsdagen,
-- reference = indsigelsens id; aldrig to - ekstra_fragt_bankindsigelse_kreditnota).
-- Regningen genåbnes ALDRIG her (staff: ekstra_fragt_genaabn eller
-- ekstra_fragt_bankindsigelse_afslut).
-- Svar {kode, id?, status?, kreditnota_id?}: 'tabt' (markeret nu) | 'allerede' (var markeret) |
-- 'registreret' (åben/vundet indsigelse) | 'genaabnet' (chargen er allerede
-- tilbageført og regningen genåbnet) | 'ukendt' | 'ugyldig'
create or replace function public.ekstra_fragt_registrer_bankindsigelse(
  p_charge text, p_dispute text, p_status text, p_beloeb bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  r        record;
  v_kredit uuid;
begin
  if p_charge is null or p_dispute is null or p_dispute !~ '^(du|dp)_[A-Za-z0-9_]{1,90}$'
     or p_status is null or char_length(p_status) > 40 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  select x.id, x.status, x.trade_id, x.saelger_id, x.bankindsigelse_id, x.bankindsigelse_status,
         x.bankindsigelse_tabt_kl, x.beloeb_oere
    into r
    from public.ekstra_fragt_regninger x where x.stripe_charge_id = p_charge for update;
  if r.id is null then
    select x.id into r from public.ekstra_fragt_regninger x where x.tilbagefoerte_charges @> array[p_charge] limit 1;
    if r.id is not null then return jsonb_build_object('kode', 'genaabnet', 'id', r.id); end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;
  if p_status = 'lost' then
    if r.bankindsigelse_tabt_kl is not null and r.bankindsigelse_id = p_dispute then
      -- Gentaget event: kreditnotaen sikres (laves kun, hvis den mangler).
      return jsonb_build_object('kode', 'allerede', 'id', r.id, 'status', r.status,
                                'kreditnota_id', public.ekstra_fragt_bankindsigelse_kreditnota(r.id));
    end if;
    -- (En ny tabt indsigelse på samme charge tænder lampen igen.)
    update public.ekstra_fragt_regninger
       set bankindsigelse_id = p_dispute, bankindsigelse_status = 'lost', bankindsigelse_beloeb_oere = p_beloeb,
           bankindsigelse_tabt_kl = now(),
           bankindsigelse_haandteret_kl = null, bankindsigelse_haandteret_af = null,
           bankindsigelse_haandteret_begrundelse = null
     where id = r.id;
    v_kredit := public.ekstra_fragt_bankindsigelse_kreditnota(r.id);
    perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_bankindsigelse_tabt', r.trade_id, r.saelger_id,
      'Bankindsigelse ' || p_dispute || ' på sælgerens betaling af ekstraregningen ('
      || public.ekstra_fragt_kr(r.beloeb_oere) || ') er tabt - betalingen ('
      || public.ekstra_fragt_kr(coalesce(p_beloeb, 0)) || ') er tilbageført. '
      || case when v_kredit is null then 'Kreditnotaen kunne ikke laves automatisk - lav den manuelt. '
              else 'Kreditnota er lavet automatisk. ' end
      || 'Regningen genåbnes ikke automatisk.');
    return jsonb_build_object('kode', 'tabt', 'id', r.id, 'status', r.status, 'kreditnota_id', v_kredit);
  end if;
  -- En tabt indsigelse er endelig: den overskrives ikke af en anden status.
  if r.bankindsigelse_tabt_kl is null
     and (r.bankindsigelse_id is distinct from p_dispute or r.bankindsigelse_status is distinct from p_status) then
    update public.ekstra_fragt_regninger
       set bankindsigelse_id = p_dispute, bankindsigelse_status = p_status, bankindsigelse_beloeb_oere = p_beloeb
     where id = r.id;
  end if;
  return jsonb_build_object('kode', 'registreret', 'id', r.id, 'status', r.status);
end;
$fn$;

-- Cron: rækker, der kræver handling (claimet med synket_kl, så to kørsler
-- ikke tager den samme):
--   'synk'      ubetalt med PaymentIntent i over 15 min (mistet webhook)
--   'annuller'  en kasseret PaymentIntent skal annulleres hos Stripe
create or replace function public.ekstra_fragt_cron(p_graense integer default 20)
returns table (id uuid, handling text, pi text)
language plpgsql security definer set search_path = '' as $fn$
#variable_conflict use_column
declare
  v_graense integer := least(greatest(coalesce(p_graense, 20), 1), 100);
begin
  return query
  with k as (
    select r.id,
           case when r.annuller_pi is not null then 'annuller' else 'synk' end as handling,
           coalesce(r.annuller_pi, r.stripe_payment_intent_id) as pi
      from public.ekstra_fragt_regninger r
     where (r.annuller_pi is not null
            and (r.synket_kl is null or r.synket_kl <= now() - interval '10 minutes'))
        or (r.status in ('afventer_betaling', 'behandles') and r.stripe_payment_intent_id is not null
            and r.opdateret_kl <= now() - interval '15 minutes'
            and (r.synket_kl is null
                 or r.synket_kl <= now() - case when r.oprettet_kl > now() - interval '24 hours'
                                                then interval '15 minutes' else interval '6 hours' end))
     order by coalesce(r.synket_kl, r.oprettet_kl)
     limit v_graense
     for update of r skip locked
  ), u as (
    update public.ekstra_fragt_regninger x set synket_kl = now()
      from k where x.id = k.id
    returning x.id, k.handling, k.pi
  )
  select u.id, u.handling, u.pi from u;
end;
$fn$;

-- ===========================================================================
-- 9. Fakturaer: sælgeren faktureres (fragtkonto, med moms)
-- ===========================================================================
alter table public.fakturaer add column if not exists ekstra_fragt_id uuid
  references public.ekstra_fragt_regninger(id) on delete restrict;
-- Regningens betalingsrunde (0, eller 1, 2 ... efter genåbning). null = 0.
alter table public.fakturaer add column if not exists ekstra_fragt_runde integer;

-- Drift-tjek (md5 af den normaliserede definition, uden mellemrum): CHECK'en
-- erstattes kun, hvis den er præcis den kendte udgave fra
-- 20261023030000_boost.sql - eller allerede er denne fils udgave (genkørsel).
do $do$
declare
  v_def  text;
  v_md5  text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.fakturaer'::regclass and c.conname = 'fakturaer_slags_check';
  if v_def is null then
    raise exception 'Drift: CHECK fakturaer_slags_check mangler - kontrollér fakturaer, før migrationen køres';
  end if;
  v_md5 := md5(regexp_replace(v_def, '\s', '', 'g'));
  if not (v_md5 = any (array[
    md5(regexp_replace($k$CHECK (((slags = ANY (ARRAY['salg'::text, 'returfragt'::text, 'sag_returfragt'::text, 'boost'::text])) AND ((slags = 'salg'::text) OR ((slags = 'returfragt'::text) AND (dokument = 'faktura'::text) AND (part = 'koeber'::text)) OR ((slags = 'sag_returfragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'boost'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)))))$k$, '\s', '', 'g')),
    md5(regexp_replace($k$CHECK (((slags = ANY (ARRAY['salg'::text, 'returfragt'::text, 'sag_returfragt'::text, 'boost'::text, 'ekstra_fragt'::text])) AND ((slags = 'salg'::text) OR ((slags = 'returfragt'::text) AND (dokument = 'faktura'::text) AND (part = 'koeber'::text)) OR ((slags = 'sag_returfragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'boost'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'ekstra_fragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'saelger'::text)))))$k$, '\s', '', 'g'))])) then
    raise exception 'Drift: CHECK fakturaer_slags_check er ændret uden for migrationerne (md5 %) - opdatér migrationen: %', v_md5, v_def;
  end if;
end $do$;

alter table public.fakturaer drop constraint if exists fakturaer_slags_check;
alter table public.fakturaer add constraint fakturaer_slags_check
  check (slags in ('salg', 'returfragt', 'sag_returfragt', 'boost', 'ekstra_fragt')
         and (slags = 'salg'
              or (slags = 'returfragt' and dokument = 'faktura' and part = 'koeber')
              or (slags = 'sag_returfragt' and dokument in ('faktura', 'kreditnota') and part = 'koeber')
              or (slags = 'boost' and dokument in ('faktura', 'kreditnota') and part = 'koeber')
              or (slags = 'ekstra_fragt' and dokument in ('faktura', 'kreditnota') and part = 'saelger')));

alter table public.fakturaer drop constraint if exists fakturaer_ekstra_fragt_id_check;
alter table public.fakturaer add constraint fakturaer_ekstra_fragt_id_check
  check ((slags = 'ekstra_fragt') = (ekstra_fragt_id is not null));
alter table public.fakturaer drop constraint if exists fakturaer_ekstra_fragt_runde_check;
alter table public.fakturaer add constraint fakturaer_ekstra_fragt_runde_check
  check (ekstra_fragt_runde is null or (ekstra_fragt_id is not null and ekstra_fragt_runde >= 0));

comment on column public.fakturaer.slags is
  'salg: fakturaen ved betalingen (og kreditnotaen for den). returfragt: køberens faktura på returfragten, der blev trukket fra refusionen, da pakken ikke blev afhentet (20261016030000). sag_returfragt: køberens faktura (og kreditnota ved refusion) på returfragten, køberen betalte i en sag (20261022010000, returfragt_id). boost: købers faktura (og kreditnota ved refusion) på boost-point (20261023030000, boost_koeb_id). ekstra_fragt: sælgerens faktura (og kreditnota ved refusion) på ekstra fragt ved for lille pakkestørrelse (20261029020000, ekstra_fragt_id). Låst.';

-- Én faktura pr. betaling, part, dokument og slags - undtagen returfragt i
-- sager og ekstra fragt (en handel kan have flere): én pr. række og dokument.
-- Nyt indeks først, så der aldrig er et øjeblik uden værn.
create unique index if not exists fakturaer_handel_part_slags_v3
  on public.fakturaer (betaling_id, part, dokument, slags)
  where betaling_id is not null and slags not in ('sag_returfragt', 'ekstra_fragt');
drop index if exists public.fakturaer_handel_part_slags_v2;
-- Én faktura og én kreditnota pr. regning OG betalingsrunde (en genåbnet
-- regning får en kreditnota for den tilbageførte betaling og en ny faktura).
create unique index if not exists fakturaer_ekstra_fragt_runde_dokument
  on public.fakturaer (ekstra_fragt_id, (coalesce(ekstra_fragt_runde, 0)), dokument) where ekstra_fragt_id is not null;
drop index if exists public.fakturaer_ekstra_fragt_dokument;

create or replace function public.fakturaer_ekstra_fragt_laast()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.ekstra_fragt_id is distinct from old.ekstra_fragt_id
     or new.ekstra_fragt_runde is distinct from old.ekstra_fragt_runde then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  return new;
end;
$fn$;
revoke all on function public.fakturaer_ekstra_fragt_laast() from public, anon, authenticated;
drop trigger if exists fakturaer_ekstra_fragt_laast on public.fakturaer;
create trigger fakturaer_ekstra_fragt_laast before update on public.fakturaer
  for each row execute function public.fakturaer_ekstra_fragt_laast();

-- Rundens faktura for en betalt regning (intern - fakturakøen og
-- genåbningen). Laves kun, hvis den mangler. Dateret på betalingsdagen.
-- Passer det modtagne beløb ikke, oprettes den som "kræver handling".
-- Svar: faktura_id (null, hvis regningen ikke er betalt), ny (lavet nu).
create or replace function public.ekstra_fragt_lav_faktura(p_id uuid, out faktura_id uuid, out ny boolean)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r        record;
  v_linjer jsonb;
  v_ok     boolean;
  v_fejl   text := 'Ekstraregningen er betalt med et andet beløb end regningen - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  ny := false;
  select x.id, x.saelger_id, x.trade_id, x.betaling_id, x.beloeb_oere, x.modtaget_oere, x.betalt_kl, x.runde,
         x.stripe_charge_id, x.stripe_payment_intent_id, x.fragtfirma_fakturanummer
    into r
    from public.ekstra_fragt_regninger x
   where x.id = p_id and x.betalt_kl is not null and x.status in ('betalt', 'refunderet');
  if r.id is null then faktura_id := null; return; end if;
  select f.id into faktura_id from public.fakturaer f
   where f.ekstra_fragt_id = r.id and coalesce(f.ekstra_fragt_runde, 0) = r.runde and f.dokument = 'faktura';
  if faktura_id is not null then return; end if;
  v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
  v_linjer := jsonb_build_array(public.faktura_linje('fragt',
    left('Ekstra fragt - pakken var større/tungere end den valgte størrelse (fragtfirmaets faktura ' || r.fragtfirma_fakturanummer || ')', 250),
    r.beloeb_oere));
  insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                slags, ekstra_fragt_id, ekstra_fragt_runde)
  values ('faktura', 'saelger', r.saelger_id, r.betaling_id, r.trade_id, v_linjer, public.faktura_sum(v_linjer),
          public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
          coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
          case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
          case when v_ok then null else v_fejl end, 'ekstra_fragt', r.id, r.runde)
  on conflict do nothing
  returning id into faktura_id;
  if faktura_id is not null then
    ny := true;
  else
    -- Lavet af en samtidig kørsel.
    select f.id into faktura_id from public.fakturaer f
     where f.ekstra_fragt_id = r.id and coalesce(f.ekstra_fragt_runde, 0) = r.runde and f.dokument = 'faktura';
  end if;
end;
$fn$;
revoke all on function public.ekstra_fragt_lav_faktura(uuid) from public, anon, authenticated;

-- Kreditnota for rundens faktura, når betalingen er tilbageført efter en TABT
-- bankindsigelse (intern - ekstra_fragt_registrer_bankindsigelse ved tabet,
-- og som sikkerhedsnet fakturakøen, genåbningen og "afslut uden genåbning").
-- Dateret på tabsdagen, reference = indsigelsens id. Idempotent: findes
-- rundens kreditnota allerede (også en refusions-kreditnota), returneres den -
-- aldrig to (unikt indeks pr. regning, runde og dokument). Rundens faktura
-- laves først, hvis fakturakøen ikke har nået det. Dækker indsigelsen ikke
-- hele det modtagne beløb, eller er fakturaen håndteret manuelt, oprettes
-- kreditnotaen som "kræver handling" (laves manuelt i Dinero).
-- Svar: kreditnotaens id (null, hvis regningen ikke har en tabt indsigelse).
create or replace function public.ekstra_fragt_bankindsigelse_kreditnota(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r      record;
  v_fak  record;
  m      record;
  v_id   uuid;
  v_ok   boolean;
  v_fuld boolean;
begin
  select x.id, x.runde, x.bankindsigelse_id, x.bankindsigelse_tabt_kl, x.bankindsigelse_beloeb_oere,
         x.modtaget_oere, x.beloeb_oere
    into r
    from public.ekstra_fragt_regninger x
   where x.id = p_id and x.bankindsigelse_tabt_kl is not null and x.bankindsigelse_id is not null
     and x.betalt_kl is not null and x.status in ('betalt', 'refunderet');
  if r.id is null then return null; end if;
  select k.id into v_id from public.fakturaer k
   where k.ekstra_fragt_id = r.id and coalesce(k.ekstra_fragt_runde, 0) = r.runde and k.dokument = 'kreditnota';
  if v_id is not null then return v_id; end if;
  select * into v_fak from public.ekstra_fragt_lav_faktura(r.id);
  if v_fak.faktura_id is null then return null; end if;
  select fa.linjer, fa.manuel, fa.status, fa.bruger_id, fa.betaling_id, fa.trade_id into m
    from public.fakturaer fa where fa.id = v_fak.faktura_id;
  v_fuld := r.bankindsigelse_beloeb_oere is not distinct from coalesce(r.modtaget_oere, r.beloeb_oere);
  v_ok := v_fuld and not (m.manuel or m.status in ('kraever_handling', 'haandteret_manuelt'));
  insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                slags, ekstra_fragt_id, ekstra_fragt_runde)
  values ('kreditnota', 'saelger', m.bruger_id, m.betaling_id, m.trade_id, v_fak.faktura_id, m.linjer,
          public.faktura_sum(m.linjer), public.faktura_moms(m.linjer),
          (r.bankindsigelse_tabt_kl at time zone 'Europe/Copenhagen')::date, r.bankindsigelse_id,
          case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
          case when v_ok then null
               when not v_fuld then 'Bankindsigelsen dækker kun en del af betalingen (' || public.ekstra_fragt_kr(coalesce(r.bankindsigelse_beloeb_oere, 0))
                                    || ') – lav kreditnotaen for det tilbageførte beløb manuelt i Dinero.'
               else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
          'ekstra_fragt', r.id, r.runde)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    -- Lavet af en samtidig kørsel.
    select k.id into v_id from public.fakturaer k
     where k.ekstra_fragt_id = r.id and coalesce(k.ekstra_fragt_runde, 0) = r.runde and k.dokument = 'kreditnota';
  end if;
  return v_id;
end;
$fn$;
revoke all on function public.ekstra_fragt_bankindsigelse_kreditnota(uuid) from public, anon, authenticated;

-- Planlægger fakturaer og kreditnotaer for ekstra fragt (kaldes af
-- fakturakøen efter faktura_planlaeg). Idempotent. Pr. betalingsrunde:
--   faktura:    betalt regning (også hvis den senere er refunderet - så
--               bogføres begge). Dateret på betalingsdagen.
--   kreditnota: refunderet regning (hele beløbet), dateret på refusionsdagen.
--               Tilbageført betaling efter en tabt bankindsigelse: laves ved
--               tabet (ekstra_fragt_registrer_bankindsigelse); her kun som
--               sikkerhedsnet, hvis den mangler (dateret på tabsdagen).
create or replace function public.faktura_planlaeg_ekstra_fragt(p_graense integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura integer := 0;
  v_kredit  integer := 0;
  n         integer;
  r         record;
  v_fak     record;
  v_ok      boolean;
begin
  for r in
    select x.id
      from public.ekstra_fragt_regninger x
     where x.betalt_kl is not null
       and x.status in ('betalt', 'refunderet')
       and not exists (select 1 from public.fakturaer f
                        where f.ekstra_fragt_id = x.id and coalesce(f.ekstra_fragt_runde, 0) = x.runde
                          and f.dokument = 'faktura')
     order by x.betalt_kl
     limit v_graense
  loop
    select * into v_fak from public.ekstra_fragt_lav_faktura(r.id);
    if v_fak.ny then v_faktura := v_faktura + 1; end if;
  end loop;

  for r in
    select fa.id as faktura_id, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer, fa.manuel, fa.status as moder_status,
           x.id, x.runde, x.refunderet_kl, x.stripe_refund_id
      from public.fakturaer fa
      join public.ekstra_fragt_regninger x on x.id = fa.ekstra_fragt_id
     where fa.dokument = 'faktura'
       and fa.slags = 'ekstra_fragt'
       and coalesce(fa.ekstra_fragt_runde, 0) = x.runde
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k
                        where k.ekstra_fragt_id = x.id and coalesce(k.ekstra_fragt_runde, 0) = x.runde
                          and k.dokument = 'kreditnota')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_ok := not (r.manuel or r.moder_status in ('kraever_handling', 'haandteret_manuelt'));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, ekstra_fragt_id, ekstra_fragt_runde)
    values ('kreditnota', 'saelger', r.bruger_id, r.betaling_id, r.trade_id, r.faktura_id, r.linjer,
            public.faktura_sum(r.linjer), public.faktura_moms(r.linjer),
            (r.refunderet_kl at time zone 'Europe/Copenhagen')::date, r.stripe_refund_id,
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
            'ekstra_fragt', r.id, r.runde)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  -- Sikkerhedsnet: tabt bankindsigelse uden kreditnota i runden.
  for r in
    select x.id
      from public.ekstra_fragt_regninger x
     where x.bankindsigelse_tabt_kl is not null
       and x.status = 'betalt'
       and not exists (select 1 from public.fakturaer k
                        where k.ekstra_fragt_id = x.id and coalesce(k.ekstra_fragt_runde, 0) = x.runde
                          and k.dokument = 'kreditnota')
     order by x.bankindsigelse_tabt_kl
     limit v_graense
  loop
    if public.ekstra_fragt_bankindsigelse_kreditnota(r.id) is not null then v_kredit := v_kredit + 1; end if;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit);
end;
$fn$;

-- ===========================================================================
-- 9b. Oprydning: ubrugte dokumentationsfiler (Filip, 21. okt. 2026)
-- ===========================================================================
-- Filer i bucket'en, som ingen regning bruger, og som er over 7 dage gamle
-- (fx en upload, staff ikke gjorde færdig). Højst p_graense (1-1000) ad
-- gangen, ældste først. Selve sletningen sker via Storage-API'et
-- (src/lib/ekstraFragt/oprydning.ts, én gang om måneden), så filen også
-- forsvinder fra lageret. Dokumentation, en regning bruger, slettes aldrig.
create or replace function public.ekstra_fragt_ubrugte_filer(p_graense integer default 500)
returns setof text
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.name
    from storage.objects o
   where o.bucket_id = 'ekstra-fragt-dokumentation'
     and o.created_at < now() - interval '7 days'
     and not exists (select 1 from public.ekstra_fragt_regninger r where r.dokumentation_sti = o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_graense, 500), 1), 1000);
$fn$;

-- ===========================================================================
-- 10. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  -- Kun serveren (service role).
  foreach f in array array[
    'public.ekstra_fragt_betal_start(uuid, uuid)',
    'public.ekstra_fragt_gem_pi(uuid, text, integer)',
    'public.ekstra_fragt_nulstil_pi(uuid, text)',
    'public.ekstra_fragt_pi_annulleret(uuid, text)',
    'public.ekstra_fragt_registrer(text, text, text, bigint, text)',
    'public.ekstra_fragt_registrer_charge_refusion(text, text, boolean)',
    'public.ekstra_fragt_cron(integer)',
    'public.ekstra_fragt_registrer_bankindsigelse(text, text, text, bigint)',
    'public.ekstra_fragt_ubrugte_filer(integer)',
    'public.faktura_planlaeg_ekstra_fragt(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- Brugerens session (staff: auth.uid() + er_staff(); sælger: auth.uid()).
  foreach f in array array[
    'public.ekstra_fragt_opret(uuid, bigint, text, integer, text, text, text, text, text, text)',
    'public.ekstra_fragt_frafald(uuid, text)',
    'public.ekstra_fragt_afgoer_indsigelse(uuid, text, text)',
    'public.ekstra_fragt_gem_note(uuid, text)',
    'public.ekstra_fragt_genaabn(uuid, text)',
    'public.ekstra_fragt_bankindsigelse_afslut(uuid, text)',
    'public.ekstra_fragt_dokumentation_staff(uuid)',
    'public.ekstra_fragt_antal()',
    'public.mit_ekstra_fragt_indsigelse(uuid, text)',
    'public.mine_ekstra_fragt_regninger(uuid)',
    'public.min_ekstra_fragt_dokumentation(uuid)',
    'public.min_ekstra_fragt_status()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $do$;
