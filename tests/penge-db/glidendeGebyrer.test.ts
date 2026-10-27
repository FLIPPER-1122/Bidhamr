// Migrationen 20261102140000_glidende_gebyrer.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Samme opsætning som
// erhvervUdenSaelgergebyr.test.ts (stubs + de rigtige funktioner), derefter
// prismodel-migrationerne (20261031010000 ff. og 20261101010000) og så denne
// (to gange - idempotent).
// Testes: Filips kontrolværdier (27. okt. 2026), grænsen, halv op og
// lofterne i SQL og TypeScript; at den samlede pris aldrig falder, når buddet
// stiger; nye private betalinger får 'ny2' (afslut_udloebne_auktioner,
// "tilbud til næste byder", direkte insert - kalderens beløb ignoreres);
// gamle 'ny'-handler (også ubetalte over 7.500 kr.) beholder deres beløb og
// kan stadig opdateres; erhverv2 er uændret; Beskyttelse ved skift af
// leveringsform; refusion ved medhold i en sag (kun buddet); fakturaerne; og
// md5-drift-tjekket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  aktuelPrismodel,
  applicationFeeOere,
  erNyPrivatPrismodel,
  forventetTotalOere,
  koebergebyrForPrismodel,
  koebergebyrOere,
  koebergebyrTekst,
  koeberTotalOere,
  saelgergebyrForPrismodel,
  saelgergebyrOere,
  sagRefusionOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";
import { FORTSAET, funktion, KOEBER, KOEBER2, MIG, MIGRATION, RETTELSER, RIGTIGE, SAELGER, STUB } from "./prismodelStub";

const ERHVERV2 = readFileSync(path.join(MIG, "20261101010000_erhverv_intet_saelgergebyr.sql"), "utf8");
const GLIDENDE = readFileSync(path.join(MIG, "20261102140000_glidende_gebyrer.sql"), "utf8");

// Det faktura_planlaeg skal bruge ud over prismodel-stubben (som i
// erhvervUdenSaelgergebyr.test.ts).
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

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

type Betaling = {
  id: string;
  trade_id: string;
  prismodel: string;
  bud_oere: string;
  koebergebyr_oere: string;
  saelgergebyr_oere: string;
  fragt_oere: string;
  beskyttelse: boolean;
  beskyttelse_oere: string;
  total_oere: string;
  udbetaling_oere: string;
  status: string;
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
async function solgt(o: { bud: number; erhverv?: boolean; forsendelse?: boolean }): Promise<Betaling> {
  const { id } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, forsendelse_mulig, erhverv, pakkestoerrelse, slutter_kl)
     values ($1, $2, $3, 'lille', now() - interval '1 minute') returning id`,
    [SAELGER, o.forsendelse ?? true, o.erhverv ?? false],
  );
  await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, $3)`, [id, KOEBER, o.bud]);
  await db.query(`select public.afslut_udloebne_auktioner()`);
  return en<Betaling>(`select * from public.betalinger where auction_id = $1`, [id]);
}

// bigint kommer som tal eller tekst - sammenlign som tekst (null bevares).
function tekst(r: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)]));
}

async function hent(id: string): Promise<Betaling> {
  return en<Betaling>(`select * from public.betalinger where id = $1`, [id]);
}

// Handler fra FØR migrationen.
let gammelNyHoej: Betaling; // 'ny', 10.000 kr., ikke betalt
let gammelNyLav: Betaling; // 'ny', 100 kr.
let gammelErhverv2: Betaling;

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
  // En gammel betaling (før 20261031010000): 5 %/5 % + tilkøbt Beskyttelse.
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
  await db.exec(RETTELSER);
  await db.exec(FORTSAET);
  await db.exec(ERHVERV2);
  gammelNyHoej = await solgt({ bud: 10000 });
  gammelNyLav = await solgt({ bud: 100 });
  gammelErhverv2 = await solgt({ bud: 10000, erhverv: true });
  await db.exec(GLIDENDE);
  await db.exec(GLIDENDE);
}, 60_000);

