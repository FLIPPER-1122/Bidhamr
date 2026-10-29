// Migrationerne 20261102330000_firma_fakturaer.sql og
// 20261102390000_firma_fakturaer_rettelser.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubs af de tabeller,
// migrationerne bygger på, og de rigtige funktioner (erhverv_har_adgang,
// stand_normaliser). Hver migration køres TO gange (idempotent).
//
// Testes:
//   - kladden laves, når køberen betaler (og ikke før), én pr. handel
//   - INTET sendes automatisk: kun firma_faktura_send med firmaets egen
//     bruger sætter 'sendt' - ikke service role/cron (intet auth.uid()), ikke
//     en direkte UPDATE, ikke et andet firma, ikke køberen
//   - fortløbende numre uden huller pr. firma (også efter afviste forsøg,
//     dobbeltklik og kreditnotaer i samme serie), præfiks og cifre
//   - mangler købers adresse, kan kladden ikke sendes (og intet nummer bruges)
//   - købers oplysninger: MitID-navn, kontoadresse før checkout, rettelser
//   - en sendt faktura kan ikke ændres eller slettes; kreditnota modsat fortegn
//   - moms (netto/moms/total) og brugtmoms (ingen moms + teksten)
//   - momsordning pr. auktion låst efter bud/salg; standard låst på kladden
//   - indstillinger: nummer låst efter første afsendelse
//   - RLS: firmaet ser sine egne, køberen kun sendte til sig, andre intet;
//     chef via det loggede opslag
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { funktion, MIG } from "./prismodelStub";
import { huskelisteAfsnit, rettelseAfsnit } from "./huskelisteAfsnit";
import { beregnFaktura } from "@/lib/erhverv/firmaFaktura";

const MIGRATION = readFileSync(path.join(MIG, "20261102330000_firma_fakturaer.sql"), "utf8");
const RETTELSER = readFileSync(path.join(MIG, "20261102390000_firma_fakturaer_rettelser.sql"), "utf8");

const FIRMA_U = "00000000-0000-4000-8000-0000000000f1";
const FIRMA2_U = "00000000-0000-4000-8000-0000000000f2";
const KOEBER = "00000000-0000-4000-8000-0000000000a1";
const KOEBER2 = "00000000-0000-4000-8000-0000000000a2";
const FREMMED = "00000000-0000-4000-8000-0000000000a3";
const CHEF = "00000000-0000-4000-8000-0000000000c1";
const F1 = "00000000-0000-4000-8000-00000000f0a1";
const F2 = "00000000-0000-4000-8000-00000000f0b1";

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table auth.users (id uuid primary key, email text);
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table public.users (id uuid primary key, navn text, email text, fornavn text, efternavn text, adresse text,
  avatar_url text, rolle text not null default 'bruger', konto_type text default 'privat',
  konto_lukket_kl timestamptz, konto_slettet_kl timestamptz, suspenderet boolean not null default false, suspenderet_til timestamptz);
insert into public.users (id, navn, email, fornavn, efternavn, adresse, konto_type, rolle) values
  ('${FIRMA_U}', 'Alfa ApS', 'alfa@firma.dk', null, null, null, 'erhverv', 'bruger'),
  ('${FIRMA2_U}', 'Beta ApS', 'beta@firma.dk', null, null, null, 'erhverv', 'bruger'),
  ('${KOEBER}', 'kasper', 'kasper@koeber.dk', 'Kasper', 'Køber', 'Købervej 3, 4700 Næstved', 'privat', 'bruger'),
  ('${KOEBER2}', 'lise', 'lise@koeber.dk', 'Lise', 'Larsen', null, 'privat', 'bruger'),
  ('${FREMMED}', 'fremmed', 'f@x.dk', null, null, null, 'privat', 'bruger'),
  ('${CHEF}', 'Chef', 'chef@bidhamr.dk', null, null, null, 'privat', 'chef');
create table public.firmaer (id uuid primary key, bruger_id uuid not null unique references public.users(id),
  firmanavn text not null, cvr text not null, adresse text not null, postnummer text not null, bynavn text not null,
  telefon text not null, kontakt_email text not null, bruger_brugtmoms boolean not null default false,
  opdateret_kl timestamptz not null default now());
insert into public.firmaer values
  ('${F1}', '${FIRMA_U}', 'Alfa ApS', '12345678', 'Firmavej 1', '4700', 'Næstved', '+4511223344', 'alfa@firma.dk', false, now()),
  ('${F2}', '${FIRMA2_U}', 'Beta ApS', '87654321', 'Betavej 2', '8000', 'Aarhus C', '+4522334455', 'beta@firma.dk', true, now());
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid not null, titel text, stand text,
  erhverv boolean not null default false, vinder_id uuid, afsluttet_kl timestamptz, "nuværende_bud" numeric);
create table public.bids (id uuid primary key default gen_random_uuid(), auktion_id uuid not null);
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid, seller_id uuid not null, buyer_id uuid,
  amount numeric not null, created_at timestamptz not null default now(), sendt_kl timestamptz, received_at timestamptz,
  status text not null default 'betaling_modtaget');
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid not null unique, bud_oere bigint,
  betalt_kl timestamptz, refunderet_kl timestamptz, status text not null default 'betalt');
create table public.handel_levering (trade_id uuid primary key, maade text not null, modtager_navn text not null,
  modtager_adresse text, modtager_postnummer text, modtager_by text, modtager_email text);
create table public.mitid_verificeringer (id uuid primary key default gen_random_uuid(), bruger_id uuid not null,
  juridisk_navn text, status text not null default 'aktiv', verificeret_kl timestamptz not null default now());
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now());
-- staff_aal2_ok: styres af testen (to-trins-login er testet andetsteds).
create function public.staff_aal2_ok(p_maks_timer integer default 12) returns boolean language sql stable as
  $$ select coalesce(current_setting('test.aal2', true), '') = 'ja' $$;
