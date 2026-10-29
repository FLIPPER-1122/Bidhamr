// Migrationen 20261102010000_firmapakker.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Stubs af tabellerne og de funktioner, som de
// stod på testdatabasen før migrationen (fixtures/firmapakker_foer_...sql), så
// md5-drift-tjekket kører mod det rigtige. Migrationen køres TO gange
// (idempotent). Testes:
//   - migrering af pakker (arkivér Basis/Plus/Pro/Max, opret Start/Butik/Pro,
//     flyt firmaerne, annullér ventende skift, prissynk kun med Stripe),
//   - kvote pr. kalendermåned (dansk tid, annullerede tæller, BHE03-teksten,
//     ekstra auktioner, ubegrænset, opgradering giver flere med det samme),
//   - prøveperiode, introrabat og særpris (databasedelen - Stripe er mocket
//     væk: spejlet kaldes med Stripes svar),
//   - fremhævninger og kvote (liste_top/aktive_annoncer),
//   - ekstra auktioner,
//   - rettigheder: chef og sælger-rollen må, admin/medarbejder må ikke.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { FIX, MIG } from "./prismodelStub";

const MIGRATION = readFileSync(path.join(MIG, "20261102010000_firmapakker.sql"), "utf8");
const FOER = readFileSync(path.join(FIX, "firmapakker_foer_20261102010000.sql"), "utf8");

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const SAELGERROLLE = "00000000-0000-4000-8000-0000000000c2";
const ADMIN = "00000000-0000-4000-8000-0000000000c3";
const MEDARBEJDER = "00000000-0000-4000-8000-0000000000c4";
const SYSTEM = "00000000-0000-4000-8000-0000000b1d00";
const PRIVAT = "00000000-0000-4000-8000-0000000000a1";

const GAMMEL = {
  BASIS: "66666666-6666-4666-8666-000000000001",
  PLUS: "1ee795f0-4b56-4903-8831-9b741e732834",
  PRO: "9b5fa06b-0916-45af-a143-dd3af50c52e9",
  MAX: "d0e754b8-0cc7-498b-8cdf-6f4fcd7f94cc",
};
const NY = {
  START: "7e57a000-0000-4000-8000-000000000001",
  BUTIK: "7e57a000-0000-4000-8000-000000000002",
  PRO: "7e57a000-0000-4000-8000-000000000003",
};

// Firmaer: bruger-id og firma-id.
const B = {
  basis: "00000000-0000-4000-8000-0000000000f1",
  plus: "00000000-0000-4000-8000-0000000000f2",
  pro: "00000000-0000-4000-8000-0000000000f3",
  max: "00000000-0000-4000-8000-0000000000f4",
  ny: "00000000-0000-4000-8000-0000000000f5",
};
const F = {
  basis: "00000000-0000-4000-8000-00000000f0a1",
  plus: "00000000-0000-4000-8000-00000000f0b1",
  pro: "00000000-0000-4000-8000-00000000f0c1",
  max: "00000000-0000-4000-8000-00000000f0d1",
  ny: "00000000-0000-4000-8000-00000000f0e1",
};

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select null::text $$;
create table auth.users (id uuid primary key, email text, invited_at timestamptz, last_sign_in_at timestamptz,
  encrypted_password text, created_at timestamptz not null default now());
create table public.users (id uuid primary key, navn text, email text, rolle text not null default 'bruger',
  konto_type text not null default 'privat', konto_lukket_kl timestamptz, konto_slettet_kl timestamptz,
  suspenderet boolean not null default false, suspenderet_til timestamptz, oprettet timestamptz not null default now(),
  fornavn text, efternavn text, telefon text);
insert into public.users (id, navn, rolle, konto_type) values
  ('${CHEF}', 'Chef', 'chef', 'privat'), ('${SAELGERROLLE}', 'Sælger', 'saelger', 'privat'),
  ('${ADMIN}', 'Admin', 'admin', 'privat'), ('${MEDARBEJDER}', 'Medarbejder', 'medarbejder', 'privat'),
  ('${SYSTEM}', 'BidHamr', 'bruger', 'privat'), ('${PRIVAT}', 'Privat', 'bruger', 'privat'),
  ('${B.basis}', 'Basis ApS', 'bruger', 'erhverv'), ('${B.plus}', 'Plus ApS', 'bruger', 'erhverv'),
  ('${B.pro}', 'Pro ApS', 'bruger', 'erhverv'), ('${B.max}', 'Max ApS', 'bruger', 'erhverv');
create function public.bidhamr_system_id() returns uuid language sql immutable as $$ select '${SYSTEM}'::uuid $$;
create function public.stand_normaliser(p text) returns text language sql immutable as $$ select p $$;
create function public.rate_limit_tjek(p_noegle text, p_max integer, p_sek integer) returns boolean
  language sql as $$ select true $$;
create function public.drift_fejl_log(a text, b text, c text, d text, e uuid) returns void language sql as $$ select $$;

create table public.erhverv_pakker (id uuid primary key default gen_random_uuid(), navn text not null unique,
  beskrivelse text, maanedspris numeric, auktioner_pr_uge integer not null check (auktioner_pr_uge between 1 and 1000),
  aktiv boolean not null default true, sortering integer not null default 0, oprettet_af uuid, opdateret_af uuid,
  oprettet_kl timestamptz not null default now(), opdateret_kl timestamptz not null default now(),
  stripe_price_id text, stripe_price_oere bigint, ugens_butik_rabat_procent integer not null default 0,
  ugens_butik_rabat_antal integer not null default 0);
insert into public.erhverv_pakker (id, navn, maanedspris, auktioner_pr_uge, sortering, stripe_price_id) values
  ('${GAMMEL.BASIS}', 'Basis', 1000, 1, 10, 'price_basis'), ('${GAMMEL.PLUS}', 'Plus', 2000, 2, 20, null),
  ('${GAMMEL.PRO}', 'Pro', 3000, 3, 30, null), ('${GAMMEL.MAX}', 'Max', 4000, 4, 40, null);

create table public.erhverv_henvendelser (id uuid primary key default gen_random_uuid(), status text not null default 'ny',
  behandlet_af uuid, behandlet_kl timestamptz, opdateret_kl timestamptz);

