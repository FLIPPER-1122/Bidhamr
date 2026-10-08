-- Ny betalingsmodel, trin 1: fundament (docs/BETALINGSMODEL-PLAN.md afsnit 6.1).
-- ROADMAP-BESLUTNINGER.md "Betalingsmodel ændres" (Filip, 8. okt. 2026).
--
-- INGEN ændring i pengestrømmen: alle eksisterende og nye betalinger er
-- 'separat' (separate charges and transfers), og alt nyt er slået fra, indtil
-- BÅDE serverflaget STRIPE_BETALINGSMODEL=destination OG databasens
-- indstilling stripe_tilstand.betalingsmodel = 'destination' er sat
-- (src/lib/betaling/model.ts).
--
--  1. Databasens indstilling: stripe_tilstand.betalingsmodel ('separat' |
--     'destination', standard 'separat'). Genbruger enkeltrækken fra
--     20261010070000 (kun service role). betalingsmodel_aktiv() læser den.
--  2. betalinger: pengemodel + kolonner til destination charges (pengene står
--     på sælgerens Connect-konto, manuel udbetaling). CHECK: en 'separat'-række
--     har ALDRIG destination-kolonner udfyldt - derfor ændrer vagterne i 5
--     intet for 'separat'. pengemodel kan kun skiftes, mens betalingen afventer
--     og ingen charge findes.
--  3. saelger_udbetalinger: BidHamrs payouts fra sælgerens Connect-konto til
--     banken (bruges fra trin 3). Kun service role, slettes aldrig.
--  4. betalingsprofiler: connect_charges_enabled, connect_kort_aktiv,
--     connect_betalingsmetoder, connect_udbetalingsplan, connect_plan_ok -
--     spejlet fra Stripe af serveren (spejlConnectKonto). Som de øvrige
--     connect_*-kolonner: brugeren kan kun læse sin egen række (RLS +
--     table-SELECT), kun service role skriver.
--  5. "Pengene er givet til sælger": betaling_penge_til_saelger(betalinger) =
--     stripe_transfer_id (separat) ELLER saelger_udbetaling_id (destination,
--     payout påbegyndt). Vagterne med stripe_transfer_id is null / is not null
--     i 21 funktioner rettes på stedet til også at dække saelger_udbetaling_id.
--     saelger_udbetaling_id er altid null for 'separat' (CHECK i 2), så
--     vagterne virker præcis som før for alle eksisterende rækker.
--     IKKE rettet (bevidst - se nederst): admin_forside_tal, admin_penge_holdes,
--     admin_penge_tal, betaling_overfoersel_fejlet,
--     betaling_overfoersel_loest_auto, betaling_overfoersel_nulstil,
--     udbetalingskonto_nulstil.
--  6. har_udbetalingskonto: med betalingsmodel 'destination' kræves også
--     charges_enabled, card_payments aktiv og manuel udbetalingsplan. Med
--     'separat' (i dag) uændret.
--
-- Idempotent. Ændrer ingen handelsdata.

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Databasens indstilling for betalingsmodellen
-- ===========================================================================
alter table public.stripe_tilstand
  add column if not exists betalingsmodel text not null default 'separat';

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'stripe_tilstand_betalingsmodel_check'
                   and conrelid = 'public.stripe_tilstand'::regclass) then
    alter table public.stripe_tilstand
      add constraint stripe_tilstand_betalingsmodel_check
      check (betalingsmodel in ('separat', 'destination'));
  end if;
end $do$;

comment on column public.stripe_tilstand.betalingsmodel is
  'Betalingsmodel: separat (BidHamrs saldo + transfer ved frigivelse, i dag) eller destination (pengene på sælgerens Connect-konto, manuel udbetaling). Destination er først aktiv, når også serverflaget STRIPE_BETALINGSMODEL=destination er sat (src/lib/betaling/model.ts). Se docs/BETALINGSMODEL-PLAN.md.';

create or replace function public.betalingsmodel_aktiv()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select betalingsmodel from public.stripe_tilstand where id), 'separat');
$$;

revoke all on function public.betalingsmodel_aktiv() from public, anon, authenticated;
grant execute on function public.betalingsmodel_aktiv() to service_role;