describe("gebyrerne (SQL og TypeScript)", () => {
  // [bud øre, købergebyr øre, sælgergebyr øre]
  const tabel: [number, number, number][] = [
    // Filips kontrolværdier (ROADMAP-BESLUTNINGER afsnit 3, 27. okt. 2026).
    [750_000, 30_000, 9_500], // 7.500 kr.
    [750_100, 30_003, 9_502], // 7.501 kr.
    [1_000_000, 37_500, 14_500], // 10.000 kr.
    [1_500_000, 52_500, 24_500], // 15.000 kr.
    [2_000_000, 65_000, 34_500], // 20.000 kr.: købers loft
    // 25.000 kr.: 95 + 2 % af 17.500 = 445 kr. (formlen - sælgers loft på 450
    // kr. nås først ved 25.250 kr., over beløbsloftet).
    [2_500_000, 65_000, 44_500],
    // Grænsen og halv op.
    [749_999, 30_000, 9_500], // 7.499,99 kr. (lav sats, begge lofter)
    [750_001, 30_000, 9_500], // 7.500,01 kr.: 0,03 / 0,02 øre -> 0
    [750_017, 30_001, 9_500], // 0,51 -> 1 / 0,34 -> 0
    [750_025, 30_001, 9_501], // 0,75 -> 1 / 0,50 -> 1 (halv op)
    [750_050, 30_002, 9_501], // 1,50 -> 2 / 1,00
    [2_499_900, 65_000, 44_498], // 24.999 kr.
    // Købers loft (650 kr.) ved 19.166,67 kr.
    [1_916_649, 64_999, 32_833], // 34.999,47 -> 34.999
    [1_916_650, 65_000, 32_833], // 34.999,50 -> 35.000 (loftet)
    [1_916_700, 65_000, 32_834],
    // Sælgers loft (450 kr.) ved 25.250 kr. - kun selve formlen (buddet kan højst være 25.000 kr.).
    [2_524_974, 65_000, 44_999], // 35.499,48 -> 35.499
    [2_524_975, 65_000, 45_000], // 35.499,50 -> 35.500 (loftet)
    [3_000_000, 65_000, 45_000],
    // Lav sats er uændret.
    [100, 507, 505],
    [10_000, 1_200, 1_000],
    [421_429, 30_000, 9_500],
  ];

  it.each(tabel)("%d øre: køber %d, sælger %d", async (bud, koeb, saelg) => {
    const r = await en<{ k: string; s: string; pk: string; ps: string }>(
      `select public.koebergebyr_oere($1, false) k, public.saelgergebyr_oere($1, false) s,
              public.prismodel_koebergebyr_oere('ny2', $1) pk, public.prismodel_saelgergebyr_oere('ny2', $1) ps`,
      [bud],
    );
    expect([Number(r.k), Number(r.s), Number(r.pk), Number(r.ps)]).toEqual([koeb, saelg, koeb, saelg]);
    expect(koebergebyrOere(bud, false)).toBe(koeb);
    expect(saelgergebyrOere(bud, false)).toBe(saelg);
    expect(koebergebyrForPrismodel("ny2", bud)).toBe(koeb);
    expect(saelgergebyrForPrismodel("ny2", bud)).toBe(saelg);
    expect(udbetalingOere(bud, false)).toBe(bud - saelg);
    expect(koeberTotalOere(bud, false, 4200)).toBe(bud + koeb + 4200);
  });

  it("alle hele kroner op til 25.000 kr. og alle ører omkring grænsen: SQL = TypeScript, og prisen falder aldrig", async () => {
    const r = await db.query<{ b: string; k: string; s: string; ke: string; se: string }>(
      `select b, public.koebergebyr_oere(b, false) k, public.saelgergebyr_oere(b, false) s,
              public.koebergebyr_oere(b, true) ke, public.saelgergebyr_oere(b, true) se
         from (select x * 100 as b from generate_series(1::bigint, 25000) x
               union select x from generate_series(748_000::bigint, 752_000) x) v
        order by b`,
    );
    let forrigeTotal = -Infinity;
    let forrigeUdbetaling = -Infinity;
    let forrigeKoeb = -Infinity;
    let forrigeSaelg = -Infinity;
    for (const x of r.rows) {
      const b = Number(x.b);
      const [k, s, ke, se] = [Number(x.k), Number(x.s), Number(x.ke), Number(x.se)];
      if (koebergebyrOere(b, false) !== k || saelgergebyrOere(b, false) !== s) {
        throw new Error(`${b} øre: SQL ${k}/${s}, TS ${koebergebyrOere(b, false)}/${saelgergebyrOere(b, false)}`);
      }
      // Erhverv uændret: 5 % / 0 kr.
      if (ke !== Math.round((b * 5) / 100) || se !== 0 || koebergebyrOere(b, true) !== ke) {
        throw new Error(`${b} øre: erhverv ${ke}/${se}`);
      }
      // Glidende: køberens samlede pris, sælgerens udbetaling og begge
      // gebyrer stiger (eller står stille), når buddet stiger.
      if (b + k < forrigeTotal || b - s < forrigeUdbetaling || k < forrigeKoeb || s < forrigeSaelg) {
        throw new Error(`${b} øre: prisen faldt`);
      }
      forrigeTotal = b + k;
      forrigeUdbetaling = b - s;
      forrigeKoeb = k;
      forrigeSaelg = s;
    }
    // 25.000 hele kroner + 4.001 ørebeløb - 41 hele kroner, der er med i begge.
    expect(r.rows.length).toBe(28_960);
  });

  it("de andre prismodeller er uændrede; ukendt prismodel giver null", async () => {
    const r = tekst(await en<Record<string, unknown>>(
      `select public.prismodel_koebergebyr_oere('ny', 1000000) nyk, public.prismodel_saelgergebyr_oere('ny', 1000000) nys,
              public.prismodel_koebergebyr_oere('ny', 2500000) nyk2, public.prismodel_saelgergebyr_oere('ny', 2500000) nys2,
              public.prismodel_koebergebyr_oere('ny', 750000) nyk3,
              public.prismodel_koebergebyr_oere('gammel', 100100) gk, public.prismodel_saelgergebyr_oere('gammel', 100100) gs,
              public.prismodel_koebergebyr_oere('erhverv', 100100) ek, public.prismodel_saelgergebyr_oere('erhverv', 100100) es,
              public.prismodel_koebergebyr_oere('erhverv2', 100100) e2k, public.prismodel_saelgergebyr_oere('erhverv2', 100100) e2s,
              public.prismodel_koebergebyr_oere('x', 100100) xk, public.prismodel_saelgergebyr_oere(null, 100100) xs,
              public.aktuel_prismodel(false) ap, public.aktuel_prismodel(true) ae, public.aktuel_prismodel(null) an`,
    ));
    expect(r).toEqual({
      nyk: "31500", nys: "21500", nyk2: "65000", nys2: "45000", nyk3: "30000",
      gk: "5005", gs: "5005", ek: "5005", es: "5005", e2k: "5005", e2s: "0",
      xk: null, xs: null, ap: "ny2", ae: "erhverv2", an: "ny2",
    });
    for (const [model, bud] of [["ny", 1_000_000], ["ny", 2_500_000], ["ny", 750_000], ["gammel", 100_100], ["erhverv", 100_100], ["erhverv2", 100_100]] as const) {
      const s = await en<{ k: string; s: string }>(
        `select public.prismodel_koebergebyr_oere($1, $2) k, public.prismodel_saelgergebyr_oere($1, $2) s`,
        [model, bud],
      );
      expect([koebergebyrForPrismodel(model, bud), saelgergebyrForPrismodel(model, bud)]).toEqual([Number(s.k), Number(s.s)]);
    }
    expect(koebergebyrForPrismodel("x", 100)).toBeNull();
    expect(saelgergebyrForPrismodel("x", 100)).toBeNull();
    expect([aktuelPrismodel(false), aktuelPrismodel(true)]).toEqual(["ny2", "erhverv2"]);
  });
});