create table public.firmaer (id uuid primary key default gen_random_uuid(), bruger_id uuid not null unique references public.users(id),
  firmanavn text not null, cvr text not null, adresse text not null default 'Vej 1', postnummer text not null default '8000',
  bynavn text not null default 'Aarhus', telefon text not null default '12345678', kontakt_email text not null default 'f@test.dk',
  kontaktperson text not null default 'Kontakt', henvendelse_id uuid, pakke_id uuid not null references public.erhverv_pakker(id),
  abonnement_status text not null default 'afventer_betaling', abonnement_start timestamptz not null default now(),
  naeste_pakke_id uuid, naeste_pakke_fra timestamptz, stripe_customer_id text, stripe_subscription_id text,
  betalt_til timestamptz, betaling_mislykket_kl timestamptz, pauset_aarsag text, opsagt_kl timestamptz, oprettet_af uuid,
  oprettet_kl timestamptz not null default now(), opdateret_kl timestamptz not null default now(),
  stripe_abonnement_status text, opsiges_fra timestamptz, periode_slut timestamptz, pakkeskift_i_gang_kl timestamptz,
  pakkeskift_laas uuid, bruger_brugtmoms boolean not null default false, luk_opsigelse_forsoeg integer not null default 0,
  luk_opsigelse_naeste_kl timestamptz, luk_opsigelse_fejl text, luk_opsigelse_kl timestamptz);
insert into public.firmaer (id, bruger_id, firmanavn, cvr, pakke_id, abonnement_status, stripe_subscription_id) values
  ('${F.basis}', '${B.basis}', 'Basis ApS', '11111111', '${GAMMEL.BASIS}', 'aktiv', 'sub_basis'),
  ('${F.plus}', '${B.plus}', 'Plus ApS', '22222222', '${GAMMEL.PLUS}', 'aktiv', null),
  ('${F.pro}', '${B.pro}', 'Pro ApS', '33333333', '${GAMMEL.PRO}', 'aktiv', null),
  ('${F.max}', '${B.max}', 'Max ApS', '44444444', '${GAMMEL.MAX}', 'afventer_betaling', null);

create table public.firma_pakkeskift (id uuid primary key default gen_random_uuid(), firma_id uuid not null references public.firmaer(id),
  fra_pakke_id uuid, til_pakke_id uuid not null, type text not null, status text not null, gaelder_fra timestamptz,
  anmodet_af uuid, stripe_reference text unique, note text, oprettet_kl timestamptz not null default now(),
  behandlet_kl timestamptz, stripe_invoice_id text);
-- En ventende opgradering Plus -> Pro (gamle pakker): annulleres ved flytningen.
insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status) values
  ('${F.plus}', '${GAMMEL.PLUS}', '${GAMMEL.PRO}', 'opgradering', 'afventer_betaling');

create table public.firma_regninger (id uuid primary key default gen_random_uuid(), firma_id uuid not null, nummer text,
  type text not null, periode_fra date, periode_til date, beloeb_oere bigint not null, status text not null default 'afventer',
  stripe_invoice_id text unique, stripe_reference text unique, pdf_url text, betalt_kl timestamptz,
  oprettet_kl timestamptz not null default now(), beloeb_ekskl_moms_oere bigint, moms_oere bigint, hosted_url text,
  stripe_subscription_id text, krediteret_kl timestamptz);

create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now(),
  constraint moderation_log_handling_check check (handling = any ('{erhverv_pakke_gemt,firma_oprettet,firma_opdateret}'::text[])),
  constraint moderation_log_maal_type_check check (maal_type = any ('{bruger,erhverv_pakke,firma}'::text[])));

create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid not null, titel text default 'Vare',
  status text not null default 'aktiv', oprettet timestamptz not null default now(),
  slutter_kl timestamptz not null default now() + interval '3 days', skjult boolean default false, arkiveret_kl timestamptz,
  pauset_kl timestamptz, kunst_kontrol text, kategori text default 'moebler', erhverv boolean not null default false,
  producent text, sikkerhedsoplysninger text, stand text default 'brugt', antal_bud integer default 0);
create table public.bids (id uuid primary key default gen_random_uuid(), auktion_id uuid, bruger_id uuid, oprettet timestamptz default now());
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid, buyer_id uuid, seller_id uuid,
  status text, amount numeric, afhentning boolean default false, created_at timestamptz default now());
create table public.betalinger (id uuid primary key default gen_random_uuid(), seller_id uuid, trade_id uuid, status text,
  udbetaling_oere bigint, overfoert_kl timestamptz, refunderet_kl timestamptz, annulleret_kl timestamptz,
  refusion_anmodet_kl timestamptz, afsendelsesfrist_annulleret_kl timestamptz, afhentningsfrist_annulleret_kl timestamptz,
  indsigelse_tabt_kl timestamptz);
create table public.auction_views (auktion_id uuid, foerste_visning timestamptz default now());
create table public.auction_questions (id uuid primary key default gen_random_uuid(), auction_id uuid, question text,
  answer text, asked_at timestamptz default now(), hidden boolean default false);
create table public.boost_indstillinger (id boolean primary key default true, maks_pladser integer not null default 4,
  rotation_minutter integer not null default 10);
insert into public.boost_indstillinger values (true, 4, 10);
create table public.auktion_boosts (id uuid primary key default gen_random_uuid(), auktion_id uuid not null,
  start_kl timestamptz not null default now(), slut_kl timestamptz not null);
