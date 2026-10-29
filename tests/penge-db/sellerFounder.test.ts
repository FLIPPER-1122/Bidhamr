// Migrationen 20261102420000_seller_founder.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Samme opsætning som
// glidendeGebyrer.test.ts (stubs + de rigtige funktioner + prismodel-
// migrationerne), derefter 20261102140000 og så denne (to gange - idempotent).
// Testes: beregningen ved 0 %, 50 % og 100 % (også over 7.500 kr.) i SQL og
// TypeScript; månedsgrænsen (måned 6 -> 7) i dansk tid; at rabatten låses på
// betalingen og ikke kan ændres; erhverv og firmaer får aldrig rabat; kun
// chefen kan oprette/ændre/stoppe (og det logges); ingen gebyrfaktura ved
// 0 kr.; refusion (sag = buddet, application fee 0) og drift-tjekket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applicationFeeOere,
  danskDato,
  forventetTotalOere,
  founderFriTil,
  founderGebyrOere,
  founderHalvFra,
  founderRabatPct,
  koebergebyrForPrismodel,
  koebergebyrOere,
  koeberTotalOere,
  saelgergebyrForPrismodel,
  saelgergebyrOere,
  sagRefusionOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";
import { FORTSAET, funktion, KOEBER, MIG, MIGRATION, RETTELSER, RIGTIGE, SAELGER, STUB } from "./prismodelStub";

const ERHVERV2 = readFileSync(path.join(MIG, "20261101010000_erhverv_intet_saelgergebyr.sql"), "utf8");
const GLIDENDE = readFileSync(path.join(MIG, "20261102140000_glidende_gebyrer.sql"), "utf8");
const FOUNDER = readFileSync(path.join(MIG, "20261102420000_seller_founder.sql"), "utf8");

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const ADMIN = "00000000-0000-4000-8000-0000000000c2";
const FIRMA = "00000000-0000-4000-8000-0000000000f1";
const FIRMA2 = "00000000-0000-4000-8000-0000000000f2";
const ANDEN = "00000000-0000-4000-8000-0000000000b2";

const FAKTURA_STUB = `
alter table public.betalinger add column betalt_kl timestamptz, add column stripe_application_fee_id text,
  add column stripe_charge_id text, add column stripe_payment_intent_id text, add column refunderet_kl timestamptz,
  add column gebyr_refunderet_kl timestamptz, add column refusion_gebyr_oere bigint, add column stripe_refund_id text,
  add column bidhamr_daekker_refund_id text, add column bidhamr_daekker_oere bigint;
create table public.fakturaer (id uuid primary key default gen_random_uuid(), dokument text not null, part text not null,
  bruger_id uuid not null, betaling_id uuid, trade_id uuid, firma_regning_id uuid, krediterer_id uuid,
  linjer jsonb not null, beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null,
  stripe_reference text, status text not null, manuel boolean not null default false, sidste_fejl text,
  slags text not null default 'salg', laas_til timestamptz, oprettet_kl timestamptz not null default now());
create unique index fakturaer_handel on public.fakturaer (betaling_id, part, dokument, slags) where betaling_id is not null;
create table public.handel_ikke_afhentet (betaling_id uuid, total_oere bigint, koebergebyr_oere bigint,
  beskyttelse_oere bigint, fragt_oere bigint, refusion_oere bigint);
create table public.firmaer (id uuid primary key, bruger_id uuid);
create table public.firma_regninger (id uuid primary key, firma_id uuid, betalt_kl timestamptz, status text,
  beloeb_oere bigint, moms_oere bigint, type text, nummer text, krediteret_kl timestamptz, stripe_invoice_id text);
create function public.faktura_ikke_afhentet_ok(p_betaling uuid) returns boolean language sql as $$ select true $$;
`;