describe("nye betalinger: 'ny2'", () => {
  it("over 7.500 kr. med forsendelse: glidende gebyrer, beskyttet, application fee passer", async () => {
    const b = await solgt({ bud: 10000 });
    expect(b.prismodel).toBe("ny2");
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)]).toEqual([37500, 14500, 4200]);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([true, 0]);
    expect(Number(b.total_oere)).toBe(1_000_000 + 37500 + 4200);
    expect(Number(b.total_oere)).toBe(koeberTotalOere(1_000_000, false, 4200));
    expect(Number(b.udbetaling_oere)).toBe(1_000_000 - 14500);
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny2" })).toBe(Number(b.total_oere));
    // Den gamle 'ny'-formel passer ikke på en 'ny2'-række (og omvendt).
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny" })).toBeNull();
    const fee = applicationFeeOere(tal(b));
    expect(fee).toBe(37500 + 14500 + 4200);
    await db.query(`update public.betalinger set application_fee_oere = $2 where id = $1`, [b.id, fee]);
    // De gamle 'ny'-beløb afvises af CHECK'erne.
    await expect(
      db.query(
        `update public.betalinger set koebergebyr_oere = 31500, total_oere = bud_oere + 31500 + fragt_oere,
                application_fee_oere = 31500 + saelgergebyr_oere + fragt_oere where id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/koebergebyr_formel/);
    await expect(
      db.query(
        `update public.betalinger set saelgergebyr_oere = 21500, udbetaling_oere = bud_oere - 21500,
                application_fee_oere = koebergebyr_oere + 21500 + fragt_oere where id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/saelgergebyr_formel/);
  });

  it("til og med 7.500 kr.: samme beløb som før", async () => {
    const b = await solgt({ bud: 100 });
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual(["ny2", 1200, 1000]);
    const c = await solgt({ bud: 7500, forsendelse: false });
    expect([c.prismodel, Number(c.koebergebyr_oere), Number(c.saelgergebyr_oere), Number(c.fragt_oere), c.beskyttelse])
      .toEqual(["ny2", 30000, 9500, 0, false]);
  });

  it("25.000 kr. (beløbsloftet): køber 650 kr., sælger 445 kr.", async () => {
    const b = await solgt({ bud: 25000 });
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual(["ny2", 65000, 44500]);
  });

  it("kalderens beløb og prismodel ignoreres ved oprettelse", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, pakkestoerrelse) values ($1, 'lille') returning id`,
      [SAELGER],
    );
    const { id: t } = await en<{ id: string }>(
      `insert into public.trades (auction_id, seller_id, buyer_id, amount, status) values ($1, $2, $3, 15000, 'afventer_betaling') returning id`,
      [a, SAELGER, KOEBER],
    );
    // De gamle 'ny'-beløb for 15.000 kr. (3 % + 15 = 465 kr., 2 % + 15 = 315 kr.).
    await db.query(
      `insert into public.betalinger (trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere,
         beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere, prismodel)
       values ($1, $2, $3, $4, 1500000, 46500, 4200, true, 0, 1550700, 31500, 1468500, 'ny')`,
      [t, a, KOEBER, SAELGER],
    );
    const b = await en<Betaling>(`select * from public.betalinger where trade_id = $1`, [t]);
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.total_oere), Number(b.udbetaling_oere)])
      .toEqual(["ny2", 52500, 24500, 1500000 + 52500 + 4200, 1500000 - 24500]);
  });

  it("tilbud til næste byder: glidende gebyrer", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, status, forsendelse_mulig, pakkestoerrelse) values ($1, 'afsluttet', true, 'mellem') returning id`,
      [SAELGER],
    );
    const { id: x } = await en<{ id: string }>(
      `insert into public.andenchance_tilbud (auction_id, seller_id, byder_id, bud_oere) values ($1, $2, $3, 1000000) returning id`,
      [a, SAELGER, KOEBER2],
    );
    const svar = await en<{ r: { kode: string } }>(`select public.andenchance_svar($1, $2, true) as r`, [x, KOEBER2]);
    expect(svar.r.kode).toBe("ok");
    const b = await en<Betaling>(`select * from public.betalinger where auction_id = $1`, [a]);
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)])
      .toEqual(["ny2", 37500, 14500, 5200]);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([true, 0]);
  });

  it("skift mellem afhentning og forsendelse: Beskyttelse følger med; prismodellen kan ikke ændres", async () => {
    const b = await solgt({ bud: 9000 });
    // Som handel_gem_levering: fragt 0.
    await db.query(
      `update public.betalinger set fragt_oere = 0, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere where id = $1`,
      [b.id],
    );
    expect((await hent(b.id)).beskyttelse).toBe(false);
    await db.query(
      `update public.betalinger set fragt_oere = 4200, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere + 4200,
              prismodel = 'ny' where id = $1`,
      [b.id],
    );
    const efter = await hent(b.id);
    expect([efter.beskyttelse, efter.prismodel, Number(efter.koebergebyr_oere)]).toEqual([true, "ny2", 34500]);
  });

  it("erhverv er uændret: 'erhverv2', 5 % købergebyr, intet sælgergebyr", async () => {
    const b = await solgt({ bud: 10000, erhverv: true });
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.udbetaling_oere), b.beskyttelse])
      .toEqual(["erhverv2", 50000, 0, 1_000_000, false]);
    expect(forventetTotalOere({ ...tal(b), prismodel: "erhverv2" })).toBe(Number(b.total_oere));
  });
});

