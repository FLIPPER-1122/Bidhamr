// Migrationen 20261028010000_fragt_dao_gls_ingen_postnord.sql i PGlite
// (Postgres i processen - ingen database, intet netværk). Fragtfirmaer
// (Filip, 20. okt. 2026): DAO og GLS, ingen PostNord.
// - handel_gem_levering afviser ved Shipmondo en transportør, der ikke står i
//   serverens liste p_valg->'tilladte', med 'transportoer_lukket'
// - uden listen (gammel kode under deploy): dao og gls - PostNord afvist
// - 'tilladte' sendt, men ikke et array: alt afvist (fail closed)
// - afhentning og andre fragtfirmaer er uændrede
// - md5-drift-tjekket: migrationen kan køres to gange, og en funktion, der
//   ikke er den forventede, afbryder migrationen
// Funktionen før migrationen er den præcise definition fra testdatabasen
// (identisk med produktion 20. okt. 2026 -
// fixtures/handel_gem_levering_20261024020000.sql).
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const laes = (...p: string[]) => readFileSync(path.resolve(import.meta.dirname, ...p), "utf8");
const MIGRATION = laes("../../supabase/migrations/20261028010000_fragt_dao_gls_ingen_postnord.sql");
const FOER = laes("fixtures/handel_gem_levering_20261024020000.sql");

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.trades (id uuid primary key, buyer_id uuid, seller_id uuid, status text,
  afhentning boolean, auction_id uuid);
create table public.handel_levering (trade_id uuid primary key, transportoer text);
`;

const TRADE = "00000000-0000-4000-8000-000000000001";
const KOEBER = "00000000-0000-4000-8000-000000000002";

let db: PGlite;

async function gem(valg: Record<string, unknown>): Promise<string> {
  const r = await db.query<{ v: { kode: string } }>(
    "select public.handel_gem_levering($1, $2, $3::jsonb, null) as v",
    [TRADE, KOEBER, JSON.stringify(valg)],
  );
  return r.rows[0].v.kode;
}

const levering = (ekstra: Record<string, unknown>) => ({
  maade: "doer",
  fragtfirma: "shipmondo",
  modtager: { navn: "Køber", adresse: "Vej 1", postnummer: "8000", by: "Aarhus C", telefon: "+4512345678" },
  ...ekstra,
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(FOER);
  // To gange: anden kørsel skal genkende den rettede funktion ("allerede").
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

// "ikke_fundet" = værnet er passeret (handlen findes ikke i stubben).
describe("DAO og GLS, ingen PostNord (20261028010000)", () => {
  it("med listen ['dao','gls']: DAO og GLS går videre, PostNord afvises", async () => {
    const tilladte = ["dao", "gls"];
    expect(await gem(levering({ transportoer: "dao", tilladte }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "gls", tilladte }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "postnord", tilladte }))).toBe("transportoer_lukket");
    // Uden transportør = DAO som før.
    expect(await gem(levering({ tilladte }))).toBe("ikke_fundet");
  });

  it("GLS kræver ikke længere gls_aktiv", async () => {
    expect(await gem(levering({ transportoer: "gls", tilladte: ["dao", "gls"], gls_aktiv: false }))).toBe("ikke_fundet");
  });

  it("med PostNord i listen (SHIPMONDO_POSTNORD_AKTIV=true) går PostNord videre", async () => {
    expect(await gem(levering({ transportoer: "postnord", tilladte: ["dao", "gls", "postnord"] }))).toBe("ikke_fundet");
  });

  it("listen kan også lukke DAO eller GLS", async () => {
    expect(await gem(levering({ transportoer: "gls", tilladte: ["dao"] }))).toBe("transportoer_lukket");
    expect(await gem(levering({ transportoer: "dao", tilladte: ["gls"] }))).toBe("transportoer_lukket");
    expect(await gem(levering({ tilladte: ["gls"] }))).toBe("transportoer_lukket");
  });

  it("uden listen (gammel kode under deploy): dao og gls, PostNord afvist", async () => {
    expect(await gem(levering({ transportoer: "dao" }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "gls", gls_aktiv: true }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "gls" }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "postnord" }))).toBe("transportoer_lukket");
    expect(await gem(levering({ transportoer: "postnord", gls_aktiv: true }))).toBe("transportoer_lukket");
  });

  it("'tilladte' er ikke et array: alt afvist (fail closed)", async () => {
    for (const tilladte of [null, "dao,gls", { dao: true }, 1]) {
      expect(await gem(levering({ transportoer: "dao", tilladte }))).toBe("transportoer_lukket");
    }
    expect(await gem(levering({ transportoer: "dao", tilladte: [] }))).toBe("transportoer_lukket");
  });

  it("ukendt transportør er stadig 'ugyldig'", async () => {
    expect(await gem(levering({ transportoer: "bring", tilladte: ["dao", "gls", "bring"] }))).toBe("ugyldig");
  });

  it("afhentning og andre fragtfirmaer rammes ikke af værnet", async () => {
    expect(await gem({ maade: "afhentning", transportoer: "postnord", tilladte: [] })).toBe("ikke_fundet");
    expect(await gem(levering({ fragtfirma: "dao", transportoer: "postnord", tilladte: ["dao"] }))).toBe("ikke_fundet");
  });

  it("kun service-role kan kalde funktionen", async () => {
    const r = await db.query<{ a: boolean; b: boolean; s: boolean }>(
      `select has_function_privilege('anon', 'public.handel_gem_levering(uuid,uuid,jsonb,text)', 'execute') a,
              has_function_privilege('authenticated', 'public.handel_gem_levering(uuid,uuid,jsonb,text)', 'execute') b,
              has_function_privilege('service_role', 'public.handel_gem_levering(uuid,uuid,jsonb,text)', 'execute') s`,
    );
    expect(r.rows[0]).toEqual({ a: false, b: false, s: true });
  });

  it("en funktion, der er hverken gammel eller ny, afbryder migrationen", async () => {
    const db2 = new PGlite();
    try {
      await db2.exec(STUB);
      await db2.exec(FOER.replace("'ugyldig'", "'ugyldig_aendret'"));
      await expect(db2.exec(MIGRATION)).rejects.toThrow(/hverken gammel eller ny/);
    } finally {
      await db2.close();
    }
  });

  it("uden 20261024020000 (GLS-værnet mangler) afbrydes migrationen", async () => {
    const db2 = new PGlite();
    try {
      await db2.exec(STUB);
      await db2.exec(laes("fixtures/handel_gem_levering_20261024010000.sql"));
      await expect(db2.exec(MIGRATION)).rejects.toThrow(/hverken gammel eller ny/);
    } finally {
      await db2.close();
    }
  });
});
