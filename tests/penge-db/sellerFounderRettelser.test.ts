// Migrationen 20261102460000_seller_founder_rettelser.sql i PGlite (samme
// opsætning som sellerFounder.test.ts, derefter 20261102420000 og så denne
// to gange - idempotent). Testes: rabatten ud fra auktionens sluttid (også
// når aftalen stoppes før/efter sluttiden), tilbud til næste byder bruger nu,
// at en ny privat prismodel ikke afvises af rabat-checket, tallene til det
// anslåede Stripe-tab (uden/med refunderede), alarmen ved mistanke om falske
// handler (én pr. par pr. periode), at genoptagelse bevarer den første
// oprettelse, at staff ikke kan være founder, og md5-tjekket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { danskDato } from "@/lib/betaling/beregn";
import { anslaaetStripeTabOere } from "@/lib/betaling/stripeGebyrSkoen";
import { FORTSAET, funktion, KOEBER, KOEBER2, MIG, MIGRATION, RETTELSER, RIGTIGE, SAELGER, STUB } from "./prismodelStub";

const ERHVERV2 = readFileSync(path.join(MIG, "20261101010000_erhverv_intet_saelgergebyr.sql"), "utf8");
const GLIDENDE = readFileSync(path.join(MIG, "20261102140000_glidende_gebyrer.sql"), "utf8");
const FOUNDER = readFileSync(path.join(MIG, "20261102420000_seller_founder.sql"), "utf8");
const RET = readFileSync(path.join(MIG, "20261102460000_seller_founder_rettelser.sql"), "utf8");

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const ADMIN = "00000000-0000-4000-8000-0000000000c2";
const ANDEN = "00000000-0000-4000-8000-0000000000b2";
const TREDJE = "00000000-0000-4000-8000-0000000000b3";

const FAKTURA_STUB = `
alter table public.betalinger add column betalt_kl timestamptz, add column stripe_application_fee_id text,
  add column stripe_charge_id text, add column stripe_payment_intent_id text, add column refunderet_kl timestamptz,
  add column gebyr_refunderet_kl timestamptz, add column refusion_gebyr_oere bigint, add column stripe_refund_id text,
  add column bidhamr_daekker_refund_id text, add column bidhamr_daekker_oere bigint;
create table public.fakturaer (id uuid primary key default gen_random_uuid(), dokument text not null, part text not null,
  bruger_id uuid not null, betaling_id uuid, trade_id uuid, firma_regning_id uuid, krediterer_id uuid,
  linjer jsonb not null, beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null,
  stripe_reference text, status text not null, manuel boolean not null default false, sidste_fejl text,
  slags text not null default 'salg', laas_til timestamptz, oprettet_kl timestamptz not null default now());
create unique index fakturaer_handel on public.fakturaer (betaling_id, part, dokument, slags) where betaling_id is not null;
create table public.handel_ikke_afhentet (betaling_id uuid, total_oere bigint, koebergebyr_oere bigint,
  beskyttelse_oere bigint, fragt_oere bigint, refusion_oere bigint);
create table public.firmaer (id uuid primary key, bruger_id uuid);
create table public.firma_regninger (id uuid primary key, firma_id uuid, betalt_kl timestamptz, status text,
  beloeb_oere bigint, moms_oere bigint, type text, nummer text, krediteret_kl timestamptz, stripe_invoice_id text);
create function public.faktura_ikke_afhentet_ok(p_betaling uuid) returns boolean language sql as $$ select true $$;
`;

const FOUNDER_STUB = `
alter table public.users add column email text, add column konto_slettet_kl timestamptz;
insert into public.users (id, navn, rolle) values ('${CHEF}', 'Chefen', 'chef'), ('${ADMIN}', 'Admin', 'admin');
insert into public.users (id, navn) values ('${ANDEN}', 'Anden sælger'), ('${TREDJE}', 'Tredje sælger');
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz not null default now(),
  constraint moderation_log_handling_check check (handling = any ('{advarsel,suspender}'::text[])),
  constraint moderation_log_maal_type_check check (maal_type = any ('{auktion,bruger}'::text[])));
`;

