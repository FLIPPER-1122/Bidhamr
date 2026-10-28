// Migrationerne 20261102120000_skift_email.sql og
// 20261102160000_skift_email_rettelser.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Hver køres TO gange (idempotent +
// md5-drifttjek). Rettelserne: anmodninger, der sidder fast i 'bekraeftet',
// firmakonti, gamle links/koder ryddes ved skiftet, og Supabase' gamle
// e-mail-skift ryddes på eksisterende brugere.
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
import { huskelisteAfsnit } from "./huskelisteAfsnit";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102120000_skift_email.sql"),
  "utf8",
);
const RETTELSER = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102160000_skift_email_rettelser.sql"),
  "utf8",
);

const IDA = "00000000-0000-4000-8000-0000000000a1";
const BO = "00000000-0000-4000-8000-0000000000a2";
const FIRMA = "00000000-0000-4000-8000-0000000000a3";
const STAFF = "00000000-0000-4000-8000-0000000000a4";
const SUSP = "00000000-0000-4000-8000-0000000000a5";
const LUKKET = "00000000-0000-4000-8000-0000000000a6";
const SLETTET = "00000000-0000-4000-8000-0000000000a7";
const ERHVERV = "00000000-0000-4000-8000-0000000000a8";
const TOKENS = "00000000-0000-4000-8000-0000000000a9";

// staff_to_trin_er_staff_rolle præcis som i 20261027010000 (md5-tjekket).
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
grant usage on schema public to anon, authenticated, service_role;
create type auth.one_time_token_type as enum ('confirmation_token', 'reauthentication_token', 'recovery_token',
  'email_change_token_new', 'email_change_token_current', 'phone_change_token');
create table auth.users (id uuid primary key, email text, email_change text default '',
  email_change_token_new text default '', email_change_token_current text default '',
  email_change_confirm_status smallint default 0, email_change_sent_at timestamptz,
  recovery_token text default '', confirmation_token text default '', reauthentication_token text default '');
create table auth.one_time_tokens (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade, token_type auth.one_time_token_type not null,
  token_hash text not null, relates_to text not null);
create table public.users (id uuid primary key, email text unique, rolle text not null default 'bruger',
  konto_type text not null default 'privat',
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
    [ERHVERV, "erhverv@test.dk", "konto_type = 'erhverv'"],
    [TOKENS, "tokens@test.dk", ""],
  ] as const) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
    await db.query(`insert into public.users (id, email) values ($1, $2)`, [id, email]);
    if (ekstra) await db.query(`update public.users set ${ekstra} where id = $1`, [id]);
  }
  await db.query(`insert into public.firmaer (bruger_id, kontakt_email) values ($1, 'firma@test.dk'), ($2, 'kontakt@andet.dk')`, [FIRMA, BO]);
  // Et åbent e-mail-skift fra Supabase' eget flow (før værnet fandtes).
  await db.query(
    `update auth.users set email_change = 'angriber@test.dk', email_change_token_new = 'tok-ny', email_change_token_current = 'tok-nu',
       email_change_confirm_status = 1 where id = $1`, [LUKKET]);
  await db.query(
    `insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to) values ($1, 'email_change_token_new', 'h1', 'angriber@test.dk'),
       ($1, 'recovery_token', 'h2', 'lukket@test.dk')`, [LUKKET]);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent
  await db.exec(RETTELSER);
  await db.exec(RETTELSER); // idempotent
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

