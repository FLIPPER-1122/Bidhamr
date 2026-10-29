// 20261102430000 (afsnit "enhed") i PGlite: kendt enhed på admin-hosten
// kun efter to-trins-login (TOTP), markeringen ryddes ved ny adgangskode,
// nulstillet to-trins-login og "Log ud andre steder", og chefens udvej
// "Nulstil login-loft" (review af 20261102410000, punkt 1 og 3).
// Afsnittet køres TO gange (idempotent).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rettelseAfsnit } from "./huskelisteAfsnit";

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const MED = "00000000-0000-4000-8000-0000000000c2";
const BRUGER = "00000000-0000-4000-8000-0000000000c3";
const MED2 = "00000000-0000-4000-8000-0000000000c4";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

// Kun det fra drift, som afsnittet bruger (kendte_enheder som i
// 20261007030000, staff_to_trin_er_staff_rolle som i 20261027010000).
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
grant usage on schema public to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, encrypted_password text);
create table public.users (id uuid primary key, email text unique, rolle text not null default 'bruger');
create table public.kendte_enheder (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid not null references public.users(id) on delete cascade,
  enhed_hash text not null check (enhed_hash ~ '^[0-9a-f]{64}$'),
  beskrivelse text not null default 'Chrome på Windows',
  session_id uuid,
  foerst_set_kl timestamptz not null default now(),
  sidst_set_kl timestamptz not null default now(),
  constraint kendte_enheder_unik unique (bruger_id, enhed_hash));
create table public.rate_limits (noegle text not null, vindue_start timestamptz not null, antal integer not null default 0,
  primary key (noegle, vindue_start));
create table public.staff_to_trin (bruger_id uuid primary key references public.users(id), aktiv boolean not null default false);
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now(),
  constraint moderation_log_handling_check check (handling = any (array['advarsel', 'to_trin_nulstillet'])),
  constraint moderation_log_maal_type_check check (maal_type = any (array['bruger', 'system'])));
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

async function v<T = unknown>(sql: string, p: unknown[] = []): Promise<T> {
  return (await db.query<{ v: T }>(sql, p)).rows[0].v;
}
const undtaget = (b: string, h: string | null) => v<string>(`select public.admin_login_loft_undtaget($1, $2) v`, [b, h]);
const mfa = (b: string, h: string) => v<boolean>(`select public.kendt_enhed_admin_mfa($1, $2) v`, [b, h]);
const nulstil = (chef: string, b: string, min = 30) =>
  v<Record<string, unknown>>(`select public.staff_login_loft_nulstil($1, $2, $3) v`, [chef, b, min]);
const markeret = async (b: string) =>
  Number(await v<number>(`select count(*)::int v from public.kendte_enheder where bruger_id = $1 and admin_mfa_kl is not null`, [b]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  for (const [id, email, rolle] of [
    [CHEF, "chef@test.dk", "chef"],
    [MED, "Med@Test.dk", "medarbejder"],
    [BRUGER, "bruger@test.dk", "bruger"],
    [MED2, "med2@test.dk", "admin"],
  ] as const) {
    await db.query(`insert into auth.users (id, email, encrypted_password) values ($1, $2, 'gammel')`, [id, email]);
    await db.query(`insert into public.users (id, email, rolle) values ($1, $2, $3)`, [id, email, rolle]);
  }
  await db.query(`insert into public.staff_to_trin (bruger_id, aktiv) values ($1, true), ($2, true), ($3, true)`, [CHEF, MED, MED2]);
  const afsnit = rettelseAfsnit("enhed");
  await db.exec(afsnit);
  await db.exec(afsnit); // idempotent
});

afterAll(async () => {
  await db.close();
});

