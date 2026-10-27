// Den fælles tabel for "Meld et problem" (src/lib/tekster/sagValg.ts) -
// samme tekster på hjemmesiden og i appen (20261102210000).
import { describe, expect, it } from "vitest";
import {
  SAG_DET_SKER,
  SAG_FAELLES_TEKSTER,
  SAG_VALG,
  SAG_VALG_IDER,
  sagBilledKrav,
  sagHvisDuFaarRet,
  sagValgFor,
} from "@/lib/tekster/sagValg";
import { sagBillederOpfylder, sagProblemFristKl, sagSvarFristKl } from "@/lib/sager";
import { sagRefusionOere } from "@/lib/betaling/beregn";

// 1.000 kr. (ny2): total 1.117 kr. (gebyr 75 + fragt 42).
const B = { prismodel: "ny2" as const, bud_oere: 100_000, total_oere: 111_700, beskyttelse_oere: 0, returfragt_oere: 4_200 };

describe("valg -> sagstype", () => {
  it("seks valg i showcasens rækkefølge, og køberen ser aldrig ordet svindel", () => {
    expect(SAG_VALG_IDER).toEqual(["stykker", "annonce", "anden_vare", "tom", "ikke_kommet", "andet"]);
    expect(SAG_VALG.stykker.type).toBe("skadet");
    expect(SAG_VALG.annonce.type).toBe("ikke_som_beskrevet");
    expect(SAG_VALG.anden_vare.type).toBe("svindel");
    expect(SAG_VALG.tom.type).toBe("svindel");
    expect(SAG_VALG.ikke_kommet.type).toBe("bortkommet");
    expect(SAG_VALG.andet.type).toBe("andet");
    for (const v of Object.values(SAG_VALG)) {
      expect(`${v.navn} ${v.undertekst}`.toLowerCase()).not.toContain("svindel");
    }
  });

  it("valgene følger de tilladte typer", () => {
    expect(sagValgFor(["bortkommet", "svindel"]).map((v) => v.id)).toEqual(["anden_vare", "tom", "ikke_kommet"]);
    expect(sagValgFor([])).toEqual([]);
  });
});

describe("billedkrav (regel 1 og 2)", () => {
  it("pakken med labelen + indholdet; ingen ved 'ikke fået pakken'; pakken valgfri ved 'smidt ud'", () => {
    expect(sagBilledKrav(SAG_VALG.stykker, true).map((k) => [k.kategori, k.paakraevet])).toEqual([
      ["pakke_label", true],
      ["indhold", true],
    ]);
    expect(sagBilledKrav(SAG_VALG.ikke_kommet, true)).toEqual([]);
    expect(sagBilledKrav(SAG_VALG.stykker, false)).toEqual([]);
    expect(sagBilledKrav(SAG_VALG.stykker, true, true)[0].paakraevet).toBe(false);
  });

  it("sagBillederOpfylder = databasens regel", () => {
    expect(sagBillederOpfylder(["pakke_label", "indhold"], false)).toBe(true);
    expect(sagBillederOpfylder(["pakke", "label", "indhold"], false)).toBe(true);
    expect(sagBillederOpfylder(["label", "indhold"], false)).toBe(false);
    expect(sagBillederOpfylder(["indhold"], true)).toBe(true);
    expect(sagBillederOpfylder(["pakke_label"], true)).toBe(false);
  });
});

describe("'Hvis du får ret' (regel 6 og 7)", () => {
  it("bortkommet og transportskade: hele beløbet; transportskade: køberen betaler ikke returfragten", () => {
    expect(sagHvisDuFaarRet(SAG_VALG.ikke_kommet, B)).toContain("hele beløbet på 1.117 kr");
    const skade = sagHvisDuFaarRet(SAG_VALG.stykker, B);
    expect(skade).toContain("hele beløbet på 1.117 kr");
    expect(skade).toContain("Du betaler ikke returfragten");
    expect(sagRefusionOere(B, "skadet")).toBe(111_700);
  });

  it("'ikke som beskrevet': buddet, og køberen betaler returfragten (= fragten ud)", () => {
    const t = sagHvisDuFaarRet(SAG_VALG.annonce, B);
    expect(t).toContain("dit bud på 1.000 kr");
    expect(t).toContain("Returfragten koster 42 kr, og den betaler du");
    expect(t).toContain("Gebyr og fragt får du ikke tilbage");
  });

  it("svindel: buddet uden retur; 'andet': intet løfte om beløb", () => {
    expect(sagHvisDuFaarRet(SAG_VALG.tom, B)).toContain("Du skal ikke sende noget retur");
    expect(sagHvisDuFaarRet(SAG_VALG.andet, B)).not.toMatch(/kr/);
  });

  it("ingen tekst siger, at BidHamr holder pengene", () => {
    const alle = [
      ...SAG_DET_SKER,
      ...SAG_VALG_IDER.map((id) => sagHvisDuFaarRet(SAG_VALG[id], B)),
      ...SAG_VALG_IDER.map((id) => SAG_VALG[id].goerNu),
      JSON.stringify(SAG_FAELLES_TEKSTER),
    ].join(" ");
    expect(alle.toLowerCase()).not.toMatch(/holder pengene|holdes tilbage|forsikring/);
  });
});

describe("frister", () => {
  it("problem_frist_kl bruges; ellers 48 timer (database før migrationen); sælgeren har 48 timer", () => {
    expect(sagProblemFristKl("2026-11-01T10:00:00.000Z", "2026-11-04T10:00:00.000Z")).toBe("2026-11-04T10:00:00.000Z");
    expect(sagProblemFristKl("2026-11-01T10:00:00.000Z", null)).toBe("2026-11-03T10:00:00.000Z");
    expect(sagSvarFristKl("2026-11-01T10:00:00.000Z")).toBe("2026-11-03T10:00:00.000Z");
  });
});
