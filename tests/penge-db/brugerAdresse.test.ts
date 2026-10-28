// Migrationen 20261102340000_bruger_adresse.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Køres TO gange (idempotent).
// Testes:
//   - RLS: brugeren ser kun sin egen adresse og kan ikke skrive direkte,
//   - gem_min_adresse: validering, byen fra postnummerlisten, auth.uid(),
//     uændret adresse giver ingen ny opdateret_kl, lukket konto afvises,
//   - krav før bud (BHY01) på bids og bud_maksimum - automatiske bud,
//     firmakonti og systembrugeren er undtaget,
//   - kontosletning: slettes uden handler, bevares med handler,
//   - mine_data: nøglen 'adresse', og de andre udvidelser bevares,
//   - rettigheder på funktionerne.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102340000_bruger_adresse.sql"),
  "utf8",
);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1); // privat, får adresse
const B = id(2); // privat, uden adresse
const FIRMA = id(3);
const SYSTEM = id(4);
const LUKKET = id(5);
const UDEN_HANDEL = id(6);
const MED_HANDEL = id(7);
const AUK = id(101);

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
create table public.users (
  id uuid primary key, konto_type text, konto_slettet_kl timestamptz, konto_lukket_kl timestamptz);
insert into public.users (id, konto_type, konto_lukket_kl) values
  ('${A}', 'privat', null), ('${B}', null, null), ('${FIRMA}', 'erhverv', null), ('${SYSTEM}', 'privat', null),
  ('${LUKKET}', 'privat', now()), ('${UDEN_HANDEL}', 'privat', null), ('${MED_HANDEL}', 'privat', null);
create function public.bidhamr_system_id() returns uuid language sql immutable as $$ select '${SYSTEM}'::uuid $$;
create table public.postnummer_koordinater (postnummer text primary key, bynavn text not null, lat float8, lng float8);
insert into public.postnummer_koordinater values ('2100', 'København Ø', 0, 0), ('4700', 'Næstved', 0, 0);
create table public.trades (id uuid primary key default gen_random_uuid(), buyer_id uuid, seller_id uuid);
insert into public.trades (buyer_id, seller_id) values ('${MED_HANDEL}', '${A}');
create table public.bids (
  id uuid primary key default gen_random_uuid(), auktion_id uuid not null, bruger_id uuid not null,
  "beløb" numeric not null, automatisk boolean not null default false);
create table public.bud_maksimum (
  auktion_id uuid not null, bruger_id uuid not null, maks_beloeb numeric not null, primary key (auktion_id, bruger_id));
grant select, insert on public.bids, public.bud_maksimum to authenticated;
grant update on public.bud_maksimum to authenticated;
-- mine_data som i produktion, med udvidelser fra andre migrationer.
create function public.mine_data_grund() returns jsonb language sql as $$ select jsonb_build_object('profil', '{}'::jsonb) $$;
create function public.mine_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  v := public.mine_data_grund()
       || jsonb_build_object('bidhamr_bot', '[]'::jsonb)
       || jsonb_build_object('henvis_en_ven', '{}'::jsonb);
  return v || jsonb_build_object('mitid', '{}'::jsonb);
