// Migrationen 20261023020000_badge_konkurrence.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubber de tabeller, den bygger
// på, kører den TO gange og tjekker:
// - "Populær sælger": 50 gennemførte salg giver badge, 49 gør ikke;
//   annullerede, refunderede og ikke-frigivne salg tæller ikke
// - konkurrencen: én lod pr. gennemført salg i den måned (dansk tid), hvor
//   pengene blev frigivet; firmaer, staff, pause, frosne konti, åbne sager og
//   anker er ikke med
// - lodtrækningen: kun chef, kun afsluttede måneder, listen fastfryses,
//   hash og vinderlod kan efterregnes (src/lib/konkurrence/regler.ts), ny
//   vinder kræver begrundelse og udelukker den gamle, intet kan ændres
// - trækningen er vægtet efter antal lod
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { konkurrenceCsv, listeHash, lodNr, nytSeed, vinderAf } from "@/lib/konkurrence/regler";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261023020000_badge_konkurrence.sql"),
  "utf8",
);

const CHEF = "00000000-0000-4000-8000-0000000000c0";
const ADMIN = "00000000-0000-4000-8000-0000000000c1";
const SYSTEM = "00000000-0000-4000-8000-0000000b1d00";

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create function public.bidhamr_system_id() returns uuid language sql immutable as
  $$ select '${SYSTEM}'::uuid $$;
create table public.users (
  id uuid primary key, navn text, email text, rolle text not null default 'bruger',
  konto_type text default 'privat', suspenderet boolean not null default false, suspenderet_til timestamptz,
  konto_lukket_kl timestamptz, konto_slettet_kl timestamptz);
insert into public.users (id, navn, email, rolle) values
  ('${CHEF}', 'Chefen', 'chef@test.bidhamr.dk', 'chef'),
  ('${ADMIN}', 'Admin', 'admin@test.bidhamr.dk', 'admin'),
  ('${SYSTEM}', 'BidHamr', null, 'bruger');
create table public.trades (id uuid primary key default gen_random_uuid(), seller_id uuid,
  status text not null default 'afsluttet', sag_aaben boolean not null default false);
create table public.betalinger (
  id uuid primary key default gen_random_uuid(), trade_id uuid references public.trades(id), seller_id uuid,
  status text not null default 'betalt', betalt_kl timestamptz, frigivet_kl timestamptz,
  annulleret_kl timestamptz, refusion_anmodet_kl timestamptz, refunderet_kl timestamptz, refusion_oere bigint,
  bidhamr_daekker_kl timestamptz, indsigelse_kl timestamptz, indsigelse_status text, indsigelse_tabt_kl timestamptz);
create table public.sager (id uuid primary key default gen_random_uuid(), trade_id uuid, status text,
  penge_flyttes_efter_kl timestamptz, afviklet_kl timestamptz);
create table public.sag_anker (id uuid primary key default gen_random_uuid(), trade_id uuid, status text);
create table public.betalingsprofiler (user_id uuid primary key, saelger_frosset_kl timestamptz,
  udbetaling_frosset_kl timestamptz, salg_frosset_kl timestamptz);
