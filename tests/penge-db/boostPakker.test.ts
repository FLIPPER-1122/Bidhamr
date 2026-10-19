// Migrationen 20261026010000_boost_pakker.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Oven på 20261023030000_boost.sql (samme
// stubs som boost.test.ts) og min_auktion_boost, som
// 20261025010000_app_endpoints.sql efterlader den (md5-drift-tjekket).
// Migrationen køres TO gange. Testes: pakkevalg (serveren vælger pris og
// point ud fra id'et), låst pris og pakke på købet, afvist ukendt eller
// inaktiv pakke, idempotens ved skift af pakke (et åbent køb af en anden
// pakke genbruges aldrig), kreditering, tilbageførsel og faktura med
// pakkens point og beløb, mine_point/min_auktion_boost og rettigheder.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHEF, PRIVAT, PRIVAT2, FIRMA, STUB } from "./boostStub";

const MIGRATIONER = path.resolve(import.meta.dirname, "../../supabase/migrations");
const BOOST = readFileSync(path.join(MIGRATIONER, "20261023030000_boost.sql"), "utf8");
const MIGRATION = readFileSync(path.join(MIGRATIONER, "20261026010000_boost_pakker.sql"), "utf8");

// min_auktion_boost som efter 20261025010000_app_endpoints.sql (grund
// 'kunst_kontrol') - den udgave, der ligger i produktion.
const APP_ENDPOINTS_MIN_AUKTION_BOOST = `do $d$ begin execute replace(
  pg_get_functiondef('public.min_auktion_boost(uuid)'::regprocedure),
  $g$    when public.boost_kunst_afventer(p_auktion) then 'ikke_aktiv'$g$,
  $n$    when public.boost_kunst_afventer(p_auktion) then 'kunst_kontrol'$n$); end $d$;`;

const PRIVAT3 = "00000000-0000-4000-8000-0000000000a3";

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}
const saldo = async (b: string) => (await en<{ s: number }>(`select public.boost_saldo($1) as s`, [b])).s;
const start = (b: string, pakke: string | null = null) =>
  pakke === null
    ? j(`select public.boost_koeb_start($1) as v`, [b])
    : j(`select public.boost_koeb_start($1, false, $2) as v`, [b, pakke]);
const piFor = (s: Record<string, unknown>) => `pi_test_${String(s.id).replace(/-/g, "")}_${s.pi_forsoeg}`;
const gemPi = async (s: Record<string, unknown>) => {
  const pi = piFor(s);
  expect((await en<{ v: string }>(`select public.boost_koeb_gem_pi($1, $2, $3) as v`, [s.id, pi, s.pi_forsoeg])).v).toBe("ok");
  return pi;
};
const registrer = (pi: string, status: string, beloeb: number | null = null, charge: string | null = null) =>
  j(`select public.boost_koeb_registrer($1, $2, $3, $4, null) as v`, [pi, status, charge, beloeb]);
const koeb = (id: unknown) =>
  en<{ status: string; point: number; beloeb_oere: number; pakke_id: string | null }>(
    `select status, point, beloeb_oere, pakke_id from public.boost_koeb where id = $1`,
    [id],
  );

// Et betalt køb af pakken. Svar: købets id, PaymentIntent og charge.
async function betaltKoeb(b: string, pakke: string, beloeb: number) {
  const s = await start(b, pakke);
  expect(s.kode).toBe("ok");
  const pi = await gemPi(s);
  const charge = `ch_${String(s.id).replace(/-/g, "").slice(0, 12)}`;
  expect((await registrer(pi, "succeeded", beloeb, charge)).kode).toBe("betalt");
  return { id: s.id as string, pi, charge };
}

async function nulstil(b: string) {
  const s = await saldo(b);
  if (s > 0) await j(`select public.boost_staff_justering($1, $2, $3, 'test', $4) as v`, [CHEF, b, -s, randomUUID()]);
}

