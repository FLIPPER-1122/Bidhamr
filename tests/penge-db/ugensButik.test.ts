// Migrationen 20261101020000_ugens_butik.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Stubs af de tabeller, migrationen bygger på
// (users, firmaer, auctions, fakturaer med de nuværende CHECK'er,
// moderation_log, nødstoppet) og de rigtige fakturafunktioner. Migrationen
// køres TO gange (idempotent). Testes: prisen ét sted (500 kr. + moms),
// kun aktive firmaer kan købe, ugerne (næste uge til 12 uger frem, mandag),
// én booking pr. uge (også når låsen omgås: det unikke indeks), reservation
// der udløber og frigiver ugen, betaling (rigtigt beløb, forkert beløb, for
// sent, kasseret), staff (book med/uden betaling, annullér, kun chefen
// refunderer og retter prisen - alt logges), faktura og kreditnota i
// Dinero-køen, forsiden (offentlig, kun aktive auktioner, højst 8) og
// firmaets egen oversigt.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { funktion, MIG } from "./prismodelStub";

const MIGRATION = readFileSync(path.join(MIG, "20261101020000_ugens_butik.sql"), "utf8");

const FIRMA_A = "00000000-0000-4000-8000-0000000000f1";
const FIRMA_B = "00000000-0000-4000-8000-0000000000f2";
const FIRMA_PAUSE = "00000000-0000-4000-8000-0000000000f3";
const FIRMA_SUSP = "00000000-0000-4000-8000-0000000000f4";
const PRIVAT = "00000000-0000-4000-8000-0000000000a1";
const CHEF = "00000000-0000-4000-8000-0000000000c1";
const SAELGERROLLE = "00000000-0000-4000-8000-0000000000c2";
const ADMIN = "00000000-0000-4000-8000-0000000000c3";
const FIRMA_R = "00000000-0000-4000-8000-0000000000f5";
const F_R = "00000000-0000-4000-8000-00000000f0e1";
const PAKKE_START = "00000000-0000-4000-8000-00000000aa01";
const PAKKE_BUTIK = "00000000-0000-4000-8000-00000000aa02";
// firmaer.id (forskellig fra brugerens id).
const F = {
  A: "00000000-0000-4000-8000-00000000f0a1",
  B: "00000000-0000-4000-8000-00000000f0b1",
  PAUSE: "00000000-0000-4000-8000-00000000f0c1",
  SUSP: "00000000-0000-4000-8000-00000000f0d1",
};

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger',
  konto_type text not null default 'privat', konto_lukket_kl timestamptz, konto_slettet_kl timestamptz,
  suspenderet boolean not null default false, suspenderet_til timestamptz, avatar_url text);
insert into public.users (id, navn, rolle, konto_type, suspenderet, avatar_url) values
  ('${FIRMA_A}', 'Firma A', 'bruger', 'erhverv', false, 'https://billede/a.jpg'),
  ('${FIRMA_B}', 'Firma B', 'bruger', 'erhverv', false, null),
  ('${FIRMA_PAUSE}', 'Firma Pause', 'bruger', 'erhverv', false, null),
  ('${FIRMA_SUSP}', 'Firma Susp', 'bruger', 'erhverv', true, null),
  ('${PRIVAT}', 'Privat', 'bruger', 'privat', false, null),
  ('${CHEF}', 'Chef', 'chef', 'privat', false, null),
  ('${SAELGERROLLE}', 'Sælger', 'saelger', 'privat', false, null),
  ('${ADMIN}', 'Admin', 'admin', 'privat', false, null);
create table public.erhverv_pakker (id uuid primary key, navn text not null);
insert into public.erhverv_pakker values ('${PAKKE_START}', 'Start'), ('${PAKKE_BUTIK}', 'Butik');
create table public.firmaer (id uuid primary key, bruger_id uuid not null unique references public.users(id),
  firmanavn text not null, abonnement_status text not null, pakke_id uuid references public.erhverv_pakker(id));
insert into public.firmaer values
  ('${F.A}', '${FIRMA_A}', 'Alfa ApS', 'aktiv', '${PAKKE_START}'),
  ('${F.B}', '${FIRMA_B}', 'Beta ApS', 'aktiv', '${PAKKE_START}'),
  ('${F.PAUSE}', '${FIRMA_PAUSE}', 'Pause ApS', 'pauset', '${PAKKE_START}'),
  ('${F.SUSP}', '${FIRMA_SUSP}', 'Susp ApS', 'aktiv', '${PAKKE_BUTIK}');
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid not null, titel text,
  billeder text[] not null default '{}', startpris numeric default 10, "nuværende_bud" numeric, antal_bud integer default 0,
  status text not null default 'aktiv', slutter_kl timestamptz not null default now() + interval '2 days',
  skjult boolean default false, arkiveret_kl timestamptz, pauset_kl timestamptz, forsendelse_mulig boolean default true,
  kunst_kontrol text, beskrivelse text);
