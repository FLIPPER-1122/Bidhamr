// Scenarie: fragtfirmaets sporing melder pakken leveret/afhentet, og
// 48-timers uret starter af sig selv (ROADMAP fase 2 "Auto-frigivelse 48
// timer efter afhentning, hvis ingen sag"; 20261030010000,
// src/lib/betaling/fragtUr.ts).
//
// Leveringsmeldingen simuleres med den rigtige indgang
// (registrerForsendelseshaendelse - samme som DAO's sporingsfeed), på en
// DAO-forsendelse, der er indsat som fixture (ingen DAO-nøgler i testmiljøet).
//   - Uret regnes fra registreringen hos os, ikke fra DAO's (forsinkede)
//     hændelsestidspunkt.
//   - Samme melding to gange (og parallelle kald) giver ingen ny effekt.
//   - Efter 48 timer uden sag frigives pengene automatisk (ingen bedømmelse).
//   - Aldrig når der er en sag, når pakken er returneret, eller når meldingen
//     kommer fra Shipmondo uden SHIPMONDO_LEVERET_FRIGIVER.
//   - Når fragtfirmaet startede uret, kan køberen melde pakken bortkommet
//     (uden billeder) inden for 48 timer, og så frigives intet. Efter 48
//     timer: for_sent.
//   - Intet ur ved blokerende indsigelse, refusion, afhentning hos sælger,
//     lukket sag eller registreret "ikke afhentet".
//   - 14-dages-reglen frigiver ikke før 48 timer efter leveringsmeldingen.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrerForsendelseshaendelse } from "@/lib/fragt/server";
import { frigivAutomatisk } from "@/lib/betaling/autoFrigiv";
import { startUrFraFragt } from "@/lib/betaling/fragtUr";
import { admin, betal, betaling, forberedSaelger, opretHandel, pakkeSendt, rydOp, type TestHandel } from "./handel";
import { logIndSom } from "./session";
import { CHEF_ID } from "./brugere";

const TIME = 60 * 60 * 1000;

let hA: TestHandel; // DAO leveret -> uret -> frigivet efter 48 t
let hB: TestHandel; // sag (bortkommet) før leveringsmeldingen -> intet ur
let hC: TestHandel; // uret startet -> køberen melder bortkommet -> intet frigives
let hD: TestHandel; // returneret, derefter "leveret" -> intet ur
let hE: TestHandel; // Shipmondo uden flaget -> intet ur
let hF: TestHandel; // indsigelse, afhentning, refusion, lukket sag -> intet ur; 14 dage venter 48 t
let hG: TestHandel; // "ikke afhentet" registreret -> intet ur

beforeAll(async () => {
  await forberedSaelger();
  hA = await opretHandel({ navn: "fragt-48t-frigiv", budOere: 20_000 });
  hB = await opretHandel({ navn: "fragt-48t-sag-foer", budOere: 20_000 });
  hC = await opretHandel({ navn: "fragt-48t-bortkommet", budOere: 20_000 });
  hD = await opretHandel({ navn: "fragt-48t-retur", budOere: 20_000 });
  hE = await opretHandel({ navn: "fragt-48t-shipmondo", budOere: 20_000 });
  hF = await opretHandel({ navn: "fragt-48t-blokeret", budOere: 20_000 });
  hG = await opretHandel({ navn: "fragt-48t-ikke-afhentet", budOere: 20_000 });
});

afterAll(async () => {
  for (const h of [hA, hB, hC, hD, hE, hF, hG]) if (h) await rydOp(h);
});

type Handel = {
  status: string;
  received_at: string | null;
  modtaget_kilde: string | null;
  fragt_ur_besked_kl: string | null;
};

async function handel(h: TestHandel): Promise<Handel> {
  const { data, error } = await admin()
    .from("trades")
    .select("status, received_at, modtaget_kilde, fragt_ur_besked_kl")
    .eq("id", h.tradeId)
    .single<Handel>();
  if (error || !data) throw new Error(`trades: ${error?.message}`);
  return data;
}