`;

let db: PGlite;
let nr = 0;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}

function nyId(): string {
  nr += 1;
  return `00000000-0000-4000-8000-${nr.toString(16).padStart(12, "0")}`;
}

async function bruger(o: { navn?: string; konto_type?: string; rolle?: string } = {}): Promise<string> {
  const id = nyId();
  await db.query(`insert into public.users (id, navn, email, konto_type, rolle) values ($1, $2, $3, $4, $5)`, [
    id,
    o.navn ?? `Sælger ${nr}`,
    `s${nr}@test.bidhamr.dk`,
    o.konto_type ?? "privat",
    o.rolle ?? "bruger",
  ]);
  return id;
}

type SalgValg = {
  frigivet?: string | null;
  betaling?: Record<string, unknown>;
  tradeStatus?: string;
  sagAaben?: boolean;
};

// Et salg: handel + betaling, som standard betalt og frigivet 15. sep. 2026.
async function salg(saelger: string, o: SalgValg = {}): Promise<string> {
  const t = await en<{ id: string }>(
    `insert into public.trades (seller_id, status, sag_aaben) values ($1, $2, $3) returning id`,
    [saelger, o.tradeStatus ?? "afsluttet", o.sagAaben ?? false],
  );
  const felter: Record<string, unknown> = {
    trade_id: t.id,
    seller_id: saelger,
    betalt_kl: "2026-09-10T10:00:00Z",
    frigivet_kl: o.frigivet === undefined ? "2026-09-15T10:00:00Z" : o.frigivet,
    ...o.betaling,
  };
  const k = Object.keys(felter);
  await db.query(
    `insert into public.betalinger (${k.join(", ")}) values (${k.map((_, i) => `$${i + 1}`).join(", ")})`,
    k.map((x) => felter[x]),
  );
  return t.id;
}

async function flereSalg(saelger: string, antal: number, o: SalgValg = {}) {
  for (let i = 0; i < antal; i++) await salg(saelger, o);
}

const badge = async (id: string) => (await en<{ v: boolean }>(`select public.populaer_saelger($1) as v`, [id])).v;

async function lod(maaned: string, bruger?: string): Promise<Map<string, { antal: number; grund: string | null }>> {
  const { rows } = await db.query<{ bruger_id: string; antal_lod: number; grund: string | null }>(
    `select l.* from public.konkurrence_maaned_interval($1) i, public.konkurrence_lod_beregn(i.fra, i.til, $2) l`,
    [maaned, bruger ?? null],
  );
  return new Map(rows.map((r) => [r.bruger_id, { antal: r.antal_lod, grund: r.grund }]));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("rettigheder: badge offentligt, egne lod kun authenticated, resten kun service role", async () => {
    const r = await en<Record<string, boolean>>(`
      select has_function_privilege('anon', 'public.populaer_saelger(uuid)', 'execute') as anon_badge,
             has_function_privilege('anon', 'public.populaere_saelgere(uuid[])', 'execute') as anon_badges,
             has_function_privilege('anon', 'public.mine_konkurrence_lod()', 'execute') as anon_mine,
             has_function_privilege('authenticated', 'public.mine_konkurrence_lod()', 'execute') as auth_mine,
             has_function_privilege('authenticated', 'public.gennemfoerte_salg(timestamptz,timestamptz,uuid)', 'execute') as auth_salg,
             has_function_privilege('authenticated', 'public.konkurrence_lod_beregn(timestamptz,timestamptz,uuid)', 'execute') as auth_beregn,
             has_function_privilege('authenticated', 'public.konkurrence_admin_oversigt(uuid,text)', 'execute') as auth_oversigt,
             has_function_privilege('authenticated', 'public.konkurrence_traek(uuid,text,text)', 'execute') as auth_traek,
             has_function_privilege('service_role', 'public.konkurrence_traek(uuid,text,text)', 'execute') as sr_traek,
             has_function_privilege('service_role', 'public.konkurrence_gem_traekning(uuid,text,integer,uuid,text,text,uuid)', 'execute') as sr_gem,
             has_table_privilege('authenticated', 'public.konkurrence_traekninger', 'select') as auth_sel,
             has_table_privilege('anon', 'public.konkurrence_traekning_lod', 'select') as anon_lod,
             has_table_privilege('service_role', 'public.konkurrence_traekninger', 'select') as sr_sel,
             has_table_privilege('service_role', 'public.konkurrence_traekninger', 'insert') as sr_ins,
             has_table_privilege('service_role', 'public.konkurrence_traekning_lod', 'delete') as sr_del`);
    expect(r).toEqual({
      anon_badge: true,
      anon_badges: true,
      anon_mine: false,
      auth_mine: true,
      auth_salg: false,
      auth_beregn: false,
      auth_oversigt: false,
      auth_traek: false,
      sr_traek: true,
      sr_gem: false,
      auth_sel: false,
      anon_lod: false,
      sr_sel: true,
      sr_ins: false,
      sr_del: false,
    });
  });

  it("alle security definer-funktioner har search_path = ''", async () => {
    const { rows } = await db.query<{ proname: string; cfg: string[] | null }>(`
      select p.proname, p.proconfig as cfg from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef`);
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) expect(r.cfg, r.proname).toContain('search_path=""');
  });
});

describe("Populær sælger", () => {
  it("50 gennemførte salg giver badge, 49 giver ikke", async () => {
    const a = await bruger();
    const b = await bruger();
    await flereSalg(a, 50);
    await flereSalg(b, 49);
    expect(await badge(a)).toBe(true);
    expect(await badge(b)).toBe(false);
    const { rows } = await db.query<{ v: string }>(`select v from public.populaere_saelgere($1::uuid[]) v`, [[a, b, null]]);
    expect(rows.map((r) => r.v)).toEqual([a]);
  });

  it("annullerede, refunderede, ikke-frigivne og tabte indsigelser tæller ikke", async () => {
    const tilfaelde: SalgValg[] = [
      { frigivet: null },
      { tradeStatus: "annulleret" },
      { betaling: { status: "refunderet", refunderet_kl: "2026-09-20T10:00:00Z" } },
      { betaling: { refusion_anmodet_kl: "2026-09-20T10:00:00Z" } },
      { betaling: { refusion_oere: 1000 } },
      { betaling: { annulleret_kl: "2026-09-20T10:00:00Z" } },
      { betaling: { bidhamr_daekker_kl: "2026-09-20T10:00:00Z" } },
      { betaling: { indsigelse_kl: "2026-09-20T10:00:00Z", indsigelse_status: "needs_response" } },
      { betaling: { indsigelse_kl: "2026-09-20T10:00:00Z", indsigelse_status: "lost", indsigelse_tabt_kl: "2026-09-25T10:00:00Z" } },
      { betaling: { status: "afventer" } },
    ];
    for (const t of tilfaelde) {
      const s = await bruger();
      await flereSalg(s, 49);
      await salg(s, t);
      expect(await badge(s), JSON.stringify(t)).toBe(false);
      // Det 50. rigtige salg giver badget.
      await salg(s);
      expect(await badge(s), JSON.stringify(t)).toBe(true);
    }
  });

  it("en vundet indsigelse tæller som gennemført", async () => {
    const s = await bruger();
    await flereSalg(s, 49);
    await salg(s, { betaling: { indsigelse_kl: "2026-09-20T10:00:00Z", indsigelse_status: "won" } });
    expect(await badge(s)).toBe(true);
  });

  it("lukkede og slettede konti og systemkontoen får ikke badget", async () => {
    const s = await bruger();
    await flereSalg(s, 50);
    await db.query(`update public.users set konto_slettet_kl = now() where id = $1`, [s]);
    expect(await badge(s)).toBe(false);
    await flereSalg(SYSTEM, 50);
    expect(await badge(SYSTEM)).toBe(false);
    expect(await badge(null as unknown as string)).toBe(false);
  });
});

describe("lod i konkurrencen", () => {
  it("én lod pr. gennemført salg, i den måned pengene frigives (dansk tid)", async () => {
    const s = await bruger();
    // Betalt i september, frigivet i oktober: tæller i oktober.
    await salg(s, { frigivet: "2026-10-02T10:00:00Z" });
    // 31. okt. kl. 23.30 UTC = 1. nov. kl. 00.30 dansk tid: november.
    await salg(s, { frigivet: "2026-10-31T23:30:00Z" });
    // 31. aug. kl. 22.30 UTC = 1. sep. kl. 00.30 dansk tid (sommertid): september.
    await salg(s, { frigivet: "2026-08-31T22:30:00Z" });
    // 30. sep. kl. 21.59 UTC = 23.59 dansk tid: september.
    await salg(s, { frigivet: "2026-09-30T21:59:00Z" });
    expect((await lod("2026-09", s)).get(s)).toEqual({ antal: 2, grund: null });
    expect((await lod("2026-10", s)).get(s)).toEqual({ antal: 1, grund: null });
    expect((await lod("2026-11", s)).get(s)).toEqual({ antal: 1, grund: null });
    expect((await lod("2026-08", s)).get(s)).toBeUndefined();
  });

  it("refunderede, annullerede og ikke-frigivne salg giver ikke lod", async () => {
    const s = await bruger();
    await salg(s);
    await salg(s, { frigivet: null });
    await salg(s, { tradeStatus: "annulleret" });
    await salg(s, { betaling: { refunderet_kl: "2026-09-20T10:00:00Z", status: "refunderet" } });
    await salg(s, { betaling: { refusion_oere: 500 } });
    expect((await lod("2026-09", s)).get(s)?.antal).toBe(1);
  });

  it("åben sag, anke, sag-markering, medhold til køber og løbende ankefrist giver ikke lod", async () => {
    const s = await bruger();
    await salg(s); // tæller
    const sagLukket = await salg(s); // sag afgjort til sælger og afviklet: tæller
    await db.query(
      `insert into public.sager (trade_id, status, penge_flyttes_efter_kl, afviklet_kl) values ($1, 'afgjort_saelger', now() - interval '5 days', now() - interval '1 day')`,
      [sagLukket],
    );
    for (const status of ["aaben", "afventer_retur", "afgjort_koeber"]) {
      const t = await salg(s);
      await db.query(`insert into public.sager (trade_id, status) values ($1, $2)`, [t, status]);
    }
    const ankefrist = await salg(s);
    await db.query(
      `insert into public.sager (trade_id, status, penge_flyttes_efter_kl) values ($1, 'afgjort_saelger', now() + interval '2 days')`,
      [ankefrist],
    );
    const anke = await salg(s);
    await db.query(`insert into public.sager (trade_id, status, afviklet_kl) values ($1, 'afgjort_saelger', now())`, [anke]);
    await db.query(`insert into public.sag_anker (trade_id, status) values ($1, 'afventer')`, [anke]);
    const ankeAfgjort = await salg(s); // anken er afgjort: tæller
    await db.query(`insert into public.sag_anker (trade_id, status) values ($1, 'stadfaestet')`, [ankeAfgjort]);
    await salg(s, { sagAaben: true });
    expect((await lod("2026-09", s)).get(s)?.antal).toBe(3);
  });

  it("firmaer, staff, pause, frosne og lukkede konti deltager ikke", async () => {
    const firma = await bruger({ konto_type: "erhverv" });
    const staff = await bruger({ rolle: "medarbejder" });
    const erhvervSaelger = await bruger({ rolle: "saelger" });
    const pause = await bruger();
    const pauseUdloebet = await bruger();
    const frosne = [await bruger(), await bruger(), await bruger()];
    const lukket = await bruger();
    const ok = await bruger();
    for (const s of [firma, staff, erhvervSaelger, pause, pauseUdloebet, ...frosne, lukket, ok]) await flereSalg(s, 2);
    await db.query(`update public.users set suspenderet = true, suspenderet_til = now() + interval '3 days' where id = $1`, [pause]);
    await db.query(`update public.users set suspenderet = true, suspenderet_til = now() - interval '1 day' where id = $1`, [pauseUdloebet]);
    await db.query(`update public.users set konto_lukket_kl = now() where id = $1`, [lukket]);
    await db.query(`insert into public.betalingsprofiler (user_id, saelger_frosset_kl) values ($1, now())`, [frosne[0]]);
    await db.query(`insert into public.betalingsprofiler (user_id, udbetaling_frosset_kl) values ($1, now())`, [frosne[1]]);
    await db.query(`insert into public.betalingsprofiler (user_id, salg_frosset_kl) values ($1, now())`, [frosne[2]]);
    const l = await lod("2026-09");
    expect(l.get(firma)?.grund).toBe("erhverv");
    expect(l.get(staff)?.grund).toBe("staff");
    expect(l.get(erhvervSaelger)?.grund).toBe("staff");
    expect(l.get(pause)?.grund).toBe("pause");
    expect(l.get(pauseUdloebet)?.grund).toBeNull();
    for (const f of frosne) expect(l.get(f)?.grund).toBe("frosset");
    expect(l.get(lukket)?.grund).toBe("lukket");
    expect(l.get(ok)).toEqual({ antal: 2, grund: null });
  });

  it("mine_konkurrence_lod: kun egne lod i den aktuelle måned", async () => {
    const s = await bruger();
    const anden = await bruger();
    const firma = await bruger({ konto_type: "erhverv" });
    await flereSalg(s, 3, { frigivet: new Date().toISOString() });
    await flereSalg(anden, 5, { frigivet: new Date().toISOString() });
    await flereSalg(firma, 2, { frigivet: new Date().toISOString() });
    await salg(s); // september - ikke denne måned
    const mine = async (uid: string) => {
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
      try {
        await db.query(`set role authenticated`);
        return await j(`select public.mine_konkurrence_lod() as v`);
      } finally {
        await db.query(`reset role`);
        await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
      }
    };
    const denne = (await en<{ m: string }>(`select public.konkurrence_denne_maaned() as m`)).m;
    expect(await mine(s)).toEqual({ maaned: denne, antal_lod: 3, deltager: true, grund: null });
    expect(await mine(firma)).toEqual({ maaned: denne, antal_lod: 0, deltager: false, grund: "erhverv" });
    // authenticated kan ikke læse andres eller hele listen.
    await db.query(`set role authenticated`);
    try {
      await expect(db.query(`select * from public.konkurrence_lod_beregn(null, null)`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from public.konkurrence_traekninger`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query(`reset role`);
    }
  });
});