// Det seller founder-migrationen bygger på ud over prismodel-stubben.
const FOUNDER_STUB = `
alter table public.users add column email text, add column konto_slettet_kl timestamptz;
insert into public.users (id, navn, rolle) values ('${CHEF}', 'Chefen', 'chef'), ('${ADMIN}', 'Admin', 'admin');
insert into public.users (id, navn, konto_type) values ('${FIRMA}', 'Firma ApS', 'erhverv'), ('${FIRMA2}', 'Firma 2', 'privat'),
  ('${ANDEN}', 'Anden sælger', 'privat');
insert into public.firmaer (id, bruger_id) values (gen_random_uuid(), '${FIRMA2}');
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now(),
  constraint moderation_log_handling_check check (handling = any ('{advarsel,suspender}'::text[])),
  constraint moderation_log_maal_type_check check (maal_type = any ('{auktion,bruger}'::text[])));
`;

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

type Betaling = {
  id: string;
  trade_id: string;
  prismodel: string;
  founder_rabat_pct: number;
  bud_oere: string;
  koebergebyr_oere: string;
  saelgergebyr_oere: string;
  fragt_oere: string;
  beskyttelse: boolean;
  beskyttelse_oere: string;
  total_oere: string;
  udbetaling_oere: string;
};

function tal(b: Betaling) {
  return {
    bud_oere: Number(b.bud_oere),
    koebergebyr_oere: Number(b.koebergebyr_oere),
    saelgergebyr_oere: Number(b.saelgergebyr_oere),
    fragt_oere: Number(b.fragt_oere),
    beskyttelse_oere: Number(b.beskyttelse_oere),
  };
}

// En udløbet auktion med ét bud (kr.); afslut_udloebne_auktioner laver handel og betaling.
async function solgt(o: { bud: number; saelger?: string; erhverv?: boolean; forsendelse?: boolean }): Promise<Betaling> {
  const { id } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, forsendelse_mulig, afhentning_mulig, erhverv, pakkestoerrelse, slutter_kl)
     values ($1, $2, not $2, $3, 'lille', now() - interval '1 minute') returning id`,
    [o.saelger ?? SAELGER, o.forsendelse ?? true, o.erhverv ?? false],
  );
  await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, $3)`, [id, KOEBER, o.bud]);
  await db.query(`select public.afslut_udloebne_auktioner()`);
  return en<Betaling>(`select * from public.betalinger where auction_id = $1`, [id]);
}

async function hent(id: string): Promise<Betaling> {
  return en<Betaling>(`select * from public.betalinger where id = $1`, [id]);
}

async function kode(sql: string, params: unknown[]): Promise<string> {
  return (await en<{ r: { kode: string } }>(sql, params)).r.kode;
}

// Sælgeren som founder med en bestemt startdato (dansk dato i dag + dage).
async function saetStart(bruger: string, dageFraIDag: number, maaneder = 0): Promise<string> {
  const r = await en<{ d: string }>(
    `update public.seller_founder
        set start_dato = ((now() at time zone 'Europe/Copenhagen')::date + $2::integer - make_interval(months => $3::integer))::date
      where bruger_id = $1 returning to_char(start_dato, 'YYYY-MM-DD') d`,
    [bruger, dageFraIDag, maaneder],
  );
  return r.d;
}

