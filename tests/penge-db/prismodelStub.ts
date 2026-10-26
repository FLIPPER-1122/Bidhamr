// Fælles opsætning for prismodel-testene (20261031010000 ff.) i PGlite: stubs
// af de tabeller, migrationerne bygger på, og de RIGTIGE funktioner fra
// repoets migrationer. Bruges af nyPrismodel.test.ts og
// erhvervUdenSaelgergebyr.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";

export const MIG = path.resolve(import.meta.dirname, "../../supabase/migrations");
export const MIGRATION = readFileSync(path.join(MIG, "20261031010000_ny_prismodel.sql"), "utf8");
export const RETTELSER = readFileSync(path.join(MIG, "20261031020000_prismodel_rettelser.sql"), "utf8");
export const FORTSAET = readFileSync(path.join(MIG, "20261031030000_udbetaling_fortsaet.sql"), "utf8");
export const FIX = path.resolve(import.meta.dirname, "fixtures");

// "create or replace function <start>..." til og med det afsluttende dollar-tag.
export function funktion(fil: string, start: string): string {
  const t = readFileSync(path.join(MIG, fil), "utf8").replace(/\r/g, "");
  const i = t.indexOf(start);
  if (i < 0) throw new Error(`${start} findes ikke i ${fil}`);
  const rest = t.slice(i);
  const m = rest.match(/\bas\s+(\$[a-zA-Z_]*\$)/i);
  if (!m || m.index === undefined) throw new Error("intet dollar-tag");
  const slut = rest.indexOf(m[1], m.index + m[0].length);
  return rest.slice(0, slut + m[1].length) + ";\n";
}

export const SAELGER = "00000000-0000-4000-8000-0000000000b1";
export const KOEBER = "00000000-0000-4000-8000-0000000000a1";
export const KOEBER2 = "00000000-0000-4000-8000-0000000000a2";

export const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select null::text $$;
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger',
  suspenderet boolean not null default false, suspenderet_til timestamptz, konto_type text default 'privat');
insert into public.users (id, navn) values ('${SAELGER}', 'Sælger'), ('${KOEBER}', 'Køber'), ('${KOEBER2}', 'Køber 2');
create table public.fragt_pakkestoerrelser (kode text primary key, navn text not null, maks_gram integer not null,
  pakkeshop_oere integer not null, doer_oere integer, sortering integer not null default 0);
insert into public.fragt_pakkestoerrelser values ('lille', 'Lille', 1000, 4000, 6000, 1),
  ('mellem', 'Mellem', 5000, 5000, 8500, 2), ('stor', 'Stor', 15000, 6500, null, 3);
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid not null,
  vinder_id uuid, status text not null default 'aktiv', slutter_kl timestamptz not null default now() + interval '1 day',
  pauset_kl timestamptz, skjult boolean default false, forsendelse_mulig boolean default true,
  afhentning_mulig boolean default false, erhverv boolean not null default false, startpris numeric default 1,
  titel text, pakkestoerrelse text, fragt_pakkeshop_oere integer, fragt_doer_oere integer, "nuværende_bud" numeric);
-- Som repoets naeste_bud_minimum (budstigningen forenklet til 1 kr.).
create function public.naeste_bud_minimum(p_nuvaerende numeric, p_startpris numeric) returns numeric
  language sql immutable as $$ select case when p_nuvaerende is null then greatest(ceil(coalesce(p_startpris, 0)), 3)
                                           else p_nuvaerende + 1 end $$;
-- Som auctions_fragt: en UPDATE uden ændret forsendelse/størrelse bevarer den låste pris.
create function public.auctions_fragt() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.pakkestoerrelse is not distinct from old.pakkestoerrelse
     and new.forsendelse_mulig is not distinct from old.forsendelse_mulig then
    new.fragt_pakkeshop_oere := old.fragt_pakkeshop_oere;
    new.fragt_doer_oere := old.fragt_doer_oere;
    return new;
  end if;
  if not coalesce(new.forsendelse_mulig, false) then
    new.fragt_pakkeshop_oere := null; new.fragt_doer_oere := null; return new;
  end if;
  new.pakkestoerrelse := coalesce(new.pakkestoerrelse, 'mellem');
  select pakkeshop_oere, doer_oere into new.fragt_pakkeshop_oere, new.fragt_doer_oere
    from public.fragt_pakkestoerrelser where kode = new.pakkestoerrelse;
  return new;
end $$;
create trigger auctions_fragt before insert or update on public.auctions
  for each row execute function public.auctions_fragt();
create table public.bids (id uuid primary key default gen_random_uuid(), auktion_id uuid not null, bruger_id uuid not null,
  "beløb" numeric not null, oprettet timestamptz not null default clock_timestamp(), beskyttelse boolean default false,
  automatisk boolean default false, auktion_redigeret_kl timestamptz);
create table public.bud_maksimum (auktion_id uuid, bruger_id uuid, maks_beloeb numeric, beskyttelse boolean,
  primary key (auktion_id, bruger_id));
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid not null, seller_id uuid,
  buyer_id uuid, amount numeric, status text not null, afhentning boolean default false);
create unique index trades_auktion_aktiv on public.trades (auction_id) where status <> 'annulleret';
create table public.genopsaetninger (gammel_auction_id uuid, ny_auction_id uuid);
create table public.andenchance_tilbud (id uuid primary key default gen_random_uuid(), auction_id uuid, seller_id uuid,
  byder_id uuid, bud_oere bigint, beskyttelse boolean default false, status text default 'afventer',
  udloeber timestamptz default now() + interval '1 day', besvaret_kl timestamptz, ny_trade_id uuid);
