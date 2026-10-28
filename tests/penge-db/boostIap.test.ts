// Migrationen 20261102320000_boost_iap.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Oven på 20261023030000_boost.sql og
// 20261026010000_boost_pakker.sql (samme stubs som boostPakker.test.ts).
// Migrationen køres TO gange (idempotent). Testes:
//   - kreditering med point fra produktet (klienten bestemmer intet),
//   - idempotens: samme transaktion/ordre/token giver aldrig point to gange
//     og aldrig til en anden bruger - heller ikke på tværs af platforme,
//   - firma og spærret konto afvises,
//   - refusion: kumulativt mål, saldo i minus, minus blokerer boost, men
//     ikke nye indbetalinger; tilbageførsel/staff-træk kan stadig ikke føre
//     saldoen under 0; chefen kan lægge point til en negativ saldo,
//   - webhook-idempotens, cron-claim og consume,
//   - chefens oversigt (Stripe, Apple, Google adskilt) og rettigheder.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHEF, PRIVAT, PRIVAT2, FIRMA, SPAERRET, STUB } from "./boostStub";

const MIGRATIONER = path.resolve(import.meta.dirname, "../../supabase/migrations");
const BOOST = readFileSync(path.join(MIGRATIONER, "20261023030000_boost.sql"), "utf8");
const PAKKER = readFileSync(path.join(MIGRATIONER, "20261026010000_boost_pakker.sql"), "utf8");
const MIGRATION = readFileSync(path.join(MIGRATIONER, "20261102320000_boost_iap.sql"), "utf8");

const APP_ENDPOINTS_MIN_AUKTION_BOOST = `do $d$ begin execute replace(
  pg_get_functiondef('public.min_auktion_boost(uuid)'::regprocedure),
  $g$    when public.boost_kunst_afventer(p_auktion) then 'ikke_aktiv'$g$,
  $n$    when public.boost_kunst_afventer(p_auktion) then 'kunst_kontrol'$n$); end $d$;`;

const PRIVAT3 = "00000000-0000-4000-8000-0000000000a3";
const PRIVAT4 = "00000000-0000-4000-8000-0000000000a4";

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}
const saldo = async (b: string) => (await en<{ s: number }>(`select public.boost_saldo($1) as s`, [b])).s;