// En aktiv udgående label (som efter "Send pakke" med BidHamrs fragtlabel).
async function forsendelse(h: TestHandel, fragtfirma: "dao" | "shipmondo" = "dao"): Promise<string> {
  const { data, error } = await admin()
    .from("forsendelser")
    .insert({
      trade_id: h.tradeId,
      type: "udgaaende",
      fragtfirma,
      status: "oprettet",
      pakkestoerrelse: "lille",
      sporingsnummer: `TEST${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      levering: "pakkeshop",
    })
    .select("id, leveret_frigiver")
    .single<{ id: string; leveret_frigiver: boolean }>();
  if (error || !data) throw new Error(`forsendelser: ${error?.message}`);
  expect(data.leveret_frigiver).toBe(fragtfirma !== "shipmondo");
  return data.id;
}

// DAO's melding kan være op til 24 timer forsinket: hændelsen er 20 timer gammel.
function leveret(noegle: string) {
  return {
    type: "leveret" as const,
    tidspunkt: new Date(Date.now() - 20 * TIME).toISOString(),
    noegle,
    beskrivelse: "TEST: pakken er udleveret til modtageren",
  };
}

async function noegler(tradeId: string): Promise<string[]> {
  const { data } = await admin()
    .from("notifikation_afsendelser")
    .select("noegle")
    .in("noegle", [`fragt_ur:${tradeId}`, `pakke_leveret:${tradeId}`, `fragt_leveret:${tradeId}`, `auto_frigivet:${tradeId}`]);
  return (data ?? []).map((r) => r.noegle as string).sort();
}

// Flytter uret 49 timer tilbage (som om fristen er gået).
async function fristUdloebet(h: TestHandel) {
  const { error } = await admin()
    .from("trades")
    .update({ received_at: new Date(Date.now() - 49 * TIME).toISOString() })
    .eq("id", h.tradeId);
  if (error) throw new Error(`received_at: ${error.message}`);
}

describe("fragtfirmaets leveringsmelding starter 48-timers uret", () => {
  it("DAO melder leveret: handlen går til 'modtaget' fra registreringen hos os, og begge parter får besked", async () => {
    await betal(hA);
    await pakkeSendt(hA);
    const fid = await forsendelse(hA);
    const foer = Date.now();
    const r = await registrerForsendelseshaendelse(fid, leveret("test-leveret-A"), "sporing");
    expect(r.ny).toBe(true);

    const t = await handel(hA);
    expect(t.status).toBe("modtaget");
    expect(t.modtaget_kilde).toBe("fragt");
    // Ikke DAO's tidspunkt (20 timer siden), men registreringen nu.
    expect(Date.parse(t.received_at!)).toBeGreaterThanOrEqual(foer - 60_000);
    expect(t.fragt_ur_besked_kl).not.toBeNull();
    // Køberen: "48 timer til at melde en fejl"; sælgeren: fristen. Ikke den
    // gamle "Tryk Jeg har modtaget pakken".
    expect(await noegler(hA.tradeId)).toEqual([`fragt_ur:${hA.tradeId}`, `pakke_leveret:${hA.tradeId}`]);
    const { data: f } = await admin().from("forsendelser").select("leveret_besked_kl").eq("id", fid).single();
    expect(f?.leveret_besked_kl).not.toBeNull();
  });

  it("samme melding igen og parallelle kald: ingen ny effekt", async () => {
    const foer = await handel(hA);
    const { data: f } = await admin().from("forsendelser").select("id").eq("trade_id", hA.tradeId).single();
    const r = await registrerForsendelseshaendelse(f!.id as string, leveret("test-leveret-A"), "sporing");
    expect(r.ny).toBe(false);
    const [a, b] = await Promise.all([
      admin().rpc("handel_fragt_leveret_start", { p_trade: hA.tradeId }),
      admin().rpc("handel_fragt_leveret_start", { p_trade: hA.tradeId }),
    ]);
    expect(a.data).toEqual([]);
    expect(b.data).toEqual([]);
    expect(await startUrFraFragt(hA.tradeId)).toEqual({ ok: true, startet: 0 });
    expect(await handel(hA)).toEqual(foer);
  });

  it("køberen kan ikke trykke 'modtaget' igen og forlænge uret", async () => {
    const foer = await handel(hA);
    const klient = await logIndSom(hA.koeber.id, hA.koeber.email);
    const { data } = await klient.rpc("trade_marker_modtaget", { p_trade: hA.tradeId });
    expect(data).toBe(false);
    expect((await handel(hA)).received_at).toBe(foer.received_at);
  });

  it("brugerne kan ikke selv sætte modtaget_kilde eller starte uret", async () => {
    const klient = await logIndSom(hA.koeber.id, hA.koeber.email);
    const { error: u } = await klient.from("trades").update({ modtaget_kilde: null }).eq("id", hA.tradeId);
    expect(u).not.toBeNull();
    const { error: r } = await klient.rpc("handel_fragt_leveret_start", { p_trade: hA.tradeId });
    expect(r).not.toBeNull();
    // Parterne kan læse kilden (appen).
    const { data } = await klient.from("trades").select("modtaget_kilde").eq("id", hA.tradeId).single();
    expect(data?.modtaget_kilde).toBe("fragt");
  });

  it("inden 48 timer: intet frigives", async () => {
    await frigivAutomatisk();
    const b = await betaling(hA.betalingId);
    expect(b.frigivet_kl).toBeNull();
    expect((await handel(hA)).status).toBe("modtaget");
  });

  it("48 timer uden sag: bortkommet er for sent, og pengene frigives automatisk én gang, uden bedømmelse", async () => {
    await fristUdloebet(hA);
    const klient = await logIndSom(hA.koeber.id, hA.koeber.email);
    const { data: sag } = await klient.rpc("sag_opret", {
      p_trade: hA.tradeId,
      p_type: "bortkommet",
      p_beskrivelse: "TEST pengetest: bortkommet efter de 48 timer.",
      p_billeder: [],
    });
    expect((sag as { kode: string }).kode).toBe("for_sent");
    await frigivAutomatisk();
    const b = await betaling(hA.betalingId);
    expect(b.frigivet_kl).not.toBeNull();
    expect((await handel(hA)).status).toBe("leveret");
    const frigivet = b.frigivet_kl;
    await frigivAutomatisk();
    expect((await betaling(hA.betalingId)).frigivet_kl).toBe(frigivet);
    const { count } = await admin()
      .from("ratings")
      .select("id", { count: "exact", head: true })
      .eq("trade_id", hA.tradeId);
    expect(count ?? 0).toBe(0);
    expect(await noegler(hA.tradeId)).toContain(`auto_frigivet:${hA.tradeId}`);
    const { data: afregning } = await admin()
      .from("notifikation_afsendelser")
      .select("noegle")
      .eq("noegle", `afregning_saelger:${hA.tradeId}`);
    expect(afregning?.length).toBe(1);
  });

  it("sag oprettet før leveringsmeldingen: uret starter ikke", async () => {
    await betal(hB);
    await pakkeSendt(hB);
    // "Pakken er ikke kommet frem" kan meldes 7 dage efter afsendelsen.
    await admin()
      .from("trades")
      .update({ sendt_kl: new Date(Date.now() - 8 * 24 * TIME).toISOString() })
      .eq("id", hB.tradeId);
    const klient = await logIndSom(hB.koeber.id, hB.koeber.email);
    const { data: sag } = await klient.rpc("sag_opret", {
      p_trade: hB.tradeId,
      p_type: "bortkommet",
      p_beskrivelse: "TEST pengetest: pakken er ikke kommet frem.",
      p_billeder: [],
    });
    expect((sag as { kode: string }).kode).toBe("ok");
    const fid = await forsendelse(hB);
    await registrerForsendelseshaendelse(fid, leveret("test-leveret-B"), "sporing");
    const t = await handel(hB);
    expect(t.status).toBe("pakke_sendt");
    expect(t.modtaget_kilde).toBeNull();
  });

  it("uret startet af fragtfirmaet: køberen kan melde pakken bortkommet uden billeder, og intet frigives", async () => {
    await betal(hC);
    await pakkeSendt(hC);
    const fid = await forsendelse(hC);
    await registrerForsendelseshaendelse(fid, leveret("test-leveret-C"), "sporing");
    expect((await handel(hC)).modtaget_kilde).toBe("fragt");

    const klient = await logIndSom(hC.koeber.id, hC.koeber.email);
    const { data: sag } = await klient.rpc("sag_opret", {
      p_trade: hC.tradeId,
      p_type: "bortkommet",
      p_beskrivelse: "TEST pengetest: fragtfirmaet siger leveret, men jeg har ikke fået pakken.",
      p_billeder: [],
    });
    expect((sag as { kode: string }).kode).toBe("ok");
    const { data: s } = await admin()
      .from("sager")
      .select("type, tjek_sporing, handel_status_ved_oprettelse")
      .eq("trade_id", hC.tradeId)
      .single();
    expect(s).toEqual({ type: "bortkommet", tjek_sporing: true, handel_status_ved_oprettelse: "modtaget" });

    await fristUdloebet(hC);
    await frigivAutomatisk();
    expect((await betaling(hC.betalingId)).frigivet_kl).toBeNull();
  });

  it("køberen trykkede selv 'modtaget': bortkommet er stadig ikke muligt (uændret)", async () => {
    // hB's sag fylder; brug en frisk tilstand på hD før returen.
    await betal(hD);
    await pakkeSendt(hD);
    const klient = await logIndSom(hD.koeber.id, hD.koeber.email);
    const { data: m } = await klient.rpc("trade_marker_modtaget", { p_trade: hD.tradeId });
    expect(m).toBe(true);
    const { data: sag } = await klient.rpc("sag_opret", {
      p_trade: hD.tradeId,
      p_type: "bortkommet",
      p_beskrivelse: "TEST pengetest: forsøg på bortkommet efter eget modtaget.",
      p_billeder: [],
    });
    expect((sag as { kode: string }).kode).toBe("forkert_trin");
    // Tilbage til 'pakke_sendt' til næste scenarie (fixture).
    await admin().from("trades").update({ status: "pakke_sendt", received_at: null }).eq("id", hD.tradeId);
  });

  it("pakken er meldt returneret: en senere 'leveret' starter ikke uret", async () => {
    const fid = await forsendelse(hD);
    await registrerForsendelseshaendelse(
      fid,
      { type: "returneret", tidspunkt: new Date().toISOString(), noegle: "test-retur-D", beskrivelse: "TEST: retur til afsender" },
      "sporing",
    );
    await registrerForsendelseshaendelse(fid, leveret("test-leveret-D"), "sporing");
    const t = await handel(hD);
    expect(t.status).toBe("pakke_sendt");
    expect(t.modtaget_kilde).toBeNull();
    expect(await startUrFraFragt(hD.tradeId)).toEqual({ ok: true, startet: 0 });
  });

  it("Shipmondo uden SHIPMONDO_LEVERET_FRIGIVER: uret starter ikke (Filip, 15. okt. 2026)", async () => {
    await betal(hE);
    await pakkeSendt(hE);
    const fid = await forsendelse(hE, "shipmondo");
    await registrerForsendelseshaendelse(fid, leveret("test-leveret-E"), "webhook");
    const t = await handel(hE);
    expect(t.status).toBe("pakke_sendt");
    expect(t.modtaget_kilde).toBeNull();
    // Den gamle besked ("Tryk Jeg har modtaget pakken").
    expect(await noegler(hE.tradeId)).toEqual([`fragt_leveret:${hE.tradeId}`]);
  });

  // Kalder starten direkte (leveret_kl er allerede sat) og tjekker, at intet
  // ur blev startet.
  async function ingenUr(h: TestHandel) {
    const { data, error } = await admin().rpc("handel_fragt_leveret_start", { p_trade: h.tradeId });
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const t = await handel(h);
    expect(t.status).toBe("pakke_sendt");
    expect(t.modtaget_kilde).toBeNull();
  }

  async function opdaterBetaling(h: TestHandel, felter: Record<string, unknown>) {
    const { error } = await admin().from("betalinger").update(felter).eq("id", h.betalingId);
    if (error) throw new Error(`betalinger: ${error.message}`);
  }

  async function opdaterHandel(h: TestHandel, felter: Record<string, unknown>) {
    const { error } = await admin().from("trades").update(felter).eq("id", h.tradeId);
    if (error) throw new Error(`trades: ${error.message}`);
  }

  it("blokerende indsigelse: leveringsmeldingen starter ikke uret", async () => {
    await betal(hF);
    await pakkeSendt(hF);
    const fid = await forsendelse(hF);
    await opdaterBetaling(hF, { indsigelse_kl: new Date().toISOString(), indsigelse_status: "needs_response" });
    try {
      await registrerForsendelseshaendelse(fid, leveret("test-leveret-F"), "sporing");
      const t = await handel(hF);
      expect(t.status).toBe("pakke_sendt");
      expect(t.modtaget_kilde).toBeNull();
      await ingenUr(hF);
    } finally {
      await opdaterBetaling(hF, { indsigelse_kl: null, indsigelse_status: null });
    }
  });

  it("afhentning hos sælgeren: intet ur", async () => {
    await opdaterHandel(hF, { afhentning: true });
    try {
      await ingenUr(hF);
    } finally {
      await opdaterHandel(hF, { afhentning: false });
    }
  });

  it("refusion anmodet: intet ur", async () => {
    await opdaterBetaling(hF, { refusion_anmodet_kl: new Date().toISOString() });
    try {
      await ingenUr(hF);
    } finally {
      await opdaterBetaling(hF, { refusion_anmodet_kl: null });
    }
  });

  it("lukket sag: intet ur", async () => {
    const nu = new Date().toISOString();
    const { error } = await admin().from("sager").insert({
      trade_id: hF.tradeId,
      oprettet_af: hF.koeber.id,
      type: "bortkommet",
      beskrivelse: "TEST pengetest: lukket sag før leveringsmeldingen.",
      status: "lukket",
      beskyttelse: false,
      handel_status_ved_oprettelse: "pakke_sendt",
      afgjort_af: CHEF_ID,
      afgjort_kl: nu,
      begrundelse: "TEST pengetest: sagen er lukket.",
    });
    expect(error).toBeNull();
    await ingenUr(hF);
  });

  it("14-dages-reglen: frigiver ikke før 48 timer efter leveringsmeldingen", async () => {
    // Sendt for 15 dage siden; leveringsmeldingen er registreret lige nu
    // (fragtfirmaets tidspunkt 20 timer siden) og startede ikke uret (lukket sag).
    await opdaterHandel(hF, { sendt_kl: new Date(Date.now() - 15 * 24 * TIME).toISOString() });
    await frigivAutomatisk();
    let b = await betaling(hF.betalingId);
    expect(b.frigivet_kl).toBeNull();
    // Ingen staff-opgave ("ikke meldt leveret") - handlen venter bare.
    expect(b.auto_frigiv_opgave_kl ?? null).toBeNull();
    expect((await handel(hF)).status).toBe("pakke_sendt");

    // Fragtfirmaets tidspunkt er over 48 timer gammelt, men registreringen
    // hos os er ny: stadig intet (det seneste af de to tæller).
    const { data: f } = await admin().from("forsendelser").select("id").eq("trade_id", hF.tradeId).single();
    const fid = f!.id as string;
    const { error: lFejl } = await admin()
      .from("forsendelser")
      .update({ leveret_kl: new Date(Date.now() - 50 * TIME).toISOString() })
      .eq("id", fid);
    expect(lFejl).toBeNull();
    await frigivAutomatisk();
    expect((await betaling(hF.betalingId)).frigivet_kl).toBeNull();

    // Fixture: leveringsmeldingen blev først registreret for 50 timer siden
    // (den første registrering tæller). Nu frigives pengene efter 14 dage.
    const gammel = new Date(Date.now() - 50 * TIME).toISOString();
    const { error: hFejl } = await admin().from("forsendelse_haendelser").insert({
      forsendelse_id: fid,
      type: "leveret",
      tidspunkt: gammel,
      noegle: `test-leveret-F-gammel-${randomUUID()}`,
      beskrivelse: "TEST: leveringsmelding registreret for 50 timer siden",
      kilde: "test",
      modtaget_kl: gammel,
    });
    expect(hFejl).toBeNull();
    await frigivAutomatisk();
    b = await betaling(hF.betalingId);
    expect(b.frigivet_kl).not.toBeNull();
    expect((await handel(hF)).status).toBe("leveret");
  });

  it('"ikke afhentet" registreret: leveringsmeldingen starter ikke uret', async () => {
    await betal(hG);
    await pakkeSendt(hG);
    const b = await betaling(hG.betalingId);
    const total = Number(b.total_oere);
    const gebyr = Number(b.koebergebyr_oere);
    const besk = Number(b.beskyttelse_oere ?? 0);
    const fragt = Number(b.fragt_oere);
    // Fixture direkte i tabellen (ingen refusion sat i gang), så det kun er
    // registreringen, der blokerer.
    const { error } = await admin().from("handel_ikke_afhentet").insert({
      trade_id: hG.tradeId,
      betaling_id: hG.betalingId,
      kilde: "staff",
      medarbejder_id: CHEF_ID,
      begrundelse: "TEST pengetest: pakken kom retur uden at være hentet.",
      total_oere: total,
      koebergebyr_oere: gebyr,
      beskyttelse_oere: besk,
      fragt_oere: fragt,
      returfragt_oere: fragt,
      refusion_oere: Math.max(0, total - gebyr - besk - fragt - fragt),
    });
    expect(error).toBeNull();
    expect((await betaling(hG.betalingId)).refusion_anmodet_kl ?? null).toBeNull();
    const fid = await forsendelse(hG);
    await registrerForsendelseshaendelse(fid, leveret("test-leveret-G"), "sporing");
    const t = await handel(hG);
    expect(t.status).toBe("pakke_sendt");
    expect(t.modtaget_kilde).toBeNull();
    expect(await startUrFraFragt(hG.tradeId)).toEqual({ ok: true, startet: 0 });
  });
});