create table public.stripe_tilstand (id boolean primary key default true, nye_betalinger_stoppet boolean not null default false);
insert into public.stripe_tilstand values (true, false);
create function public.nye_betalinger_stoppet() returns boolean language sql stable as
  $$ select coalesce((select st.nye_betalinger_stoppet from public.stripe_tilstand st where st.id), true) $$;
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now(),
  constraint moderation_log_handling_check check (handling = any ('{boost_justering,firma_opdateret}'::text[])),
  constraint moderation_log_maal_type_check check (maal_type = any ('{bruger,firma}'::text[])));
create table public.fakturaer (id uuid primary key default gen_random_uuid(), dokument text not null, part text not null,
  bruger_id uuid not null, betaling_id uuid, trade_id uuid, firma_regning_id uuid, krediterer_id uuid, linjer jsonb not null,
  beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null, stripe_reference text,
  status text not null, manuel boolean not null default false, sidste_fejl text, slags text not null default 'salg',
  boost_koeb_id uuid, ekstra_fragt_id uuid, returfragt_id uuid,
  constraint fakturaer_kilde CHECK ((((dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (betaling_id IS NOT NULL) AND (firma_regning_id IS NULL) AND (part = ANY (ARRAY['koeber'::text, 'saelger'::text]))) OR ((dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (slags = 'boost'::text) AND (boost_koeb_id IS NOT NULL) AND (betaling_id IS NULL) AND (firma_regning_id IS NULL) AND (part = 'koeber'::text)) OR ((dokument = ANY (ARRAY['abonnement'::text, 'abonnement_retur'::text])) AND (firma_regning_id IS NOT NULL) AND (betaling_id IS NULL) AND (part = 'firma'::text)))),
  constraint fakturaer_slags_check CHECK (((slags = ANY (ARRAY['salg'::text, 'returfragt'::text, 'sag_returfragt'::text, 'boost'::text, 'ekstra_fragt'::text])) AND ((slags = 'salg'::text) OR ((slags = 'returfragt'::text) AND (dokument = 'faktura'::text) AND (part = 'koeber'::text)) OR ((slags = 'sag_returfragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'boost'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'ekstra_fragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'saelger'::text))))));
`;

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

type Svar = { kode: string; id?: string; beloeb_oere?: number; pi?: string | null; pi_forsoeg?: number; gammel_pi?: string[]; status?: string; uge_start?: string };

async function start(bruger: string, uge: string): Promise<Svar> {
  return (await en<{ r: Svar }>(`select public.ugens_butik_koeb_start($1, $2::date) as r`, [bruger, uge])).r;
}
async function gemPi(id: string, pi: string, forsoeg = 0): Promise<string> {
  return (await en<{ r: string }>(`select public.ugens_butik_gem_pi($1, $2, $3) as r`, [id, pi, forsoeg])).r;
}
async function registrer(pi: string, status: string, beloeb: number | null, charge: string | null = null): Promise<Svar> {
  return (await en<{ r: Svar }>(`select public.ugens_butik_registrer($1, $2, $3, $4, null) as r`, [pi, status, charge, beloeb])).r;
}
async function booking(id: string): Promise<Record<string, unknown>> {
  return en(`select * from public.ugens_butik_bookinger where id = $1`, [id]);
}
async function udloeb(id: string): Promise<void> {
  await db.query(`update public.ugens_butik_bookinger set reserveret_til = now() - interval '1 second' where id = $1`, [id]);
}

// Ugerne: mandag i næste uge (dansk tid) + n uger.
let naeste: string;
function uge(n: number): string {
  const d = new Date(`${naeste}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  for (const start of [
    "create or replace function public.faktura_linje(",
    "create or replace function public.faktura_moms(",
    "create or replace function public.faktura_sum(",
  ]) {
    await db.exec(funktion("20261012080000_fakturaer.sql", start));
  }
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  naeste = (await en<{ d: string }>(`select (public.ugens_butik_uge(now()) + 7)::text as d`)).d;
}, 60_000);

describe("pris og uger", () => {
  it("prisen står ét sted: 500 kr. + 25 % moms = 625 kr.", async () => {
    const s = await en<{ p: string; m: string }>(
      `select pris_ekskl_moms_oere p, public.ugens_butik_moms_oere(pris_ekskl_moms_oere) m from public.ugens_butik_indstillinger`,
    );
    expect([Number(s.p), Number(s.m)]).toEqual([50000, 12500]);
  });

  it("ugen går fra mandag 00:00 til mandag 00:00 dansk tid (også ved skift til vintertid)", async () => {
    // Uge 44 2026: mandag 26. okt. (efter skiftet søndag 25. okt.); uge 43 har skiftet.
    const r = await en<{ s: string; e: string; t: string }>(
      `select to_char(public.ugens_butik_uge_start_kl('2026-10-19') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as s,
              to_char(public.ugens_butik_uge_start_kl('2026-10-26') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as e,
              public.ugens_butik_uge('2026-10-25 22:59:59+00')::text as t`,
    );
    expect(String(r.s)).toContain("2026-10-18 22:00:00");
    expect(String(r.e)).toContain("2026-10-25 23:00:00");
    expect(String(r.t)).toBe("2026-10-19");
  });

  it("firmaet kan kun købe fra næste uge, mandage, højst 12 uger frem", async () => {
    const nu = (await en<{ d: string }>(`select public.ugens_butik_uge(now())::text as d`)).d;
    expect((await start(FIRMA_A, nu)).kode).toBe("uge_ugyldig");
    const tirsdag = new Date(`${naeste}T12:00:00Z`);
    tirsdag.setUTCDate(tirsdag.getUTCDate() + 1);
    expect((await start(FIRMA_A, tirsdag.toISOString().slice(0, 10))).kode).toBe("uge_ugyldig");
    expect((await start(FIRMA_A, uge(12))).kode).toBe("uge_ugyldig");
    const ok = await start(FIRMA_A, uge(11));
    expect(ok.kode).toBe("ok");
    // Ryd op: firmaet vælger en anden uge senere i testene.
    await db.query(`update public.ugens_butik_bookinger set status = 'annulleret', annulleret_kl = now() where id = $1`, [ok.id]);
  });
});