type Krediter = {
  bruger: string;
  platform?: "ios" | "android";
  ekstern?: string;
  token?: string | null;
  produkt?: string;
  miljoe?: string;
  pris?: number | null;
  valuta?: string | null;
};
function krediter(k: Krediter) {
  const platform = k.platform ?? "ios";
  return j(`select public.boost_iap_krediter($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10) as v`, [
    k.bruger,
    platform,
    k.ekstern ?? randomUUID(),
    platform === "ios" ? "orig-1" : null,
    platform === "android" ? (k.token === undefined ? `tok-${randomUUID()}` : k.token) : null,
    k.produkt ?? "dk.bidhamr.app.boost100",
    k.miljoe ?? "produktion",
    k.pris === undefined ? 39000 : k.pris,
    k.valuta === undefined ? "DKK" : k.valuta,
    platform === "ios" ? "DNK" : "DK",
  ]);
}
// andel: milliunits af købets point (100000 = hele købet).
const refusion = (platform: string, ekstern: string | null, token: string | null, andel: number, kilde = "apple_notifikation") =>
  j(`select public.boost_iap_refusion($1, $2, $3, $4, $5) as v`, [platform, ekstern, token, andel, kilde]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(`insert into public.users (id, navn) values ('${PRIVAT3}', 'Privat 3'), ('${PRIVAT4}', 'Privat 4')`);
  await db.exec(BOOST);
  await db.exec(APP_ENDPOINTS_MIN_AUKTION_BOOST);
  await db.exec(PAKKER);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

describe("produkterne", () => {
  it("tre forbrugsprodukter med 100, 300 og 700 point", async () => {
    const r = await db.query<{ produkt_id: string; point: number; pakke_id: string }>(
      `select produkt_id, point, pakke_id from public.boost_iap_produkter order by sortering`,
    );
    expect(r.rows).toEqual([
      { produkt_id: "dk.bidhamr.app.boost100", point: 100, pakke_id: "point_100" },
      { produkt_id: "dk.bidhamr.app.boost300", point: 300, pakke_id: "point_300" },
      { produkt_id: "dk.bidhamr.app.boost700", point: 700, pakke_id: "point_700" },
    ]);
  });
  it("point kan ikke ændres, og produkter slettes ikke", async () => {
    await expect(db.exec(`update public.boost_iap_produkter set point = 9999 where produkt_id = 'dk.bidhamr.app.boost100'`)).rejects.toThrow();
    await expect(db.exec(`delete from public.boost_iap_produkter where produkt_id = 'dk.bidhamr.app.boost100'`)).rejects.toThrow();
  });
});

describe("kreditering og idempotens", () => {
  it("Apple: point fra produktet, posteringstype koeb_apple", async () => {
    const r = await krediter({ bruger: PRIVAT, ekstern: "2000000111", produkt: "dk.bidhamr.app.boost300" });
    expect(r).toMatchObject({ kode: "ok", point: 300, saldo: 300 });
    const p = await en<{ type: string; point: number; saldo_efter: number }>(
      `select type, point, saldo_efter from public.boost_posteringer where iap_koeb_id = $1`,
      [r.id],
    );
    expect(p).toEqual({ type: "koeb_apple", point: 300, saldo_efter: 300 });
  });

  it("samme transaktion igen: 'allerede', ingen nye point", async () => {
    const r = await krediter({ bruger: PRIVAT, ekstern: "2000000111", produkt: "dk.bidhamr.app.boost300" });
    expect(r).toMatchObject({ kode: "allerede", point: 300, saldo: 300 });
    expect(await saldo(PRIVAT)).toBe(300);
  });

  it("samme transaktion fra en anden bruger: 'anden_bruger', ingen point", async () => {
    const r = await krediter({ bruger: PRIVAT2, ekstern: "2000000111" });
    expect(r).toEqual({ kode: "anden_bruger" });
    expect(await saldo(PRIVAT2)).toBe(0);
  });

  it("Google: samme ordre eller samme token giver ikke point igen", async () => {
    const r = await krediter({ bruger: PRIVAT2, platform: "android", ekstern: "GPA.1111-2222-3333-44444", token: "token-aaaaaaaaaa" });
    expect(r).toMatchObject({ kode: "ok", point: 100, saldo: 100 });
    expect(
      await krediter({ bruger: PRIVAT2, platform: "android", ekstern: "GPA.9999-2222-3333-44444", token: "token-aaaaaaaaaa" }),
    ).toMatchObject({ kode: "allerede", forbrugt: false });
    expect(
      await krediter({ bruger: PRIVAT3, platform: "android", ekstern: "GPA.1111-2222-3333-44444", token: "token-bbbbbbbbbb" }),
    ).toEqual({ kode: "anden_bruger" });
    // Et Apple-id med samme tekst som en Google-ordre er et andet køb.
    expect((await krediter({ bruger: PRIVAT3, platform: "ios", ekstern: "GPA.1111-2222-3333-44444" })).kode).toBe("ok");
    expect(await saldo(PRIVAT2)).toBe(100);
  });

  it("firma og spærret konto får ingen point; ukendt produkt afvises", async () => {
    expect(await krediter({ bruger: FIRMA })).toEqual({ kode: "erhverv" });
    expect(await krediter({ bruger: SPAERRET })).toEqual({ kode: "spaerret" });
    expect(await krediter({ bruger: PRIVAT4, produkt: "dk.bidhamr.app.boost999" })).toEqual({ kode: "produkt_ukendt" });
    expect(await saldo(FIRMA)).toBe(0);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.boost_iap_koeb where bruger_id in ($1, $2)`, [FIRMA, SPAERRET])).n).toBe(0);
  });

  it("ugyldige kald afvises", async () => {
    // Android uden token / iOS med token.
    expect(
      await j(`select public.boost_iap_krediter($1, 'android', 'GPA.x', null, null, 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null) as v`, [PRIVAT4]),
    ).toEqual({ kode: "ugyldig" });
    expect(
      await j(`select public.boost_iap_krediter($1, 'ios', '1', null, 'tok-xxxxxxxxxx', 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null) as v`, [PRIVAT4]),
    ).toEqual({ kode: "ugyldig" });
    expect(
      await j(`select public.boost_iap_krediter($1, 'web', '1', null, null, 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null) as v`, [PRIVAT4]),
    ).toEqual({ kode: "ugyldig" });
  });

  it("købet er låst: køber, point og pris kan ikke ændres, og det slettes ikke", async () => {
    const id = (await en<{ id: string }>(`select id from public.boost_iap_koeb where ekstern_id = '2000000111'`)).id;
    await expect(db.exec(`update public.boost_iap_koeb set bruger_id = '${PRIVAT2}' where id = '${id}'`)).rejects.toThrow();
    await expect(db.exec(`update public.boost_iap_koeb set point = 700 where id = '${id}'`)).rejects.toThrow();
    await expect(db.exec(`update public.boost_iap_koeb set pris_milli = 1 where id = '${id}'`)).rejects.toThrow();
    await expect(db.exec(`delete from public.boost_iap_koeb where id = '${id}'`)).rejects.toThrow();
    await expect(db.exec(`delete from public.boost_posteringer where iap_koeb_id = '${id}'`)).rejects.toThrow();
  });
});

describe("refusion og saldo i minus", () => {
  it("brugte point: saldoen går i minus, og boost er blokeret", async () => {
    // PRIVAT4 køber 100 point og bruger 100 (to boost).
    const k = await krediter({ bruger: PRIVAT4, ekstern: "3000000001" });
    expect(k.kode).toBe("ok");
    for (let i = 0; i < 2; i++) {
      const a = (await en<{ id: string }>(`insert into public.auctions (bruger_id, titel) values ($1, 'Lampe') returning id`, [PRIVAT4])).id;
      expect((await j(`select public.boost_brug($1, $2, $3) as v`, [PRIVAT4, a, randomUUID()])).kode).toBe("ok");
    }
    expect(await saldo(PRIVAT4)).toBe(0);

    const r = await refusion("ios", "3000000001", null, 100000);
    expect(r).toMatchObject({ kode: "tilbagefoert", point: 100, saldo: -100, i_minus: true, bruger_id: PRIVAT4 });
    expect(await saldo(PRIVAT4)).toBe(-100);
    const koeb = await en<Record<string, unknown>>(
      `select refunderet_point, kraever_opmaerksomhed, opmaerksomhed_tekst like '%i minus%' as tekst from public.boost_iap_koeb where ekstern_id = '3000000001'`,
    );
    expect(koeb).toEqual({ refunderet_point: 100, kraever_opmaerksomhed: true, tekst: true });

    // Nyt boost afvises (for få point).
    const a = (await en<{ id: string }>(`insert into public.auctions (bruger_id, titel) values ($1, 'Stol') returning id`, [PRIVAT4])).id;
    expect(await j(`select public.boost_brug($1, $2, $3) as v`, [PRIVAT4, a, randomUUID()])).toMatchObject({
      kode: "for_faa_point",
      saldo: -100,
    });
  });

  it("samme refusion igen (gentaget webhook): intet trækkes", async () => {
    expect(await refusion("ios", "3000000001", null, 100000)).toMatchObject({ kode: "allerede", saldo: -100 });
    expect(await saldo(PRIVAT4)).toBe(-100);
  });

  it("indbetalinger virker i minus; træk under 0 afvises stadig", async () => {
    // Et nyt køb i appen: -100 + 300 = 200.
    expect(await krediter({ bruger: PRIVAT4, ekstern: "3000000002", produkt: "dk.bidhamr.app.boost300" })).toMatchObject({
      kode: "ok",
      saldo: 200,
    });
    // Refunderes det nye: tilbage til -100.
    expect(await refusion("ios", "3000000002", null, 100000)).toMatchObject({ kode: "tilbagefoert", saldo: -100 });
    // Chefen kan lægge point til (også et mindre antal end minusset).
    expect(await j(`select public.boost_staff_justering($1, $2, 10, 'Delvis eftergivelse', $3) as v`, [CHEF, PRIVAT4, randomUUID()])).toMatchObject({
      kode: "ok",
      saldo: -90,
    });
    // Men ikke trække mere.
    expect(await j(`select public.boost_staff_justering($1, $2, -10, 'Træk', $3) as v`, [CHEF, PRIVAT4, randomUUID()])).toMatchObject({
      kode: "for_lav_saldo",
    });
    // Ledgeren selv afviser et forbrug i minus (BHB01), også direkte.
    await expect(
      db.exec(`insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, staff_id, begrundelse, idempotens_noegle)
               values ('${PRIVAT4}', 'staff', -5, 0, '${CHEF}', 'x', '${randomUUID()}')`),
    ).rejects.toThrow(/ikke point nok/);
    expect(await saldo(PRIVAT4)).toBe(-90);
  });

  it("en tilbageførsel (Stripe/salg) klippes til 0 i minus - gør ikke minusset større", async () => {
    // En betaling, der har givet optjening, og som tilbageføres.
    const b = (await en<{ id: string }>(`insert into public.betalinger (seller_id) values ($1) returning id`, [PRIVAT4])).id;
    await db.exec(`insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, betaling_id) values ('${PRIVAT4}', 'optjening', 10, 0, '${b}')`);
    expect(await saldo(PRIVAT4)).toBe(-80);
    await db.exec(`insert into public.boost_posteringer (bruger_id, type, point, oensket_point, saldo_efter, betaling_id)
                   values ('${PRIVAT4}', 'tilbagefoersel', 0, 10, 0, '${b}')`);
    expect(await saldo(PRIVAT4)).toBe(-80);
  });

  it("delvis refusion (Apple prorated) og derefter fuld: kumulativt", async () => {
    const k = await krediter({ bruger: PRIVAT3, ekstern: "4000000001", produkt: "dk.bidhamr.app.boost700" });
    const foer = await saldo(PRIVAT3);
    expect(await refusion("ios", "4000000001", null, 50000)).toMatchObject({ kode: "tilbagefoert", point: 350 });
    expect(await refusion("ios", "4000000001", null, 20000)).toMatchObject({ kode: "allerede" });
    expect(await refusion("ios", "4000000001", null, 100000)).toMatchObject({ kode: "tilbagefoert", point: 350 });
    expect(await saldo(PRIVAT3)).toBe(foer - 700);
    const n = (await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where iap_koeb_id = $1 and type = 'refusion_apple'`, [k.id])).n;
    expect(n).toBe(2);
  });

  it("Google: refusion via token; ukendt køb: 'ukendt'", async () => {
    expect(await refusion("android", null, "token-aaaaaaaaaa", 100000, "google_rtdn")).toMatchObject({
      kode: "tilbagefoert",
      point: 100,
      saldo: 0,
      i_minus: false,
    });
    expect(await refusion("android", "GPA.1111-2222-3333-44444", null, 100000, "google_voided")).toMatchObject({ kode: "allerede" });
    expect(await refusion("android", "GPA.0000", null, 100000, "google_voided")).toEqual({ kode: "ukendt" });
    expect(await refusion("ios", "x", null, 100000, "ukendt_kilde")).toEqual({ kode: "ugyldig" });
    expect(await refusion("ios", "x", null, 0)).toEqual({ kode: "ugyldig" });
    expect(await refusion("ios", "x", null, 100001)).toEqual({ kode: "ugyldig" });
    // Platformen skal passe: et Apple-id findes ikke som Google-køb.
    expect(await refusion("android", "2000000111", null, 100000, "google_voided")).toEqual({ kode: "ukendt" });
  });
});

