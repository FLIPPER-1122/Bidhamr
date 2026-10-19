// Migrationen 20261027010000_staff_to_trin.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Køres TO gange. Testes: tabellerne er kun
// for service_role, min_staff_adgang/staff_aal2_ok (auth.uid() og auth.jwt()),
// aktivering med gendannelseskoder, nulstilling (kun aal2-sessioner), åbning
// af tilmelding, gendannelse, triggeren på users.rolle, moderation_log og
// 14-dages-vinduet ved første udrulning.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261027010000_staff_to_trin.sql"),
  "utf8",
);

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const CHEF2 = "00000000-0000-4000-8000-0000000000c2";
const MEDARB = "00000000-0000-4000-8000-0000000000e1";
const SAELGER = "00000000-0000-4000-8000-0000000000e2";
const BRUGER = "00000000-0000-4000-8000-0000000000b1";
const NY = "00000000-0000-4000-8000-0000000000e3";

// moderation_log_handling_check som i produktion og test (19. okt. 2026,
// forkortet - de værdier, der skal bevares, er med).
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  factor_type text not null default 'totp', status text not null default 'unverified');
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, aal text not null default 'aal1');
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger');
insert into public.users (id, navn, rolle) values
  ('${CHEF}', 'Chef', 'chef'), ('${CHEF2}', 'Chef 2', 'chef'), ('${MEDARB}', 'Medarbejder', 'medarbejder'),
  ('${SAELGER}', 'Sælger', 'saelger'), ('${BRUGER}', 'Bruger', 'bruger'), ('${NY}', 'Ny', 'bruger');
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz default now(),
  constraint moderation_log_handling_check check ((handling = ANY ('{advarsel,rolle_aendret,suspender,udbetalingskonto_nulstillet}'::text[]))),
  constraint moderation_log_maal_type_check check ((maal_type = ANY ('{auktion,bruger,handel}'::text[]))));
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, p)).rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const hashes = (n = 10, salt = randomUUID()) => Array.from({ length: n }, (_, i) => hash(`${salt}-${i}`));

async function som<T>(rolle: "authenticated" | "anon", bruger: string | null, claims: Record<string, unknown>, f: () => Promise<T>) {
  await db.exec(
    `set role ${rolle}; select set_config('request.jwt.claim.sub', '${bruger ?? ""}', false);
     select set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', false);`,
  );
  try {
    return await f();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '', false);`);
  }
}

async function nyFaktor(bruger: string, status = "verified"): Promise<string> {
  return (await en<{ id: string }>(`insert into auth.mfa_factors (user_id, status) values ($1, $2) returning id`, [bruger, status])).id;
}
async function aabnVindue(bruger: string, timer = 24) {
  await db.query(`update public.staff_to_trin set tilmelding_aaben_til = now() + make_interval(hours => $2) where bruger_id = $1`, [bruger, timer]);
}
async function aktiver(bruger: string): Promise<{ faktor: string; koder: string[] }> {
  await db.query(`delete from auth.mfa_factors where user_id = $1`, [bruger]);
  await aabnVindue(bruger);
  const faktor = await nyFaktor(bruger);
  const koder = hashes();
  expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [bruger, faktor, koder])).kode).toBe("ok");
  return { faktor, koder };
}
const logAntal = async (handling: string, bruger: string) =>
  Number((await en<{ n: number }>(`select count(*)::int as n from public.moderation_log where handling = $1 and bruger_id = $2`, [handling, bruger])).n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
});
afterAll(async () => {
  await db?.close();
});

describe("første udrulning", () => {
  it("nuværende staff (alle fire roller) får et vindue på 14 dage - brugere ingen række", async () => {
    const r = await db.query<{ bruger_id: string; dage: number }>(
      `select bruger_id, round(extract(epoch from tilmelding_aaben_til - now()) / 86400)::int as dage from public.staff_to_trin order by 1`,
    );
    expect(r.rows.map((x) => x.bruger_id).sort()).toEqual([CHEF, CHEF2, MEDARB, SAELGER].sort());
    expect(r.rows.every((x) => x.dage === 14)).toBe(true);
  });

  it("en ny kørsel forlænger ikke vinduet (on conflict do nothing)", async () => {
    await db.query(`update public.staff_to_trin set tilmelding_aaben_til = now() + interval '1 hour' where bruger_id = $1`, [SAELGER]);
    await db.exec(MIGRATION);
    const r = await en<{ timer: number }>(
      `select round(extract(epoch from tilmelding_aaben_til - now()) / 3600)::int as timer from public.staff_to_trin where bruger_id = $1`,
      [SAELGER],
    );
    expect(r.timer).toBe(1);
  });

  it("moderation_log_handling_check: de nye handlinger er flettet ind, de gamle bevaret", async () => {
    const d = (await en<{ d: string }>(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'moderation_log_handling_check'`)).d;
    for (const h of ["advarsel", "rolle_aendret", "suspender", "udbetalingskonto_nulstillet", "to_trin_opsat", "to_trin_nulstillet", "to_trin_gendannet", "to_trin_tilmelding_aabnet"]) {
      expect(d).toContain(h);
    }
  });
});