let db: PGlite;

async function en<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

async function kode(sql: string, params: unknown[]): Promise<string> {
  return (await en<{ r: { kode: string } }>(sql, params)).r.kode;
}

type Betaling = { id: string; founder_rabat_pct: number; koebergebyr_oere: string; saelgergebyr_oere: string; total_oere: string };

// En auktion, der sluttede for `slutForMin` minutter siden, med ét bud (kr.)
// fra køberen; afslut_udloebne_auktioner laver handel og betaling.
async function solgt(o: { bud: number; saelger?: string; koeber?: string; slutForMin?: number }): Promise<Betaling> {
  const { id } = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, forsendelse_mulig, pakkestoerrelse, slutter_kl)
     values ($1, true, 'lille', now() - make_interval(mins => $2::integer)) returning id`,
    [o.saelger ?? SAELGER, o.slutForMin ?? 1],
  );
  await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, $3)`, [id, o.koeber ?? KOEBER, o.bud]);
  await db.query(`select public.afslut_udloebne_auktioner()`);
  const b = await en<Betaling>(`select * from public.betalinger where auction_id = $1`, [id]);
  if (!b) throw new Error("ingen betaling oprettet");
  return b;
}

// Startdato = dansk dato i dag + dage - måneder.
async function saetStart(bruger: string, dageFraIDag: number, maaneder = 0): Promise<void> {
  await db.query(
    `update public.seller_founder
        set start_dato = ((now() at time zone 'Europe/Copenhagen')::date + $2::integer - make_interval(months => $3::integer))::date
      where bruger_id = $1`,
    [bruger, dageFraIDag, maaneder],
  );
}

async function betal(id: string, dageSiden = 0): Promise<void> {
  await db.query(
    `update public.betalinger set status = 'betalt', betalt_kl = now() - make_interval(days => $2::integer) where id = $1`,
    [id, dageSiden],
  );
}

async function admin(bruger: string) {
  return (await en<{ r: { kode: string; er_staff: boolean; founder: Record<string, unknown> } }>(
    `select public.seller_founder_admin($1, $2) r`,
    [CHEF, bruger],
  )).r;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(RIGTIGE);
  await db.exec(FAKTURA_STUB);
  for (const [fil, start] of [
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_linje("],
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_moms("],
    ["20261012080000_fakturaer.sql", "create or replace function public.faktura_sum("],
  ]) {
    await db.exec(funktion(fil, start));
  }
  await db.exec(MIGRATION);
  await db.exec(RETTELSER);
  await db.exec(FORTSAET);
  await db.exec(ERHVERV2);
  await db.exec(GLIDENDE);
  await db.exec(FOUNDER_STUB);
  await db.exec(FOUNDER);
  // En aftale, der er genoptaget med den gamle kode (oprettet_kl overskrevet):
  // migrationen skal hente den første oprettelse fra moderation_log.
  expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, TREDJE, danskDato(new Date())])).toBe("ok");
  await db.query(`update public.moderation_log set oprettet_kl = now() - interval '40 days' where bruger_id = $1`, [TREDJE]);
  await db.query(`update public.seller_founder set oprettet_kl = now() - interval '40 days' where bruger_id = $1`, [TREDJE]);
  expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [CHEF, TREDJE])).toBe("ok");
  expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, TREDJE, danskDato(new Date())])).toBe("ok");
  await db.exec(RET);
  await db.exec(RET);
}, 60_000);