describe("lodtrækningen", () => {
  // Egen måned med en kendt liste: A 1 lod, B 3 lod, C 6 lod, + en firma og en på pause.
  const MAANED = "2026-06";
  const FRIGIVET = "2026-06-15T10:00:00Z";
  let A: string, B: string, C: string;

  beforeAll(async () => {
    A = await bruger({ navn: "Anna" });
    B = await bruger({ navn: "Bo" });
    C = await bruger({ navn: "Carl" });
    const firma = await bruger({ konto_type: "erhverv" });
    const pause = await bruger();
    await flereSalg(A, 1, { frigivet: FRIGIVET });
    await flereSalg(B, 3, { frigivet: FRIGIVET });
    await flereSalg(C, 6, { frigivet: FRIGIVET });
    await flereSalg(firma, 4, { frigivet: FRIGIVET });
    await flereSalg(pause, 4, { frigivet: FRIGIVET });
    await db.query(`update public.users set suspenderet = true where id = $1`, [pause]);
  });

  const traek = (chef: string, maaned: string, seed: string) =>
    j(`select public.konkurrence_traek($1, $2, $3) as v`, [chef, maaned, seed]);
  const igen = (chef: string, id: string, begrundelse: string, seed: string) =>
    j(`select public.konkurrence_traek_igen($1, $2, $3, $4) as v`, [chef, id, begrundelse, seed]);

  it("kun chef, kun gyldigt seed og kun afsluttede måneder", async () => {
    expect(await traek(ADMIN, MAANED, nytSeed())).toEqual({ kode: "ingen_adgang" });
    expect(await traek(CHEF, MAANED, "abc")).toEqual({ kode: "ugyldigt_seed" });
    expect(await traek(CHEF, "2026-13", nytSeed())).toEqual({ kode: "ugyldig_maaned" });
    const denne = (await en<{ m: string }>(`select public.konkurrence_denne_maaned() as m`)).m;
    expect(await traek(CHEF, denne, nytSeed())).toEqual({ kode: "maaned_ikke_slut" });
    expect(await traek(CHEF, "2025-01", nytSeed())).toEqual({ kode: "ingen_deltagere" });
    const o = await j(`select public.konkurrence_admin_oversigt($1, $2) as v`, [ADMIN, MAANED]);
    expect(o).toEqual({ kode: "ingen_adgang" });
  });

  it("oversigten viser deltagere med lod og udelukkede med grund", async () => {
    const o = await j(`select public.konkurrence_admin_oversigt($1, $2) as v`, [CHEF, MAANED]);
    expect(o.kode).toBe("ok");
    expect(o.maaned_slut).toBe(true);
    expect(o.deltagere).toEqual([
      { bruger_id: C, navn: "Carl", antal_lod: 6 },
      { bruger_id: B, navn: "Bo", antal_lod: 3 },
      { bruger_id: A, navn: "Anna", antal_lod: 1 },
    ]);
    const grunde = (o.udelukkede as { grund: string }[]).map((u) => u.grund).sort();
    expect(grunde).toEqual(["erhverv", "pause"]);
    expect(o.traekninger).toEqual([]);
  });

  it("trækker, fastfryser listen og kan efterregnes; dobbeltklik giver samme trækning", async () => {
    const seed = nytSeed();
    const r = await traek(CHEF, MAANED, seed);
    expect(r.kode).toBe("ok");
    expect(r.antal_lod).toBe(10);
    expect(r.antal_deltagere).toBe(3);
    const liste = [
      { bruger_id: A, antal_lod: 1 },
      { bruger_id: B, antal_lod: 3 },
      { bruger_id: C, antal_lod: 6 },
    ];
    expect(r.liste_hash).toBe(listeHash(MAANED, liste));
    expect(r.vinder_lod).toBe(lodNr(seed, r.liste_hash as string, 10));
    expect(r.vinder_id).toBe(vinderAf(liste, r.vinder_lod as number));

    // Fastfrosset: et nyt salg ændrer ikke listen.
    await salg(A, { frigivet: FRIGIVET });
    const { rows } = await db.query<{ bruger_id: string; antal_lod: number; foerste_lod: number; sidste_lod: number; fastfrosset: boolean }>(
      `select * from public.konkurrence_admin_liste($1, $2)`,
      [CHEF, MAANED],
    );
    expect(rows.map((x) => [x.bruger_id, x.antal_lod, x.fastfrosset])).toEqual(
      [...liste].sort((a, b) => (a.bruger_id < b.bruger_id ? -1 : 1)).map((x) => [x.bruger_id, x.antal_lod, true]),
    );
    expect(rows[0].foerste_lod).toBe(1);
    expect(rows[rows.length - 1].sidste_lod).toBe(10);

    const igenR = await traek(CHEF, MAANED, nytSeed());
    expect(igenR).toEqual({ kode: "findes", traekning_id: r.traekning_id });
    const n = await en<{ n: number }>(`select count(*)::int as n from public.konkurrence_traekninger where maaned = $1`, [MAANED]);
    expect(n.n).toBe(1);

    // CSV: kun de nødvendige felter.
    const csv = konkurrenceCsv(MAANED, rows.map((x) => ({ ...x, navn: "=Navn" })), true);
    expect(csv.split("\r\n")[0]).toBe("﻿Måned;Bruger-id;Navn;Antal lod;Første lod;Sidste lod");
    expect(csv).toContain(";'=Navn;");
  });

  it("ny vinder: kræver begrundelse, udelukker den gamle vinder og logges", async () => {
    const o = await j(`select public.konkurrence_admin_oversigt($1, $2) as v`, [CHEF, MAANED]);
    const foerste = (o.traekninger as { id: string; vinder_id: string }[])[0];
    expect(await igen(CHEF, foerste.id, "kort", nytSeed())).toEqual({ kode: "begrundelse_mangler" });
    expect(await igen(ADMIN, foerste.id, "Vinderen svarede ikke inden 14 dage", nytSeed())).toEqual({ kode: "ingen_adgang" });

    const seed = nytSeed();
    const r = await igen(CHEF, foerste.id, "Vinderen svarede ikke inden 14 dage", seed);
    expect(r.kode).toBe("ok");
    expect(r.nr).toBe(2);
    expect(r.vinder_id).not.toBe(foerste.vinder_id);
    const rest = [
      { bruger_id: A, antal_lod: 1 },
      { bruger_id: B, antal_lod: 3 },
      { bruger_id: C, antal_lod: 6 },
    ].filter((x) => x.bruger_id !== foerste.vinder_id);
    const lodIalt = rest.reduce((s, x) => s + x.antal_lod, 0);
    expect(r.antal_lod).toBe(lodIalt);
    expect(r.liste_hash).toBe(listeHash(MAANED, rest));
    expect(r.vinder_lod).toBe(lodNr(seed, r.liste_hash as string, lodIalt));
    expect(r.vinder_id).toBe(vinderAf(rest, r.vinder_lod as number));

    // Dobbeltklik på den gamle: ingen ny vinder.
    const dobbelt = await igen(CHEF, foerste.id, "Vinderen svarede ikke inden 14 dage", nytSeed());
    expect(dobbelt).toEqual({ kode: "allerede_erstattet", traekning_id: r.traekning_id });

    const o2 = await j(`select public.konkurrence_admin_oversigt($1, $2) as v`, [CHEF, MAANED]);
    const t = o2.traekninger as Record<string, unknown>[];
    expect(t.map((x) => x.nr)).toEqual([2, 1]);
    expect(t[0]).toMatchObject({ begrundelse: "Vinderen svarede ikke inden 14 dage", erstatter_id: foerste.id, erstattet_kl: null, trukket_af_navn: "Chefen" });
    expect(t[1].erstattet_kl).not.toBeNull();
    expect(t[1].erstattet_af_navn).toBe("Chefen");
    expect(o2.gaeldende_id).toBe(r.traekning_id);

    // Til sidst er der ingen flere at trække.
    let gaeldende = r.traekning_id as string;
    for (let i = 0; i < 5; i++) {
      const x = await igen(CHEF, gaeldende, "Vinderen svarede heller ikke", nytSeed());
      if (x.kode === "ingen_flere") break;
      expect(x.kode).toBe("ok");
      gaeldende = x.traekning_id as string;
    }
    expect(await igen(CHEF, gaeldende, "Vinderen svarede heller ikke", nytSeed())).toEqual({ kode: "ingen_flere" });
    // "ingen_flere" erstatter ikke den gældende.
    const g = await en<{ id: string }>(`select id from public.konkurrence_traekninger where maaned = $1 and erstattet_kl is null`, [MAANED]);
    expect(g.id).toBe(gaeldende);
  });

  it("trækninger og lister kan ikke ændres eller slettes", async () => {
    await expect(db.query(`update public.konkurrence_traekninger set vinder_lod = 1 where maaned = $1`, [MAANED])).rejects.toThrow(/kan ikke ændres/);
    await expect(db.query(`delete from public.konkurrence_traekninger where maaned = $1`, [MAANED])).rejects.toThrow(/kan ikke slettes/);
    await expect(db.query(`update public.konkurrence_traekning_lod set antal_lod = 99`)).rejects.toThrow(/kan ikke ændres/);
    await expect(db.query(`delete from public.konkurrence_traekning_lod`)).rejects.toThrow(/kan ikke ændres/);
  });
});