create table public.betalinger (
  id uuid primary key default gen_random_uuid(), trade_id uuid unique, auction_id uuid, buyer_id uuid, seller_id uuid,
  bud_oere bigint not null, koebergebyr_oere bigint not null, fragt_oere bigint not null default 0,
  beskyttelse boolean not null default false, beskyttelse_oere bigint not null default 0,
  total_oere bigint not null, saelgergebyr_oere bigint not null, udbetaling_oere bigint not null,
  status text not null default 'afventer', betal_senest timestamptz not null default now() + interval '48 hours',
  pengemodel text not null default 'destination', application_fee_oere bigint, saelger_stripe_konto text,
  saelger_udbetaling_id uuid, overfoersel_paabegyndt_kl timestamptz, stripe_transfer_id text,
  refusion_anmodet_kl timestamptz, refusion_aarsag text, refusion_oere bigint, indsigelse_kl timestamptz,
  indsigelse_status text, frigivet_kl timestamptz, oprettet timestamptz default now(), opdateret timestamptz default now(),
  midler_tilgaengelige_kl timestamptz, udbetal_tidligst timestamptz, kraever_opmaerksomhed boolean not null default false,
  constraint betalinger_total_stemmer check (total_oere = bud_oere + koebergebyr_oere + fragt_oere + beskyttelse_oere),
  constraint betalinger_beskyttelse_stemmer check (beskyttelse or beskyttelse_oere = 0),
  constraint betalinger_udbetaling_stemmer check (udbetaling_oere = bud_oere - saelgergebyr_oere),
  constraint betalinger_destination_gebyr_stemmer check (pengemodel <> 'destination' or application_fee_oere is null or (
    application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere
    and total_oere - application_fee_oere = udbetaling_oere)),
  constraint betalinger_koebergebyr_formel check (pengemodel = 'separat' or koebergebyr_oere = round(bud_oere * 5 / 100.0)),
  constraint betalinger_saelgergebyr_formel check (pengemodel = 'separat' or saelgergebyr_oere = round(bud_oere * 5 / 100.0)),
  constraint betalinger_beskyttelse_formel check (pengemodel = 'separat' or beskyttelse_oere = 0
    or beskyttelse_oere = least(greatest(round(bud_oere * 5 / 100.0), 2500), 25000)));
create table public.saelger_udbetalinger (id uuid primary key default gen_random_uuid(), seller_id uuid,
  stripe_konto text, beloeb_oere bigint, valuta text, status text, betaling_ids uuid[],
  oprettet timestamptz not null default now());
create table public.betalingsprofiler (user_id uuid primary key, udbetaling_frosset_kl timestamptz);
create table public.sager (id uuid primary key default gen_random_uuid(), trade_id uuid, penge_handling text, afviklet_kl timestamptz);
create function public.udbetalinger_stoppet() returns boolean language sql as $$ select false $$;
create function public.betaling_udbetaling_blokeret(p_betaling uuid) returns text language sql as $$ select null::text $$;
create function public.betaling_indsigelse_blokerer(p_kl timestamptz, p_status text) returns boolean language sql
  as $$ select p_kl is not null $$;
create function public.beregn_beskyttelse_oere(p_bud_oere bigint) returns bigint language sql immutable
  as $$ select least(greatest(round(p_bud_oere * 5 / 100.0)::bigint, 2500), 25000) $$;
-- Beløbsloftets triggere (funktionerne erstattes af migrationen).
create function public.beloebsloft_auktion() returns trigger language plpgsql as $$ begin return new; end $$;
create function public.beloebsloft_bud() returns trigger language plpgsql as $$ begin return new; end $$;
create function public.beloebsloft_maksimum() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger beloebsloft_auktion before insert or update of startpris on public.auctions
  for each row execute function public.beloebsloft_auktion();
create trigger beloebsloft_bud before insert on public.bids for each row execute function public.beloebsloft_bud();
create trigger beloebsloft_maksimum before insert or update of maks_beloeb on public.bud_maksimum
  for each row execute function public.beloebsloft_maksimum();
`;

// De rigtige funktioner (nyeste version i repoet).
export const RIGTIGE = [
  funktion("20261012010000_fragt_dao_shipmondo.sql", "create or replace function public.betalinger_a_fragtpris()"),
  `create trigger betalinger_a_fragtpris before insert on public.betalinger
     for each row execute function public.betalinger_a_fragtpris();`,
  funktion("20261010031000_erhverv_rettelser.sql", "create or replace function public.betalinger_beskyttelse_kun_afhentning()"),
  `create trigger betalinger_beskyttelse_kun_afhentning before insert on public.betalinger
     for each row execute function public.betalinger_beskyttelse_kun_afhentning();`,
  funktion("20261009040000_skjult_auktion_pause.sql", "create or replace function public.afslut_udloebne_auktioner()"),
  funktion("20261005010000_betalingsfrist.sql", "create or replace function public.andenchance_svar("),
  funktion("20261010030000_erhverv.sql", "create or replace function public.saet_maksimum("),
  funktion("20261019010000_pengesikkerhed.sql", "create or replace function public.betaling_bidhamr_daekker_claim("),
  funktion("20261019010000_pengesikkerhed.sql", "create or replace function public.saelger_udbetaling_claim("),
  funktion("20261019010000_pengesikkerhed.sql", "create or replace function public.handel_udbetalingsstatus("),
  readFileSync(path.join(FIX, "faktura_planlaeg_20261019010000.sql"), "utf8"),
  readFileSync(path.join(FIX, "sag_claim_refusion_20261011010000.sql"), "utf8"),
].join("\n");
