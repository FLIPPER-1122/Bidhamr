// Migrationen 20261022010000_returfragt_betaling.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubs af de tabeller,
// migrationen bygger på; derefter køres migrationen TO gange, og reglerne
// testes: låst pris, én aktiv betaling pr. handel, ingen returkode før
// betaling (trigger), spejling fra Stripe, cron-beslutninger, refusion,
// fakturaer og RLS. Også afstemningens rene returfragt-regler.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  erKasseretReturfragtRefusion,
  erReturfragtRefusion,
  forventetReturfragtRefunderet,
  returfragtStatusAfviger,
} from "@/lib/betaling/afstemning";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261022010000_returfragt_betaling.sql"),
  "utf8",
);

const KOEBER = "00000000-0000-4000-8000-0000000000a1";
const SAELGER = "00000000-0000-4000-8000-0000000000b1";
const FREMMED = "00000000-0000-4000-8000-0000000000c1";
const STAFF = "00000000-0000-4000-8000-0000000000d1";
const MEDARBEJDER = "00000000-0000-4000-8000-0000000000d2";

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger');
insert into public.users values ('${KOEBER}', 'Køber', 'bruger'), ('${SAELGER}', 'Sælger', 'bruger'),
  ('${FREMMED}', 'Fremmed', 'bruger'), ('${STAFF}', 'Admin', 'admin'), ('${MEDARBEJDER}', 'Medarbejder', 'medarbejder');
create function public.staff_chat_har_rolle(p uuid, r text) returns boolean language sql as
  $$ select exists (select 1 from public.users u where u.id = p and
       case r when 'chef' then u.rolle = 'chef' when 'admin' then u.rolle in ('admin','chef') else u.rolle in ('medarbejder','admin','chef') end) $$;
-- Stub: inhabil = part i handlen.
create function public.penge_inhabil(p_m uuid, p_k uuid, p_s uuid) returns boolean language sql as
  $$ select p_m = p_k or p_m = p_s $$;
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  constraint moderation_log_handling_check check (handling = any (array['advarsel','sag_afgjort_koeber'])),
  constraint moderation_log_maal_type_check check (maal_type = any (array['bruger','sag'])));
create table public.auctions (id uuid primary key default gen_random_uuid(), titel text, pakkestoerrelse text,
  fragt_pakkeshop_oere bigint);
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid references public.auctions(id),
  buyer_id uuid, seller_id uuid, afhentning boolean default false, status text default 'modtaget');
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid, fragt_oere bigint,
  betalt_kl timestamptz);
create table public.sager (id uuid primary key default gen_random_uuid(), trade_id uuid, status text,
  retur_kraeves boolean default false, retur_afleveret_kl timestamptz, penge_flyttes_efter_kl timestamptz,
  oprettet_kl timestamptz default now());
create table public.sag_anker (id uuid primary key default gen_random_uuid(), sag_id uuid, status text,
  indgivet_kl timestamptz default now());
create table public.forsendelser (id uuid primary key default gen_random_uuid(), trade_id uuid, type text,
  fragtfirma text default 'test', status text default 'opretter', pakkestoerrelse text default 'lille',
  afsender jsonb, oprettet_kl timestamptz default now(), forsoegt_kl timestamptz default now(),
  ukendt_udfald_kl timestamptz, fejl text, kraever_opmaerksomhed boolean default false, opmaerksomhed_tekst text);
create table public.fragt_pakkestoerrelser (kode text primary key, pakkeshop_oere bigint);
insert into public.fragt_pakkestoerrelser values ('lille', 4000), ('mellem', 5000), ('stor', 6500);
create table public.fakturaer (
  id uuid primary key default gen_random_uuid(), dokument text not null, part text not null, bruger_id uuid not null,
  betaling_id uuid, trade_id uuid, krediterer_id uuid references public.fakturaer(id), linjer jsonb not null,
  beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null, stripe_reference text,
  status text not null default 'venter', manuel boolean not null default false, sidste_fejl text,
  slags text not null default 'salg', oprettet_kl timestamptz default now());
alter table public.fakturaer add constraint fakturaer_slags_check
  check (slags in ('salg', 'returfragt') and (slags = 'salg' or (dokument = 'faktura' and part = 'koeber')));
create unique index fakturaer_handel_part_slags on public.fakturaer (betaling_id, part, dokument, slags) where betaling_id is not null;
create function public.faktura_linje(p_kode text, p_tekst text, p_beloeb bigint) returns jsonb language sql immutable as
  $$ select case when p_beloeb is null or p_beloeb <= 0 then null
            else jsonb_build_object('kode', p_kode, 'tekst', p_tekst, 'beloeb_oere', p_beloeb) end $$;
create function public.faktura_moms(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint - round((l->>'beloeb_oere')::numeric * 4 / 5)::bigint), 0)::bigint
     from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
