// Migrationen 20261023010000_kunst_forbudt.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). De funktioner, migrationen ændrer, oprettes
// først med deres hidtidige definition fra de ældre migrationer (md5 skal
// være prods), resten stubbes. Migrationen køres TO gange, og der tjekkes:
// - public.kunst_tekst_tjek giver præcis det samme som tjekKunstTekst (TS)
// - markering og automatisk anmeldelse ved oprettelse og rettelse
// - brugeren kan ikke selv sætte/fjerne markeringen eller ændre bekræftelsen
// - 'kunst' i regler, kategorier og check-constraints
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tjekKunstTekst } from "@/lib/kunstForbud";
import { FORBUDTE_KATEGORIER } from "@/lib/forbudteVarer";
import { DSA_REGLER } from "@/lib/dsa/regler";
import { KUNST_JA, KUNST_NEJ } from "../enhed/kunstEksempler";

const mig = (navn: string) =>
  readFileSync(path.resolve(import.meta.dirname, "../../supabase/migrations", navn), "utf8").replace(/\r/g, "");

const MIGRATION = mig("20261023010000_kunst_forbudt.sql");

// Henter "create or replace function public.<navn>(" ... "$fn$;" fra en ældre migration.
function funktion(fil: string, navn: string): string {
  const tekst = mig(fil);
  const start = tekst.indexOf(`create or replace function public.${navn}(`);
  if (start < 0) throw new Error(`${navn} findes ikke i ${fil}`);
  const slut = tekst.indexOf("\n$fn$;", start);
  return tekst.slice(start, slut + "\n$fn$;".length);
}

const SYSTEM = "00000000-0000-0000-0000-000000000001";
const SAELGER = "00000000-0000-0000-0000-0000000000aa";

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('test.rolle', true), '') $$;
create function public.bidhamr_system_id() returns uuid language sql immutable
  as $$ select '${SYSTEM}'::uuid $$;
create function public.auktion_kategorier() returns text[] language sql immutable
  as $$ select array['Elektronik', 'Møbler', 'Tøj & sko', 'Biler', 'Legetøj', 'Sport', 'Havemøbler', 'Andet'] $$;
create table public.auctions (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid not null,
  titel text not null,
  beskrivelse text,
  kategori text);
grant select (id, bruger_id, titel, beskrivelse, kategori) on public.auctions to anon, authenticated;
grant insert, update on public.auctions to authenticated;
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid, reporter_id uuid, category text, description text,
  created_at timestamptz not null default now(), status text not null default 'pending',
  constraint reports_category_check check (category = any ('{andet,forbudt_vare,ulovlig_vare}'::text[])));
create table public.dsa_anmeldelser (
  id uuid primary key default gen_random_uuid(), kategori text not null,
  constraint dsa_anmeldelser_kategori_check check (kategori = any (array['forbudt_vare', 'andet'])));