`;

// JSON fra databasen (løst typet - testen tjekker værdierne).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}
async function som(bruger: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [bruger ?? ""]);
}
async function fejlkode(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return "ingen fejl";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

// Et salg: auktion, handel og (valgfrit) betaling.
async function salg(o: { saelger?: string; koeber?: string; bud?: number; titel?: string; stand?: string; betalt?: boolean; moms?: string | null; levering?: Record<string, string> } = {}) {
  const saelger = o.saelger ?? FIRMA_U;
  const a = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, titel, stand, erhverv, momsordning) values ($1, $2, $3, true, $4) returning id`,
    [saelger, o.titel ?? "Lampe", o.stand ?? "god", o.moms ?? null],
  );
  const t = await en<{ id: string }>(
    `insert into public.trades (auction_id, seller_id, buyer_id, amount) values ($1, $2, $3, $4) returning id`,
    [a.id, saelger, o.koeber ?? KOEBER, (o.bud ?? 10000) / 100],
  );
  if (o.levering) {
    await db.query(
      `insert into public.handel_levering (trade_id, maade, modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_email)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [t.id, o.levering.maade, o.levering.navn, o.levering.adresse ?? null, o.levering.post ?? null, o.levering.by ?? null, o.levering.email ?? null],
    );
  }
  await db.query(`insert into public.betalinger (trade_id, bud_oere, betalt_kl) values ($1, $2, $3)`, [
    t.id,
    o.bud ?? 10000,
    o.betalt === false ? null : new Date().toISOString(),
  ]);
  return { auktion: a.id, trade: t.id };
}

const KASPER_DOER = { maade: "doer", navn: "Kasper Køber", adresse: "Købervej 3", post: "4700", by: "Næstved", email: "kasper@koeber.dk" };

async function kladdeFor(trade: string): Promise<string> {
  return (await en<{ id: string }>(`select id from public.firma_fakturaer where trade_id = $1 and type = 'faktura'`, [trade])).id;
}

type SendSvar = { kode: string; fakturanummer?: string; mangler?: string[]; data?: Record<string, unknown> };
async function send(id: string, bruger: string | null = FIRMA_U): Promise<SendSvar> {
  await som(bruger);
  try {
    return (await en<{ r: SendSvar }>(`select public.firma_faktura_send($1) as r`, [id])).r;
  } finally {
    await som(null);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(funktion("20261010030000_erhverv.sql", "create or replace function public.erhverv_har_adgang"));
  await db.exec(funktion("20261006040000_auktionsfunktioner.sql", "create or replace function public.stand_normaliser"));
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(RETTELSER);
  await db.exec(RETTELSER);
});

describe("kladde ved betaling", () => {
  it("laves først, når køberen har betalt, og kun én pr. handel", async () => {
    const s = await salg({ betalt: false });
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where trade_id = $1`, [s.trade])).n).toBe(0);
    await db.query(`update public.betalinger set betalt_kl = now() where trade_id = $1`, [s.trade]);
    await db.query(`update public.betalinger set betalt_kl = now() + interval '1 second' where trade_id = $1`, [s.trade]);
    const r = await en<{ n: number; status: string }>(
      `select count(*)::int n, min(status) status from public.firma_fakturaer where trade_id = $1`,
      [s.trade],
    );
    expect(r).toEqual({ n: 1, status: "kladde" });
  });

  it("private sælgere får ingen kladde", async () => {
    const a = await en<{ id: string }>(`insert into public.auctions (bruger_id, titel) values ($1, 'x') returning id`, [KOEBER2]);
    const t = await en<{ id: string }>(`insert into public.trades (auction_id, seller_id, buyer_id, amount) values ($1, $2, $3, 50) returning id`, [a.id, KOEBER2, KOEBER]);
    await db.query(`insert into public.betalinger (trade_id, bud_oere, betalt_kl) values ($1, 5000, now())`, [t.id]);
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where trade_id = $1`, [t.id])).n).toBe(0);
  });
});

describe("købers oplysninger og moms", () => {
  it("MitID-navn, checkout-adresse, moms 25 % og total - også pr. linje", async () => {
    await db.query(`insert into public.mitid_verificeringer (bruger_id, juridisk_navn) values ($1, 'Kasper Juridisk Køber')`, [KOEBER]);
    const s = await salg({
      bud: 12345,
      titel: "Kommode",
      stand: "ny_med_maerke",
      levering: { maade: "doer", navn: "K. Køber", adresse: "Checkoutvej 9", post: "2100", by: "København Ø", email: "levering@koeber.dk" },
    });
    const d = (await en<{ d: Json }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s.trade)])).d;
    // Uden kontoadresse (bruger_adresser) bruges checkout. users.adresse bruges aldrig.
    expect(d.koeber).toMatchObject({ navn: "Kasper Juridisk Køber", adresse: "Checkoutvej 9", postnummer: "2100", by: "København Ø", email: "levering@koeber.dk" });
    expect(d.linjer[0].tekst).toBe("Kommode (stand: ny med mærke)");
    expect(d.momsordning).toBe("moms");
    expect(d.total_oere).toBe(12345);
    expect(d.beloeb_ekskl_moms_oere).toBe(9876);
    expect(d.moms_oere).toBe(2469);
    expect(d.moms_sats).toBe(25);
    expect(d.brugtmoms_tekst).toBeNull();
    expect(d.mangler).toEqual([]);
    // § 58, stk. 1: enhedspris og beløb ekskl. moms, momssats og beløb inkl. moms pr. linje.
    expect(d.linjer[0]).toMatchObject({
      antal: 1,
      enhedspris_ekskl_moms_oere: 9876,
      netto_oere: 9876,
      moms_sats: 25,
      moms_oere: 2469,
      enhedspris_oere: 12345,
      beloeb_oere: 12345,
    });
    expect(d.vare_stand).toBe("ny_med_maerke");
    // Samme regel i koden.
    expect(beregnFaktura([12345], "moms")).toMatchObject({ beloeb_ekskl_moms_oere: 9876, moms_oere: 2469, total_oere: 12345 });
  });

  it("uden kontoadresse bruges checkout; brugtmoms viser ingen moms, men teksten", async () => {
    const s = await salg({
      saelger: FIRMA2_U,
      koeber: KOEBER2,
      bud: 50000,
      levering: { maade: "doer", navn: "Lise Larsen", adresse: "Lisevej 2", post: "8000", by: "Aarhus C", email: "lise@koeber.dk" },
    });
    const d = (await en<{ d: Json }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s.trade)])).d;
    expect(d.koeber).toMatchObject({ navn: "Lise Larsen", adresse: "Lisevej 2", postnummer: "8000", by: "Aarhus C" });
    expect(d.momsordning).toBe("brugtmoms");
    expect(d.moms_oere).toBeNull();
    expect(d.beloeb_ekskl_moms_oere).toBeNull();
    expect(d.linjer[0].moms_oere).toBeNull();
    expect(d.linjer[0].enhedspris_ekskl_moms_oere).toBeNull();
    expect(d.linjer[0].moms_sats).toBeNull();
    expect(d.total_oere).toBe(50000);
    // Lovens ordlyd (momssystemdirektivets art. 226, nr. 14).
    expect(d.brugtmoms_tekst).toBe("Fortjenstmargenordning – brugte genstande");
    expect(d.brugtmoms_forklaring).toMatch(/brugtmomsordningen/);
  });

  it("auktionens momsordning overstyrer standarden og låses på kladden", async () => {
    const s = await salg({ moms: "brugtmoms" });
    const id = await kladdeFor(s.trade);
    expect((await en<{ m: string }>(`select momsordning m from public.firma_fakturaer where id = $1`, [id])).m).toBe("brugtmoms");
    // Standarden ændres bagefter: kladden følger ikke med.
    await db.query(`update public.firmaer set bruger_brugtmoms = true where id = $1`, [F1]);
    await db.query(`update public.firmaer set bruger_brugtmoms = false where id = $1`, [F1]);
    expect((await en<{ m: string }>(`select momsordning m from public.firma_fakturaer where id = $1`, [id])).m).toBe("brugtmoms");
    expect((await en<{ f: boolean }>(`select momsordning_fra_standard f from public.firma_fakturaer where id = $1`, [id])).f).toBe(false);
    // Browseren kan ikke skrive direkte (kun via RPC'en).
    await db.query(`set role authenticated`);
    await som(FIRMA_U);
    try {
      expect(await fejlkode(`update public.firma_fakturaer set momsordning = 'moms' where id = $1`, [id])).toBe("42501");
    } finally {
      await db.query(`reset role`);
      await som(null);
    }
  });
});

describe("afsendelse - kun firmaets eget tryk", () => {
  let k1: string;
  let k2: string;
  let k3: string;
  let uden: string;

  beforeAll(async () => {
    k1 = await kladdeFor((await salg({ bud: 10000, levering: KASPER_DOER })).trade);
    k2 = await kladdeFor((await salg({ bud: 20000, levering: KASPER_DOER })).trade);
    k3 = await kladdeFor((await salg({ bud: 30000, levering: KASPER_DOER })).trade);
    // Køber uden adresse nogen steder.
    uden = await kladdeFor((await salg({ koeber: KOEBER2, bud: 4000 })).trade);
  });

  it("service role / cron (intet auth.uid()) kan ikke sende", async () => {
    expect(await fejlkode(`select public.firma_faktura_send($1)`, [k1])).toBe("42501");
  });

  it("en direkte UPDATE til 'sendt' afvises - også med alle felter udfyldt", async () => {
    expect(
      await fejlkode(
        `update public.firma_fakturaer set status = 'sendt', nummer = 999, fakturanummer = 'X', udstedt_dato = current_date,
           data = '{}'::jsonb, sendt_kl = now(), sendt_af = $2 where id = $1`,
        [k1, FIRMA_U],
      ),
    ).toBe("42501");
    await som(FIRMA_U);
    expect(
      await fejlkode(
        `update public.firma_fakturaer set status = 'sendt', nummer = 999, fakturanummer = 'X', udstedt_dato = current_date,
           data = '{}'::jsonb, sendt_kl = now(), sendt_af = $2 where id = $1`,
        [k1, FIRMA_U],
      ),
    ).toBe("42501");
    await som(null);
    expect(await fejlkode(`insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, status, momsordning)
      select firma_id, saelger_id, koeber_id, trade_id, 'sendt', momsordning from public.firma_fakturaer where id = $1`, [k1])).not.toBe("ingen fejl");
  });

  it("et andet firma og køberen kan ikke sende", async () => {
    await som(FIRMA2_U);
    expect(await fejlkode(`select public.firma_faktura_send($1)`, [k1])).toBe("42501");
    await som(KOEBER);
    expect(await fejlkode(`select public.firma_faktura_send($1)`, [k1])).toBe("42501");
    await som(null);
  });

  it("mangler adressen, er Send spærret, og intet nummer bruges", async () => {
    const r = await send(uden);
    expect(r.kode).toBe("mangler");
    expect(r.mangler).toEqual(expect.arrayContaining(["koeber_adresse", "koeber_postnummer", "koeber_by"]));
    expect((await en<{ s: string }>(`select status s from public.firma_fakturaer where id = $1`, [uden])).s).toBe("kladde");
  });

  it("fortløbende numre uden huller, dobbeltklik giver ikke nyt nummer", async () => {
    // Præfiks og cifre (før første afsendelse).
    await som(FIRMA_U);
    await db.query(`select public.firma_faktura_indstillinger_gem('BH-', 7, 4, 'moms', 'Betalt via BidHamr', '', true)`);
    await som(null);
    const a = await send(k1);
    const b = await send(k2);
    const igen = await send(k1);
    const c = await send(k3);
    expect([a.kode, b.kode, igen.kode, c.kode]).toEqual(["sendt", "sendt", "allerede_sendt", "sendt"]);
    expect([a.fakturanummer, b.fakturanummer, igen.fakturanummer, c.fakturanummer]).toEqual(["BH-0007", "BH-0008", "BH-0007", "BH-0009"]);
    const numre = (await db.query<{ nummer: number }>(`select nummer from public.firma_fakturaer where firma_id = $1 and nummer is not null order by nummer`, [F1])).rows.map((r) => r.nummer);
    expect(numre).toEqual([7, 8, 9]);
    const r = await en<{ status: string; sendt_af: string; data: Json }>(`select status, sendt_af, data from public.firma_fakturaer where id = $1`, [k1]);
    expect(r.status).toBe("sendt");
    expect(r.sendt_af).toBe(FIRMA_U);
    expect(r.data.fakturanummer).toBe("BH-0007");
    expect(r.data.saelger).toMatchObject({ firmanavn: "Alfa ApS", cvr: "12345678", adresse: "Firmavej 1", postnummer: "4700", by: "Næstved" });
  });

  it("udfylder firmaet adressen, kan kladden sendes og får næste nummer", async () => {
    await som(FIRMA_U);
    await db.query(`select public.firma_faktura_kladde_gem($1, null, 'Lisevej 2', '8000', 'Aarhus C', null, 'Lises Firma ApS', '11223344', null, null)`, [uden]);
    await som(null);
    const r = await send(uden);
    expect(r.kode).toBe("sendt");
    expect(r.fakturanummer).toBe("BH-0010");
    expect((r.data as Json).koeber).toMatchObject({ navn: "Lise Larsen", adresse: "Lisevej 2", firmanavn: "Lises Firma ApS", cvr: "11223344" });
  });

  it("en sendt faktura kan ikke ændres eller slettes", async () => {
    expect(await fejlkode(`update public.firma_fakturaer set koeber_navn = 'Snyd' where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`update public.firma_fakturaer set data = data || '{"total_oere": 1}' where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`update public.firma_fakturaer set status = 'kladde', nummer = null where id = $1`, [k1])).not.toBe("ingen fejl");
    expect(await fejlkode(`delete from public.firma_fakturaer where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`delete from public.firma_fakturaer where id = $1`, [uden])).toBe("42501");
    // Afvises (triggeren og fremmednøglen fra firma_faktura_log).
    expect(await fejlkode(`truncate public.firma_fakturaer`)).not.toBe("ingen fejl");
    await som(FIRMA_U);
    expect(await fejlkode(`select public.firma_faktura_kladde_gem($1, 'Snyd', null, null, null, null, null, null, null, null)`, [k1])).toBe("BHF10");
    await som(null);
    // Kun PDF-stien (én gang) og mailstatus må skrives bagefter (service role).
    expect((await en<{ r: boolean }>(`select public.firma_faktura_gem_pdf($1, 'a/b.pdf') r`, [k1])).r).toBe(true);
    expect((await en<{ r: boolean }>(`select public.firma_faktura_gem_pdf($1, 'c/d.pdf') r`, [k1])).r).toBe(false);
    expect(await fejlkode(`update public.firma_fakturaer set pdf_sti = 'x.pdf' where id = $1`, [k1])).toBe("42501");
    expect((await en<{ r: boolean }>(`select public.firma_faktura_mail_resultat($1, true, null) r`, [k1])).r).toBe(true);
    expect((await en<{ s: string }>(`select status s from public.firma_fakturaer where id = $1`, [k1])).s).toBe("sendt");
  });

  it("kreditnota: samme serie, modsat fortegn, refererer til fakturaen", async () => {
    await som(FIRMA_U);
    const kid = (await en<{ id: string }>(`select public.firma_kreditnota_opret($1) id`, [k2])).id;
    const igen = (await en<{ id: string }>(`select public.firma_kreditnota_opret($1) id`, [k2])).id;
    expect(igen).toBe(kid);
    // Kreditnota på en kladde afvises.
    expect(await fejlkode(`select public.firma_kreditnota_opret($1)`, [kid])).toBe("22023");
    await som(null);
    const r = await send(kid);
    expect(r.kode).toBe("sendt");
    expect(r.fakturanummer).toBe("BH-0011");
    const d = r.data as Json;
    expect(d.type).toBe("kreditnota");
    expect(d.krediterer.fakturanummer).toBe("BH-0008");
    expect(d.total_oere).toBe(-20000);
    expect(d.moms_oere).toBe(-4000);
    expect(d.beloeb_ekskl_moms_oere).toBe(-16000);
    expect(d.koeber.navn).toBe("Kasper Juridisk Køber");
  });

  it("nummerserien er låst efter første afsendelse; momsordning m.m. kan stadig ændres", async () => {
    await som(FIRMA_U);
    expect(await fejlkode(`select public.firma_faktura_indstillinger_gem('NY-', 1, 4, 'moms', 'Betalt', '', true)`)).toBe("BHF11");
    expect(await fejlkode(`select public.firma_faktura_indstillinger_gem('BH-', 12, 4, 'brugtmoms', 'Betalt via BidHamr', 'svar@alfa.dk', false)`)).toBe("ingen fejl");
    await som(null);
    expect((await en<{ b: boolean }>(`select bruger_brugtmoms b from public.firmaer where id = $1`, [F1])).b).toBe(true);
    // Hvert firma har sin egen serie.
    const beta = await kladdeFor((await salg({ saelger: FIRMA2_U, levering: { maade: "doer", navn: "K", adresse: "V 1", post: "1000", by: "Kbh", email: "k@k.dk" } })).trade);
    const r = await send(beta, FIRMA2_U);
    expect(r.fakturanummer).toBe("F-0001");
  });

  it("refunderet eller annulleret køb kan ikke faktureres, og købers adresse vises ikke", async () => {
    const s = await salg({ levering: KASPER_DOER });
    await db.query(`update public.betalinger set refunderet_kl = now() where trade_id = $1`, [s.trade]);
    const id = await kladdeFor(s.trade);
    const r = await send(id);
    expect(r.kode).toBe("mangler");
    expect(r.mangler).toContain("refunderet");
    // Heller ikke firmaets egne rettelser af adressen.
    await som(FIRMA_U);
    await db.query(`select public.firma_faktura_kladde_gem($1, null, 'Rettetvej 1', '1000', 'Kbh', null, null, null, null, null)`, [id]);
    await som(null);
    const d = (await en<{ d: Json }>(`select public.firma_faktura_byg($1) d`, [id])).d;
    expect(d.koeber).toMatchObject({ adresse: null, postnummer: null, by: null });
    const auto = (await en<{ a: Json }>(`select public.firma_faktura_koeber_auto($1) a`, [s.trade])).a;
    expect(auto).toMatchObject({ adresse: null, adresse_kilde: "skjult" });

    const s2 = await salg({ levering: KASPER_DOER });
    await db.query(`update public.trades set status = 'annulleret' where id = $1`, [s2.trade]);
    const d2 = (await en<{ d: Json }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s2.trade)])).d;
    expect(d2.koeber.adresse).toBeNull();
    expect(d2.mangler).toContain("refunderet");
  });
});

