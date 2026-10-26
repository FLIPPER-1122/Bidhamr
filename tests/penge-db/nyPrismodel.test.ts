// Migrationen 20261031010000_ny_prismodel.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Stubs af de tabeller, migrationen bygger
// på, og de RIGTIGE funktioner fra repoets migrationer (så md5-drift-tjekket
// og mønstrene i ps_ret prøves mod den kode, der ligger i databaserne).
// Migrationen køres TO gange (idempotent). Derefter testes: gebyrfunktionerne
// (og at TypeScript-spejlet i beregn.ts giver det samme), nye betalinger fra
// afslut_udloebne_auktioner og "tilbud til næste byder" (forsendelse,
// afhentning, erhverv), Beskyttelse ved skift af leveringsform, CHECK-
// formlerne, gamle rækker uændret, beløbsloftet (25.000 kr.), fragtpriserne,
// refusion ved medhold i en sag (kun buddet i den nye model), og at en sælger
// højst får én udbetaling pr. 14 dage.
// Rettelserne (20261031020000_prismodel_rettelser.sql, også kørt to gange):
// samme kørsel må lave flere payouts, til køen er tom (B1), og cron'ens liste
// over sælgere, der er klar (B2).
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  forventetTotalOere,
  koebergebyrOere,
  koeberTotalOere,
  saelgergebyrOere,
  sagRefusionOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";

const MIG = path.resolve(import.meta.dirname, "../../supabase/migrations");
const MIGRATION = readFileSync(path.join(MIG, "20261031010000_ny_prismodel.sql"), "utf8");
const RETTELSER = readFileSync(path.join(MIG, "20261031020000_prismodel_rettelser.sql"), "utf8");
const FIX = path.resolve(import.meta.dirname, "fixtures");

// "create or replace function <start>..." til og med det afsluttende dollar-tag.
function funktion(fil: string, start: string): string {
  const t = readFileSync(path.join(MIG, fil), "utf8").replace(/\r/g, "");
  const i = t.indexOf(start);
  if (i < 0) throw new Error(`${start} findes ikke i ${fil}`);
  const rest = t.slice(i);
  const m = rest.match(/\bas\s+(\$[a-zA-Z_]*\$)/i);
  if (!m || m.index === undefined) throw new Error("intet dollar-tag");
  const slut = rest.indexOf(m[1], m.index + m[0].length);
  return rest.slice(0, slut + m[1].length) + ";\n";
}

const SAELGER = "00000000-0000-4000-8000-0000000000b1";
const KOEBER = "00000000-0000-4000-8000-0000000000a1";
const KOEBER2 = "00000000-0000-4000-8000-0000000000a2";

const STUB = `
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
const RIGTIGE = [
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

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

async function nyAuktion(o: {
  forsendelse?: boolean;
  erhverv?: boolean;
  stoerrelse?: string;
  bud?: number;
  koeber?: string;
  saelger?: string;
}): Promise<string> {
  const { id } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, forsendelse_mulig, erhverv, pakkestoerrelse, slutter_kl)
     values ($1, $2, $3, $4, now() - interval '1 minute') returning id`,
    [o.saelger ?? SAELGER, o.forsendelse ?? true, o.erhverv ?? false, o.stoerrelse ?? "lille"],
  );
  if (o.bud) {
    // Byderen vælger "Beskyttelse" - det skal ikke længere betyde noget.
    await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb", beskyttelse) values ($1, $2, $3, true)`, [
      id,
      o.koeber ?? KOEBER,
      o.bud,
    ]);
  }
  return id;
}

type Betaling = {
  id: string;
  prismodel: string;
  bud_oere: string;
  koebergebyr_oere: string;
  saelgergebyr_oere: string;
  fragt_oere: string;
  beskyttelse: boolean;
  beskyttelse_oere: string;
  total_oere: string;
  udbetaling_oere: string;
};

