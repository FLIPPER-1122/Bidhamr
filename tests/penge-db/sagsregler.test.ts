// Migrationen 20261102210000_sagsregler.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Stubs + de RIGTIGE funktioner fra
// testdatabasen før migrationen (sagsreglerStub.ts), derefter migrationen TO
// gange (idempotent). Testes - de 8 regelændringer (Filip, 27. okt. 2026):
//   1. 2 billeder (pakke med label + indhold), 2. "pakken er smidt ud",
//   3. sælgerens svar (frist, én gang, billeder, uforanderligt, RLS),
//   4. "andet" + staff retter typen (logget, sager_beskyt),
//   5. påmindelser (kandidaterne 6 t / 12 t før fristen),
//   6. bortkommet pakke = hele beløbet tilbage (sag_claim_refusion),
//   7. transportskade: hele beløbet + staff vælger, hvem der betaler
//      returfragten (sælger -> regning som ekstra fragt, BidHamr ->
//      indpakning ordentlig / reklamation), dækket returfragt (ingen Stripe,
//      ingen faktura til køberen),
//   8. 72 timer (trades.problem_frist_kl, gamle handler beholder 48 t,
//      handel_auto_frigiv).
// Og md5-drift-tjekket. Derefter rettelserne 20261102350000 (review B1-B3,
// S1-S8 og Filips afklaringer: tom pakke, bortkommet -> reklamation til
// sælgeren, svindel = kun buddet) - se describe("20261102350000 ...").
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { sagRefusionOere } from "@/lib/betaling/beregn";
import {
  ADMIN,
  FREMMED,
  KOEBER,
  MEDARBEJDER,
  RETTELSER,
  SAELGER,
  SAGSREGLER,
  opsaet,
  opsaetRettelser,
} from "./sagsreglerStub";
import { huskelisteAfsnit } from "./huskelisteAfsnit";

let db: PGlite;

type R = Record<string, unknown>;

async function en<T = R>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<R> {
  return (await en<{ v: R }>(sql, p)).v;
}
async function som(uid: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ""]);
}

// En betalt handel. status 'modtaget' (received_at = nu - timerSiden) eller
// 'pakke_sendt'. Beløb (ny2, 1.000 kr.): bud 100.000, købergebyr 7.500,
// fragt 4.200, total 111.700, sælgergebyr 5.500, udbetaling 94.500, gebyr 17.200.
async function handel(o: { status?: string; timerSiden?: number; kilde?: string | null; beskyttelse?: boolean } = {}) {
  const a = await en<{ id: string }>(`insert into public.auctions default values returning id`);
  const status = o.status ?? "modtaget";
  const t = await en<{ id: string }>(
    `insert into public.trades (auction_id, buyer_id, seller_id, status, received_at, sendt_kl, modtaget_kilde)
     values ($1, $2, $3, $4, case when $4 = 'modtaget' then now() - make_interval(hours => $5) end,
             now() - interval '9 days', $6) returning id`,
    [a.id, KOEBER, SAELGER, status, o.timerSiden ?? 1, o.kilde ?? null],
  );
  const b = await en<{ id: string }>(
    `insert into public.betalinger (trade_id, beskyttelse) values ($1, $2) returning id`,
    [t.id, o.beskyttelse ?? true],
  );
  await db.query(
    `insert into public.forsendelser (trade_id, type, status, afsender, leveret_kl) values ($1, 'udgaaende', 'leveret', '{"navn":"Sælger"}', now())`,
    [t.id],
  );
  return { tradeId: t.id, betalingId: b.id, auctionId: a.id };
}

let billedeNr = 0;
// Uploader (stub) et billede i brugerens mappe på handlen og returnerer stien.
async function billede(bruger: string, trade: string): Promise<string> {
  billedeNr++;
  const sti = `${bruger}/${trade}/billede${billedeNr}.jpg`;
  await db.query(`insert into storage.objects (bucket_id, name) values ('sag-billeder', $1)`, [sti]);
  return sti;
}

async function opret(
  trade: string,
  type: string,
  billeder: { sti: string; kategori: string }[],
  ekstra: { smidt?: boolean; grund?: string | null } = {},
): Promise<R> {
  await som(KOEBER);
  return j(`select public.sag_opret($1, $2, $3, $4::jsonb, $5, $6) as v`, [
    trade,
    type,
    "Det ene ben var knækket, da jeg åbnede pakken.",
    JSON.stringify(billeder),
    ekstra.smidt ?? false,
    ekstra.grund ?? null,
  ]);
}

async function toBilleder(trade: string) {
  return [
    { sti: await billede(KOEBER, trade), kategori: "pakke_label" },
    { sti: await billede(KOEBER, trade), kategori: "indhold" },
  ];
}

// Handler fra FØR migrationen (beholder 48 timer).
let gammel60: { tradeId: string };
let gammel49: { tradeId: string };

beforeAll(async () => {
  db = new PGlite();
  await opsaet(db);
  gammel60 = await handel({ timerSiden: 60 });
  gammel49 = await handel({ timerSiden: 49 });
  await db.exec(SAGSREGLER);
  // Kan køres igen.
  await db.exec(SAGSREGLER);
  // Rettelserne (20261102350000) oven på - også to gange. Alle tests nedenfor
  // kører mod den endelige udgave.
  await opsaetRettelser(db);
  await db.exec(RETTELSER);
  await db.exec(RETTELSER);
}, 60_000);

describe("regel 8: 72 timer", () => {
  it("nye handler får received_at + 72 t; gamle beholder 48 t", async () => {
    const ny = await handel({ timerSiden: 1 });
    const r = await en<{ timer: number }>(
      `select extract(epoch from problem_frist_kl - received_at) / 3600 as timer from public.trades where id = $1`,
      [ny.tradeId],
    );
    expect(Number(r.timer)).toBe(72);
    const g = await en<{ timer: number }>(
      `select extract(epoch from problem_frist_kl - received_at) / 3600 as timer from public.trades where id = $1`,
      [gammel60.tradeId],
    );
    expect(Number(g.timer)).toBe(48);
  });

  it("fristen kan ikke rettes for sig selv, men følger received_at", async () => {
    const h = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set problem_frist_kl = now() + interval '30 days' where id = $1`, [h.tradeId]);
    const r = await en<{ timer: number }>(
      `select extract(epoch from problem_frist_kl - received_at) / 3600 as timer from public.trades where id = $1`,
      [h.tradeId],
    );
    expect(Number(r.timer)).toBe(72);
    await db.query(`update public.trades set received_at = now() - interval '10 hours' where id = $1`, [h.tradeId]);
    const r2 = await en<{ ok: boolean }>(
      `select problem_frist_kl = received_at + interval '72 hours' as ok from public.trades where id = $1`,
      [h.tradeId],
    );
    expect(r2.ok).toBe(true);
  });

  it("sag kan oprettes 60 timer efter levering (ny handel), men ikke på en gammel handel", async () => {
    const ny = await handel({ timerSiden: 1 });
    // Ny handel modtaget for 60 timer siden (trigger: +72 t).
    await db.query(`update public.trades set received_at = now() - interval '60 hours' where id = $1`, [ny.tradeId]);
    expect((await opret(ny.tradeId, "skadet", await toBilleder(ny.tradeId))).kode).toBe("ok");
    expect((await opret(gammel60.tradeId, "skadet", await toBilleder(gammel60.tradeId))).kode).toBe("for_sent");
  });

  it("efter 72 timer: for sent", async () => {
    const h = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set received_at = now() - interval '73 hours' where id = $1`, [h.tradeId]);
    expect((await opret(h.tradeId, "skadet", await toBilleder(h.tradeId))).kode).toBe("for_sent");
  });

  it("handel_auto_frigiv frigiver efter 72 t (ny) og 48 t (gammel) - ikke før", async () => {
    const tidlig = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set received_at = now() - interval '60 hours' where id = $1`, [tidlig.tradeId]);
    const sen = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set received_at = now() - interval '73 hours' where id = $1`, [sen.tradeId]);
    const ud = (await j(`select public.handel_auto_frigiv() as v`)) as unknown as { trade_id: string; grund: string }[];
    const ider = ud.map((x) => x.trade_id);
    expect(ider).toContain(sen.tradeId);
    expect(ider).toContain(gammel49.tradeId);
    expect(ider).not.toContain(tidlig.tradeId);
    const b = await en<{ frigivet: boolean }>(
      `select frigivet_kl is not null as frigivet from public.betalinger where trade_id = $1`,
      [tidlig.tradeId],
    );
    expect(b.frigivet).toBe(false);
  });

  it("leveringsmeldingen holder 14-dages-grenen tilbage i 72 timer", async () => {
    const h = await handel({ status: "pakke_sendt" });
    await db.query(`update public.forsendelser set leveret_kl = now() - interval '60 hours' where trade_id = $1`, [h.tradeId]);
    expect((await en<{ v: boolean }>(`select public.handel_leveret_melding_ny($1) as v`, [h.tradeId])).v).toBe(true);
    await db.query(`update public.forsendelser set leveret_kl = now() - interval '73 hours' where trade_id = $1`, [h.tradeId]);
    await db.query(`insert into public.forsendelse_haendelser (forsendelse_id, type, modtaget_kl)
                    select id, 'leveret', now() - interval '73 hours' from public.forsendelser where trade_id = $1`, [h.tradeId]);
    expect((await en<{ v: boolean }>(`select public.handel_leveret_melding_ny($1) as v`, [h.tradeId])).v).toBe(false);
  });
});