describe("kun aktive firmaer kan købe", () => {
  it("privat konto, firma uden aktivt abonnement, suspenderet firma og lukket konto afvises", async () => {
    expect((await start(PRIVAT, uge(1))).kode).toBe("ikke_firma");
    expect((await start(FIRMA_PAUSE, uge(1))).kode).toBe("ikke_aktiv");
    expect((await start(FIRMA_SUSP, uge(1))).kode).toBe("spaerret");
    await db.query(`update public.users set konto_lukket_kl = now() where id = $1`, [FIRMA_B]);
    expect((await start(FIRMA_B, uge(1))).kode).toBe("spaerret");
    await db.query(`update public.users set konto_lukket_kl = null where id = $1`, [FIRMA_B]);
  });

  it("nødstop for nye betalinger: ingen ny reservation", async () => {
    await db.query(`update public.stripe_tilstand set nye_betalinger_stoppet = true`);
    expect((await start(FIRMA_A, uge(1))).kode).toBe("noedstop");
    await db.query(`update public.stripe_tilstand set nye_betalinger_stoppet = false`);
  });
});

describe("én booking pr. uge", () => {
  it("reservation: et andet firma får 'optaget' - samme firma genoptager sin", async () => {
    const a = await start(FIRMA_A, uge(1));
    expect(a.kode).toBe("ok");
    expect(a.beloeb_oere).toBe(62500);
    expect((await start(FIRMA_B, uge(1))).kode).toBe("optaget");
    const igen = await start(FIRMA_A, uge(1));
    expect([igen.kode, igen.id]).toEqual(["findes", a.id]);
  });

  it("samtidige køb: også hvis låsen omgås, afviser det unikke indeks en anden booking af ugen", async () => {
    await expect(
      db.query(
        `insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
           reserveret_til, pris_ekskl_moms_oere, moms_oere, beloeb_oere)
         values ($1, $2, $3::date, now(), now(), 'firma', 'stripe', 'reserveret', now() + interval '30 minutes', 50000, 12500, 62500)`,
        [F.B, FIRMA_B, uge(1)],
      ),
    ).rejects.toThrow(/ugens_butik_en_pr_uge/);
    // Og to transaktioner efter hinanden (som to samtidige kald, der venter
    // på ugens lås): den sidste får 'optaget'.
    await db.exec("begin");
    const b = await start(FIRMA_B, uge(1));
    await db.exec("commit");
    expect(b.kode).toBe("optaget");
    const n = await en<{ n: string }>(
      `select count(*) n from public.ugens_butik_bookinger where uge_start = $1::date and status in ('reserveret','behandles','betalt','manuel')`,
      [uge(1)],
    );
    expect(Number(n.n)).toBe(1);
  });

  it("højst én åben betaling pr. firma: en anden uge uden PaymentIntent erstatter den gamle, med PaymentIntent -> 'skift'", async () => {
    const b1 = await start(FIRMA_B, uge(2));
    expect(b1.kode).toBe("ok");
    const b2 = await start(FIRMA_B, uge(3));
    expect(b2.kode).toBe("ok");
    expect((await booking(b1.id!)).status).toBe("annulleret");
    expect(await gemPi(b2.id!, "pi_b2")).toBe("ok");
    const skift = await start(FIRMA_B, uge(4));
    expect([skift.kode, skift.pi]).toEqual(["skift", "pi_b2"]);
    // Serveren annullerer hos Stripe -> webhooken spejler 'canceled' -> prøv igen.
    expect((await registrer("pi_b2", "canceled", null)).kode).toBe("nulstillet");
    const b4 = await start(FIRMA_B, uge(4));
    expect(b4.kode).toBe("ok");
    expect((await booking(b2.id!)).status).toBe("annulleret");
    // Uge 3 er ledig igen.
    const n = await en<{ n: string }>(
      `select count(*) n from public.ugens_butik_bookinger where uge_start = $1::date and status in ('reserveret','behandles','betalt','manuel')`,
      [uge(3)],
    );
    expect(Number(n.n)).toBe(0);
  });
});