describe("kontoadressen (bruger_adresser, 20261102340000)", () => {
  // Testene ovenfor kører UDEN tabellen (som før 20261102340000): så bruges
  // checkout og users.adresse. Nu kommer tabellen.
  beforeAll(async () => {
    await db.exec(`create table public.bruger_adresser (bruger_id uuid primary key references public.users(id),
      adresse text not null, postnummer text not null, bynavn text not null)`);
  });

  it("kontoens adresse går forud for checkout", async () => {
    await db.query(`insert into public.bruger_adresser values ($1, 'Kontovej 5', '5000', 'Odense C')`, [KOEBER]);
    const s = await salg({ levering: { maade: "doer", navn: "K", adresse: "Checkoutvej 9", post: "2100", by: "København Ø", email: "k@k.dk" } });
    const d = (await en<{ d: Json }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s.trade)])).d;
    expect(d.koeber).toMatchObject({ adresse: "Kontovej 5", postnummer: "5000", by: "Odense C" });
    const auto = (await en<{ a: Record<string, string> }>(`select public.firma_faktura_koeber_auto($1) a`, [s.trade])).a;
    expect(auto.adresse_kilde).toBe("konto");
  });

  it("uden række i bruger_adresser: checkout, ellers kladde med spærret Send - users.adresse bruges ikke", async () => {
    const s1 = await salg({ koeber: KOEBER2, levering: { maade: "doer", navn: "Lise", adresse: "Lisevej 2", post: "8000", by: "Aarhus C", email: "l@l.dk" } });
    expect((await en<{ a: Record<string, string> }>(`select public.firma_faktura_koeber_auto($1) a`, [s1.trade])).a).toMatchObject({ adresse: "Lisevej 2", adresse_kilde: "checkout" });
    await db.query(`update public.users set adresse = 'Fritekstvej 1, 9000 Aalborg' where id = $1`, [FREMMED]);
    const s2 = await salg({ koeber: FREMMED });
    expect((await en<{ a: Record<string, string | null> }>(`select public.firma_faktura_koeber_auto($1) a`, [s2.trade])).a).toMatchObject({ adresse: null, postnummer: null, by: null, adresse_kilde: null });
    const s3 = await salg({ koeber: KOEBER2 });
    const k3 = await kladdeFor(s3.trade);
    expect((await send(k3)).kode).toBe("mangler");
  });
});

