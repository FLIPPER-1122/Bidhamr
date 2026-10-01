-- Ny betalingsmodel: betal naar du vinder - ingen saldo.
--
-- Stripe holder pengene ("separate charges and transfers"). Koeberen betaler
-- til BidHamrs platformskonto via en PaymentIntent; ved frigivelse oprettes en
-- Transfer til saelgerens Connect Express-konto (beloeb minus 5% saelgergebyr)
-- med source_transaction = chargen. Databasen SPEJLER kun status fra Stripe.
--
-- Denne migration:
--   1. Fjerner saldo-tjek/reservation fra budflowet (trigger paa bids).
--      Wallet-tabellerne og -funktionerne bliver staaende ubrugte - de fjernes
--      i naeste roadmap-punkt.
--   2. Ny handelsstatus 'afventer_betaling' (foer 'betaling_modtaget').
--   3. Tabellerne betalingsprofiler, betalinger og stripe_haendelser.
--   4. afslut_udloebne_auktioner opretter nu handel + betaling (48 t frist)
--      i stedet for at traekke penge fra en saldo.
--   5. Service-role-funktioner, som webhooken bruger til at spejle Stripe.
--
-- Alle beloeb er i oere (heltal). Handelsdata slettes aldrig: ingen
-- "on delete cascade" fra betalinger.

-- ============================================================ 1. budflow

drop trigger if exists bids_reserver_midler_trg on public.bids;

-- Godkendelse krediterer ikke laengere en saldo (se handel_godkend nedenfor).
-- Den gamle funktion maa ikke kunne kaldes af brugere via PostgREST.
do $$
begin
  if to_regprocedure('public.wallet_udbetal_saelger(uuid)') is not null then
    revoke execute on function public.wallet_udbetal_saelger(uuid) from public, anon, authenticated;
  end if;
end $$;

-- ============================================================ 2. trades

alter table public.trades drop constraint if exists trades_status_check;
alter table public.trades add constraint trades_status_check check (
  status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget',
             'leveret','afsluttet','annulleret'));

alter table public.trades alter column status set default 'afventer_betaling';

comment on column public.trades.status is
  'afventer_betaling: auktionen er slut, vinderen har 48 timer til at betale. '
  'betaling_modtaget: Stripe har bekraeftet betalingen (sat af webhooken). '
  'pakke_sendt: saelger har afsendt. modtaget: koeber har kvitteret for '
  'pakken. leveret: koeber har godkendt, og pengene er frigivet til saelger. '
  'afsluttet: RESERVERET. annulleret: sat af admin via Sager.';

-- ============================================================ 3a. profiler

-- Stripe-id'er og betalingsindstillinger. Egen tabel frem for kolonner paa
-- users, saa users' kolonne-grants og beskyttelsestriggere ikke beroeres, og
-- saa klienten aldrig kan skrive her: kun service-role skriver.
create table if not exists public.betalingsprofiler (
  user_id                    uuid primary key references public.users(id) on delete restrict,
  stripe_customer_id         text unique,
  -- Gemt kort (tilvalg). Id paa PaymentMethod hos Stripe + visningsdata.
  gemt_betalingsmetode_id    text,
  gemt_kort_maerke           text,
  gemt_kort_sidste4          text,
  gemt_kort_udloeb           text,
  -- "Betal automatisk, naar jeg vinder". Kraever et gemt kort.
  autobetaling               boolean not null default false,
  -- Saelger: Connect Express-konto.
  stripe_account_id          text unique,
  connect_detaljer_indsendt  boolean not null default false,
  connect_overfoersler_aktiv boolean not null default false,
  connect_udbetalinger_aktiv boolean not null default false,
  oprettet                   timestamptz not null default now(),
  opdateret                  timestamptz not null default now(),
  constraint autobetaling_kraever_kort
    check (not autobetaling or gemt_betalingsmetode_id is not null)
);

alter table public.betalingsprofiler enable row level security;

