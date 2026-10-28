// Migrationen 20261102330000_firma_fakturaer.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubs af de tabeller,
// migrationen bygger på, og de rigtige funktioner (erhverv_har_adgang,
// stand_normaliser). Migrationen køres TO gange (idempotent).
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
import { beregnFaktura } from "@/lib/erhverv/firmaFaktura";

const MIGRATION = readFileSync(path.join(MIG, "20261102330000_firma_fakturaer.sql"), "utf8");

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
  amount numeric not null, created_at timestamptz not null default now(), sendt_kl timestamptz, received_at timestamptz);
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid not null unique, bud_oere bigint,
  betalt_kl timestamptz, refunderet_kl timestamptz);
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
  it("MitID-navn, kontoadressen før checkout, moms 25 % og total", async () => {
    await db.query(`insert into public.mitid_verificeringer (bruger_id, juridisk_navn) values ($1, 'Kasper Juridisk Køber')`, [KOEBER]);
    const s = await salg({
      bud: 12345,
      titel: "Kommode",
      stand: "ny_med_maerke",
      levering: { maade: "doer", navn: "K. Køber", adresse: "Checkoutvej 9", post: "2100", by: "København Ø", email: "levering@koeber.dk" },
    });
    const d = (await en<{ d: Record<string, any> }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s.trade)])).d;
    expect(d.koeber).toMatchObject({ navn: "Kasper Juridisk Køber", adresse: "Købervej 3", postnummer: "4700", by: "Næstved", email: "levering@koeber.dk" });
    expect(d.linjer[0].tekst).toBe("Kommode (stand: ny med mærke)");
    expect(d.momsordning).toBe("moms");
    expect(d.total_oere).toBe(12345);
    expect(d.beloeb_ekskl_moms_oere).toBe(9876);
    expect(d.moms_oere).toBe(2469);
    expect(d.moms_sats).toBe(25);
    expect(d.brugtmoms_tekst).toBeNull();
    expect(d.mangler).toEqual([]);
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
    const d = (await en<{ d: Record<string, any> }>(`select public.firma_faktura_byg($1) d`, [await kladdeFor(s.trade)])).d;
    expect(d.koeber).toMatchObject({ navn: "Lise Larsen", adresse: "Lisevej 2", postnummer: "8000", by: "Aarhus C" });
    expect(d.momsordning).toBe("brugtmoms");
    expect(d.moms_oere).toBeNull();
    expect(d.beloeb_ekskl_moms_oere).toBeNull();
    expect(d.linjer[0].moms_oere).toBeNull();
    expect(d.total_oere).toBe(50000);
    expect(d.brugtmoms_tekst).toBe("Brugtmoms – særordning for brugte varer");
  });

  it("auktionens momsordning overstyrer standarden og låses på kladden", async () => {
    const s = await salg({ moms: "brugtmoms" });
    const id = await kladdeFor(s.trade);
    expect((await en<{ m: string }>(`select momsordning m from public.firma_fakturaer where id = $1`, [id])).m).toBe("brugtmoms");
    // Standarden ændres bagefter: kladden følger ikke med.
    await db.query(`update public.firmaer set bruger_brugtmoms = true where id = $1`, [F1]);
    await db.query(`update public.firmaer set bruger_brugtmoms = false where id = $1`, [F1]);
    expect((await en<{ m: string }>(`select momsordning m from public.firma_fakturaer where id = $1`, [id])).m).toBe("brugtmoms");
    expect(await fejlkode(`update public.firma_fakturaer set momsordning = 'moms' where id = $1`, [id])).toBe("42501");
  });
});

describe("afsendelse - kun firmaets eget tryk", () => {
  let k1: string;
  let k2: string;
  let k3: string;
  let uden: string;

  beforeAll(async () => {
    k1 = await kladdeFor((await salg({ bud: 10000 })).trade);
    k2 = await kladdeFor((await salg({ bud: 20000 })).trade);
    k3 = await kladdeFor((await salg({ bud: 30000 })).trade);
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
    const r = await en<{ status: string; sendt_af: string; data: Record<string, any> }>(`select status, sendt_af, data from public.firma_fakturaer where id = $1`, [k1]);
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
    expect((r.data as any).koeber).toMatchObject({ navn: "Lise Larsen", adresse: "Lisevej 2", firmanavn: "Lises Firma ApS", cvr: "11223344" });
  });

  it("en sendt faktura kan ikke ændres eller slettes", async () => {
    expect(await fejlkode(`update public.firma_fakturaer set koeber_navn = 'Snyd' where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`update public.firma_fakturaer set data = data || '{"total_oere": 1}' where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`update public.firma_fakturaer set status = 'kladde', nummer = null where id = $1`, [k1])).not.toBe("ingen fejl");
    expect(await fejlkode(`delete from public.firma_fakturaer where id = $1`, [k1])).toBe("42501");
    expect(await fejlkode(`delete from public.firma_fakturaer where id = $1`, [uden])).toBe("42501");
    expect(await fejlkode(`truncate public.firma_fakturaer`)).toBe("42501");
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
    const d = r.data as any;
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

  it("refunderet køb kan ikke faktureres", async () => {
    const s = await salg();
    await db.query(`update public.betalinger set refunderet_kl = now() where trade_id = $1`, [s.trade]);
    const r = await send(await kladdeFor(s.trade));
    expect(r.kode).toBe("mangler");
    expect(r.mangler).toContain("refunderet");
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