describe("kendt enhed kun efter to-trins-login", () => {
  it("et login med adgangskoden alene gør ikke enheden kendt", async () => {
    // Som registrer_login efter adgangskoden.
    await db.query(`insert into public.kendte_enheder (bruger_id, enhed_hash) values ($1, $2), ($1, $3)`, [MED, H1, H2]);
    expect(await undtaget(MED, H1)).toBe("nej");
    expect(await undtaget(MED, null)).toBe("nej");
  });

  it("efter koden fra app'en: netop den enhed er kendt - ikke andre, ikke andre brugere", async () => {
    expect(await mfa(MED, H1)).toBe(true);
    expect(await undtaget(MED, H1)).toBe("enhed");
    expect(await undtaget(MED, H2)).toBe("nej");
    expect(await undtaget(MED2, H1)).toBe("nej"); // MED's enhed, ikke MED2's
    // En enhed, der ikke er registreret, og et ugyldigt hash.
    expect(await mfa(MED, "3".repeat(64))).toBe(false);
    expect(await mfa(MED, "ikke-hash")).toBe(false);
  });

  it("højst 90 dage gammel", async () => {
    await db.query(`update public.kendte_enheder set admin_mfa_kl = now() - interval '91 days' where bruger_id = $1 and enhed_hash = $2`, [MED, H1]);
    expect(await undtaget(MED, H1)).toBe("nej");
    await mfa(MED, H1);
    expect(await undtaget(MED, H1)).toBe("enhed");
  });

  it("en almindelig bruger kan aldrig være undtaget", async () => {
    await db.query(`insert into public.kendte_enheder (bruger_id, enhed_hash, admin_mfa_kl) values ($1, $2, now())`, [BRUGER, H1]);
    expect(await undtaget(BRUGER, H1)).toBe("nej");
  });
});

describe("markeringen ryddes", () => {
  it("ved ny adgangskode - kun for den bruger; andre opdateringer rydder ikke", async () => {
    await mfa(MED, H1);
    await mfa(MED, H2);
    await db.query(`insert into public.kendte_enheder (bruger_id, enhed_hash) values ($1, $2)`, [MED2, H1]);
    expect(await mfa(MED2, H1)).toBe(true);
    expect(await markeret(MED)).toBe(2);
    await db.query(`update auth.users set email = 'x@test.dk' where id = $1`, [MED]);
    expect(await markeret(MED)).toBe(2);
    await db.query(`update auth.users set encrypted_password = 'gammel' where id = $1`, [MED]); // samme
    expect(await markeret(MED)).toBe(2);
    await db.query(`update auth.users set encrypted_password = 'ny' where id = $1`, [MED]);
    expect(await markeret(MED)).toBe(0);
    expect(await undtaget(MED, H1)).toBe("nej");
    // Den anden medarbejders enhed røres ikke.
    expect(await markeret(MED2)).toBe(1);
  });

  it("når to-trins-loginet nulstilles eller gendannes (aktiv -> false)", async () => {
    await mfa(MED, H1);
    await db.query(`update public.staff_to_trin set aktiv = true where bruger_id = $1`, [MED]); // uændret
    expect(await markeret(MED)).toBe(1);
    await db.query(`update public.staff_to_trin set aktiv = false where bruger_id = $1`, [MED]);
    expect(await markeret(MED)).toBe(0);
    await db.query(`update public.staff_to_trin set aktiv = true where bruger_id = $1`, [MED]);
  });

  it("ved \"Log ud andre steder\" (kendte_enheder_ryd_admin_mfa)", async () => {
    await mfa(MED, H1);
    await mfa(MED, H2);
    expect(await v<number>(`select public.kendte_enheder_ryd_admin_mfa($1) v`, [MED])).toBe(2);
    expect(await markeret(MED)).toBe(0);
    expect(await v<number>(`select public.kendte_enheder_ryd_admin_mfa($1) v`, [MED])).toBe(0);
  });
});

