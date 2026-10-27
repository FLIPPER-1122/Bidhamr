// Migrationerne 20261102240000_bidhamr_bot.sql og 20261102290000_bot_rettelser.sql
// i PGlite (Postgres i processen - ingen database, intet netværk). Køres TO
// gange (idempotent). Tester loftet (pr. bruger, pr. IP, pr. samtale, uden
// login samlet og i USD), ejerskab af samtalen (og samme IP uden login),
// idempotent overdragelse til en medarbejder, kontosletning, den daglige
// rensning, "Download dine data" og at kun service_role kan kalde
// funktionerne og læse tabellerne.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102240000_bidhamr_bot.sql"),
  "utf8",
);
const RETTELSER = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261102290000_bot_rettelser.sql"),
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
create table public.users (id uuid primary key, email text, konto_slettet_kl timestamptz);
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
-- mine_data som i produktion (20261014010000 + 20261016020000), plus en
-- udvidelse fra en anden migration (henvisninger), der skal blive stående.
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
       || jsonb_build_object('erhverv_klager', '[]'::jsonb)
       || jsonb_build_object('henvisninger', '[]'::jsonb);
  return v || jsonb_build_object('mitid', '{}'::jsonb);
end $$;
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
  await db.exec(RETTELSER);
  await db.exec(RETTELSER);
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
    expect((await rpc("public.bot_overdrag($1, null, 'ikke-en-mail', 'xxxxxxxxxxxx', $2)", [anon, IP3])).kode).toBe("ugyldig_email");
    // Uden login: kun fra samme IP (og ikke uden IP - den gamle signatur).
    expect((await rpc("public.bot_overdrag($1, null, 'gaest@test.bidhamr.dk', 'xxxxxxxxxxxx', $2)", [anon, IP2])).kode).toBe("ukendt_samtale");
    expect((await rpc("public.bot_overdrag($1, null, 'gaest@test.bidhamr.dk', 'xxxxxxxxxxxx')", [anon])).kode).toBe("ukendt_samtale");
    expect((await rpc("public.bot_overdrag($1, null, 'Gaest@Test.bidhamr.dk', 'xxxxxxxxxxxx', $2)", [anon, IP3])).kode).toBe("ok");
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
                     ('public.bot_overdrag(uuid, uuid, text, text, text)'),
                     ('public.bot_forbrug_oversigt()'),
                     ('public.bot_rens()')) f(fn)`);
    for (const x of r.rows) expect(x.ok, `${x.rolle} ${x.fn}`).toBe(x.rolle === "service_role");
    const t = await db.query<{ rolle: string; ok: boolean }>(`
      select r.rolle, has_table_privilege(r.rolle, 'public.bot_beskeder', 'select')
                      or has_table_privilege(r.rolle, 'public.bot_samtaler', 'select')
                      or has_table_privilege(r.rolle, 'public.bot_indstillinger', 'select') as ok
        from (values ('anon'), ('authenticated')) r(rolle)`);
    for (const x of t.rows) expect(x.ok).toBe(false);
    // Interne funktioner: ingen (heller ikke service_role) kalder dem direkte.
    const intern = await db.query<{ rolle: string; ok: boolean }>(`
      select r.rolle, has_function_privilege(r.rolle, 'public.mine_data_bot(uuid)', 'execute')
                      or has_function_privilege(r.rolle, 'public.bot_ved_kontosletning()', 'execute') as ok
        from (values ('anon'), ('authenticated'), ('service_role')) r(rolle)`);
    for (const x of intern.rows) expect(x.ok, x.rolle).toBe(false);
    // Den gamle bot_overdrag uden IP findes ikke længere.
    const gl = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'bot_overdrag'`);
    expect(gl.rows[0].n).toBe(1);
  });
});

// Alt fra før tælles ikke med i døgnlofterne nedenfor.
async function nulstilDoegn() {
  await db.exec(`update public.bot_beskeder set oprettet_kl = now() - interval '25 hours' where oprettet_kl > now() - interval '24 hours'`);
}