describe("momsordning pr. auktion", () => {
  it("firmaet kan sætte den før bud, ikke efter bud eller salg; private nulstilles", async () => {
    const a = (await en<{ id: string }>(`insert into public.auctions (bruger_id, titel, erhverv) values ($1, 'x', true) returning id`, [FIRMA_U])).id;
    await som(FIRMA_U);
    expect((await en<{ m: string }>(`select public.firma_saet_auktion_momsordning($1, 'brugtmoms') m`, [a])).m).toBe("brugtmoms");
    await som(FIRMA2_U);
    expect(await fejlkode(`select public.firma_saet_auktion_momsordning($1, 'moms')`, [a])).toBe("42501");
    await som(FIRMA_U);
    await db.query(`insert into public.bids (auktion_id) values ($1)`, [a]);
    expect(await fejlkode(`select public.firma_saet_auktion_momsordning($1, 'moms')`, [a])).toBe("BHM01");
    await som(null);
    // Også en direkte UPDATE er låst, så snart der er budt (triggeren).
    expect(await fejlkode(`update public.auctions set momsordning = 'moms' where id = $1`, [a])).toBe("BHM01");
    await db.query(`insert into public.trades (auction_id, seller_id, buyer_id, amount) values ($1, $2, $3, 10)`, [a, FIRMA_U, KOEBER]);
    expect(await fejlkode(`update public.auctions set momsordning = 'moms' where id = $1`, [a])).toBe("BHM01");
    const p = (await en<{ m: string | null }>(`insert into public.auctions (bruger_id, titel, erhverv, momsordning) values ($1, 'p', false, 'moms') returning momsordning m`, [KOEBER])).m;
    expect(p).toBeNull();
  });
});

