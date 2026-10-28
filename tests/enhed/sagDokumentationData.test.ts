// Dokumentation til sælger og politi: hentningen (src/lib/sagDokumentation/data.ts)
// med en falsk service-role-klient. Rettelser efter review:
//   - et fejlet opslag kaster (routen svarer 500 og logger intet)
//   - valgfri kolonner (oprindelig_type osv.) må fejle uden at stoppe PDF'en
//   - lofter (beskeder, sporingshændelser, pakkebilleder) står i dataene
//   - betalingen er den betalte række frem for den nyeste
//   - billedstier uden for handlens mappe og ugyldig URL-kodning hentes ikke
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/HandelStatusBadge", () => ({ statusLabel: (s: string) => s }));

const { hentDokumentationData, MAKS_BESKEDER, BILLEDE_KAN_IKKE_KONVERTERES } = await import("@/lib/sagDokumentation/data");
const { bygDokument, dokumentTekst } = await import("@/lib/sagDokumentation/indhold");

const SAG = "55555555-5555-4555-8555-0000000000d1";
const HANDEL = "77777777-7777-4777-8777-777777777777";
const ANDEN_HANDEL = "77777777-7777-4777-8777-000000000000";
const KOEBER = "11111111-1111-4111-8111-000000000001";
const SAELGER = "11111111-1111-4111-8111-000000000002";
const FREMMED = "11111111-1111-4111-8111-00000000000f";
const PARTER = { sagId: SAG, tradeId: HANDEL, koeberId: KOEBER, saelgerId: SAELGER };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

type Svar = { data: unknown; error: { message: string } | null; count?: number | null };

// Svar pr. tabel (nøgle "sager:valgfri" for de valgfri kolonner).
let svar: Record<string, Svar>;
let hentet: string[];

function grund(): Record<string, Svar> {
  return {
    sager: {
      data: {
        id: SAG,
        trade_id: HANDEL,
        type: "svindel",
        status: "aaben",
        oprettet_kl: "2026-10-20T10:00:00.000Z",
        beskrivelse: "Tom pakke",
        beskyttelse: true,
        afgjort_kl: null,
        begrundelse: null,
        retur_kraeves: false,
        retur_afleveret_kl: null,
      },
      error: null,
    },
    "sager:valgfri": { data: { oprindelig_type: null, pakke_smidt_ud: false, pakke_smidt_ud_begrundelse: null }, error: null },
    trades: {
      data: {
        id: HANDEL,
        auction_id: "a1",
        created_at: "2026-10-10T10:00:00.000Z",
        afhentning: false,
        sendt_kl: null,
        received_at: null,
        tracking_number: null,
      },
      error: null,
    },
    auctions: {
      data: {
        id: "a1",
        titel: "iPhone",
        beskrivelse: "Som ny",
        kategori: null,
        maerke: null,
        stand: null,
        vaegt_gram: null,
        billeder: [
          "https://abc.supabase.co/storage/v1/object/public/auktion-billeder/x/%E0%A4%A.jpg",
          "https://abc.supabase.co/storage/v1/object/public/auktion-billeder/x/ok.png",
        ],
      },
      error: null,
    },
    betalinger: {
      data: [
        { bud_oere: 100, fragt_oere: 0, total_oere: 100, betalt_kl: null, status: "annulleret" },
        { bud_oere: 50000, fragt_oere: 4900, total_oere: 54900, betalt_kl: "2026-10-11T09:00:00.000Z", status: "betalt" },
      ],
      error: null,
    },
    handel_levering: { data: null, error: null },
    forsendelser: {
      data: [
        {
          id: "f1",
          type: "udgaaende",
          fragtfirma: "gls",
          transportoer: null,
          status: "leveret",
          sporingsnummer: "123",
          oprettet_kl: null,
          afleveret_kl: null,
          leveret_kl: null,
          vaegt_gram: null,
        },
      ],
      error: null,
      count: 1,
    },
    forsendelse_haendelser: {
      data: [
        { forsendelse_id: "f1", tidspunkt: "2026-10-13T10:00:00.000Z", type: "leveret", beskrivelse: "Leveret", raa: null },
        { forsendelse_id: "f1", tidspunkt: "2026-10-12T10:00:00.000Z", type: "indleveret", beskrivelse: "Indleveret", raa: null },
      ],
      error: null,
      count: 734,
    },
    sag_billeder: {
      data: [
        { sti: `${KOEBER}/${HANDEL}/a.png`, kategori: "pakke", oprettet_kl: "2026-10-20T10:00:00.000Z" },
        { sti: `${FREMMED}/${HANDEL}/b.png`, kategori: "pakke", oprettet_kl: "2026-10-20T10:00:00.000Z" },
        { sti: `${KOEBER}/${ANDEN_HANDEL}/c.png`, kategori: "pakke", oprettet_kl: "2026-10-20T10:00:00.000Z" },
      ],
      error: null,
    },
    sag_svar: { data: { id: "s1", tekst: "Jeg sendte den", oprettet_kl: "2026-10-21T10:00:00.000Z" }, error: null },
    sag_svar_billeder: {
      data: [{ sti: `${SAELGER}/${HANDEL}/../../hemmelig.png`, kategori: "pakke", oprettet_kl: "2026-10-21T10:00:00.000Z" }],
      error: null,
    },
    pakke_billeder: {
      data: [{ sti: `${SAELGER}/${HANDEL}/p.png`, kategori: "aaben_kasse", oprettet_kl: "2026-10-12T10:00:00.000Z" }],
      error: null,
      count: 25,
    },
    sag_anker: { data: null, error: null },
    messages: {
      // Nyeste først (som forespørgslen beder om).
      data: [
        { sender_id: SAELGER, content: "Nyeste", created_at: "2026-10-11T12:00:00.000Z", fra_bidhamr: false, blokeret_grund: null },
        { sender_id: KOEBER, content: "Ældste", created_at: "2026-10-11T10:00:00.000Z", fra_bidhamr: false, blokeret_grund: null },
      ],
      error: null,
      count: 1234,
    },
    users: { data: [{ id: KOEBER, navn: "Karl" }, { id: SAELGER, navn: "Sofie" }], error: null },
  };
}