describe("rettelser (20261102290000)", () => {
  const C = "00000000-0000-4000-8000-0000000000c1";
  const IP4 = "4".repeat(64);
  const IP5 = "5".repeat(64);

  it("en samtale uden login kan kun fortsættes fra samme IP", async () => {
    await nulstilDoegn();
    const s = (await ny(null, null, IP4)).samtale_id as string;
    expect((await ny(s, null, IP5)).kode).toBe("ukendt_samtale");
    expect((await ny(s, null, IP4)).kode).toBe("ok");
    // Indlogget: IP'en må skifte (mobil/wifi).
    const b = (await ny(null, B, IP4)).samtale_id as string;
    expect((await ny(b, B, IP5)).kode).toBe("ok");
  });

  it("loft for alle uden login samlet - indloggede har stadig plads", async () => {
    await nulstilDoegn();
    await db.exec(`update public.bot_indstillinger set doegnloft_anon = 3`);
    for (let i = 0; i < 3; i++) expect((await ny(null, null, `${i}`.repeat(64))).kode).toBe("ok");
    const fuld = await ny(null, null, "9".repeat(64));
    expect(fuld).toMatchObject({ kode: "loft_alle", grund: "anon" });
    expect((await ny(null, A, "9".repeat(64))).kode).toBe("ok");
    await db.exec(`update public.bot_indstillinger set doegnloft_anon = 2000`);
  });

  it("loft i USD: over 2 USD det seneste døgn giver loft_alle og én alarm pr. døgn", async () => {
    await nulstilDoegn();
    const s = (await ny(null, A, IP4)).samtale_id as string;
    await rpc("public.bot_gem_svar($1, 'Svar', 'claude-opus-5-5', 1, 1, 0, 0, 1.5, '{}', 'end_turn', 1)", [s]);
    expect((await ny(s, A, IP4)).kode).toBe("ok");
    await rpc("public.bot_gem_svar($1, 'Svar', 'claude-opus-5-5', 1, 1, 0, 0, 0.6, '{}', 'end_turn', 1)", [s]);
    const f1 = await ny(s, A, IP4);
    expect(f1).toMatchObject({ kode: "loft_alle", grund: "usd", alarm: true });
    expect(Number(f1.usd)).toBeCloseTo(2.1);
    const f2 = await ny(null, B, IP5);
    expect(f2).toMatchObject({ kode: "loft_alle", grund: "usd", alarm: false });
    // Loftet kan ændres uden en ny migration.
    await db.exec(`update public.bot_indstillinger set doegnloft_usd = 5`);
    expect((await ny(s, A, IP4)).kode).toBe("ok");
    await db.exec(`update public.bot_indstillinger set doegnloft_usd = 2`);
    await nulstilDoegn();
    expect((await ny(s, A, IP4)).kode).toBe("ok");
  });

  it("kontosletning: tekst og e-mail væk, henvendelsen får en pladsholder, forbruget bevares", async () => {
    await db.exec(`insert into public.users values ('${C}', 'c@test.bidhamr.dk', null)`);
    const s = (await ny(null, C, IP4, "Min adresse er Testvej 1")).samtale_id as string;
    await rpc("public.bot_gem_svar($1, 'Svar til C', 'claude-haiku-5-5', 100, 50, 0, 0, 0.0001, '{}', 'end_turn', 1)", [s]);
    expect((await rpc("public.bot_overdrag($1, $2, null, 'Bruger:\n> Min adresse er Testvej 1')", [s, C])).kode).toBe("ok");
    await db.exec(`update public.bot_samtaler set email = 'gammel@test.bidhamr.dk' where id = '${s}'`);
    // En anden brugers samtale må ikke røres.
    const andens = (await ny(null, B, IP4, "Bs egen besked")).samtale_id as string;

    await db.exec(`update public.users set konto_slettet_kl = now() where id = '${C}'`);

    const b = await db.query<{ tekst: string; input_tokens: number; pris_usd: string; model: string | null }>(
      `select tekst, input_tokens, pris_usd::text, model from public.bot_beskeder where samtale_id = $1 order by oprettet_kl`, [s]);
    expect(b.rows.map((r) => r.tekst)).toEqual(["[slettet]", "[slettet]"]);
    expect(b.rows[1]).toMatchObject({ input_tokens: 100, model: "claude-haiku-5-5" });
    expect(Number(b.rows[1].pris_usd)).toBeCloseTo(0.0001);
    const sm = await db.query<{ email: string | null; bruger_id: string }>(`select email, bruger_id from public.bot_samtaler where id = $1`, [s]);
    expect(sm.rows[0]).toEqual({ email: null, bruger_id: C });
    const h = await db.query<{ besked: string }>(`select besked from public.kontakt_henvendelser where bot_samtale_id = $1`, [s]);
    expect(h.rows[0].besked).toContain("slettet sin konto");
    expect(h.rows[0].besked).not.toContain("Testvej");
    const a = await db.query<{ tekst: string }>(`select tekst from public.bot_beskeder where samtale_id = $1`, [andens]);
    expect(a.rows[0].tekst).toBe("Bs egen besked");
  });

  it("bot_rens: 90 dage, 2 år efter overdragelse og ip_hash efter 7 dage - forbruget bevares", async () => {
    const gl = (await ny(null, null, IP5, "Gammel besked")).samtale_id as string;
    await rpc("public.bot_gem_svar($1, 'Gammelt svar', 'claude-haiku-5-5', 7, 3, 0, 0, 0.0002, '{}', 'end_turn', 1)", [gl]);
    const ny89 = (await ny(null, A, IP5, "Næsten gammel")).samtale_id as string;
    const ov = (await ny(null, B, IP5, "Overdraget for længe siden")).samtale_id as string;
    expect((await rpc("public.bot_overdrag($1, $2, null, 'Bruger:\n> Overdraget for længe siden')", [ov, B])).kode).toBe("ok");
    const ovNy = (await ny(null, B, IP5, "Overdraget for nylig")).samtale_id as string;
    expect((await rpc("public.bot_overdrag($1, $2, null, 'Bruger:\n> Overdraget for nylig')", [ovNy, B])).kode).toBe("ok");
    await db.exec(`
      update public.bot_samtaler set opdateret_kl = now() - interval '91 days', oprettet_kl = now() - interval '91 days' where id = '${gl}';
      update public.bot_beskeder set oprettet_kl = now() - interval '91 days' where samtale_id = '${gl}';
      update public.bot_samtaler set opdateret_kl = now() - interval '89 days' where id = '${ny89}';
      update public.bot_beskeder set oprettet_kl = now() - interval '89 days' where samtale_id = '${ny89}';
      update public.bot_samtaler set opdateret_kl = now() - interval '800 days', overdraget_kl = now() - interval '731 days' where id = '${ov}';
      update public.bot_samtaler set opdateret_kl = now() - interval '400 days', overdraget_kl = now() - interval '400 days' where id = '${ovNy}';`);

    const r1 = await rpc("public.bot_rens()");
    expect(Number(r1.samtaler_90_dage)).toBeGreaterThanOrEqual(1);
    expect(Number(r1.samtaler_2_aar)).toBe(1);

    const s = await db.query<{ id: string; email: string | null; bruger_id: string | null; ip_hash: string | null; renset: boolean }>(
      `select id, email, bruger_id, ip_hash, renset_kl is not null as renset from public.bot_samtaler where id = any($1)`,
      [[gl, ny89, ov, ovNy]]);
    const pr = new Map(s.rows.map((x) => [x.id, x]));
    expect(pr.get(gl)).toMatchObject({ email: null, bruger_id: null, ip_hash: null, renset: true });
    expect(pr.get(ov)).toMatchObject({ email: null, bruger_id: null, ip_hash: null, renset: true });
    // 89 dage: tekst og bruger bevares, men ip_hash er nulstillet (over 7 dage).
    expect(pr.get(ny89)).toMatchObject({ bruger_id: A, ip_hash: null, renset: false });
    expect(pr.get(ovNy)).toMatchObject({ bruger_id: B, ip_hash: null, renset: false });

    const t = await db.query<{ samtale_id: string; tekst: string; bruger_id: string | null; ip_hash: string | null; input_tokens: number }>(
      `select samtale_id, tekst, bruger_id, ip_hash, input_tokens from public.bot_beskeder where samtale_id = any($1) order by oprettet_kl`,
      [[gl, ny89, ov, ovNy]]);
    for (const x of t.rows.filter((r) => r.samtale_id === gl || r.samtale_id === ov)) {
      expect(x).toMatchObject({ tekst: "[slettet]", bruger_id: null, ip_hash: null });
    }
    expect(t.rows.find((r) => r.samtale_id === gl && r.input_tokens === 7)).toBeTruthy();
    expect(t.rows.find((r) => r.samtale_id === ny89)?.tekst).toBe("Næsten gammel");
    expect(t.rows.find((r) => r.samtale_id === ny89)?.ip_hash).toBeNull();
    expect(t.rows.find((r) => r.samtale_id === ovNy)?.tekst).toBe("Overdraget for nylig");

    const h = await db.query<{ bot_samtale_id: string; besked: string }>(
      `select bot_samtale_id, besked from public.kontakt_henvendelser where bot_samtale_id = any($1)`, [[ov, ovNy]]);
    expect(h.rows.find((x) => x.bot_samtale_id === ov)?.besked).toContain("slettet 2 år efter");
    expect(h.rows.find((x) => x.bot_samtale_id === ovNy)?.besked).toContain("Overdraget for nylig");

    // En renset samtale kan hverken fortsættes eller overdrages.
    expect((await ny(gl, null, IP5)).kode).toBe("ukendt_samtale");
    // Idempotent: anden kørsel gør intet nyt.
    const r2 = await rpc("public.bot_rens()");
    expect(r2).toMatchObject({ samtaler_90_dage: 0, samtaler_2_aar: 0, beskeder: 0, henvendelser: 0 });
  });

  it("mine_data: egne bot-samtaler uden tokens og pris - og de andre udvidelser bevares", async () => {
    const s = (await ny(null, A, IP4, "Hvad koster fragt?")).samtale_id as string;
    await rpc("public.bot_gem_svar($1, 'Fragt koster ...', 'claude-haiku-5-5', 100, 50, 0, 0, 0.0001, '{}', 'end_turn', 1)", [s]);
    await db.exec(`set request.jwt.claim.sub = '${A}'`);
    const md = await rpc("public.mine_data()");
    await db.exec(`reset request.jwt.claim.sub`);
    expect(Object.keys(md)).toEqual(expect.arrayContaining(["profil", "erhverv_klager", "henvisninger", "mitid", "bidhamr_bot"]));
    const samtaler = md.bidhamr_bot as { kilde: string; oprettet_kl: string; overdraget_kl: string | null; beskeder: { rolle: string; tekst: string }[] }[];
    const denne = samtaler.find((x) => x.beskeder.some((b) => b.tekst === "Hvad koster fragt?"))!;
    expect(denne).toMatchObject({ kilde: "web", overdraget_kl: null });
    expect(denne.beskeder.map((b) => b.rolle)).toEqual(["bruger", "bot"]);
    const json = JSON.stringify(md.bidhamr_bot);
    for (const forbudt of ["tokens", "pris", "model", "ip_hash", "email", "bruger_id"]) expect(json).not.toContain(forbudt);
    // Kun egne samtaler (ikke B's).
    expect(json).not.toContain("Bs egen besked");
    // Uden login: ingen samtaler.
    expect((await rpc("public.mine_data()")).bidhamr_bot).toEqual([]);
  });
});