async function betalingFor(auktion: string): Promise<Betaling> {
  return en<Betaling>(`select * from public.betalinger where auction_id = $1`, [auktion]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(RIGTIGE);
  // En gammel betaling (før migrationen): 5 %/5 % + tilkøbt Beskyttelse.
  const { id: a } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, status, pakkestoerrelse) values ($1, 'afsluttet', 'lille') returning id`,
    [SAELGER],
  );
  const { id: t } = await en<{ id: string }>(
    `insert into public.trades (auction_id, seller_id, buyer_id, amount, status) values ($1, $2, $3, 1000, 'betaling_modtaget') returning id`,
    [a, SAELGER, KOEBER],
  );
  await db.query(
    `insert into public.betalinger (trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere,
       beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere, status)
     values ($1, $2, $3, $4, 100000, 5000, 4000, true, 5000, 114000, 5000, 95000, 'betalt')`,
    [t, a, KOEBER, SAELGER],
  );
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(RETTELSER);
  await db.exec(RETTELSER);
}, 60_000);

describe("gebyrfunktionerne", () => {
  const tabel: [number, number, number][] = [
    // [bud kr., købergebyr øre, sælgergebyr øre]
    [100, 1200, 1000],
    [200, 1900, 1500],
    [7500, 30000, 9500],
    [7501, 24003, 16502],
    [10000, 31500, 21500],
    [25000, 65000, 45000],
  ];
  it.each(tabel)("%d kr.: køber %d øre, sælger %d øre (SQL og TS)", async (kr, koeb, saelg) => {
    const r = await en<{ k: string; s: string }>(
      `select public.koebergebyr_oere($1, false) as k, public.saelgergebyr_oere($1, false) as s`,
      [kr * 100],
    );
    expect(Number(r.k)).toBe(koeb);
    expect(Number(r.s)).toBe(saelg);
    expect(koebergebyrOere(kr * 100, false)).toBe(koeb);
    expect(saelgergebyrOere(kr * 100, false)).toBe(saelg);
    expect(udbetalingOere(kr * 100, false)).toBe(kr * 100 - saelg);
  });

  it("erhverv: 5 % / 5 % uden min/maks", async () => {
    const r = await en<{ k: string; s: string }>(
      `select public.koebergebyr_oere(2500000, true) as k, public.saelgergebyr_oere(1001, true) as s`,
    );
    expect(Number(r.k)).toBe(125000);
    expect(Number(r.s)).toBe(50); // 50,05 -> 50
    expect(koebergebyrOere(2_500_000, true)).toBe(125000);
    expect(saelgergebyrOere(1001, true)).toBe(50);
  });

  it("TypeScript-spejlet giver det samme som databasen (inkl. halv op og grænsen)", async () => {
    const beloeb = [1, 50, 99, 150, 333, 749_999, 750_000, 750_001, 750_050, 750_150, 1_234_567, 2_166_650, 2_500_000];
    for (let x = 100; x < 2_500_000; x += 7_919) beloeb.push(x);
    const r = await db.query<{ b: string; k: string; s: string; ke: string; se: string }>(
      `select b, public.koebergebyr_oere(b, false) k, public.saelgergebyr_oere(b, false) s,
              public.koebergebyr_oere(b, true) ke, public.saelgergebyr_oere(b, true) se
         from unnest($1::bigint[]) b`,
      [beloeb],
    );
    for (const x of r.rows) {
      const b = Number(x.b);
      expect([koebergebyrOere(b, false), saelgergebyrOere(b, false), koebergebyrOere(b, true), saelgergebyrOere(b, true)])
        .toEqual([Number(x.k), Number(x.s), Number(x.ke), Number(x.se)]);
    }
  });
});

describe("nye betalinger", () => {
  it("forsendelse (privat): nye gebyrer, beskyttet uden særskilt beløb, ny fragt, application fee passer", async () => {
    const a = await nyAuktion({ bud: 100 });
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await betalingFor(a);
    expect(b.prismodel).toBe("ny");
    expect(Number(b.fragt_oere)).toBe(4200);
    expect(Number(b.koebergebyr_oere)).toBe(1200);
    expect(Number(b.saelgergebyr_oere)).toBe(1000);
    expect(b.beskyttelse).toBe(true);
    expect(Number(b.beskyttelse_oere)).toBe(0);
    expect(Number(b.total_oere)).toBe(10000 + 1200 + 4200);
    expect(Number(b.total_oere)).toBe(koeberTotalOere(10000, false, 4200));
    expect(Number(b.udbetaling_oere)).toBe(9000);
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny" })).toBe(Number(b.total_oere));
    // Forsvar i dybden (20261031020000, S4): et forkert sælgergebyr (eller
    // købergebyr/Beskyttelse) giver null - så betales der ikke.
    expect(forventetTotalOere({ ...tal(b), saelgergebyr_oere: Number(b.saelgergebyr_oere) + 1, prismodel: "ny" })).toBeNull();
    expect(forventetTotalOere({ ...tal(b), koebergebyr_oere: Number(b.koebergebyr_oere) - 1, prismodel: "ny" })).toBeNull();
    expect(forventetTotalOere({ ...tal(b), beskyttelse_oere: 2500, prismodel: "ny" })).toBeNull();
    // Application fee = købergebyr + sælgergebyr + fragt (CHECK betalinger_destination_gebyr_stemmer).
    await db.query(
      `update public.betalinger set application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere where id = $1`,
      [b.id],
    );
    await expect(
      db.query(`update public.betalinger set application_fee_oere = application_fee_oere + 1 where id = $1`, [b.id]),
    ).rejects.toThrow(/gebyr_stemmer/);
  });

  it("afhentning: samme gebyrer, ingen fragt, ingen Beskyttelse", async () => {
    const a = await nyAuktion({ bud: 7501, forsendelse: false });
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await betalingFor(a);
    expect([b.prismodel, Number(b.fragt_oere), b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual(["ny", 0, false, 0]);
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([24003, 16502]);
    expect(Number(b.total_oere)).toBe(750100 + 24003);
  });

  it("erhverv: 5 % / 5 %, ingen Beskyttelse", async () => {
    const a = await nyAuktion({ bud: 25000, erhverv: true, stoerrelse: "stor" });
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await betalingFor(a);
    expect(b.prismodel).toBe("erhverv");
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)]).toEqual([125000, 125000, 6700]);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([false, 0]);
  });

  it("skift mellem afhentning og forsendelse: Beskyttelse følger med; prismodellen kan ikke ændres", async () => {
    const a = await nyAuktion({ bud: 200 });
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await betalingFor(a);
    // Som handel_gem_levering: fragt 0 og beskyttelse = (v_besk > 0) = false.
    await db.query(
      `update public.betalinger set fragt_oere = 0, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere where id = $1`,
      [b.id],
    );
    expect((await betalingFor(a)).beskyttelse).toBe(false);
    await db.query(
      `update public.betalinger set fragt_oere = 4200, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere + 4200,
              prismodel = 'gammel' where id = $1`,
      [b.id],
    );
    const efter = await betalingFor(a);
    expect([efter.beskyttelse, efter.prismodel]).toEqual([true, "ny"]);
    // Forkert gebyr på en ny række afvises.
    await expect(
      db.query(
        `update public.betalinger set koebergebyr_oere = round(bud_oere * 5 / 100.0), total_oere = bud_oere + round(bud_oere * 5 / 100.0) + fragt_oere where id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/koebergebyr_formel/);
  });

  it("kalderens beløb ignoreres ved oprettelse (5 % og Beskyttelse-tilkøb bliver til den nye model)", async () => {
    const a = await nyAuktion({});
    const { id: t } = await en<{ id: string }>(
      `insert into public.trades (auction_id, seller_id, buyer_id, amount, status) values ($1, $2, $3, 300, 'afventer_betaling') returning id`,
      [a, SAELGER, KOEBER],
    );
    await db.query(
      `insert into public.betalinger (trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere,
         beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere, prismodel)
       values ($1, $2, $3, $4, 30000, 1500, 3500, true, 2500, 37500, 1500, 28500, 'gammel')`,
      [t, a, KOEBER, SAELGER],
    );
    const b = await betalingFor(a);
    expect(b.prismodel).toBe("ny");
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.beskyttelse_oere), Number(b.fragt_oere)])
      .toEqual([2600, 2000, 0, 4200]);
    expect(Number(b.total_oere)).toBe(30000 + 2600 + 4200);
  });

  it("tilbud til næste byder: nye gebyrer, tilbuddets Beskyttelse-valg ignoreres", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, status, forsendelse_mulig, pakkestoerrelse) values ($1, 'afsluttet', true, 'mellem') returning id`,
      [SAELGER],
    );
    const { id: x } = await en<{ id: string }>(
      `insert into public.andenchance_tilbud (auction_id, seller_id, byder_id, bud_oere, beskyttelse)
       values ($1, $2, $3, 1000000, true) returning id`,
      [a, SAELGER, KOEBER2],
    );
    const svar = await en<{ r: { kode: string } }>(`select public.andenchance_svar($1, $2, true) as r`, [x, KOEBER2]);
    expect(svar.r.kode).toBe("ok");
    const b = await betalingFor(a);
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)])
      .toEqual(["ny", 31500, 21500, 5200]);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([true, 0]);
  });

  it("gamle betalinger er uændrede", async () => {
    const b = await en<Betaling>(`select * from public.betalinger where prismodel = 'gammel'`);
    expect([Number(b.koebergebyr_oere), Number(b.beskyttelse_oere), Number(b.total_oere)]).toEqual([5000, 5000, 114000]);
    expect(forventetTotalOere({ ...tal(b), prismodel: "gammel" })).toBe(114000);
    expect(forventetTotalOere({ ...tal(b), saelgergebyr_oere: 4999, prismodel: "gammel" })).toBeNull();
    // Constrainterne er gyldige (også på de gamle rækker).
    const c = await db.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where conname like 'betalinger_%_formel' order by 1`,
    );
    expect(c.rows.map((r) => r.convalidated)).toEqual([true, true, true]);
  });
});