describe("rettelser (20261102160000)", () => {
  it("engangsoprydning: Supabase' gamle e-mail-skift er ryddet, andre tokens bevaret", async () => {
    const r = await en<Record<string, unknown>>(
      `select email_change, email_change_token_new, email_change_token_current, email_change_confirm_status from auth.users where id = $1`, [LUKKET]);
    expect(r).toEqual({ email_change: "", email_change_token_new: "", email_change_token_current: "", email_change_confirm_status: 0 });
    const t = await db.query<{ token_type: string }>(`select token_type::text from auth.one_time_tokens where user_id = $1`, [LUKKET]);
    expect(t.rows.map((x) => x.token_type)).toEqual(["recovery_token"]);
  });

  it("firmakonti kan ikke selv skifte e-mail", async () => {
    expect(await en<{ v: string }>(`select public.email_skift_konto_spaerret($1) v`, [ERHVERV])).toEqual({ v: "firma" });
    expect((await anmod(ERHVERV, "erhverv-ny@test.dk")).kode).toBe("firma");
    expect(Number((await en<{ n: number }>(`select count(*)::int n from public.email_skift where bruger_id = $1`, [ERHVERV])).n)).toBe(0);
  });

  it("'bekraeftet' sætter bekraeftet_kl; nyere end 5 min. giver 'igang', ældre bliver 'fejl'", async () => {
    await anmod(TOKENS, "tokens-ny@test.dk", "121212");
    const ok = await tjek(TOKENS, "121212");
    expect(ok.kode).toBe("ok");
    const b = await en<{ status: string; bekraeftet_kl: string | null }>(`select status, bekraeftet_kl from public.email_skift where id = $1`, [ok.id]);
    expect(b.status).toBe("bekraeftet");
    expect(b.bekraeftet_kl).not.toBeNull();
    // Netop bekræftet: auth opdateres nu - ingen ny anmodning.
    expect((await anmod(TOKENS, "tokens-ny@test.dk", "131313")).kode).toBe("igang");
    // Serveren døde: efter 5 minutter kan brugeren bede om en ny kode.
    await db.query(`update public.email_skift set bekraeftet_kl = now() - interval '6 minutes' where id = $1`, [ok.id]);
    expect((await anmod(TOKENS, "tokens-ny@test.dk", "141414")).kode).toBe("ok");
    expect((await en<{ status: string }>(`select status from public.email_skift where id = $1`, [ok.id])).status).toBe("fejl");
    // Rækker uden bekraeftet_kl (fra før rettelsen) bruger oprettet_kl.
    const ny = await tjek(TOKENS, "141414");
    await db.query(`update public.email_skift set bekraeftet_kl = null, oprettet_kl = now() - interval '10 minutes' where id = $1`, [ny.id]);
    expect((await anmod(TOKENS, "tokens-ny@test.dk", "151515")).kode).toBe("ok");
    expect((await en<{ status: string }>(`select status from public.email_skift where id = $1`, [ny.id])).status).toBe("fejl");
  });

  it("ved skiftet ryddes gamle links/koder og engangskoder - ellers røres de ikke", async () => {
    await db.query(
      `update auth.users set recovery_token = 'r', confirmation_token = 'c', reauthentication_token = 'ra',
         email_change_token_current = 'ec' where id = $1`, [TOKENS]);
    await db.query(
      `insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to) values
         ($1, 'recovery_token', 'r', 'tokens@test.dk'), ($1, 'reauthentication_token', 'ra', 'tokens@test.dk')`, [TOKENS]);
    // En opdatering uden ny e-mail (fx GoTrue, der gemmer en ny recovery_token) rører intet.
    await db.query(`update auth.users set email = email, recovery_token = 'r2' where id = $1`, [TOKENS]);
    expect((await en<{ recovery_token: string }>(`select recovery_token from auth.users where id = $1`, [TOKENS])).recovery_token).toBe("r2");
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.one_time_tokens where user_id = $1`, [TOKENS])).n)).toBe(2);

    const ok = await tjek(TOKENS, "151515");
    expect(ok.kode).toBe("ok");
    await db.query(`update auth.users set email = 'tokens-ny@test.dk' where id = $1`, [TOKENS]);
    const r = await en<Record<string, unknown>>(
      `select recovery_token, confirmation_token, reauthentication_token, email_change_token_new, email_change_token_current,
              email_change, email_change_confirm_status from auth.users where id = $1`, [TOKENS]);
    expect(r).toEqual({
      recovery_token: "", confirmation_token: "", reauthentication_token: "", email_change_token_new: "",
      email_change_token_current: "", email_change: "", email_change_confirm_status: 0,
    });
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.one_time_tokens where user_id = $1`, [TOKENS])).n)).toBe(0);
    // Spejlingen kører stadig.
    expect((await en<{ email: string }>(`select email from public.users where id = $1`, [TOKENS])).email).toBe("tokens-ny@test.dk");
    expect((await en<{ status: string }>(`select status from public.email_skift where id = $1`, [ok.id])).status).toBe("gennemfoert");
    // Andre brugeres tokens røres ikke.
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.one_time_tokens where user_id = $1`, [LUKKET])).n)).toBe(1);
  });

  it("drifttjek: en ændret funktion stopper migrationen", async () => {
    await db.exec(`create or replace function public.email_skift_afslut(p_id uuid, p_status text) returns boolean
      language plpgsql security definer set search_path = public as $fn$ begin return true; end $fn$;`);
    await expect(db.exec(RETTELSER)).rejects.toThrow(/email_skift_afslut.*md5/);
    // Tilbage til 120000's udgave (funktionen præcis som i migrationen).
    const afslut = /create or replace function public\.email_skift_afslut[\s\S]*?\n\$fn\$;/.exec(MIGRATION)![0];
    await db.exec(afslut);
    await db.exec(RETTELSER);
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

// ---------------------------------------------------------------------------
// 20261102410000 (afsnit "email"): outbox for log-ud og advarsel, og
// recovery-token ryddes igen efter skiftet.
// ---------------------------------------------------------------------------
describe("outbox efter skiftet (20261102410000)", () => {
  const OUT = "00000000-0000-4000-8000-0000000000b1";
  const ANDEN = "00000000-0000-4000-8000-0000000000b2";
  const S_BEHOLD = "00000000-0000-4000-8000-00000000c001";
  const S_GAMMEL = "00000000-0000-4000-8000-00000000c002";
  const S_ANDEN = "00000000-0000-4000-8000-00000000c003";

  beforeAll(async () => {
    // Det fra Supabase Auth, som afsnittet bruger (findes i drift).
    await db.exec(`
      alter table auth.users add column recovery_sent_at timestamptz;
      alter table auth.one_time_tokens add column created_at timestamptz not null default now();
      create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
        created_at timestamptz not null default now());
    `);
    const afsnit = huskelisteAfsnit("email");
    await db.exec(afsnit);
    await db.exec(afsnit); // idempotent
    for (const [id, email] of [[OUT, "out@test.dk"], [ANDEN, "anden@test.dk"]] as const) {
      await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
      await db.query(`insert into public.users (id, email) values ($1, $2)`, [id, email]);
    }
  });

  const skift = async (bruger: string, ny: string, kode: string, session: string | null) => {
    expect((await anmod(bruger, ny, kode)).kode).toBe("ok");
    const ok = await tjek(bruger, kode);
    expect(ok.kode).toBe("ok");
    expect((await en<{ r: boolean }>(`select public.email_skift_behold_session($1, $2, $3) r`, [ok.id, bruger, session])).r).toBe(true);
    // Som Supabase Auth' updateUserById.
    await db.query(`update auth.users set email = $2 where id = $1`, [bruger, ny]);
    return ok.id as string;
  };
  const tag = async (skiftId: string | null = null) =>
    (await en<{ v: Record<string, unknown>[] }>(`select public.email_skift_outbox_tag($1) v`, [skiftId])).v;

  it("behold_session kun for egen, bekræftet anmodning", async () => {
    expect((await anmod(OUT, "out-x@test.dk", "100100")).kode).toBe("ok");
    const s = await en<{ id: string }>(`select id from public.email_skift where bruger_id = $1 and status = 'afventer'`, [OUT]);
    // Ikke bekræftet endnu.
    expect((await en<{ r: boolean }>(`select public.email_skift_behold_session($1, $2, $3) r`, [s.id, OUT, S_BEHOLD])).r).toBe(false);
    const ok = await tjek(OUT, "100100");
    // En anden brugers id.
    expect((await en<{ r: boolean }>(`select public.email_skift_behold_session($1, $2, $3) r`, [ok.id, ANDEN, S_BEHOLD])).r).toBe(false);
    await db.query(`select public.email_skift_afslut($1, 'fejl')`, [ok.id]);
  });

  it("skiftet opretter outbox-rækken i samme transaktion; kun brugerens eget skift", async () => {
    // Sessioner og tokens fra før skiftet.
    await db.query(
      `insert into auth.sessions (id, user_id, created_at) values ($1, $4, now() - interval '1 hour'),
         ($2, $4, now() - interval '1 hour'), ($3, $5, now() - interval '1 hour')`,
      [S_BEHOLD, S_GAMMEL, S_ANDEN, OUT, ANDEN]);
    const id = await skift(OUT, "out-ny@test.dk", "200200", S_BEHOLD);
    const o = await en<{ n: number; bruger_id: string }>(
      `select count(*)::int n, min(bruger_id::text) bruger_id from public.email_skift_outbox where email_skift_id = $1`, [id]);
    expect(o).toEqual({ n: 1, bruger_id: OUT });
    // Skift uden for flowet (dashboardet) giver ingen række.
    await db.query(`update auth.users set email = 'anden-ny@test.dk' where id = $1`, [ANDEN]);
    expect(Number((await en<{ n: number }>(
      `select count(*)::int n from public.email_skift_outbox x join public.email_skift s on s.id = x.email_skift_id where s.bruger_id = $1`,
      [ANDEN])).n)).toBe(0);
  });

  it("GoTrue skriver recovery-token tilbage efter skiftet: log_ud rydder den igen og logger andre enheder ud", async () => {
    const skiftId = (await en<{ id: string }>(
      `select id from public.email_skift where bruger_id = $1 and status = 'gennemfoert' order by oprettet_kl desc limit 1`, [OUT])).id;
    // Som hvis Supabase Auth gemmer brugerens gamle felter igen (uden ny e-mail).
    await db.query(
      `update auth.users set recovery_token = 'gammel', recovery_sent_at = now() - interval '10 minutes' where id = $1`, [OUT]);
    await db.query(
      `insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to, created_at)
         values ($1, 'recovery_token', 'gammel', 'out@test.dk', now() - interval '10 minutes')`, [OUT]);
    // En ny session efter skiftet (fx login på en ny enhed med den nye adresse).
    await db.query(`update public.email_skift_outbox set skiftet_kl = now() - interval '1 minute' where email_skift_id = $1`, [skiftId]);
    await db.query(`insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), $1, now())`, [OUT]);

    const raekker = await tag(skiftId);
    expect(raekker).toHaveLength(1);
    expect(raekker[0]).toMatchObject({ bruger_id: OUT, gammel_email: "out@test.dk", ny_email: "out-ny@test.dk", log_ud: false, mail: false, stripe: false, forsoeg: 1 });
    // Taget: et samtidigt forsøg (cron) får den ikke.
    expect(await tag(skiftId)).toEqual([]);
    expect(await tag()).toEqual([]);

    const id = raekker[0].id as string;
    const r = await en<{ v: Record<string, unknown> }>(`select public.email_skift_outbox_log_ud($1) v`, [id]);
    expect(r.v).toEqual({ kode: "ok", sessioner: 1, tokens: 2 });
    const sess = await db.query<{ id: string }>(`select id::text from auth.sessions where user_id = $1 order by created_at`, [OUT]);
    // Den, der skiftede, og den nye efter skiftet er tilbage. Den gamle er væk.
    expect(sess.rows.map((x) => x.id)).toContain(S_BEHOLD);
    expect(sess.rows.map((x) => x.id)).not.toContain(S_GAMMEL);
    expect(sess.rows).toHaveLength(2);
    // Andre brugeres sessioner røres ikke.
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.sessions where id = $1`, [S_ANDEN])).n)).toBe(1);
    expect((await en<{ recovery_token: string }>(`select recovery_token from auth.users where id = $1`, [OUT])).recovery_token).toBe("");
    // Idempotent.
    expect((await en<{ v: Record<string, unknown> }>(`select public.email_skift_outbox_log_ud($1) v`, [id])).v).toEqual({ kode: "allerede" });

    // "Glemt adgangskode" til den NYE adresse efter skiftet røres ikke.
    await db.query(`update auth.users set recovery_token = 'ny', recovery_sent_at = now() where id = $1`, [OUT]);
    await db.query(`update public.email_skift_outbox set log_ud_kl = null where id = $1`, [id]);
    await db.query(`select public.email_skift_outbox_log_ud($1)`, [id]);
    expect((await en<{ recovery_token: string }>(`select recovery_token from auth.users where id = $1`, [OUT])).recovery_token).toBe("ny");
  });

  it("trin og fejl: rækken er færdig, når alle tre trin er gjort; en fejl slipper låsen til cron", async () => {
    const o = await en<{ id: string }>(`select x.id from public.email_skift_outbox x join public.email_skift s on s.id = x.email_skift_id where s.bruger_id = $1`, [OUT]);
    expect((await en<{ r: boolean }>(`select public.email_skift_outbox_trin($1, 'ukendt') r`, [o.id])).r).toBe(false);
    expect((await en<{ r: boolean }>(`select public.email_skift_outbox_fejl($1, 'Resend nede') r`, [o.id])).r).toBe(true);
    // Låsen er sluppet: cron kan tage den med det samme.
    const igen = await tag();
    expect(igen).toHaveLength(1);
    expect(igen[0]).toMatchObject({ log_ud: true, mail: false, forsoeg: 2 });
    await db.query(`select public.email_skift_outbox_trin($1, 'mail')`, [o.id]);
    expect((await en<{ udfoert_kl: string | null }>(`select udfoert_kl from public.email_skift_outbox where id = $1`, [o.id])).udfoert_kl).toBeNull();
    await db.query(`select public.email_skift_outbox_trin($1, 'stripe')`, [o.id]);
    const f = await en<{ udfoert_kl: string | null; sidste_fejl: string | null; laast_til: string | null }>(
      `select udfoert_kl, sidste_fejl, laast_til from public.email_skift_outbox where id = $1`, [o.id]);
    expect(f.udfoert_kl).not.toBeNull();
    expect(f.sidste_fejl).toBeNull();
    expect(f.laast_til).toBeNull();
    expect(await tag()).toEqual([]);
  });

  it("højst 12 forsøg; ukendt session (null) logger alle sessioner fra før skiftet ud", async () => {
    await db.query(`insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), $1, now() - interval '1 hour')`, [ANDEN]);
    const id = await skift(ANDEN, "anden-tredje@test.dk", "300300", null);
    await db.query(`update public.email_skift_outbox set skiftet_kl = now() + interval '1 second' where email_skift_id = $1`, [id]);
    const [r] = await tag(id);
    await db.query(`select public.email_skift_outbox_log_ud($1)`, [r.id]);
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.sessions where user_id = $1`, [ANDEN])).n)).toBe(0);
    await db.query(`update public.email_skift_outbox set forsoeg = 12, laast_til = null where id = $1`, [r.id]);
    expect(await tag()).toEqual([]);
  });

  it("kun service_role", async () => {
    for (const rolle of ["authenticated", "anon"]) {
      await db.exec(`set role ${rolle}`);
      try {
        await expect(db.query(`select * from public.email_skift_outbox`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_outbox_tag(null)`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_outbox_log_ud($1)`, [OUT])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_outbox_trin($1, 'mail')`, [OUT])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_outbox_fejl($1, 'x')`, [OUT])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.email_skift_behold_session($1, $1, $1)`, [OUT])).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role`);
      }
    }
  });

  it("drifttjek: en ændret spejling stopper afsnittet", async () => {
    const d = new PGlite();
    await d.exec(STUB);
    await d.exec(MIGRATION);
    await d.exec(RETTELSER);
    await d.exec(`create or replace function public.auth_users_email_spejl() returns trigger language plpgsql as $$ begin return new; end $$;`);
    await expect(d.exec(huskelisteAfsnit("email"))).rejects.toThrow(/auth_users_email_spejl.*md5/);
    await d.close();
  });
});