async function somBruger<T>(b: string, f: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${b}', false);`);
  try {
    return await f();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(`insert into public.users (id, navn) values ('${PRIVAT3}', 'Privat 3')`);
  await db.exec(BOOST);
  await db.exec(APP_ENDPOINTS_MIN_AUKTION_BOOST);
  // Et ubetalt køb fra før pakkerne (100 point, 39 kr.) - får 'point_100'.
  await db.exec(`select public.boost_koeb_start('${PRIVAT3}')`);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("de tre pakker med pris, boost, besparelse og 'Bedste køb'", async () => {
    const liste = (await en<{ v: unknown[] }>(`select public.boost_pakke_liste() as v`)).v;
    expect(liste).toEqual([
      { id: "point_100", point: 100, pris_oere: 3900, boost: 2, spar_oere: 0, bedste: false },
      { id: "point_300", point: 300, pris_oere: 9900, boost: 6, spar_oere: 1800, bedste: false },
      { id: "point_700", point: 700, pris_oere: 19900, boost: 14, spar_oere: 7400, bedste: true },
    ]);
    expect((await en<{ v: unknown }>(`select public.boost_standard_pakke() as v`)).v).toEqual({
      id: "point_100",
      point: 100,
      pris_oere: 3900,
    });
  });

  it("et køb fra før pakkerne får point_100", async () => {
    const r = await en<{ pakke_id: string }>(`select pakke_id from public.boost_koeb where bruger_id = $1`, [PRIVAT3]);
    expect(r.pakke_id).toBe("point_100");
  });

  it("den gamle boost_koeb_start(uuid, boolean) er væk; kun service role har den nye", async () => {
    const r = await en<Record<string, unknown>>(`
      select to_regprocedure('public.boost_koeb_start(uuid,boolean)') is null as gammel_vaek,
             has_function_privilege('service_role', 'public.boost_koeb_start(uuid,boolean,text)', 'execute') as sr,
             has_function_privilege('authenticated', 'public.boost_koeb_start(uuid,boolean,text)', 'execute') as auth,
             has_function_privilege('anon', 'public.boost_koeb_start(uuid,boolean,text)', 'execute') as anon,
             has_function_privilege('authenticated', 'public.boost_pakke_liste()', 'execute') as auth_liste,
             has_function_privilege('authenticated', 'public.mine_point()', 'execute') as auth_mine,
             has_function_privilege('anon', 'public.mine_point()', 'execute') as anon_mine,
             has_table_privilege('authenticated', 'public.boost_pakker', 'insert') as auth_skriv,
             has_table_privilege('service_role', 'public.boost_pakker', 'update') as sr_skriv`);
    expect(r).toEqual({
      gammel_vaek: true,
      sr: true,
      auth: false,
      anon: false,
      auth_liste: false,
      auth_mine: true,
      anon_mine: false,
      auth_skriv: false,
      sr_skriv: false,
    });
  });

  it("drift: en ændret mine_point stopper migrationen", async () => {
    const d = new PGlite();
    try {
      await d.exec(STUB);
      await d.exec(BOOST);
      await d.exec(APP_ENDPOINTS_MIN_AUKTION_BOOST);
      await d.exec(`do $x$ begin execute replace(pg_get_functiondef('public.mine_point()'::regprocedure),
        $g$'point_pr_salg', s.point_pr_salg,$g$, $n$'point_pr_salg', s.point_pr_salg + 0,$n$); end $x$;`);
      await expect(d.exec(MIGRATION)).rejects.toThrow(/hverken gammel eller ny/);
    } finally {
      await d.close();
    }
  });

  it("drift: min_auktion_boost uden app-endpoints-rettelsen stopper migrationen", async () => {
    const d = new PGlite();
    try {
      await d.exec(STUB);
      await d.exec(BOOST);
      await expect(d.exec(MIGRATION)).rejects.toThrow(/min_auktion_boost.*hverken gammel eller ny/);
    } finally {
      await d.close();
    }
  });
});