describe("refusion ved medhold i en sag", () => {
  it("ny model: kun buddet; gammel model: alt undtagen Beskyttelse", async () => {
    const ny = await en<{ id: string; bud_oere: string; total_oere: string }>(
      `select id, bud_oere, total_oere from public.betalinger where prismodel = 'ny' and fragt_oere > 0 limit 1`,
    );
    await db.query(`update public.betalinger set status = 'betalt' where id = $1`, [ny.id]);
    const r1 = await en<{ beloeb: string; fejl: string | null }>(`select * from public.sag_claim_refusion($1)`, [ny.id]);
    expect(Number(r1.beloeb)).toBe(Number(ny.bud_oere));
    const gl = await en<{ id: string }>(`select id from public.betalinger where prismodel = 'gammel'`);
    const r2 = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [gl.id]);
    expect(Number(r2.beloeb)).toBe(114000 - 5000);
    expect(sagRefusionOere({ prismodel: "ny", bud_oere: 10000, total_oere: 15400, beskyttelse_oere: 0 })).toBe(10000);
    expect(sagRefusionOere({ prismodel: "gammel", bud_oere: 100000, total_oere: 114000, beskyttelse_oere: 5000 })).toBe(109000);
    expect(sagRefusionOere({ prismodel: "erhverv", bud_oere: 100000, total_oere: 110000, beskyttelse_oere: 0 })).toBe(110000);
  });

  it("BidHamr dækker, fakturaer og saet_maksimum er rettet", async () => {
    const r = await db.query<{ f: string }>(
      `select pg_get_functiondef(p.oid) f from pg_proc p where p.proname in
         ('betaling_bidhamr_daekker_claim', 'faktura_planlaeg', 'saet_maksimum', 'handel_udbetalingsstatus')`,
    );
    const alle = r.rows.map((x) => x.f).join("\n");
    expect(alle).toContain("public.sag_refusion_oere(b.prismodel");
    expect(alle).toContain("public.faktura_koebergebyr_tekst(rb.prismodel, rb.beskyttelse)");
    expect(alle).not.toContain("beskyttelse_laast");
    expect(alle).toContain("public.saelger_naeste_udbetaling_kl(b.seller_id)");
    const t = await en<{ a: string; b: string; c: string; d: string; e: string }>(
      `select public.faktura_koebergebyr_tekst('ny', true) a, public.faktura_koebergebyr_tekst('ny', false) b,
              public.faktura_koebergebyr_tekst('gammel', true) c, public.faktura_saelgergebyr_tekst('ny') d,
              public.faktura_saelgergebyr_tekst('gammel') e`,
    );
    expect(t).toEqual({
      a: "Gebyr (inkl. BidHamr Beskyttelse)",
      b: "Gebyr",
      c: "Købergebyr (5 %)",
      d: "Sælgergebyr",
      e: "Sælgergebyr (5 %)",
    });
  });
});