describe("reservationen udløber", () => {
  it("efter udløb frigives ugen til et andet firma, og den gamle PaymentIntent skal annulleres", async () => {
    const a = await en<{ id: string }>(
      `select id from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`,
      [F.A],
    );
    expect(await gemPi(a.id, "pi_a1")).toBe("ok");
    // PaymentIntenten gemmes ikke på en udløbet reservation.
    await udloeb(a.id);
    // Firma B har en åben betaling for uge 4 - giv den op først.
    const b4 = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`, [F.B]);
    await db.query(`update public.ugens_butik_bookinger set status = 'annulleret', annulleret_kl = now() where id = $1`, [b4.id]);
    const b = await start(FIRMA_B, uge(1));
    expect(b.kode).toBe("ok");
    expect(b.gammel_pi).toEqual(["pi_a1"]);
    const gl = await booking(a.id);
    expect(gl.status).toBe("udloebet");
    expect(gl.tidligere_payment_intents).toEqual(["pi_a1"]);
  });

  it("en udløbet reservation, der alligevel betales, mens ugen er taget: refunderes ('for_sent')", async () => {
    const r = await registrer("pi_a1", "succeeded", 62500, "ch_a1");
    expect(r.kode).toBe("for_sent");
    const a = await booking(r.id!);
    expect([a.status, a.refusion_aarsag, a.stripe_payment_intent_id]).toEqual(["refunderes", "for_sent", "pi_a1"]);
    // Ugen er stadig firma B's.
    const holder = await en<{ firma_id: string }>(
      `select firma_id from public.ugens_butik_bookinger where uge_start = $1::date and status in ('reserveret','behandles','betalt','manuel')`,
      [uge(1)],
    );
    expect(holder.firma_id).toBe(F.B);
  });

  it("en udløbet reservation, der betales, mens ugen stadig er ledig: firmaet får ugen", async () => {
    const a = await start(FIRMA_A, uge(5));
    expect(a.kode).toBe("ok");
    await gemPi(a.id!, "pi_a5");
    await udloeb(a.id!);
    // Cron'en: udløb (efter at Stripe-annulleringen fejlede, fordi den var betalt).
    const job = await db.query<{ id: string; handling: string }>(`select * from public.ugens_butik_cron(20)`);
    expect(job.rows.find((x) => x.id === a.id)?.handling).toBe("udloeb");
    expect((await en<{ r: boolean }>(`select public.ugens_butik_udloeb($1, 'pi_a5') as r`, [a.id])).r).toBe(true);
    const r = await registrer("pi_a5", "succeeded", 62500, "ch_a5");
    expect(r.kode).toBe("betalt");
    expect((await booking(a.id!)).status).toBe("betalt");
  });

  it("cron'en finder udløbne reservationer uden PaymentIntent", async () => {
    const b = await en<{ id: string }>(
      `select id from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`,
      [F.B],
    );
    await udloeb(b.id);
    const job = await db.query<{ id: string; handling: string }>(`select * from public.ugens_butik_cron(20)`);
    expect(job.rows.find((x) => x.id === b.id)?.handling).toBe("udloeb");
    expect((await en<{ r: boolean }>(`select public.ugens_butik_udloeb($1, null) as r`, [b.id])).r).toBe(true);
    expect((await booking(b.id)).status).toBe("udloebet");
  });
});

describe("betaling", () => {
  it("rigtigt beløb: betalt én gang (idempotent); forkert beløb: ingen uge, refunderes", async () => {
    const b = await start(FIRMA_B, uge(6));
    expect(await gemPi(b.id!, "pi_b6")).toBe("ok");
    expect((await registrer("pi_b6", "processing", null)).kode).toBe("behandles");
    expect((await start(FIRMA_B, uge(7))).kode).toBe("behandles");
    expect((await registrer("pi_b6", "succeeded", 62500, "ch_b6")).kode).toBe("betalt");
    expect((await registrer("pi_b6", "succeeded", 62500, "ch_b6")).kode).toBe("allerede");

    const c = await start(FIRMA_B, uge(7));
    await gemPi(c.id!, "pi_b7");
    expect((await registrer("pi_b7", "succeeded", 100, "ch_b7")).kode).toBe("beloeb_afviger");
    const x = await booking(c.id!);
    expect([x.status, x.refusion_aarsag, x.kraever_opmaerksomhed]).toEqual(["refunderes", "beloeb", true]);
    // Ugen er ledig igen.
    expect((await start(FIRMA_A, uge(7))).kode).toBe("ok");
  });

  it("refusionens resultat spejles; refund.failed genåbner den", async () => {
    const c = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where stripe_payment_intent_id = 'pi_b7'`);
    expect((await en<{ r: string }>(`select public.ugens_butik_refusion_resultat($1, true, 're_b7', null) as r`, [c.id])).r).toBe("refunderet");
    expect((await en<{ r: string }>(`select public.ugens_butik_refusion_resultat($1, true, 're_b7', null) as r`, [c.id])).r).toBe("allerede");
    expect((await en<{ r: string }>(`select public.ugens_butik_refusion_fejlet('re_b7', 'kort lukket') as r`)).r).toBe("genaabnet");
    expect((await booking(c.id)).status).toBe("refunderes");
    await db.query(`select public.ugens_butik_refusion_resultat($1, true, 're_b7b', null)`, [c.id]);
  });

  it("PaymentIntenten gemmes ikke på en udløbet reservation eller under nødstop", async () => {
    const a = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`, [F.A]);
    await db.query(`update public.stripe_tilstand set nye_betalinger_stoppet = true`);
    expect(await gemPi(a.id, "pi_x")).toBe("noedstop");
    await db.query(`update public.stripe_tilstand set nye_betalinger_stoppet = false`);
    await udloeb(a.id);
    expect(await gemPi(a.id, "pi_x")).toBe("nej");
  });
});

describe("staff", () => {
  it("chef og sælger booker; admin har ingen adgang; begrundelse påkrævet; logges", async () => {
    const nu = (await en<{ d: string }>(`select public.ugens_butik_uge(now())::text as d`)).d;
    const s = async (staff: string, firma: string, u: string, med: boolean, grund: string | null) =>
      (await en<{ r: Svar }>(`select public.ugens_butik_staff_book($1, $2, $3::date, $4, $5) as r`, [staff, firma, u, med, grund])).r;
    expect((await s(ADMIN, F.A, nu, false, "aftale")).kode).toBe("ingen_adgang");
    expect((await s(SAELGERROLLE, F.A, nu, false, " ")).kode).toBe("begrundelse_mangler");
    expect((await s(SAELGERROLLE, F.PAUSE, uge(8), false, "aftale")).kode).toBe("ikke_aktiv");
    // Den igangværende uge kan kun bookes uden betaling (af staff).
    expect((await s(SAELGERROLLE, F.A, nu, true, "aftale")).kode).toBe("uge_ugyldig");
    const m = await s(SAELGERROLLE, F.A, nu, false, "Aftale med Alfa om lancering");
    expect([m.kode, m.status]).toEqual(["ok", "manuel"]);
    expect((await s(CHEF, F.B, nu, false, "dobbelt")).kode).toBe("optaget");
    const med = await s(CHEF, F.B, uge(9), true, "Aftalt i telefonen");
    expect([med.kode, med.status]).toEqual(["ok", "reserveret"]);
    const r = await booking(med.id!);
    expect([r.kilde, r.betaling, Number(r.beloeb_oere)]).toEqual(["staff", "stripe", 62500]);
    // Firmaet betaler staffs reservation fra Firma oversigt (samme uge = genoptag) ...
    const f = await start(FIRMA_B, uge(9));
    expect([f.kode, f.id]).toEqual(["findes", med.id]);
    // ... men kan ikke vælge en anden uge, mens den står åben.
    expect((await start(FIRMA_B, uge(10))).kode).toBe("aaben_reservation");
    const log = await db.query<{ handling: string; maal_type: string }>(
      `select handling, maal_type from public.moderation_log where maal_id in ($1, $2) order by oprettet_kl`,
      [m.id, med.id],
    );
    expect(log.rows).toEqual([
      { handling: "ugens_butik_booket", maal_type: "ugens_butik" },
      { handling: "ugens_butik_booket", maal_type: "ugens_butik" },
    ]);
  });

  it("annullering: sælger må annullere ubetalte, kun chefen betalte - med eller uden refusion", async () => {
    const ann = async (staff: string, id: string, grund: string, refunder = false) =>
      (await en<{ r: Svar }>(`select public.ugens_butik_staff_annuller($1, $2, $3, $4) as r`, [staff, id, grund, refunder])).r;
    const betalt = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where stripe_payment_intent_id = 'pi_b6'`);
    expect((await ann(SAELGERROLLE, betalt.id, "fejl")).kode).toBe("kun_chef");
    expect((await ann(ADMIN, betalt.id, "fejl")).kode).toBe("ingen_adgang");
    const r = await ann(CHEF, betalt.id, "Firmaet har fået en anden uge", true);
    expect([r.kode, r.status]).toEqual(["ok", "refunderes"]);
    const b = await booking(betalt.id);
    expect([b.refusion_aarsag, b.refusion_af]).toEqual(["staff", CHEF]);
    // Ugen er ledig igen.
    expect((await start(FIRMA_A, uge(6))).kode).not.toBe("optaget");

    // Staffs reservation med PaymentIntent: sælger annullerer; serveren skal annullere PI'en.
    const res = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where kilde = 'staff' and status = 'reserveret'`);
    await gemPi(res.id, "pi_staff");
    const a = await ann(SAELGERROLLE, res.id, "Firmaet ombestemte sig");
    expect([a.kode, a.pi]).toEqual(["ok", "pi_staff"]);
    // Betales den alligevel, er den kasseret og refunderes som dobbeltbetaling.
    expect((await registrer("pi_staff", "succeeded", 62500, "ch_staff")).kode).toBe("kasseret");
    const log = await db.query<{ handling: string }>(
      `select handling from public.moderation_log where maal_id in ($1, $2) order by oprettet_kl`,
      [betalt.id, res.id],
    );
    expect(log.rows.map((x) => x.handling)).toEqual(["ugens_butik_booket", "ugens_butik_refunderet", "ugens_butik_annulleret"]);
  });

  it("prisen rettes kun af chefen (logges); en åben reservation beholder sin pris", async () => {
    const aaben = await en<{ id: string; beloeb_oere: string }>(
      `select id, beloeb_oere from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`,
      [F.A],
    );
    const p = async (staff: string, oere: number) =>
      (await en<{ r: Svar }>(`select public.ugens_butik_saet_pris($1, $2) as r`, [staff, oere])).r;
    expect((await p(SAELGERROLLE, 60000)).kode).toBe("ingen_adgang");
    expect((await p(CHEF, 5)).kode).toBe("ugyldig");
    const ok = await p(CHEF, 60000);
    expect([ok.kode, ok.beloeb_oere]).toEqual(["ok", 75000]);
    expect(Number((await booking(aaben.id)).beloeb_oere)).toBe(Number(aaben.beloeb_oere));
    const log = await en<{ aarsag: string }>(`select aarsag from public.moderation_log where handling = 'ugens_butik_pris'`);
    expect(log.aarsag).toContain("600");
    await p(CHEF, 50000);
  });

  it("admin-oversigten kun for chef og sælger", async () => {
    expect((await en<{ r: unknown }>(`select public.ugens_butik_admin($1) as r`, [ADMIN])).r).toBeNull();
    const a = (await en<{ r: { uger: unknown[]; bookinger: unknown[]; pris: { inkl_moms_oere: number } } }>(
      `select public.ugens_butik_admin($1) as r`, [SAELGERROLLE])).r;
    expect(a.pris.inkl_moms_oere).toBe(62500);
    expect(a.uger.length).toBe(13);
    expect(a.bookinger.length).toBeGreaterThan(5);
  });
});

describe("faktura (Dinero-køen)", () => {
  it("betalt booking: faktura til firmaet på 625 kr. inkl. 125 kr. moms; refunderet: kreditnota", async () => {
    const r1 = (await en<{ r: { fakturaer: number; kreditnotaer: number } }>(`select public.faktura_planlaeg_ugens_butik(200) as r`)).r;
    expect(r1.fakturaer).toBeGreaterThanOrEqual(3);
    const f = await en<{ bruger_id: string; part: string; beloeb_oere: string; moms_oere: string; linjer: { kode: string; tekst: string }[]; status: string }>(
      `select f.* from public.fakturaer f join public.ugens_butik_bookinger b on b.id = f.ugens_butik_id
        where b.stripe_payment_intent_id = 'pi_a5' and f.dokument = 'faktura'`,
    );
    expect([f.bruger_id, f.part, Number(f.beloeb_oere), Number(f.moms_oere), f.status]).toEqual([FIRMA_A, "koeber", 62500, 12500, "venter"]);
    expect(f.linjer[0].kode).toBe("ugens_butik");
    expect(f.linjer[0].tekst).toMatch(/^Ugens butik på BidHamrs forside, uge \d+ \d{4} \(/);
    // Forkert beløb: faktura "kræver handling".
    const fx = await en<{ status: string }>(
      `select f.status from public.fakturaer f join public.ugens_butik_bookinger b on b.id = f.ugens_butik_id
        where b.stripe_payment_intent_id = 'pi_b7' and f.dokument = 'faktura'`,
    );
    expect(fx.status).toBe("kraever_handling");
    // Refunderet booking -> kreditnota (pi_b7 er refunderet).
    expect(r1.kreditnotaer).toBeGreaterThanOrEqual(1);
    const r2 = (await en<{ r: { fakturaer: number; kreditnotaer: number } }>(`select public.faktura_planlaeg_ugens_butik(200) as r`)).r;
    expect(r2).toEqual({ fakturaer: 0, kreditnotaer: 0 });
    // En manuel booking (uden betaling) får ingen faktura.
    const m = await en<{ n: string }>(
      `select count(*) n from public.fakturaer f join public.ugens_butik_bookinger b on b.id = f.ugens_butik_id where b.betaling = 'ingen'`,
    );
    expect(Number(m.n)).toBe(0);
  });
});

describe("forsiden og Firma oversigt", () => {
  it("forside_ugens_butik: denne uges firma med højst 8 aktive auktioner; ingen auktioner = intet", async () => {
    // Firma A har den igangværende uge (manuel, booket af sælger-rollen).
    expect((await en<{ r: unknown }>(`select public.forside_ugens_butik() as r`)).r).toBeNull();
    for (let i = 0; i < 10; i++) {
      await db.query(`insert into public.auctions (bruger_id, titel, billeder, slutter_kl) values ($1, $2, $3, now() + make_interval(hours => $4))`, [
        FIRMA_A,
        `Vare ${i}`,
        [`https://billede/${i}.jpg`],
        i + 1,
      ]);
    }
    await db.query(`insert into public.auctions (bruger_id, titel, skjult) values ($1, 'Skjult', true)`, [FIRMA_A]);
    await db.query(`insert into public.auctions (bruger_id, titel, kunst_kontrol, slutter_kl) values ($1, 'Kunst?', 'afventer', now() + interval '1 minute')`, [FIRMA_A]);
    await db.query(`insert into public.auctions (bruger_id, titel, slutter_kl) values ($1, 'Andet firma', now() + interval '1 minute')`, [FIRMA_B]);
    const r = (await en<{ r: { annonce: boolean; firma: Record<string, string>; auktioner: { titel: string; billede: string }[] } }>(
      `select public.forside_ugens_butik() as r`)).r;
    expect(r.annonce).toBe(true);
    expect(r.firma).toEqual({ bruger_id: FIRMA_A, firmanavn: "Alfa ApS", profil_url: `/erhvervssaelger/${FIRMA_A}`, billede: "https://billede/a.jpg" });
    expect(r.auktioner.length).toBe(8);
    expect(r.auktioner[0]).toMatchObject({ titel: "Vare 0", billede: "https://billede/0.jpg" });
    expect(Object.keys(r.auktioner[0]).sort()).toEqual(
      ["antal_bud", "billede", "forsendelse_mulig", "id", "nuvaerende_bud", "slutter_kl", "startpris", "titel"]);
    // Firmaet er ikke aktivt længere: intet felt.
    await db.query(`update public.firmaer set abonnement_status = 'pauset' where id = $1`, [F.A]);
    expect((await en<{ r: unknown }>(`select public.forside_ugens_butik() as r`)).r).toBeNull();
    await db.query(`update public.firmaer set abonnement_status = 'aktiv' where id = $1`, [F.A]);
  });

  it("rettigheder: forsiden er offentlig, firma-RPC'en kun for indloggede, resten kun service role", async () => {
    const r = await en<Record<string, boolean>>(`select
      has_function_privilege('anon', 'public.forside_ugens_butik()', 'execute') as forside_anon,
      has_function_privilege('anon', 'public.firma_ugens_butik()', 'execute') as firma_anon,
      has_function_privilege('authenticated', 'public.firma_ugens_butik()', 'execute') as firma_auth,
      has_function_privilege('authenticated', 'public.ugens_butik_koeb_start(uuid, date)', 'execute') as start_auth,
      has_function_privilege('service_role', 'public.ugens_butik_koeb_start(uuid, date)', 'execute') as start_service,
      has_function_privilege('authenticated', 'public.ugens_butik_staff_book(uuid, uuid, date, boolean, text)', 'execute') as staff_auth,
      has_function_privilege('service_role', 'public.ugens_butik_udloeb_uge(date)', 'execute') as intern_service,
      has_table_privilege('authenticated', 'public.ugens_butik_bookinger', 'select') as tabel_auth`);
    expect(r).toEqual({
      forside_anon: true, firma_anon: false, firma_auth: true, start_auth: false, start_service: true,
      staff_auth: false, intern_service: false, tabel_auth: false,
    });
  });

  it("firma_ugens_butik: pris, uger (ledig/optaget/din) og egne bookinger - aldrig andre firmaers navne", async () => {
    await db.query(`select public.ugens_butik_staff_book($1, $2, $3::date, false, 'aftale')`, [CHEF, F.B, uge(10)]);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [FIRMA_B]);
    const o = (await en<{ r: { pris: { inkl_moms_oere: number }; kan_koebe: boolean; uger: { uge_start: string; status: string }[]; bookinger: unknown[]; aaben: { uge_start: string } | null } }>(
      `select public.firma_ugens_butik() as r`)).r;
    expect(o.pris.inkl_moms_oere).toBe(62500);
    expect(o.kan_koebe).toBe(true);
    expect(o.uger.length).toBe(12);
    expect(o.uger[0].uge_start).toBe(uge(0));
    const status = new Map(o.uger.map((x) => [x.uge_start, x.status]));
    expect(status.get(uge(10))).toBe("din");
    expect(status.get(uge(1))).toBe("ledig"); // B's reservation udløb (cron-testen)
    expect(status.get(uge(6))).toBe("optaget"); // A's åbne reservation
    expect(status.get(uge(5))).toBe("optaget");
    expect(status.get(uge(9))).toBe("ledig");
    expect(JSON.stringify(o)).not.toContain("Alfa");
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [PRIVAT]);
    expect((await en<{ r: unknown }>(`select public.firma_ugens_butik() as r`)).r).toBeNull();
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  });

  it("firmaet annullerer selv sin åbne betaling - kun sin egen", async () => {
    const a = await en<{ id: string }>(`select id from public.ugens_butik_bookinger where firma_id = $1 and status = 'reserveret'`, [F.A]);
    expect((await en<{ r: string }>(`select public.ugens_butik_firma_annuller($1, $2, null) as r`, [FIRMA_B, a.id])).r).toBe("ikke_fundet");
    expect((await en<{ r: string }>(`select public.ugens_butik_firma_annuller($1, $2, null) as r`, [FIRMA_A, a.id])).r).toBe("ok");
    expect((await booking(a.id)).status).toBe("annulleret");
    expect((await en<{ r: string }>(`select public.ugens_butik_firma_annuller($1, $2, null) as r`, [FIRMA_A, a.id])).r).toBe("nej");
  });

  it("handelsdata slettes aldrig; firma, uge og pris er låst", async () => {
    const b = await en<{ id: string }>(`select id from public.ugens_butik_bookinger limit 1`);
    await expect(db.query(`delete from public.ugens_butik_bookinger where id = $1`, [b.id])).rejects.toThrow(/slettes/);
    await expect(db.query(`update public.ugens_butik_bookinger set beloeb_oere = 1 where id = $1`, [b.id])).rejects.toThrow(/låst|ændres/);
    await expect(db.query(`update public.ugens_butik_bookinger set uge_start = uge_start + 7 where id = $1`, [b.id])).rejects.toThrow(/ændres/);
  });
});