function falskAdmin() {
  return {
    from(tabel: string) {
      let noegle = tabel;
      const kaede: Record<string, unknown> = {};
      const selv = () => kaede;
      for (const k of ["eq", "in", "order", "limit", "or", "neq", "gte"]) kaede[k] = selv;
      kaede.select = (kol: string) => {
        if (tabel === "sager" && kol.startsWith("oprindelig_type")) noegle = "sager:valgfri";
        // Politiudgavens lister (handler mellem parterne, andre sager).
        if (tabel === "trades" && (kol.includes("buyer_id") || kol === "id")) noegle = "trades:liste";
        if (tabel === "sager" && kol === "id") noegle = "sager:antal";
        return kaede;
      };
      const resultat = () => Promise.resolve(svar[noegle] ?? { data: [], error: null });
      kaede.single = resultat;
      kaede.maybeSingle = resultat;
      kaede.then = (ok: (v: unknown) => unknown, fejl?: (e: unknown) => unknown) => resultat().then(ok, fejl);
      return kaede;
    },
    storage: {
      from: (bucket: string) => ({
        download: async (sti: string) => {
          hentet.push(`${bucket}:${sti}`);
          return { data: new Blob([PNG]), error: null };
        },
      }),
    },
  };
}

async function hent(udgave: "saelger" | "politi" = "saelger") {
  return hentDokumentationData(falskAdmin() as never, PARTER, udgave);
}

beforeEach(() => {
  svar = grund();
  hentet = [];
});

describe("fejl i opslag", () => {
  for (const tabel of [
    "messages",
    "sag_billeder",
    "pakke_billeder",
    "forsendelser",
    "forsendelse_haendelser",
    "betalinger",
    "handel_levering",
    "sag_svar",
    "sag_anker",
    "sag_svar_billeder",
    "auctions",
    "users",
  ]) {
    it(`${tabel} fejler -> der kastes`, async () => {
      svar[tabel] = { data: null, error: { message: "timeout" } };
      await expect(hent()).rejects.toThrow(tabel);
    });
  }

  it("valgfri kolonner må fejle - PDF'en laves stadig", async () => {
    svar["sager:valgfri"] = { data: null, error: { message: "column does not exist" } };
    const d = await hent();
    expect(d.sag.oprindeligType).toBeNull();
    expect(d.sag.pakkeSmidtUd).toBe(false);
  });
});