describe("consume, webhooks og cron", () => {
  it("consume: fejl tælles, ok gemmes én gang", async () => {
    const r = await krediter({ bruger: PRIVAT2, platform: "android", ekstern: "GPA.5555", token: "token-cccccccccc" });
    expect(r.kode).toBe("ok");
    const mangler = async () =>
      (await db.query<{ id: string }>(`select id from public.boost_iap_mangler_forbrug(50)`)).rows.map((x) => x.id);
    expect(await mangler()).toContain(r.id);
    expect((await en<{ v: boolean }>(`select public.boost_iap_forbrug_resultat($1, false, 'timeout') as v`, [r.id])).v).toBe(true);
    expect((await en<{ v: boolean }>(`select public.boost_iap_forbrug_resultat($1, true) as v`, [r.id])).v).toBe(true);
    expect((await en<{ v: boolean }>(`select public.boost_iap_forbrug_resultat($1, true) as v`, [r.id])).v).toBe(false);
    expect(await mangler()).not.toContain(r.id);
    expect(await krediter({ bruger: PRIVAT2, platform: "android", ekstern: "GPA.5555", token: "token-cccccccccc" })).toMatchObject({
      kode: "allerede",
      forbrugt: true,
    });
  });

  it("webhook-idempotens: ny, gentaget, behandlet", async () => {
    const start = async () => (await en<{ v: string }>(`select public.boost_iap_notifikation_start('ios', 'uuid-1', 'REFUND') as v`)).v;
    expect(await start()).toBe("ny");
    expect(await start()).toBe("gentaget");
    await db.exec(`select public.boost_iap_notifikation_slut('ios', 'uuid-1', 'tilbagefoert')`);
    expect(await start()).toBe("behandlet");
  });

  it("cron-claim: én gang pr. døgn", async () => {
    const claim = async () => (await en<{ v: boolean }>(`select public.boost_iap_cron_claim(20) as v`)).v;
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    await db.exec(`select public.boost_iap_cron_ok()`);
    expect(await claim()).toBe(false);
  });

  it("note til chefen (REFUND_REVERSED) én gang", async () => {
    const t = "Apple har trukket refusionen tilbage.";
    expect((await en<{ v: string }>(`select public.boost_iap_opmaerksomhed('ios', '4000000001', $1) as v`, [t])).v).toBe(PRIVAT3);
    await db.exec(`select public.boost_iap_opmaerksomhed('ios', '4000000001', '${t}')`);
    const tekst = (await en<{ t: string }>(`select opmaerksomhed_tekst as t from public.boost_iap_koeb where ekstern_id = '4000000001'`)).t;
    expect(tekst.split(t).length - 1).toBe(1);
  });
});

