// Migrationen 20261101010000_erhverv_intet_saelgergebyr.sql i PGlite (Postgres
// i processen - ingen database, intet netværk). Samme opsætning som
// nyPrismodel.test.ts (stubs + de rigtige funktioner), derefter de tre
// prismodel-migrationer og så denne (to gange - idempotent).
// Testes: nye erhvervsbetalinger får 'erhverv2' (5 % købergebyr, 0 kr.
// sælgergebyr, udbetaling = hele buddet), kalderens beløb ignoreres, gamle
// 'erhverv'-rækker (5 %/5 %) er urørte og kan stadig opdateres, CHECK'erne
// afviser forkerte beløb, TypeScript-spejlet passer, application fee =
// købergebyr + fragt, ingen sælgerfaktura på et 0-kr.-gebyr (faktura_planlaeg),
// og refusion ved medhold i en sag er alle pengene (som 'erhverv').
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applicationFeeOere,
  erErhvervPrismodel,
  forventetTotalOere,
  koebergebyrForPrismodel,
  koebergebyrOere,
  koebergebyrTekst,
  saelgergebyrForPrismodel,
  saelgergebyrOere,
  sagRefusionOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";
import { kvitteringLinjer } from "@/lib/kvittering";
import { FORTSAET, funktion, KOEBER, MIG, MIGRATION, RETTELSER, RIGTIGE, SAELGER, STUB } from "./prismodelStub";

const ERHVERV2 = readFileSync(path.join(MIG, "20261101010000_erhverv_intet_saelgergebyr.sql"), "utf8");

// Det faktura_planlaeg skal bruge ud over prismodel-stubben.
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

// En udløbet auktion med ét bud; afslut_udloebne_auktioner laver handel og betaling.
async function solgt(o: { bud: number; erhverv: boolean; forsendelse?: boolean }): Promise<Betaling> {
  const { id } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, forsendelse_mulig, erhverv, pakkestoerrelse, slutter_kl)
     values ($1, $2, $3, 'lille', now() - interval '1 minute') returning id`,
    [SAELGER, o.forsendelse ?? true, o.erhverv],
  );
  await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, $3)`, [id, KOEBER, o.bud]);
  await db.query(`select public.afslut_udloebne_auktioner()`);
  return en<Betaling>(`select * from public.betalinger where auction_id = $1`, [id]);
}

let gammelErhverv: Betaling;

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
  // En erhvervshandel fra FØR denne migration: 5 %/5 % (prismodel 'erhverv').
  gammelErhverv = await solgt({ bud: 1001, erhverv: true });
  await db.exec(ERHVERV2);
  await db.exec(ERHVERV2);
}, 60_000);

