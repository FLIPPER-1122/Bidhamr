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
const RETTELSER = readFileSync(path.join(MIGRATIONER, "20261102370000_boost_iap_rettelser.sql"), "utf8");
const RETTELSER2 = readFileSync(path.join(MIGRATIONER, "20261102400000_boost_iap_rettelser2.sql"), "utf8");

// mine_data som i produktion (med andre migrationers udvidelser).
const MINE_DATA_STUB = `
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
       || jsonb_build_object('henvis_en_ven', '{}'::jsonb);
  return v || jsonb_build_object('mitid', '{}'::jsonb);
end $$;
grant execute on function public.mine_data() to authenticated;
`;

const APP_ENDPOINTS_MIN_AUKTION_BOOST = `do $d$ begin execute replace(
  pg_get_functiondef('public.min_auktion_boost(uuid)'::regprocedure),
  $g$    when public.boost_kunst_afventer(p_auktion) then 'ikke_aktiv'$g$,
  $n$    when public.boost_kunst_afventer(p_auktion) then 'kunst_kontrol'$n$); end $d$;`;

const PRIVAT3 = "00000000-0000-4000-8000-0000000000a3";
const PRIVAT4 = "00000000-0000-4000-8000-0000000000a4";
const PRIVAT5 = "00000000-0000-4000-8000-0000000000a5";
const PRIVAT6 = "00000000-0000-4000-8000-0000000000a6";
const PRIVAT7 = "00000000-0000-4000-8000-0000000000a7";

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
  markering?: string | null;
};
function krediter(k: Krediter) {
  const platform = k.platform ?? "ios";
  return j(`select public.boost_iap_krediter($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11) as v`, [
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
    k.markering ?? null,
  ]);
}
// andel: milliunits af købets point (100000 = hele købet).
const refusion = (platform: string, ekstern: string | null, token: string | null, andel: number, kilde = "apple_notifikation") =>
  j(`select public.boost_iap_refusion($1, $2, $3, $4, $5) as v`, [platform, ekstern, token, andel, kilde]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(`insert into public.users (id, navn) values ('${PRIVAT3}', 'Privat 3'), ('${PRIVAT4}', 'Privat 4'),
                 ('${PRIVAT5}', 'Privat 5'), ('${PRIVAT6}', 'Privat 6'), ('${PRIVAT7}', 'Privat 7')`);
  await db.exec(BOOST);
  await db.exec(APP_ENDPOINTS_MIN_AUKTION_BOOST);
  await db.exec(PAKKER);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
  await db.exec(MINE_DATA_STUB);
  await db.exec(RETTELSER);
  // Rettelserne kan også køres igen.
  await db.exec(RETTELSER);
  await db.exec(RETTELSER2);
  await db.exec(RETTELSER2);
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
      await j(`select public.boost_iap_krediter($1, 'android', 'GPA.x', null, null, 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null, null) as v`, [PRIVAT4]),
    ).toEqual({ kode: "ugyldig" });
    expect(
      await j(`select public.boost_iap_krediter($1, 'ios', '1', null, 'tok-xxxxxxxxxx', 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null, null) as v`, [PRIVAT4]),
    ).toEqual({ kode: "ugyldig" });
    expect(
      await j(`select public.boost_iap_krediter($1, 'web', '1', null, null, 'dk.bidhamr.app.boost100', 'produktion', now(), null, null, null, null) as v`, [PRIVAT4]),
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
    expect(await refusion("android", "GPA.0000", null, 100000, "google_voided")).toMatchObject({ kode: "ukendt", ventende: true });
    expect(await refusion("ios", "x", null, 100000, "ukendt_kilde")).toEqual({ kode: "ugyldig" });
    expect(await refusion("ios", "x", null, 0)).toEqual({ kode: "ugyldig" });
    expect(await refusion("ios", "x", null, 100001)).toEqual({ kode: "ugyldig" });
    // Platformen skal passe: et Apple-id findes ikke som Google-køb.
    expect(await refusion("android", "2000000111", null, 100000, "google_voided")).toMatchObject({ kode: "ukendt", ventende: true });
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
      select has_function_privilege('service_role', 'public.boost_iap_krediter(uuid,text,text,text,text,text,text,timestamptz,bigint,text,text,text)', 'execute') as sr,
             has_function_privilege('authenticated', 'public.boost_iap_krediter(uuid,text,text,text,text,text,text,timestamptz,bigint,text,text,text)', 'execute') as auth,
             has_function_privilege('anon', 'public.boost_iap_refusion(text,text,text,integer,text,text,timestamptz)', 'execute') as anon_ref,
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

// 20261102370000_boost_iap_rettelser.sql
describe("rettelser: ventende refusion, markering, testkøb, Download dine data", () => {
  it("refusion før kreditering: gemmes som ventende, og købet afvises bagefter", async () => {
    expect(await refusion("ios", "6000000001", null, 100000)).toEqual({ kode: "ukendt", ventende: true });
    // Samme refusion igen: stadig én række.
    expect(await refusion("ios", "6000000001", null, 100000, "apple_historik")).toEqual({ kode: "ukendt", ventende: true });
    expect((await en<{ n: number }>(`select count(*)::int as n from public.boost_iap_ventende_refusioner where ekstern_id = '6000000001'`)).n).toBe(1);
    expect(await krediter({ bruger: PRIVAT5, ekstern: "6000000001" })).toEqual({ kode: "refunderet" });
    expect(await saldo(PRIVAT5)).toBe(0);
    const v = await en<{ afvist_antal: number }>(`select afvist_antal from public.boost_iap_ventende_refusioner where ekstern_id = '6000000001'`);
    expect(v.afvist_antal).toBe(1);
    // Google: void via token (uden ordre) afviser købet med samme token.
    expect(await refusion("android", null, "token-vvvvvvvvvv", 100000, "google_rtdn")).toEqual({ kode: "ukendt", ventende: true });
    expect(await krediter({ bruger: PRIVAT5, platform: "android", ekstern: "GPA.7777", token: "token-vvvvvvvvvv" })).toEqual({ kode: "refunderet" });
  });

  it("REFUND_REVERSED ophæver den ventende refusion - så krediteres købet", async () => {
    expect(await en<{ v: boolean }>(`select public.boost_iap_ventende_ophaev('ios', '6000000001', null) as v`)).toEqual({ v: true });
    expect(await en<{ v: boolean }>(`select public.boost_iap_ventende_ophaev('ios', '6000000001', null) as v`)).toEqual({ v: false });
    expect(await krediter({ bruger: PRIVAT5, ekstern: "6000000001" })).toMatchObject({ kode: "ok", point: 100 });
    // Ventende rækker slettes ikke.
    await expect(db.exec(`delete from public.boost_iap_ventende_refusioner`)).rejects.toThrow();
  });

  it("markering: promo kun Google i produktion, testkoeb_prod kun testkøb; låst", async () => {
    expect(await krediter({ bruger: PRIVAT6, ekstern: "6100000001", markering: "promo" })).toEqual({ kode: "ugyldig" });
    expect(await krediter({ bruger: PRIVAT6, ekstern: "6100000002", markering: "testkoeb_prod" })).toEqual({ kode: "ugyldig" });
    expect(await krediter({ bruger: PRIVAT6, ekstern: "6100000003", markering: "andet" })).toEqual({ kode: "ugyldig" });
    const promo = await krediter({ bruger: PRIVAT6, platform: "android", ekstern: "GPA.PROMO1", token: "token-promo00001", markering: "promo", pris: null, valuta: null });
    expect(promo).toMatchObject({ kode: "ok", point: 100 });
    const test = await krediter({ bruger: PRIVAT6, ekstern: "6100000004", miljoe: "test", markering: "testkoeb_prod", produkt: "dk.bidhamr.app.boost300" });
    expect(test).toMatchObject({ kode: "ok", point: 300 });
    await expect(db.exec(`update public.boost_iap_koeb set markering = null where id = '${String(promo.id)}'`)).rejects.toThrow();
  });

  it("Boost-salg: promo og testkøb i produktion tælles for sig, ikke som omsætning", async () => {
    const o = await j(`select public.boost_salg_oversigt($1, now() - interval '1 minute', null) as v`, [CHEF]);
    const google = o.google as Record<string, number>;
    const apple = o.apple as Record<string, number>;
    expect(google.promo_antal).toBe(1);
    expect(google.promo_point).toBe(100);
    expect(google.testkoeb_prod_antal).toBe(0);
    expect(apple.testkoeb_prod_antal).toBe(1);
    expect(apple.promo_antal).toBe(0);
    // Omsætningen er den samme som uden promo- og testkøbene.
    const alle = await j(`select public.boost_salg_oversigt($1, null, null) as v`, [CHEF]);
    const g = alle.google as Record<string, number>;
    const a = alle.apple as Record<string, number>;
    expect(g.antal).toBe(2);
    expect(g.listepris_oere).toBe(2 * 3900);
    // 5 fra før + 6000000001 (almindeligt køb); testkøbet tæller ikke.
    expect(a.antal).toBe(6);
    expect(a.test_antal).toBe(2);
  });

  it("testkøb i produktion trækkes tilbage samlet (én gang)", async () => {
    const foer = await saldo(PRIVAT6);
    expect(await j(`select public.boost_iap_tilbagekald_testkoeb() as v`)).toEqual({ tilbagekaldt: 1, point: 300 });
    expect(await saldo(PRIVAT6)).toBe(foer - 300);
    expect(await j(`select public.boost_iap_tilbagekald_testkoeb() as v`)).toEqual({ tilbagekaldt: 0, point: 0 });
    const k = await en<{ refusion_kilde: string }>(`select refusion_kilde from public.boost_iap_koeb where ekstern_id = '6100000004'`);
    expect(k.refusion_kilde).toBe("staff_testkoeb");
    // Promo-købet røres ikke.
    expect((await en<{ r: number }>(`select refunderet_point as r from public.boost_iap_koeb where ekstern_id = 'GPA.PROMO1'`)).r).toBe(0);
  });

  it("chefens visning har markeringen", async () => {
    const liste = (await en<{ v: { markering: string | null }[] }>(`select public.boost_iap_admin_bruger($1, $2) as v`, [CHEF, PRIVAT6])).v;
    expect(liste.map((x) => x.markering).sort()).toEqual(["promo", "testkoeb_prod"]);
  });

  it("Download dine data: boost-køb fra Stripe og appen - uden token og Stripe-id", async () => {
    await db.exec(`insert into public.boost_koeb (bruger_id, pakke_id, point, beloeb_oere, status, betalt_kl, stripe_payment_intent_id)
                   values ('${PRIVAT6}', 'point_100', 100, 3900, 'betalt', now(), 'pi_hemmelig123')`);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${PRIVAT6}', false);`);
    try {
      const d = await j(`select public.mine_data() as v`);
      expect(d.henvis_en_ven).toEqual({});
      const b = d.boost_koeb as { saldo: number; bidhamr_dk: Record<string, unknown>[]; appen: Record<string, unknown>[] };
      expect(b.bidhamr_dk).toHaveLength(1);
      expect(b.bidhamr_dk[0]).toMatchObject({ point: 100, beloeb_oere: 3900, status: "betalt" });
      expect(b.appen).toHaveLength(2);
      expect(b.appen.find((x) => x.promo === true)).toMatchObject({ platform: "Google Play", transaktion: "GPA.PROMO1", point: 100 });
      const tekst = JSON.stringify(d);
      expect(tekst).not.toContain("token-promo00001");
      expect(tekst).not.toContain("pi_hemmelig123");
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    }
    const def = (await en<{ d: string }>(`select pg_get_functiondef('public.mine_data()'::regprocedure) as d`)).d;
    expect(def.split("mine_data_boost(").length - 1).toBe(1);
  });

  it("kun service role: de nye funktioner og tabellen", async () => {
    const r = await en<Record<string, unknown>>(`
      select has_function_privilege('authenticated', 'public.boost_iap_tilbagekald_testkoeb()', 'execute') as auth_tilbage,
             has_function_privilege('service_role', 'public.boost_iap_tilbagekald_testkoeb()', 'execute') as sr_tilbage,
             has_function_privilege('authenticated', 'public.boost_iap_ventende_ophaev(text,text,text,text,timestamptz,text)', 'execute') as auth_ophaev,
             has_function_privilege('authenticated', 'public.boost_iap_laas_koeb(text,text)', 'execute') as auth_laas,
             has_function_privilege('authenticated', 'public.mine_data_boost(uuid)', 'execute') as auth_mdb,
             has_table_privilege('authenticated', 'public.boost_iap_ventende_refusioner', 'select') as auth_vent,
             has_table_privilege('service_role', 'public.boost_iap_ventende_refusioner', 'insert') as sr_vent_skriv`);
    expect(r).toEqual({ auth_tilbage: false, sr_tilbage: true, auth_ophaev: false, auth_laas: false, auth_mdb: false, auth_vent: false, sr_vent_skriv: false });
  });
});

// 20261102400000_boost_iap_rettelser2.sql
describe("rettelser 2: REFUND_REVERSED holder, og testkøb låses i fast rækkefølge", () => {
  // Apples notifikation: notificationUUID og signedDate.
  const apple = (ekstern: string, uuid: string, signeret: string, kilde = "apple_notifikation") =>
    j(`select public.boost_iap_refusion('ios', $1, null, 100000, $2, $3, $4::timestamptz) as v`, [ekstern, kilde, uuid, signeret]);
  const ophaev = async (ekstern: string, uuid: string | null, signeret: string | null, kilde = "apple_notifikation") =>
    (await en<{ v: boolean }>(`select public.boost_iap_ventende_ophaev('ios', $1, null, $2, $3::timestamptz, $4) as v`, [ekstern, uuid, signeret, kilde])).v;
  const raekke = (ekstern: string) =>
    en<Record<string, unknown>>(
      `select ophaevet_kl, refusion_notifikation, refusion_signeret_kl, ophaevet_notifikation, ophaevet_signeret_kl
         from public.boost_iap_ventende_refusioner where platform = 'ios' and ekstern_id = $1`,
      [ekstern],
    );

  it("REFUND → REFUND_REVERSED → samme REFUND igen (daglig historik): købet kan krediteres", async () => {
    expect(await apple("7000000001", "uuid-r1", "2026-10-20T10:00:00Z")).toEqual({ kode: "ukendt", ventende: true });
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000001" })).toEqual({ kode: "refunderet" });
    expect(await ophaev("7000000001", "uuid-rr1", "2026-10-21T10:00:00Z")).toBe(true);
    // Cron'en kører den samme REFUND igen (historikken): genåbner ikke.
    expect(await apple("7000000001", "uuid-r1", "2026-10-20T10:00:00Z", "apple_historik")).toEqual({ kode: "ukendt", ventende: false, ophaevet: true });
    expect(await apple("7000000001", "uuid-r1", "2026-10-20T10:00:00Z")).toMatchObject({ ophaevet: true });
    // Uden tidspunkt kan en refusion heller ikke genåbne.
    expect(await j(`select public.boost_iap_refusion('ios', '7000000001', null, 100000, 'apple_opslag') as v`)).toMatchObject({ ophaevet: true });
    expect((await raekke("7000000001")).ophaevet_kl).not.toBeNull();
    // En gentaget REFUND_REVERSED ændrer intet.
    expect(await ophaev("7000000001", "uuid-rr1", "2026-10-21T10:00:00Z", "apple_historik")).toBe(false);
    // Bagefter kan købet krediteres.
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000001" })).toMatchObject({ kode: "ok", point: 100 });
    expect(await saldo(PRIVAT7)).toBe(100);
  });

  it("en NY refusion efter ophævelsen genåbner rækken; en ældre REFUND_REVERSED ophæver den ikke", async () => {
    expect(await apple("7000000002", "uuid-r2", "2026-10-20T10:00:00Z")).toEqual({ kode: "ukendt", ventende: true });
    expect(await ophaev("7000000002", "uuid-rr2", "2026-10-21T10:00:00Z")).toBe(true);
    // Apple refunderer igen (nyere signedDate): blokeret igen.
    expect(await apple("7000000002", "uuid-r3", "2026-10-22T10:00:00Z")).toEqual({ kode: "ukendt", ventende: true });
    const r = await raekke("7000000002");
    expect(r.ophaevet_kl).toBeNull();
    expect(r.refusion_notifikation).toBe("uuid-r3");
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000002" })).toEqual({ kode: "refunderet" });
    // Den gamle REFUND_REVERSED fra historikken ophæver ikke den nye refusion.
    expect(await ophaev("7000000002", "uuid-rr2", "2026-10-21T10:00:00Z", "apple_historik")).toBe(false);
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000002" })).toEqual({ kode: "refunderet" });
    // En nyere REFUND_REVERSED gør.
    expect(await ophaev("7000000002", "uuid-rr3", "2026-10-23T10:00:00Z")).toBe(true);
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000002" })).toMatchObject({ kode: "ok" });
  });

  it("REFUND_REVERSED før REFUND (tabt webhook): den ældre REFUND blokerer ikke købet", async () => {
    expect(await ophaev("7000000003", "uuid-rr4", "2026-10-21T10:00:00Z", "apple_historik")).toBe(false);
    expect((await raekke("7000000003")).ophaevet_signeret_kl).not.toBeNull();
    expect(await apple("7000000003", "uuid-r4", "2026-10-20T10:00:00Z", "apple_historik")).toMatchObject({ ophaevet: true });
    expect(await krediter({ bruger: PRIVAT7, ekstern: "7000000003" })).toMatchObject({ kode: "ok" });
  });

  it("ugyldige kald til ophævelsen og rettigheder", async () => {
    expect(await ophaev("", null, null)).toBe(false);
    expect(await ophaev("7000000009", null, null, "google_rtdn")).toBe(false);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.boost_iap_ventende_refusioner where ekstern_id = '7000000009'`)).n).toBe(0);
    const r = await en<Record<string, unknown>>(`
      select has_function_privilege('authenticated', 'public.boost_iap_refusion(text,text,text,integer,text,text,timestamptz)', 'execute') as auth_ref,
             has_function_privilege('service_role', 'public.boost_iap_refusion(text,text,text,integer,text,text,timestamptz)', 'execute') as sr_ref,
             has_function_privilege('anon', 'public.boost_iap_ventende_ophaev(text,text,text,text,timestamptz,text)', 'execute') as anon_oph,
             has_function_privilege('service_role', 'public.boost_iap_ventende_ophaev(text,text,text,text,timestamptz,text)', 'execute') as sr_oph,
             to_regprocedure('public.boost_iap_refusion(text,text,text,integer,text)') is null as gammel_ref_vaek,
             to_regprocedure('public.boost_iap_ventende_ophaev(text,text,text)') is null as gammel_oph_vaek`);
    expect(r).toEqual({ auth_ref: false, sr_ref: true, anon_oph: false, sr_oph: true, gammel_ref_vaek: true, gammel_oph_vaek: true });
  });

  it("tilbagekald af testkøb: flere køb og brugere i én kørsel, én gang, låse i fast rækkefølge", async () => {
    await krediter({ bruger: PRIVAT7, ekstern: "7100000001", miljoe: "test", markering: "testkoeb_prod" });
    await krediter({ bruger: PRIVAT6, ekstern: "7100000002", miljoe: "test", markering: "testkoeb_prod" });
    await krediter({ bruger: PRIVAT7, platform: "android", ekstern: "GPA.TEST7", token: "token-test70001", miljoe: "test", markering: "testkoeb_prod" });
    const foer7 = await saldo(PRIVAT7);
    const foer6 = await saldo(PRIVAT6);
    expect(await j(`select public.boost_iap_tilbagekald_testkoeb() as v`)).toEqual({ tilbagekaldt: 3, point: 300 });
    expect(await saldo(PRIVAT7)).toBe(foer7 - 200);
    expect(await saldo(PRIVAT6)).toBe(foer6 - 100);
    expect(await j(`select public.boost_iap_tilbagekald_testkoeb() as v`)).toEqual({ tilbagekaldt: 0, point: 0 });
    // Låsene tages i fast rækkefølge: tokens, transaktioner, pointkonti, så refusionerne.
    const def = (await en<{ d: string }>(`select pg_get_functiondef('public.boost_iap_tilbagekald_testkoeb()'::regprocedure) as d`)).d;
    const t = def.indexOf("'t:' || k.google_token");
    const e = def.indexOf("'e:' || k.ekstern_id");
    const b = def.indexOf("boost_laas_bruger(k.bruger_id)");
    const f = def.indexOf("boost_iap_refusion(");
    expect(t > 0 && t < e && e < b && b < f).toBe(true);
  });
});