describe("beløbsloft 25.000 kr.", () => {
  it("bud, startpris og maksimum over loftet afvises; præcis 25.000 er tilladt", async () => {
    const { id: a } = await en<{ id: string }>(`insert into public.auctions (bruger_id, startpris) values ($1, 25000) returning id`, [SAELGER]);
    await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, 25000)`, [a, KOEBER]);
    await expect(
      db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, 25001)`, [a, KOEBER]),
    ).rejects.toThrow("Det højeste tilladte bud er 25.000 kr.");
    await expect(db.query(`insert into public.auctions (bruger_id, startpris) values ($1, 25001)`, [SAELGER])).rejects.toThrow(
      "Startprisen kan højst være 25.000 kr.",
    );
    await expect(
      db.query(`insert into public.bud_maksimum (auktion_id, bruger_id, maks_beloeb) values ($1, $2, 30000)`, [a, KOEBER]),
    ).rejects.toThrow("Dit maksimum kan højst være 25.000 kr.");
  });

  it("gamle værdier over loftet blokerer ikke andre ændringer", async () => {
    await db.exec(`alter table public.auctions disable trigger beloebsloft_auktion`);
    const { id: a } = await en<{ id: string }>(`insert into public.auctions (bruger_id, startpris) values ($1, 400000) returning id`, [SAELGER]);
    await db.exec(`alter table public.auctions enable trigger beloebsloft_auktion`);
    await db.query(`update public.auctions set titel = 'ny titel', startpris = startpris where id = $1`, [a]);
    await expect(db.query(`update public.auctions set startpris = 300000 where id = $1`, [a])).rejects.toThrow(/25.000/);
  });
});