describe("RLS og chef", () => {
  async function antal(bruger: string, hvor = "true"): Promise<number> {
    await db.query(`set role authenticated`);
    try {
      await som(bruger);
      return (await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where ${hvor}`)).n;
    } finally {
      await db.query(`reset role`);
      await som(null);
    }
  }

  it("firmaet ser alle sine egne, køberen kun sendte til sig, andre intet", async () => {
    const egne = (await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where saelger_id = $1`, [FIRMA_U])).n;
    const sendteTilKasper = (await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where koeber_id = $1 and status = 'sendt'`, [KOEBER])).n;
    expect(egne).toBeGreaterThan(3);
    expect(await antal(FIRMA_U)).toBe(egne);
    expect(await antal(FIRMA2_U, `saelger_id = '${FIRMA_U}'`)).toBe(0);
    expect(await antal(KOEBER)).toBe(sendteTilKasper);
    expect(await antal(KOEBER, "status = 'kladde'")).toBe(0);
    expect(await antal(FREMMED)).toBe(0);
  });

  it("authenticated kan ikke skrive direkte eller kalde de interne funktioner", async () => {
    await db.query(`set role authenticated`);
    try {
      await som(FIRMA_U);
      expect(await fejlkode(`update public.firma_fakturaer set koeber_navn = 'x'`)).toBe("42501");
      expect(await fejlkode(`select public.firma_faktura_byg(gen_random_uuid())`)).toBe("42501");
      expect(await fejlkode(`select public.firma_faktura_gem_pdf(gen_random_uuid(), 'x')`)).toBe("42501");
      expect(await fejlkode(`select public.firma_faktura_koeber_auto(gen_random_uuid())`)).toBe("42501");
      expect(await fejlkode(`select * from public.firma_faktura_indstillinger`)).toBe("42501");
    } finally {
      await db.query(`reset role`);
      await som(null);
    }
  });

  it("chefen ser et firmas fakturaer via det loggede opslag (kræver to-trins-login)", async () => {
    await som(CHEF);
    expect(await fejlkode(`select public.admin_firma_fakturaer($1)`, [F1])).toBe("42501");
    await db.query(`select set_config('test.aal2', 'ja', false)`);
    const r = (await en<{ r: unknown[] }>(`select public.admin_firma_fakturaer($1) r`, [F1])).r;
    expect(r.length).toBeGreaterThan(3);
    await som(FREMMED);
    expect(await fejlkode(`select public.admin_firma_fakturaer($1)`, [F1])).toBe("42501");
    await som(null);
    await db.query(`select set_config('test.aal2', '', false)`);
    expect((await en<{ n: number }>(`select count(*)::int n from public.moderation_log where handling = 'firma_faktura_opslag' and medarbejder_id = $1`, [CHEF])).n).toBe(1);
  });

  it("køberen kan oplyse firmanavn og CVR, kun på sin egen kladde", async () => {
    const s = await salg();
    await som(KOEBER);
    expect((await en<{ r: { ok: boolean } }>(`select public.koeber_faktura_firma_gem($1, 'Kaspers ApS', '1234 5678') r`, [s.trade])).r.ok).toBe(true);
    expect(await fejlkode(`select public.koeber_faktura_firma_gem($1, 'Kaspers ApS', '123')`, [s.trade])).toBe("22023");
    await som(FREMMED);
    expect((await en<{ r: { ok: boolean; kode: string } }>(`select public.koeber_faktura_firma_gem($1, 'X', '11111111') r`, [s.trade])).r).toEqual({ ok: false, kode: "ingen_faktura" });
    await som(null);
    const k = await en<{ f: string; c: string }>(`select koeber_firmanavn f, koeber_cvr c from public.firma_fakturaer where trade_id = $1`, [s.trade]);
    expect(k).toEqual({ f: "Kaspers ApS", c: "12345678" });
  });
});

// ---------------------------------------------------------------------------
// 20261102390000_firma_fakturaer_rettelser.sql
// ---------------------------------------------------------------------------
async function somKald<T>(bruger: string | null, sql: string, params: unknown[] = []): Promise<T> {
  await som(bruger);
  try {
    return await en<T>(sql, params);
  } finally {
    await som(null);
  }
}
async function fejlSom(bruger: string | null, sql: string, params: unknown[] = []): Promise<string> {
  await som(bruger);
  try {
    return await fejlkode(sql, params);
  } finally {
    await som(null);
  }
}
async function antalSendte(): Promise<number> {
  return (await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where status = 'sendt'`)).n;
}

describe("momsordning på kladden (kun mens den er kladde)", () => {
  it("firmaet kan skifte på en kladde - ikke efter afsendelse, ikke på en kreditnota, ikke andre", async () => {
    const s = await salg({ levering: KASPER_DOER, bud: 10000 });
    const id = await kladdeFor(s.trade);
    // Start fra almindelig moms (standarden kan være brugtmoms her).
    await db.query(`update public.firma_fakturaer set momsordning = 'moms' where id = $1`, [id]);
    const d = (await somKald<{ d: Json }>(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms') d`, [id])).d;
    expect(d.momsordning).toBe("brugtmoms");
    expect(d.moms_oere).toBeNull();
    expect(d.linjer[0].netto_oere).toBeNull();
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_faktura_log where faktura_id = $1 and handling = 'momsordning'`, [id])).n).toBe(1);
    // Tilbage til moms: tallene pr. linje kommer igen.
    const d2 = (await somKald<{ d: Json }>(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'moms') d`, [id])).d;
    expect(d2.linjer[0]).toMatchObject({ enhedspris_ekskl_moms_oere: 8000, netto_oere: 8000, moms_sats: 25, moms_oere: 2000, beloeb_oere: 10000 });

    expect(await fejlSom(FIRMA2_U, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms')`, [id])).toBe("42501");
    expect(await fejlSom(KOEBER, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms')`, [id])).toBe("42501");
    expect(await fejlSom(null, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms')`, [id])).toBe("42501");
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'nul')`, [id])).toBe("22023");

    await somKald(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms')`, [id]);
    expect((await send(id)).kode).toBe("sendt");
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'moms')`, [id])).toBe("BHF10");
    expect(await fejlkode(`update public.firma_fakturaer set momsordning = 'moms' where id = $1`, [id])).toBe("42501");

    // Kreditnotaen arver fakturaens momsordning og kan ikke skifte.
    const kid = (await somKald<{ id: string }>(FIRMA_U, `select public.firma_kreditnota_opret($1) id`, [id])).id;
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'moms')`, [kid])).toBe("22023");
    expect(await fejlkode(`update public.firma_fakturaer set momsordning = 'moms' where id = $1`, [kid])).toBe("42501");
    const k = await send(kid);
    expect(k.kode).toBe("sendt");
    expect((k.data as Json).momsordning).toBe("brugtmoms");
    expect((k.data as Json).total_oere).toBe(-10000);
  });

  it("kladder uden eget valg følger firmaets aktuelle standard - også backfill-kladder", async () => {
    // Lav en kladde, mens standarden er 'moms'.
    await db.query(`update public.firmaer set bruger_brugtmoms = false where id = $1`, [F1]);
    expect((await en<{ m: string }>(`select momsordning m from public.firma_faktura_indstillinger where firma_id = $1`, [F1])).m).toBe("moms");
    const foelger = await kladdeFor((await salg({ levering: KASPER_DOER })).trade);
    const valgt = await kladdeFor((await salg({ levering: KASPER_DOER })).trade);
    await somKald(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'moms')`, [valgt]);
    expect((await en<{ f: boolean }>(`select momsordning_fra_standard f from public.firma_fakturaer where id = $1`, [foelger])).f).toBe(true);
    // Firmaet vælger brugtmoms (Firmaoplysninger eller Fakturaer -> Indstillinger).
    await db.query(`update public.firmaer set bruger_brugtmoms = true where id = $1`, [F1]);
    const m = async (id: string) => (await en<{ m: string }>(`select momsordning m from public.firma_fakturaer where id = $1`, [id])).m;
    expect(await m(foelger)).toBe("brugtmoms");
    expect(await m(valgt)).toBe("moms");
    await db.query(`update public.firmaer set bruger_brugtmoms = false where id = $1`, [F1]);
    expect(await m(foelger)).toBe("moms");
    // Sendte fakturaer følger aldrig med.
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where status = 'sendt' and momsordning_fra_standard and data->>'momsordning' <> momsordning`)).n).toBe(0);
  });
});