describe("handler fra før migrationen beholder deres beløb", () => {
  it("ubetalt 'ny'-handel over 7.500 kr.: 3 % + 15 / 2 % + 15, kan opdateres og betales med sine beløb", async () => {
    expect(gammelNyHoej.prismodel).toBe("ny");
    const b = await hent(gammelNyHoej.id);
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.total_oere)])
      .toEqual(["ny", 31500, 21500, 1_000_000 + 31500 + 4200]);
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny" })).toBe(Number(b.total_oere));
    expect(forventetTotalOere({ ...tal(b), prismodel: "ny2" })).toBeNull();
    // Senere opdateringer (leveringsvalg, application fee, status) afvises ikke.
    await db.query(
      `update public.betalinger set fragt_oere = 0, beskyttelse = false, total_oere = bud_oere + koebergebyr_oere where id = $1`,
      [b.id],
    );
    await db.query(
      `update public.betalinger set fragt_oere = 4200, total_oere = bud_oere + koebergebyr_oere + 4200 where id = $1`,
      [b.id],
    );
    expect((await hent(b.id)).beskyttelse).toBe(true);
    await db.query(
      `update public.betalinger set application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere, status = 'betalt'
        where id = $1`,
      [b.id],
    );
    // Prismodellen kan ikke skiftes til den nye.
    await db.query(`update public.betalinger set prismodel = 'ny2' where id = $1`, [b.id]);
    const efter = await hent(b.id);
    expect([efter.prismodel, Number(efter.koebergebyr_oere), efter.status]).toEqual(["ny", 31500, "betalt"]);
  });

  it("'ny' under 7.500 kr. og 'erhverv2' er urørte; CHECK'erne er gyldige på alle rækker", async () => {
    const l = await hent(gammelNyLav.id);
    expect([l.prismodel, Number(l.koebergebyr_oere), Number(l.saelgergebyr_oere)]).toEqual(["ny", 1200, 1000]);
    const e = await hent(gammelErhverv2.id);
    expect([e.prismodel, Number(e.koebergebyr_oere), Number(e.saelgergebyr_oere)]).toEqual(["erhverv2", 50000, 0]);
    const g = await en<Betaling>(`select * from public.betalinger where prismodel = 'gammel'`);
    expect([Number(g.koebergebyr_oere), Number(g.saelgergebyr_oere), Number(g.beskyttelse_oere), Number(g.total_oere)])
      .toEqual([5000, 5000, 5000, 114000]);
    expect(forventetTotalOere({ ...tal(g), prismodel: "gammel" })).toBe(114000);
    expect(forventetTotalOere({ ...tal(g), beskyttelse_oere: 4999, prismodel: "gammel" })).toBeNull();
    await db.query(`update public.betalinger set status = 'frigivet' where id = $1`, [g.id]);
    const c = await db.query<{ conname: string; convalidated: boolean; def: string }>(
      `select conname, convalidated, pg_get_constraintdef(oid) def from pg_constraint
        where conname like 'betalinger_%_formel' or conname = 'betalinger_prismodel_check' order by 1`,
    );
    expect(c.rows.map((r) => [r.conname, r.convalidated])).toEqual([
      ["betalinger_beskyttelse_formel", true],
      ["betalinger_koebergebyr_formel", true],
      ["betalinger_prismodel_check", true],
      ["betalinger_saelgergebyr_formel", true],
    ]);
    expect(c.rows.every((r) => r.def.includes("ny2") || r.def.includes("prismodel_"))).toBe(true);
  });
});