describe("fragt 42 / 52 / 67 kr.", () => {
  it("tabellen og auktioner uden handel har de nye priser; dør-priserne er uændrede", async () => {
    const p = await db.query<{ kode: string; pakkeshop_oere: number; doer_oere: number | null }>(
      `select kode, pakkeshop_oere, doer_oere from public.fragt_pakkestoerrelser order by sortering`,
    );
    expect(p.rows.map((r) => [r.kode, r.pakkeshop_oere, r.doer_oere])).toEqual([
      ["lille", 4200, 6000],
      ["mellem", 5200, 8500],
      ["stor", 6700, null],
    ]);
  });

  it("overgangen: aktive auktioner med gammel pris opdateres, solgte røres ikke", async () => {
    const m2 = new PGlite();
    await m2.exec(STUB);
    await m2.exec(RIGTIGE);
    const aktiv = (await m2.query<{ id: string }>(`insert into public.auctions (bruger_id, pakkestoerrelse) values ($1, 'mellem') returning id`, [SAELGER])).rows[0].id;
    const solgt = (await m2.query<{ id: string }>(`insert into public.auctions (bruger_id, pakkestoerrelse, status) values ($1, 'lille', 'afsluttet') returning id`, [SAELGER])).rows[0].id;
    await m2.query(`insert into public.trades (auction_id, seller_id, buyer_id, amount, status) values ($1, $2, $3, 10, 'betaling_modtaget')`, [solgt, SAELGER, KOEBER]);
    await m2.exec(MIGRATION);
    const r = await m2.query<{ id: string; fragt_pakkeshop_oere: number }>(`select id, fragt_pakkeshop_oere from public.auctions`);
    const pris = new Map(r.rows.map((x) => [x.id, x.fragt_pakkeshop_oere]));
    expect(pris.get(aktiv)).toBe(5200);
    expect(pris.get(solgt)).toBe(4000);
    await m2.close();
  }, 60_000);
});

