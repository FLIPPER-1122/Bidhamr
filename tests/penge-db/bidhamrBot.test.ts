// Migrationen 20261102240000_bidhamr_bot.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Køres TO gange (idempotent). Tester loftet
// (pr. bruger, pr. IP, pr. samtale), ejerskab af samtalen, idempotent
// overdragelse til en medarbejder og at kun service_role kan kalde
// funktionerne og læse tabellerne.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102240000_bidhamr_bot.sql"),
  "utf8",
);

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const IP1 = "a".repeat(64);
const IP2 = "b".repeat(64);
const IP3 = "c".repeat(64);

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.users (id uuid primary key, email text);
insert into public.users values ('${A}', 'a@test.bidhamr.dk'), ('${B}', 'b@test.bidhamr.dk');
create table public.trades (id uuid primary key);
create table public.kontakt_henvendelser (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid references public.users(id) on delete set null,
  email text not null, emne text not null, besked text not null,
  handels_ref text, trade_id uuid references public.trades(id), status text not null default 'ny',
  besvaret_af uuid, besvaret_kl timestamptz, oprettet_kl timestamptz not null default now(),
  constraint kontakt_emne_check check (emne in ('generelt', 'handel', 'betaling', 'fejl')),
  constraint kontakt_besked_laengde check (char_length(btrim(besked)) between 10 and 4000));