create function public.faktura_sum(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint), 0)::bigint from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  const r = await en<{ v: Record<string, unknown> }>(sql, p);
  return r.v;
}

// En handel i en sag, der afventer retur (ankefristen udløbet), med udgående
// label (sælgerens adresse) og betaling med 40 kr. fragt.
async function handel(o: { fragt?: number | null; ankefrist?: boolean; uden_adresse?: boolean } = {}) {
  const a = await en<{ id: string }>(
    `insert into public.auctions (titel, pakkestoerrelse, fragt_pakkeshop_oere) values ('Vare', 'lille', 4000) returning id`,
  );
  const t = await en<{ id: string }>(
    `insert into public.trades (auction_id, buyer_id, seller_id) values ($1, $2, $3) returning id`,
    [a.id, KOEBER, SAELGER],
  );
  const b = await en<{ id: string }>(
    `insert into public.betalinger (trade_id, fragt_oere, betalt_kl) values ($1, $2, now() - interval '10 days') returning id`,
    [t.id, o.fragt === undefined ? 4000 : o.fragt],
  );
  const s = await en<{ id: string }>(
    `insert into public.sager (trade_id, status, retur_kraeves, penge_flyttes_efter_kl)
     values ($1, 'afventer_retur', true, $2) returning id`,
    [t.id, o.ankefrist ? new Date(Date.now() + 86_400_000).toISOString() : new Date(Date.now() - 60_000).toISOString()],
  );
  if (!o.uden_adresse) {
    await db.query(
      `insert into public.forsendelser (trade_id, type, status, afsender) values ($1, 'udgaaende', 'leveret', '{"navn":"Sælger"}')`,
      [t.id],
    );
  }
  return { tradeId: t.id, betalingId: b.id, sagId: s.id };
}

const start = (trade: string, koeber = KOEBER) => j(`select public.returfragt_start($1, $2) as v`, [trade, koeber]);

async function betalt(trade: string, beloeb = 4000) {
  const s = await start(trade);
  const pi = `pi_test_${String(s.id).replace(/-/g, "")}`;
  await en(`select public.returfragt_gem_pi($1, $2, 0)`, [s.id, pi]);
  const r = await j(`select public.returfragt_registrer($1, 'succeeded', 'ch_x' || $1, $2, null) as v`, [pi, beloeb]);
  return { id: s.id as string, pi, r };
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
  it("kun service role har funktionerne; authenticated kun min_returfragt og select", async () => {
    const r = await en<Record<string, boolean>>(`
      select has_function_privilege('anon', 'public.returfragt_start(uuid,uuid)', 'execute') as anon_start,
             has_function_privilege('authenticated', 'public.returfragt_start(uuid,uuid)', 'execute') as auth_start,
             has_function_privilege('service_role', 'public.returfragt_start(uuid,uuid)', 'execute') as sr_start,
             has_function_privilege('authenticated', 'public.min_returfragt(uuid)', 'execute') as auth_min,
             has_function_privilege('anon', 'public.min_returfragt(uuid)', 'execute') as anon_min,
             has_table_privilege('authenticated', 'public.returfragt_betalinger', 'select') as auth_sel,
             has_column_privilege('authenticated', 'public.returfragt_betalinger', 'status', 'select') as auth_status,
             has_column_privilege('authenticated', 'public.returfragt_betalinger', 'label_intern_fejl', 'select') as auth_intern,
             has_table_privilege('authenticated', 'public.returfragt_betalinger', 'insert') as auth_ins,
             has_table_privilege('service_role', 'public.returfragt_betalinger', 'insert') as sr_ins,
             has_table_privilege('service_role', 'public.returfragt_betalinger', 'update') as sr_upd,
             has_table_privilege('anon', 'public.returfragt_betalinger', 'select') as anon_sel`);
    expect(r).toEqual({
      anon_start: false,
      auth_start: false,
      sr_start: true,
      auth_min: true,
      anon_min: false,
      auth_sel: false,
      auth_status: true,
      auth_intern: false,
      auth_ins: false,
      sr_ins: false,
      sr_upd: false,
      anon_sel: false,
    });
  });

  it("alle funktioner har search_path = '' og er security definer", async () => {
    const { rows } = await db.query<{ proname: string; sd: boolean; cfg: string[] | null }>(`
      select p.proname, p.prosecdef as sd, p.proconfig as cfg from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'returfragt%' or p.proname in ('min_returfragt', 'faktura_planlaeg_returfragt', 'forsendelser_returfragt_vagt'))
         and p.proname not in ('returfragt_forbyd_sletning', 'returfragt_laaste_felter')`);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const r of rows) {
      expect(r.sd, r.proname).toBe(true);
      expect(r.cfg, r.proname).toContain('search_path=""');
    }
  });
});