drop policy if exists betalingsprofiler_select_egen on public.betalingsprofiler;
create policy betalingsprofiler_select_egen on public.betalingsprofiler
  for select to authenticated using (user_id = auth.uid());

-- Ingen insert/update/delete-policies: kun service-role skriver.
revoke insert, update, delete, truncate on public.betalingsprofiler from anon, authenticated;
revoke all on public.betalingsprofiler from anon;
grant select on public.betalingsprofiler to authenticated;
grant all on public.betalingsprofiler to service_role;

-- ============================================================ 3b. betalinger

create table if not exists public.betalinger (
  id                        uuid primary key default gen_random_uuid(),
  trade_id                  uuid not null unique references public.trades(id) on delete restrict,
  auction_id                uuid not null references public.auctions(id) on delete restrict,
  buyer_id                  uuid not null references public.users(id) on delete restrict,
  seller_id                 uuid not null references public.users(id) on delete restrict,

  -- Beloeb i oere. Beregnes KUN i databasen/paa serveren.
  bud_oere                  bigint not null check (bud_oere > 0),
  koebergebyr_oere          bigint not null check (koebergebyr_oere >= 0),
  fragt_oere                bigint not null default 0 check (fragt_oere >= 0),
  beskyttelse               boolean not null default false,
  beskyttelse_oere          bigint not null default 0 check (beskyttelse_oere >= 0),
  total_oere                bigint not null check (total_oere > 0),
  saelgergebyr_oere         bigint not null check (saelgergebyr_oere >= 0),
  -- Det der overfoeres til saelgerens Connect-konto ved frigivelse.
  udbetaling_oere           bigint not null check (udbetaling_oere >= 0),
  valuta                    text not null default 'dkk',

  status                    text not null default 'afventer' check (status in (
                              'afventer',   -- venter paa koeberen
                              'behandles',  -- Stripe behandler (fx MobilePay)
                              'betalt',     -- payment_intent.succeeded
                              'annulleret', -- frist overskredet (senere punkt)
                              'refunderet'  -- refusion (senere punkt)
                            )),
  betal_senest              timestamptz not null,

  stripe_payment_intent_id  text unique,
  stripe_charge_id          text,
  betalt_kl                 timestamptz,
  sidste_fejl               text,

  -- Automatisk betaling med gemt kort (tilvalg).
  autobetaling_forsoegt_kl  timestamptz,
  autobetaling_resultat     text,

  -- Mails. Saettes atomisk FOER afsendelse, saa en mail aldrig sendes to gange.
  vundet_mail_sendt_kl      timestamptz,
  paamindelse_24_sendt_kl   timestamptz,
  paamindelse_40_sendt_kl   timestamptz,

  -- Frigivelse til saelger.
  frigivet_kl               timestamptz,
  stripe_transfer_id        text unique,
  overfoert_kl              timestamptz,

  oprettet                  timestamptz not null default now(),
  opdateret                 timestamptz not null default now(),

  constraint betalinger_total_stemmer check (
    total_oere = bud_oere + koebergebyr_oere + fragt_oere + beskyttelse_oere),
  constraint betalinger_beskyttelse_stemmer check (
    beskyttelse or beskyttelse_oere = 0),
  constraint betalinger_udbetaling_stemmer check (
    udbetaling_oere = bud_oere - saelgergebyr_oere)
);

create index if not exists betalinger_buyer_idx  on public.betalinger (buyer_id, oprettet desc);
create index if not exists betalinger_seller_idx on public.betalinger (seller_id, oprettet desc);
create index if not exists betalinger_status_idx on public.betalinger (status, betal_senest);

comment on table public.betalinger is
  'Spejl af Stripe-betalingen for en handel. Stripe er sandheden om penge. '
  'Alle beloeb i oere. Slettes aldrig (bogfoeringsloven/DAC7).';

alter table public.betalinger enable row level security;