describe("pakkevalg og låst pris", () => {
  it("serveren vælger pris og point ud fra pakkens id", async () => {
    const s = await start(PRIVAT, "point_300");
    expect(s).toMatchObject({ kode: "ok", pakke: "point_300", point: 300, beloeb_oere: 9900 });
    expect(await koeb(s.id)).toMatchObject({ status: "afventer", point: 300, beloeb_oere: 9900, pakke_id: "point_300" });
    // Samme pakke igen: samme køb (idempotent).
    const igen = await start(PRIVAT, "point_300");
    expect(igen).toMatchObject({ kode: "findes", id: s.id, pakke: "point_300", point: 300, beloeb_oere: 9900 });
  });

  it("uden pakke bruges standardpakken (100 point, 39 kr.) - som den nuværende app", async () => {
    const s = await start(PRIVAT2);
    expect(s).toMatchObject({ kode: "ok", pakke: "point_100", point: 100, beloeb_oere: 3900 });
  });

  it("pris, point og pakke er låst på købet", async () => {
    const s = await start(PRIVAT, "point_300");
    await expect(db.query(`update public.boost_koeb set point = 700 where id = $1`, [s.id])).rejects.toThrow(/kan ikke ændres/);
    await expect(db.query(`update public.boost_koeb set beloeb_oere = 100 where id = $1`, [s.id])).rejects.toThrow(/kan ikke ændres/);
    await expect(db.query(`update public.boost_koeb set pakke_id = 'point_700' where id = $1`, [s.id])).rejects.toThrow(
      /kan ikke ændres/,
    );
    // En ny pris på pakken ændrer ikke et startet køb.
    await db.exec(`update public.boost_pakker set pris_oere = 12900 where id = 'point_300'`);
    expect(await koeb(s.id)).toMatchObject({ beloeb_oere: 9900 });
    await db.exec(`update public.boost_pakker set pris_oere = 9900 where id = 'point_300'`);
  });

  it("ukendt, inaktiv eller ugyldig pakke afvises", async () => {
    await db.exec(`insert into public.boost_pakker (id, point, pris_oere, aktiv, sortering) values ('point_50', 50, 2500, false, 5)
                   on conflict (id) do nothing`);
    for (const p of ["point_999", "point_50", "POINT_100", "point_100; drop table x", ""]) {
      expect((await start(PRIVAT3, p)).kode).toBe("pakke_ukendt");
    }
    // Den inaktive er heller ikke i listen og ikke standardpakken.
    const ids = ((await en<{ v: { id: string }[] }>(`select public.boost_pakke_liste() as v`)).v).map((x) => x.id);
    expect(ids).not.toContain("point_50");
    expect((await en<{ v: { id: string } }>(`select public.boost_standard_pakke() as v`)).v.id).toBe("point_100");
  });

  it("firmaer kan ikke købe nogen pakke", async () => {
    expect((await start(FIRMA, "point_700")).kode).toBe("erhverv");
  });

  it("pakkerne kan ikke slettes", async () => {
    await expect(db.query(`delete from public.boost_pakker where id = 'point_50'`)).rejects.toThrow(/slettes ikke/);
  });
});