describe("rettigheder", () => {
  it("tabellerne kan ikke læses eller skrives af authenticated eller anon", async () => {
    for (const rolle of ["authenticated", "anon"] as const) {
      await expect(som(rolle, MEDARB, {}, () => db.query(`select * from public.staff_to_trin`))).rejects.toThrow(/permission denied/);
      await expect(som(rolle, MEDARB, {}, () => db.query(`select * from public.staff_gendannelseskoder`))).rejects.toThrow(/permission denied/);
      await expect(
        som(rolle, MEDARB, {}, () => db.query(`update public.staff_to_trin set aktiv = true where bruger_id = $1`, [MEDARB])),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("service-role-RPC'erne kan ikke kaldes af authenticated", async () => {
    for (const sql of [
      `select public.staff_to_trin_aktiver('${MEDARB}', gen_random_uuid(), array[]::text[])`,
      `select public.staff_to_trin_nulstil('${CHEF}', '${MEDARB}', 24)`,
      `select public.staff_to_trin_aabn_tilmelding('${CHEF}', '${MEDARB}', 24)`,
      `select public.staff_gendan_brug('${MEDARB}', '${"0".repeat(64)}')`,
      `select public.staff_to_trin_ryd_auth('${MEDARB}')`,
      `select public.staff_to_trin_ukendte_faktorer('${MEDARB}')`,
    ]) {
      await expect(som("authenticated", CHEF, { aal: "aal2" }, () => db.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("min_staff_adgang og staff_aal2_ok: authenticated ja, anon nej", async () => {
    await expect(som("anon", null, {}, () => db.query(`select public.min_staff_adgang()`))).rejects.toThrow(/permission denied/);
    await expect(som("anon", null, {}, () => db.query(`select public.staff_aal2_ok(12)`))).rejects.toThrow(/permission denied/);
    const r = await som("authenticated", BRUGER, { aal: "aal1" }, () => j(`select public.min_staff_adgang() as v`));
    expect(r).toEqual({ staff: false });
  });
});

describe("min_staff_adgang og staff_aal2_ok", () => {
  it("staff med åbent vindue: ikke aktiv, tilmelding åben, aal fra JWT", async () => {
    const r = await som("authenticated", MEDARB, { aal: "aal1" }, () => j(`select public.min_staff_adgang() as v`));
    expect(r).toMatchObject({ staff: true, rolle: "medarbejder", aktiv: false, ukendte_faktorer: false, tilmelding_aaben: true, aal: "aal1" });
  });

  it("efter aktivering: aktiv; en ekstra verificeret faktor er ukendt; en halvfærdig er ligegyldig", async () => {
    await aktiver(MEDARB);
    const status = () => som("authenticated", MEDARB, { aal: "aal2" }, () => j(`select public.min_staff_adgang() as v`));
    expect(await status()).toMatchObject({ aktiv: true, ukendte_faktorer: false, tilmelding_aaben: false, aal: "aal2" });
    const halv = await nyFaktor(MEDARB, "unverified");
    expect(await status()).toMatchObject({ aktiv: true, ukendte_faktorer: false });
    const fremmed = await nyFaktor(MEDARB, "verified");
    expect(await status()).toMatchObject({ aktiv: true, ukendte_faktorer: true });
    await db.query(`delete from auth.mfa_factors where id = any($1)`, [[halv, fremmed]]);
  });

  it("en godkendt faktor, der er slettet direkte i Supabase, giver ikke aktiv", async () => {
    const { faktor } = await aktiver(MEDARB);
    await db.query(`delete from auth.mfa_factors where id = $1`, [faktor]);
    const r = await som("authenticated", MEDARB, { aal: "aal2" }, () => j(`select public.min_staff_adgang() as v`));
    expect(r.aktiv).toBe(false);
  });

  it("staff_aal2_ok: aal2 + frisk TOTP + aktiv; ellers false", async () => {
    await aktiver(MEDARB);
    const nu = Math.floor(Date.now() / 1000);
    const ok = (claims: Record<string, unknown>, bruger = MEDARB, timer = 12) =>
      som("authenticated", bruger, claims, async () => (await en<{ v: boolean }>(`select public.staff_aal2_ok($1) as v`, [timer])).v);
    expect(await ok({ aal: "aal2", amr: [{ method: "totp", timestamp: nu - 60 }] })).toBe(true);
    expect(await ok({ aal: "aal1", amr: [{ method: "totp", timestamp: nu - 60 }] })).toBe(false);
    expect(await ok({ aal: "aal2", amr: [{ method: "password", timestamp: nu }] })).toBe(false);
    expect(await ok({ aal: "aal2", amr: [{ method: "totp", timestamp: nu - 13 * 3600 }] })).toBe(false);
    expect(await ok({ aal: "aal2", amr: [{ method: "totp", timestamp: nu - 13 * 3600 }] }, MEDARB, 24)).toBe(true);
    expect(await ok({ aal: "aal2", amr: [{ method: "totp", timestamp: nu + 3600 }] })).toBe(false);
    expect(await ok({ aal: "aal2", amr: [{ method: "totp", timestamp: nu - 60 }] }, BRUGER)).toBe(false);
  });
});

describe("staff_to_trin_aktiver", () => {
  it("afviser lukket vindue, andre faktorer, forkerte koder og ikke-staff", async () => {
    await db.query(`update public.staff_to_trin set aktiv = false, faktor_ider = '{}', tilmelding_aaben_til = null where bruger_id = $1`, [SAELGER]);
    const f = await nyFaktor(SAELGER);
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, hashes()])).kode).toBe("vindue_lukket");
    await aabnVindue(SAELGER);
    const anden = await nyFaktor(SAELGER);
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, hashes()])).kode).toBe("andre_faktorer");
    await db.query(`delete from auth.mfa_factors where id = $1`, [anden]);
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, hashes(9)])).kode).toBe("ugyldige_koder");
    const dubletter = Array(10).fill(hash("x"));
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, dubletter])).kode).toBe("ugyldige_koder");
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, ["ikke-hex", ...hashes(9)]])).kode).toBe("ugyldige_koder");
    const halv = await nyFaktor(SAELGER, "unverified");
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, halv, hashes()])).kode).toBe("faktor_ukendt");
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [BRUGER, f, hashes()])).kode).toBe("ikke_staff");
  });

  it("ok: aktiv, vinduet lukkes, præcis 10 koder, logget - og dobbeltklik giver allerede_aktiv", async () => {
    await db.query(`delete from auth.mfa_factors where user_id = $1`, [SAELGER]);
    await aabnVindue(SAELGER);
    const f = await nyFaktor(SAELGER);
    const koder = hashes();
    const foer = await logAntal("to_trin_opsat", SAELGER);
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, koder])).kode).toBe("ok");
    expect((await j(`select public.staff_to_trin_aktiver($1, $2, $3) as v`, [SAELGER, f, hashes()])).kode).toBe("allerede_aktiv");
    const t = await en<{ aktiv: boolean; faktor_ider: string[]; vindue: string | null }>(
      `select aktiv, faktor_ider, tilmelding_aaben_til as vindue from public.staff_to_trin where bruger_id = $1`,
      [SAELGER],
    );
    expect(t).toEqual({ aktiv: true, faktor_ider: [f], vindue: null });
    const k = await db.query<{ kode_hash: string }>(`select kode_hash from public.staff_gendannelseskoder where bruger_id = $1`, [SAELGER]);
    expect(k.rows.map((r) => r.kode_hash).sort()).toEqual([...koder].sort());
    expect(await logAntal("to_trin_opsat", SAELGER)).toBe(foer + 1);
  });
});