const START = { start_dato: "2026-01-31", stoppet_kl: null };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(RIGTIGE);
  await db.exec(FAKTURA_STUB);
  for (const [fil, start] of [
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_linje("],
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_moms("],
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_sum("],
  ]) {
    await db.exec(funktion(fil, start));
  }
  await db.exec(MIGRATION);
  await db.exec(RETTELSER);
  await db.exec(FORTSAET);
  await db.exec(ERHVERV2);
  await db.exec(GLIDENDE);
  await db.exec(FOUNDER_STUB);
  await db.exec(FOUNDER);
  await db.exec(FOUNDER);
}, 60_000);

describe("beregningen (SQL og TypeScript)", () => {
  // [bud øre, købergebyr ny2, sælgergebyr ny2]
  const tabel: [number, number, number][] = [
    [100, 507, 505], // 1 kr.: ulige øre -> halv op ved 50 %
    [10_000, 1_200, 1_000],
    [100_100, 7_507, 5_505],
    [750_000, 30_000, 9_500], // 7.500 kr.
    [750_100, 30_003, 9_502],
    [900_000, 34_500, 12_500],
    [1_000_000, 37_500, 14_500], // 10.000 kr.
    [2_500_000, 65_000, 44_500], // 25.000 kr. (loftet)
  ];

  it.each(tabel)("%d øre: 0 %, 50 % og 100 % rabat", async (bud, koeb, saelg) => {
    for (const rabat of [0, 50, 100] as const) {
      const fk = Math.round((koeb * (100 - rabat)) / 100);
      const fs = Math.round((saelg * (100 - rabat)) / 100);
      const r = await en<{ k: string; s: string }>(
        `select public.founder_gebyr_oere(public.prismodel_koebergebyr_oere('ny2', $1), $2) k,
                public.founder_gebyr_oere(public.prismodel_saelgergebyr_oere('ny2', $1), $2) s`,
        [bud, rabat],
      );
      expect([Number(r.k), Number(r.s)]).toEqual([fk, fs]);
      expect(koebergebyrForPrismodel("ny2", bud, rabat)).toBe(fk);
      expect(saelgergebyrForPrismodel("ny2", bud, rabat)).toBe(fs);
      expect(koebergebyrOere(bud, false, rabat)).toBe(fk);
      expect(saelgergebyrOere(bud, false, rabat)).toBe(fs);
      expect(udbetalingOere(bud, false, rabat)).toBe(bud - fs);
      expect(koeberTotalOere(bud, false, 4200, rabat)).toBe(bud + fk + 4200);
    }
    // Halv op: 5,07 kr. / 2 = 2,535 -> 2,54 kr.
    expect(founderGebyrOere(507, 50)).toBe(254);
    expect(founderGebyrOere(505, 50)).toBe(253);
  });

  it("alle hele kroner op til 25.000 kr.: SQL = TypeScript ved 50 % og 100 %", async () => {
    const r = await db.query<{ b: string; k50: string; s50: string; k100: string; s100: string }>(
      `select b, public.founder_gebyr_oere(public.koebergebyr_oere(b, false), 50) k50,
              public.founder_gebyr_oere(public.saelgergebyr_oere(b, false), 50) s50,
              public.founder_gebyr_oere(public.koebergebyr_oere(b, false), 100) k100,
              public.founder_gebyr_oere(public.saelgergebyr_oere(b, false), 100) s100
         from (select x * 100 as b from generate_series(1::bigint, 25000) x) v order by b`,
    );
    for (const x of r.rows) {
      const b = Number(x.b);
      if (koebergebyrOere(b, false, 50) !== Number(x.k50) || saelgergebyrOere(b, false, 50) !== Number(x.s50)) {
        throw new Error(`${b} øre ved 50 %: SQL ${x.k50}/${x.s50}, TS ${koebergebyrOere(b, false, 50)}/${saelgergebyrOere(b, false, 50)}`);
      }
      if (Number(x.k100) !== 0 || Number(x.s100) !== 0) throw new Error(`${b} øre ved 100 % er ikke 0`);
    }
  });

  it("erhverv: rabatten ignoreres i TypeScript og afvises i formlerne", async () => {
    expect(koebergebyrOere(1_000_000, true, 100)).toBe(50_000);
    expect(saelgergebyrOere(1_000_000, true, 50)).toBe(0);
    expect(koebergebyrForPrismodel("erhverv2", 1_000_000, 50)).toBeNull();
    expect(koebergebyrForPrismodel("ny", 1_000_000, 100)).toBeNull();
    expect(koebergebyrForPrismodel("ny2", 1_000_000, 30)).toBeNull();
    expect(founderGebyrOere(1000, 30)).toBeNull();
    const r = await en<{ x: string | null }>(`select public.founder_gebyr_oere(1000, 30) x`);
    expect(r.x).toBeNull();
  });
});

describe("månedsgrænsen (dansk tid)", () => {
  beforeAll(async () => {
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, ANDEN, "2026-01-31"])).toBe("ok");
  });

  it("måned 1-6 = 100 %, fra måned 7 = 50 %; 31. jan. + 6 måneder = 31. juli", async () => {
    const tider: [string, number][] = [
      ["2026-01-30T22:59:59Z", 0], // 30. jan. 23:59 dansk tid - før start
      ["2026-01-30T23:00:00Z", 100], // 31. jan. 00:00 dansk tid
      ["2026-07-30T21:59:59Z", 100], // 30. juli 23:59:59 (sommertid) - sidste dag i måned 6
      ["2026-07-30T22:00:00Z", 50], // 31. juli 00:00 dansk tid - måned 7
      ["2027-12-24T12:00:00Z", 50], // for altid
    ];
    for (const [tid, pct] of tider) {
      const r = await en<{ p: number }>(`select public.founder_rabat_pct($1, $2::timestamptz) p`, [ANDEN, tid]);
      expect([tid, Number(r.p)]).toEqual([tid, pct]);
      expect([tid, founderRabatPct(START, new Date(tid))]).toEqual([tid, pct]);
    }
    expect(founderFriTil("2026-01-31")).toBe("2026-07-30");
    expect(founderHalvFra("2026-01-31")).toBe("2026-07-31");
    // Postgres: 31. aug. + 6 måneder = 28. feb. (sidste dag i måneden).
    expect(founderHalvFra("2026-08-31")).toBe("2027-02-28");
    const pg = await en<{ d: string }>(`select to_char(date '2026-08-31' + interval '6 months', 'YYYY-MM-DD') d`);
    expect(pg.d).toBe("2027-02-28");
    expect(founderHalvFra("2027-08-31")).toBe("2028-02-29");
    expect(danskDato(new Date("2026-10-28T23:30:00Z"))).toBe("2026-10-29");
  });

  it("stoppet aftale giver 0 fra stoptidspunktet; stoppet giver aldrig mærket", async () => {
    expect(founderRabatPct({ start_dato: "2026-01-31", stoppet_kl: "2026-03-01T12:00:00Z" }, new Date("2026-03-01T11:00:00Z"))).toBe(100);
    expect(founderRabatPct({ start_dato: "2026-01-31", stoppet_kl: "2026-03-01T12:00:00Z" }, new Date("2026-03-01T12:00:00Z"))).toBe(0);
    expect(founderRabatPct(null)).toBe(0);
  });
});