`;

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}
async function rpc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await en<{ r: T }>(`select ${sql} as r`, params)).r;
}
async function som<T>(bruger: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [bruger ?? ""]);
  try {
    return await fn();
  } finally {
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
async function opretAuktion(bruger: string, ekstra = ""): Promise<string> {
  const r = await en<{ id: string }>(
    `insert into public.auctions (bruger_id${ekstra ? ", " + ekstra.split("=")[0] : ""})
     values ($1${ekstra ? ", " + ekstra.split("=")[1] : ""}) returning id`,
    [bruger],
  );
  return r.id;
}
async function fejl(fn: () => Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { message: string; code?: string };
  }
  throw new Error("forventede en fejl");
}

async function nyDatabase(): Promise<void> {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(FOER);
  await db.exec(`create trigger auctions_zz_erhverv before insert or update on public.auctions
                 for each row execute function public.auctions_erhverv()`);
  await db.exec(MIGRATION);
}

describe("firmapakker (20261102010000)", () => {
  beforeAll(async () => {
    await nyDatabase();
    // Idempotent: anden kørsel ændrer intet og fejler ikke.
    await db.exec(MIGRATION);
  });

  describe("migrering af pakker", () => {
    it("arkiverer Basis/Plus/Pro/Max uden at slette dem", async () => {
      const r = await db.query<{ id: string; navn: string; aktiv: boolean; arkiveret: boolean }>(
        `select id, navn, aktiv, arkiveret_kl is not null as arkiveret from public.erhverv_pakker
          where id = any($1::uuid[]) order by sortering`,
        [Object.values(GAMMEL)],
      );
      expect(r.rows.map((x) => [x.navn, x.aktiv, x.arkiveret])).toEqual([
        ["Basis (gammel)", false, true],
        ["Plus (gammel)", false, true],
        ["Pro (gammel)", false, true],
        ["Max (gammel)", false, true],
      ]);
    });

    it("opretter Start, Butik og Pro med de rigtige tal (ekskl. moms)", async () => {
      const r = await db.query<Record<string, unknown>>(
        `select navn, maanedspris::int as pris, auktioner_pr_maaned, fremhaevninger_pr_maaned, statistik,
                fast_kontaktperson, ugens_butik_rabat_procent, ugens_butik_rabat_antal, aktiv, auktioner_pr_uge
           from public.erhverv_pakker where id = any($1::uuid[]) order by sortering`,
        [Object.values(NY)],
      );
      expect(r.rows).toEqual([
        { navn: "Start", pris: 499, auktioner_pr_maaned: 10, fremhaevninger_pr_maaned: 0, statistik: "ingen",
          fast_kontaktperson: false, ugens_butik_rabat_procent: 0, ugens_butik_rabat_antal: 0, aktiv: true, auktioner_pr_uge: null },
        { navn: "Butik", pris: 999, auktioner_pr_maaned: 30, fremhaevninger_pr_maaned: 5, statistik: "statistik",
          fast_kontaktperson: false, ugens_butik_rabat_procent: 50, ugens_butik_rabat_antal: 3, aktiv: true, auktioner_pr_uge: null },
        { navn: "Pro", pris: 1999, auktioner_pr_maaned: null, fremhaevninger_pr_maaned: 20, statistik: "fuld",
          fast_kontaktperson: true, ugens_butik_rabat_procent: 50, ugens_butik_rabat_antal: 5, aktiv: true, auktioner_pr_uge: null },
      ]);
    });

    it("flytter firmaerne: Basis -> Start, Plus -> Butik, Pro/Max -> Pro", async () => {
      const r = await db.query<{ id: string; pakke_id: string; stripe_pris_synk: boolean }>(
        `select id, pakke_id, stripe_pris_synk from public.firmaer where id = any($1::uuid[])`,
        [[F.basis, F.plus, F.pro, F.max]],
      );
      const m = new Map(r.rows.map((x) => [x.id, x]));
      expect(m.get(F.basis)?.pakke_id).toBe(NY.START);
      expect(m.get(F.plus)?.pakke_id).toBe(NY.BUTIK);
      expect(m.get(F.pro)?.pakke_id).toBe(NY.PRO);
      expect(m.get(F.max)?.pakke_id).toBe(NY.PRO);
      // Kun firmaet med et Stripe-abonnement skal have prisen skiftet i Stripe.
      expect(m.get(F.basis)?.stripe_pris_synk).toBe(true);
      expect(m.get(F.plus)?.stripe_pris_synk).toBe(false);
    });

    it("annullerer ventende skift til de gamle pakker, logger flytningen én gang", async () => {
      const s = await en<{ status: string }>(
        `select status from public.firma_pakkeskift where firma_id = $1 and type = 'opgradering'`,
        [F.plus],
      );
      expect(s.status).toBe("annulleret");
      const log = await en<{ n: number }>(
        `select count(*)::int as n from public.moderation_log where handling = 'firma_pakker_flyttet'`,
      );
      expect(log.n).toBe(4);
      const skift = await en<{ n: number }>(
        `select count(*)::int as n from public.firma_pakkeskift where type = 'bidhamr' and status = 'gennemfoert'`,
      );
      expect(skift.n).toBe(4);
    });

    it("drift-tjekket stopper migrationen, hvis en erstattet funktion er ændret uden migration", async () => {
      const ny = new PGlite();
      await ny.exec(STUB);
      await ny.exec(FOER);
      await ny.exec(`create or replace function public.firma_ugekvote() returns jsonb language sql as $$ select '{}'::jsonb $$`);
      await expect(ny.exec(MIGRATION)).rejects.toThrow(/firma_ugekvote\(\).*passer ikke/);
      await ny.close();
    });
  });

  describe("kvote pr. kalendermåned", () => {
    it("tæller alle auktioner i måneden (også annullerede) og afviser den 11. på Start med dansk tekst", async () => {
      for (let i = 0; i < 9; i++) await opretAuktion(B.basis);
      // Annulleret tæller også.
      const id = await opretAuktion(B.basis);
      await db.query(`update public.auctions set status = 'annulleret' where id = $1`, [id]);
      // En auktion fra sidste måned tæller ikke.
      await db.query(
        `update public.auctions set oprettet = public.erhverv_maaned_start(now()) - interval '1 second'
          where id = (select id from public.auctions where bruger_id = $1 order by oprettet limit 1)`,
        [B.basis],
      );
      const k = await rpc<Record<string, unknown>>(`public.erhverv_kvote($1, false)`, [B.basis]);
      expect(k.brugt).toBe(9);
      expect(k.max).toBe(10);
      await opretAuktion(B.basis);
      const f = await fejl(() => opretAuktion(B.basis));
      expect(f.code).toBe("BHE03");
      const naeste = await en<{ navn: string }>(`select public.erhverv_maaned_navn(public.erhverv_naeste_maaned(now())) as navn`);
      expect(f.message).toBe(
        `erhverv_kvote: Du har oprettet 10 af 10 auktioner i denne måned. Du kan oprette den næste den 1. ${naeste.navn}.`,
      );
    });

    it("måneden er dansk tid og nulstilles den 1.", async () => {
      const r = await en<{ s: string; n: string; navn: string }>(
        `select public.erhverv_maaned_start('2026-10-31 23:30:00+00') as s,
                public.erhverv_naeste_maaned('2026-10-31 23:30:00+00') as n,
                public.erhverv_maaned_navn('2026-10-31 23:30:00+00') as navn`,
      );
      // 31. okt. 23:30 UTC = 1. nov. 00:30 dansk tid -> november.
      expect(new Date(r.s).toISOString()).toBe("2026-10-31T23:00:00.000Z");
      expect(new Date(r.n).toISOString()).toBe("2026-11-30T23:00:00.000Z");
      expect(r.navn).toBe("november");
    });

    it("ekstra auktioner i måneden giver plads med det samme", async () => {
      const svar = await rpc(`public.erhverv_firma_ekstra_giv($1, $2, 2, 0, 'Aftale i telefon')`, [SAELGERROLLE, F.basis]);
      expect(svar).toMatchObject({ kode: "ok", auktioner: 2 });
      await opretAuktion(B.basis);
      await opretAuktion(B.basis);
      expect((await fejl(() => opretAuktion(B.basis))).code).toBe("BHE03");
      const k = await som(B.basis, () => rpc<Record<string, unknown>>(`public.firma_kvote()`));
      expect(k).toMatchObject({ brugt: 12, max: 12, ekstra: 2, kan_oprette: false, aktivt_abonnement: true, ubegraenset: false });
      // Det gamle navn svarer det samme (appen).
      expect(await som(B.basis, () => rpc(`public.firma_ugekvote()`))).toEqual(k);
    });

    it("ekstra auktioner kan rettes ned, men aldrig under 0, og kræver begrundelse", async () => {
      expect(await rpc(`public.erhverv_firma_ekstra_giv($1, $2, -5, 0, 'Fejl')`, [CHEF, F.basis])).toMatchObject({ kode: "under_nul" });
      expect(await rpc(`public.erhverv_firma_ekstra_giv($1, $2, 1, 0, '')`, [CHEF, F.basis])).toMatchObject({ kode: "begrundelse" });
      expect(await rpc(`public.erhverv_firma_ekstra_giv($1, $2, 0, 0, 'Ingen ændring')`, [CHEF, F.basis])).toMatchObject({ kode: "ugyldigt_antal" });
      const log = await en<{ n: number; aarsag: string }>(
        `select count(*)::int as n, max(aarsag) as aarsag from public.moderation_log where handling = 'firma_ekstra_auktioner'`,
      );
      expect(log.n).toBe(1);
      expect(log.aarsag).toContain("+2 ekstra auktioner");
      expect(log.aarsag).toContain("Aftale i telefon");
    });

    it("en betalt opgradering giver flere auktioner med det samme", async () => {
      const s = await en<{ id: string }>(
        `insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status)
         values ($1, $2, $3, 'opgradering', 'afventer_betaling') returning id`,
        [F.basis, NY.START, NY.BUTIK],
      );
      expect((await fejl(() => opretAuktion(B.basis))).code).toBe("BHE03");
      expect(await rpc(`public.firma_pakkeskift_betalt($1, 'in_test_1', 50000, 'in_test_1')`, [s.id])).toMatchObject({ kode: "ok" });
      await opretAuktion(B.basis);
      const k = await rpc<Record<string, unknown>>(`public.erhverv_kvote($1, false)`, [B.basis]);
      expect(k).toMatchObject({ brugt: 13, max: 32, kode: "ok" });
    });

    it("Pro er ubegrænset", async () => {
      for (let i = 0; i < 40; i++) await opretAuktion(B.pro);
      const k = await som(B.pro, () => rpc<Record<string, unknown>>(`public.firma_kvote()`));
      expect(k).toMatchObject({ brugt: 40, max: null, ubegraenset: true, kan_oprette: true });
    });

    it("et firma, der venter på første betaling, kan ikke oprette auktioner (BHE02)", async () => {
      expect((await fejl(() => opretAuktion(B.max))).code).toBe("BHE02");
    });

    it("private konti er uberørte", async () => {
      for (let i = 0; i < 15; i++) await opretAuktion(PRIVAT);
      expect(await som(PRIVAT, () => rpc(`public.firma_kvote()`))).toBeNull();
    });
  });

  describe("pakkeskift med månedspakkerne", () => {
    it("Start -> Butik er en opgradering, Pro -> Butik en nedgradering, arkiveret kan ikke vælges", async () => {
      // Plus-firmaet står nu på Butik.
      const op = await rpc<Record<string, unknown>>(`public.firma_skift_pakke_server($1, $2)`, [B.plus, NY.PRO]);
      expect(op.kode).toBe("opgradering_afventer_betaling");
      await db.query(`update public.firmaer set pakkeskift_i_gang_kl = null where id = $1`, [F.plus]);
      const ned = await rpc<Record<string, unknown>>(`public.firma_skift_pakke_server($1, $2)`, [B.pro, NY.BUTIK]);
      expect(ned.kode).toBe("nedgradering_planlagt");
      await db.query(`update public.firmaer set pakkeskift_i_gang_kl = null where id = $1`, [F.pro]);
      const ark = await rpc<Record<string, unknown>>(`public.firma_skift_pakke_server($1, $2)`, [B.pro, GAMMEL.MAX]);
      expect(ark.kode).toBe("ugyldig_pakke");
    });

    it("i den gratis periode gennemføres skiftet med det samme uden regning (firma_pakkeskift_uden_betaling)", async () => {
      const s = await en<{ id: string }>(
        `select id from public.firma_pakkeskift where firma_id = $1 and status = 'planlagt'`,
        [F.pro],
      );
      expect(await rpc(`public.firma_pakkeskift_uden_betaling($1, 'Skiftet i den gratis periode')`, [s.id])).toMatchObject({ kode: "ok" });
      expect(await rpc(`public.firma_pakkeskift_uden_betaling($1, null)`, [s.id])).toMatchObject({ kode: "allerede_registreret" });
      const f = await en<{ pakke_id: string; naeste_pakke_id: string | null }>(
        `select pakke_id, naeste_pakke_id from public.firmaer where id = $1`,
        [F.pro],
      );
      expect(f).toEqual({ pakke_id: NY.BUTIK, naeste_pakke_id: null });
      const r = await en<{ n: number }>(`select count(*)::int as n from public.firma_regninger where firma_id = $1`, [F.pro]);
      expect(r.n).toBe(0);
      // Tilbage til Pro til de næste tests.
      await rpc(`public.erhverv_firma_opdater($1, $2, $3, null, null, null, null, null, null, null, null, null, 'Tilbage')`, [CHEF, F.pro, NY.PRO]);
    });

    it("staff kan ikke vælge en arkiveret pakke", async () => {
      expect(
        await rpc(`public.erhverv_firma_opdater($1, $2, $3)`, [CHEF, F.plus, GAMMEL.BASIS]),
      ).toMatchObject({ kode: "ugyldig_pakke" });
    });
  });

  describe("prøveperiode, introrabat og særpris (databasedelen)", () => {
    it("et nyt firma oprettes med 1 gratis måned og introrabat fra henvendelsen", async () => {
      await db.query(`insert into auth.users (id, email, invited_at, encrypted_password) values ($1, 'ny@test.dk', now(), '')`, [B.ny]);
      await db.query(`insert into public.users (id, navn) values ($1, 'ny')`, [B.ny]);
      const h = await en<{ id: string }>(`insert into public.erhverv_henvendelser default values returning id`);
      const svar = await rpc<{ kode: string; firma_id: string }>(
        `public.erhverv_firma_opret($1, $2, 'Ny ApS', '55555555', 'Vej 2', '8000', 'Aarhus', '12345678', 'ny@test.dk',
                                    'Kontakt', $3, $4, 50, 6)`,
        [SAELGERROLLE, B.ny, NY.BUTIK, h.id],
      );
      expect(svar.kode).toBe("ok");
      const f = await en<Record<string, unknown>>(
        `select proeve_maaneder, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle is not null as noegle,
                abonnement_status from public.firmaer where id = $1`,
        [svar.firma_id],
      );
      expect(f).toEqual({ proeve_maaneder: 1, intro_procent: 50, intro_maaneder: 6, intro_fra: "efter_gratis",
                          intro_status: "planlagt", noegle: true, abonnement_status: "afventer_betaling" });
      const log = await en<{ aarsag: string }>(`select aarsag from public.moderation_log where handling = 'firma_oprettet'`);
      expect(log.aarsag).toContain("introrabat 50 % i 6 måneder efter den gratis måned");
      F.ny = svar.firma_id;
    });

    it("ugyldig introrabat og arkiveret pakke afvises ved oprettelse", async () => {
      const id = "00000000-0000-4000-8000-0000000000f6";
      await db.query(`insert into auth.users (id, email, invited_at, encrypted_password) values ($1, 'x@test.dk', now(), '')`, [id]);
      await db.query(`insert into public.users (id, navn) values ($1, 'x')`, [id]);
      const args = `$1, $2, 'X ApS', '66666666', 'Vej', '8000', 'Aarhus', '12345678', 'x@test.dk', 'K', $3, null`;
      expect(await rpc(`public.erhverv_firma_opret(${args}, 50, null)`, [CHEF, id, NY.START])).toMatchObject({ kode: "ugyldig_rabat" });
      expect(await rpc(`public.erhverv_firma_opret(${args}, 150, 6)`, [CHEF, id, NY.START])).toMatchObject({ kode: "ugyldig_rabat" });
      expect(await rpc(`public.erhverv_firma_opret(${args})`, [CHEF, id, GAMMEL.PLUS])).toMatchObject({ kode: "ugyldig_pakke" });
    });

    it("gratis periode før start øger proeve_maaneder; med Stripe spejles trial_end", async () => {
      expect(await rpc(`public.erhverv_firma_gratis_gem($1, $2, 2, 'Messe-aftale', false, null)`, [CHEF, F.ny]))
        .toMatchObject({ kode: "ok", proeve_maaneder: 3 });
      expect(await rpc(`public.erhverv_firma_gratis_gem($1, $2, 30, 'For meget', false, null)`, [CHEF, F.ny]))
        .toMatchObject({ kode: "ugyldigt_antal" });
      // Abonnementet starter (webhooken): trialing med trial_end.
      const slut = new Date(Date.now() + 90 * 86400_000).toISOString();
      expect(
        await rpc(`public.firma_stripe_abonnement_spejl($1, 'sub_ny', 'trialing', null, $2::timestamptz, false, null, $2::timestamptz)`, [F.ny, slut]),
      ).toMatchObject({ kode: "ok" });
      const a = await rpc<Record<string, unknown>>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(new Date(a.gratis_til as string).toISOString()).toBe(slut);
      expect(a.gratis_brugt).toBe(false);
      // Forlænget i Stripe: spejles.
      const ny = new Date(Date.now() + 120 * 86400_000).toISOString();
      expect(await rpc(`public.erhverv_firma_gratis_gem($1, $2, 1, 'Ekstra måned', true, $3::timestamptz)`, [SAELGERROLLE, F.ny, ny]))
        .toMatchObject({ kode: "ok" });
      const f = await en<{ proeve_slut: string }>(`select proeve_slut from public.firmaer where id = $1`, [F.ny]);
      expect(new Date(f.proeve_slut).toISOString()).toBe(ny);
      // Prøveperioden er slut (active): gratis_brugt.
      await rpc(`public.firma_stripe_abonnement_spejl($1, 'sub_ny', 'active', null, null, false, null, $2::timestamptz)`, [F.ny, ny]);
      const b = await rpc<Record<string, unknown>>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(b.gratis_til).toBeNull();
      expect(b.gratis_brugt).toBe(true);
      const log = await db.query<{ aarsag: string }>(`select aarsag from public.moderation_log where handling = 'firma_gratis_periode' order by oprettet_kl`);
      expect(log.rows).toHaveLength(2);
      expect(log.rows[0].aarsag).toContain("+2 gratis måneder");
    });

    it("introrabat: spejlet fra Stripe gælder kun den aftale, det hørte til", async () => {
      const gammel = await en<{ noegle: string }>(`select intro_noegle as noegle from public.firmaer where id = $1`, [F.ny]);
      // Staff ændrer aftalen imens: Stripe-svaret for den gamle aftale ignoreres.
      const ny = await rpc<{ kode: string; noegle: string }>(
        `public.erhverv_firma_intro_gem($1, $2, 30, 3, 'straks', 'Ny aftale')`, [CHEF, F.ny],
      );
      expect(ny.kode).toBe("ok");
      expect(await rpc(`public.firma_intro_spejl($1, $2, 'aktiv', 'kupon_gammel', now())`, [F.ny, gammel.noegle]))
        .toMatchObject({ kode: "aendret" });
      expect(await rpc(`public.firma_intro_spejl($1, $2, 'aktiv', 'bidhamr_intro_30_3', now() + interval '3 months')`, [F.ny, ny.noegle]))
        .toMatchObject({ kode: "ok" });
      const a = await rpc<{ introrabat: Record<string, unknown> }>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(a.introrabat).toMatchObject({ procent: 30, maaneder: 3, fra: "straks", status: "aktiv" });
      expect(await rpc(`public.erhverv_firma_intro_gem($1, $2, 30, 0, 'straks', 'Forkert')`, [CHEF, F.ny])).toMatchObject({ kode: "ugyldig_rabat" });
      // Fjern.
      expect(await rpc(`public.erhverv_firma_intro_gem($1, $2, null, null, null, 'Aftale opsagt')`, [SAELGERROLLE, F.ny])).toMatchObject({ kode: "ok" });
      const b = await rpc<{ introrabat: unknown }>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(b.introrabat).toBeNull();
    });

    it("særpris gælder kun den nuværende pakke og bortfalder ved pakkeskift", async () => {
      expect(await rpc(`public.erhverv_firma_saerpris_gem($1, $2, 79900, $3, 'Rabat aftalt', 'naeste_betaling')`, [CHEF, F.ny, NY.START]))
        .toMatchObject({ kode: "pakke_skiftet" });
      expect(await rpc(`public.erhverv_firma_saerpris_gem($1, $2, 79950, $3, 'Øre', 'naeste_betaling')`, [CHEF, F.ny, NY.BUTIK]))
        .toMatchObject({ kode: "ugyldig_pris" });
      expect(await rpc(`public.erhverv_firma_saerpris_gem($1, $2, 79900, $3, 'Rabat aftalt', 'naeste_betaling')`, [SAELGERROLLE, F.ny, NY.BUTIK]))
        .toMatchObject({ kode: "ok" });
      const a = await rpc<Record<string, unknown>>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(a).toMatchObject({ pris: 799, saerpris: 799, saerpris_aftale: "Rabat aftalt" });
      await rpc(`public.erhverv_firma_opdater($1, $2, $3, null, null, null, null, null, null, null, null, null, 'Op')`, [CHEF, F.ny, NY.PRO]);
      const b = await rpc<Record<string, unknown>>(`public.erhverv_firma_abonnement_json($1)`, [F.ny]);
      expect(b).toMatchObject({ pris: 1999, saerpris: null });
      const log = await en<{ aarsag: string }>(
        `select aarsag from public.moderation_log where handling = 'firma_pakke_skiftet' order by oprettet_kl desc limit 1`,
      );
      expect(log.aarsag).toContain("særprisen er bortfaldet");
    });
  });

  describe("særpris og prøveperiode - værn", () => {
    it("særprisen bortfalder også, når firmaet selv skifter pakke (betalt opgradering)", async () => {
      // F.ny står på Pro.
      expect(await rpc(`public.erhverv_firma_saerpris_gem($1, $2, 150000, $3, 'Pro-aftale', 'naeste_betaling')`, [CHEF, F.ny, NY.PRO]))
        .toMatchObject({ kode: "ok" });
      const s = await en<{ id: string }>(
        `insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status)
         values ($1, $2, $3, 'opgradering', 'afventer_betaling') returning id`,
        [F.ny, NY.PRO, NY.BUTIK],
      );
      await rpc(`public.firma_pakkeskift_betalt($1, 'in_saer_1', 0, 'in_saer_1')`, [s.id]);
      const f = await en<Record<string, unknown>>(
        `select pakke_id, saerpris_oere, saerpris_pakke_id, saerpris_aftale from public.firmaer where id = $1`, [F.ny],
      );
      expect(f).toEqual({ pakke_id: NY.BUTIK, saerpris_oere: null, saerpris_pakke_id: null, saerpris_aftale: null });
    });

    it("et spejl uden trial_end (gammel kode under udrulning) bevarer datoen for den gratis periode", async () => {
      const slut = new Date(Date.now() + 20 * 86400_000).toISOString();
      await rpc(`public.firma_stripe_abonnement_spejl($1, 'sub_ny', 'trialing', null, null, false, null, $2::timestamptz)`, [F.ny, slut]);
      // Gammel kode: 7 argumenter.
      await rpc(`public.firma_stripe_abonnement_spejl($1, 'sub_ny', 'trialing', null, null, false, null)`, [F.ny]);
      const f = await en<{ proeve_slut: string }>(`select proeve_slut from public.firmaer where id = $1`, [F.ny]);
      expect(new Date(f.proeve_slut).toISOString()).toBe(slut);
    });
  });

  describe("fremhævninger", () => {
    it("Start har ingen fremhævninger", async () => {
      // Basis-firmaet står nu på Butik efter opgraderingen; sæt Plus-firmaet på Start.
      await rpc(`public.erhverv_firma_opdater($1, $2, $3)`, [CHEF, F.plus, NY.START]);
      const a = await opretAuktion(B.plus);
      const svar = await som(B.plus, () => rpc<Record<string, unknown>>(`public.firma_fremhaev_auktion($1)`, [a]));
      expect(svar.kode).toBe("kvote_brugt");
    });

    it("Butik har 5 om måneden + ekstra, og regler for auktionen håndhæves", async () => {
      const aukt: string[] = [];
      for (let i = 0; i < 7; i++) aukt.push(await opretAuktion(B.basis));
      const fremhaev = (id: string, bruger = B.basis) =>
        som(bruger, () => rpc<Record<string, unknown>>(`public.firma_fremhaev_auktion($1)`, [id]));
      for (let i = 0; i < 5; i++) expect((await fremhaev(aukt[i])).kode).toBe("ok");
      expect((await fremhaev(aukt[0])).kode).toBe("allerede");
      expect((await fremhaev(aukt[5])).kode).toBe("kvote_brugt");
      // Ekstra fremhævning fra staff.
      expect(await rpc(`public.erhverv_firma_ekstra_giv($1, $2, 0, 1, 'Kampagne')`, [CHEF, F.basis])).toMatchObject({ kode: "ok", fremhaevninger: 1 });
      expect((await fremhaev(aukt[5])).kode).toBe("ok");
      expect((await fremhaev(aukt[6])).kode).toBe("kvote_brugt");
      // Andres auktion, for kort tid, skjult.
      const privat = await opretAuktion(PRIVAT);
      expect((await fremhaev(privat)).kode).toBe("ikke_din");
      const kort = await opretAuktion(B.pro, "slutter_kl=now() + interval '30 minutes'");
      expect((await fremhaev(kort, B.pro)).kode).toBe("for_kort_tid");
      const skjult = await opretAuktion(B.pro, "skjult=true");
      expect((await fremhaev(skjult, B.pro)).kode).toBe("ikke_aktiv_auktion");
      const k = await som(B.basis, () => rpc<{ kvote: Record<string, number> }>(`public.firma_fremhaevninger()`));
      expect(k.kvote).toMatchObject({ pakke: 5, ekstra: 1, maks: 6, brugt: 6, tilbage: 0 });
    });

    it("staff stopper en fremhævning og giver den tilbage", async () => {
      const h = await en<{ id: string }>(
        `select h.id from public.firma_fremhaevninger h where h.firma_id = $1 order by h.start_kl limit 1`, [F.basis],
      );
      expect(await rpc(`public.erhverv_fremhaevning_stop($1, $2, true, 'Forkert auktion')`, [SAELGERROLLE, h.id])).toMatchObject({ kode: "ok" });
      expect(await rpc(`public.erhverv_fremhaevning_stop($1, $2, true, 'Igen')`, [SAELGERROLLE, h.id])).toMatchObject({ kode: "allerede" });
      const k = await som(B.basis, () => rpc<{ kvote: Record<string, number> }>(`public.firma_fremhaevninger()`));
      expect(k.kvote.tilbage).toBe(1);
    });

    it("ubrugte forsvinder: sidste måneds fremhævninger tæller ikke i denne måned", async () => {
      await db.query(
        `update public.firma_fremhaevninger set maaned = (public.erhverv_maaned_dato(now()) - interval '1 month')::date
          where firma_id = $1`, [F.basis],
      );
      const k = await som(B.basis, () => rpc<{ kvote: Record<string, number> }>(`public.firma_fremhaevninger()`));
      expect(k.kvote).toMatchObject({ brugt: 0, tilbage: 6 });
    });

    it("liste_top: boost og annonce i én pulje (højst 4), markeret med type; aktive_annoncer", async () => {
      const top = await db.query<{ auktion_id: string; type: string }>(`select * from public.liste_top(null, null)`);
      expect(top.rows.length).toBe(4);
      expect(new Set(top.rows.map((r) => r.type))).toEqual(new Set(["annonce"]));
      // Et boost af en privat auktion kommer med i samme pulje (her alene i sin kategori).
      const privat = await opretAuktion(PRIVAT, "kategori='elektronik'");
      await db.query(
        `insert into public.auktion_boosts (auktion_id, start_kl, slut_kl) values ($1, now() - interval '1 day', now() + interval '1 day')`,
        [privat],
      );
      const top2 = await db.query<{ auktion_id: string; type: string }>(`select * from public.liste_top(null, null)`);
      expect(top2.rows.length).toBe(4);
      const el = await db.query<{ auktion_id: string; type: string }>(
        `select auktion_id, type from public.liste_top('elektronik', null)`,
      );
      expect(el.rows).toEqual([{ auktion_id: privat, type: "boost" }]);
      const ingen = await db.query(`select * from public.liste_top('have', null)`);
      expect(ingen.rows).toHaveLength(0);
      const aktive = await db.query<{ auktion_id: string }>(
        `select auktion_id from public.aktive_annoncer($1::uuid[])`,
        [top.rows.map((r) => r.auktion_id).concat([privat])],
      );
      expect(aktive.rows.map((r) => r.auktion_id).sort()).toEqual(top.rows.map((r) => r.auktion_id).sort());
    });
  });

  describe("firma_oversigt og statistik", () => {
    it("viser pakke, kvote, fremhævninger og abonnement; kun aktive, ikke-arkiverede pakker", async () => {
      const o = await som(B.basis, () => rpc<{ pakke: Record<string, unknown>; pakker: { navn: string }[]; kvote: unknown; ugekvote: unknown; abonnement: Record<string, unknown> }>(`public.firma_oversigt()`));
      expect(o.pakke).toMatchObject({ navn: "Butik", auktioner_pr_maaned: 30, fremhaevninger_pr_maaned: 5, statistik: "statistik" });
      expect(o.pakker.map((p: { navn: string }) => p.navn)).toEqual(["Start", "Butik", "Pro"]);
      expect(o.kvote).toEqual(o.ugekvote);
      expect(o.abonnement).toMatchObject({ pris: 999, saerpris: null });
      expect(o.abonnement.saerpris_aftale).toBeUndefined();
    });

    it("statistik følger pakkens niveau", async () => {
      expect(await som(B.plus, () => rpc(`public.firma_statistik()`))).toMatchObject({ niveau: "ingen", maaneder: [], auktioner: [] });
      const butik = await som(B.basis, () => rpc<Record<string, unknown[]>>(`public.firma_statistik()`));
      expect(butik.niveau).toBe("statistik");
      expect(butik.maaneder).toHaveLength(12);
      expect(butik.auktioner).toEqual([]);
      const pro = await som(B.pro, () => rpc<Record<string, unknown[]>>(`public.firma_statistik()`));
      expect(pro.niveau).toBe("fuld");
      expect(pro.auktioner.length).toBeGreaterThan(0);
    });

    it("admin-listen har gratis periode, introrabat, særpris, kvote og fremhævninger", async () => {
      const liste = await rpc<(Record<string, unknown> & { id: string })[]>(`public.erhverv_firmaer_liste($1)`, [SAELGERROLLE]);
      const b = liste.find((x) => x.id === F.basis)!;
      expect(b.kvote).toMatchObject({ brugt: 20, max: 32, ekstra: 2, ubegraenset: false });
      expect(b.fremhaevninger).toMatchObject({ maks: 6 });
      expect(b).toHaveProperty("gratis_til");
      expect(b).toHaveProperty("introrabat");
      expect(b).toHaveProperty("saerpris");
      expect(b).toHaveProperty("kort");
    });
  });

  describe("pakker (kun chef)", () => {
    it("erhverv_pakke_gem: chef kan gemme med ubegrænset, fremhævninger og statistik", async () => {
      const ok = await rpc<{ kode: string; id: string }>(
        `public.erhverv_pakke_gem($1, null, 'Test', null, 100, null, true, 3, 'fuld', false, false, 99, 10, 2)`, [CHEF],
      );
      expect(ok.kode).toBe("ok");
      const p = await rpc<Record<string, unknown>>(`public.erhverv_pakke_json($1)`, [ok.id]);
      expect(p).toMatchObject({ auktioner_pr_maaned: null, ubegraenset: true, fremhaevninger_pr_maaned: 3, statistik: "fuld",
                                ugens_butik_rabat_procent: 10, ugens_butik_rabat_antal: 2, aktiv: false });
      expect(await rpc(`public.erhverv_pakke_gem($1, null, 'Test2', null, 100, 0, false)`, [CHEF])).toMatchObject({ kode: "ugyldigt_antal" });
      expect(await rpc(`public.erhverv_pakke_gem($1, $2, 'Basis (gammel)', null, 100, 5, false)`, [CHEF, GAMMEL.BASIS]))
        .toMatchObject({ kode: "arkiveret" });
    });

    it("sælger-rollen, admin og medarbejder kan ikke ændre pakker", async () => {
      for (const s of [SAELGERROLLE, ADMIN, MEDARBEJDER]) {
        expect((await fejl(() => rpc(`public.erhverv_pakke_gem($1, null, 'X', null, 1, 1, false)`, [s]))).message).toBe("Ingen adgang");
      }
    });
  });

  describe("rettigheder", () => {
    const staffKald: [string, unknown[]][] = [
      [`public.erhverv_firma_ekstra_giv($1, $2, 1, 0, 'Begrundelse')`, [F.basis]],
      [`public.erhverv_firma_gratis_gem($1, $2, 1, 'Begrundelse', false, null)`, [F.plus]],
      [`public.erhverv_firma_intro_gem($1, $2, 50, 6, 'efter_gratis', 'Begrundelse')`, [F.plus]],
      [`public.erhverv_firma_saerpris_gem($1, $2, 10000, $3, 'Begrundelse', 'naeste_betaling')`, [F.plus, NY.START]],
      [`public.erhverv_firma_opdater($1, $2, $3)`, [F.plus, NY.START]],
      [`public.erhverv_firmaer_liste($1)`, []],
      [`public.erhverv_pakker_liste($1)`, []],
    ];

    it("admin og medarbejder har ingen adgang til firmaernes handlinger", async () => {
      for (const s of [ADMIN, MEDARBEJDER, PRIVAT, B.basis]) {
        for (const [sql, args] of staffKald) {
          expect((await fejl(() => rpc(sql, [s, ...args]))).message).toBe("Ingen adgang");
        }
      }
    });

    it("chef og sælger-rollen kan alle handlingerne", async () => {
      for (const s of [CHEF, SAELGERROLLE]) {
        for (const [sql, args] of staffKald) {
          const svar = await rpc<{ kode?: string } | unknown[]>(sql, [s, ...args]);
          if (!Array.isArray(svar)) expect(svar.kode).toBe("ok");
        }
      }
    });

    it("authenticated/anon kan kun kalde firmaets egne RPC'er og listevisningen", async () => {
      const kan = async (rolle: string, fn: string) =>
        (await en<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [rolle, fn])).ok;
      for (const fn of [
        "public.erhverv_firma_ekstra_giv(uuid,uuid,integer,integer,text)",
        "public.erhverv_firma_gratis_gem(uuid,uuid,integer,text,boolean,timestamptz)",
        "public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text)",
        "public.erhverv_firma_saerpris_gem(uuid,uuid,bigint,uuid,text,text)",
        "public.erhverv_fremhaevning_stop(uuid,uuid,boolean,text)",
        "public.firma_intro_spejl(uuid,uuid,text,text,timestamptz)",
        "public.firma_kort_spejl(uuid,text,text,integer,integer)",
        "public.firma_pakkeskift_uden_betaling(uuid,text)",
        "public.erhverv_kvote(uuid,boolean)",
        "public.erhverv_firma_abonnement_json(uuid)",
        "public.firma_stripe_abonnement_spejl(uuid,text,text,timestamptz,timestamptz,boolean,text,timestamptz)",
      ]) {
        expect(await kan("authenticated", fn)).toBe(false);
        expect(await kan("anon", fn)).toBe(false);
        expect(await kan("service_role", fn)).toBe(true);
      }
      for (const fn of ["public.firma_kvote()", "public.firma_fremhaev_auktion(uuid)", "public.firma_fremhaevninger()"]) {
        expect(await kan("authenticated", fn)).toBe(true);
        expect(await kan("anon", fn)).toBe(false);
      }
      expect(await kan("anon", "public.liste_top(text,text)")).toBe(true);
      expect(await kan("anon", "public.aktive_annoncer(uuid[])")).toBe(true);
    });
  });
});

// Nye kvoter (Filip, 29. okt. 2026): Start 20, Butik 40 - 20261102440000.
const KVOTER = readFileSync(path.join(MIG, "20261102440000_pakke_kvoter.sql"), "utf8");

describe("pakke_kvoter (20261102440000)", () => {
  beforeAll(async () => {
    await nyDatabase();
  });

  const pakker = async () =>
    (await db.query<{ navn: string; auktioner_pr_maaned: number | null; beskrivelse: string }>(
      `select navn, auktioner_pr_maaned, beskrivelse from public.erhverv_pakker
        where id = any($1::uuid[]) order by sortering`,
      [Object.values(NY)],
    )).rows;

  it("Start 20, Butik 40, Pro uændret - og to kørsler giver det samme", async () => {
    await db.exec(KVOTER);
    await db.exec(KVOTER);
    const r = await pakker();
    expect(r.map((p) => [p.navn, p.auktioner_pr_maaned])).toEqual([["Start", 20], ["Butik", 40], ["Pro", null]]);
    expect(r[0].beskrivelse).toContain("20 auktioner om måneden");
    expect(r[1].beskrivelse).toContain("Som Start + 40 auktioner om måneden");
  });

  it("overskriver ikke en kvote eller beskrivelse, chefen selv har sat", async () => {
    await db.query(`update public.erhverv_pakker set auktioner_pr_maaned = 35, beskrivelse = 'Chefens tekst' where id = $1`, [NY.BUTIK]);
    await db.exec(KVOTER);
    expect((await pakker())[1]).toMatchObject({ auktioner_pr_maaned: 35, beskrivelse: "Chefens tekst" });
  });

  it("kvoten følger pakken med det samme", async () => {
    const k = await rpc<Record<string, unknown>>(`public.erhverv_kvote($1, false)`, [B.basis]);
    expect(k.max).toBe(20);
  });
});