describe("vægtning", () => {
  it("databasen og koden giver samme vinderlod", async () => {
    for (let i = 0; i < 50; i++) {
      const seed = nytSeed();
      const hash = nytSeed();
      const n = 1 + (i * 7919) % 1000;
      const r = await en<{ v: number }>(`select public.konkurrence_lod_nr($1, $2, $3) as v`, [seed, hash, n]);
      expect(r.v).toBe(lodNr(seed, hash, n));
    }
  });

  it("chancen er proportional med antal lod (A 1, B 3, C 6)", async () => {
    const liste = [
      { bruger_id: "00000000-0000-4000-8000-00000000aaaa", antal_lod: 1 },
      { bruger_id: "00000000-0000-4000-8000-00000000bbbb", antal_lod: 3 },
      { bruger_id: "00000000-0000-4000-8000-00000000cccc", antal_lod: 6 },
    ];
    const hash = listeHash("2026-01", liste);
    const ANTAL = 20_000;
    const vundet = new Map<string, number>();
    for (let i = 0; i < ANTAL; i++) {
      const v = vinderAf(liste, lodNr(nytSeed(), hash, 10))!;
      vundet.set(v, (vundet.get(v) ?? 0) + 1);
    }
    // Forventet 10 %, 30 %, 60 % (± 1,5 procentpoint - over 6 standardafvigelser).
    expect(vundet.get(liste[0].bruger_id)! / ANTAL).toBeCloseTo(0.1, 1);
    expect(Math.abs(vundet.get(liste[0].bruger_id)! / ANTAL - 0.1)).toBeLessThan(0.015);
    expect(Math.abs(vundet.get(liste[1].bruger_id)! / ANTAL - 0.3)).toBeLessThan(0.015);
    expect(Math.abs(vundet.get(liste[2].bruger_id)! / ANTAL - 0.6)).toBeLessThan(0.015);

    // Samme i databasen med deterministiske seeds (sha256 af løbenummeret).
    const { rows } = await db.query<{ lod: number; n: number }>(
      `select public.konkurrence_lod_nr(encode(sha256(convert_to(i::text, 'UTF8')), 'hex'), $1, 10) as lod, count(*)::int as n
         from generate_series(1, 5000) i group by 1 order by 1`,
      [hash],
    );
    expect(rows.map((r) => r.lod)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of rows) expect(Math.abs(r.n / 5000 - 0.1)).toBeLessThan(0.025);
  });

  it("seed er 32 tilfældige bytes i hex", () => {
    const a = nytSeed();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(nytSeed()).not.toBe(a);
  });
});