-- ===========================================================================
-- 3. saelger_udbetalinger (før 2: betalinger refererer til den)
-- ===========================================================================
create table if not exists public.saelger_udbetalinger (
  id               uuid primary key default gen_random_uuid(),
  seller_id        uuid not null references public.users(id) on delete restrict,
  stripe_konto     text not null,
  beloeb_oere      bigint not null check (beloeb_oere > 0),
  valuta           text not null default 'dkk',
  stripe_payout_id text unique,
  status           text not null default 'claimet'
                   check (status in ('claimet', 'oprettet', 'paid', 'failed', 'canceled', 'usikker')),
  forsoeg          integer not null default 0 check (forsoeg >= 0),
  sidste_fejl      text,
  oprettet         timestamptz not null default now(),
  opdateret        timestamptz not null default now(),
  betalt_kl        timestamptz,
  fejlet_kl        timestamptz
);

comment on table public.saelger_udbetalinger is
  'BidHamrs udbetalinger (payouts) fra sælgerens Stripe Connect-konto til sælgerens bank (destination-modellen, trin 3). En udbetaling dækker en eller flere betalinger (betalinger.saelger_udbetaling_id). Kun service role. Slettes aldrig (bogføringsloven).';

create index if not exists saelger_udbetalinger_seller_idx
  on public.saelger_udbetalinger (seller_id, oprettet desc);
create index if not exists saelger_udbetalinger_aaben_idx
  on public.saelger_udbetalinger (status)
  where status in ('claimet', 'oprettet', 'usikker');

alter table public.saelger_udbetalinger enable row level security;
revoke all on table public.saelger_udbetalinger from public, anon, authenticated;
grant select, insert, update on table public.saelger_udbetalinger to service_role;

create or replace function public.saelger_udbetalinger_forbyd_sletning()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'saelger_udbetalinger_slettes_aldrig';
end;
$$;

revoke all on function public.saelger_udbetalinger_forbyd_sletning() from public, anon, authenticated;

drop trigger if exists saelger_udbetalinger_forbyd_sletning_trg on public.saelger_udbetalinger;
create trigger saelger_udbetalinger_forbyd_sletning_trg
  before delete on public.saelger_udbetalinger
  for each row execute function public.saelger_udbetalinger_forbyd_sletning();

-- ===========================================================================
-- 2. betalinger: pengemodel og destination-kolonner
-- ===========================================================================
alter table public.betalinger
  add column if not exists pengemodel                     text not null default 'separat',
  add column if not exists saelger_stripe_konto           text,
  add column if not exists application_fee_oere           bigint,
  add column if not exists stripe_destination_transfer_id text,
  add column if not exists stripe_application_fee_id      text,
  add column if not exists stripe_destination_payment_id  text,
  add column if not exists midler_tilgaengelige_kl        timestamptz,
  add column if not exists udbetal_tidligst               timestamptz,
  add column if not exists saelger_udbetaling_id          uuid references public.saelger_udbetalinger(id) on delete restrict,
  add column if not exists refusion_fra_saelger_oere      bigint,
  add column if not exists refusion_gebyr_oere            bigint,
  add column if not exists stripe_fee_refund_id           text,
  add column if not exists gebyr_refunderet_kl            timestamptz,
  add column if not exists indsigelse_tilbagefoersel_id   text,
  add column if not exists indsigelse_genoverfoersel_id   text,
  add column if not exists svindelvarsel_kl               timestamptz,
  add column if not exists radar_review_aaben             boolean not null default false;

do $do$
declare
  c record;