describe("regel 1, 2 og 4: oprettelse", () => {
  it("2 billeder: pakken med label + indhold er nok; de gamle 3 virker stadig", async () => {
    const a = await handel();
    expect((await opret(a.tradeId, "skadet", await toBilleder(a.tradeId))).kode).toBe("ok");
    const b = await handel();
    const tre = [
      { sti: await billede(KOEBER, b.tradeId), kategori: "pakke" },
      { sti: await billede(KOEBER, b.tradeId), kategori: "label" },
      { sti: await billede(KOEBER, b.tradeId), kategori: "indhold" },
    ];
    expect((await opret(b.tradeId, "ikke_som_beskrevet", tre)).kode).toBe("ok");
  });

  it("mangler pakken eller indholdet: billeder_kraeves (label alene er ikke pakken)", async () => {
    const a = await handel();
    expect((await opret(a.tradeId, "skadet", [{ sti: await billede(KOEBER, a.tradeId), kategori: "indhold" }])).kode).toBe(
      "billeder_kraeves",
    );
    const b = await handel();
    const lab = [
      { sti: await billede(KOEBER, b.tradeId), kategori: "label" },
      { sti: await billede(KOEBER, b.tradeId), kategori: "indhold" },
    ];
    expect((await opret(b.tradeId, "skadet", lab)).kode).toBe("billeder_kraeves");
    const c = await handel();
    expect((await opret(c.tradeId, "skadet", [{ sti: await billede(KOEBER, c.tradeId), kategori: "pakke_label" }])).kode).toBe(
      "billeder_kraeves",
    );
  });

  it("'Ikke kommet frem' efter leveringsmelding kræver ingen billeder", async () => {
    const a = await handel({ kilde: "fragt" });
    expect((await opret(a.tradeId, "bortkommet", [])).kode).toBe("ok");
  });

  it("pakken er smidt ud: forklaring på mindst 20 tegn, indholdet kræves stadig, markeres til vurdering", async () => {
    const a = await handel();
    const indhold = [{ sti: await billede(KOEBER, a.tradeId), kategori: "indhold" }];
    expect((await opret(a.tradeId, "skadet", indhold, { smidt: true, grund: "Smidt ud" })).kode).toBe("smidt_ud_begrundelse");
    expect((await opret(a.tradeId, "skadet", [], { smidt: true, grund: "Jeg smed papkassen ud samme dag." })).kode).toBe(
      "billeder_kraeves",
    );
    const r = await opret(a.tradeId, "skadet", indhold, { smidt: true, grund: "Jeg smed papkassen ud samme dag." });
    expect(r.kode).toBe("ok");
    const s = await en<{ pakke_smidt_ud: boolean; pakke_smidt_ud_begrundelse: string; sag_note: string }>(
      `select s.pakke_smidt_ud, s.pakke_smidt_ud_begrundelse, t.sag_note from public.sager s join public.trades t on t.id = s.trade_id where s.id = $1`,
      [r.sag_id],
    );
    expect(s.pakke_smidt_ud).toBe(true);
    expect(s.pakke_smidt_ud_begrundelse).toBe("Jeg smed papkassen ud samme dag.");
    expect(s.sag_note).toContain("smidt ud");
  });

  it("smidt ud giver ikke mening ved bortkommet / pakke på vej", async () => {
    const a = await handel({ kilde: "fragt" });
    expect((await opret(a.tradeId, "bortkommet", [], { smidt: true, grund: "Jeg smed papkassen ud samme dag." })).kode).toBe(
      "smidt_ud_ikke_mulig",
    );
  });

  it("'andet' er en rigtig type og kræver BidHamr Beskyttelse", async () => {
    const a = await handel();
    expect((await opret(a.tradeId, "andet", await toBilleder(a.tradeId))).kode).toBe("ok");
    const b = await handel({ beskyttelse: false });
    expect((await opret(b.tradeId, "andet", await toBilleder(b.tradeId))).kode).toBe("kraever_beskyttelse");
  });

  it("den gamle 4-parameter-signatur er væk, men navngivne kald fra gammel kode virker", async () => {
    expect((await en<{ f: string | null }>(`select to_regprocedure('public.sag_opret(uuid,text,text,jsonb)')::text as f`)).f).toBeNull();
    const a = await handel();
    await som(KOEBER);
    const r = await j(
      `select public.sag_opret(p_trade => $1, p_type => 'skadet', p_beskrivelse => 'Varen er gået i stykker.', p_billeder => $2::jsonb) as v`,
      [a.tradeId, JSON.stringify(await toBilleder(a.tradeId))],
    );
    expect(r.kode).toBe("ok");
  });
});