describe("refusion, fakturaer og tekster", () => {
  it("medhold i en sag: 'ny2' = kun buddet (som 'ny')", async () => {
    const b = await solgt({ bud: 12000 });
    await db.query(`update public.betalinger set status = 'betalt' where id = $1`, [b.id]);
    const r = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [b.id]);
    expect(Number(r.beloeb)).toBe(1_200_000);
    const s = tekst(await en<Record<string, unknown>>(
      `select public.sag_refusion_oere('ny2', 100, 150, 0) ny2, public.sag_refusion_oere('ny', 100, 150, 0) ny,
              public.sag_refusion_oere('erhverv2', 100, 150, 0) e2, public.sag_refusion_oere('gammel', 100, 150, 25) g`,
    ));
    expect(s).toEqual({ ny2: "100", ny: "100", e2: "150", g: "125" });
    expect(sagRefusionOere({ prismodel: "ny2", bud_oere: 100, total_oere: 150, beskyttelse_oere: 0 })).toBe(100);
    expect(sagRefusionOere({ prismodel: "erhverv2", bud_oere: 100, total_oere: 150, beskyttelse_oere: 0 })).toBe(150);
    expect([erNyPrivatPrismodel("ny"), erNyPrivatPrismodel("ny2"), erNyPrivatPrismodel("erhverv2"), erNyPrivatPrismodel(null)])
      .toEqual([true, true, false, false]);
  });

  it("fakturaer: 'ny2' som 'ny' (gebyrlinjer og sagsreglerne)", async () => {
    const krop = await en<{ s: string }>(
      `select prosrc s from pg_proc where oid = 'public.faktura_planlaeg(integer)'::regprocedure`,
    );
    expect(krop.s).toContain("and not (fa.part = 'koeber' and x.prismodel in ('ny', 'ny2')");
    expect(krop.s).toContain("elsif rf.prismodel in ('ny', 'ny2') and rf.part = 'saelger'");
    expect(krop.s).not.toMatch(/prismodel = 'ny'/);
    const b = await solgt({ bud: 8000 });
    const fee = Number(b.koebergebyr_oere) + Number(b.saelgergebyr_oere) + Number(b.fragt_oere);
    await db.query(
      `update public.betalinger set status = 'betalt', betalt_kl = now(), application_fee_oere = $2,
              stripe_application_fee_id = 'fee_test', stripe_charge_id = 'ch_test_ny2' where id = $1`,
      [b.id, fee],
    );
    await db.query(`select public.faktura_planlaeg(200)`);
    const f = await db.query<{ part: string; beloeb_oere: string; linjer: { kode: string; tekst: string; beloeb_oere: number }[] }>(
      `select part, beloeb_oere, linjer from public.fakturaer where betaling_id = $1 order by part`,
      [b.id],
    );
    expect(f.rows.map((x) => x.part)).toEqual(["koeber", "saelger"]);
    // 8.000 kr.: køber 300 + 15 = 315 kr., sælger 95 + 10 = 105 kr.
    expect(Number(f.rows[0].beloeb_oere)).toBe(31500 + 4200);
    expect(f.rows[0].linjer.map((l) => l.tekst)[0]).toBe("Gebyr (inkl. BidHamr Beskyttelse)");
    expect(Number(f.rows[1].beloeb_oere)).toBe(10500);
    expect(f.rows[1].linjer.map((l) => l.tekst)).toEqual(["Sælgergebyr"]);
    expect(koebergebyrTekst("ny2", true)).toBe("Gebyr (inkl. BidHamr Beskyttelse)");
    expect(koebergebyrTekst("ny2", false)).toBe("Gebyr");
  });
});

describe("migrationen", () => {
  it("genkørsel ændrer intet; en ændret funktion stopper migrationen", async () => {
    const foer = await db.query(`select id, koebergebyr_oere, saelgergebyr_oere, prismodel from public.betalinger order by id`);
    await db.exec(GLIDENDE);
    const efter = await db.query(`select id, koebergebyr_oere, saelgergebyr_oere, prismodel from public.betalinger order by id`);
    expect(efter.rows).toEqual(foer.rows);
    // Drift: sag_refusion_oere er ændret af andre end migrationen.
    await db.exec(`create or replace function public.sag_refusion_oere(p_prismodel text, p_bud_oere bigint,
                                                    p_total_oere bigint, p_beskyttelse_oere bigint)
      returns bigint language sql immutable set search_path = '' as $fn$ select p_total_oere $fn$;`);
    await expect(db.exec(GLIDENDE)).rejects.toThrow(/sag_refusion_oere.*hverken gammel eller ny/);
  });
});