describe("rabat fra pakken (Butik/Pro)", () => {
  // Ny database, så ugerne er ledige.
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(STUB);
    for (const s of [
      "create or replace function public.faktura_linje(",
      "create or replace function public.faktura_moms(",
      "create or replace function public.faktura_sum(",
    ]) {
      await db.exec(funktion("20261012080000_fakturaer.sql", s));
    }
    await db.exec(MIGRATION);
    await db.exec(`insert into public.users (id, navn, konto_type) values ('${FIRMA_R}', 'Firma R', 'erhverv');
      insert into public.firmaer values ('${F_R}', '${FIRMA_R}', 'Rabat ApS', 'aktiv', '${PAKKE_BUTIK}');`);
  }, 60_000);

  async function koebOgBetal(u: string, pi: string): Promise<Svar> {
    const s = await start(FIRMA_R, u);
    expect(s.kode).toBe("ok");
    await gemPi(s.id!, pi);
    expect((await registrer(pi, "succeeded", s.beloeb_oere!, `ch_${pi}`)).kode).toBe("betalt");
    return s;
  }

  it("en pakke uden rabat (standard 0) giver fuld pris", async () => {
    const s = await start(FIRMA_R, uge(0));
    expect([s.kode, s.beloeb_oere]).toEqual(["ok", 62500]);
    await db.query(`select public.ugens_butik_firma_annuller($1, $2, null)`, [FIRMA_R, s.id]);
  });

  it("50 % de første 2 gange i kalenderåret, derefter fuld pris; annulleret/refunderet giver rabatten tilbage; nyt år = ny kvote", async () => {
    await db.query(`update public.erhverv_pakker set ugens_butik_rabat_procent = 50, ugens_butik_rabat_antal = 2 where id = $1`, [PAKKE_BUTIK]);
    // Fire uger i samme kalenderår (ugens mandag).
    const alle = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(uge);
    const aar = alle[11].slice(0, 4);
    const samme = alle.filter((u) => u.slice(0, 4) === aar);
    const [u1, u2, u3, u4] = samme.length >= 4 ? samme : alle.filter((u) => u.slice(0, 4) === alle[0].slice(0, 4));
    expect([u1, u2, u3, u4].every(Boolean)).toBe(true);
    const a = await koebOgBetal(u1, "pi_r1");
    const ab = await booking(a.id!);
    expect([Number(ab.beloeb_oere), Number(ab.moms_oere), ab.rabat_procent, Number(ab.rabat_oere)]).toEqual([31250, 6250, 50, 25000]);
    const b = await koebOgBetal(u2, "pi_r2");
    const c = await start(FIRMA_R, u3);
    expect(c.beloeb_oere).toBe(62500);
    // Firmaets oversigt viser satsen, forbruget og prisen pr. uge.
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [FIRMA_R]);
    const o = (await en<{ r: { rabat: Record<string, number>; uger: { uge_start: string; pris_inkl_moms_oere: number }[] } }>(
      `select public.firma_ugens_butik() as r`)).r;
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    expect([o.rabat.procent, o.rabat.antal_pr_aar]).toEqual([50, 2]);
    expect(o.uger.find((x) => x.uge_start === u4)?.pris_inkl_moms_oere).toBe(62500);
    // Chefen annullerer og refunderer en rabat-uge: rabatten kan bruges igen.
    await db.query(`select public.ugens_butik_firma_annuller($1, $2, null)`, [FIRMA_R, c.id]);
    const ann = (await en<{ r: Svar }>(`select public.ugens_butik_staff_annuller($1, $2, 'test', true) as r`, [CHEF, b.id])).r;
    expect(ann.status).toBe("refunderes");
    const d = await start(FIRMA_R, u4);
    expect(d.beloeb_oere).toBe(31250);
    // Fakturaen nævner rabatten.
    await db.query(`select public.faktura_planlaeg_ugens_butik(200)`);
    const f = await en<{ linjer: { tekst: string }[]; beloeb_oere: string; moms_oere: string }>(
      `select linjer, beloeb_oere, moms_oere from public.fakturaer where ugens_butik_id = $1`, [a.id]);
    expect(f.linjer[0].tekst).toContain("50 % rabat fra din pakke");
    expect([Number(f.beloeb_oere), Number(f.moms_oere)]).toEqual([31250, 6250]);
    // Et andet kalenderår har sin egen kvote.
    const pf = await en<{ rabat_procent: number }>(
      `select rabat_procent from public.ugens_butik_pris_for($1, ($2::date + 371))`, [F_R, u1]);
    expect(pf.rabat_procent).toBe(50);
    // Rabatten er låst på bookingen.
    await expect(
      db.query(`update public.ugens_butik_bookinger set rabat_procent = 0, rabat_oere = 0 where id = $1`, [a.id]),
    ).rejects.toThrow(/ændres/);
  });
});