end $$;
`;

let db: PGlite;

async function som<T>(bruger: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role authenticated`);
  if (bruger) await db.exec(`set request.jwt.claim.sub = '${bruger}'`);
  else await db.exec(`reset request.jwt.claim.sub`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role; reset request.jwt.claim.sub`);
  }
}

async function fejlkode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "ukendt";
  }
}

const gem = (bruger: string | null, adresse: string, postnummer: string) =>
  som<{ r: Record<string, unknown> }>(bruger, `select public.gem_min_adresse($1, $2) as r`, [adresse, postnummer]).then(
    (r) => r[0].r,
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
});
afterAll(async () => {
  await db.close();
});

describe("gem_min_adresse", () => {
  it("gemmer egen adresse, renser mellemrum og sætter byen fra postnummeret", async () => {
    expect(await gem(A, "  Testvej   12, 2. th. ", "2100")).toEqual({
      kode: "ok",
      adresse: "Testvej 12, 2. th.",
      postnummer: "2100",
      by: "København Ø",
    });
    const r = await db.query<{ bynavn: string }>(`select bynavn from public.bruger_adresser where bruger_id = $1`, [A]);
    expect(r.rows[0].bynavn).toBe("København Ø");
  });

  it("afviser ugyldig adresse, ukendt postnummer, uden login og lukket konto", async () => {
    expect((await gem(B, "Testvej", "2100")).kode).toBe("adresse");
    expect((await gem(B, "12", "2100")).kode).toBe("adresse");
    expect((await gem(B, "Testvej 1", "9999")).kode).toBe("postnummer");
    expect((await gem(B, "Testvej 1", "21a0")).kode).toBe("postnummer");
    expect((await gem(null, "Testvej 1", "2100")).kode).toBe("ikke_logget_ind");
    expect((await gem(LUKKET, "Testvej 1", "2100")).kode).toBe("konto");
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.bruger_adresser where bruger_id in ($1, $2)`, [B, LUKKET]);
    expect(n.rows[0].n).toBe(0);
  });

  it("samme adresse igen (dobbeltklik) ændrer ikke opdateret_kl; en ny gør", async () => {
    await db.exec(`update public.bruger_adresser set opdateret_kl = '2020-01-01' where bruger_id = '${A}'`);
    await gem(A, "Testvej 12, 2. th.", "2100");
    const f = await db.query<{ t: string }>(`select opdateret_kl::text as t from public.bruger_adresser where bruger_id = $1`, [A]);
    expect(f.rows[0].t.startsWith("2020-01-01")).toBe(true);
    await gem(A, "Testvej 14", "4700");
    const e = await db.query<{ t: string; bynavn: string }>(
      `select opdateret_kl::text as t, bynavn from public.bruger_adresser where bruger_id = $1`, [A]);
    expect(e.rows[0].t.startsWith("2020-01-01")).toBe(false);
    expect(e.rows[0].bynavn).toBe("Næstved");
  });
});

describe("RLS og rettigheder", () => {
  it("brugeren ser kun sin egen adresse; andre og anon ser intet", async () => {
    expect(await som(A, `select bruger_id from public.bruger_adresser`)).toEqual([{ bruger_id: A }]);
    expect(await som(B, `select bruger_id from public.bruger_adresser`)).toEqual([]);
    await db.exec(`set role anon`);
    expect(await fejlkode(() => db.query(`select * from public.bruger_adresser`))).toBe("42501");
    await db.exec(`reset role`);
  });

  it("ingen kan skrive direkte i tabellen", async () => {
    expect(await fejlkode(() => som(A, `update public.bruger_adresser set adresse = 'Hack 1'`))).toBe("42501");
    expect(
      await fejlkode(() =>
        som(B, `insert into public.bruger_adresser (bruger_id, adresse, postnummer, bynavn) values ('${B}', 'Vej 1', '2100', 'X')`),
      ),
    ).toBe("42501");
    expect(await fejlkode(() => som(A, `delete from public.bruger_adresser`))).toBe("42501");
  });

  it("kun authenticated kalder gem_min_adresse; interne funktioner er lukkede", async () => {
    const r = await db.query<{ rolle: string; fn: string; ok: boolean }>(`
      select r.rolle, f.fn, has_function_privilege(r.rolle, f.fn, 'execute') as ok
        from (values ('anon'), ('authenticated'), ('service_role')) r(rolle),
             (values ('public.gem_min_adresse(text, text)'), ('public.bruger_adresse_gem(uuid, text, text)'),
                     ('public.adresse_kraev(uuid)'), ('public.mine_data_adresse(uuid)'),
                     ('public.users_adresse_ved_sletning()')) f(fn)`);
    const forventet: Record<string, string[]> = {
      "public.gem_min_adresse(text, text)": ["authenticated"],
      "public.bruger_adresse_gem(uuid, text, text)": ["service_role"],
    };
    for (const x of r.rows) expect(x.ok, `${x.rolle} ${x.fn}`).toBe((forventet[x.fn] ?? []).includes(x.rolle));
  });
});