${funktion("20261006042000_forbudte_varer_skaerpet.sql", "forbudt_normaliser")}
${funktion("20261006042000_forbudte_varer_skaerpet.sql", "forbudte_varer")}
${funktion("20261009030000_testrettelser_dsa_sikkerhed.sql", "dsa_regler")}
${funktion("20261009011000_dsa_rettelser.sql", "dsa_anmeldelse_opret")}
`;

const MD5 = `select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\\n]*', '', 'g'), '\\s', '', 'g'))) as h
  from pg_proc p where p.oid = to_regprocedure($1)`;

let db: PGlite;

async function md5(fn: string): Promise<string> {
  const r = await db.query<{ h: string }>(MD5, [fn]);
  return r.rows[0]?.h ?? "";
}

async function somRolle(rolle: string | null) {
  await db.query("select set_config('test.rolle', $1, false)", [rolle ?? ""]);
}

async function opret(titel: string, beskrivelse: string | null = null, bekraeftet?: boolean): Promise<string> {
  const r = await db.query<{ id: string }>(
    bekraeftet === undefined
      ? "insert into public.auctions (bruger_id, titel, beskrivelse) values ($1, $2, $3) returning id"
      : "insert into public.auctions (bruger_id, titel, beskrivelse, kunst_bekraeftet) values ($1, $2, $3, $4) returning id",
    bekraeftet === undefined ? [SAELGER, titel, beskrivelse] : [SAELGER, titel, beskrivelse, bekraeftet],
  );
  return r.rows[0].id;
}

async function auktion(id: string) {
  const r = await db.query<{ kunst_markeret_kl: string | null; kunst_bekraeftet: boolean }>(
    "select kunst_markeret_kl, kunst_bekraeftet from public.auctions where id = $1",
    [id],
  );
  return r.rows[0];
}

async function rapporter(id: string) {
  const r = await db.query<{ category: string; description: string; reporter_id: string; status: string }>(
    "select category, description, reporter_id, status from public.reports where auction_id = $1 order by created_at",
    [id],
  );
  return r.rows;
}

const GAMLE_MD5: Record<string, string> = {
  "public.forbudte_varer()": "26f66c209eafd8851d51bc524a5771bc",
  "public.dsa_regler()": "3c089e00118b314b50a3b2fcdc988c8d",
  "public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)": "10671a6ecac0d9faaae0518587047ff9",
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  // Stubbene skal være prods funktioner - ellers tester drift-tjekket ingenting.
  for (const [fn, h] of Object.entries(GAMLE_MD5)) {
    expect(await md5(fn), fn).toBe(h);
  }
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("de ændrede funktioner har den md5, migrationen forventer", async () => {
    for (const fn of Object.keys(GAMLE_MD5)) {
      const h = await md5(fn);
      expect(MIGRATION, `${fn} har nu md5 ${h}`).toContain(`'${h}'`);
    }
  });

  it("'kunst' er tilføjet regler, kategorier og checks", async () => {
    const regel = await db.query<{ kode: string; navn: string; grundlag: string; henvisning: string }>(
      "select kode, navn, grundlag, henvisning from public.dsa_regler() where kode = 'kunst'",
    );
    expect(regel.rows[0]).toEqual(DSA_REGLER.find((r) => r.kode === "kunst"));
    const kat = await db.query<{ kode: string; navn: string; beskrivelse: string }>(
      "select kode, navn, beskrivelse from public.forbudte_varer() where kode = 'kunst'",
    );
    expect(kat.rows[0]).toEqual(FORBUDTE_KATEGORIER.find((k) => k.kode === "kunst"));
    // Hele listen af regler er den samme i TS og SQL.
    const alle = await db.query<{ kode: string }>("select kode from public.dsa_regler()");
    expect(alle.rows.map((r) => r.kode)).toEqual(DSA_REGLER.map((r) => r.kode));
    const checks = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('reports_category_check', 'dsa_anmeldelser_kategori_check')",
    );
    expect(checks.rows).toHaveLength(2);
    for (const c of checks.rows) expect(c.def).toContain("kunst");
    const src = await db.query<{ prosrc: string }>(
      "select prosrc from pg_proc where proname = 'dsa_anmeldelse_opret'",
    );
    expect(src.rows[0].prosrc).toContain("'vilkaar', 'kunst', 'andet'");
  });

  it("nye kolonner kan ikke læses af brugere", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.column_privileges
        where table_name = 'auctions' and column_name in ('kunst_bekraeftet', 'kunst_markeret_kl')
          and privilege_type = 'SELECT' and grantee in ('anon', 'authenticated')`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe("kunst_tekst_tjek = tjekKunstTekst", () => {
  const ekstra = [
    "Maleri af Kirkeby, olie på lærred, signeret",
    "Plakat af maleri af Monet. Maleri sælges også",
    "kunst læder kunst",
    "IKEA billede. Oliemaleri af min farfar",
    "Grafik, signeret og nummereret 12/50",
    "Buste i bronze",
    "AKVAREL",
    "Lito",
  ];
  it.each([...KUNST_JA, ...KUNST_NEJ, ...ekstra])("%s", async (t) => {
    const r = await db.query<{ v: unknown }>("select public.kunst_tekst_tjek($1) as v", [t]);
    expect(r.rows[0].v).toEqual(tjekKunstTekst(t));
  });
});