describe("chefens oversigt og rettigheder", () => {
  it("Stripe, Apple og Google hver for sig; testkøb tælles for sig", async () => {
    await krediter({ bruger: PRIVAT2, platform: "ios", ekstern: "5000000001", miljoe: "test" });
    const o = await j(`select public.boost_salg_oversigt($1, null, null) as v`, [CHEF]);
    const apple = o.apple as Record<string, number>;
    const google = o.google as Record<string, number>;
    // Apple (produktion): 2000000111 (300), GPA.1111 (100, ios), 3000000001, 3000000002, 4000000001.
    expect(apple.antal).toBe(5);
    expect(apple.test_antal).toBe(1);
    expect(apple.brutto_oere).toBe(5 * 3900);
    expect(apple.refunderet_antal).toBe(3);
    expect(apple.refunderet_point).toBe(100 + 300 + 700);
    expect(google.antal).toBe(2);
    expect(google.listepris_oere).toBe(2 * 3900);
    expect(google.refunderet_antal).toBe(1);
    expect(o.stripe).toEqual({ antal: 0, brutto_oere: 0, refunderet_antal: 0, refunderet_oere: 0 });
    expect(o.i_minus).toBeGreaterThanOrEqual(1);
    expect(await j(`select public.boost_salg_oversigt($1, null, null) as v`, [PRIVAT])).toBeNull();
    expect(await j(`select public.boost_iap_admin_bruger($1, $2) as v`, [PRIVAT, PRIVAT4])).toBeNull();
    const liste = (await en<{ v: unknown[] }>(`select public.boost_iap_admin_bruger($1, $2) as v`, [CHEF, PRIVAT4])).v;
    expect(liste).toHaveLength(2);
  });

  it("kun service role kan kalde serverfunktionerne; brugeren ser egne køb uden token", async () => {
    const r = await en<Record<string, unknown>>(`
      select has_function_privilege('service_role', 'public.boost_iap_krediter(uuid,text,text,text,text,text,text,timestamptz,bigint,text,text)', 'execute') as sr,
             has_function_privilege('authenticated', 'public.boost_iap_krediter(uuid,text,text,text,text,text,text,timestamptz,bigint,text,text)', 'execute') as auth,
             has_function_privilege('anon', 'public.boost_iap_refusion(text,text,text,integer,text)', 'execute') as anon_ref,
             has_function_privilege('authenticated', 'public.boost_salg_oversigt(uuid,timestamptz,timestamptz)', 'execute') as auth_overs,
             has_table_privilege('authenticated', 'public.boost_iap_koeb', 'insert') as auth_skriv,
             has_table_privilege('service_role', 'public.boost_iap_koeb', 'update') as sr_skriv,
             has_column_privilege('authenticated', 'public.boost_iap_koeb', 'google_token', 'select') as auth_token,
             has_column_privilege('authenticated', 'public.boost_iap_koeb', 'point', 'select') as auth_point`);
    expect(r).toEqual({
      sr: true,
      auth: false,
      anon_ref: false,
      auth_overs: false,
      auth_skriv: false,
      sr_skriv: false,
      auth_token: false,
      auth_point: true,
    });
  });

  it("mine_point viser den negative saldo og de nye typer i historikken", async () => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${PRIVAT4}', false);`);
    try {
      const m = await j(`select public.mine_point() as v`);
      expect(m.saldo).toBe(-80);
      const typer = (m.historik as { type: string }[]).map((h) => h.type);
      expect(typer).toEqual(expect.arrayContaining(["koeb_apple", "refusion_apple"]));
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    }
  });
});