drop policy if exists betalinger_select_part on public.betalinger;
create policy betalinger_select_part on public.betalinger
  for select to authenticated using (
    buyer_id = auth.uid() or seller_id = auth.uid() or public.er_staff());

revoke insert, update, delete, truncate on public.betalinger from anon, authenticated;
revoke all on public.betalinger from anon;
grant select on public.betalinger to authenticated;
grant all on public.betalinger to service_role;

-- Handelsdata maa aldrig slettes - heller ikke af service-role ved et uheld.
create or replace function public.betalinger_forbyd_sletning()
returns trigger language plpgsql as $fn$
begin
  raise exception 'betalinger_slettes_aldrig';
end;
$fn$;

drop trigger if exists betalinger_forbyd_sletning_trg on public.betalinger;
create trigger betalinger_forbyd_sletning_trg
  before delete on public.betalinger
  for each row execute function public.betalinger_forbyd_sletning();

-- ============================================================ 3c. events

-- Log over behandlede Stripe-events. Webhook-handlerne er selv idempotente;
-- tabellen giver et spor og lader os springe allerede behandlede events over.
create table if not exists public.stripe_haendelser (
  id          text primary key,           -- evt_...
  type        text not null,
  behandlet   timestamptz not null default now()
);

alter table public.stripe_haendelser enable row level security;
revoke all on public.stripe_haendelser from anon, authenticated;
grant all on public.stripe_haendelser to service_role;

-- ============================================================ beregning

-- Gebyrer i oere. 5% koeber, 5% saelger (ROADMAP-BESLUTNINGER afsnit 3).
-- BidHamr Beskyttelse: 3% af buddet, min 2000 / maks 25000 oere (afsnit 4).
-- Afrunding: halv op til naermeste oere.
create or replace function public.beregn_beskyttelse_oere(p_bud_oere bigint)
returns bigint language sql immutable as $fn$
  select least(greatest(round(p_bud_oere * 3 / 100.0)::bigint, 2000), 25000);
$fn$;

-- ============================================================ 4. auktionsslut