describe("skift af pakke (idempotens dækker pakken)", () => {
  it("uden PaymentIntent: det åbne køb annulleres, og der startes et nyt", async () => {
    const gl = await start(PRIVAT, "point_300"); // findes fra før (ingen PI)
    const ny = await start(PRIVAT, "point_700");
    expect(ny).toMatchObject({ kode: "ok", pakke: "point_700", point: 700, beloeb_oere: 19900 });
    expect(ny.id).not.toBe(gl.id);
    expect((await koeb(gl.id)).status).toBe("annulleret");
  });

  it("med PaymentIntent: 'skift' - intet ændres, før PaymentIntenten er annulleret hos Stripe", async () => {
    const s = await start(PRIVAT, "point_700");
    const pi = await gemPi(s);
    const skift = await start(PRIVAT, "point_100");
    expect(skift).toEqual({ kode: "skift", id: s.id, pi });
    expect((await koeb(s.id)).status).toBe("afventer");
    // Serveren har annulleret den hos Stripe: canceled spejles (kasseret).
    expect((await registrer(pi, "canceled")).kode).toBe("nulstillet");
    const ny = await start(PRIVAT, "point_100");
    expect(ny).toMatchObject({ kode: "ok", pakke: "point_100", point: 100, beloeb_oere: 3900 });
    expect((await koeb(s.id)).status).toBe("annulleret");
    // Betales den kasserede alligevel, er det en dobbeltbetaling (refunderes) - ingen point.
    const foer = await saldo(PRIVAT);
    expect((await registrer(pi, "succeeded", 19900, "ch_kasseret700")).kode).toBe("kasseret");
    expect(await saldo(PRIVAT)).toBe(foer);
  });

  it("nåede den gamle at blive betalt, får brugeren den gamle pakkes point", async () => {
    const aaben = await start(PRIVAT, "point_100"); // fra forrige test
    const pi = await gemPi(aaben);
    expect((await start(PRIVAT, "point_300")).kode).toBe("skift");
    const foer = await saldo(PRIVAT);
    // Serveren slår den op hos Stripe: betalt -> spejles.
    expect((await registrer(pi, "succeeded", 3900, "ch_naaede100")).kode).toBe("betalt");
    expect(await saldo(PRIVAT)).toBe(foer + 100);
    // Derefter er der intet åbent køb: et nyt af den valgte pakke.
    expect(await start(PRIVAT, "point_300")).toMatchObject({ kode: "ok", point: 300 });
  });

  it("behandles (fx MobilePay): 'behandles' - ingen ny betaling", async () => {
    const s = await start(PRIVAT, "point_300");
    const pi = await gemPi(s);
    expect((await registrer(pi, "processing")).kode).toBe("behandles");
    expect(await start(PRIVAT, "point_700")).toEqual({ kode: "behandles", id: s.id });
    // Samme pakke: det åbne køb (som før).
    expect(await start(PRIVAT, "point_300")).toMatchObject({ kode: "findes", id: s.id, status: "behandles" });
    expect((await registrer(pi, "succeeded", 9900, "ch_behandlet300")).kode).toBe("betalt");
  });

  it("ændres pakkens pris, genbruges et åbent køb med den gamle pris ikke", async () => {
    const s = await start(PRIVAT2); // point_100 fra tidligere (åbent, uden PI)
    await db.exec(`update public.boost_pakker set pris_oere = 4900 where id = 'point_100'`);
    try {
      const ny = await start(PRIVAT2, "point_100");
      expect(ny).toMatchObject({ kode: "ok", pakke: "point_100", beloeb_oere: 4900 });
      expect((await koeb(s.id)).status).toBe("annulleret");
    } finally {
      await db.exec(`update public.boost_pakker set pris_oere = 3900 where id = 'point_100'`);
    }
  });
});

describe("betaling, tilbageførsel og faktura med pakkens point", () => {
  it("700 point krediteres for 199 kr.; et andet beløb giver ingen point", async () => {
    await nulstil(PRIVAT2);
    // PRIVAT2 har et åbent point_100-køb (49 kr., uden PI) fra forrige test:
    // det annulleres, og 700-købet startes.
    const k = await betaltKoeb(PRIVAT2, "point_700", 19900);
    expect(await saldo(PRIVAT2)).toBe(700);
    expect(await koeb(k.id)).toMatchObject({ status: "betalt", point: 700, beloeb_oere: 19900, pakke_id: "point_700" });

    const s = await start(PRIVAT2, "point_300");
    const pi = await gemPi(s);
    expect((await registrer(pi, "succeeded", 3900, "ch_forkert300")).kode).toBe("beloeb_afviger");
    expect(await saldo(PRIVAT2)).toBe(700);
  });

  it("chefens refusion trækker pakkens point tilbage (700)", async () => {
    const k = await en<{ id: string }>(
      `select id from public.boost_koeb where bruger_id = $1 and pakke_id = 'point_700' and status = 'betalt'`,
      [PRIVAT2],
    );
    const r = await j(`select public.boost_staff_refusion($1, $2, 'test') as v`, [CHEF, k.id]);
    expect(r).toMatchObject({ kode: "ok", trukket: 700, oensket: 700 });
    expect(await saldo(PRIVAT2)).toBe(0);
  });

  it("tabt indsigelse trækker pakkens point tilbage - så langt saldoen rækker", async () => {
    await nulstil(PRIVAT3);
    // PRIVAT3 har et gammelt åbent køb (point_100, uden PI): skift til 300.
    const k = await betaltKoeb(PRIVAT3, "point_300", 9900);
    expect(await saldo(PRIVAT3)).toBe(300);
    // Brugeren har brugt 50 af pointene (staff-justering som stand-in).
    await j(`select public.boost_staff_justering($1, $2, -50, 'brugt', $3) as v`, [CHEF, PRIVAT3, randomUUID()]);
    expect(await j(`select to_jsonb(public.boost_koeb_indsigelse($1, 'dp_1', 'needs_response')) as v`, [k.charge])).toBe("laast");
    expect(await j(`select to_jsonb(public.boost_koeb_indsigelse($1, 'dp_1', 'lost')) as v`, [k.charge])).toBe("tilbagefoert");
    expect(await saldo(PRIVAT3)).toBe(0);
    const t = await en<{ point: number; oensket_point: number }>(
      `select point, oensket_point from public.boost_posteringer where boost_koeb_id = $1 and type = 'tilbagefoersel'`,
      [k.id],
    );
    expect(t).toEqual({ point: -250, oensket_point: 300 });
  });

  it("refunderet i Stripe (charge.refunded) trækker pakkens point tilbage", async () => {
    await nulstil(PRIVAT);
    const k = await betaltKoeb(PRIVAT, "point_700", 19900);
    expect(await saldo(PRIVAT)).toBe(700);
    expect(await j(`select to_jsonb(public.boost_koeb_registrer_charge_refusion($1, 're_1', true)) as v`, [k.charge])).toBe(
      "refunderet",
    );
    expect(await saldo(PRIVAT)).toBe(0);
  });

  it("fakturaen har pakkens point og beløb", async () => {
    await db.exec(`select public.faktura_planlaeg_boost(500)`);
    const f = await en<{ linjer: { tekst: string; beloeb_oere: number }[]; beloeb_oere: number }>(
      `select f.linjer, f.beloeb_oere from public.fakturaer f join public.boost_koeb k on k.id = f.boost_koeb_id
        where f.dokument = 'faktura' and k.pakke_id = 'point_700'
        order by f.oprettet_kl limit 1`,
    );
    expect(f.beloeb_oere).toBe(19900);
    expect(f.linjer[0]).toMatchObject({ tekst: "Boost-point (700 point)", beloeb_oere: 19900 });
    const kredit = await en<{ n: number }>(
      `select count(*)::int as n from public.fakturaer f join public.boost_koeb k on k.id = f.boost_koeb_id
        where f.dokument = 'kreditnota' and k.pakke_id = 'point_700'`,
    );
    expect(kredit.n).toBeGreaterThanOrEqual(1);
  });
});

