// Migrationen 20261102120000_skift_email.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Køres TO gange (idempotent + md5-drifttjek).
// Testes: anmodning (spærrede konti, staff, samme/optaget adresse),
// kodetjek (forsøg, udløb, engangsbrug, optaget ved koden), spejlingen fra
// auth.users (public.users, firmaets kontakt-e-mail, loggen), værnet mod
// Supabase' eget e-mail-skift, GDPR ved sletning og at alt kun er for
// service_role.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102120000_skift_email.sql"),
  "utf8",
);

const IDA = "00000000-0000-4000-8000-0000000000a1";
const BO = "00000000-0000-4000-8000-0000000000a2";
const FIRMA = "00000000-0000-4000-8000-0000000000a3";
const STAFF = "00000000-0000-4000-8000-0000000000a4";
const SUSP = "00000000-0000-4000-8000-0000000000a5";
const LUKKET = "00000000-0000-4000-8000-0000000000a6";
const SLETTET = "00000000-0000-4000-8000-0000000000a7";

// staff_to_trin_er_staff_rolle præcis som i 20261027010000 (md5-tjekket).
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
grant usage on schema public to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, email_change text default '');
create table public.users (id uuid primary key, email text unique, rolle text not null default 'bruger',
  suspenderet boolean default false, suspenderet_til timestamptz, konto_lukket_kl timestamptz, konto_slettet_kl timestamptz);
create table public.firmaer (id uuid primary key default gen_random_uuid(), bruger_id uuid unique, kontakt_email text);
create or replace function public.staff_to_trin_er_staff_rolle(p_rolle text)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p_rolle in ('medarbejder', 'admin', 'chef', 'saelger'), false)
$fn$;
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, p)).rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}
const h = (bruger: string, kode: string) => createHash("sha256").update(`bidhamr-email-skift-v1|${bruger}|${kode}`).digest("hex");
const anmod = (b: string, ny: string, kode = "123456") =>
  j(`select public.email_skift_anmod($1, $2, $3) as v`, [b, ny, h(b, kode)]);
const tjek = (b: string, kode: string) => j(`select public.email_skift_tjek($1, $2) as v`, [b, h(b, kode)]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  for (const [id, email, ekstra] of [
    [IDA, "ida@test.dk", ""],
    [BO, "bo@test.dk", ""],
    [FIRMA, "firma@test.dk", ""],
    [STAFF, "staff@test.dk", "rolle = 'medarbejder'"],
    [SUSP, "susp@test.dk", "suspenderet = true"],
    [LUKKET, "lukket@test.dk", "konto_lukket_kl = now()"],
    [SLETTET, "slettet@test.dk", "konto_slettet_kl = now()"],
  ] as const) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
    await db.query(`insert into public.users (id, email) values ($1, $2)`, [id, email]);
    if (ekstra) await db.query(`update public.users set ${ekstra} where id = $1`, [id]);
  }
  await db.query(`insert into public.firmaer (bruger_id, kontakt_email) values ($1, 'firma@test.dk'), ($2, 'kontakt@andet.dk')`, [FIRMA, BO]);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent
});

afterAll(async () => {
  await db.close();
});

describe("email_skift_anmod", () => {
  it("afviser ugyldigt input, samme adresse og spærrede konti", async () => {
    expect((await j(`select public.email_skift_anmod($1, 'ny@test.dk', 'ikke-hash') as v`, [IDA])).kode).toBe("ugyldig");
    expect((await anmod(IDA, "ikke-en-mail")).kode).toBe("ugyldig");
    expect((await anmod(IDA, "x@slettet.invalid")).kode).toBe("ugyldig");
    expect((await anmod(IDA, " IDA@test.dk ")).kode).toBe("samme");
    expect((await anmod(STAFF, "ny@test.dk")).kode).toBe("staff");
    expect((await anmod(SUSP, "ny@test.dk")).kode).toBe("suspenderet");
    expect((await anmod(LUKKET, "ny@test.dk")).kode).toBe("lukket");
    expect((await anmod(SLETTET, "ny@test.dk")).kode).toBe("slettet");
    // En udløbet suspension spærrer ikke.
    await db.query(`update public.users set suspenderet_til = now() - interval '1 day' where id = $1`, [SUSP]);
    expect((await anmod(SUSP, "susp-ny@test.dk")).kode).toBe("ok");
    expect(Number((await en<{ n: number }>(`select count(*)::int n from public.email_skift where bruger_id = $1`, [STAFF])).n)).toBe(0);
  });

  it("optaget adresse: ok + optaget, men ingen kode gemt; ny anmodning erstatter den gamle", async () => {
    const r = await anmod(IDA, "BO@test.dk");
    expect(r).toEqual({ kode: "ok", optaget: true });
    const a = await en<{ kode_hash: string | null; optaget: boolean }>(
      `select kode_hash, optaget from public.email_skift where bruger_id = $1 and status = 'afventer'`, [IDA]);
    expect(a).toEqual({ kode_hash: null, optaget: true });
    expect((await tjek(IDA, "123456")).kode).toBe("forkert");

    expect(await anmod(IDA, "ida-ny@test.dk", "111111")).toEqual({ kode: "ok", optaget: false });
    const s = await db.query<{ status: string }>(`select status from public.email_skift where bruger_id = $1 order by oprettet_kl, ctid`, [IDA]);
    expect(s.rows.map((x) => x.status)).toEqual(["erstattet", "afventer"]);
  });
});