describe("rabatten låses på betalingen", () => {
  it("måned 1: 0 kr. i begge gebyrer; BidHamr Beskyttelse gælder; fragten betales", async () => {
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, 'Aftale') r`, [CHEF, SAELGER, danskDato(new Date())])).toBe("ok");
    const b = await solgt({ bud: 10000 });
    expect([b.prismodel, Number(b.founder_rabat_pct)]).toEqual(["ny2", 100]);
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([0, 0]);
    expect(Number(b.fragt_oere)).toBeGreaterThan(0);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([true, 0]);
    expect(Number(b.total_oere)).toBe(1_000_000 + Number(b.fragt_oere));
    expect(Number(b.udbetaling_oere)).toBe(1_000_000);
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny2", founder_rabat_pct: 100 })).toBe(Number(b.total_oere));
    // Uden rabatten passer beløbene ikke (forsvar i dybden før PaymentIntent).
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny2", founder_rabat_pct: 0 })).toBeNull();
    // Application fee = kun fragten; sælgeren får hele buddet.
    const fee = applicationFeeOere(tal(b));
    expect(fee).toBe(Number(b.fragt_oere));
    await db.query(`update public.betalinger set application_fee_oere = $2 where id = $1`, [b.id, fee]);
  });

  it("rabatten kan ikke ændres bagefter - hverken af aftalen eller direkte", async () => {
    const b = await solgt({ bud: 2000 });
    expect(Number(b.founder_rabat_pct)).toBe(100);
    // Aftalen flyttes 7 måneder tilbage (nu 50 %) - den gemte betaling røres ikke.
    await saetStart(SAELGER, 0, 7);
    expect(Number((await hent(b.id)).founder_rabat_pct)).toBe(100);
    // Direkte: kolonnen nulstilles til den låste værdi.
    await db.query(`update public.betalinger set founder_rabat_pct = 0 where id = $1`, [b.id]);
    expect(Number((await hent(b.id)).founder_rabat_pct)).toBe(100);
    await db.query(`update public.betalinger set founder_rabat_pct = 50, fragt_oere = fragt_oere where id = $1`, [b.id]);
    expect(Number((await hent(b.id)).founder_rabat_pct)).toBe(100);
    // Fuldt gebyr på en rabat-betaling afvises af CHECK-formlerne.
    await expect(
      db.query(
        `update public.betalinger set koebergebyr_oere = 2_200, total_oere = bud_oere + 2_200 + fragt_oere where id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/koebergebyr_formel/);
    await expect(
      db.query(`update public.betalinger set saelgergebyr_oere = 1_500, udbetaling_oere = bud_oere - 1_500 where id = $1`, [b.id]),
    ).rejects.toThrow(/saelgergebyr_formel/);
  });

  it("måned 7: 50 % af begge gebyrer - også over 7.500 kr.", async () => {
    await saetStart(SAELGER, 0, 6); // præcis 6 måneder siden = første dag i måned 7
    const b = await solgt({ bud: 10000 });
    expect(Number(b.founder_rabat_pct)).toBe(50);
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([18_750, 7_250]);
    expect(Number(b.udbetaling_oere)).toBe(1_000_000 - 7_250);
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny2", founder_rabat_pct: 50 })).toBe(Number(b.total_oere));
    const lav = await solgt({ bud: 1001 }); // 7 % + 5 = 75,07 kr. / 5 % + 5 = 55,05 kr.
    expect([Number(lav.koebergebyr_oere), Number(lav.saelgergebyr_oere)]).toEqual([3_754, 2_753]);
  });

  it("sidste dag i måned 6: stadig 0 kr.", async () => {
    await saetStart(SAELGER, 1, 6); // i morgen for 6 måneder siden -> i dag er sidste dag i måned 6
    const b = await solgt({ bud: 500 });
    expect([Number(b.founder_rabat_pct), Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([100, 0, 0]);
  });

  it("startdato i fremtiden: ingen rabat endnu, intet mærke", async () => {
    await saetStart(SAELGER, 3);
    const b = await solgt({ bud: 500 });
    expect(Number(b.founder_rabat_pct)).toBe(0);
    expect((await en<{ f: boolean }>(`select public.founding_seller($1) f`, [SAELGER])).f).toBe(false);
    await saetStart(SAELGER, 0);
    expect((await en<{ f: boolean }>(`select public.founding_seller($1) f`, [SAELGER])).f).toBe(true);
  });

  it("tilbud til næste byder: rabatten bestemmes, når betalingen oprettes", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, status, forsendelse_mulig, pakkestoerrelse) values ($1, 'afsluttet', true, 'mellem') returning id`,
      [SAELGER],
    );
    const { id: x } = await en<{ id: string }>(
      `insert into public.andenchance_tilbud (auction_id, seller_id, byder_id, bud_oere) values ($1, $2, $3, 1000000) returning id`,
      [a, SAELGER, KOEBER],
    );
    expect((await en<{ r: { kode: string } }>(`select public.andenchance_svar($1, $2, true) as r`, [x, KOEBER])).r.kode).toBe("ok");
    const b = await en<Betaling>(`select * from public.betalinger where auction_id = $1`, [a]);
    expect([Number(b.founder_rabat_pct), Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([100, 0, 0]);
  });

  it("erhvervsauktion fra en founder: ingen rabat ('erhverv2')", async () => {
    const b = await solgt({ bud: 10000, erhverv: true });
    expect([b.prismodel, Number(b.founder_rabat_pct), Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)])
      .toEqual(["erhverv2", 0, 50_000, 0]);
    // Constrainten: rabat kun på 'ny2'.
    const c = await en<{ d: string }>(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'betalinger_founder_rabat_check'`,
    );
    expect(c.d).toMatch(/founder_rabat_pct = 0\) OR \(prismodel = 'ny2'/);
  });

  it("auktion_founder_rabat: rabatten for visningen før buddet", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, pakkestoerrelse, slutter_kl) values ($1, 'lille', now() + interval '2 days') returning id`,
      [SAELGER],
    );
    const { id: e } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, erhverv, pakkestoerrelse) values ($1, true, 'lille') returning id`,
      [SAELGER],
    );
    const r = await en<{ p: number; e: number; u: number }>(
      `select public.auktion_founder_rabat($1) p, public.auktion_founder_rabat($2) e,
              public.auktion_founder_rabat(gen_random_uuid()) u`,
      [a, e],
    );
    expect([Number(r.p), Number(r.e), Number(r.u)]).toEqual([100, 0, 0]);
  });

  it("stoppet aftale: nye betalinger uden rabat, gamle beholder deres", async () => {
    const foer = await solgt({ bud: 3000 });
    expect(Number(foer.founder_rabat_pct)).toBe(100);
    expect(await kode(`select public.seller_founder_stop($1, $2, 'Aftalen ophørt') r`, [CHEF, SAELGER])).toBe("ok");
    const efter = await solgt({ bud: 3000 });
    expect(Number(efter.founder_rabat_pct)).toBe(0);
    expect(Number(efter.koebergebyr_oere)).toBe(koebergebyrOere(300_000, false));
    expect(Number((await hent(foer.id)).founder_rabat_pct)).toBe(100);
    expect((await en<{ f: boolean }>(`select public.founding_seller($1) f`, [SAELGER])).f).toBe(false);
    // Genoptag (ny startdato) til resten af testene.
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, SAELGER, danskDato(new Date())])).toBe("ok");
  });
});

