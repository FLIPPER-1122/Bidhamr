// Dokumentation til sælger og til politiet (ROADMAP-BESLUTNINGER, "Dokumentation
// til politiet (Filip, 27. okt. 2026)"):
//   - rolletjek: staff kan ikke lave udgaven til politiet, inhabile kan ingen af dem
//   - udgaven til sælger indeholder ikke e-mail, MitID, telefon eller spamstoppede beskeder
//   - hver udlevering logges (sag_dokumentation_log), og uden log sendes ingen PDF
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { bygDokument, dokumentTekst, type DokumentationData } from "@/lib/sagDokumentation/indhold";
import {
  dokumentationAfvisning,
  dokumentationFilnavn,
  maaLaveDokumentation,
  rensFelt,
  tjekFelter,
} from "@/lib/sagDokumentation/regler";

const SAG = "55555555-5555-4555-8555-0000000000d1";
const KOEBER = "11111111-1111-4111-8111-000000000001";
const SAELGER = "11111111-1111-4111-8111-000000000002";
const MIG = "99999999-9999-4999-8999-999999999999";

const EMAIL = "koeber.hemmelig@example.com";
const TELEFON = "+45 12 34 56 78";
const MITID_NAVN = "Karl Juridisk Køber";
const FOEDSEL = "1990-04-17";
const STOPPET = "Skriv til mig på 87654321";

function data(): DokumentationData {
  return {
    sag: {
      id: SAG,
      type: "svindel",
      oprindeligType: null,
      status: "aaben",
      oprettetKl: "2026-10-20T10:00:00.000Z",
      beskrivelse: "Pakken var tom, da jeg åbnede den.",
      beskyttelse: true,
      pakkeSmidtUd: false,
      pakkeSmidtUdBegrundelse: null,
      afgjortKl: null,
      begrundelse: null,
      returKraeves: false,
      returAfleveretKl: null,
    },
    handel: {
      id: "77777777-7777-4777-8777-777777777777",
      oprettetKl: "2026-10-10T10:00:00.000Z",
      afhentning: false,
      sendtKl: "2026-10-12T08:00:00.000Z",
      modtagetKl: null,
      sporingsnummer: "00370730253434081234",
    },
    auktion: {
      id: "a",
      titel: "iPhone 15 Pro",
      beskrivelse: "Som ny",
      kategori: "Elektronik",
      maerke: "Apple",
      stand: "Som ny",
      vaegtGram: 400,
    },
    auktionBilleder: [{ tekst: "Auktionsbillede 1", tid: null, bytes: null, format: null }],
    betaling: { budOere: 500000, fragtOere: 4900, totalOere: 512400, betaltKl: "2026-10-11T09:00:00.000Z", status: "betalt" },
    koeberNavn: "Karl K.",
    saelgerNavn: "Sofie S.",
    levering: { maade: "pakkeshop", navn: "Karl Køber", adresse: "Testvej 1", postnummer: "4684", by: "Holmegaard", pakkeshop: "Netto, Hovedgaden 2" },
    forsendelser: [
      {
        retning: "udgaaende",
        fragtfirma: "GLS",
        sporingsnummer: "00370730253434081234",
        oprettetKl: "2026-10-11T12:00:00.000Z",
        afleveretKl: "2026-10-12T08:00:00.000Z",
        leveretKl: "2026-10-14T13:00:00.000Z",
        angivetVaegtGram: 500,
        haendelser: [
          { tidspunkt: "2026-10-12T08:00:00.000Z", tekst: "Pakken er indleveret", maaltVaegtGram: 120 },
          { tidspunkt: "2026-10-14T13:00:00.000Z", tekst: "Pakken er leveret", maaltVaegtGram: null },
        ],
      },
    ],
    koeberBilleder: [{ tekst: "Indholdet", tid: "2026-10-20T10:00:00.000Z", bytes: null, format: null, kategori: "Indholdet" }],
    saelgerSvar: { tekst: "Jeg sendte telefonen.", oprettetKl: "2026-10-21T10:00:00.000Z", billeder: [] },
    pakkebilleder: [],
    anke: null,
    chat: [
      { tid: "2026-10-11T10:00:00.000Z", fra: "koeber", tekst: "Hvornår sender du?", stoppet: null },
      { tid: "2026-10-11T11:00:00.000Z", fra: "saelger", tekst: STOPPET, stoppet: "telefon" },
    ],
    politi: {
      koeber: {
        email: EMAIL,
        telefon: TELEFON,
        kontoOprettetKl: "2026-01-01T10:00:00.000Z",
        mitid: [{ status: "aktiv", navn: MITID_NAVN, foedselsdato: FOEDSEL, verificeretKl: "2026-02-01T10:00:00.000Z", nulstilletKl: null }],
        andreSagerSomKoeber: 3,
        andreSagerSomSaelger: 0,
      },
      saelger: {
        email: "saelger.hemmelig@example.com",
        telefon: null,
        kontoOprettetKl: "2026-01-02T10:00:00.000Z",
        mitid: [],
        andreSagerSomKoeber: 0,
        andreSagerSomSaelger: 1,
      },
      handlerMellem: [],
      log: [{ tid: "2026-10-20T11:00:00.000Z", handling: "sag_taget", medarbejder: "Admin", aarsag: "Intern log-note" }],
      udleveringer: [],
    },
  };
}