describe("udbetaling hver 14. dag", () => {
  async function frigivet(saelger = SAELGER, frigivetKl = "now()"): Promise<string> {
    const a = await nyAuktion({ bud: 500, saelger });
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await betalingFor(a);
    await db.query(
      `update public.betalinger set status = 'betalt', frigivet_kl = ${frigivetKl}, saelger_stripe_konto = 'acct_test',
              midler_tilgaengelige_kl = now() - interval '1 hour' where id = $1`,
      [b.id],
    );
    return b.id;
  }

  type Claim = { kode: string; udbetaling_id?: string; naeste_kl?: string };
  async function claim(saelger: string, betaling: string, koersel: string | null): Promise<Claim> {
    const r = await en<{ r: Claim }>(
      `select public.saelger_udbetaling_claim($1, 'acct_test', array[$2]::uuid[], $3::uuid) as r`,
      [saelger, betaling, koersel],
    );
    return r.r;
  }
  // Som registrerOprettet (payouten er oprettet hos Stripe).
  async function oprettet(id: string, oprettetKl = "now()"): Promise<void> {
    await db.query(`update public.saelger_udbetalinger set status = 'oprettet', oprettet = ${oprettetKl} where id = $1`, [id]);
  }

  it("første udbetaling straks; derefter tidligst 14 dage efter den seneste", async () => {
    const b1 = await frigivet();
    const c1 = await en<{ r: { kode: string; udbetaling_id: string } }>(
      `select public.saelger_udbetaling_claim($1, 'acct_test', array[$2]::uuid[]) as r`,
      [SAELGER, b1],
    );
    expect(c1.r.kode).toBe("ok");
    await db.query(`update public.saelger_udbetalinger set status = 'paid', oprettet = now() - interval '3 days' where id = $1`, [
      c1.r.udbetaling_id,
    ]);
    const b2 = await frigivet();
    const c2 = await en<{ r: { kode: string; naeste_kl: string } }>(
      `select public.saelger_udbetaling_claim($1, 'acct_test', array[$2]::uuid[]) as r`,
      [SAELGER, b2],
    );
    expect(c2.r.kode).toBe("interval");
    // Intet er låst.
    expect((await en<{ u: string | null }>(`select saelger_udbetaling_id u from public.betalinger where id = $1`, [b2])).u).toBeNull();
    // En fejlet udbetaling tæller ikke; en ældre end 14 dage heller ikke.
    await db.query(`update public.saelger_udbetalinger set oprettet = now() - interval '14 days 1 minute' where id = $1`, [
      c1.r.udbetaling_id,
    ]);
    const c3 = await en<{ r: { kode: string } }>(
      `select public.saelger_udbetaling_claim($1, 'acct_test', array[$2]::uuid[]) as r`,
      [SAELGER, b2],
    );
    expect(c3.r.kode).toBe("ok");
  });

  it("samme kørsel fortsætter, til køen er tom; en anden kørsel og et kald uden kørsel afvises", async () => {
    const S = "00000000-0000-4000-8000-0000000000b2";
    const k1 = "00000000-0000-4000-8000-00000000c001";
    const k2 = "00000000-0000-4000-8000-00000000c002";
    const [b1, b2, b3, b4] = [await frigivet(S), await frigivet(S), await frigivet(S), await frigivet(S)];
    const c1 = await claim(S, b1, k1);
    expect(c1.kode).toBe("ok");
    // Endnu ikke oprettet hos Stripe: en uafklaret claim stopper også samme kørsel.
    expect((await claim(S, b2, k1)).kode).toBe("i_gang");
    await oprettet(c1.udbetaling_id!, "now() - interval '10 minutes'");
    const c2 = await claim(S, b2, k1);
    expect(c2.kode).toBe("ok");
    await oprettet(c2.udbetaling_id!);
    // Andre kørsler (cron, webhook) og kald uden kørsel: intervallet gælder.
    expect((await claim(S, b3, k2)).kode).toBe("interval");
    expect((await claim(S, b3, null)).kode).toBe("interval");
    // Kørslens første payout er over 1 time gammel: kørslen må ikke fortsætte.
    await db.query(`update public.saelger_udbetalinger set oprettet = now() - interval '1 day' where id = $1`, [
      c1.udbetaling_id,
    ]);
    expect((await claim(S, b3, k1)).kode).toBe("interval");
    // Intervallet regnes fra kørslens FØRSTE payout (for 1 dag siden), ikke den seneste (nu).
    const n = await en<{ dage: string }>(
      `select round(extract(epoch from public.saelger_naeste_udbetaling_kl($1) - now()) / 86400) as dage`,
      [S],
    );
    expect(Number(n.dage)).toBe(13);
    await db.query(`update public.saelger_udbetalinger set oprettet = now() - interval '10 minutes' where id = $1`, [
      c1.udbetaling_id,
    ]);
    const c3 = await claim(S, b3, k1);
    expect(c3.kode).toBe("ok");
    await oprettet(c3.udbetaling_id!);
    // En payout fra en ANDEN kørsel inden for 14 dage: heller ikke samme kørsel må fortsætte.
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, oprettet)
       values ($1, 'acct_test', 1, 'dkk', 'paid', '{}', now() - interval '13 days')`,
      [S],
    );
    expect((await claim(S, b4, k1)).kode).toBe("interval");
    expect((await en<{ u: string | null }>(`select saelger_udbetaling_id u from public.betalinger where id = $1`, [b4])).u).toBeNull();
  });

  it("højst 20 payouts pr. kørsel", async () => {
    const S = "00000000-0000-4000-8000-0000000000b3";
    const k = "00000000-0000-4000-8000-00000000c003";
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, koersel)
       select $1, 'acct_test', 1, 'dkk', 'oprettet', '{}', $2::uuid from generate_series(1, 20)`,
      [S, k],
    );
    expect((await claim(S, await frigivet(S), k)).kode).toBe("interval");
    // 19: kørslen må lave den 20.
    await db.query(
      `update public.saelger_udbetalinger set status = 'failed' where id = (select id from public.saelger_udbetalinger where koersel = $1 limit 1)`,
      [k],
    );
    expect((await claim(S, await frigivet(S), k)).kode).toBe("ok");
  });

  it("cron'ens liste: kun sælgere uden ventetid, ældste frigivelse først", async () => {
    const nyS = "00000000-0000-4000-8000-0000000000b4";
    const aeldreS = "00000000-0000-4000-8000-0000000000b5";
    const ikkeKlarS = "00000000-0000-4000-8000-0000000000b6";
    await frigivet(nyS, "now() - interval '1 day'");
    await frigivet(aeldreS, "now() - interval '5 days'");
    // Midlerne er ikke tilgængelige endnu: tæller ikke.
    const ikkeKlar = await frigivet(ikkeKlarS);
    await db.query(`update public.betalinger set midler_tilgaengelige_kl = now() + interval '1 day' where id = $1`, [ikkeKlar]);
    const r = await db.query<{ seller_id: string }>(`select seller_id from public.saelgere_klar_til_udbetaling(500)`);
    const liste = r.rows.map((x) => x.seller_id);
    // b2 og b3 har ventetid (payouts inden for 14 dage).
    expect(liste).not.toContain("00000000-0000-4000-8000-0000000000b2");
    expect(liste).not.toContain("00000000-0000-4000-8000-0000000000b3");
    expect(liste).not.toContain(ikkeKlarS);
    expect(liste.indexOf(aeldreS)).toBeGreaterThanOrEqual(0);
    expect(liste.indexOf(aeldreS)).toBeLessThan(liste.indexOf(nyS));
    const en1 = await db.query<{ seller_id: string }>(`select seller_id from public.saelgere_klar_til_udbetaling(1)`);
    expect(en1.rows.length).toBe(1);
  });
});

function tal(b: Betaling) {
  return {
    bud_oere: Number(b.bud_oere),
    koebergebyr_oere: Number(b.koebergebyr_oere),
    saelgergebyr_oere: Number(b.saelgergebyr_oere),
    fragt_oere: Number(b.fragt_oere),
    beskyttelse_oere: Number(b.beskyttelse_oere),
  };
}