describe("staff_to_trin_nulstil", () => {
  it("kun chefen, ikke sig selv", async () => {
    expect((await j(`select public.staff_to_trin_nulstil($1, $2, 24) as v`, [MEDARB, SAELGER])).kode).toBe("ingen_adgang");
    expect((await j(`select public.staff_to_trin_nulstil($1, $1, 24) as v`, [CHEF])).kode).toBe("egen");
  });

  it("sletter faktorer, KUN aal2-sessioner og ubrugte koder, åbner 24 t og logger - anden gang uaendret", async () => {
    await aktiver(MEDARB);
    await db.query(`delete from auth.sessions where user_id = $1`, [MEDARB]);
    await db.query(`insert into auth.sessions (user_id, aal) values ($1, 'aal1'), ($1, 'aal2'), ($1, 'aal2'), ($2, 'aal2')`, [MEDARB, CHEF]);
    const foer = await logAntal("to_trin_nulstillet", MEDARB);

    const r = await j(`select public.staff_to_trin_nulstil($1, $2, 24) as v`, [CHEF, MEDARB]);
    expect(r).toMatchObject({ kode: "ok", faktorer: 1, sessioner: 2 });
    const sess = await db.query<{ aal: string }>(`select aal from auth.sessions where user_id = $1`, [MEDARB]);
    expect(sess.rows.map((s) => s.aal)).toEqual(["aal1"]);
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.sessions where user_id = $1`, [CHEF])).n)).toBe(1);
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.mfa_factors where user_id = $1`, [MEDARB])).n)).toBe(0);
    expect(Number((await en<{ n: number }>(`select count(*)::int n from public.staff_gendannelseskoder where bruger_id = $1`, [MEDARB])).n)).toBe(0);
    const t = await en<{ aktiv: boolean; nulstillet_af: string; timer: number }>(
      `select aktiv, nulstillet_af, round(extract(epoch from tilmelding_aaben_til - now()) / 3600)::int timer from public.staff_to_trin where bruger_id = $1`,
      [MEDARB],
    );
    expect(t).toEqual({ aktiv: false, nulstillet_af: CHEF, timer: 24 });
    expect(await logAntal("to_trin_nulstillet", MEDARB)).toBe(foer + 1);

    expect((await j(`select public.staff_to_trin_nulstil($1, $2, 24) as v`, [CHEF, MEDARB])).kode).toBe("uaendret");
    expect(await logAntal("to_trin_nulstillet", MEDARB)).toBe(foer + 1);

    const status = await som("authenticated", MEDARB, { aal: "aal2" }, () => j(`select public.min_staff_adgang() as v`));
    expect(status).toMatchObject({ aktiv: false, tilmelding_aaben: true });
  });

  it("en anden chef kan nulstille chefen", async () => {
    await aktiver(CHEF);
    expect((await j(`select public.staff_to_trin_nulstil($1, $2, 24) as v`, [CHEF2, CHEF])).kode).toBe("ok");
  });
});