describe("start og pris", () => {
  it("låser prisen = fragten ud og giver samme række igen", async () => {
    const h = await handel();
    const s1 = await start(h.tradeId);
    expect(s1).toMatchObject({ kode: "ok", beloeb_oere: 4000, pi: null, pi_forsoeg: 0 });
    const s2 = await start(h.tradeId);
    expect(s2).toMatchObject({ kode: "findes", id: s1.id, beloeb_oere: 4000 });
    const n = await en<{ n: number }>(`select count(*)::int as n from public.returfragt_betalinger where trade_id = $1`, [h.tradeId]);
    expect(n.n).toBe(1);
    // Prisen kan ikke ændres bagefter.
    await expect(db.query(`update public.returfragt_betalinger set beloeb_oere = 1 where id = $1`, [s1.id])).rejects.toThrow(/kan ikke ændres/);
  });

  it("uden fragt på betalingen: auktionens pakkeshop-pris", async () => {
    const h = await handel({ fragt: 0 });
    expect(await start(h.tradeId)).toMatchObject({ kode: "ok", beloeb_oere: 4000 });
  });

  it("afviser fremmede, ankefrist, anke, manglende adresse og afhentning", async () => {
    const h = await handel();
    expect(await start(h.tradeId, FREMMED)).toEqual({ kode: "ikke_fundet" });
    const af = await handel({ ankefrist: true });
    expect((await start(af.tradeId)).kode).toBe("ankefrist");
    const an = await handel();
    await db.query(`insert into public.sag_anker (sag_id, status) values ($1, 'afventer')`, [an.sagId]);
    expect((await start(an.tradeId)).kode).toBe("anke");
    const ua = await handel({ uden_adresse: true });
    expect((await start(ua.tradeId)).kode).toBe("mangler_adresse");
    const ah = await handel();
    await db.query(`update public.trades set afhentning = true where id = $1`, [ah.tradeId]);
    expect((await start(ah.tradeId)).kode).toBe("ingen_retur");
    const ls = await handel();
    await db.query(`update public.sager set status = 'afgjort_saelger' where id = $1`, [ls.sagId]);
    expect((await start(ls.tradeId)).kode).toBe("ingen_retur");
  });

  it("én aktiv betaling pr. handel (unikt indeks)", async () => {
    const h = await handel();
    const s = await start(h.tradeId);
    await expect(
      db.query(
        `insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, beloeb_oere) values ($1, $2, $3, 4000)`,
        [h.tradeId, h.sagId, KOEBER],
      ),
    ).rejects.toThrow(/returfragt_en_aktiv/);
    expect(s.kode).toBe("ok");
  });
});

