// Migrationen 20261102450000_intro_behold_gratis.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubs af tabellerne og de
// RIGTIGE funktioner, som migrationen erstatter (erhverv_maaned1 og
// erhverv_firma_abonnement_json fra 20261102150000, erhverv_firma_intro_gem fra
// 20261102050000 og erhverv_firma_opret fra 20261102070000), så md5-drift-
// tjekket kører mod det rigtige. Migrationen køres TO gange (idempotent).
// Testes:
//   - "Behold Starts gratis måned + introrabat" i Introrabat-kortet
//     (erhverv_firma_intro_gem) og i "Opret firmakonto" (erhverv_firma_opret):
//     måned 1 'gratis' med introrabat, log med begrundelse, og afvisningerne
//     (Fra nu, Butik/Pro, startet abonnement, ingen gratis måned til gode,
//     begrundelse),
//   - uden valget er alt som før (introrabat = ingen gratis måned), også for
//     gamle kald uden de nye parametre,
//   - triggeren nulstiller valget, når introrabatten fjernes eller ændres til
//     'straks', og et pakkeskift til Butik giver ingen gratis måned,
//   - drift-tjekket afviser en ændret funktion, og rettighederne.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { funktion, MIG } from "./prismodelStub";

const MIGRATION = readFileSync(path.join(MIG, "20261102450000_intro_behold_gratis.sql"), "utf8");

const STAFF = "00000000-0000-4000-8000-0000000000c2";
const START = "7e57a000-0000-4000-8000-000000000001";
const BUTIK = "7e57a000-0000-4000-8000-000000000002";
const FIRMA = "00000000-0000-4000-8000-00000000f451";
const FIRMA_BRUGER = "00000000-0000-4000-8000-0000000000f1";
// CVR, som stub'en af erhverv_cvr_tidligere_json siger har haft abonnement før.
const TIDLIGERE_CVR = "99999999";

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key, invited_at timestamptz, last_sign_in_at timestamptz,
  encrypted_password text, created_at timestamptz not null default now());
create table public.users (id uuid primary key, navn text, email text, konto_type text not null default 'privat',
  rolle text not null default 'bruger', konto_slettet_kl timestamptz, konto_lukket_kl timestamptz,
  oprettet timestamptz not null default now(), fornavn text, efternavn text, telefon text);
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid);
create table public.bids (id uuid primary key default gen_random_uuid(), bruger_id uuid);
create table public.trades (id uuid primary key default gen_random_uuid(), buyer_id uuid, seller_id uuid);
create table public.erhverv_pakker (id uuid primary key, navn text not null, maanedspris numeric,
  maaned1 text not null default 'halv', arkiveret_kl timestamptz);
insert into public.erhverv_pakker (id, navn, maanedspris, maaned1) values
  ('${START}', 'Start', 499, 'gratis'), ('${BUTIK}', 'Butik', 999, 'halv');
create table public.erhverv_henvendelser (id uuid primary key, status text, behandlet_af uuid,
  behandlet_kl timestamptz, opdateret_kl timestamptz);
create table public.firmaer (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid, firmanavn text, cvr text, adresse text, postnummer text, bynavn text, telefon text,
  kontakt_email text, kontaktperson text, henvendelse_id uuid, pakke_id uuid, oprettet_af uuid,
  abonnement_status text not null default 'afventer_betaling',
  proeve_maaneder integer not null default 1, proeve_givet_kl timestamptz, proeve_slut timestamptz,
  proeve_ekstra_ventende integer not null default 0,
  intro_procent integer, intro_maaneder integer, intro_fra text, intro_status text, intro_noegle uuid,
  intro_coupon_id text, intro_til timestamptz,
  saerpris_oere bigint, saerpris_pakke_id uuid, saerpris_aftale text,
  stripe_subscription_id text, stripe_abonnement_status text,
  kort_maerke text, kort_sidste4 text, kort_udloeb_maaned integer, kort_udloeb_aar integer,
  opdateret_kl timestamptz not null default now()
);
create table public.firma_regninger (id uuid primary key default gen_random_uuid(), firma_id uuid,
  type text, status text, beloeb_oere bigint);
create table public.firma_pakkeskift (id uuid primary key default gen_random_uuid(), firma_id uuid,
  fra_pakke_id uuid, til_pakke_id uuid, type text, status text, anmodet_af uuid, behandlet_kl timestamptz);