describe("krav før bud (BHY01)", () => {
  const byd = (bruger: string, automatisk = false) =>
    db.query(`insert into public.bids (auktion_id, bruger_id, "beløb", automatisk) values ($1, $2, 100, $3)`, [AUK, bruger, automatisk]);

  it("privat uden adresse afvises; med adresse går buddet igennem", async () => {
    expect(await fejlkode(() => byd(B))).toBe("BHY01");
    expect(await fejlkode(() => byd(A))).toBeNull();
  });

  it("automatiske bud, firmakonti og systembrugeren er undtaget", async () => {
    expect(await fejlkode(() => byd(B, true))).toBeNull();
    expect(await fejlkode(() => byd(FIRMA))).toBeNull();
    expect(await fejlkode(() => byd(SYSTEM))).toBeNull();
  });

  it("maksimum: nyt eller ændret beløb kræver adresse; andre ændringer ikke", async () => {
    expect(
      await fejlkode(() => db.query(`insert into public.bud_maksimum values ($1, $2, 500)`, [AUK, B])),
    ).toBe("BHY01");
    await db.exec(`alter table public.bud_maksimum disable trigger a1_bud_maksimum_adresse`);
    await db.query(`insert into public.bud_maksimum values ($1, $2, 500)`, [AUK, B]);
    await db.exec(`alter table public.bud_maksimum enable trigger a1_bud_maksimum_adresse`);
    // Uændret beløb (fx et maksimum fra før kravet): ingen afvisning.
    expect(await fejlkode(() => db.query(`update public.bud_maksimum set maks_beloeb = 500 where bruger_id = $1`, [B]))).toBeNull();
    expect(
      await fejlkode(() => db.query(`update public.bud_maksimum set maks_beloeb = 600 where bruger_id = $1`, [B])),
    ).toBe("BHY01");
    expect(await fejlkode(() => db.query(`insert into public.bud_maksimum values ($1, $2, 500)`, [AUK, A]))).toBeNull();
  });
});

describe("kontosletning", () => {
  it("uden handler slettes adressen; med handler bevares den", async () => {
    await gem(UDEN_HANDEL, "Slettevej 1", "2100");
    await gem(MED_HANDEL, "Handelsvej 2", "2100");
    await db.exec(`update public.users set konto_slettet_kl = now() where id in ('${UDEN_HANDEL}', '${MED_HANDEL}')`);
    const r = await db.query<{ bruger_id: string }>(
      `select bruger_id from public.bruger_adresser where bruger_id in ($1, $2)`, [UDEN_HANDEL, MED_HANDEL]);
    expect(r.rows.map((x) => x.bruger_id)).toEqual([MED_HANDEL]);
    // En slettet konto kan ikke få en ny adresse.
    expect((await gem(MED_HANDEL, "Nyvej 3", "2100")).kode).toBe("konto");
  });
});

describe("mine_data", () => {
  it("har nøglen 'adresse' med egen adresse, og de andre udvidelser bevares", async () => {
    const [r] = await som<{ r: Record<string, unknown> }>(A, `select public.mine_data() as r`);
    expect(r.r.adresse).toMatchObject({ adresse: "Testvej 14", postnummer: "4700", by: "Næstved" });
    expect(Object.keys(r.r)).toEqual(expect.arrayContaining(["profil", "bidhamr_bot", "henvis_en_ven", "mitid", "adresse"]));
    const [b] = await som<{ r: Record<string, unknown> }>(B, `select public.mine_data() as r`);
    expect(b.r.adresse).toBeNull();
  });

  it("fletningen sker kun én gang (migrationen kørt to gange)", async () => {
    const r = await db.query<{ d: string }>(`select pg_get_functiondef('public.mine_data()'::regprocedure) as d`);
    expect(r.rows[0].d.split("public.mine_data_adresse(v_uid)").length - 1).toBe(1);
  });
});