describe("email_skift_tjek", () => {
  it("forkert kode tæller op, rigtig kode virker én gang", async () => {
    expect((await tjek(IDA, "000000")).kode).toBe("forkert");
    const ok = await tjek(IDA, "111111");
    expect(ok).toMatchObject({ kode: "ok", ny_email: "ida-ny@test.dk", gammel_email: "ida@test.dk" });
    expect((await tjek(IDA, "111111")).kode).toBe("ingen");
    const r = await en<{ status: string; forsoeg: number; kode_hash: string | null }>(
      `select status, forsoeg, kode_hash from public.email_skift where id = $1`, [ok.id]);
    expect(r).toEqual({ status: "bekraeftet", forsoeg: 2, kode_hash: null });
    // email_skift_afslut kun fra 'bekraeftet' og kun optaget/fejl.
    expect((await en<{ v: boolean }>(`select public.email_skift_afslut($1, 'gennemfoert') v`, [ok.id])).v).toBe(false);
    expect((await en<{ v: boolean }>(`select public.email_skift_afslut($1, 'fejl') v`, [ok.id])).v).toBe(true);
    expect((await en<{ v: boolean }>(`select public.email_skift_afslut($1, 'fejl') v`, [ok.id])).v).toBe(false);
  });

  it("5 forkerte: koden er brugt op", async () => {
    await anmod(IDA, "ida-ny@test.dk", "222222");
    for (let i = 0; i < 4; i++) expect((await tjek(IDA, "000000")).kode).toBe("forkert");
    expect((await tjek(IDA, "000000")).kode).toBe("for_mange");
    expect((await tjek(IDA, "222222")).kode).toBe("ingen");
  });

  it("udløbet kode og suspension efter anmodningen", async () => {
    await anmod(IDA, "ida-ny@test.dk", "333333");
    await db.query(`update public.email_skift set udloeber_kl = now() - interval '1 second' where bruger_id = $1 and status = 'afventer'`, [IDA]);
    expect((await tjek(IDA, "333333")).kode).toBe("udloebet");

    await anmod(IDA, "ida-ny@test.dk", "444444");
    await db.query(`update public.users set suspenderet = true where id = $1`, [IDA]);
    expect((await tjek(IDA, "444444")).kode).toBe("suspenderet");
    await db.query(`update public.users set suspenderet = false where id = $1`, [IDA]);
    expect((await tjek(IDA, "444444")).kode).toBe("ingen");
  });

  it("adressen taget efter koden blev sendt: optaget", async () => {
    await anmod(IDA, "snart-taget@test.dk", "555555");
    await db.query(`update auth.users set email = 'snart-taget@test.dk' where id = $1`, [BO]);
    expect((await tjek(IDA, "555555")).kode).toBe("optaget");
    await db.query(`update auth.users set email = 'bo@test.dk' where id = $1`, [BO]);
  });
});