describe("rabatten ud fra auktionens sluttid", () => {
  beforeAll(async () => {
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, SAELGER, danskDato(new Date())])).toBe("ok");
  });

  it("auktionen sluttede i måned 6, betalingen oprettes i måned 7: 100 % (som vist før buddet)", async () => {
    await saetStart(SAELGER, 0, 6); // i dag = første dag i måned 7 -> 50 % nu
    expect(Number((await en<{ p: number }>(`select public.founder_rabat_pct($1, now()) p`, [SAELGER])).p)).toBe(50);
    const b = await solgt({ bud: 10000, slutForMin: 2 * 24 * 60 }); // sluttede for 2 døgn siden (måned 6)
    expect([Number(b.founder_rabat_pct), Number(b.koebergebyr_oere), Number(b.saelgergebyr_oere)]).toEqual([100, 0, 0]);
    // Lige sluttet (i dag): 50 %.
    const nu = await solgt({ bud: 10000 });
    expect(Number(nu.founder_rabat_pct)).toBe(50);
  });

  it("auktion_founder_rabat før buddet = rabatten på betalingen ved sluttiden", async () => {
    await saetStart(SAELGER, 0);
    const { id } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, pakkestoerrelse, slutter_kl) values ($1, 'lille', now() + interval '3 days') returning id`,
      [SAELGER],
    );
    const vist = Number((await en<{ p: number }>(`select public.auktion_founder_rabat($1) p`, [id])).p);
    // Sluttiden skubbes tilbage, som om cron'en kører efter sluttiden.
    await db.query(`update public.auctions set slutter_kl = now() - interval '1 minute' where id = $1`, [id]);
    await db.query(`insert into public.bids (auktion_id, bruger_id, "beløb") values ($1, $2, 500)`, [id, KOEBER]);
    await db.query(`select public.afslut_udloebne_auktioner()`);
    const b = await en<Betaling>(`select * from public.betalinger where auction_id = $1`, [id]);
    expect([vist, Number(b.founder_rabat_pct)]).toEqual([100, 100]);
  });

  it("tilbud til næste byder: rabatten efter nu, ikke efter sluttiden", async () => {
    await saetStart(SAELGER, 0, 6); // 50 % nu, 100 % for 2 døgn siden
    const { id: a } = await en<{ id: string }>(
      `insert into public.auctions (bruger_id, status, forsendelse_mulig, pakkestoerrelse, slutter_kl, vinder_id)
       values ($1, 'afsluttet', true, 'mellem', now() - interval '2 days', $2) returning id`,
      [SAELGER, KOEBER],
    );
    const { id: x } = await en<{ id: string }>(
      `insert into public.andenchance_tilbud (auction_id, seller_id, byder_id, bud_oere) values ($1, $2, $3, 1000000) returning id`,
      [a, SAELGER, KOEBER2],
    );
    expect((await en<{ r: { kode: string } }>(`select public.andenchance_svar($1, $2, true) as r`, [x, KOEBER2])).r.kode).toBe("ok");
    const b = await en<Betaling>(`select * from public.betalinger where auction_id = $1`, [a]);
    expect(Number(b.founder_rabat_pct)).toBe(50);
    await saetStart(SAELGER, 0);
  });

  it("stoppet før sluttiden: 0; stoppet efter sluttiden: rabatten ved sluttiden", async () => {
    expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [CHEF, SAELGER])).toBe("ok");
    await db.query(`update public.seller_founder set stoppet_kl = now() - interval '2 hours' where bruger_id = $1`, [SAELGER]);
    const efterStop = await solgt({ bud: 2000, slutForMin: 60 }); // sluttede 1 time efter stoppet
    expect(Number(efterStop.founder_rabat_pct)).toBe(0);
    const foerStop = await solgt({ bud: 2000, slutForMin: 180 }); // sluttede 1 time før stoppet
    expect([Number(foerStop.founder_rabat_pct), Number(foerStop.koebergebyr_oere)]).toEqual([100, 0]);
    expect((await en<{ f: boolean }>(`select public.founding_seller($1) f`, [SAELGER])).f).toBe(false);
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, SAELGER, danskDato(new Date())])).toBe("ok");
  });

  it("rabatten er stadig låst ved UPDATE", async () => {
    const b = await solgt({ bud: 700 });
    await db.query(`update public.betalinger set founder_rabat_pct = 0 where id = $1`, [b.id]);
    expect(Number((await en<Betaling>(`select * from public.betalinger where id = $1`, [b.id])).founder_rabat_pct)).toBe(100);
  });
});

describe("rabat-checket følger ikke kun 'ny2'", () => {
  it("afviser kun de gamle modeller og erhverv", async () => {
    const c = await en<{ d: string }>(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'betalinger_founder_rabat_check'`,
    );
    expect(c.d).toMatch(/erhverv2/);
    expect(c.d).not.toMatch(/prismodel = 'ny2'/);
    // Konstrueret: en ny privat model 'ny3' (efter at prismodel-checket er
    // udvidet) må gerne have rabat - erhverv2 må ikke.
    const r = await en<{ ny3: boolean; erhverv2: boolean; ny: boolean }>(
      `select (100 in (0, 50, 100) and (false or 'ny3' not in ('gammel', 'ny', 'erhverv', 'erhverv2'))) ny3,
              ('erhverv2' not in ('gammel', 'ny', 'erhverv', 'erhverv2')) erhverv2,
              ('ny' not in ('gammel', 'ny', 'erhverv', 'erhverv2')) ny`,
    );
    expect(r).toEqual({ ny3: true, erhverv2: false, ny: false });
    const kommentar = await en<{ c: string }>(`select obj_description('public.aktuel_prismodel(boolean)'::regprocedure, 'pg_proc') c`);
    expect(kommentar.c).toMatch(/NY MODEL\?/);
  });
});