describe("markering og anmeldelse", () => {
  it("kunst ved oprettelse: markeres, og staff får én anmeldelse", async () => {
    await somRolle("authenticated");
    const id = await opret("Oliemaleri af skib", "60x80", true);
    const a = await auktion(id);
    expect(a.kunst_markeret_kl).not.toBeNull();
    expect(a.kunst_bekraeftet).toBe(true);
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ category: "kunst", reporter_id: SYSTEM, status: "pending" });
    expect(r[0].description).toContain('"oliemaleri"');
    expect(r[0].description).toContain('bekræftet "Det er ikke kunst"');
  });

  it("appens insert uden kunst_bekraeftet virker og markeres", async () => {
    await somRolle("authenticated");
    const id = await opret("Litografi signeret");
    expect((await auktion(id)).kunst_bekraeftet).toBe(false);
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0].description).toContain("ikke bekræftet");
    // Én tidligere kunst-markeret auktion fra samme sælger.
    expect(r[0].description).toContain("1 andre auktioner");
  });

  it("almindelig vare: ingen markering og ingen anmeldelse", async () => {
    await somRolle("authenticated");
    const id = await opret("Maleritape og malerpensel");
    expect((await auktion(id)).kunst_markeret_kl).toBeNull();
    expect(await rapporter(id)).toHaveLength(0);
  });

  it("rettelse til kunst: markeres og anmeldes - kun én åben anmeldelse", async () => {
    await somRolle("authenticated");
    const id = await opret("Billede");
    await db.query("update public.auctions set titel = 'Akvarel af fyrtårn' where id = $1", [id]);
    expect((await auktion(id)).kunst_markeret_kl).not.toBeNull();
    await db.query("update public.auctions set beskrivelse = 'Akvarel, indrammet' where id = $1", [id]);
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0].description).toContain("den rettede titel eller beskrivelse");
  });

  it("brugeren kan ikke fjerne markeringen eller ændre bekræftelsen", async () => {
    await somRolle("authenticated");
    const id = await opret("Kunstværk", null, false);
    await db.query(
      "update public.auctions set kunst_markeret_kl = null, kunst_bekraeftet = true, titel = 'Sofa' where id = $1",
      [id],
    );
    const a = await auktion(id);
    expect(a.kunst_markeret_kl).not.toBeNull();
    expect(a.kunst_bekraeftet).toBe(false);
  });

  it("brugeren kan ikke selv markere en almindelig vare", async () => {
    await somRolle("authenticated");
    const r = await db.query<{ id: string }>(
      "insert into public.auctions (bruger_id, titel, kunst_markeret_kl) values ($1, 'Sofa', now()) returning id",
      [SAELGER],
    );
    expect((await auktion(r.rows[0].id)).kunst_markeret_kl).toBeNull();
  });

  it("staff/system-rettelser giver ingen ny anmeldelse", async () => {
    await somRolle("service_role");
    const id = await opret("Sofa");
    await db.query("update public.auctions set titel = 'Skulptur' where id = $1", [id]);
    expect(await rapporter(id)).toHaveLength(0);
    // ... men markeringen sættes stadig.
    expect((await auktion(id)).kunst_markeret_kl).not.toBeNull();
  });

  it("oprettelse via service_role (fx 'sæt varen op igen') anmeldes", async () => {
    await somRolle("service_role");
    const id = await opret("Bronzefigur");
    expect(await rapporter(id)).toHaveLength(1);
  });
});