describe("ingen returkode før betaling", () => {
  it("triggeren afviser en returforsendelse uden betalt returfragt", async () => {
    const h = await handel();
    await start(h.tradeId);
    await expect(
      db.query(`insert into public.forsendelser (trade_id, type) values ($1, 'retur')`, [h.tradeId]),
    ).rejects.toThrow(/returfragt_ikke_betalt/);
  });

  it("efter betaling: forsendelsen tilknyttes, og labelen kan gemmes (label_klar_kl)", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    expect(b.r).toMatchObject({ kode: "betalt", id: b.id });
    const f = await en<{ id: string }>(`insert into public.forsendelser (trade_id, type) values ($1, 'retur') returning id`, [h.tradeId]);
    const rf1 = await en<{ forsendelse_id: string; label_forsoeg: number; label_klar_kl: string | null }>(
      `select forsendelse_id, label_forsoeg, label_klar_kl from public.returfragt_betalinger where id = $1`,
      [b.id],
    );
    expect(rf1).toMatchObject({ forsendelse_id: f.id, label_forsoeg: 1, label_klar_kl: null });
    // Et andet forsøg samtidig afvises.
    await expect(db.query(`insert into public.forsendelser (trade_id, type) values ($1, 'retur')`, [h.tradeId])).rejects.toThrow(
      /returfragt_label_findes/,
    );
    await db.query(`update public.forsendelser set status = 'oprettet' where id = $1`, [f.id]);
    const rf2 = await en<{ label_klar_kl: string | null }>(`select label_klar_kl from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(rf2.label_klar_kl).not.toBeNull();
    // Med en klar label kan der ikke refunderes automatisk.
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("label_findes");
  });

  it("en label kan ikke gemmes, hvis returfragten er refunderet imens", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const f = await en<{ id: string }>(
      `insert into public.forsendelser (trade_id, type, forsoegt_kl, ukendt_udfald_kl) values ($1, 'retur', now() - interval '20 minutes', now() - interval '15 minutes') returning id`,
      [h.tradeId],
    );
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("ok");
    // Claimet satte den hængende forsendelse til fejlet.
    expect((await en<{ status: string }>(`select status from public.forsendelser where id = $1`, [f.id])).status).toBe("fejlet");
    await expect(db.query(`update public.forsendelser set status = 'oprettet' where id = $1`, [f.id])).rejects.toThrow(/fejlet|ikke_betalt/);
  });

  it("refusion_claim venter, mens et label-forsøg kører", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    await db.query(`insert into public.forsendelser (trade_id, type) values ($1, 'retur')`, [h.tradeId]);
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("i_gang");
  });
});

describe("spejling fra Stripe", () => {
  it("idempotent: samme succeeded to gange", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const r2 = await j(`select public.returfragt_registrer($1, 'succeeded', 'ch_y', 4000, null) as v`, [b.pi]);
    expect(r2).toMatchObject({ kode: "allerede" });
    expect((await start(h.tradeId)).kode).toBe("betalt");
  });

  it("andet beløb: registreret og claimet til refusion", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId, 3999);
    expect(b.r.kode).toBe("beloeb_afviger");
    const rf = await en<{ status: string; refusion_aarsag: string }>(
      `select status, refusion_aarsag from public.returfragt_betalinger where id = $1`,
      [b.id],
    );
    expect(rf).toEqual({ status: "refunderes", refusion_aarsag: "beloeb" });
  });

  it("annulleret PaymentIntent kasseres; betales den alligevel, er den 'kasseret'", async () => {
    const h = await handel();
    const s = await start(h.tradeId);
    await en(`select public.returfragt_gem_pi($1, 'pi_gammel1', 0)`, [s.id]);
    expect((await j(`select public.returfragt_registrer('pi_gammel1', 'canceled', null, null, null) as v`)).kode).toBe("nulstillet");
    const s2 = await start(h.tradeId);
    expect(s2).toMatchObject({ kode: "findes", pi: null, pi_forsoeg: 1 });
    // gem_pi med det gamle forsøg afvises.
    expect((await en<{ v: boolean }>(`select public.returfragt_gem_pi($1, 'pi_x', 0) as v`, [s.id])).v).toBe(false);
    expect((await j(`select public.returfragt_registrer('pi_gammel1', 'succeeded', 'ch_g', 4000, null) as v`)).kode).toBe("kasseret");
    expect((await j(`select public.returfragt_registrer('pi_findes_ikke', 'succeeded', null, 4000, null) as v`)).kode).toBe("ukendt");
  });
});

describe("cron og refusion", () => {
  it("betalt uden kode: 'label'; efter 48 timer: 'refunder'; refusion idempotent", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    await db.query(`update public.returfragt_betalinger set betalt_kl = now() - interval '5 minutes' where id = $1`, [b.id]);
    let k = await db.query<{ id: string; handling: string }>(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b.id)?.handling).toBe("label");
    // Claimet: ikke igen med det samme.
    k = await db.query(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b.id)).toBeUndefined();

    await db.query(
      `update public.returfragt_betalinger set betalt_kl = now() - interval '49 hours', label_naeste_kl = null where id = $1`,
      [b.id],
    );
    k = await db.query(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b.id)?.handling).toBe("refunder");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("ok");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("forkert_status");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_resultat($1, true, 're_1', null) as v`, [b.id])).v).toBe("refunderet");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_resultat($1, true, 're_2', null) as v`, [b.id])).v).toBe("allerede");
    const rf = await en<{ stripe_refund_id: string; status: string }>(
      `select stripe_refund_id, status from public.returfragt_betalinger where id = $1`,
      [b.id],
    );
    expect(rf).toEqual({ stripe_refund_id: "re_1", status: "refunderet" });
    // En senere fejlet refusion genåbner til nyt forsøg ...
    expect((await en<{ v: string }>(`select public.returfragt_refusion_fejlet('re_1', 'kort lukket') as v`)).v).toBe("genaabnet");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_resultat($1, true, 're_3', null) as v`, [b.id])).v).toBe("refunderet");
    // Efter refusionen kan køberen betale igen (ny række) ...
    expect((await start(h.tradeId)).kode).toBe("ok");
    // ... og så kan den gamle ikke genåbnes (én aktiv pr. handel): staff.
    expect((await en<{ v: string }>(`select public.returfragt_refusion_fejlet('re_3', 'kort lukket') as v`)).v).toBe("markeret");
  });

  it("5 label-fejl -> refunder; sagen ændret -> refunder (ikke nødvendig)", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    for (let i = 1; i <= 5; i++) {
      expect((await en<{ v: number }>(`select public.returfragt_label_fejlet($1, 'Adressen blev afvist.', 'x') as v`, [b.id])).v).toBe(i);
    }
    await db.query(`update public.returfragt_betalinger set label_naeste_kl = null, betalt_kl = now() - interval '1 hour' where id = $1`, [b.id]);
    let k = await db.query<{ id: string; handling: string }>(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b.id)?.handling).toBe("refunder");

    const h2 = await handel();
    const b2 = await betalt(h2.tradeId);
    await db.query(`update public.returfragt_betalinger set betalt_kl = now() - interval '1 hour' where id = $1`, [b2.id]);
    await db.query(`update public.sager set status = 'afgjort_saelger' where id = $1`, [h2.sagId]);
    k = await db.query(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b2.id)?.handling).toBe("refunder");
  });

  it("ubetalt med PaymentIntent: 'synk' efter 15 min; sagen ændret: 'annuller'", async () => {
    const h = await handel();
    const s = await start(h.tradeId);
    await en(`select public.returfragt_gem_pi($1, 'pi_synk1', 0)`, [s.id]);
    await db.query(`alter table public.returfragt_betalinger disable trigger returfragt_laaste_felter`);
    await db.query(`update public.returfragt_betalinger set opdateret = now() - interval '20 minutes' where id = $1`, [s.id]);
    let k = await db.query<{ id: string; handling: string }>(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === s.id)?.handling).toBe("synk");

    // Uden PaymentIntent og med sagen uændret: intet at gøre (sulter ikke køen).
    const h2 = await handel();
    const s2 = await start(h2.tradeId);
    await db.query(`update public.returfragt_betalinger set opdateret = now() - interval '20 minutes' where id = $1`, [s2.id]);
    k = await db.query(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === s2.id)).toBeUndefined();
    await db.query(`update public.sager set status = 'lukket' where id = $1`, [h2.sagId]);
    k = await db.query(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === s2.id)?.handling).toBe("annuller");
    await db.query(`alter table public.returfragt_betalinger enable trigger returfragt_laaste_felter`);
    expect((await en<{ v: boolean }>(`select public.returfragt_annuller($1) as v`, [s2.id])).v).toBe(true);
    expect((await en<{ status: string }>(`select status from public.returfragt_betalinger where id = $1`, [s2.id])).status).toBe("annulleret");
  });

  it("staff-markering lander på returforsendelsen", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const f = await en<{ id: string }>(`insert into public.forsendelser (trade_id, type) values ($1, 'retur') returning id`, [h.tradeId]);
    expect((await en<{ v: boolean }>(`select public.returfragt_marker($1, 'Kunne ikke laves') as v`, [b.id])).v).toBe(true);
    const x = await en<{ kraever_opmaerksomhed: boolean; opmaerksomhed_tekst: string }>(
      `select kraever_opmaerksomhed, opmaerksomhed_tekst from public.forsendelser where id = $1`,
      [f.id],
    );
    expect(x).toEqual({ kraever_opmaerksomhed: true, opmaerksomhed_tekst: "Kunne ikke laves" });
  });
});