create table public.moderation_log (id bigserial primary key, medarbejder_id uuid, handling text,
  maal_type text, maal_id uuid, bruger_id uuid, aarsag text);
create table public.erhverv_staff_klik (klik_id uuid primary key, handling text, firma_id uuid, staff_id uuid);
insert into public.users (id, navn, rolle) values ('${STAFF}', 'Ebbe Erhvervssælger', 'saelger');
insert into public.users (id, navn, konto_type) values ('${FIRMA_BRUGER}', 'Firma', 'erhverv');

-- Stubs (ikke md5-tjekket af migrationen).
create function public.erhverv_har_adgang(p_bruger uuid, p_kun_chef boolean default false)
returns boolean language sql stable as $$ select p_bruger = '${STAFF}'::uuid $$;
create function public.erhverv_firma_kvote_json(p_firma uuid)
returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function public.erhverv_cvr_tidligere_json(p_cvr text)
returns jsonb language sql stable as $$
  select case when p_cvr = '${TIDLIGERE_CVR}' then '[{"firmanavn": "Gammelt firma"}]'::jsonb else '[]'::jsonb end $$;
`;

// De rigtige funktioner, som de stod før migrationen.
const RIGTIGE = [
  funktion("20261102010000_firmapakker.sql", "create or replace function public.erhverv_begrundelse_ok("),
  funktion("20261102010000_firmapakker.sql", "create or replace function public.erhverv_firma_log("),
  funktion("20261102020000_firmapakker_rettelser.sql", "create or replace function public.erhverv_staff_klik_tag("),
  funktion("20261102050000_tidligere_cvr_ingen_gratis.sql", "create or replace function public.erhverv_intro_gaelder("),
  funktion("20261102050000_tidligere_cvr_ingen_gratis.sql", "create or replace function public.erhverv_saerpris_gaelder("),
  funktion("20261102050000_tidligere_cvr_ingen_gratis.sql", "create or replace function public.erhverv_firma_intro_gem("),
  funktion("20261102150000_maaned1_rettelser.sql", "create or replace function public.erhverv_har_betalt_abonnement("),
  funktion("20261102150000_maaned1_rettelser.sql", "create or replace function public.erhverv_faar_velkomst_gratis("),
  funktion("20261102150000_maaned1_rettelser.sql", "create or replace function public.erhverv_maaned1("),
  funktion("20261102150000_maaned1_rettelser.sql", "create or replace function public.erhverv_firma_abonnement_json("),
  funktion("20261102070000_maaned1_regel.sql", "create or replace function public.erhverv_firma_opret("),
];

async function nyDatabase(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(STUB);
  for (const f of RIGTIGE) await d.exec(f);
  return d;
}

let db: PGlite;
type J = Record<string, unknown>;

async function j(sql: string, args: unknown[] = []): Promise<J> {
  const r = await db.query<{ j: J }>(sql, args);
  return r.rows[0].j;
}
async function maaned1(firma = FIRMA): Promise<string> {
  const r = await db.query<{ m: string }>(`select public.erhverv_maaned1($1) m`, [firma]);
  return r.rows[0].m;
}
async function firma(id = FIRMA): Promise<J> {
  const r = await db.query<J>(`select * from public.firmaer where id = $1`, [id]);
  return r.rows[0];
}
async function introGem(a: { procent?: number | null; fra?: string | null; behold?: boolean; maaneder?: number | null; firma?: string }): Promise<J> {
  const procent = a.procent === undefined ? 50 : a.procent;
  const maaneder = a.maaneder === undefined ? (procent == null ? null : 6) : a.maaneder;
  const fra = a.fra === undefined ? (procent == null ? null : "efter_gratis") : a.fra;
  if (a.behold === undefined) {
    // Gammelt kald (uden p_behold_gratis) - som før migrationen.
    return j(
      `select public.erhverv_firma_intro_gem(p_staff => $1, p_firma => $2, p_procent => $3, p_maaneder => $4, p_fra => $5, p_begrundelse => $6) j`,
      [STAFF, a.firma ?? FIRMA, procent, maaneder, fra, "Testbegrundelse"],
    );
  }
  return j(
    `select public.erhverv_firma_intro_gem(p_staff => $1, p_firma => $2, p_procent => $3, p_maaneder => $4, p_fra => $5,
                                           p_begrundelse => $6, p_behold_gratis => $7) j`,
    [STAFF, a.firma ?? FIRMA, procent, maaneder, fra, "Filip har ringet", a.behold],
  );
}
async function nulstil(ekstra = ""): Promise<void> {
  await db.exec(`update public.firmaer set pakke_id = '${START}', stripe_subscription_id = null, stripe_abonnement_status = null,
                   proeve_maaneder = 1, proeve_givet_kl = null, proeve_ekstra_ventende = 0, saerpris_oere = null,
                   saerpris_pakke_id = null, intro_procent = null, intro_maaneder = null, intro_fra = null,
                   intro_status = null, intro_til = null, intro_behold_gratis = false
                 where id = '${FIRMA}'`);
  if (ekstra) await db.exec(`update public.firmaer set ${ekstra.replace(/^\s*,/, "")} where id = '${FIRMA}'`);
}
async function senesteLog(maal: string): Promise<string> {
  const r = await db.query<{ aarsag: string }>(`select aarsag from public.moderation_log where maal_id = $1 order by id desc limit 1`, [maal]);
  return r.rows[0]?.aarsag ?? "";
}

let nyBrugerNr = 0;
async function nyInviteretBruger(): Promise<string> {
  nyBrugerNr++;
  const id = `00000000-0000-4000-8000-${String(nyBrugerNr).padStart(12, "0")}`;
  await db.query(`insert into auth.users (id, invited_at) values ($1, now())`, [id]);
  await db.query(`insert into public.users (id, navn) values ($1, 'Ny')`, [id]);
  return id;
}
async function opret(a: {
  pakke?: string;
  intro?: boolean;
  behold?: boolean;
  grund?: string | null;
  cvr?: string;
  bekraeftet?: boolean | null;
  saeraftale?: boolean;
}): Promise<J> {
  const bruger = await nyInviteretBruger();
  const cvr = a.cvr ?? String(10_000_000 + nyBrugerNr);
  const intro = a.intro ?? true;
  const params: unknown[] = [
    STAFF, bruger, `Firma ${nyBrugerNr}`, cvr, "Vej 1", "8000", "Aarhus", "12345678", `f${nyBrugerNr}@test.bidhamr.dk`, "Kontakt",
    a.pakke ?? START, intro ? 50 : null, intro ? 6 : null, a.bekraeftet ?? null,
  ];
  if (a.behold === undefined && !a.saeraftale) {
    // Gammelt kald (uden de nye parametre).
    return j(
      `select public.erhverv_firma_opret(p_staff => $1, p_bruger => $2, p_firmanavn => $3, p_cvr => $4, p_adresse => $5,
         p_postnummer => $6, p_by => $7, p_telefon => $8, p_kontakt_email => $9, p_kontaktperson => $10, p_pakke => $11,
         p_intro_procent => $12, p_intro_maaneder => $13, p_cvr_bekraeftet => $14) j`,
      params,
    );
  }
  return j(
    `select public.erhverv_firma_opret(p_staff => $1, p_bruger => $2, p_firmanavn => $3, p_cvr => $4, p_adresse => $5,
       p_postnummer => $6, p_by => $7, p_telefon => $8, p_kontakt_email => $9, p_kontaktperson => $10, p_pakke => $11,
       p_intro_procent => $12, p_intro_maaneder => $13, p_cvr_bekraeftet => $14,
       p_saeraftale_gratis => $15, p_saeraftale_begrundelse => $16,
       p_intro_behold_gratis => $17, p_intro_behold_begrundelse => $18) j`,
    [...params, a.saeraftale ?? false, a.saeraftale ? "Særaftale med Filip" : null, a.behold ?? false,
     a.grund === undefined ? "Aftalt med Filip i telefonen" : a.grund],
  );
}

describe("Behold Starts gratis måned + introrabat (20261102450000)", () => {
  beforeAll(async () => {
    db = await nyDatabase();
    await db.query(
      `insert into public.firmaer (id, bruger_id, firmanavn, cvr, pakke_id, kontakt_email) values ($1, $2, 'Testfirma', '12345678', $3, 'f@test.bidhamr.dk')`,
      [FIRMA, FIRMA_BRUGER, START],
    );
    // En planlagt introrabat fra før migrationen: ingen gratis måned (som før).
    await db.exec(`update public.firmaer set intro_procent = 50, intro_maaneder = 6, intro_fra = 'efter_gratis', intro_status = 'planlagt' where id = '${FIRMA}'`);
    await db.exec(MIGRATION);
    // Idempotent: anden kørsel ændrer intet og fejler ikke.
    await db.exec(MIGRATION);
  });

  describe("migrationen", () => {
    it("eksisterende firmaer får valget slået FRA (aldrig standard) - ingen ændring af deres måned 1", async () => {
      expect((await firma()).intro_behold_gratis).toBe(false);
      expect(await maaned1()).toBe("ingen");
    });
    it("de gamle signaturer er væk, de nye findes", async () => {
      const r = await db.query<{ gl1: string | null; gl2: string | null; ny1: string | null; ny2: string | null }>(
        `select to_regprocedure('public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid)')::text gl1,
                to_regprocedure('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text)')::text gl2,
                to_regprocedure('public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid,boolean)')::text ny1,
                to_regprocedure('public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text,boolean,text)')::text ny2`,
      );
      expect(r.rows[0]).toMatchObject({ gl1: null, gl2: null });
      expect(r.rows[0].ny1).not.toBeNull();
      expect(r.rows[0].ny2).not.toBeNull();
    });
    it("drift-tjekket afviser en ændret funktion (intet ændres)", async () => {
      const ny = await nyDatabase();
      await ny.exec(`create or replace function public.erhverv_maaned1(p_firma uuid) returns text language sql stable as $$ select 'gratis' $$;`);
      await expect(ny.exec(MIGRATION)).rejects.toThrow(/erhverv_maaned1\(uuid\).*passer hverken/);
      const r = await ny.query<{ n: number }>(
        `select count(*)::int n from information_schema.columns where table_name = 'firmaer' and column_name = 'intro_behold_gratis'`,
      );
      expect(r.rows[0].n).toBe(0);
      await ny.close();
    });
    it("drift-tjekket afviser en ændret gammel erhverv_firma_intro_gem", async () => {
      const ny = await nyDatabase();
      await ny.exec(`create or replace function public.erhverv_firma_intro_gem(p_staff uuid, p_firma uuid, p_procent integer,
        p_maaneder integer, p_fra text, p_begrundelse text, p_klik uuid default null) returns jsonb language sql as $$ select '{}'::jsonb $$;`);
      await expect(ny.exec(MIGRATION)).rejects.toThrow(/erhverv_firma_intro_gem.*passer ikke med forrige migration/);
      await ny.close();
    });
    it("rettigheder: kun service_role", async () => {
      const r = await db.query<{ anon: boolean; auth: boolean; sr: boolean; anon2: boolean; sr2: boolean }>(
        `select has_function_privilege('anon', 'public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid,boolean)', 'execute') anon,
                has_function_privilege('authenticated', 'public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid,boolean)', 'execute') auth,
                has_function_privilege('service_role', 'public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid,boolean)', 'execute') sr,
                has_function_privilege('anon', 'public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text,boolean,text)', 'execute') anon2,
                has_function_privilege('service_role', 'public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text,boolean,text)', 'execute') sr2`,
      );
      expect(r.rows[0]).toEqual({ anon: false, auth: false, sr: true, anon2: false, sr2: true });
    });
  });

  describe("Introrabat-kortet (erhverv_firma_intro_gem)", () => {
    it("valget på Start før Checkout: måned 1 gratis, introrabatten fra første betaling, logget med begrundelse", async () => {
      await nulstil();
      expect(await introGem({ behold: true })).toMatchObject({ kode: "ok", behold_gratis: true });
      expect(await firma()).toMatchObject({ intro_procent: 50, intro_maaneder: 6, intro_fra: "efter_gratis", intro_status: "planlagt", intro_behold_gratis: true });
      expect(await maaned1()).toBe("gratis");
      const ab = await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA]);
      expect(ab).toMatchObject({
        maaned1: "gratis",
        gratis_maaneder_ved_start: 1,
        introrabat: { procent: 50, maaneder: 6, fra: "efter_gratis", status: "planlagt", behold_gratis: true },
      });
      const log = await senesteLog(FIRMA);
      expect(log).toContain("Behold Starts gratis måned + introrabat");
      expect(log).toContain("måned 2-7");
      expect(log).toContain("Filip har ringet");
    });

    it("uden valget (også et gammelt kald): som før - introrabatten erstatter den gratis måned, og valget nulstilles", async () => {
      await introGem({});
      expect((await firma()).intro_behold_gratis).toBe(false);
      expect(await maaned1()).toBe("ingen");
      const ab = await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA]);
      expect(ab).toMatchObject({ maaned1: "ingen", gratis_maaneder_ved_start: 0, behold_gratis_mulig: true });
      expect(await introGem({ behold: false })).toMatchObject({ kode: "ok", behold_gratis: false });
      expect(await maaned1()).toBe("ingen");
    });

    it("'Fra nu' med valget afvises (intet ændres)", async () => {
      await nulstil();
      expect(await introGem({ behold: true, fra: "straks" })).toEqual({ kode: "ugyldig_rabat" });
      expect((await firma()).intro_procent).toBeNull();
    });

    it("Butik: behold_kun_start", async () => {
      await nulstil(`, pakke_id = '${BUTIK}'`);
      expect(await introGem({ behold: true })).toEqual({ kode: "behold_kun_start" });
      expect((await firma()).intro_procent).toBeNull();
      expect((await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA])).behold_gratis_mulig).toBe(false);
    });

    it("abonnementet er startet: behold_startet", async () => {
      await nulstil(`, stripe_subscription_id = 'sub_x', stripe_abonnement_status = 'trialing', proeve_givet_kl = now()`);
      expect(await introGem({ behold: true })).toEqual({ kode: "behold_startet" });
      expect((await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA])).behold_gratis_mulig).toBe(false);
    });

    it("ingen gratis måned til gode (tidligere CVR / brugt / betalt): behold_ingen_gratis", async () => {
      await nulstil(`, proeve_maaneder = 0`);
      expect(await introGem({ behold: true })).toEqual({ kode: "behold_ingen_gratis" });
      await nulstil();
      await db.exec(`insert into public.firma_regninger (firma_id, type, status, beloeb_oere) values ('${FIRMA}', 'abonnement', 'betalt', 49900)`);
      expect(await introGem({ behold: true })).toEqual({ kode: "behold_ingen_gratis" });
      await db.exec(`delete from public.firma_regninger where firma_id = '${FIRMA}'`);
    });

    it("særpris: afvist som før (saerpris_aktiv)", async () => {
      await nulstil(`, saerpris_oere = 39900, saerpris_pakke_id = '${START}'`);
      expect(await introGem({ behold: true })).toEqual({ kode: "saerpris_aktiv" });
      expect((await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA])).behold_gratis_mulig).toBe(false);
    });

    it("fjernes introrabatten, nulstilles valget", async () => {
      await nulstil();
      await introGem({ behold: true });
      expect(await introGem({ procent: null })).toMatchObject({ kode: "ok" });
      expect(await firma()).toMatchObject({ intro_procent: null, intro_behold_gratis: false });
      expect(await maaned1()).toBe("gratis");
    });

    it("dobbeltklik (samme klik-id): kun én gang", async () => {
      await nulstil();
      const klik = "00000000-0000-4000-8000-00000000cc01";
      const kald = () =>
        j(`select public.erhverv_firma_intro_gem($1, $2, 50, 6, 'efter_gratis', 'Filip har ringet', $3::uuid, true) j`, [STAFF, FIRMA, klik]);
      expect(await kald()).toMatchObject({ kode: "ok" });
      expect(await kald()).toEqual({ kode: "allerede_udfoert" });
    });

    it("ingen adgang: kaster", async () => {
      await expect(
        db.query(`select public.erhverv_firma_intro_gem($1, $2, 50, 6, 'efter_gratis', 'x x x', null, true)`, [FIRMA_BRUGER, FIRMA]),
      ).rejects.toThrow(/Ingen adgang/);
    });
  });

  describe("triggeren og reglen for måned 1", () => {
    it("ændres intro_fra til 'straks' eller fjernes introrabatten direkte, nulstilles valget", async () => {
      await nulstil();
      await introGem({ behold: true });
      await db.exec(`update public.firmaer set intro_fra = 'straks' where id = '${FIRMA}'`);
      expect((await firma()).intro_behold_gratis).toBe(false);
      expect(await maaned1()).toBe("ingen");
      await introGem({ behold: true });
      await db.exec(`update public.firmaer set intro_procent = null, intro_maaneder = null, intro_fra = null where id = '${FIRMA}'`);
      expect((await firma()).intro_behold_gratis).toBe(false);
      // Kan ikke slås til uden en introrabat fra første betaling.
      await db.exec(`update public.firmaer set intro_behold_gratis = true where id = '${FIRMA}'`);
      expect((await firma()).intro_behold_gratis).toBe(false);
    });

    it("pakkeskift til Butik før Checkout: ingen gratis måned (Butik er aldrig gratis)", async () => {
      await nulstil();
      await introGem({ behold: true });
      await db.exec(`update public.firmaer set pakke_id = '${BUTIK}' where id = '${FIRMA}'`);
      expect(await maaned1()).toBe("ingen");
      await db.exec(`update public.firmaer set pakke_id = '${START}' where id = '${FIRMA}'`);
      expect(await maaned1()).toBe("gratis");
    });

    it("den gratis måned er givet (abonnementet startet): velkomstfordelen er brugt", async () => {
      await db.exec(`update public.firmaer set stripe_subscription_id = 'sub_y', stripe_abonnement_status = 'trialing', proeve_givet_kl = now() where id = '${FIRMA}'`);
      expect(await maaned1()).toBe("ingen");
      const ab = await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA]);
      expect(ab).toMatchObject({ maaned1: null, gratis_maaneder_ved_start: 0, introrabat: { behold_gratis: true } });
    });

    it("staff-givne gratis måneder oveni lægges til som før", async () => {
      await nulstil(`, proeve_ekstra_ventende = 1`);
      await introGem({ behold: true });
      const ab = await j(`select public.erhverv_firma_abonnement_json($1) j`, [FIRMA]);
      expect(ab).toMatchObject({ maaned1: "gratis", gratis_maaneder_ved_start: 2 });
    });
  });

  describe("Opret firmakonto (erhverv_firma_opret)", () => {
    it("Start + introrabat + valget: måned 1 gratis, logget med staffs navn og begrundelsen", async () => {
      const svar = await opret({ behold: true });
      expect(svar).toMatchObject({ kode: "ok", maaned1: "gratis", gratis_maaneder: 1, behold_gratis: true });
      const id = String(svar.firma_id);
      expect(await firma(id)).toMatchObject({ intro_procent: 50, intro_maaneder: 6, intro_fra: "efter_gratis", intro_status: "planlagt", intro_behold_gratis: true, proeve_maaneder: 1 });
      expect(await maaned1(id)).toBe("gratis");
      const log = await senesteLog(id);
      expect(log).toContain("første måned gratis og derefter introrabat 50 % i måned 2-7");
      expect(log).toContain("Ebbe Erhvervssælger");
      expect(log).toContain("Aftalt med Filip i telefonen");
    });

    it("gammelt kald uden valget: som før (introrabat = ingen gratis måned)", async () => {
      const svar = await opret({});
      expect(svar).toMatchObject({ kode: "ok", maaned1: "ingen", gratis_maaneder: 0, behold_gratis: false });
      expect((await firma(String(svar.firma_id))).intro_behold_gratis).toBe(false);
      expect(await senesteLog(String(svar.firma_id))).toContain("introrabat 50 % i måned 1-6 (ingen velkomstfordel oveni)");
    });

    it("afvisninger: Butik, uden introrabat, uden begrundelse", async () => {
      expect(await opret({ behold: true, pakke: BUTIK })).toEqual({ kode: "behold_kun_start" });
      expect(await opret({ behold: true, intro: false })).toEqual({ kode: "ugyldig_rabat" });
      expect(await opret({ behold: true, grund: "kort" })).toEqual({ kode: "behold_begrundelse" });
      expect(await opret({ behold: true, grund: null })).toEqual({ kode: "behold_begrundelse" });
    });

    it("tidligere CVR: uden særaftale intet at beholde; med særaftale tilladt", async () => {
      expect(await opret({ behold: true, cvr: TIDLIGERE_CVR, bekraeftet: true })).toEqual({ kode: "behold_ingen_gratis" });
      const svar = await opret({ behold: true, cvr: TIDLIGERE_CVR, bekraeftet: true, saeraftale: true });
      expect(svar).toMatchObject({ kode: "ok", maaned1: "gratis", saeraftale: true, behold_gratis: true });
      expect(await maaned1(String(svar.firma_id))).toBe("gratis");
    });
  });
});