`;

let db: PGlite;

async function rpc(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const r = await db.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, params);
  return r.rows[0].r;
}
const ny = (samtale: string | null, bruger: string | null, ip: string, tekst = "Hej bot") =>
  rpc("public.bot_ny_besked($1, $2, $3, 'web', $4)", [samtale, bruger, ip, tekst]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
});
afterAll(async () => {
  await db.close();
});

describe("loftet i databasen", () => {
  it("30 beskeder pr. bruger pr. døgn - den 31. afvises", async () => {
    const forste = await ny(null, A, IP1);
    expect(forste.kode).toBe("ok");
    const samtale = forste.samtale_id as string;
    // Fordel på flere samtaler (højst 40 pr. samtale) og IP'er.
    for (let i = 1; i < 30; i++) {
      const s = await ny(i < 20 ? samtale : null, A, i % 2 ? IP2 : IP1);
      expect(s.kode).toBe("ok");
    }
    expect((await ny(null, A, IP3)).kode).toBe("loft_bruger");
    // En anden bruger er ikke ramt.
    expect((await ny(null, B, IP3)).kode).toBe("ok");
  });

  it("beskeder ældre end et døgn tæller ikke", async () => {
    await db.exec(`update public.bot_beskeder set oprettet_kl = now() - interval '25 hours' where bruger_id = '${A}'`);
    expect((await ny(null, A, IP3)).kode).toBe("ok");
  });

  it("30 pr. IP pr. døgn uden login", async () => {
    const ip = "d".repeat(64);
    for (let i = 0; i < 30; i++) expect((await ny(null, null, ip)).kode).toBe("ok");
    expect((await ny(null, null, ip)).kode).toBe("loft_ip");
  });

  it("100 pr. IP pr. døgn i alt (også indloggede)", async () => {
    const ip = "e".repeat(64);
    await db.exec(`
      insert into public.bot_samtaler (id, ip_hash) values ('00000000-0000-4000-8000-00000000e001', '${ip}');
      insert into public.bot_beskeder (samtale_id, rolle, tekst, ip_hash)
        select '00000000-0000-4000-8000-00000000e001', 'bruger', 'x', '${ip}' from generate_series(1, 100);`);
    expect((await ny(null, B, ip)).kode).toBe("loft_ip");
  });

  it("længden tjekkes også i databasen", async () => {
    expect((await ny(null, B, IP1, "x".repeat(1001))).kode).toBe("ugyldig_laengde");
    expect((await ny(null, B, IP1, "   ")).kode).toBe("ugyldig_laengde");
  });

  it("en samtale kan kun fortsættes af sin ejer", async () => {
    const s = (await ny(null, B, IP1)).samtale_id as string;
    expect((await ny(s, A, IP1)).kode).toBe("ukendt_samtale");
    expect((await ny(s, null, IP1)).kode).toBe("ukendt_samtale");
    const anon = (await ny(null, null, IP2)).samtale_id as string;
    expect((await ny(anon, B, IP2)).kode).toBe("ukendt_samtale");
  });

  it("højst 40 beskeder pr. samtale", async () => {
    await db.exec(`update public.bot_beskeder set oprettet_kl = now() - interval '25 hours'`);
    const s = (await ny(null, B, IP3)).samtale_id as string;
    await db.exec(`
      insert into public.bot_beskeder (samtale_id, rolle, tekst, bruger_id, ip_hash, oprettet_kl)
        select '${s}', 'bruger', 'x', '${B}', '${IP3}', now() - interval '25 hours' from generate_series(1, 39);`);
    expect((await ny(s, B, IP3)).kode).toBe("samtale_fuld");
  });
});

describe("svar, forbrug og medarbejder", () => {
  it("svaret og forbruget gemmes, og oversigten summerer prisen", async () => {
    const s = (await ny(null, B, IP1)).samtale_id as string;
    const r = await rpc(
      "public.bot_gem_svar($1, 'Svar', 'claude-haiku-5-5', 100, 50, 900, 0, 0.000135, array['hent_mine_handler'], 'end_turn', 2)",
      [s],
    );
    expect(r.kode).toBe("ok");
    const o = await rpc("public.bot_forbrug_oversigt()");
    expect(Number((o.alt as Record<string, unknown>).pris_usd)).toBeCloseTo(0.000135);
    expect(Number((o.doegn as Record<string, unknown>).output_tokens)).toBe(50);
  });

  it("overdragelse er idempotent og kræver e-mail uden login", async () => {
    const s = (await ny(null, B, IP1)).samtale_id as string;
    const f1 = await rpc("public.bot_overdrag($1, $2, null, 'Bruger: Hjælp mig med min handel')", [s, B]);
    expect(f1.kode).toBe("ok");
    const f2 = await rpc("public.bot_overdrag($1, $2, null, 'Bruger: Hjælp mig med min handel')", [s, B]);
    expect(f2.kode).toBe("allerede");
    expect(f2.henvendelse_id).toBe(f1.henvendelse_id);
    const h = await db.query<{ emne: string; email: string; n: number }>(
      `select emne, email, (select count(*)::int from public.kontakt_henvendelser where bot_samtale_id = $1) as n
         from public.kontakt_henvendelser where bot_samtale_id = $1`,
      [s],
    );
    expect(h.rows[0]).toEqual({ emne: "bot", email: "b@test.bidhamr.dk", n: 1 });
    // En anden bruger kan ikke overdrage samtalen.
    expect((await rpc("public.bot_overdrag($1, $2, null, 'xxxxxxxxxxxx')", [s, A])).kode).toBe("ukendt_samtale");

    const anon = (await ny(null, null, IP3)).samtale_id as string;
    expect((await rpc("public.bot_overdrag($1, null, 'ikke-en-mail', 'xxxxxxxxxxxx')", [anon])).kode).toBe("ugyldig_email");
    expect((await rpc("public.bot_overdrag($1, null, 'Gaest@Test.bidhamr.dk', 'xxxxxxxxxxxx')", [anon])).kode).toBe("ok");
    const e = await db.query<{ email: string }>(`select email from public.bot_samtaler where id = $1`, [anon]);
    expect(e.rows[0].email).toBe("gaest@test.bidhamr.dk");
  });
});

describe("rettigheder", () => {
  it("kun service_role kan kalde funktionerne og læse tabellerne", async () => {
    const r = await db.query<{ rolle: string; fn: string; ok: boolean }>(`
      select r.rolle, f.fn, has_function_privilege(r.rolle, f.fn, 'execute') as ok
        from (values ('anon'), ('authenticated'), ('service_role')) r(rolle),
             (values ('public.bot_ny_besked(uuid, uuid, text, text, text)'),
                     ('public.bot_gem_svar(uuid, text, text, integer, integer, integer, integer, numeric, text[], text, integer)'),
                     ('public.bot_overdrag(uuid, uuid, text, text)'),
                     ('public.bot_forbrug_oversigt()')) f(fn)`);
    for (const x of r.rows) expect(x.ok, `${x.rolle} ${x.fn}`).toBe(x.rolle === "service_role");
    const t = await db.query<{ rolle: string; ok: boolean }>(`
      select r.rolle, has_table_privilege(r.rolle, 'public.bot_beskeder', 'select')
                      or has_table_privilege(r.rolle, 'public.bot_samtaler', 'select') as ok
        from (values ('anon'), ('authenticated')) r(rolle)`);
    for (const x of t.rows) expect(x.ok).toBe(false);
  });
});