describe("firmaer betaler intet sælgergebyr", () => {
  it("den gamle erhvervshandel er urørt (5 %/5 %) og passer stadig med CHECK'erne", async () => {
    expect(gammelErhverv.prismodel).toBe("erhverv");
    const b = await en<Betaling>(`select * from public.betalinger where id = $1`, [gammelErhverv.id]);
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.udbetaling_oere)]).toEqual([5005, 5005, 100100 - 5005]);
    // En senere opdatering af den gamle række (fx status) afvises ikke.
    await db.query(`update public.betalinger set status = 'betalt' where id = $1`, [b.id]);
    expect(forventetTotalOere({ ...tal(b), prismodel: "erhverv" })).toBe(Number(b.total_oere));
    expect(forventetTotalOere({ ...tal(b), saelgergebyr_oere: 0, prismodel: "erhverv" })).toBeNull();
    const c = await db.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where conname like 'betalinger_%_formel' order by 1`,
    );
    expect(c.rows.map((r) => r.convalidated)).toEqual([true, true, true]);
    // Prismodellen kan ikke ændres til den nye.
    await db.query(`update public.betalinger set prismodel = 'erhverv2' where id = $1`, [b.id]);
    expect((await en<Betaling>(`select * from public.betalinger where id = $1`, [b.id])).prismodel).toBe("erhverv");
  });

  it("ny erhvervshandel: 'erhverv2', 5 % købergebyr, 0 kr. sælgergebyr, udbetaling = hele buddet", async () => {
    const b = await solgt({ bud: 1001, erhverv: true });
    expect(b.prismodel).toBe("erhverv2");
    expect([Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)]).toEqual([5005, 0, 4200]);
    expect(Number(b.udbetaling_oere)).toBe(100100);
    expect([b.beskyttelse, Number(b.beskyttelse_oere)]).toEqual([false, 0]);
    expect(Number(b.total_oere)).toBe(100100 + 5005 + 4200);
    expect(forventetTotalOere({ ...tal(b), prismodel: "erhverv2" })).toBe(Number(b.total_oere));
    // Application fee = købergebyr + fragt (intet sælgergebyr), og sælgeren
    // står tilbage med hele buddet (betalinger_destination_gebyr_stemmer).
    const fee = applicationFeeOere(tal(b));
    expect(fee).toBe(5005 + 4200);
    await db.query(`update public.betalinger set application_fee_oere = $2 where id = $1`, [b.id, fee]);
    // Et sælgergebyr på 5 % afvises nu (CHECK).
    await expect(
      db.query(
        `update public.betalinger set saelgergebyr_oere = 5005, udbetaling_oere = bud_oere - 5005,
                application_fee_oere = koebergebyr_oere + 5005 + fragt_oere where id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/saelgergebyr_formel/);
    expect(forventetTotalOere({ ...tal(b), saelgergebyr_oere: 5005, prismodel: "erhverv2" })).toBeNull();
  });

  it("afhentning hos et firma: ingen fragt, 5 % gebyr, intet sælgergebyr", async () => {
    const b = await solgt({ bud: 25000, erhverv: true, forsendelse: false });
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere), Number(b.fragt_oere)])
      .toEqual(["erhverv2", 125000, 0, 0]);
    expect(Number(b.udbetaling_oere)).toBe(2500000);
  });

  it("kalderens beløb ignoreres (5 % sælgergebyr bliver til 0)", async () => {
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, erhverv, pakkestoerrelse) values ($1, true, 'lille') returning id`,
      [SAELGER],
    );
    const { id: t } = await en<{ id: string }>(
      `insert into public.trades (auction_id, seller_id, buyer_id, amount, status) values ($1, $2, $3, 300, 'afventer_betaling') returning id`,
      [a, SAELGER, KOEBER],
    );
    await db.query(
      `insert into public.betalinger (trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere,
         beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere, prismodel)
       values ($1, $2, $3, $4, 30000, 1500, 4200, false, 0, 35700, 1500, 28500, 'erhverv')`,
      [t, a, KOEBER, SAELGER],
    );
    const b = await en<Betaling>(`select * from public.betalinger where trade_id = $1`, [t]);
    expect([b.prismodel, Number(b.saelgergebyr_oere), Number(b.udbetaling_oere)]).toEqual(["erhverv2", 0, 30000]);
  });

  it("private handler er uændrede", async () => {
    const b = await solgt({ bud: 100, erhverv: false });
    expect([b.prismodel, Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual(["ny", 1200, 1000]);
  });

  it("TypeScript-spejlet giver det samme som databasen", async () => {
    const beloeb = [1, 50, 99, 1001, 749_999, 750_000, 750_001, 2_500_000];
    for (let x = 100; x < 2_500_000; x += 9_973) beloeb.push(x);
    const r = await db.query<{ b: string; k: string; s: string; ke: string; se: string }>(
      `select b, public.koebergebyr_oere(b, false) k, public.saelgergebyr_oere(b, false) s,
              public.koebergebyr_oere(b, true) ke, public.saelgergebyr_oere(b, true) se
         from unnest($1::bigint[]) b`,
      [beloeb],
    );
    for (const x of r.rows) {
      const b = Number(x.b);
      // Private: prismodellen 'ny' (databasen her er før 20261102140000).
      expect([koebergebyrForPrismodel("ny", b), saelgergebyrForPrismodel("ny", b), koebergebyrOere(b, true), saelgergebyrOere(b, true)])
        .toEqual([Number(x.k), Number(x.s), Number(x.ke), Number(x.se)]);
      expect(Number(x.se)).toBe(0);
      expect(udbetalingOere(b, true)).toBe(b);
    }
    expect(erErhvervPrismodel("erhverv2")).toBe(true);
    expect(erErhvervPrismodel("ny")).toBe(false);
    expect(koebergebyrTekst("erhverv2", false)).toBe("Gebyr");
  });

  it("refusion ved medhold i en sag: alle pengene (som erhverv)", async () => {
    const b = await en<Betaling>(`select * from public.betalinger where prismodel = 'erhverv2' and fragt_oere > 0 limit 1`);
    await db.query(`update public.betalinger set status = 'betalt' where id = $1`, [b.id]);
    const r = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [b.id]);
    expect(Number(r.beloeb)).toBe(Number(b.total_oere));
    expect(sagRefusionOere({ prismodel: "erhverv2", bud_oere: 100100, total_oere: 109305, beskyttelse_oere: 0 })).toBe(109305);
  });

  it("ingen sælgerfaktura på et 0-kr.-gebyr - købers faktura laves som før", async () => {
    const b = await solgt({ bud: 2000, erhverv: true });
    const fee = Number(b.koebergebyr_oere) + Number(b.fragt_oere);
    await db.query(
      `update public.betalinger set status = 'betalt', betalt_kl = now(), application_fee_oere = $2,
              stripe_application_fee_id = 'fee_test', stripe_charge_id = 'ch_test_erhverv2' where id = $1`,
      [b.id, fee],
    );
    await db.query(`select public.faktura_planlaeg(200)`);
    const f = await db.query<{ part: string; beloeb_oere: string; linjer: { kode: string; tekst: string }[] }>(
      `select part, beloeb_oere, linjer from public.fakturaer where betaling_id = $1 order by part`,
      [b.id],
    );
    expect(f.rows.map((x) => x.part)).toEqual(["koeber"]);
    expect(Number(f.rows[0].beloeb_oere)).toBe(fee);
    expect(f.rows[0].linjer.map((l) => l.kode)).toEqual(["koebergebyr", "fragt"]);
    // Planlæggeren igen: stadig ingen sælgerfaktura (og ingen dubletter).
    await db.query(`select public.faktura_planlaeg(200)`);
    expect(Number((await en<{ n: string }>(`select count(*) n from public.fakturaer where betaling_id = $1`, [b.id])).n)).toBe(1);
  });

  it("kvitteringen viser ingen 0-kr.-linje for sælgergebyret", () => {
    const linjer = kvitteringLinjer({
      rolle: "saelger",
      handelId: "x",
      titel: "Vare",
      modpartNavn: "Køber",
      dato: new Date().toISOString(),
      afhentning: false,
      budOere: 100100,
      saelgergebyrOere: 0,
      udbetalingOere: 100100,
      prismodel: "erhverv2",
      overfoertKl: null,
      firma: null,
    });
    expect(linjer.map((l) => l.tekst)).toEqual(["Salgspris (vindende bud)", "Udbetaling til dig"]);
  });
});