begin
  for c in
    select * from (values
      ('betalinger_pengemodel_check',
       $c$check (pengemodel in ('separat', 'destination'))$c$),
      -- En 'separat'-række har aldrig destination-kolonner. Det gør, at
      -- vagterne (afsnit 5) er uændrede for 'separat'.
      ('betalinger_separat_uden_destination',
       $c$check (pengemodel <> 'separat' or (
          saelger_stripe_konto is null and application_fee_oere is null
          and stripe_destination_transfer_id is null and stripe_application_fee_id is null
          and stripe_destination_payment_id is null and midler_tilgaengelige_kl is null
          and saelger_udbetaling_id is null and refusion_fra_saelger_oere is null
          and refusion_gebyr_oere is null and stripe_fee_refund_id is null
          and gebyr_refunderet_kl is null and indsigelse_tilbagefoersel_id is null
          and indsigelse_genoverfoersel_id is null))$c$),
      -- Destination laver aldrig en separat transfer.
      ('betalinger_destination_uden_transfer',
       $c$check (pengemodel <> 'destination' or stripe_transfer_id is null)$c$),
      -- Destination: BidHamrs application fee = købergebyr + sælgergebyr +
      -- fragt + Beskyttelse, og sælgeren står tilbage med udbetaling_oere.
      ('betalinger_destination_gebyr_stemmer',
       $c$check (pengemodel <> 'destination' or application_fee_oere is null or (
          application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere
          and total_oere - application_fee_oere = udbetaling_oere))$c$),
      -- Destination: før der findes en PaymentIntent, skal gebyr og sælgerkonto
      -- være låst på betalingen.
      ('betalinger_destination_klar',
       $c$check (pengemodel <> 'destination' or stripe_payment_intent_id is null
          or (application_fee_oere is not null and saelger_stripe_konto is not null))$c$),
      -- Destination: en payout sætter også overfoersel_paabegyndt_kl.
      ('betalinger_destination_udbetaling_paabegyndt',
       $c$check (pengemodel <> 'destination' or saelger_udbetaling_id is null
          or overfoersel_paabegyndt_kl is not null)$c$),
      ('betalinger_application_fee_oere_check',
       $c$check (application_fee_oere is null or application_fee_oere >= 0)$c$),
      -- Refusionsplan (trin 4): fra sælger + gebyr-refusion = refusionsbeløbet.
      ('betalinger_refusionsplan_stemmer',
       $c$check (
          (refusion_fra_saelger_oere is null or refusion_fra_saelger_oere between 0 and udbetaling_oere)
          and (refusion_gebyr_oere is null or refusion_gebyr_oere >= 0)
          and (refusion_fra_saelger_oere is null or refusion_gebyr_oere is null
               or refusion_fra_saelger_oere + refusion_gebyr_oere = coalesce(refusion_oere, total_oere)))$c$)
    ) as v(navn, def)
  loop
    if not exists (select 1 from pg_constraint
                    where conname = c.navn and conrelid = 'public.betalinger'::regclass) then
      execute format('alter table public.betalinger add constraint %I %s', c.navn, c.def);
    end if;
  end loop;
end $do$;

create unique index if not exists betalinger_stripe_destination_transfer_id_key
  on public.betalinger (stripe_destination_transfer_id)
  where stripe_destination_transfer_id is not null;
create index if not exists betalinger_saelger_udbetaling_idx
  on public.betalinger (saelger_udbetaling_id)
  where saelger_udbetaling_id is not null;

comment on column public.betalinger.pengemodel is
  'separat: betaling på BidHamrs saldo + transfer ved frigivelse (stripe_transfer_id). destination: betaling på sælgerens vegne (on_behalf_of + transfer_data), pengene står på sælgerens Connect-konto, manuel payout (saelger_udbetaling_id). Kan kun skiftes, mens betalingen afventer uden charge.';
comment on column public.betalinger.saelger_stripe_konto is
  'Destination: sælgerens Connect-konto (acct_...), låst når PaymentIntenten oprettes.';
comment on column public.betalinger.application_fee_oere is
  'Destination: BidHamrs application fee = købergebyr + sælgergebyr + fragt + Beskyttelse (CHECK).';
comment on column public.betalinger.stripe_destination_transfer_id is
  'Destination: Stripes automatiske transfer til sælgerens konto (charge.transfer). IKKE stripe_transfer_id - den betyder "givet til sælger" i den gamle model.';
comment on column public.betalinger.saelger_udbetaling_id is
  'Destination: payout til sælgerens bank er påbegyndt (saelger_udbetalinger). Sammen med stripe_transfer_id = "pengene er givet til sælger" (betaling_penge_til_saelger).';
comment on column public.betalinger.midler_tilgaengelige_kl is
  'Destination: hvornår pengene er "available" på sælgerens Connect-konto (balance_transaction.available_on).';
comment on column public.betalinger.udbetal_tidligst is
  'Destination: tidligste payout (Niels F02 - ventetid ved fx afhentning).';

-- pengemodel må kun skiftes, mens betalingen afventer og ingen charge findes.
create or replace function public.betalinger_pengemodel_laas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pengemodel is distinct from old.pengemodel
     and (old.status <> 'afventer' or old.stripe_charge_id is not null) then
    raise exception 'betalinger_pengemodel_laast: pengemodel kan ikke ændres efter betaling';
  end if;
  return new;
end;
$$;

revoke all on function public.betalinger_pengemodel_laas() from public, anon, authenticated;

drop trigger if exists betalinger_pengemodel_laas on public.betalinger;
create trigger betalinger_pengemodel_laas
  before update of pengemodel on public.betalinger
  for each row execute function public.betalinger_pengemodel_laas();

-- ===========================================================================
-- 4. betalingsprofiler: spejl af sælgerkontoen til destination-modellen
-- ===========================================================================
alter table public.betalingsprofiler
  add column if not exists connect_charges_enabled  boolean not null default false,
  add column if not exists connect_kort_aktiv       boolean not null default false,
  add column if not exists connect_betalingsmetoder jsonb   not null default '{}'::jsonb,
  add column if not exists connect_udbetalingsplan  text,
  add column if not exists connect_plan_ok          boolean not null default false;

