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
create role anon; create role authenticated; create role service_role bypassrls; -- som i Supabase
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table public.users (id uuid primary key);
create table public.trades (id uuid primary key, buyer_id uuid, seller_id uuid, status text,
  afhentning boolean, auction_id uuid);
create table public.handel_levering (trade_id uuid primary key, transportoer text);
`;

const TRADE = "00000000-0000-4000-8000-000000000001";
const KOEBER = "00000000-0000-4000-8000-000000000002";
const SAELGER = "00000000-0000-4000-8000-000000000003";
const ANDEN = "00000000-0000-4000-8000-000000000004";

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
  await db.exec(`insert into public.users (id) values ('${SAELGER}'), ('${ANDEN}');
    insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values
      ('${SAELGER}', 'dao', '2025-10-21'), ('${ANDEN}', 'dao', '2025-10-21');`);
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

  it("fragt_betingelser_accept: brugeren læser kun sine egne rækker og kan ikke skrive", async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [SAELGER]);
    await db.exec("set role authenticated");
    try {
      const r = await db.query<{ bruger_id: string }>("select bruger_id from public.fragt_betingelser_accept");
      expect(r.rows.map((x) => x.bruger_id)).toEqual([SAELGER]);
      await expect(
        db.query("insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values ($1, 'dao', '2099-01-01')", [SAELGER]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("delete from public.fragt_betingelser_accept")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    await db.exec("set role anon");
    try {
      await expect(db.query("select 1 from public.fragt_betingelser_accept")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });

  it("fragt_betingelser_accept: én række pr. sælger, fragtfirma og version; kun dao/gls", async () => {
    await expect(
      db.query("insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values ($1, 'dao', '2025-10-21')", [SAELGER]),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.query("insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values ($1, 'postnord', 'x')", [SAELGER]),
    ).rejects.toThrow(/check constraint/);
    // Ny version = ny række (den gamle bliver stående).
    await db.query("insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values ($1, 'dao', '2026-01-01')", [SAELGER]);
    const r = await db.query<{ n: number }>("select count(*)::int n from public.fragt_betingelser_accept where bruger_id = $1", [SAELGER]);
    expect(r.rows[0].n).toBe(2);
  });

  it("fragt_betingelser_accept kan aldrig ændres eller slettes - heller ikke af ejeren eller service_role", async () => {
    await expect(db.query("update public.fragt_betingelser_accept set version = 'x'")).rejects.toThrow(/kan ikke ændres eller slettes/);
    await expect(db.query("delete from public.fragt_betingelser_accept")).rejects.toThrow(/kan ikke ændres eller slettes/);
    await expect(db.query("truncate public.fragt_betingelser_accept")).rejects.toThrow(/kan ikke ændres eller slettes/);
    await db.exec("set role service_role");
    try {
      // Serverens upsert (ignoreDuplicates = on conflict do nothing) virker - også ved dobbeltklik.
      for (let i = 0; i < 2; i++) {
        await db.query(
          "insert into public.fragt_betingelser_accept (bruger_id, fragtfirma, version) values ($1, 'dao', '2026-02-02') on conflict (bruger_id, fragtfirma, version) do nothing",
          [ANDEN],
        );
      }
      await expect(db.query("update public.fragt_betingelser_accept set version = 'x'")).rejects.toThrow(/permission denied/);
      await expect(db.query("delete from public.fragt_betingelser_accept")).rejects.toThrow(/permission denied/);
      await expect(db.query("truncate public.fragt_betingelser_accept")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    const r = await db.query<{ n: number }>(
      "select count(*)::int n from public.fragt_betingelser_accept where bruger_id = $1 and version = '2026-02-02'",
      [ANDEN],
    );
    expect(r.rows[0].n).toBe(1);
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