describe("tal til admin (Stripe-tab og refunderede)", () => {
  it("handler/rabat uden refunderede; gratis_handler/gratis_total inkl. refunderede", async () => {
    await saetStart(ANDEN, 0);
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, ANDEN, danskDato(new Date())])).toBe("ok");
    const a = await solgt({ bud: 1000, saelger: ANDEN, koeber: KOEBER2 });
    const b = await solgt({ bud: 2000, saelger: ANDEN, koeber: KOEBER2 });
    const ubetalt = await solgt({ bud: 3000, saelger: ANDEN, koeber: KOEBER2 });
    await betal(a.id);
    await betal(b.id);
    await db.query(`update public.betalinger set status = 'refunderet', refunderet_kl = now() where id = $1`, [b.id]);
    const f = (await admin(ANDEN)).founder;
    // Kun a tæller som handel; b er refunderet; den ubetalte tæller ikke.
    expect(Number(ubetalt.founder_rabat_pct)).toBe(100);
    expect([f.handler, f.refunderede, f.gratis_handler]).toEqual([1, 1, 2]);
    expect(Number(f.gratis_total_oere)).toBe(Number(a.total_oere) + Number(b.total_oere));
    const fuld = await en<{ r: string }>(
      `select public.prismodel_koebergebyr_oere('ny2', 100000) + public.prismodel_saelgergebyr_oere('ny2', 100000) r`,
    );
    expect(Number(f.rabat_oere)).toBe(Number(fuld.r));
    // Skønnet: 1,5 % + 1,80 kr. pr. handel.
    expect(anslaaetStripeTabOere(2, Number(f.gratis_total_oere))).toBe(
      Math.round((Number(a.total_oere) + Number(b.total_oere)) * 0.015) + 360,
    );
  });
});