comment on column public.betalingsprofiler.connect_charges_enabled is
  'Spejl af Stripe account.charges_enabled. Kun service role skriver.';
comment on column public.betalingsprofiler.connect_kort_aktiv is
  'Spejl: capabilities.card_payments = active (krævet for on_behalf_of). Kun service role skriver.';
comment on column public.betalingsprofiler.connect_betalingsmetoder is
  'Spejl: status for kontoens betalingsmetode-capabilities (*_payments), fx {"card_payments":"active","mobilepay_payments":"inactive"}. Kun service role skriver.';
comment on column public.betalingsprofiler.connect_udbetalingsplan is
  'Spejl: settings.payouts.schedule.interval (manual/daily/weekly/monthly). Kun service role skriver.';
comment on column public.betalingsprofiler.connect_plan_ok is
  'Spejl: udbetalingsplanen er manual (BidHamr laver udbetalingerne i destination-modellen). Kun service role skriver.';

-- Ingen nye rettigheder: authenticated har (som før) kun SELECT på egen række
-- (betalingsprofiler_select_egen); kun service role skriver.

-- ===========================================================================
-- 5. "Pengene er givet til sælger" - hjælper og vagter
-- ===========================================================================
create or replace function public.betaling_penge_til_saelger(p public.betalinger)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p.stripe_transfer_id is not null or p.saelger_udbetaling_id is not null;
$$;

revoke all on function public.betaling_penge_til_saelger(public.betalinger) from public, anon, authenticated;
grant execute on function public.betaling_penge_til_saelger(public.betalinger) to service_role;

comment on function public.betaling_penge_til_saelger(public.betalinger) is
  'Pengene er givet til sælger: separat = transfer (stripe_transfer_id), destination = payout påbegyndt (saelger_udbetaling_id). Vagterne i SQL-funktionerne bruger samme udtryk direkte (20261011010000).';