describe("ny faktura efter kreditnota (kreditnota + ny faktura)", () => {
  let trade: string;
  let foerste: string;

  beforeAll(async () => {
    trade = (await salg({ levering: KASPER_DOER, bud: 25000 })).trade;
    foerste = await kladdeFor(trade);
    expect((await send(foerste)).kode).toBe("sendt");
  });

  it("kan først laves, når kreditnotaen er sendt - og laves aldrig af sig selv", async () => {
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_ny($1, 'moms')`, [trade])).toBe("22023");
    const kid = (await somKald<{ id: string }>(FIRMA_U, `select public.firma_kreditnota_opret($1) id`, [foerste])).id;
    // Kreditnota som kladde: stadig ikke.
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_ny($1, 'moms')`, [trade])).toBe("22023");
    expect((await send(kid)).kode).toBe("sendt");
    expect((await en<{ k: string | null }>(`select krediteret_kl k from public.firma_fakturaer where id = $1`, [foerste])).k).not.toBeNull();
    // At åbne fakturalisten (og betalingstriggeren) laver IKKE en ny faktura.
    await somKald(FIRMA_U, `select public.firma_fakturaer_liste() l`);
    await db.query(`update public.betalinger set betalt_kl = now() where trade_id = $1`, [trade]);
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where trade_id = $1 and type = 'faktura'`, [trade])).n).toBe(1);
    // "Lav ny faktura" står ved den krediterede faktura.
    const r = (await somKald<{ r: Json }>(FIRMA_U, `select public.firma_faktura_hent($1) r`, [foerste])).r;
    expect(r.kan_lave_ny).toBe(true);
    expect(r.ny_faktura_id).toBeNull();
  });

  it("firmaet laver den selv, vælger momsordning, og den får næste nummer", async () => {
    expect(await fejlSom(KOEBER, `select public.firma_faktura_ny($1, 'moms')`, [trade])).toBe("42501");
    expect(await fejlSom(FIRMA2_U, `select public.firma_faktura_ny($1, 'moms')`, [trade])).toBe("42501");
    expect(await fejlSom(null, `select public.firma_faktura_ny($1, 'moms')`, [trade])).toBe("42501");
    const ny = (await somKald<{ id: string }>(FIRMA_U, `select public.firma_faktura_ny($1, 'brugtmoms') id`, [trade])).id;
    const igen = (await somKald<{ id: string }>(FIRMA_U, `select public.firma_faktura_ny($1, 'moms') id`, [trade])).id;
    expect(igen).toBe(ny);
    const raekke = await en<{ status: string; momsordning: string; f: boolean }>(
      `select status, momsordning, momsordning_fra_standard f from public.firma_fakturaer where id = $1`,
      [ny],
    );
    expect(raekke).toEqual({ status: "kladde", momsordning: "brugtmoms", f: false });
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_faktura_log where faktura_id = $1 and handling = 'ny_faktura'`, [ny])).n).toBe(1);
    // Én ikke-krediteret faktura pr. handel.
    expect(
      await fejlkode(
        `insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, type, status, momsordning)
         values ($1, $2, $3, $4, 'faktura', 'kladde', 'moms')`,
        [F1, FIRMA_U, KOEBER, trade],
      ),
    ).toBe("23505");
    const foer = (await en<{ n: number }>(`select naeste_nummer n from public.firma_faktura_indstillinger where firma_id = $1`, [F1])).n;
    const r = await send(ny);
    expect(r.kode).toBe("sendt");
    expect((r.data as Json).nummer).toBe(foer);
    expect((r.data as Json).brugtmoms_tekst).toBe("Fortjenstmargenordning – brugte genstande");
    const gl = (await somKald<{ r: Json }>(FIRMA_U, `select public.firma_faktura_hent($1) r`, [foerste])).r;
    expect(gl.ny_faktura_id).toBe(ny);
    expect(gl.kan_lave_ny).toBe(false);
  });

  it("refunderet handel: ingen ny faktura", async () => {
    const s = await salg({ levering: KASPER_DOER });
    const id = await kladdeFor(s.trade);
    expect((await send(id)).kode).toBe("sendt");
    const kid = (await somKald<{ id: string }>(FIRMA_U, `select public.firma_kreditnota_opret($1) id`, [id])).id;
    expect((await send(kid)).kode).toBe("sendt");
    await db.query(`update public.betalinger set refunderet_kl = now(), status = 'refunderet' where trade_id = $1`, [s.trade]);
    expect(await fejlSom(FIRMA_U, `select public.firma_faktura_ny($1, null)`, [s.trade])).toBe("22023");
    expect((await somKald<{ r: Json }>(FIRMA_U, `select public.firma_faktura_hent($1) r`, [id])).r.kan_lave_ny).toBe(false);
  });
});

describe("mangler tjekkes igen efter låsen", () => {
  it("ændres købers adresse, mens Send venter på låsen, rulles alt tilbage - også nummeret", async () => {
    const s = await salg({ saelger: FIRMA2_U, koeber: KOEBER2, levering: { maade: "doer", navn: "Lise Larsen", adresse: "Lisevej 2", post: "8000", by: "Aarhus C", email: "lise@koeber.dk" } });
    const id = await kladdeFor(s.trade);
    const foer = (await en<{ n: number }>(`select naeste_nummer n from public.firma_faktura_indstillinger where firma_id = $1`, [F2])).n;
    // Simulér en samtidig ændring: lige når nummeret er taget (efter låsen),
    // forsvinder adressen fra checkout.
    await db.exec(`
      create function public.test_fjern_adresse() returns trigger language plpgsql as $$
      begin
        update public.handel_levering set modtager_adresse = null
         where trade_id = nullif(current_setting('test.trade', true), '')::uuid;
        return null;
      end $$;
      create trigger test_fjern_adresse after update on public.firma_faktura_indstillinger
        for each row execute function public.test_fjern_adresse();`);
    await db.query(`select set_config('test.trade', $1, false)`, [s.trade]);
    try {
      expect(await fejlSom(FIRMA2_U, `select public.firma_faktura_send($1)`, [id])).toBe("BHF12");
    } finally {
      await db.exec(`drop trigger test_fjern_adresse on public.firma_faktura_indstillinger; drop function public.test_fjern_adresse();`);
      await db.query(`select set_config('test.trade', '', false)`);
    }
    const r = await en<{ status: string; nummer: number | null }>(`select status, nummer from public.firma_fakturaer where id = $1`, [id]);
    expect(r).toEqual({ status: "kladde", nummer: null });
    expect((await en<{ n: number }>(`select naeste_nummer n from public.firma_faktura_indstillinger where firma_id = $1`, [F2])).n).toBe(foer);
    // Også ændringen fra den "samtidige" handling blev rullet tilbage, så adressen er der igen.
    expect((await send(id, FIRMA2_U)).kode).toBe("sendt");
  });
});