describe("kun private, kun chefen", () => {
  it("firmaer kan ikke blive founder (konto_type og firmaer-rækken), heller ikke direkte", async () => {
    expect(await kode(`select public.seller_founder_opret($1, $2, current_date, null) r`, [CHEF, FIRMA])).toBe("firma");
    expect(await kode(`select public.seller_founder_opret($1, $2, current_date, null) r`, [CHEF, FIRMA2])).toBe("firma");
    await expect(
      db.query(`insert into public.seller_founder (bruger_id, start_dato, oprettet_af) values ($1, current_date, $2)`, [FIRMA, CHEF]),
    ).rejects.toThrow(/Firmakonti kan ikke være seller founder/);
  });

  it("en founder, der bliver firma, mister rabatten og mærket", async () => {
    expect((await en<{ p: number }>(`select public.founder_rabat_pct($1, now()) p`, [ANDEN])).p).toBe(50);
    await db.query(`update public.users set konto_type = 'erhverv' where id = $1`, [ANDEN]);
    expect(Number((await en<{ p: number }>(`select public.founder_rabat_pct($1, now()) p`, [ANDEN])).p)).toBe(0);
    expect((await en<{ f: string[] }>(`select array(select public.founding_sellere(array[$1, $2]::uuid[])) f`, [ANDEN, SAELGER])).f)
      .toEqual([SAELGER]);
    // Aftalen kan stadig stoppes.
    expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [CHEF, ANDEN])).toBe("ok");
    await db.query(`update public.users set konto_type = 'privat' where id = $1`, [ANDEN]);
  });

  it("kun chefen: admin og almindelige brugere afvises; chefen kan ikke gøre sig selv til founder", async () => {
    for (const ikkeChef of [ADMIN, KOEBER]) {
      expect(await kode(`select public.seller_founder_opret($1, $2, current_date, null) r`, [ikkeChef, ANDEN])).toBe("ingen_adgang");
      expect(await kode(`select public.seller_founder_ret_start($1, $2, current_date) r`, [ikkeChef, SAELGER])).toBe("ingen_adgang");
      expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [ikkeChef, SAELGER])).toBe("ingen_adgang");
      expect(await kode(`select public.seller_founder_admin($1, $2) r`, [ikkeChef, SAELGER])).toBe("ingen_adgang");
      expect((await en<{ r: unknown }>(`select public.seller_founder_liste($1) r`, [ikkeChef])).r).toBeNull();
    }
    expect(await kode(`select public.seller_founder_opret($1, $1, current_date, null) r`, [CHEF])).toBe("inhabil");
    expect(await kode(`select public.seller_founder_opret($1, $2, date '2020-01-01', null) r`, [CHEF, ANDEN])).toBe("ugyldig_dato");
    expect(await kode(`select public.seller_founder_opret($1, $2, current_date, null) r`, [CHEF, SAELGER])).toBe("allerede");
    expect(await kode(`select public.seller_founder_ret_start($1, $2, current_date - 10) r`, [CHEF, SAELGER])).toBe("ok");
    expect(await kode(`select public.seller_founder_ret_start($1, $2, current_date - 10) r`, [CHEF, SAELGER])).toBe("uaendret");
    expect(await kode(`select public.seller_founder_ret_start($1, $2, current_date) r`, [CHEF, ANDEN])).toBe("ikke_founder");
  });

  it("rettigheder: tabellen og chef-funktionerne er lukket for anon og authenticated; mærket er åbent", async () => {
    const r = await en<Record<string, boolean>>(
      `select has_table_privilege('anon', 'public.seller_founder', 'select') ta,
              has_table_privilege('authenticated', 'public.seller_founder', 'select') tu,
              has_table_privilege('service_role', 'public.seller_founder', 'delete') td,
              has_function_privilege('authenticated', 'public.seller_founder_opret(uuid,uuid,date,text)', 'execute') fo,
              has_function_privilege('authenticated', 'public.seller_founder_stop(uuid,uuid,text)', 'execute') fs,
              has_function_privilege('authenticated', 'public.seller_founder_ret_start(uuid,uuid,date)', 'execute') fr,
              has_function_privilege('anon', 'public.seller_founder_liste(uuid)', 'execute') fl,
              has_function_privilege('anon', 'public.seller_founder_admin(uuid,uuid)', 'execute') fa,
              has_function_privilege('anon', 'public.founder_rabat_pct(uuid,timestamptz)', 'execute') fp,
              has_function_privilege('service_role', 'public.seller_founder_opret(uuid,uuid,date,text)', 'execute') so,
              has_function_privilege('anon', 'public.founding_seller(uuid)', 'execute') ms,
              has_function_privilege('anon', 'public.founding_sellere(uuid[])', 'execute') mf,
              has_function_privilege('anon', 'public.auktion_founder_rabat(uuid)', 'execute') mr,
              (select relrowsecurity from pg_class where oid = 'public.seller_founder'::regclass) rls`,
    );
    expect(r).toEqual({
      ta: false, tu: false, td: false, fo: false, fs: false, fr: false, fl: false, fa: false, fp: false,
      so: true, ms: true, mf: true, mr: true, rls: true,
    });
    await expect(db.query(`delete from public.seller_founder where bruger_id = $1`, [SAELGER])).rejects.toThrow(/slettes ikke/);
  });

  it("hændelserne logges i moderation_log; admin-visningen har fasen", async () => {
    const log = await db.query<{ handling: string; aarsag: string }>(
      `select handling, aarsag from public.moderation_log where bruger_id = $1 order by oprettet_kl, handling`,
      [SAELGER],
    );
    const h = log.rows.map((x) => x.handling);
    expect(h).toContain("seller_founder_oprettet");
    expect(h).toContain("seller_founder_startdato");
    expect(h).toContain("seller_founder_stoppet");
    expect(log.rows.find((x) => x.handling === "seller_founder_stoppet")?.aarsag).toMatch(/Aftalen ophørt/);
    const a = (await en<{ r: { kode: string; er_firma: boolean; founder: Record<string, unknown> } }>(
      `select public.seller_founder_admin($1, $2) r`,
      [CHEF, SAELGER],
    )).r;
    expect(a.kode).toBe("ok");
    expect(a.er_firma).toBe(false);
    expect(a.founder.rabat_nu).toBe(100);
    expect(a.founder.fri_til).toBe(founderFriTil(String(a.founder.start_dato)));
    expect(a.founder.halv_fra).toBe(founderHalvFra(String(a.founder.start_dato)));
    const liste = (await en<{ r: { bruger_id: string; stoppet_kl: string | null }[] }>(`select public.seller_founder_liste($1) r`, [CHEF])).r;
    expect(liste.map((x) => x.bruger_id)).toEqual([SAELGER, ANDEN]); // aktive først
  });
});