describe("spejling fra auth.users", () => {
  it("brugerens skift: public.users, loggen gennemført", async () => {
    await anmod(IDA, "ida-ny@test.dk", "666666");
    const ok = await tjek(IDA, "666666");
    expect(ok.kode).toBe("ok");
    await db.query(`update auth.users set email = 'ida-ny@test.dk' where id = $1`, [IDA]);
    expect((await en<{ email: string }>(`select email from public.users where id = $1`, [IDA])).email).toBe("ida-ny@test.dk");
    const r = await en<{ status: string; kilde: string; gennemfoert_kl: string | null }>(
      `select status, kilde, gennemfoert_kl from public.email_skift where id = $1`, [ok.id]);
    expect(r.status).toBe("gennemfoert");
    expect(r.kilde).toBe("bruger");
    expect(r.gennemfoert_kl).not.toBeNull();
  });

  it("firmaets kontakt-e-mail følger kun med, når den var login-adressen", async () => {
    await db.query(`update auth.users set email = 'firma-ny@test.dk' where id = $1`, [FIRMA]);
    expect((await en<{ kontakt_email: string }>(`select kontakt_email from public.firmaer where bruger_id = $1`, [FIRMA])).kontakt_email).toBe("firma-ny@test.dk");
    await db.query(`update auth.users set email = 'bo-ny@test.dk' where id = $1`, [BO]);
    expect((await en<{ kontakt_email: string }>(`select kontakt_email from public.firmaer where bruger_id = $1`, [BO])).kontakt_email).toBe("kontakt@andet.dk");
    // Skift uden for flowet logges som 'udenfor'.
    const r = await en<{ kilde: string; status: string; gammel_email: string; ny_email: string }>(
      `select kilde, status, gammel_email, ny_email from public.email_skift where bruger_id = $1 and ny_email = 'bo-ny@test.dk'`, [BO]);
    expect(r).toEqual({ kilde: "udenfor", status: "gennemfoert", gammel_email: "bo@test.dk", ny_email: "bo-ny@test.dk" });
  });

  it("en optaget adresse vælter hele ændringen (unik e-mail i public.users)", async () => {
    await db.query(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000b9', 'kun-auth@test.dk')`);
    await db.query(`insert into public.users (id, email) values ('00000000-0000-4000-8000-0000000000b9', 'dublet@test.dk')`);
    await expect(db.query(`update auth.users set email = 'dublet@test.dk' where id = $1`, [IDA])).rejects.toThrow();
    expect((await en<{ email: string }>(`select email from auth.users where id = $1`, [IDA])).email).toBe("ida-ny@test.dk");
  });

  it("slettede konti og pladsholdere springes over", async () => {
    await db.query(`update auth.users set email = 'slettet+x@slettet.invalid' where id = $1`, [SLETTET]);
    expect((await en<{ email: string }>(`select email from public.users where id = $1`, [SLETTET])).email).toBe("slettet@test.dk");
  });
});

describe("værn og GDPR", () => {
  it("Supabase' eget e-mail-skift (email_change) afvises; at rydde det er tilladt", async () => {
    await expect(db.query(`update auth.users set email_change = 'angriber@test.dk' where id = $1`, [IDA])).rejects.toThrow(/BidHamrs server/);
    await db.query(`update auth.users set email_change = '' where id = $1`, [IDA]);
    await db.query(`update auth.users set email_change = null where id = $1`, [IDA]);
  });

  it("ved sletning fjernes adresserne fra loggen", async () => {
    await anmod(IDA, "ida-tredje@test.dk", "777777");
    await db.query(`update public.users set konto_slettet_kl = now() where id = $1`, [IDA]);
    const r = await db.query<{ gammel_email: string | null; ny_email: string | null; status: string }>(
      `select gammel_email, ny_email, status from public.email_skift where bruger_id = $1`, [IDA]);
    expect(r.rows.length).toBeGreaterThan(3);
    expect(r.rows.every((x) => x.gammel_email === null && x.ny_email === null)).toBe(true);
    expect(r.rows.some((x) => x.status === "afventer" || x.status === "bekraeftet")).toBe(false);
  });

  it("kun service_role: authenticated og anon kan hverken læse tabellen eller kalde funktionerne", async () => {
    for (const rolle of ["authenticated", "anon"]) {
      await db.exec(`set role ${rolle}`);
      try {
        await expect(db.query(`select * from public.email_skift`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_anmod($1, 'x@test.dk', $2)`, [BO, h(BO, "1")])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_tjek($1, $2)`, [BO, h(BO, "1")])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_afslut($1, 'fejl')`, [BO])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_konto_spaerret($1)`, [BO])).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role`);
      }
    }
  });
});
