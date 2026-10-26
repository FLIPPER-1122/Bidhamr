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
// 20261031030000_udbetaling_fortsaet.sql: en afbrudt kørsel fortsættes af
// næste kald (kørsels-id'et slås op i databasen). Alle tre filer køres også
// igen i rækkefølge bagefter (en genkørsel overskriver ikke nyere versioner).
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

import {
  FORTSAET,
  KOEBER,
  KOEBER2,
  MIGRATION,
  RETTELSER,
  RIGTIGE,
  SAELGER,
  STUB,
} from "./prismodelStub";

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
  await db.exec(FORTSAET);
  await db.exec(FORTSAET);
  // Genkørsel af alle tre efter hinanden (B2): 20261031010000 må ikke fejle
  // på det droppede 3-parameter-claim eller overskrive den nyere
  // saelger_naeste_udbetaling_kl (20261031030000 tjekker md5'erne).
  await db.exec(MIGRATION);
  await db.exec(RETTELSER);
  await db.exec(FORTSAET);
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
    // TypeScript-spejlet følger den NYESTE model: firmaer betaler intet
    // sælgergebyr (20261101010000 - se erhvervUdenSaelgergebyr.test.ts).
    expect(saelgergebyrOere(1001, true)).toBe(0);
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
      // (Erhvervs sælgergebyr i TS er 0 efter 20261101010000 - testes i
      // erhvervUdenSaelgergebyr.test.ts mod den migrerede database.)
      expect([koebergebyrOere(b, false), saelgergebyrOere(b, false), koebergebyrOere(b, true)])
        .toEqual([Number(x.k), Number(x.s), Number(x.ke)]);
      expect(Number(x.se)).toBe(Math.round((b * 5) / 100));
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

  // 20261031030000: en kørsel, der blev afbrudt efter første payout
  // (Stripe-fejl, saldo, konto, tidsgrænse), fortsættes af næste kald.
  async function fortsaettelig(saelger: string): Promise<string | null> {
    return (await en<{ k: string | null }>(`select public.saelger_fortsaettelig_koersel($1) as k`, [saelger])).k;
  }
  async function fortsatListe(): Promise<string[]> {
    const r = await db.query<{ seller_id: string }>(`select seller_id from public.saelgere_klar_til_udbetaling_fortsat(500)`);
    return r.rows.map((x) => x.seller_id);
  }
  async function klarListe(): Promise<string[]> {
    const r = await db.query<{ seller_id: string }>(`select seller_id from public.saelgere_klar_til_udbetaling(500)`);
    return r.rows.map((x) => x.seller_id);
  }

  it("afbrudt kørsel: næste kald finder kørslen i databasen og fortsætter, til køen er tom", async () => {
    const S = "00000000-0000-4000-8000-0000000000b7";
    const k1 = "00000000-0000-4000-8000-00000000c007";
    const [b1, b2, b3] = [await frigivet(S), await frigivet(S), await frigivet(S)];
    // Ingen payout endnu: intet at fortsætte - første kørsel er en ny.
    expect(await fortsaettelig(S)).toBeNull();
    expect(await klarListe()).toContain(S);
    const c1 = await claim(S, b1, k1);
    expect(c1.kode).toBe("ok");
    // Uafklaret claim: endnu intet at fortsætte.
    expect(await fortsaettelig(S)).toBeNull();
    await oprettet(c1.udbetaling_id!, "now() - interval '10 minutes'");
    // Kørslen blev afbrudt her. Sælgeren har nu ventetid - han er ikke på
    // den almindelige liste, men på listen over fortsættelige kørsler.
    expect(await klarListe()).not.toContain(S);
    expect(await fortsatListe()).toContain(S);
    // Næste kald (cron) slår kørslen op og fortsætter den.
    const k = await fortsaettelig(S);
    expect(k).toBe(k1);
    // En ny kørsel (et andet id) får stadig 'interval'.
    expect((await claim(S, b2, "00000000-0000-4000-8000-00000000c0ff")).kode).toBe("interval");
    const c2 = await claim(S, b2, k);
    expect(c2.kode).toBe("ok");
    expect((await en<{ k: string }>(`select koersel k from public.saelger_udbetalinger where id = $1`, [c2.udbetaling_id])).k).toBe(k1);
    await oprettet(c2.udbetaling_id!);
    // Intervallet regnes stadig fra kørslens første payout.
    const n = await en<{ min: string }>(
      `select round(extract(epoch from public.saelger_naeste_udbetaling_kl($1) - now()) / 60) as min`,
      [S],
    );
    expect(Number(n.min)).toBe(14 * 24 * 60 - 10);
    // En handel, der kræver opmærksomhed, tæller ikke: køen er tom.
    await db.query(`update public.betalinger set kraever_opmaerksomhed = true where id = $1`, [b3]);
    expect(await fortsatListe()).not.toContain(S);
    await db.query(`update public.betalinger set kraever_opmaerksomhed = false where id = $1`, [b3]);
    expect(await fortsatListe()).toContain(S);
    const c3 = await claim(S, b3, await fortsaettelig(S));
    expect(c3.kode).toBe("ok");
    await oprettet(c3.udbetaling_id!);
    // Køen er tom: ikke på nogen liste.
    expect(await fortsatListe()).not.toContain(S);
    expect(await klarListe()).not.toContain(S);
  });

  it("afbrudt kørsel: claimets værn er uændrede (nødstop, frysning, i_gang, blokering under lås)", async () => {
    const S = "00000000-0000-4000-8000-0000000000b8";
    const k1 = "00000000-0000-4000-8000-00000000c008";
    const [b1, b2, b3] = [await frigivet(S), await frigivet(S), await frigivet(S)];
    const c1 = await claim(S, b1, k1);
    await oprettet(c1.udbetaling_id!, "now() - interval '5 minutes'");
    expect(await fortsaettelig(S)).toBe(k1);
    // Nødstop.
    await db.exec(`create or replace function public.udbetalinger_stoppet() returns boolean language sql as $$ select true $$`);
    expect((await claim(S, b2, k1)).kode).toBe("stoppet");
    await db.exec(`create or replace function public.udbetalinger_stoppet() returns boolean language sql as $$ select false $$`);
    // Frosset sælger.
    await db.query(`insert into public.betalingsprofiler (user_id, udbetaling_frosset_kl) values ($1, now())`, [S]);
    expect((await claim(S, b2, k1)).kode).toBe("frosset");
    await db.query(`delete from public.betalingsprofiler where user_id = $1`, [S]);
    // Blokering pr. betaling under rækkelås (sag, indsigelse, chefens
    // godkendelse fra 10.000 kr., fortrydelsesfrist m.m.): intet claimes.
    await db.exec(`create or replace function public.betaling_udbetaling_blokeret(p_betaling uuid) returns text language sql as
      $$ select case when exists (select 1 from public.betalinger where id = p_betaling and indsigelse_kl is not null)
                     then 'indsigelse' end $$`);
    await db.query(`update public.betalinger set indsigelse_kl = now() where id = $1`, [b2]);
    expect(await fortsatListe()).toContain(S); // b3 er stadig klar
    const blok = await en<{ r: { kode: string; afvist: { grund: string }[] } }>(
      `select public.saelger_udbetaling_claim($1, 'acct_test', array[$2]::uuid[], $3::uuid) as r`,
      [S, b2, k1],
    );
    expect(blok.r.kode).toBe("intet");
    expect(blok.r.afvist[0].grund).toBe("indsigelse");
    await db.query(`update public.betalinger set indsigelse_kl = null where id = $1`, [b2]);
    await db.exec(
      `create or replace function public.betaling_udbetaling_blokeret(p_betaling uuid) returns text language sql as $$ select null::text $$`,
    );
    // En uafklaret claim i den fortsatte kørsel: næste giver 'i_gang'.
    const c2 = await claim(S, b2, k1);
    expect(c2.kode).toBe("ok");
    expect((await claim(S, b3, k1)).kode).toBe("i_gang");
    await oprettet(c2.udbetaling_id!);
    expect((await claim(S, b3, await fortsaettelig(S))).kode).toBe("ok");
  });

  it("afbrudt kørsel fortsættes ikke efter 1 time, ved 20 payouts eller med en anden payout inden for 14 dage", async () => {
    // Over 1 time siden kørslens første payout.
    const S1 = "00000000-0000-4000-8000-0000000000b9";
    const k1 = "00000000-0000-4000-8000-00000000c009";
    const [a1, a2] = [await frigivet(S1), await frigivet(S1)];
    const c1 = await claim(S1, a1, k1);
    await oprettet(c1.udbetaling_id!, "now() - interval '61 minutes'");
    expect(await fortsaettelig(S1)).toBeNull();
    expect(await fortsatListe()).not.toContain(S1);
    expect(await klarListe()).not.toContain(S1);
    expect((await claim(S1, a2, k1)).kode).toBe("interval");
    // Lige under 1 time: må fortsætte.
    await db.query(`update public.saelger_udbetalinger set oprettet = now() - interval '59 minutes' where id = $1`, [
      c1.udbetaling_id,
    ]);
    expect(await fortsaettelig(S1)).toBe(k1);

    // 20 payouts i kørslen.
    const S2 = "00000000-0000-4000-8000-0000000000ba";
    const k2 = "00000000-0000-4000-8000-00000000c00a";
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, koersel)
       select $1, 'acct_test', 1, 'dkk', 'oprettet', '{}', $2::uuid from generate_series(1, 20)`,
      [S2, k2],
    );
    await frigivet(S2);
    expect(await fortsaettelig(S2)).toBeNull();
    expect(await fortsatListe()).not.toContain(S2);
    await db.query(
      `update public.saelger_udbetalinger set status = 'failed' where id = (select id from public.saelger_udbetalinger where koersel = $1 limit 1)`,
      [k2],
    );
    expect(await fortsaettelig(S2)).toBe(k2);

    // En payout fra en anden kørsel (eller uden kørsel) inden for 14 dage.
    const S3 = "00000000-0000-4000-8000-0000000000bb";
    const k3 = "00000000-0000-4000-8000-00000000c00b";
    const d1 = await frigivet(S3);
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, oprettet)
       values ($1, 'acct_test', 1, 'dkk', 'paid', '{}', now() - interval '13 days')`,
      [S3],
    );
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, koersel, oprettet)
       values ($1, 'acct_test', 1, 'dkk', 'oprettet', '{}', $2::uuid, now() - interval '5 minutes')`,
      [S3, k3],
    );
    expect(await fortsaettelig(S3)).toBeNull();
    expect(await fortsatListe()).not.toContain(S3);
    expect((await claim(S3, d1, k3)).kode).toBe("interval");
    // Over 14 dage gammel: tæller ikke - kørslen må fortsætte.
    await db.query(
      `update public.saelger_udbetalinger set oprettet = now() - interval '14 days 1 minute' where seller_id = $1 and koersel is null`,
      [S3],
    );
    expect(await fortsaettelig(S3)).toBe(k3);

    // Kun den SENESTE kørsel - en ældre kørsel kan aldrig fortsættes.
    const S4 = "00000000-0000-4000-8000-0000000000bc";
    const kGl = "00000000-0000-4000-8000-00000000c00c";
    const kNy = "00000000-0000-4000-8000-00000000c00d";
    await frigivet(S4);
    await db.query(
      `insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, koersel, oprettet)
       values ($1, 'acct_test', 1, 'dkk', 'paid', '{}', $2::uuid, now() - interval '20 days'),
              ($1, 'acct_test', 1, 'dkk', 'oprettet', '{}', $3::uuid, now() - interval '2 minutes')`,
      [S4, kGl, kNy],
    );
    expect(await fortsaettelig(S4)).toBe(kNy);
    // Fejlede/annullerede payouts tæller ikke som kørslens payouts.
    await db.query(`update public.saelger_udbetalinger set status = 'failed' where seller_id = $1 and koersel = $2`, [S4, kNy]);
    expect(await fortsaettelig(S4)).toBeNull();
    expect(await fortsaettelig("00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  it("genkørsel: 3-parameter-claimet er væk, og funktionerne er de nyeste versioner", async () => {
    expect((await en<{ f: string | null }>(`select to_regprocedure('public.saelger_udbetaling_claim(uuid,text,uuid[])')::text as f`)).f).toBeNull();
    const md5 = async (fn: string) =>
      (
        await en<{ h: string }>(
          `select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\\n]*', '', 'g'), '\\s', '', 'g'))) as h
             from pg_proc p where p.oid = to_regprocedure($1)`,
          [fn],
        )
      ).h;
    expect(await md5("public.saelger_naeste_udbetaling_kl(uuid)")).toBe("64b69eb837c12279e8e2c60d3423bd58");
    expect(await md5("public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)")).toBe("3ab66db65625a200d0cdd97b7d8d3544");
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