describe("regel 4: staff retter sagstypen", () => {
  it("medarbejder retter 'andet' til 'skadet' (logget, oprindelig type gemt); brugere kan ikke", async () => {
    const a = await handel();
    const s = await opret(a.tradeId, "andet", await toBilleder(a.tradeId));
    expect((await j(`select public.sag_ret_type($1, $2, 'skadet', 'Billederne viser en skade') as v`, [KOEBER, s.sag_id])).kode).toBe(
      "ingen_adgang",
    );
    expect((await j(`select public.sag_ret_type($1, $2, 'skadet', '') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe(
      "begrundelse_mangler",
    );
    const r = await j(`select public.sag_ret_type($1, $2, 'skadet', 'Billederne viser en skade') as v`, [MEDARBEJDER, s.sag_id]);
    expect(r.kode).toBe("ok");
    const sag = await en<{ type: string; oprindelig_type: string; type_rettet_af: string }>(
      `select type, oprindelig_type, type_rettet_af from public.sager where id = $1`,
      [s.sag_id],
    );
    expect(sag).toMatchObject({ type: "skadet", oprindelig_type: "andet", type_rettet_af: MEDARBEJDER });
    const log = await en<{ n: number }>(
      `select count(*)::int as n from public.moderation_log where handling = 'sag_type_rettet' and maal_id = $1`,
      [s.sag_id],
    );
    expect(log.n).toBe(1);
    // Retter igen: den oprindelige type bevares.
    await j(`select public.sag_ret_type($1, $2, 'ikke_som_beskrevet', 'Fejl i varen') as v`, [MEDARBEJDER, s.sag_id]);
    expect((await en<{ o: string }>(`select oprindelig_type as o from public.sager where id = $1`, [s.sag_id])).o).toBe("andet");
  });

  it("typen kan ikke ændres direkte (sager_beskyt)", async () => {
    const a = await handel();
    const s = await opret(a.tradeId, "skadet", await toBilleder(a.tradeId));
    await expect(db.query(`update public.sager set type = 'svindel' where id = $1`, [s.sag_id])).rejects.toThrow(/faste oplysninger/);
  });

  it("efter afgørelsen kan typen ikke rettes; uden Beskyttelse ikke til en retur-type", async () => {
    const a = await handel({ beskyttelse: false });
    const s = await opret(a.tradeId, "svindel", await toBilleder(a.tradeId));
    expect((await j(`select public.sag_ret_type($1, $2, 'skadet', 'Skade') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe(
      "kraever_beskyttelse",
    );
    await j(`select public.sag_afgoer($1, $2, 'saelger', 'Ingen dokumentation', null) as v`, [MEDARBEJDER, s.sag_id]);
    expect((await j(`select public.sag_ret_type($1, $2, 'bortkommet', 'Bortkommet') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe(
      "forkert_status",
    );
  });

  it("medhold til køber kræver en rigtig type ('andet' -> vaelg_type)", async () => {
    const a = await handel();
    const s = await opret(a.tradeId, "andet", await toBilleder(a.tradeId));
    expect((await j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null) as v`, [MEDARBEJDER, s.sag_id])).kode).toBe(
      "vaelg_type",
    );
  });
});

describe("regel 3: sælgerens svar", () => {
  async function sagMedSvarvindue() {
    const a = await handel();
    const s = await opret(a.tradeId, "skadet", await toBilleder(a.tradeId));
    return { ...a, sagId: s.sag_id as string };
  }

  it("sælgeren svarer med tekst og billeder - én gang", async () => {
    const h = await sagMedSvarvindue();
    expect((await en<{ v: boolean }>(`select public.sag_svar_kan($1, $2) as v`, [h.tradeId, SAELGER])).v).toBe(true);
    expect((await en<{ v: boolean }>(`select public.sag_svar_kan($1, $2) as v`, [h.tradeId, KOEBER])).v).toBe(false);
    const sti = await billede(SAELGER, h.tradeId);
    await som(SAELGER);
    const r = await j(`select public.sag_svar_send($1, $2, $3::jsonb) as v`, [
      h.sagId,
      "Stolen var hel, da jeg sendte den. Den var pakket i bobleplast.",
      JSON.stringify([{ sti, kategori: "indhold" }]),
    ]);
    expect(r.kode).toBe("ok");
    expect((await j(`select public.sag_svar_send($1, $2, '[]'::jsonb) as v`, [h.sagId, "Endnu et svar fra mig."])).kode).toBe("findes");
    expect((await en<{ v: boolean }>(`select public.sag_svar_kan($1, $2) as v`, [h.tradeId, SAELGER])).v).toBe(false);
    const b = await en<{ n: number }>(`select count(*)::int as n from public.sag_svar_billeder where sag_id = $1`, [h.sagId]);
    expect(b.n).toBe(1);
  });

  it("køberen og fremmede kan ikke svare; kort tekst og kontaktinfo afvises", async () => {
    const h = await sagMedSvarvindue();
    await som(KOEBER);
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "Jeg er køberen her."])).kode).toBe("ikke_fundet");
    await som(FREMMED);
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "Jeg er en fremmed."])).kode).toBe("ikke_fundet");
    await som(SAELGER);
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "Kort"])).kode).toBe("ugyldig_tekst");
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "Ring til mig på 12345678 i stedet"])).kode).toBe(
      "kontaktinfo",
    );
  });

  it("billeder i køberens mappe eller allerede brugte afvises", async () => {
    const h = await sagMedSvarvindue();
    await som(SAELGER);
    const fremmed = await billede(KOEBER, h.tradeId);
    expect(
      (await j(`select public.sag_svar_send($1, $2, $3::jsonb) as v`, [
        h.sagId,
        "Her er mine billeder af pakken.",
        JSON.stringify([{ sti: fremmed, kategori: "pakke" }]),
      ])).kode,
    ).toBe("ugyldige_billeder");
    expect(
      (await j(`select public.sag_svar_send($1, $2, $3::jsonb) as v`, [
        h.sagId,
        "Her er mine billeder af pakken.",
        JSON.stringify([{ sti: `${SAELGER}/${h.tradeId}/findes-ikke.jpg`, kategori: "pakke" }]),
      ])).kode,
    ).toBe("billede_mangler");
  });

  it("efter 48 timer eller efter afgørelsen kan sælgeren ikke svare", async () => {
    const h = await sagMedSvarvindue();
    await db.query(`update public.sager set oprettet_kl = now() - interval '49 hours' where id = $1`, [h.sagId]).catch(() => null);
    // oprettet_kl er fast (sager_beskyt) - flyt den uden om triggeren.
    await db.exec(`alter table public.sager disable trigger sager_beskyt`);
    await db.query(`update public.sager set oprettet_kl = now() - interval '49 hours' where id = $1`, [h.sagId]);
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
    await som(SAELGER);
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "For sent til at svare her."])).kode).toBe("for_sent");
    const h2 = await sagMedSvarvindue();
    await j(`select public.sag_afgoer($1, $2, 'lukket', 'Lukket', null) as v`, [MEDARBEJDER, h2.sagId]);
    await som(SAELGER);
    expect((await j(`select public.sag_svar_send($1, $2) as v`, [h2.sagId, "Nu er sagen afgjort."])).kode).toBe("lukket");
  });

  it("svaret kan ikke ændres eller slettes", async () => {
    const h = await sagMedSvarvindue();
    await som(SAELGER);
    await j(`select public.sag_svar_send($1, $2) as v`, [h.sagId, "Stolen var hel, da jeg sendte den."]);
    await expect(db.query(`update public.sag_svar set tekst = 'Ændret tekst her' where sag_id = $1`, [h.sagId])).rejects.toThrow(
      /kan ikke ændres/,
    );
    await expect(db.query(`delete from public.sag_svar where sag_id = $1`, [h.sagId])).rejects.toThrow(/kan ikke ændres/);
  });

  it("påmindelsen 12 timer før svarfristen", async () => {
    const h = await sagMedSvarvindue();
    await db.exec(`alter table public.sager disable trigger sager_beskyt`);
    await db.query(`update public.sager set oprettet_kl = now() - interval '40 hours' where id = $1`, [h.sagId]);
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
    const k = await db.query<{ sag_id: string }>(`select sag_id from public.sag_svar_paamind_kandidater(12)`);
    expect(k.rows.map((x) => x.sag_id)).toContain(h.sagId);
  });
});