describe("brugerens visning", () => {
  it("mine_point: pakker, pakke (bagudkompatibel), åbent køb og beløb i historikken", async () => {
    const s = await start(PRIVAT, "point_300");
    const p = await somBruger(PRIVAT, () => j(`select public.mine_point() as v`));
    expect(p.pakke).toEqual({ id: "point_100", point: 100, pris_oere: 3900 });
    expect((p.pakker as { id: string }[]).map((x) => x.id)).toEqual(["point_100", "point_300", "point_700"]);
    expect(p.aabent_koeb).toMatchObject({ id: s.id, pakke: "point_300", point: 300, beloeb_oere: 9900 });
    const koebt = (p.historik as { type: string; point: number; beloeb_oere: number | null }[]).filter((h) => h.type === "koeb");
    expect(koebt.some((h) => h.point === 700 && h.beloeb_oere === 19900)).toBe(true);
    expect(koebt.some((h) => h.point === 100 && h.beloeb_oere === 3900)).toBe(true);
    // Kun køb har et beløb.
    const andre = (p.historik as { type: string; beloeb_oere: number | null }[]).filter((h) => h.type !== "koeb");
    expect(andre.every((h) => h.beloeb_oere === null)).toBe(true);
  });

  it("min_auktion_boost: pakke og pakker til 'Køb point'", async () => {
    const a = await en<{ id: string }>(`insert into public.auctions (bruger_id, titel) values ($1, 'Cykel') returning id`, [PRIVAT]);
    const r = await somBruger(PRIVAT, () => j(`select public.min_auktion_boost($1) as v`, [a.id]));
    expect(r.pakke).toEqual({ id: "point_100", point: 100, pris_oere: 3900 });
    expect((r.pakker as unknown[]).length).toBe(3);
    expect(r.grund).toBe("for_faa_point");
  });

  it("brugeren kan læse de aktive pakker og pakken på sine egne køb", async () => {
    const r = await somBruger(PRIVAT, async () => ({
      pakker: (await db.query(`select id from public.boost_pakker order by sortering`)).rows.map((x) => (x as { id: string }).id),
      egne: (await db.query(`select pakke_id from public.boost_koeb`)).rows.length,
    }));
    expect(r.pakker).toEqual(["point_100", "point_300", "point_700"]);
    expect(r.egne).toBeGreaterThan(0);
  });
});