describe("lofter", () => {
  it("beskeder vises i tidsorden, og loftet står i dataene og i PDF'en", async () => {
    const d = await hent("politi");
    expect(d.chat.map((b) => b.tekst)).toEqual(["Ældste", "Nyeste"]);
    expect(d.afkortet?.beskeder).toEqual({ vist: 2, iAlt: 1234 });
    expect(d.afkortet?.haendelser).toEqual({ vist: 2, iAlt: 734 });
    expect(d.afkortet?.pakkebilleder).toEqual({ vist: 1, iAlt: 25 });
    expect(d.afkortet?.forsendelser).toBeUndefined();
    const haendelser = d.forsendelser[0].haendelser.map((h) => h.tekst);
    expect(haendelser).toEqual(["Indleveret", "Leveret"]);

    const politi = dokumentTekst(bygDokument(d, "politi", new Date()));
    expect(politi).toContain("Viser de 2 seneste af 1.234 beskeder.");
    expect(politi).toContain("Viser de 2 seneste af 734 sporingshændelser.");
    expect(politi).toContain("Viser de 1 første af 25 pakkebilleder.");

    // Udgaven til sælger nævner ikke det samlede antal beskeder (tæller
    // også beskeder stoppet af filteret).
    const saelger = dokumentTekst(bygDokument(d, "saelger", new Date()));
    expect(saelger).not.toContain("1.234");
    expect(saelger).toContain("Kun de seneste beskeder er medtaget.");
  });

  it("ingen note, når alt er med", async () => {
    svar.messages.count = 2;
    svar.forsendelse_haendelser.count = 2;
    svar.pakke_billeder.count = 1;
    const d = await hent();
    expect(d.afkortet).toEqual({});
    expect(dokumentTekst(bygDokument(d, "politi", new Date()))).not.toContain("Viser de");
  });

  it("loftet på beskeder er 1.000", () => {
    expect(MAKS_BESKEDER).toBe(1000);
  });
});

describe("betaling", () => {
  it("den betalte række vælges frem for den nyeste", async () => {
    const d = await hent();
    expect(d.betaling?.status).toBe("betalt");
    expect(d.betaling?.totalOere).toBe(54900);
  });

  it("uden betalt række bruges den nyeste", async () => {
    svar.betalinger = { data: [{ bud_oere: 1, fragt_oere: 0, total_oere: 1, betalt_kl: null, status: "afventer" }], error: null };
    expect((await hent()).betaling?.status).toBe("afventer");
  });
});

describe("billeder", () => {
  it("et billede, der ikke kan konverteres, får en tydelig note", async () => {
    const admin = falskAdmin();
    admin.storage.from = () => ({
      download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]), error: null }),
    });
    const d = await hentDokumentationData(admin as never, PARTER, "saelger");
    expect(d.koeberBilleder[0].bytes).toBeNull();
    expect(d.koeberBilleder[0].tekst).toContain(BILLEDE_KAN_IKKE_KONVERTERES);
    expect(dokumentTekst(bygDokument(d, "saelger", new Date()))).toContain("kunne ikke konverteres");
  });


  it("ugyldig URL-kodning og fremmede stier hentes ikke, resten af PDF'en laves", async () => {
    const d = await hent();
    expect(d.auktionBilleder[0]).toMatchObject({ bytes: null, tekst: "Auktionsbillede 1 (kan ikke hentes)" });
    expect(d.auktionBilleder[1].format).toBe("png");

    expect(d.koeberBilleder.map((b) => b.bytes !== null)).toEqual([true, false, false]);
    expect(d.koeberBilleder[1].tekst).toMatch(/kan ikke hentes/);
    expect(d.saelgerSvar?.billeder[0].tekst).toMatch(/kan ikke hentes/);
    expect(d.pakkebilleder[0].format).toBe("png");

    expect(hentet).toEqual([
      "auktion-billeder:x/ok.png",
      `sag-billeder:${KOEBER}/${HANDEL}/a.png`,
      `pakke-billeder:${SAELGER}/${HANDEL}/p.png`,
    ]);
  });
});