describe("regel 5: påmindelse 6 timer før fristen for at melde et problem", () => {
  it("handler med under 6 timer tilbage og ingen sag", async () => {
    const h = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set received_at = now() - interval '68 hours' where id = $1`, [h.tradeId]);
    const tidlig = await handel({ timerSiden: 1 });
    const k = await db.query<{ trade_id: string }>(`select trade_id from public.handel_problem_frist_paamind_kandidater(6)`);
    const ider = k.rows.map((x) => x.trade_id);
    expect(ider).toContain(h.tradeId);
    expect(ider).not.toContain(tidlig.tradeId);
  });
});

describe("regel 6 og 7: refusion", () => {
  async function medhold(type: string, o: { kilde?: string | null; betaler?: string | null } = {}) {
    const h = await handel({ kilde: o.kilde ?? null });
    const s = await opret(h.tradeId, type, type === "bortkommet" ? [] : await toBilleder(h.tradeId));
    expect(s.kode).toBe("ok");
    const a = await j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null, false, $3) as v`, [
      MEDARBEJDER,
      s.sag_id,
      o.betaler ?? null,
    ]);
    return { ...h, sagId: s.sag_id as string, afgoerelse: a };
  }

  it("bortkommet pakke: hele beløbet (bud + gebyr + fragt) - Stripe-refusionen dækker hele gebyret", async () => {
    const h = await medhold("bortkommet", { kilde: "fragt" });
    expect(h.afgoerelse.kode).toBe("ok");
    const r = await en<{ beloeb: string; fejl: string | null }>(`select * from public.sag_claim_refusion($1)`, [h.betalingId]);
    expect(r.fejl).toBeNull();
    expect(Number(r.beloeb)).toBe(111700);
    const b = await en<{ refusion_oere: string; refusion_aarsag: string }>(
      `select refusion_oere, refusion_aarsag from public.betalinger where id = $1`,
      [h.betalingId],
    );
    expect(Number(b.refusion_oere)).toBe(111700);
    expect(b.refusion_aarsag).toBe("sag");
    // Refusionsplanen (uændret): S = hele sælgerens del, G = R - S = hele gebyret.
    expect(111700 - 94500).toBe(17200);
  });

  it("svindel og 'ikke som beskrevet': kun buddet (ny prismodel)", async () => {
    for (const type of ["svindel", "ikke_som_beskrevet"]) {
      const h = await handel();
      const s = await opret(h.tradeId, type, await toBilleder(h.tradeId));
      const r = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [h.betalingId]);
      expect(Number(r.beloeb)).toBe(100000);
      expect(s.kode).toBe("ok");
    }
  });

  it("transportskade: hele beløbet", async () => {
    const h = await medhold("skadet", { betaler: "bidhamr" });
    const r = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [h.betalingId]);
    expect(Number(r.beloeb)).toBe(111700);
  });

  it("sag_refusion_oere (5 parametre) = beregn.ts sagRefusionOere", async () => {
    for (const [model, type] of [
      ["ny2", "bortkommet"],
      ["ny2", "skadet"],
      ["ny2", "svindel"],
      ["ny2", "ikke_som_beskrevet"],
      ["ny2", "andet"],
      ["gammel", "bortkommet"],
      ["gammel", "svindel"],
      ["erhverv2", "svindel"],
    ] as const) {
      const sql = await en<{ v: string }>(`select public.sag_refusion_oere($1, 100000, 111700, 2500, $2) as v`, [model, type]);
      expect(Number(sql.v)).toBe(sagRefusionOere({ prismodel: model, bud_oere: 100000, total_oere: 111700, beskyttelse_oere: 2500 }, type));
    }
    // Den gamle udgave er uændret (gammel kode).
    expect(Number((await en<{ v: string }>(`select public.sag_refusion_oere('ny2', 100000, 111700, 0) as v`)).v)).toBe(100000);
  });
});

describe("regel 7: hvem betaler returfragten", () => {
  async function skadeSag() {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
    return { ...h, sagId: s.sag_id as string };
  }
  const afgoer = (sag: string, betaler: string | null) =>
    j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null, false, $3) as v`, [MEDARBEJDER, sag, betaler]);

  it("staff skal vælge sælger eller BidHamr ved transportskade", async () => {
    const h = await skadeSag();
    expect((await afgoer(h.sagId, null)).kode).toBe("vaelg_returfragt_betaler");
    expect((await afgoer(h.sagId, "koeber")).kode).toBe("vaelg_returfragt_betaler");
    expect((await en<{ status: string }>(`select status from public.sager where id = $1`, [h.sagId])).status).toBe("aaben");
  });

  it("'ikke som beskrevet' følger den gamle regel: køberen betaler returfragten", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "ikke_som_beskrevet", await toBilleder(h.tradeId));
    expect((await afgoer(s.sag_id as string, "saelger")).kode).toBe("ugyldig_returfragt_betaler");
    expect((await afgoer(s.sag_id as string, null)).kode).toBe("ok");
    expect((await en<{ b: string }>(`select returfragt_betaler as b from public.sager where id = $1`, [s.sag_id])).b).toBe("koeber");
  });

  it("BidHamr betaler: indpakningen registreres ordentlig (reklamation), dækket returfragt uden faktura", async () => {
    const h = await skadeSag();
    const a = await afgoer(h.sagId, "bidhamr");
    expect(a.kode).toBe("ok");
    expect(a.handling).toBe("afvent_retur");
    const s = await en<{ status: string; returfragt_betaler: string }>(
      `select status, returfragt_betaler from public.sager where id = $1`,
      [h.sagId],
    );
    expect(s).toMatchObject({ status: "afventer_retur", returfragt_betaler: "bidhamr" });
    const o = await en<{ n: number }>(
      `select count(*)::int as n from public.indpakning_ordentlig where sag_id = $1 and tilbagekaldt_kl is null`,
      [h.sagId],
    );
    expect(o.n).toBe(1);
    // Ankefristen udløbet -> køberen starter returen: dækket (ingen betaling).
    await db.exec(`alter table public.sager disable trigger sager_beskyt`);
    await db.query(`update public.sager set penge_flyttes_efter_kl = now() - interval '1 minute' where id = $1`, [h.sagId]);
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
    const r = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
    expect(r.kode).toBe("daekket");
    expect(r.betaler).toBe("bidhamr");
    // Igen: samme række.
    const r2 = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
    expect(r2).toMatchObject({ kode: "daekket", id: r.id });
    const rf = await en<{ status: string; stripe_payment_intent_id: string | null; beloeb_oere: string }>(
      `select status, stripe_payment_intent_id, beloeb_oere from public.returfragt_betalinger where id = $1`,
      [r.id],
    );
    expect(rf).toMatchObject({ status: "betalt", stripe_payment_intent_id: null });
    expect(Number(rf.beloeb_oere)).toBe(4200);
    // Refunderes aldrig hos Stripe; faktureres ikke køberen.
    expect((await en<{ v: string }>(`select public.returfragt_refusion_claim($1, 'staff') as v`, [r.id])).v).toBe("daekket");
    await db.query(`select public.faktura_planlaeg_returfragt(100)`);
    const f = await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where returfragt_id = $1`, [r.id]);
    expect(f.n).toBe(0);
    // Betaleren kan ikke ændres, og en dækket række kan ikke få en PaymentIntent.
    await expect(db.query(`update public.returfragt_betalinger set betaler = 'koeber' where id = $1`, [r.id])).rejects.toThrow(
      /betaler/,
    );
    await expect(
      db.query(`update public.returfragt_betalinger set stripe_payment_intent_id = 'pi_x' where id = $1`, [r.id]),
    ).rejects.toThrow(/returfragt_betaler_check/);
  });

  it("kan returkoden ikke laves, annulleres den dækkede række (intet at refundere)", async () => {
    const h = await skadeSag();
    await afgoer(h.sagId, "bidhamr");
    await db.exec(`alter table public.sager disable trigger sager_beskyt`);
    await db.query(`update public.sager set penge_flyttes_efter_kl = now() - interval '1 minute' where id = $1`, [h.sagId]);
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
    const r = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
    expect((await en<{ v: string }>(`select public.returfragt_daekket_annuller($1, 'label_umulig') as v`, [r.id])).v).toBe("ok");
    expect((await en<{ s: string }>(`select status as s from public.returfragt_betalinger where id = $1`, [r.id])).s).toBe("annulleret");
    // Køberen kan starte igen.
    expect((await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER])).kode).toBe("daekket");
  });

  it("sælgeren betaler: dækket retur, og når returen er afleveret, får sælgeren en regning (ekstra fragt) - én gang", async () => {
    const h = await skadeSag();
    expect((await afgoer(h.sagId, "saelger")).kode).toBe("ok");
    await db.exec(`alter table public.sager disable trigger sager_beskyt`);
    await db.query(
      `update public.sager set penge_flyttes_efter_kl = now() - interval '1 minute', afgjort_kl = now() - interval '5 days' where id = $1`,
      [h.sagId],
    );
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
    const r = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
    expect(r).toMatchObject({ kode: "daekket", betaler: "saelger" });
    const retur = await en<{ id: string }>(
      `insert into public.forsendelser (trade_id, type, status, pakkestoerrelse) values ($1, 'retur', 'oprettet', 'lille') returning id`,
      [h.tradeId],
    );
    await db.query(`update public.returfragt_betalinger set forsendelse_id = $2, label_klar_kl = now() where id = $1`, [r.id, retur.id]);
    const a = await j(`select public.sag_retur_afleveret($1, $2, 'Afleveret i pakkeshop') as v`, [MEDARBEJDER, h.sagId]);
    expect(a.kode).toBe("ok");
    expect((a.returfragt_regning as R).kode).toBe("ok");
    const x = await en<{ slags: string; beloeb_oere: string; saelger_id: string; forsendelse_id: string; status: string; dage: number }>(
      `select slags, beloeb_oere, saelger_id, forsendelse_id, status,
              round(extract(epoch from frist - oprettet_kl) / 86400) as dage
         from public.ekstra_fragt_regninger where sag_id = $1`,
      [h.sagId],
    );
    expect(x).toMatchObject({ slags: "returfragt_sag", saelger_id: SAELGER, forsendelse_id: retur.id, status: "afventer_betaling" });
    expect(Number(x.beloeb_oere)).toBe(4200);
    expect(Number(x.dage)).toBe(14);
    // Igen: ingen ny regning.
    expect((await j(`select public.sag_returfragt_regning($1) as v`, [h.sagId])).kode).toBe("findes");
    // Fakturaen (når sælgeren har betalt) har returfragt-teksten.
    await db.query(
      `update public.ekstra_fragt_regninger set status = 'betalt', betalt_kl = now(), modtaget_oere = beloeb_oere where sag_id = $1`,
      [h.sagId],
    );
    const id = (await en<{ id: string }>(`select id from public.ekstra_fragt_regninger where sag_id = $1`, [h.sagId])).id;
    await db.query(`select * from public.ekstra_fragt_lav_faktura($1)`, [id]);
    const f = await en<{ linjer: { tekst: string }[]; part: string }>(
      `select linjer, part from public.fakturaer where ekstra_fragt_id = $1`,
      [id],
    );
    expect(f.part).toBe("saelger");
    expect(f.linjer[0].tekst).toContain("Returfragt");
    // slags og sag kan ikke ændres.
    await expect(db.query(`update public.ekstra_fragt_regninger set slags = 'for_lille_pakke' where id = $1`, [id])).rejects.toThrow(
      /slags/,
    );
  });

  it("sælger som betaler afvises, når indpakningen er vurderet ordentlig - og BidHamr, når den er vurderet dårlig", async () => {
    const h = await skadeSag();
    await db.query(`insert into public.indpakning_ordentlig (sag_id, trade_id, vurderet_af) values ($1, $2, $3)`, [
      h.sagId,
      h.tradeId,
      ADMIN,
    ]);
    expect((await afgoer(h.sagId, "saelger")).kode).toBe("indpakning_ordentlig");
    const h2 = await skadeSag();
    await db.query(`insert into public.paamindelser (sag_id, grund) values ($1, 'daarlig_indpakning')`, [h2.sagId]);
    expect((await afgoer(h2.sagId, "bidhamr")).kode).toBe("indpakning_daarlig");
    expect((await en<{ n: number }>(`select count(*)::int as n from public.indpakning_ordentlig where sag_id = $1`, [h2.sagId])).n).toBe(0);
  });

  it("anke, der omgøres til køberen ved transportskade, kræver også et valg", async () => {
    const h = await skadeSag();
    await j(`select public.sag_afgoer($1, $2, 'saelger', 'Ingen skade', null) as v`, [MEDARBEJDER, h.sagId]);
    const anke = await en<{ id: string }>(
      `insert into public.sag_anker (sag_id, trade_id, status, part, indgivet_af, ankede_afgjort_af)
       values ($1, $2, 'afventer', 'koeber', $3, $4) returning id`,
      [h.sagId, h.tradeId, KOEBER, MEDARBEJDER],
    );
    expect(
      (await j(`select public.sag_anke_afgoer($1, $2, 'omgoer', 'Skaden er dokumenteret', null) as v`, [ADMIN, anke.id])).kode,
    ).toBe("vaelg_returfragt_betaler");
    const r = await j(`select public.sag_anke_afgoer($1, $2, 'omgoer', 'Skaden er dokumenteret', null, false, 'bidhamr') as v`, [
      ADMIN,
      anke.id,
    ]);
    expect(r.kode).toBe("ok");
    expect((await en<{ b: string }>(`select returfragt_betaler as b from public.sager where id = $1`, [h.sagId])).b).toBe("bidhamr");
  });
});