describe("regler", () => {
  it("staff kan lave udgaven til sælger, kun chefen udgaven til politiet", () => {
    expect(maaLaveDokumentation("medarbejder", "saelger", false)).toBe(true);
    expect(maaLaveDokumentation("admin", "saelger", false)).toBe(true);
    expect(maaLaveDokumentation("chef", "saelger", false)).toBe(true);
    expect(maaLaveDokumentation("medarbejder", "politi", false)).toBe(false);
    expect(maaLaveDokumentation("admin", "politi", false)).toBe(false);
    expect(maaLaveDokumentation("chef", "politi", false)).toBe(true);
    expect(maaLaveDokumentation(null, "saelger", false)).toBe(false);
  });

  it("inhabile kan ingen af udgaverne lave - heller ikke chefen", () => {
    for (const rolle of ["medarbejder", "admin", "chef"] as const) {
      expect(maaLaveDokumentation(rolle, "saelger", true)).toBe(false);
      expect(maaLaveDokumentation(rolle, "politi", true)).toBe(false);
    }
    expect(dokumentationAfvisning("chef", "politi", true)).toMatch(/inhabil/);
  });

  it("felterne fra dialogen renses og tjekkes", () => {
    expect(rensFelt("  Politi,\n  journalnr.\t123 ")).toBe("Politi, journalnr. 123");
    expect(rensFelt(42)).toBe("");
    expect(tjekFelter("saelger", "x", "")).toMatch(/Skriv, hvem/);
    expect(tjekFelter("saelger", "Sælger", "")).toBeNull();
    expect(tjekFelter("politi", "a".repeat(201), "")).toMatch(/højst/);
    expect(tjekFelter("politi", "Politi", "j".repeat(101))).toMatch(/Journalnummeret/);
  });

  it("filnavnet afslører ikke parterne", () => {
    expect(dokumentationFilnavn("politi", SAG, new Date("2026-10-28T08:00:00Z"))).toBe(
      "bidhamr-dokumentation-til-politiet-55555555-2026-10-28.pdf",
    );
  });
});

describe("indhold", () => {
  it("udgaven til sælger har ingen e-mail, telefon, MitID, log eller stoppede beskeder", () => {
    const tekst = dokumentTekst(bygDokument(data(), "saelger", new Date()));
    for (const ord of [EMAIL, "saelger.hemmelig", TELEFON, MITID_NAVN, "17.04.1990", FOEDSEL, "MitID", "E-mail", "Telefon", "Intern log-note", STOPPET]) {
      expect(tekst).not.toContain(ord);
    }
    expect(tekst).not.toMatch(/\bIP\b/);
    // Men alt det, sælgeren må få:
    for (const ord of ["iPhone 15 Pro", "77777777-7777-4777-8777-777777777777", "00370730253434081234", "GLS", "120 g", "Karl Køber", "Testvej 1", "Pakken var tom", "Jeg sendte telefonen.", "Hvornår sender du?", "5.124 kr.", "Dokumentation til sælger"]) {
      expect(tekst).toContain(ord);
    }
  });

  it("udgaven til sælger ignorerer politi-data, selv hvis de ved en fejl er hentet", () => {
    const d = data();
    const tekst = dokumentTekst(bygDokument(d, "saelger", new Date()));
    expect(tekst).not.toContain("Andre sager");
    expect(tekst).not.toContain("Handler mellem");
  });

  it("udgaven til politiet har MitID, e-mail, telefon, konto, sager, log og kontaktlinje", () => {
    const tekst = dokumentTekst(bygDokument(data(), "politi", new Date()));
    for (const ord of [EMAIL, TELEFON, MITID_NAVN, "17.04.1990", "Konto oprettet", "Andre sager som køber", "Intern log-note", "Handler mellem de to parter", STOPPET, "yderligere oplysninger", "support@bidhamr.dk"]) {
      expect(tekst).toContain(ord);
    }
  });
});