describe("staff_to_trin_aabn_tilmelding", () => {
  it("kun chefen, kun staff, ikke sig selv - opretter rækken for ny staff og logger", async () => {
    expect((await j(`select public.staff_to_trin_aabn_tilmelding($1, $2, 24) as v`, [MEDARB, SAELGER])).kode).toBe("ingen_adgang");
    expect((await j(`select public.staff_to_trin_aabn_tilmelding($1, $2, 24) as v`, [CHEF, BRUGER])).kode).toBe("ikke_staff");
    expect((await j(`select public.staff_to_trin_aabn_tilmelding($1, $1, 24) as v`, [CHEF])).kode).toBe("egen");
    await db.query(`update public.users set rolle = 'medarbejder' where id = $1`, [NY]);
    expect((await j(`select public.staff_to_trin_aabn_tilmelding($1, $2, 24) as v`, [CHEF, NY])).kode).toBe("ok");
    const t = await en<{ timer: number; af: string }>(
      `select round(extract(epoch from tilmelding_aaben_til - now()) / 3600)::int timer, tilmelding_aabnet_af af from public.staff_to_trin where bruger_id = $1`,
      [NY],
    );
    expect(t).toEqual({ timer: 24, af: CHEF });
    expect(await logAntal("to_trin_tilmelding_aabnet", NY)).toBe(1);
  });
});

