// Migrationen 20261024020000_fragt_gls_slaaet_fra.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). GLS er slået fra, indtil
// Shipmondo har svaret (Filip, 15. okt. 2026):
// - handel_gem_levering afviser GLS ved Shipmondo med 'gls_lukket', medmindre
//   serveren sender gls_aktiv = true (SHIPMONDO_GLS_AKTIV=true)
// - DAO, PostNord, afhentning og andre fragtfirmaer er uændrede
// - md5-drift-tjekket: migrationen kan køres to gange, og en funktion, der
//   ikke er den forventede, afbryder migrationen
// Funktionen før migrationen er den præcise definition fra testdatabasen
// (fixtures/handel_gem_levering_20261024010000.sql).
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const laes = (...p: string[]) => readFileSync(path.resolve(import.meta.dirname, ...p), "utf8");
const MIGRATION = laes("../../supabase/migrations/20261024020000_fragt_gls_slaaet_fra.sql");
const FOER = laes("fixtures/handel_gem_levering_20261024010000.sql");

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

describe("GLS er slået fra (20261024020000)", () => {
  it("GLS uden gls_aktiv afvises med gls_lukket, før handlen slås op", async () => {
    expect(await gem(levering({ transportoer: "gls" }))).toBe("gls_lukket");
    expect(await gem(levering({ transportoer: "gls", gls_aktiv: false }))).toBe("gls_lukket");
    expect(await gem(levering({ transportoer: "gls", gls_aktiv: "ja" }))).toBe("gls_lukket");
  });

  it("GLS med gls_aktiv = true fra serveren går videre (her: handlen findes ikke)", async () => {
    expect(await gem(levering({ transportoer: "gls", gls_aktiv: true }))).toBe("ikke_fundet");
  });

  it("DAO, PostNord og manglende transportør er uændrede", async () => {
    expect(await gem(levering({ transportoer: "dao" }))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "postnord" }))).toBe("ikke_fundet");
    expect(await gem(levering({}))).toBe("ikke_fundet");
    expect(await gem(levering({ transportoer: "ukendt" }))).toBe("ugyldig");
  });

  it("afhentning og andre fragtfirmaer rammes ikke af værnet", async () => {
    expect(await gem({ maade: "afhentning", transportoer: "gls" })).toBe("ikke_fundet");
    expect(await gem(levering({ fragtfirma: "dao", transportoer: "gls" }))).toBe("ikke_fundet");
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
});