describe("modtager-e-mail, der afviger fra købers", () => {
  it("logges og vises", async () => {
    const s = await salg({ levering: KASPER_DOER });
    const id = await kladdeFor(s.trade);
    await somKald(FIRMA_U, `select public.firma_faktura_kladde_gem($1, null, null, null, null, 'Anden@Firma.dk', null, null, null, null) r`, [id]);
    const log = (await db.query<{ gammel: string; ny: string; bruger_id: string }>(
      `select gammel, ny, bruger_id from public.firma_faktura_log where faktura_id = $1 and handling = 'email_afviger'`,
      [id],
    )).rows;
    expect(log).toEqual([{ gammel: "kasper@koeber.dk", ny: "anden@firma.dk", bruger_id: FIRMA_U }]);
    expect((await somKald<{ r: Json }>(FIRMA_U, `select public.firma_faktura_hent($1) r`, [id])).r.email_afviger).toBe(true);
    // Købers egen e-mail (anden skrivemåde) logges ikke og afviger ikke.
    await somKald(FIRMA_U, `select public.firma_faktura_kladde_gem($1, null, null, null, null, 'KASPER@koeber.dk', null, null, null, null) r`, [id]);
    expect((await en<{ n: number }>(`select count(*)::int n from public.firma_faktura_log where faktura_id = $1`, [id])).n).toBe(1);
    expect((await somKald<{ r: Json }>(FIRMA_U, `select public.firma_faktura_hent($1) r`, [id])).r.email_afviger).toBe(false);
    // Loggen kan ikke ændres eller slettes.
    expect(await fejlkode(`delete from public.firma_faktura_log where faktura_id = $1`, [id])).toBe("42501");
  });
});

describe("intet sendes automatisk", () => {
  it("betaling, fakturalisten, ny faktura, momsskift og standardskift sender aldrig", async () => {
    const foer = await antalSendte();
    const s = await salg({ levering: KASPER_DOER });
    const id = await kladdeFor(s.trade);
    await somKald(FIRMA_U, `select public.firma_fakturaer_liste() l`);
    await somKald(FIRMA_U, `select public.firma_faktura_kladde_momsordning($1, 'brugtmoms') r`, [id]);
    await somKald(FIRMA_U, `select public.firma_faktura_kladde_gem($1, 'Kasper', null, null, null, null, null, null, null, null) r`, [id]);
    await db.query(`update public.firmaer set bruger_brugtmoms = true where id = $1`, [F1]);
    await db.query(`update public.firmaer set bruger_brugtmoms = false where id = $1`, [F1]);
    await db.query(`select public.firma_faktura_opret_kladder($1)`, [F1]);
    expect(await antalSendte()).toBe(foer);
    expect((await en<{ s: string }>(`select status s from public.firma_fakturaer where id = $1`, [id])).s).toBe("kladde");
    // Uden indlogget firma (service role/cron) kan intet sendes.
    expect(await fejlSom(null, `select public.firma_faktura_send($1)`, [id])).toBe("42501");
    expect(await antalSendte()).toBe(foer);
  });

  it("en lukket firmakonto kan se og eksportere, men ikke sende, rette eller lave nyt", async () => {
    await db.query(`update public.users set konto_lukket_kl = now() where id = $1`, [FIRMA2_U]);
    try {
      const l = (await somKald<{ l: Json }>(FIRMA2_U, `select public.firma_fakturaer_liste() l`)).l;
      expect(l.indstillinger.kun_laes).toBe(true);
      const sendt = l.fakturaer.find((f: Json) => f.status === "sendt");
      const kladde = l.fakturaer.find((f: Json) => f.status === "kladde");
      expect(sendt).toBeTruthy();
      expect((await somKald<{ r: Json }>(FIRMA2_U, `select public.firma_faktura_hent($1) r`, [sendt.id])).r.kun_laes).toBe(true);
      const eks = (await somKald<{ e: Json[] }>(FIRMA2_U, `select public.firma_fakturaer_eksport('2020-01-01', '2100-01-01') e`)).e;
      expect(eks.length).toBeGreaterThan(0);
      if (kladde) {
        expect(await fejlSom(FIRMA2_U, `select public.firma_faktura_send($1)`, [kladde.id])).toBe("42501");
        expect(await fejlSom(FIRMA2_U, `select public.firma_faktura_kladde_momsordning($1, 'moms')`, [kladde.id])).toBe("42501");
      }
      expect(await fejlSom(FIRMA2_U, `select public.firma_kreditnota_opret($1)`, [sendt.id])).toBe("42501");
    } finally {
      await db.query(`update public.users set konto_lukket_kl = null where id = $1`, [FIRMA2_U]);
    }
  });
});