-- Lukker udloebne auktioner og opretter handel + betaling for dem med en
-- vinder. Ingen penge flyttes her: vinderen betaler selv inden 48 timer, eller
-- serveren forsoeger hans gemte kort (autobetaling), naar cron-ruten koerer.
create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  r     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  t_id  uuid;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;

  -- Handel + betaling for afsluttede auktioner med vinder og uden handel.
  -- Begraenset til de seneste 7 dage, saa gamle auktioner ikke backfilles.
  for r in
    select a.id, a.bruger_id, a.vinder_id
      from public.auctions a
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and a.slutter_kl >= now() - interval '7 days'
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    begin
      t_id := null;
      select round(max(b.beløb) * 100)::bigint into bud
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id;

      if bud is null or bud <= 0 then
        raise warning 'ingen gyldigt vinderbud for auktion %', r.id;
        continue;
      end if;

      koeb  := round(bud * 5 / 100.0)::bigint;
      saelg := round(bud * 5 / 100.0)::bigint;

      insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
      values (r.id, r.bruger_id, r.vinder_id, bud / 100.0, 'afventer_betaling')
      on conflict (auction_id) do nothing
      returning id into t_id;

      if t_id is null then continue; end if;

      -- TODO fragt: auktionerne har endnu ingen fragtpris. fragt_oere = 0,
      -- indtil fragtintegrationen (fase 2) saetter den.
      insert into public.betalinger (
        trade_id, auction_id, buyer_id, seller_id,
        bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
        total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
      values (
        t_id, r.id, r.vinder_id, r.bruger_id,
        bud, koeb, 0, false, 0,
        bud + koeb, saelg, bud - saelg, now() + interval '48 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Gamle reservationer fra saldo-modellen maa ikke holde paa penge.
  if to_regclass('public.bid_reservations') is not null then
    for r in
      select br.auction_id as id
        from public.bid_reservations br
        join public.auctions a on a.id = br.auction_id
       where a.status <> 'aktiv'
    loop
      begin
        perform public.wallet_frigiv(r.id);
      exception when others then
        raise warning 'wallet_frigiv fejlede for auktion %: %', r.id, sqlerrm;
      end;
    end loop;
  end if;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- ============================================================ 5. spejling

-- Webhook: payment_intent.succeeded. Spejler beloeb og beskyttelse fra Stripe
-- og flytter handlen til 'betaling_modtaget'. Idempotent: en allerede betalt
-- betaling roeres ikke.
--
-- Beloebet skal stemme med det, serveren beregnede (med eller uden
-- beskyttelse). Gor det ikke, registreres betalingen IKKE som betalt, og
-- funktionen returnerer 'beloeb_afviger', saa det kan undersoeges.
create or replace function public.betaling_registrer_betalt(
  p_payment_intent text,
  p_charge         text,
  p_beloeb_oere    bigint,
  p_beskyttelse    boolean)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b    record;
  besk bigint;
begin
  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'betalt' then return 'allerede_betalt'; end if;

  besk := case when p_beskyttelse then public.beregn_beskyttelse_oere(b.bud_oere) else 0 end;

  if p_beloeb_oere <> b.bud_oere + b.koebergebyr_oere + b.fragt_oere + besk then
    update public.betalinger
       set sidste_fejl = 'Beloeb fra Stripe (' || p_beloeb_oere || ') stemmer ikke',
           opdateret = now()
     where id = b.id;
    return 'beloeb_afviger';
  end if;

  update public.betalinger
     set status = 'betalt',
         beskyttelse = p_beskyttelse,
         beskyttelse_oere = besk,
         total_oere = p_beloeb_oere,
         stripe_charge_id = p_charge,
         betalt_kl = now(),
         sidste_fejl = null,
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'betaling_modtaget'
   where id = b.trade_id and status = 'afventer_betaling';

  return 'betalt';
end;
$fn$;

revoke all on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  to service_role;

-- Koeberen vaelger BidHamr Beskyttelse til/fra, foer han betaler. Kaldes af
-- serveren, EFTER Stripe har accepteret det nye beloeb paa PaymentIntenten.
create or replace function public.betaling_saet_beskyttelse(
  p_betaling uuid, p_beskyttelse boolean)
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  b    record;
  besk bigint;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.status not in ('afventer', 'behandles') then
    return null;
  end if;

  besk := case when p_beskyttelse then public.beregn_beskyttelse_oere(b.bud_oere) else 0 end;

  update public.betalinger
     set beskyttelse = p_beskyttelse,
         beskyttelse_oere = besk,
         total_oere = bud_oere + koebergebyr_oere + fragt_oere + besk,
         opdateret = now()
   where id = b.id;

  return b.bud_oere + b.koebergebyr_oere + b.fragt_oere + besk;
end;
$fn$;

revoke all on function public.betaling_saet_beskyttelse(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.betaling_saet_beskyttelse(uuid, boolean) to service_role;

-- Koeberen godkender varen (modtaget -> leveret) i den nye model. Erstatter
-- wallet_udbetal_saelger i godkend-flowet: ingen saldo bogfoeres; i stedet
-- markeres betalingen som frigivet, og serveren opretter Stripe-overfoerslen.
-- Koeberen udledes af auth.uid().
create or replace function public.handel_godkend(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder uuid := auth.uid();
  t      record;
begin
  if kalder is null then return false; end if;

  -- Kun handler, hvor Stripe har bekraeftet betalingen, kan godkendes.
  if not exists (
    select 1 from public.betalinger
     where trade_id = p_trade and status = 'betalt'
  ) then
    return false;
  end if;

  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'modtaget'
     and buyer_id = kalder
  returning * into t;

  if not found then return false; end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where trade_id = p_trade and frigivet_kl is null;

  return true;
end;
$fn$;

revoke all on function public.handel_godkend(uuid) from public, anon;
grant execute on function public.handel_godkend(uuid) to authenticated;