describe("staff_gendan_brug", () => {
  it("forkert kode afvises; den rigtige virker én gang, sletter faktorer og aal2-sessioner og åbner 2 timer", async () => {
    const { koder } = await aktiver(MEDARB);
    await db.query(`insert into auth.sessions (user_id, aal) values ($1, 'aal2')`, [MEDARB]);
    expect((await j(`select public.staff_gendan_brug($1, $2) as v`, [MEDARB, hash("forkert")])).kode).toBe("forkert");
    expect((await j(`select public.staff_gendan_brug($1, $2) as v`, [MEDARB, "ikke-hex"])).kode).toBe("forkert");
    // En andens kode virker ikke.
    expect((await j(`select public.staff_gendan_brug($1, $2) as v`, [SAELGER, koder[0]])).kode).toBe("forkert");

    const r = await j(`select public.staff_gendan_brug($1, $2) as v`, [MEDARB, koder[0]]);
    expect(r).toMatchObject({ kode: "ok", tilbage: 9 });
    expect((await j(`select public.staff_gendan_brug($1, $2) as v`, [MEDARB, koder[0]])).kode).toBe("forkert");
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.mfa_factors where user_id = $1`, [MEDARB])).n)).toBe(0);
    expect(Number((await en<{ n: number }>(`select count(*)::int n from auth.sessions where user_id = $1 and aal = 'aal2'`, [MEDARB])).n)).toBe(0);
    const t = await en<{ aktiv: boolean; min: number }>(
      `select aktiv, round(extract(epoch from tilmelding_aaben_til - now()) / 60)::int min from public.staff_to_trin where bruger_id = $1`,
      [MEDARB],
    );
    expect(t).toEqual({ aktiv: false, min: 120 });
    expect(await logAntal("to_trin_gendannet", MEDARB)).toBe(1);
  });

  it("brugere uden staff-rolle kan ikke bruge en kode", async () => {
    expect((await j(`select public.staff_gendan_brug($1, $2) as v`, [BRUGER, hash("x")])).kode).toBe("forkert");
  });
});

describe("trigger på users.rolle", () => {
  it("forlader en medarbejder staff, er to-trins-login ikke aktivt, og vinduet lukkes", async () => {
    await aktiver(SAELGER);
    await db.query(`update public.users set rolle = 'bruger' where id = $1`, [SAELGER]);
    const t = await en<{ aktiv: boolean; vindue: string | null }>(
      `select aktiv, tilmelding_aaben_til vindue from public.staff_to_trin where bruger_id = $1`,
      [SAELGER],
    );
    expect(t).toEqual({ aktiv: false, vindue: null });
    // Skift mellem staff-roller rører ikke rækken.
    await db.query(`update public.users set rolle = 'saelger' where id = $1`, [SAELGER]);
    await aktiver(SAELGER);
    await db.query(`update public.users set rolle = 'admin' where id = $1`, [SAELGER]);
    expect((await en<{ aktiv: boolean }>(`select aktiv from public.staff_to_trin where bruger_id = $1`, [SAELGER])).aktiv).toBe(true);
  });
});