describe("eksport uden loft (side for side)", () => {
  it("henter alle sendte i nummerorden, side for side", async () => {
    const alle = (await en<{ n: number }>(`select count(*)::int n from public.firma_fakturaer where firma_id = $1 and status = 'sendt'`, [F1])).n;
    expect(alle).toBeGreaterThan(4);
    const numre: number[] = [];
    let efter = 0;
    for (;;) {
      const side = (await somKald<{ e: Json[] }>(FIRMA_U, `select public.firma_fakturaer_eksport('2020-01-01', '2100-01-01', $1, 2) e`, [efter])).e;
      if (side.length === 0) break;
      expect(side.length).toBeLessThanOrEqual(2);
      numre.push(...side.map((r: Json) => r.nummer));
      efter = side[side.length - 1].nummer;
    }
    expect(numre.length).toBe(alle);
    expect([...numre].sort((a, b) => a - b)).toEqual(numre);
    expect(await fejlSom(FREMMED, `select public.firma_fakturaer_eksport('2020-01-01', '2100-01-01')`)).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// 20261102410000 (afsnit "faktura"): låserækkefølge i send og lås på
// "Send mailen igen".
// ---------------------------------------------------------------------------
describe("20261102410000: låse", () => {
  let sendt: string;
  let kladde: string;

  beforeAll(async () => {
    const afsnit = huskelisteAfsnit("faktura");
    await db.exec(afsnit);
    await db.exec(afsnit); // idempotent
    sendt = await kladdeFor((await salg({ bud: 15000, levering: KASPER_DOER })).trade);
    kladde = await kladdeFor((await salg({ bud: 16000, levering: KASPER_DOER })).trade);
  });

  it("send låser firmaets indstillinger FØR fakturaen (samme rækkefølge som standard-momsordningen)", async () => {
    const def = (await en<{ d: string }>(`select pg_get_functiondef('public.firma_faktura_send(uuid)'::regprocedure) d`)).d;
    const indst = def.indexOf("from public.firma_faktura_indstillinger s where s.firma_id = v_firma for update");
    const faktura = def.indexOf("select * into x from public.firma_fakturaer f");
    expect(indst).toBeGreaterThan(0);
    expect(faktura).toBeGreaterThan(indst);
    // Ændring af standard-momsordningen låser også indstillinger -> kladder
    // (triggeren firma_faktura_indst_standard_synk).
    const synk = await en<{ n: number }>(
      `select count(*)::int n from pg_trigger where tgname = 'firma_faktura_indst_standard_synk' and tgrelid = 'public.firma_faktura_indstillinger'::regclass`,
    );
    expect(synk.n).toBe(1);
    // Send virker som før.
    const r = await send(sendt);
    expect(r.kode).toBe("sendt");
    expect((await send(sendt)).kode).toBe("allerede_sendt");
  });

  it("mail-låsen: kun ét forsøg ad gangen; sluppet igen efter forsøget; aldrig efter en sendt mail", async () => {
    const tag = async (id: string) => (await en<{ r: boolean }>(`select public.firma_faktura_mail_tag($1) r`, [id])).r;
    expect(await tag(kladde)).toBe(false); // ikke sendt
    expect(await tag(sendt)).toBe(true);
    // Et samtidigt tryk på "Send mailen igen" får ikke lov.
    expect(await tag(sendt)).toBe(false);
    // Forsøget fejlede (Resend nede): låsen slippes, og man kan prøve igen.
    expect((await en<{ r: boolean }>(`select public.firma_faktura_mail_resultat($1, false, 'Resend nede') r`, [sendt])).r).toBe(true);
    expect((await en<{ r: boolean }>(`select public.firma_faktura_mail_frigiv($1) r`, [sendt])).r).toBe(true);
    expect(await tag(sendt)).toBe(true);
    // En lås, der er udløbet (serveren døde), kan tages igen.
    await db.query(`update public.firma_faktura_mail_laas set laast_til = now() - interval '1 second' where faktura_id = $1`, [sendt]);
    expect(await tag(sendt)).toBe(true);
    // Mailen er sendt: ingen flere forsøg.
    await db.query(`select public.firma_faktura_mail_resultat($1, true, null)`, [sendt]);
    await db.query(`select public.firma_faktura_mail_frigiv($1)`, [sendt]);
    expect(await tag(sendt)).toBe(false);
    // Ukendt id.
    expect(await tag("00000000-0000-4000-8000-000000000999")).toBe(false);
  });

  it("kun service role", async () => {
    for (const rolle of ["authenticated", "anon"]) {
      await db.exec(`set role ${rolle}`);
      try {
        await som(FIRMA_U);
        expect(await fejlkode(`select public.firma_faktura_mail_tag($1)`, [sendt])).toBe("42501");
        expect(await fejlkode(`select public.firma_faktura_mail_frigiv($1)`, [sendt])).toBe("42501");
        expect(await fejlkode(`select * from public.firma_faktura_mail_laas`)).toBe("42501");
      } finally {
        await som(null);
        await db.exec(`reset role`);
      }
    }
  });

  it("md5-drift-tjek: en ændret firma_faktura_send stopper afsnittet", async () => {
    const d = new PGlite();
    await d.exec(STUB);
    await d.exec(funktion("20261010030000_erhverv.sql", "create or replace function public.erhverv_har_adgang"));
    await d.exec(funktion("20261006040000_auktionsfunktioner.sql", "create or replace function public.stand_normaliser"));
    await d.exec(MIGRATION);
    await d.exec(RETTELSER);
    const fn = (await d.query<{ def: string }>(`select pg_get_functiondef('public.firma_faktura_send(uuid)'::regprocedure) def`)).rows[0].def;
    await d.exec(fn.replace("'Fakturaen findes ikke.'", "'Ukendt faktura.'"));
    await expect(d.exec(huskelisteAfsnit("faktura"))).rejects.toThrow(/firma_faktura_send.*md5/);
    await d.close();
  });
});

// ---------------------------------------------------------------------------
// 20261102430000 (afsnit "faktura"): kun låsens ejer kan slippe mail-låsen.
// ---------------------------------------------------------------------------
describe("20261102430000: mail-låsens ejer", () => {
  const A = "00000000-0000-4000-8000-00000000aa01";
  const B = "00000000-0000-4000-8000-00000000aa02";
  let sendt: string;
  const tag = async (id: string, ejer: string | null) =>
    (await en<{ r: boolean }>(`select public.firma_faktura_mail_tag($1, $2) r`, [id, ejer])).r;
  const frigiv = async (id: string, ejer: string | null) =>
    (await en<{ r: boolean }>(`select public.firma_faktura_mail_frigiv($1, $2) r`, [id, ejer])).r;

  beforeAll(async () => {
    const afsnit = rettelseAfsnit("faktura");
    await db.exec(afsnit);
    await db.exec(afsnit); // idempotent
    sendt = await kladdeFor((await salg({ bud: 17000, levering: KASPER_DOER })).trade);
    expect((await send(sendt)).kode).toBe("sendt");
  });

  it("udgaven med ét argument er væk", async () => {
    const r = await en<{ n: number }>(
      `select count(*)::int n from pg_proc where proname in ('firma_faktura_mail_tag', 'firma_faktura_mail_frigiv') and pronargs = 1`);
    expect(r.n).toBe(0);
  });

  it("kun ejeren slipper låsen - en udløbet lås, der er taget af et nyt forsøg, kan det gamle ikke slippe", async () => {
    expect(await tag(sendt, null)).toBe(false); // ingen ejer
    expect(await tag(sendt, A)).toBe(true);
    expect(await tag(sendt, B)).toBe(false); // optaget
    expect(await frigiv(sendt, B)).toBe(false); // ikke B's lås
    expect(await tag(sendt, B)).toBe(false); // stadig låst
    // A's lås udløber (serveren var langsom), B tager den.
    await db.query(`update public.firma_faktura_mail_laas set laast_til = now() - interval '1 second' where faktura_id = $1`, [sendt]);
    expect(await tag(sendt, B)).toBe(true);
    // A er færdig og vil slippe - B's lås bliver stående.
    expect(await frigiv(sendt, A)).toBe(false);
    expect(await tag(sendt, A)).toBe(false);
    expect(await frigiv(sendt, B)).toBe(true);
    expect(await tag(sendt, A)).toBe(true);
    expect(await frigiv(sendt, A)).toBe(true);
    // Mailen er sendt: ingen flere forsøg.
    await db.query(`select public.firma_faktura_mail_resultat($1, true, null)`, [sendt]);
    expect(await tag(sendt, B)).toBe(false);
  });

  it("kun service role", async () => {
    for (const rolle of ["authenticated", "anon"]) {
      await db.exec(`set role ${rolle}`);
      try {
        await som(FIRMA_U);
        expect(await fejlkode(`select public.firma_faktura_mail_tag($1, $2)`, [sendt, A])).toBe("42501");
        expect(await fejlkode(`select public.firma_faktura_mail_frigiv($1, $2)`, [sendt, A])).toBe("42501");
      } finally {
        await som(null);
        await db.exec(`reset role`);
      }
    }
  });
});