describe("alarm ved mistanke om falske handler", () => {
  type Alarm = { founder_id: string; koeber_id: string; handler: number };
  const tjek = async () => (await en<{ r: Alarm[] }>(`select public.seller_founder_alarm_tjek() r`)).r;

  it("2 handler: ingen alarm; 3 inden for 30 dage: én alarm; gentaget: ingen ny", async () => {
    await tjek(); // ryd op efter tidligere tests (andre par)
    const x1 = await solgt({ bud: 100, saelger: ANDEN });
    const x2 = await solgt({ bud: 100, saelger: ANDEN });
    await betal(x1.id, 10);
    await betal(x2.id, 5);
    // En gammel handel (over 30 dage) tæller ikke.
    const gammel = await solgt({ bud: 100, saelger: ANDEN });
    await betal(gammel.id, 31);
    expect(await tjek()).toEqual([]);
    const x3 = await solgt({ bud: 100, saelger: ANDEN });
    await betal(x3.id);
    expect(await tjek()).toEqual([{ founder_id: ANDEN, koeber_id: KOEBER, handler: 3 }]);
    expect(await tjek()).toEqual([]);
    const x4 = await solgt({ bud: 100, saelger: ANDEN });
    await betal(x4.id);
    expect(await tjek()).toEqual([]); // samme periode
    const f = (await admin(ANDEN)).founder;
    expect(f.alarm_aktiv).toBe(true);
    const al = f.alarmer as { koeber_id: string; koeber_navn: string; handler: number }[];
    expect(al.map((x) => [x.koeber_id, x.koeber_navn, x.handler])).toEqual([[KOEBER, "Køber", 3]]);
  });

  it("ny periode efter 30 dage: ny alarm, hvis der igen er 3 handler", async () => {
    await db.query(`update public.seller_founder_alarmer set oprettet_kl = now() - interval '31 days' where founder_id = $1`, [ANDEN]);
    // De betalte handler står stadig inden for 30 dage -> ny periode, ny alarm.
    const r = await tjek();
    expect(r.map((x) => x.founder_id)).toEqual([ANDEN]);
    expect(r[0].handler).toBeGreaterThanOrEqual(3);
    const n = await en<{ n: number }>(`select count(*)::int n from public.seller_founder_alarmer where founder_id = $1`, [ANDEN]);
    expect(n.n).toBe(2);
  });

  it("andre par og handler uden rabat giver ingen alarm", async () => {
    // Sælger uden aftale (TREDJE stoppes): handler uden rabat.
    expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [CHEF, TREDJE])).toBe("ok");
    for (let i = 0; i < 3; i++) {
      // Sluttede efter stoppet (slutForMin 0 = lige nu).
      const b = await solgt({ bud: 100, saelger: TREDJE, slutForMin: 0 });
      expect(Number(b.founder_rabat_pct)).toBe(0);
      await betal(b.id);
    }
    expect((await tjek()).filter((x) => x.founder_id === TREDJE)).toEqual([]);
  });

  it("tabellen og funktionen er lukket for anon og authenticated", async () => {
    const r = await en<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.seller_founder_alarmer', 'select') ts,
              has_table_privilege('service_role', 'public.seller_founder_alarmer', 'insert') si,
              has_function_privilege('authenticated', 'public.seller_founder_alarm_tjek()', 'execute') fa,
              has_function_privilege('service_role', 'public.seller_founder_alarm_tjek()', 'execute') fs,
              (select relrowsecurity from pg_class where oid = 'public.seller_founder_alarmer'::regclass) rls`,
    );
    expect(r).toEqual({ ts: false, si: false, fa: false, fs: true, rls: true });
  });
});

describe("genoptagelse og staff", () => {
  it("migrationen henter den første oprettelse tilbage; ny genoptagelse bevarer den", async () => {
    const r = await en<{ dage: number; gen: string | null }>(
      `select extract(day from now() - oprettet_kl)::int dage, genoptaget_kl gen from public.seller_founder where bruger_id = $1`,
      [TREDJE],
    );
    expect(r.dage).toBe(40);
    expect(r.gen).not.toBeNull();
    // TREDJE er stoppet i testen ovenfor - genoptag igen.
    expect(await kode(`select public.seller_founder_opret($1, $2, $3::date, null) r`, [CHEF, TREDJE, danskDato(new Date())])).toBe("ok");
    const efter = await en<{ dage: number; gen: string }>(
      `select extract(day from now() - oprettet_kl)::int dage, genoptaget_kl gen from public.seller_founder where bruger_id = $1`,
      [TREDJE],
    );
    expect(efter.dage).toBe(40);
    expect(new Date(efter.gen).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const f = (await admin(TREDJE)).founder;
    expect(f.genoptaget_af_navn).toBe("Chefen");
    expect(f.oprettet_af_navn).toBe("Chefen");
  });

  it("staff kan ikke blive founder - heller ikke direkte; en founder, der bliver staff, mister rabatten", async () => {
    expect(await kode(`select public.seller_founder_opret($1, $2, current_date, null) r`, [CHEF, ADMIN])).toBe("staff");
    await expect(
      db.query(`insert into public.seller_founder (bruger_id, start_dato, oprettet_af) values ($1, current_date, $2)`, [ADMIN, CHEF]),
    ).rejects.toThrow(/Staff kan ikke være seller founder/);
    expect(Number((await en<{ p: number }>(`select public.founder_rabat_pct($1, now()) p`, [TREDJE])).p)).toBe(100);
    await db.query(`update public.users set rolle = 'medarbejder' where id = $1`, [TREDJE]);
    expect(Number((await en<{ p: number }>(`select public.founder_rabat_pct($1, now()) p`, [TREDJE])).p)).toBe(0);
    expect(await kode(`select public.seller_founder_ret_start($1, $2, current_date - 3) r`, [CHEF, TREDJE])).toBe("staff");
    const a = await admin(TREDJE);
    expect([a.er_staff, a.founder.er_staff]).toEqual([true, true]);
    // Stop er altid tilladt.
    expect(await kode(`select public.seller_founder_stop($1, $2, null) r`, [CHEF, TREDJE])).toBe("ok");
    await db.query(`update public.users set rolle = 'bruger' where id = $1`, [TREDJE]);
  });
});

describe("min_founder_rabat (appen: opret/redigér auktion)", () => {
  async function som<T>(bruger: string | null, sql: string, params: unknown[] = []): Promise<T> {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [bruger ?? ""]);
    try {
      return await en<T>(sql, params);
    } finally {
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  }

  it("egen rabat på sluttiden; uden login 0; ingen bruger-parameter", async () => {
    await saetStart(SAELGER, 0, 6); // i dag = måned 7 (50 %), for 2 døgn siden måned 6 (100 %)
    expect(Number((await som<{ p: number }>(SAELGER, `select public.min_founder_rabat() p`)).p)).toBe(50);
    expect(Number((await som<{ p: number }>(SAELGER, `select public.min_founder_rabat(now() - interval '2 days') p`)).p)).toBe(100);
    expect(Number((await som<{ p: number }>(SAELGER, `select public.min_founder_rabat(null) p`)).p)).toBe(50);
    expect(Number((await som<{ p: number }>(KOEBER, `select public.min_founder_rabat() p`)).p)).toBe(0);
    expect(Number((await som<{ p: number }>(null, `select public.min_founder_rabat() p`)).p)).toBe(0);
    await saetStart(SAELGER, 0);
    const r = await en<Record<string, boolean | number>>(
      `select has_function_privilege('authenticated', 'public.min_founder_rabat(timestamptz)', 'execute') au,
              has_function_privilege('anon', 'public.min_founder_rabat(timestamptz)', 'execute') an,
              (select prosecdef from pg_proc where oid = 'public.min_founder_rabat(timestamptz)'::regprocedure) sd,
              (select count(*)::int from pg_proc where proname = 'min_founder_rabat') n`,
    );
    expect(r).toEqual({ au: true, an: false, sd: true, n: 1 });
  });
});

describe("migrationen", () => {
  it("genkørsel ændrer intet; en ændret trigger stopper migrationen", async () => {
    const foer = await db.query(`select id, founder_rabat_pct, koebergebyr_oere from public.betalinger order by id`);
    const sf = await db.query(`select bruger_id, oprettet_kl, genoptaget_kl from public.seller_founder order by bruger_id`);
    await db.exec(RET);
    expect((await db.query(`select id, founder_rabat_pct, koebergebyr_oere from public.betalinger order by id`)).rows).toEqual(foer.rows);
    expect((await db.query(`select bruger_id, oprettet_kl, genoptaget_kl from public.seller_founder order by bruger_id`)).rows)
      .toEqual(sf.rows);
    await db.exec(`create or replace function public.betalinger_b_prismodel() returns trigger language plpgsql
      set search_path = '' as $f$ begin return new; end $f$;`);
    await expect(db.exec(RET)).rejects.toThrow(/betalinger_b_prismodel: md5/);
  });
});