// ---------------------------------------------------------------------------
// Route: POST /admin/sager/[id]/dokumentation
// ---------------------------------------------------------------------------
const m = vi.hoisted(() => ({
  rolle: "chef" as "medarbejder" | "admin" | "chef",
  inhabil: false,
  logSvar: { kode: "ok" } as Record<string, unknown>,
  rpc: vi.fn(),
  hentData: vi.fn(),
}));

vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => null) }));
vi.mock("@/lib/admin/sagTaget", () => ({ erInhabil: vi.fn(async () => m.inhabil) }));
vi.mock("@/lib/adminAuth", () => ({
  assertRole: vi.fn(async () => {
    const taeller = { count: 0, error: null };
    const kaede: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gte"]) kaede[k] = () => kaede;
    kaede.then = (ok: (v: unknown) => unknown) => Promise.resolve(taeller).then(ok);
    return {
      userId: MIG,
      rolle: m.rolle,
      andetTrinSek: null,
      admin: {
        from: () => kaede,
        rpc: (...a: unknown[]) => {
          m.rpc(...a);
          return Promise.resolve({ data: m.logSvar, error: null });
        },
      },
    };
  }),
}));
vi.mock("@/lib/sagDokumentation/data", () => ({
  hentSagParter: async () => ({ sagId: SAG, tradeId: "t", koeberId: KOEBER, saelgerId: SAELGER }),
  hentDokumentationData: (...a: unknown[]) => {
    m.hentData(...a);
    const d = data();
    if (a[2] !== "politi") delete d.politi;
    return Promise.resolve(d);
  },
}));

const { POST } = await import("@/app/admin/sager/[id]/dokumentation/route");

async function kald(udgave: string, givetTil = "Sælger", origin = "http://localhost") {
  const fd = new FormData();
  fd.set("udgave", udgave);
  fd.set("givet_til", givetTil);
  fd.set("journalnummer", "J-1");
  const res = await POST(
    new NextRequest(`http://localhost/admin/sager/${SAG}/dokumentation`, {
      method: "POST",
      body: fd,
      headers: { host: "localhost", origin },
    }),
    { params: Promise.resolve({ id: SAG }) },
  );
  return res;
}

describe("route", () => {
  beforeEach(() => {
    m.rolle = "chef";
    m.inhabil = false;
    m.logSvar = { kode: "ok" };
    m.rpc.mockClear();
    m.hentData.mockClear();
  });

  it("staff (admin/medarbejder) kan ikke lave udgaven til politiet - intet hentes eller logges", async () => {
    for (const rolle of ["medarbejder", "admin"] as const) {
      m.rolle = rolle;
      const res = await kald("politi", "Politi");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { fejl: string }).fejl).toMatch(/Kun chefen/);
    }
    expect(m.hentData).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("inhabile kan ingen af udgaverne lave", async () => {
    m.inhabil = true;
    for (const rolle of ["medarbejder", "chef"] as const) {
      m.rolle = rolle;
      expect((await kald("saelger")).status).toBe(403);
      if (rolle === "chef") expect((await kald("politi", "Politi")).status).toBe(403);
    }
    expect(m.hentData).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("medarbejder laver udgaven til sælger: PDF og logrække", async () => {
    m.rolle = "medarbejder";
    const res = await kald("saelger", "  Sælger  ");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/til-saelger/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(m.hentData).toHaveBeenCalledWith(expect.anything(), expect.anything(), "saelger");
    expect(m.rpc).toHaveBeenCalledWith("sag_dokumentation_log", {
      p_medarbejder: MIG,
      p_sag: SAG,
      p_udgave: "saelger",
      p_givet_til: "Sælger",
      p_journalnummer: "J-1",
    });
  });

  it("chefen laver udgaven til politiet, og den logges som 'politi'", async () => {
    const res = await kald("politi", "Politi, Midt- og Vestsjællands Politi");
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("sag_dokumentation_log", expect.objectContaining({ p_udgave: "politi" }));
  });

  it("afviser databasen loggen, sendes ingen PDF", async () => {
    m.rolle = "admin";
    m.logSvar = { kode: "inhabil" };
    const res = await kald("saelger");
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).not.toBe("application/pdf");
  });

  it("afviser fremmed origin og ugyldige felter", async () => {
    expect((await kald("saelger", "Sælger", "https://ond.example")).status).toBe(403);
    expect((await kald("saelger", "x")).status).toBe(400);
    expect((await kald("hemmelig")).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