describe("fakturaer", () => {
  it("faktura ved betaling (fragt med moms) og kreditnota ved refusion - én gang", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const p1 = await j(`select public.faktura_planlaeg_returfragt(1000) as v`);
    expect(Number(p1.fakturaer)).toBeGreaterThanOrEqual(1);
    const f = await en<{ id: string; dokument: string; part: string; beloeb_oere: string; moms_oere: string; slags: string; betaling_id: string; linjer: { kode: string }[] }>(
      `select id, dokument, part, beloeb_oere, moms_oere, slags, betaling_id, linjer from public.fakturaer where returfragt_id = $1`,
      [b.id],
    );
    expect(f).toMatchObject({ dokument: "faktura", part: "koeber", slags: "sag_returfragt", betaling_id: h.betalingId });
    expect(Number(f.beloeb_oere)).toBe(4000);
    expect(Number(f.moms_oere)).toBe(800);
    expect(f.linjer[0].kode).toBe("fragt");
    await en(`select public.faktura_planlaeg_returfragt(1000)`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where returfragt_id = $1`, [b.id])).n).toBe(1);

    // Refunderet -> kreditnota. En ny betaling på samme handel giver sin egen faktura.
    await en(`select public.returfragt_refusion_claim($1, 'label_umulig')`, [b.id]);
    await en(`select public.returfragt_refusion_resultat($1, true, 're_f', null)`, [b.id]);
    await en(`select public.faktura_planlaeg_returfragt(1000)`);
    const k = await en<{ krediterer_id: string; stripe_reference: string }>(
      `select krediterer_id, stripe_reference from public.fakturaer where returfragt_id = $1 and dokument = 'kreditnota'`,
      [b.id],
    );
    expect(k).toEqual({ krediterer_id: f.id, stripe_reference: "re_f" });
    const b2 = await betalt(h.tradeId);
    await en(`select public.faktura_planlaeg_returfragt(1000)`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where returfragt_id = $1`, [b2.id])).n).toBe(1);
    await en(`select public.faktura_planlaeg_returfragt(1000)`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where trade_id = $1`, [h.tradeId])).n).toBe(3);
  });
});

describe("RLS og visning", () => {
  it("køberen ser kun sin egen række; min_returfragt for køber og sælger", async () => {
    const h = await handel();
    await betalt(h.tradeId);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${KOEBER}', false);`);
    const egne = await en<{ n: number }>(`select count(*)::int as n from public.returfragt_betalinger where trade_id = '${h.tradeId}'`);
    expect(egne.n).toBe(1);
    const m = await j(`select public.min_returfragt('${h.tradeId}') as v`);
    expect(m).toMatchObject({ rolle: "koeber", status: "betalt", beloeb_oere: 4000, label_klar: false });
    expect(m.afsender).toBeNull();
    await expect(db.query(`select public.returfragt_start('${h.tradeId}', '${KOEBER}')`)).rejects.toThrow(/permission denied/);
    // Kun de viste felter - ikke interne fejl, Stripe-id'er eller staff-noter.
    expect((await en<{ n: number }>(`select count(status)::int as n from public.returfragt_betalinger where trade_id = '${h.tradeId}'`)).n).toBe(1);
    for (const kol of ["label_intern_fejl", "stripe_payment_intent_id", "opmaerksomhed_tekst", "koeber_id", "sidste_fejl"]) {
      await expect(db.query(`select ${kol} from public.returfragt_betalinger`), kol).rejects.toThrow(/permission denied/);
    }
    await expect(
      db.query(`update public.returfragt_betalinger set status = 'refunderet' where trade_id = '${h.tradeId}'`),
    ).rejects.toThrow(/permission denied/);
    await db.exec(`select set_config('request.jwt.claim.sub', '${FREMMED}', false);`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.returfragt_betalinger`)).n).toBe(0);
    expect((await en<{ v: unknown }>(`select public.min_returfragt('${h.tradeId}') as v`)).v).toBeNull();
    await db.exec(`select set_config('request.jwt.claim.sub', '${SAELGER}', false);`);
    expect(await j(`select public.min_returfragt('${h.tradeId}') as v`)).toEqual({ rolle: "saelger", retur_paa_vej: false });
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  });

  it("handelsdata kan ikke slettes", async () => {
    const h = await handel();
    const s = await start(h.tradeId);
    await expect(db.query(`delete from public.returfragt_betalinger where id = $1`, [s.id])).rejects.toThrow(/må ikke slettes/);
  });
});

describe("reviewer-rettelser", () => {
  it("annulleret UDEN fragtfirmaets bekræftelse: koden står, ingen ny kode, ingen auto-refusion - staff kan refundere", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const f1 = await en<{ id: string }>(`insert into public.forsendelser (trade_id, type) values ($1, 'retur') returning id`, [h.tradeId]);
    await db.query(`update public.forsendelser set status = 'oprettet' where id = $1`, [f1.id]);
    // Aktiv kode: staff kan ikke refundere.
    expect((await en<{ v: string }>(`select public.returfragt_staff_refusion($1, $2, 'test') as v`, [STAFF, b.id])).v).toBe("label_findes");
    // Annulleret kun i BidHamr (DAO: FragtAnnulleringIkkeMulig) - ingen bekræftelse.
    await db.query(`update public.forsendelser set status = 'annulleret' where id = $1`, [f1.id]);
    const rf = await en<{ label_klar_kl: string | null }>(`select label_klar_kl from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(rf.label_klar_kl).not.toBeNull();
    // Ingen ny kode (to gyldige koder) ...
    await expect(db.query(`insert into public.forsendelser (trade_id, type) values ($1, 'retur')`, [h.tradeId])).rejects.toThrow(/returfragt_ikke_betalt/);
    // ... og ingen automatisk refusion, heller ikke efter 48 timer.
    await db.query(`update public.returfragt_betalinger set betalt_kl = now() - interval '49 hours', label_naeste_kl = null where id = $1`, [b.id]);
    const k = await db.query<{ id: string; handling: string }>(`select * from public.returfragt_cron(100, 100)`);
    expect(k.rows.find((x) => x.id === b.id)).toBeUndefined();
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'label_umulig') as v`, [b.id])).v).toBe("staff_afgoer");
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'ikke_noedvendig') as v`, [b.id])).v).toBe("staff_afgoer");
    // Køberen ser, at koden er annulleret (ikke klar).
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${KOEBER}', false);`);
    expect(await j(`select public.min_returfragt('${h.tradeId}') as v`)).toMatchObject({ label_klar: false, label_annulleret: true });
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    // Staff: rolle, begrundelse og inhabilitet - derefter ok.
    expect((await en<{ v: string }>(`select public.returfragt_staff_refusion($1, $2, 'test') as v`, [MEDARBEJDER, b.id])).v).toBe("ingen_adgang");
    expect((await en<{ v: string }>(`select public.returfragt_staff_refusion($1, $2, '  ') as v`, [STAFF, b.id])).v).toBe("begrundelse_mangler");
    await db.query(`update public.users set rolle = 'admin' where id = $1`, [SAELGER]);
    expect((await en<{ v: string }>(`select public.returfragt_staff_refusion($1, $2, 'test') as v`, [SAELGER, b.id])).v).toBe("inhabil");
    await db.query(`update public.users set rolle = 'bruger' where id = $1`, [SAELGER]);
    expect((await en<{ v: string }>(`select public.returfragt_staff_refusion($1, $2, 'Køberen sender selv') as v`, [STAFF, b.id])).v).toBe("ok");
    const x = await en<{ status: string; refusion_aarsag: string }>(`select status, refusion_aarsag from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(x).toEqual({ status: "refunderes", refusion_aarsag: "staff" });
    const log = await en<{ handling: string; maal_type: string; maal_id: string }>(
      `select handling, maal_type, maal_id from public.moderation_log where medarbejder_id = $1`, [STAFF]);
    expect(log).toEqual({ handling: "returfragt_refunderet", maal_type: "handel", maal_id: h.tradeId });
  });

  it("annulleret MED fragtfirmaets bekræftelse: ny kode uden ny betaling", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const f1 = await en<{ id: string }>(`insert into public.forsendelser (trade_id, type) values ($1, 'retur') returning id`, [h.tradeId]);
    await db.query(`update public.forsendelser set status = 'oprettet' where id = $1`, [f1.id]);
    // Bekræftelse før annulleringen virker ikke.
    expect((await en<{ v: string }>(`select public.returfragt_annullering_bekraeftet($1) as v`, [f1.id])).v).toBe("uaendret");
    await db.query(`update public.forsendelser set status = 'annulleret' where id = $1`, [f1.id]);
    expect((await en<{ v: string }>(`select public.returfragt_annullering_bekraeftet($1) as v`, [f1.id])).v).toBe("ok");
    const rf = await en<{ label_klar_kl: string | null; label_annulleret_bekraeftet_kl: string | null }>(
      `select label_klar_kl, label_annulleret_bekraeftet_kl from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(rf.label_klar_kl).toBeNull();
    expect(rf.label_annulleret_bekraeftet_kl).not.toBeNull();
    const f2 = await en<{ id: string }>(`insert into public.forsendelser (trade_id, type) values ($1, 'retur') returning id`, [h.tradeId]);
    await db.query(`update public.forsendelser set status = 'oprettet' where id = $1`, [f2.id]);
    const efter = await en<{ forsendelse_id: string; label_klar_kl: string | null; n: number }>(
      `select forsendelse_id, label_klar_kl, (select count(*)::int from public.returfragt_betalinger where trade_id = $2) as n
         from public.returfragt_betalinger where id = $1`, [b.id, h.tradeId]);
    expect(efter.forsendelse_id).toBe(f2.id);
    expect(efter.label_klar_kl).not.toBeNull();
    expect(efter.n).toBe(1);
  });

  it("en forsendelse kan ikke skifte type til retur", async () => {
    const h = await handel();
    const f = await en<{ id: string }>(`select id from public.forsendelser where trade_id = $1 and type = 'udgaaende'`, [h.tradeId]);
    await expect(db.query(`update public.forsendelser set type = 'retur' where id = $1`, [f.id])).rejects.toThrow(/returfragt_type/);
  });

  it("charge.refunded: fuld refusion uden om BidHamr -> refunderet, ingen ny kode; delvis -> staff", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    const ch = `ch_x${b.pi}`;
    expect((await en<{ v: string }>(`select public.returfragt_registrer_charge_refusion($1, 're_d', false) as v`, [ch])).v).toBe("markeret");
    expect((await en<{ v: string }>(`select public.returfragt_registrer_charge_refusion($1, 're_d', true) as v`, [ch])).v).toBe("refunderet");
    expect((await en<{ v: string }>(`select public.returfragt_registrer_charge_refusion($1, 're_d', true) as v`, [ch])).v).toBe("allerede");
    const x = await en<{ status: string; refusion_aarsag: string; stripe_refund_id: string; kraever_opmaerksomhed: boolean }>(
      `select status, refusion_aarsag, stripe_refund_id, kraever_opmaerksomhed from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(x).toEqual({ status: "refunderet", refusion_aarsag: "ekstern", stripe_refund_id: "re_d", kraever_opmaerksomhed: true });
    await expect(db.query(`insert into public.forsendelser (trade_id, type) values ($1, 'retur')`, [h.tradeId])).rejects.toThrow(/returfragt_ikke_betalt/);
    expect((await en<{ v: string }>(`select public.returfragt_registrer_charge_refusion('ch_ukendt', null, true) as v`)).v).toBe("ukendt");
  });

  it("manglende adresse tæller ikke som et forsøg", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    expect((await en<{ v: boolean }>(`select public.returfragt_label_venter($1, 'Skriv din adresse') as v`, [b.id])).v).toBe(true);
    const x = await en<{ label_fejl_antal: number; label_brugerfejl: string }>(
      `select label_fejl_antal, label_brugerfejl from public.returfragt_betalinger where id = $1`, [b.id]);
    expect(x).toEqual({ label_fejl_antal: 0, label_brugerfejl: "Skriv din adresse" });
  });

  it("cron: kun p_labels label-rækker reserveres, label/refusion før synk, opgivne synkes sjældnere", async () => {
    // Ryd køen fra de andre tests (sæt alt i fremtiden).
    await db.query(`alter table public.returfragt_betalinger disable trigger returfragt_laaste_felter`);
    await db.query(`update public.returfragt_betalinger set label_naeste_kl = now() + interval '1 day', refusion_naeste_kl = now() + interval '1 day', synket_kl = now() + interval '1 day'`);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await handel();
      const b = await betalt(h.tradeId);
      await db.query(`update public.returfragt_betalinger set betalt_kl = now() - interval '5 minutes' where id = $1`, [b.id]);
      ids.push(b.id);
    }
    const hs = await handel();
    const s1 = await start(hs.tradeId);
    await en(`select public.returfragt_gem_pi($1, 'pi_opgivet1', 0)`, [s1.id]);
    await db.query(`update public.returfragt_betalinger set opdateret = now() - interval '20 minutes', oprettet_kl = now() - interval '2 days', synket_kl = now() - interval '1 hour' where id = $1`, [s1.id]);
    let k = await db.query<{ id: string; handling: string }>(`select * from public.returfragt_cron(2, 1)`);
    // Grænse 2: label/refusion går før synk; kun 1 label reserveres.
    expect(k.rows.filter((x) => x.handling === "label")).toHaveLength(1);
    expect(k.rows.find((x) => x.id === s1.id)).toBeUndefined();
    const reserveret = await en<{ n: number }>(
      `select count(*)::int as n from public.returfragt_betalinger where id = any($1) and label_naeste_kl > now()`, [ids]);
    expect(reserveret.n).toBe(1);
    // Opgivet (over et døgn gammel): synket for 1 time siden -> ikke nu; for 7 timer siden -> nu.
    k = await db.query(`select * from public.returfragt_cron(100, 0)`);
    expect(k.rows.find((x) => x.id === s1.id)).toBeUndefined();
    await db.query(`update public.returfragt_betalinger set synket_kl = now() - interval '7 hours', opdateret = now() - interval '20 minutes' where id = $1`, [s1.id]);
    k = await db.query(`select * from public.returfragt_cron(100, 0)`);
    expect(k.rows.find((x) => x.id === s1.id)?.handling).toBe("synk");
    await db.query(`alter table public.returfragt_betalinger enable trigger returfragt_laaste_felter`);
  });

  it("genåbnet refusion får et nyt forsøgsnummer (ny idempotency key)", async () => {
    const h = await handel();
    const b = await betalt(h.tradeId);
    await en(`select public.returfragt_refusion_claim($1, 'label_umulig')`, [b.id]);
    await en(`select public.returfragt_refusion_resultat($1, true, 're_g1', null)`, [b.id]);
    expect((await en<{ v: string }>(`select public.returfragt_refusion_fejlet('re_g1', 'x') as v`)).v).toBe("genaabnet");
    expect((await en<{ n: number }>(`select refusion_forsoeg as n from public.returfragt_betalinger where id = $1`, [b.id])).n).toBe(1);
  });
});

describe("afstemningens regler for returfragt", () => {
  it("forventet refunderet og status", () => {
    expect(forventetReturfragtRefunderet({ status: "betalt", beloeb_oere: 4000, modtaget_oere: 4000 })).toBe(0);
    expect(forventetReturfragtRefunderet({ status: "refunderes", beloeb_oere: 4000, modtaget_oere: 4000 })).toBeNull();
    expect(forventetReturfragtRefunderet({ status: "refunderet", beloeb_oere: 4000, modtaget_oere: 3999 })).toBe(3999);
    expect(returfragtStatusAfviger("succeeded", "betalt")).toBe(false);
    expect(returfragtStatusAfviger("succeeded", "afventer")).toBe(true);
    expect(returfragtStatusAfviger("requires_payment_method", "refunderet")).toBe(true);
    expect(returfragtStatusAfviger("canceled", "annulleret")).toBe(false);
    expect(erReturfragtRefusion({ id: "re_1" }, { id: "x", stripe_refund_id: "re_1" })).toBe(true);
    expect(erReturfragtRefusion({ id: "re_2", metadata: { type: "returfragt", returfragt_id: "x" } }, { id: "x", stripe_refund_id: null })).toBe(true);
    expect(erReturfragtRefusion({ id: "re_3", metadata: {} }, { id: "x", stripe_refund_id: "re_1" })).toBe(false);
    expect(erKasseretReturfragtRefusion({ metadata: { type: "returfragt", kasseret: "ja", returfragt_id: "x" } }, "x")).toBe(true);
    expect(erKasseretReturfragtRefusion({ metadata: { type: "returfragt", returfragt_id: "x" } }, "x")).toBe(false);
    expect(erKasseretReturfragtRefusion({ metadata: { type: "returfragt", kasseret: "ja", returfragt_id: "x" } }, null)).toBe(false);
  });
});