describe("fakturaer og refusion", () => {
  async function betalt(b: Betaling, feeId: string | null): Promise<void> {
    const fee = applicationFeeOere(tal(b));
    await db.query(
      `update public.betalinger set status = 'betalt', betalt_kl = now(), application_fee_oere = $2,
              stripe_application_fee_id = $3, stripe_charge_id = $4 where id = $1`,
      [b.id, fee, feeId, `ch_${b.id}`],
    );
  }

  async function fakturaer(id: string) {
    return (await db.query<{ part: string; beloeb_oere: string; linjer: { kode: string; beloeb_oere: number }[] }>(
      `select part, beloeb_oere, linjer from public.fakturaer where betaling_id = $1 order by part`,
      [id],
    )).rows;
  }

  it("100 % og afhentning: 0 kr. i gebyr - ingen faktura", async () => {
    const b = await solgt({ bud: 4000, forsendelse: false });
    expect([Number(b.founder_rabat_pct), Number(b.fragt_oere), applicationFeeOere(tal(b))]).toEqual([100, 0, 0]);
    // Stripe laver intet ApplicationFee-objekt ved 0 kr.
    await betalt(b, null);
    await db.query(`select public.faktura_planlaeg(200)`);
    expect(await fakturaer(b.id)).toEqual([]);
  });

  it("100 % med forsendelse: kun fragten faktureres køberen, ingen sælgerfaktura", async () => {
    const b = await solgt({ bud: 4000 });
    await betalt(b, `fee_${b.id}`);
    await db.query(`select public.faktura_planlaeg(200)`);
    const f = await fakturaer(b.id);
    expect(f.map((x) => x.part)).toEqual(["koeber"]);
    expect(f[0].linjer.map((l) => l.kode)).toEqual(["fragt"]);
    expect(Number(f[0].beloeb_oere)).toBe(Number(b.fragt_oere));
  });

  it("50 %: begge fakturaer med de halve gebyrer", async () => {
    await saetStart(SAELGER, 0, 8);
    const b = await solgt({ bud: 8000 });
    expect(Number(b.founder_rabat_pct)).toBe(50);
    await betalt(b, `fee_${b.id}`);
    await db.query(`select public.faktura_planlaeg(200)`);
    const f = await fakturaer(b.id);
    expect(f.map((x) => x.part)).toEqual(["koeber", "saelger"]);
    // 8.000 kr.: 315 kr. / 2 = 157,50 kr.; 105 kr. / 2 = 52,50 kr.
    expect(Number(f[0].beloeb_oere)).toBe(15_750 + Number(b.fragt_oere));
    expect(Number(f[1].beloeb_oere)).toBe(5_250);
    await saetStart(SAELGER, 0);
  });

  it("refusion: sag med medhold = buddet; fuld refusion = alt; application fee 0 er gyldigt", async () => {
    const b = await solgt({ bud: 12000 });
    expect(Number(b.founder_rabat_pct)).toBe(100);
    await db.query(`update public.betalinger set status = 'betalt' where id = $1`, [b.id]);
    const r = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [b.id]);
    expect(Number(r.beloeb)).toBe(1_200_000);
    expect(sagRefusionOere({ prismodel: "ny2", bud_oere: 1_200_000, total_oere: Number(b.total_oere), beskyttelse_oere: 0 }))
      .toBe(1_200_000);
    // Afhentning: application fee 0 - destination-CHECK'en (total - fee = udbetaling) holder.
    const a = await solgt({ bud: 12000, forsendelse: false });
    await db.query(`update public.betalinger set application_fee_oere = 0 where id = $1`, [a.id]);
    const x = await hent(a.id);
    expect(Number(x.total_oere)).toBe(Number(x.udbetaling_oere));
  });
});

describe("migrationen", () => {
  it("genkørsel ændrer intet; en ændret trigger stopper migrationen", async () => {
    const foer = await db.query(`select id, founder_rabat_pct, koebergebyr_oere, saelgergebyr_oere from public.betalinger order by id`);
    await db.exec(FOUNDER);
    const efter = await db.query(`select id, founder_rabat_pct, koebergebyr_oere, saelgergebyr_oere from public.betalinger order by id`);
    expect(efter.rows).toEqual(foer.rows);
    const c = await en<{ d: string }>(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'betalinger_koebergebyr_formel'`,
    );
    expect(c.d).toContain("founder_gebyr_oere(");
    const t = await en<{ d: string }>(
      `select pg_get_triggerdef(oid) d from pg_trigger where tgname = 'betalinger_b_prismodel'`,
    );
    expect(t.d).toContain("founder_rabat_pct");
    await db.exec(`create or replace function public.betalinger_b_prismodel() returns trigger language plpgsql
      set search_path = '' as $f$ begin return new; end $f$;`);
    await expect(db.exec(FOUNDER)).rejects.toThrow(/betalinger_b_prismodel: md5/);
  });
});
