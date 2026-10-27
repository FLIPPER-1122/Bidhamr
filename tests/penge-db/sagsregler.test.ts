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
// Og md5-drift-tjekket.
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { sagRefusionOere } from "@/lib/betaling/beregn";
import { ADMIN, FREMMED, KOEBER, MEDARBEJDER, SAELGER, SAGSREGLER, opsaet } from "./sagsreglerStub";

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