describe("chefens udvej: Nulstil login-loft", () => {
  it("kun chefen, ikke sig selv, kun staff som mål", async () => {
    expect(await nulstil(MED2, MED)).toEqual({ kode: "ingen_adgang" });
    expect(await nulstil(CHEF, CHEF)).toEqual({ kode: "egen" });
    expect(await nulstil(CHEF, BRUGER)).toEqual({ kode: "ikke_staff" });
    expect(Number(await v<number>(`select count(*)::int v from public.moderation_log`))).toBe(0);
  });

  it("tællerne pr. e-mail slettes (kun for medarbejderen), loftet gælder ikke i 30 minutter, og det logges", async () => {
    await db.exec(`insert into public.rate_limits (noegle, vindue_start, antal) values
      ('admin_login_email:med@test.dk', now(), 10), ('admin_gendan_email:med@test.dk', now(), 5),
      ('admin_login_email:med2@test.dk', now(), 10), ('admin_login_email_ip:med@test.dk|10.0.0.1', now(), 5)`);
    expect(await undtaget(MED, null)).toBe("nej");
    const r = await nulstil(CHEF, MED);
    expect(r).toMatchObject({ kode: "ok", taellere: 2 });
    const til = new Date(String(r.fritaget_til)).getTime();
    expect(til - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(til - Date.now()).toBeLessThan(31 * 60_000);
    const tilbage = (await db.query<{ noegle: string }>(`select noegle from public.rate_limits order by 1`)).rows.map((x) => x.noegle);
    // Loftet pr. e-mail+IP og den anden medarbejders tæller bliver stående.
    expect(tilbage).toEqual(["admin_login_email:med2@test.dk", "admin_login_email_ip:med@test.dk|10.0.0.1"]);
    expect(await undtaget(MED, null)).toBe("fritaget");
    expect(await undtaget(MED2, null)).toBe("nej");
    const log = (await db.query<{ medarbejder_id: string; handling: string; maal_type: string; bruger_id: string; aarsag: string }>(
      `select medarbejder_id, handling, maal_type, bruger_id, aarsag from public.moderation_log`)).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ medarbejder_id: CHEF, handling: "login_loft_nulstillet", maal_type: "bruger", bruger_id: MED });
    expect(log[0].aarsag).toMatch(/2 tæller\(e\) slettet/);
  });

  it("dobbeltklik: ingen ny log-linje", async () => {
    expect((await nulstil(CHEF, MED)).kode).toBe("uaendret");
    expect(Number(await v<number>(`select count(*)::int v from public.moderation_log`))).toBe(1);
  });

  it("fritagelsen slutter, når medarbejderen har gennemført to-trins-loginet - og efter tiden", async () => {
    await mfa(MED, H1);
    expect(await undtaget(MED, null)).toBe("nej");
    expect(await undtaget(MED, H1)).toBe("enhed");
    // Efter tiden.
    expect((await nulstil(CHEF, MED, 5)).kode).toBe("ok");
    expect(await undtaget(MED, null)).toBe("fritaget");
    await db.query(`update public.staff_login_loft_fritagelse set fritaget_til = now() - interval '1 second' where bruger_id = $1`, [MED]);
    expect(await undtaget(MED, null)).toBe("nej");
  });

  it("nye værdier i moderation_log - de gamle er bevaret", async () => {
    const def = await v<string>(
      `select pg_get_constraintdef(oid) v from pg_constraint where conname = 'moderation_log_handling_check'`);
    for (const x of ["advarsel", "to_trin_nulstillet", "login_loft_nulstillet"]) expect(def).toContain(x);
  });
});

describe("rettigheder", () => {
  it("kun service_role", async () => {
    for (const rolle of ["authenticated", "anon"]) {
      await db.exec(`set role ${rolle}`);
      try {
        for (const sql of [
          `select public.admin_login_loft_undtaget('${MED}', null)`,
          `select public.kendt_enhed_admin_mfa('${MED}', '${H1}')`,
          `select public.kendte_enheder_ryd_admin_mfa('${MED}')`,
          `select public.staff_login_loft_nulstil('${CHEF}', '${MED}', 30)`,
          `select * from public.staff_login_loft_fritagelse`,
        ]) {
          await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
        }
      } finally {
        await db.exec(`reset role`);
      }
    }
  });

  it("forudsætningerne mangler: afsnittet stopper med en tydelig fejl", async () => {
    const d = new PGlite();
    await d.exec(`create role anon; create role authenticated; create role service_role;`);
    await expect(d.exec(rettelseAfsnit("enhed"))).rejects.toThrow(/kør de tidligere migrationer først/);
    await d.close();
  });
});