// ------------------------------------------------------------------ 20261102350000

async function udenomTrigger(sql: string, p: unknown[]) {
  await db.exec(`alter table public.sager disable trigger sager_beskyt`);
  try {
    await db.query(sql, p);
  } finally {
    await db.exec(`alter table public.sager enable trigger sager_beskyt`);
  }
}

async function opretValg(trade: string, type: string, valg: string, billeder: { sti: string; kategori: string }[], smidt?: string) {
  await som(KOEBER);
  return j(`select public.sag_opret($1, $2, $3, $4::jsonb, $5, $6, $7) as v`, [
    trade,
    type,
    "Pakken var helt tom, da jeg åbnede den.",
    JSON.stringify(billeder),
    !!smidt,
    smidt ?? null,
    valg,
  ]);
}

const sagFelt = async <T>(sag: string, felt: string) =>
  (await en<{ v: T }>(`select ${felt} as v from public.sager where id = $1`, [sag])).v;

// Transportskade, sælgeren betaler; ankefristen udløbet, returen startet
// (dækket). label: returkoden er lavet.
async function saelgerRetur(o: { label: boolean }) {
  const h = await handel();
  const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
  const sagId = s.sag_id as string;
  expect((await j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null, false, 'saelger') as v`, [MEDARBEJDER, sagId])).kode).toBe(
    "ok",
  );
  await udenomTrigger(
    `update public.sager set penge_flyttes_efter_kl = now() - interval '1 minute', afgjort_kl = now() - interval '5 days' where id = $1`,
    [sagId],
  );
  const r = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
  expect(r).toMatchObject({ kode: "daekket", betaler: "saelger" });
  if (o.label) {
    const retur = await en<{ id: string }>(
      `insert into public.forsendelser (trade_id, type, status, pakkestoerrelse) values ($1, 'retur', 'oprettet', 'lille') returning id`,
      [h.tradeId],
    );
    await db.query(`update public.returfragt_betalinger set forsendelse_id = $2, label_klar_kl = now() where id = $1`, [r.id, retur.id]);
  }
  // Ankefristen løber stadig for pengene (så refusionen ikke afvikles, og
  // sagen kan genåbnes i testen).
  await udenomTrigger(`update public.sager set penge_flyttes_efter_kl = now() + interval '1 day' where id = $1`, [sagId]);
  const a = await j(`select public.sag_retur_afleveret($1, $2, 'Afleveret') as v`, [MEDARBEJDER, sagId]);
  expect(a.kode).toBe("ok");
  return { ...h, sagId, afleveret: a };
}

describe("20261102350000: B1 regningen for returfragt", () => {
  it("uden lavet returkode: ingen regning, 'ingen_daekning', staff markeret og drift-alarm - returen er stadig registreret", async () => {
    const før = (await en<{ n: number }>(`select count(*)::int as n from public.drift_fejl_stub`)).n;
    const h = await saelgerRetur({ label: false });
    expect((h.afleveret.returfragt_regning as R).kode).toBe("ingen_daekning");
    expect(await sagFelt<string>(h.sagId, "status")).toBe("afgjort_koeber");
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(true);
    expect(await sagFelt<string>(h.sagId, "opmaerksomhed_tekst")).toContain("returkode");
    const n = await en<{ n: number }>(`select count(*)::int as n from public.ekstra_fragt_regninger where sag_id = $1`, [h.sagId]);
    expect(n.n).toBe(0);
    const d = await en<{ n: number; digest: string }>(
      `select count(*)::int as n, max(digest) as digest from public.drift_fejl_stub where id > $1`,
      [før],
    );
    expect(d.n).toBe(1);
    expect(d.digest).toBe(`sag_returfragt_regning:${h.sagId}`);
  });

  it("med lavet returkode: regning på den dækkede rækkes beløb", async () => {
    const h = await saelgerRetur({ label: true });
    expect((h.afleveret.returfragt_regning as R).kode).toBe("ok");
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(false);
  });

  it("staff lukker markeringen (kun staff, ikke inhabil)", async () => {
    const h = await saelgerRetur({ label: false });
    expect((await j(`select public.sag_opmaerksomhed_luk($1, $2, null) as v`, [KOEBER, h.sagId])).kode).toBe("ingen_adgang");
    expect((await j(`select public.sag_opmaerksomhed_luk($1, $2, 'Opkræves manuelt') as v`, [MEDARBEJDER, h.sagId])).kode).toBe("ok");
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(false);
    expect((await j(`select public.sag_opmaerksomhed_luk($1, $2, null) as v`, [MEDARBEJDER, h.sagId])).kode).toBe("ikke_markeret");
  });
});

describe("20261102350000: B2 staff retter sagstypen", () => {
  it("ikke mens en anke venter - kun ved status 'aaben'", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
    await j(`select public.sag_afgoer($1, $2, 'saelger', 'Ingen skade', null) as v`, [MEDARBEJDER, s.sag_id]);
    await db.query(
      `insert into public.sag_anker (sag_id, trade_id, status, part, indgivet_af, ankede_afgjort_af) values ($1, $2, 'afventer', 'koeber', $3, $4)`,
      [s.sag_id, h.tradeId, KOEBER, MEDARBEJDER],
    );
    expect((await j(`select public.sag_ret_type($1, $2, 'svindel', 'Tom pakke') as v`, [ADMIN, s.sag_id])).kode).toBe("forkert_status");
  });

  it("samme trinregler som sag_opret", async () => {
    // Modtaget, køberen kvitterede selv: ikke 'bortkommet'.
    const a = await handel();
    const s = await opret(a.tradeId, "skadet", await toBilleder(a.tradeId));
    expect((await j(`select public.sag_ret_type($1, $2, 'bortkommet', 'Væk') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe("forkert_trin");
    // Fragtfirmaet meldte den leveret: 'bortkommet' er tilladt.
    const b = await handel({ kilde: "fragt" });
    const s2 = await opret(b.tradeId, "skadet", await toBilleder(b.tradeId));
    expect((await j(`select public.sag_ret_type($1, $2, 'bortkommet', 'Væk') as v`, [MEDARBEJDER, s2.sag_id])).kode).toBe("ok");
    // Pakken på vej: kun bortkommet/svindel.
    const c = await handel({ status: "pakke_sendt" });
    const s3 = await opret(c.tradeId, "bortkommet", []);
    expect(s3.kode).toBe("ok");
    expect((await j(`select public.sag_ret_type($1, $2, 'skadet', 'Skade') as v`, [MEDARBEJDER, s3.sag_id])).kode).toBe("forkert_trin");
    expect((await j(`select public.sag_ret_type($1, $2, 'svindel', 'Aldrig sendt') as v`, [MEDARBEJDER, s3.sag_id])).kode).toBe("ok");
  });

  it("fra 'skadet' til noget andet nulstiller returfragt_betaler", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
    await udenomTrigger(`update public.sager set returfragt_betaler = 'saelger' where id = $1`, [s.sag_id]);
    expect((await j(`select public.sag_ret_type($1, $2, 'ikke_som_beskrevet', 'Fejl') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe("ok");
    expect(await sagFelt<string | null>(s.sag_id as string, "returfragt_betaler")).toBeNull();
  });
});

describe("20261102350000: B3 og S1", () => {
  it("B3: den dækkede returfragt kun ved transportskade", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "ikke_som_beskrevet", await toBilleder(h.tradeId));
    await j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null) as v`, [MEDARBEJDER, s.sag_id]);
    // Forkert data: 'bidhamr' på en ikke-skade-sag.
    await udenomTrigger(
      `update public.sager set returfragt_betaler = 'bidhamr', penge_flyttes_efter_kl = now() - interval '1 minute' where id = $1`,
      [s.sag_id],
    );
    const r = await j(`select public.returfragt_start($1, $2) as v`, [h.tradeId, KOEBER]);
    expect(r.kode).toBe("ok");
    expect((await en<{ b: string }>(`select betaler as b from public.returfragt_betalinger where id = $1`, [r.id])).b).toBe("koeber");
  });

  it("S1: skade, hvor returen allerede er afleveret -> køberen står som betaler", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
    await udenomTrigger(`update public.sager set retur_afleveret_kl = now() where id = $1`, [s.sag_id]);
    expect((await j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null, false, 'saelger') as v`, [MEDARBEJDER, s.sag_id])).kode).toBe(
      "ok",
    );
    expect(await sagFelt<string>(s.sag_id as string, "returfragt_betaler")).toBe("koeber");
  });
});

describe("20261102350000: S3 kontaktinfo og tom pakke", () => {
  it("kontaktinfo i beskrivelsen eller forklaringen afvises", async () => {
    const h = await handel();
    await som(KOEBER);
    const r = await j(`select public.sag_opret($1, 'skadet', 'Ring til mig på 12345678 om skaden', $2::jsonb) as v`, [
      h.tradeId,
      JSON.stringify(await toBilleder(h.tradeId)),
    ]);
    expect(r.kode).toBe("kontaktinfo");
    const indhold = [{ sti: await billede(KOEBER, h.tradeId), kategori: "indhold" }];
    expect((await opret(h.tradeId, "skadet", indhold, { smidt: true, grund: "Skriv til mig på a@b.dk om pakken" })).kode).toBe(
      "kontaktinfo",
    );
  });

  it("tom pakke: kun pakken med labelen; 'anden vare' kræver stadig indholdet", async () => {
    const h = await handel();
    const pakke = [{ sti: await billede(KOEBER, h.tradeId), kategori: "pakke_label" }];
    expect((await opretValg(h.tradeId, "svindel", "anden_vare", pakke)).kode).toBe("billeder_kraeves");
    const r = await opretValg(h.tradeId, "svindel", "tom", pakke);
    expect(r.kode).toBe("ok");
    expect(await sagFelt<string>(r.sag_id as string, "koeber_valg")).toBe("tom");
    const note = await en<{ n: string }>(`select sag_note as n from public.trades where id = $1`, [h.tradeId]);
    expect(note.n).toContain("tom");
    // Valget er fast.
    await expect(db.query(`update public.sager set koeber_valg = 'stykker' where id = $1`, [r.sag_id])).rejects.toThrow(/faste oplysninger/);
  });

  it("tom pakke uden pakkebillede, med 'smidt ud' eller med forkert type afvises", async () => {
    const h = await handel();
    expect((await opretValg(h.tradeId, "svindel", "tom", [])).kode).toBe("billeder_kraeves");
    const indhold = [{ sti: await billede(KOEBER, h.tradeId), kategori: "indhold" }];
    expect((await opretValg(h.tradeId, "svindel", "tom", indhold, "Jeg smed papkassen ud samme dag.")).kode).toBe("smidt_ud_ikke_mulig");
    expect((await opretValg(h.tradeId, "skadet", "tom", indhold)).kode).toBe("ugyldigt_valg");
    expect((await opretValg(h.tradeId, "svindel", "noget", indhold)).kode).toBe("ugyldigt_valg");
  });

  it("smidt ud kræver stadig billede af varen og forklaringen", async () => {
    const h = await handel();
    expect((await opretValg(h.tradeId, "skadet", "stykker", [], "Jeg smed papkassen ud samme dag.")).kode).toBe("billeder_kraeves");
    const indhold = [{ sti: await billede(KOEBER, h.tradeId), kategori: "indhold" }];
    expect((await opretValg(h.tradeId, "skadet", "stykker", indhold, "Jeg smed papkassen ud samme dag.")).kode).toBe("ok");
  });

  it("svindel (tom pakke) med medhold: kun buddet", async () => {
    const h = await handel();
    const r = await opretValg(h.tradeId, "svindel", "tom", [{ sti: await billede(KOEBER, h.tradeId), kategori: "pakke_label" }]);
    expect((await j(`select public.sag_afgoer($1, $2, 'koeber', 'Tom pakke', null) as v`, [MEDARBEJDER, r.sag_id])).kode).toBe("ok");
    const b = await en<{ beloeb: string }>(`select * from public.sag_claim_refusion($1)`, [h.betalingId]);
    expect(Number(b.beloeb)).toBe(100000);
  });
});

describe("20261102350000: S4 påmindelser", () => {
  it("allerede sendte udelukkes, og nøglen følger med", async () => {
    const h = await handel({ timerSiden: 1 });
    await db.query(`update public.trades set received_at = now() - interval '68 hours' where id = $1`, [h.tradeId]);
    const k = await en<{ noegle: string; frist_kl: string }>(
      `select noegle, frist_kl::text from public.handel_problem_frist_paamind_kandidater(6) where trade_id = $1`,
      [h.tradeId],
    );
    const frist = await en<{ ms: string }>(
      `select floor(extract(epoch from problem_frist_kl) * 1000)::bigint::text as ms from public.trades where id = $1`,
      [h.tradeId],
    );
    expect(k.noegle).toBe(`problem_frist_paamind:${h.tradeId}:${frist.ms}`);
    await db.query(`insert into public.notifikation_afsendelser (noegle) values ($1)`, [k.noegle]);
    const efter = await db.query(`select 1 from public.handel_problem_frist_paamind_kandidater(6) where trade_id = $1`, [h.tradeId]);
    expect(efter.rows.length).toBe(0);

    const a = await handel();
    const s = await opret(a.tradeId, "skadet", await toBilleder(a.tradeId));
    await udenomTrigger(`update public.sager set oprettet_kl = now() - interval '40 hours' where id = $1`, [s.sag_id]);
    const sv = await en<{ noegle: string }>(`select noegle from public.sag_svar_paamind_kandidater(12) where sag_id = $1`, [s.sag_id]);
    expect(sv.noegle).toBe(`sag_svar_paamind:${s.sag_id}`);
    await db.query(`insert into public.notifikation_afsendelser (noegle) values ($1)`, [sv.noegle]);
    expect((await db.query(`select 1 from public.sag_svar_paamind_kandidater(12) where sag_id = $1`, [s.sag_id])).rows.length).toBe(0);
  });
});

describe("20261102350000: S5 BHX01 og S7 mine_data", () => {
  it("spærringen siger 'returfragt', når det er en regning for returfragt", async () => {
    const h = await saelgerRetur({ label: true });
    await db.query(`update public.ekstra_fragt_regninger set frist = now() - interval '1 day' where sag_id = $1`, [h.sagId]);
    await expect(db.query(`select public.ekstra_fragt_kraev($1)`, [SAELGER])).rejects.toThrow(/ekstra_fragt_ubetalt_(returfragt|begge)/);
    await db.query(`update public.ekstra_fragt_regninger set frist = now() + interval '14 days' where sag_id = $1`, [h.sagId]);
  });

  it("mine_data har sælgerens egne svar med billeder", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", await toBilleder(h.tradeId));
    const sti = await billede(SAELGER, h.tradeId);
    await som(SAELGER);
    await j(`select public.sag_svar_send($1, $2, $3::jsonb) as v`, [
      s.sag_id,
      "Stolen var hel, da jeg sendte den af sted.",
      JSON.stringify([{ sti, kategori: "indhold" }]),
    ]);
    const d = (await j(`select public.mine_data() as v`)) as { grund: boolean; sag_svar: { tekst: string; billeder: { sti: string }[] }[] };
    expect(d.grund).toBe(true);
    const mit = d.sag_svar.find((x) => x.tekst.startsWith("Stolen var hel, da jeg sendte den af sted."));
    expect(mit?.billeder.map((b) => b.sti)).toEqual([sti]);
    await som(KOEBER);
    const k = (await j(`select public.mine_data() as v`)) as { sag_svar: unknown[] };
    expect(k.sag_svar).toEqual([]);
  });
});

describe("20261102350000: S8 genåbning efter regningen for returfragt", () => {
  it("ubetalt regning frafaldes (åben PaymentIntent kasseres)", async () => {
    const h = await saelgerRetur({ label: true });
    await db.query(`update public.ekstra_fragt_regninger set stripe_payment_intent_id = 'pi_test_1' where sag_id = $1`, [h.sagId]);
    const g = await j(`select public.sag_genaabn($1, $2, 'Ny dokumentation') as v`, [ADMIN, h.sagId]);
    expect(g.kode).toBe("ok");
    expect(g.returfragt_regning).toMatchObject({ frafaldet: 1, alarm: 0 });
    const x = await en<{ status: string; annuller_pi: string; frafald_grund: string }>(
      `select status, annuller_pi, frafald_grund from public.ekstra_fragt_regninger where sag_id = $1`,
      [h.sagId],
    );
    expect(x).toMatchObject({ status: "frafaldet", annuller_pi: "pi_test_1" });
    expect(x.frafald_grund).toContain("genåbnet");
  });

  it("betalt regning: alarm til staff, intet frafald", async () => {
    const h = await saelgerRetur({ label: true });
    await db.query(
      `update public.ekstra_fragt_regninger set status = 'betalt', betalt_kl = now(), modtaget_oere = beloeb_oere where sag_id = $1`,
      [h.sagId],
    );
    const g = await j(`select public.sag_genaabn($1, $2, 'Ny dokumentation') as v`, [ADMIN, h.sagId]);
    expect(g.returfragt_regning).toMatchObject({ frafaldet: 0, alarm: 1 });
    const x = await en<{ status: string; kraever_opmaerksomhed: boolean }>(
      `select status, kraever_opmaerksomhed from public.ekstra_fragt_regninger where sag_id = $1`,
      [h.sagId],
    );
    expect(x).toMatchObject({ status: "betalt", kraever_opmaerksomhed: true });
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(true);
    const d = await en<{ n: number }>(`select count(*)::int as n from public.drift_fejl_stub where digest like 'sag_returfragt_betalt:%'`);
    expect(d.n).toBeGreaterThan(0);
  });
});

describe("20261102350000: bortkommet pakke -> reklamation (erstatningen til sælgeren)", () => {
  it("triggeren og cron'en tager bortkomne pakker med; skade uden vurderet indpakning ikke", async () => {
    await db.exec(`
      create table if not exists public.synk_log (sag_id uuid);
      create or replace function public.fragt_reklamation_synkroniser_sikker(p_sag uuid) returns text language sql as
        $$ insert into public.synk_log values (p_sag) returning 'stub' $$;
      drop trigger if exists sager_fragt_reklamation on public.sager;
      create trigger sager_fragt_reklamation after update of status, afviklet_kl, penge_handling on public.sager
        for each row when (new.status is distinct from old.status or new.afviklet_kl is distinct from old.afviklet_kl
                           or new.penge_handling is distinct from old.penge_handling)
        execute function public.sager_fragt_reklamation();`);
    const b = await handel({ kilde: "fragt" });
    const sb = await opret(b.tradeId, "bortkommet", []);
    const k = await handel();
    const sk = await opret(k.tradeId, "skadet", await toBilleder(k.tradeId));
    for (const s of [sb.sag_id, sk.sag_id]) {
      await udenomTrigger(
        `update public.sager set status = 'afgjort_koeber', penge_handling = 'refunder', afviklet_kl = now(), afgjort_kl = now() - interval '5 days' where id = $1`,
        [s],
      );
    }
    // Triggeren (udenomTrigger slår kun sager_beskyt fra) synkroniserer
    // begge typer - betingelserne afgør resten.
    const t = await db.query<{ sag_id: string }>(`select sag_id from public.synk_log`);
    expect(t.rows.map((x) => x.sag_id)).toContain(sb.sag_id);
    expect(t.rows.map((x) => x.sag_id)).toContain(sk.sag_id);
    await db.exec(`delete from public.synk_log`);
    await db.query(`select public.fragt_reklamationer_synkroniser_alle(1000)`);
    const c = await db.query<{ sag_id: string }>(`select sag_id from public.synk_log`);
    expect(c.rows.map((x) => x.sag_id)).toContain(sb.sag_id);
    expect(c.rows.map((x) => x.sag_id)).not.toContain(sk.sag_id);
    await db.exec(`drop trigger sager_fragt_reklamation on public.sager`);
  });
});

describe("20261102350000: md5-drift-tjek", () => {
  it("afbryder før ændringerne, hvis en funktion er ændret af andre", async () => {
    const d = new PGlite();
    await opsaet(d);
    await d.exec(SAGSREGLER);
    await opsaetRettelser(d);
    await d.exec(`create or replace function public.sag_genaabn(p_medarbejder uuid, p_sag uuid, p_begrundelse text)
                  returns jsonb language plpgsql as $$ begin return '{}'::jsonb; end $$;`);
    await expect(d.exec(RETTELSER)).rejects.toThrow(/sag_genaabn.*hverken gammel eller ny/);
    const r = await d.query<{ f: string | null }>(`select to_regprocedure('public.sag_staff_marker(uuid,text)')::text as f`);
    expect(r.rows[0].f).toBeNull();
    await d.close();
  }, 60_000);
});

describe("md5-drift-tjek", () => {
  it("afbryder, hvis en funktion er ændret af andre end migrationen", async () => {
    const d = new PGlite();
    await opsaet(d);
    await d.exec(`create or replace function public.handel_auto_frigiv() returns jsonb language plpgsql as $$ begin return '[]'::jsonb; end $$;`);
    await expect(d.exec(SAGSREGLER)).rejects.toThrow(/handel_auto_frigiv.*hverken gammel eller ny/);
    // Intet er ændret (én transaktion afbrudt før ændringerne).
    const r = await d.query<{ f: string | null }>(`select to_regprocedure('public.sag_svar_send(uuid,text,jsonb)')::text as f`);
    expect(r.rows[0].f).toBeNull();
    await d.close();
  }, 60_000);
});

// ------------------------------------------------------------------ 20261102410000

describe("20261102410000: billede før sælgerens regning og markering ved frafald", () => {
  beforeAll(async () => {
    const afsnit = huskelisteAfsnit("sag");
    await db.exec(afsnit);
    await db.exec(afsnit); // idempotent
  });

  const GRUND = "Jeg smed pakken ud, før jeg så skaden på stolen.";
  const afgoer = (sag: string, betaler: string | null) =>
    j(`select public.sag_afgoer($1, $2, 'koeber', 'Medhold', null, false, $3) as v`, [MEDARBEJDER, sag, betaler]);

  it("sælgeren betaler returfragten kræver et billede af pakken eller labelen: billeder_mangler", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", [{ sti: await billede(KOEBER, h.tradeId), kategori: "indhold" }], {
      smidt: true,
      grund: GRUND,
    });
    expect(s.kode).toBe("ok");
    const sagId = s.sag_id as string;
    expect((await afgoer(sagId, "saelger")).kode).toBe("billeder_mangler");
    expect(await sagFelt<string>(sagId, "status")).toBe("aaben");
    // BidHamr som betaler kræver intet billede.
    expect((await afgoer(sagId, "bidhamr")).kode).toBe("ok");
  });

  it("billede af labelen eller pakken er nok", async () => {
    const h = await handel();
    const s = await opret(
      h.tradeId,
      "skadet",
      [
        { sti: await billede(KOEBER, h.tradeId), kategori: "label" },
        { sti: await billede(KOEBER, h.tradeId), kategori: "indhold" },
      ],
      { smidt: true, grund: GRUND },
    );
    expect((await afgoer(s.sag_id as string, "saelger")).kode).toBe("ok");
    const h2 = await handel();
    const s2 = await opret(h2.tradeId, "skadet", await toBilleder(h2.tradeId));
    expect((await afgoer(s2.sag_id as string, "saelger")).kode).toBe("ok");
  });

  it("anke omgjort til køberen: også billeder_mangler uden pakkebillede", async () => {
    const h = await handel();
    const s = await opret(h.tradeId, "skadet", [{ sti: await billede(KOEBER, h.tradeId), kategori: "indhold" }], {
      smidt: true,
      grund: GRUND,
    });
    const sagId = s.sag_id as string;
    await j(`select public.sag_afgoer($1, $2, 'saelger', 'Ingen skade', null) as v`, [MEDARBEJDER, sagId]);
    const anke = await en<{ id: string }>(
      `insert into public.sag_anker (sag_id, trade_id, status, part, indgivet_af, ankede_afgjort_af)
       values ($1, $2, 'afventer', 'koeber', $3, $4) returning id`,
      [sagId, h.tradeId, KOEBER, MEDARBEJDER],
    );
    expect(
      (await j(`select public.sag_anke_afgoer($1, $2, 'omgoer', 'Skaden er dokumenteret', null, false, 'saelger') as v`, [ADMIN, anke.id]))
        .kode,
    ).toBe("billeder_mangler");
  });

  it("genåbning efter retur: frafaldet regning markerer sagen hos staff (BidHamr kan stå med returfragten)", async () => {
    const h = await saelgerRetur({ label: true });
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(false);
    const g = await j(`select public.sag_genaabn($1, $2, 'Ny dokumentation') as v`, [ADMIN, h.sagId]);
    expect(g.kode).toBe("ok");
    expect(g.returfragt_regning).toMatchObject({ frafaldet: 1, alarm: 0 });
    expect(await sagFelt<boolean>(h.sagId, "kraever_opmaerksomhed")).toBe(true);
    const tekst = await sagFelt<string>(h.sagId, "opmaerksomhed_tekst");
    expect(tekst).toContain("frafaldet");
    expect(tekst).toContain("BidHamr kan stå med returfragten");
    // Regningen selv er frafaldet som før.
    expect((await en<{ status: string }>(`select status from public.ekstra_fragt_regninger where sag_id = $1`, [h.sagId])).status).toBe(
      "frafaldet",
    );
  });

  it("md5-drift-tjek: en ændret funktion stopper afsnittet", async () => {
    const d = new PGlite();
    await opsaet(d);
    await d.exec(SAGSREGLER);
    await opsaetRettelser(d);
    await d.exec(RETTELSER);
    const fn = (await d.query<{ def: string }>(
      `select pg_get_functiondef('public.sag_indpakning_ved_afgoerelse(uuid,uuid,uuid,uuid,text)'::regprocedure) def`,
    )).rows[0].def;
    await d.exec(fn.replace("'ugyldig_returfragt_betaler'", "'ugyldig'"));
    await expect(d.exec(huskelisteAfsnit("sag"))).rejects.toThrow(/sag_indpakning_ved_afgoerelse.*md5/);
    await d.close();
  });
});