-- Retter vagterne på stedet. For hver funktion: alle mønstre skal findes
-- præcis det forventede antal gange, ellers afbrydes migrationen (så en
-- ændret funktion i produktion opdages). Allerede rettet (indeholder
-- saelger_udbetaling_id) springes over. CR fjernes først (funktioner oprettet
-- fra SQL Editor på Windows har CRLF).
create or replace function pg_temp.bm_ret(p_fn text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  e     jsonb;
  n     integer;
begin
  if position('saelger_udbetaling_id' in v_def) > 0 then
    return 'allerede';
  end if;
  for e in select * from jsonb_array_elements(p_par) loop
    n := (length(v_def) - length(replace(v_def, e->>0, ''))) / length(e->>0);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, e->>0, n;
    end if;
    v_def := replace(v_def, e->>0, e->>1);
  end loop;
  execute v_def;
  return 'rettet';
end
$f$;

do $do$
declare
  -- Mønstre (gammelt, nyt, antal).
  a  jsonb := jsonb_build_array('or b.stripe_transfer_id is not null',
                                'or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null', 1);
  bt jsonb := jsonb_build_array('and bt.stripe_transfer_id is null',
                                'and bt.stripe_transfer_id is null and bt.saelger_udbetaling_id is null', 1);
  b  jsonb := jsonb_build_array('and b.stripe_transfer_id is null',
                                'and b.stripe_transfer_id is null and b.saelger_udbetaling_id is null', 1);
  u  jsonb := jsonb_build_array('and stripe_transfer_id is null',
                                'and stripe_transfer_id is null and saelger_udbetaling_id is null', 1);
  p  jsonb := jsonb_build_array('b.stripe_transfer_id is not null or b.overfoersel_paabegyndt_kl is not null',
                                'b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null or b.overfoersel_paabegyndt_kl is not null', 1);
  r  record;
begin
  for r in
    select * from (values
      -- "Allerede afgjort / pengene er hos sælger"-vagter (afvis/spring over).
      ('public.afhentning_bekraeft(uuid,text)',                              jsonb_build_array(a)),
      ('public.afhentning_forlaeng_frist(uuid,timestamp with time zone)',   jsonb_build_array(a)),
      ('public.afhentning_vis_kode(uuid,integer,text)',                     jsonb_build_array(a)),
      ('public.betaling_paabegynd_refusion(uuid,text)',                     jsonb_build_array(a)),
      ('public.sag_afgoer(uuid,uuid,text,text,text,boolean)',               jsonb_build_array(a)),
      ('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',          jsonb_build_array(a)),
      ('public.sag_claim_refusion(uuid)',                                   jsonb_build_array(a)),
      ('public.sag_genaabn(uuid,uuid,text)',                                jsonb_build_array(a)),
      ('public.sag_opret(uuid,text,text,jsonb)',                            jsonb_build_array(a)),
      -- Kandidat-udvælgelse (bt) + vagt under låsen (b).
      ('public.afhentningsfrist_annuller()',                                jsonb_build_array(bt, a)),
      ('public.afsendelsesfrist_annuller()',                                jsonb_build_array(bt, a)),
      ('public.handel_auto_frigiv()',                                       jsonb_build_array(bt, a)),
      -- "Ikke givet til sælger endnu".
      ('public.afhentning_paamind_kandidater()',                            jsonb_build_array(b)),
      ('public.konto_sletning_blokeringer(uuid)',                           jsonb_build_array(b)),
      -- Refusionslåsen og -fejl: kun så længe intet er givet til sælger.
      ('public.betaling_refusion_laas(uuid,uuid,integer,text)',             jsonb_build_array(u)),
      ('public.betaling_refusion_fejl_uden_laas(uuid,integer)',             jsonb_build_array(u)),
      -- Refusion/indsigelse efter overførsel.
      ('public.betaling_refusion_proev_igen(uuid,uuid,text)',               jsonb_build_array(p)),
      ('public.betaling_registrer_indsigelse(text,text,text,text)',         jsonb_build_array(p)),
      ('public.betaling_registrer_refunderet(text,text)', jsonb_build_array(
         jsonb_build_array('when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null',
                           'when stripe_transfer_id is not null or saelger_udbetaling_id is not null or overfoersel_paabegyndt_kl is not null', 1),
         jsonb_build_array('or overfoersel_paabegyndt_kl is not null,',
                           'or overfoersel_paabegyndt_kl is not null or saelger_udbetaling_id is not null,', 1),
         b)),
      ('public.betaling_indsigelse_tabt_luk(uuid,uuid,text)', jsonb_build_array(
         jsonb_build_array('if b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null then',
                           'if b.stripe_transfer_id is null and b.saelger_udbetaling_id is null and b.overfoersel_paabegyndt_kl is null then', 1),
         jsonb_build_array($t$'overfoert', b.stripe_transfer_id is not null,$t$,
                           $t$'overfoert', (b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null),$t$, 1))),
      -- Handlen er først afsluttet, når pengene er givet til sælger.
      ('public.handel_afsluttet_kl(uuid)', jsonb_build_array(
         jsonb_build_array('stripe_transfer_id, refusion_anmodet_kl, indsigelse_kl, indsigelse_status',
                           'stripe_transfer_id, saelger_udbetaling_id, refusion_anmodet_kl, indsigelse_kl, indsigelse_status', 1),
         jsonb_build_array('and (b.stripe_transfer_id is null',
                           'and ((b.stripe_transfer_id is null and b.saelger_udbetaling_id is null)', 1)))
    ) as v(fn, par)
  loop
    raise notice '%: %', r.fn, pg_temp.bm_ret(r.fn, r.par);
  end loop;
end $do$;

drop function pg_temp.bm_ret(text, jsonb);

-- IKKE rettet (bevidst):
--   admin_forside_tal, admin_penge_holdes, admin_penge_tal - tal til admin
--     (penge hos BidHamr/ikke frigivet). I destination-modellen står pengene
--     på sælgerens konto - tallene laves om sammen med admin i trin 3/5.
--   betaling_overfoersel_fejlet, betaling_overfoersel_loest_auto,
--   betaling_overfoersel_nulstil, udbetalingskonto_nulstil - hører til den
--     gamle transfer (overfoerTilSaelger), som aldrig kører for destination.
--     Trin 3 laver de tilsvarende for payouts.

-- ===========================================================================
-- 6. har_udbetalingskonto: strammere regel med destination
-- ===========================================================================
-- Uændret med 'separat'. Med 'destination' skal kontoen også kunne tage imod
-- betaling på sælgerens vegne (charges_enabled + card_payments aktiv) og stå
-- til manuel udbetaling. Gælder auctions_kraev_udbetalingskonto (opret
-- auktion) og alle andre kaldere (genopsæt, andenchance ...).
create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.betalingsprofiler
     where user_id = p_bruger
       and stripe_account_id is not null
       and connect_detaljer_indsendt
       and connect_frakoblet_kl is null
       and coalesce(connect_spaerret_aarsag, '') not like 'rejected.%'
       and (public.betalingsmodel_aktiv() = 'separat'
            or (connect_charges_enabled and connect_kort_aktiv and connect_plan_ok))
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;
