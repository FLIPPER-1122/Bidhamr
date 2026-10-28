// Skærmenes tekster til "Meld et problem" (src/lib/tekster/sagValg.ts
// SAG_FLOW) - fælles for hjemmesiden og appen.
import { describe, expect, it } from "vitest";
import {
  SAG_FAELLES_TEKSTER,
  SAG_FLOW,
  SAG_SAELGER_SVAR_FORM,
  SAG_VALG,
  sagBilledKrav,
  sagTidTilbage,
  sagUdfyld,
} from "@/lib/tekster/sagValg";

const NU = Date.parse("2026-10-27T10:20:00Z");
const om = (min: number) => new Date(NU + min * 60_000).toISOString();

describe("sagTidTilbage", () => {
  it("skriver tiden i hverdagsord", () => {
    expect(sagTidTilbage(om(28 * 60), NU)).toBe("1 dag og 4 timer");
    expect(sagTidTilbage(om(72 * 60), NU)).toBe("3 dage");
    expect(sagTidTilbage(om(5 * 60 + 12), NU)).toBe("5 timer og 12 minutter");
    expect(sagTidTilbage(om(60), NU)).toBe("1 time");
    expect(sagTidTilbage(om(1), NU)).toBe("1 minut");
    expect(sagTidTilbage(new Date(NU + 30_000).toISOString(), NU)).toBe("under 1 minut");
  });

  it("null, når fristen er udløbet eller mangler", () => {
    expect(sagTidTilbage(om(0), NU)).toBeNull();
    expect(sagTidTilbage(om(-5), NU)).toBeNull();
    expect(sagTidTilbage(null, NU)).toBeNull();
    expect(sagTidTilbage("ikke en dato", NU)).toBeNull();
  });
});

describe("sagUdfyld", () => {
  it("udfylder pladsholdere og lader ukendte stå", () => {
    expect(sagUdfyld(SAG_FLOW.trin, { n: 2, ialt: 4 })).toBe("Trin 2 af 4");
    expect(sagUdfyld("Hej {navn} {x}", { navn: "Mette" })).toBe("Hej Mette {x}");
  });
});

describe("tekster til skærmene", () => {
  it("appen får dem med i de fælles tekster", () => {
    expect(SAG_FAELLES_TEKSTER.flow).toBe(SAG_FLOW);
    expect(SAG_FAELLES_TEKSTER.saelgerSvarForm).toBe(SAG_SAELGER_SVAR_FORM);
    // Kan sendes som JSON (ingen funktioner).
    expect(JSON.parse(JSON.stringify(SAG_FAELLES_TEKSTER.flow))).toEqual(SAG_FLOW);
  });

  it("ingen forbudte ord", () => {
    const alt = JSON.stringify({ SAG_FLOW, SAG_SAELGER_SVAR_FORM }).toLowerCase();
    expect(alt).not.toContain("forsikring");
    expect(alt).not.toContain("holder pengene");
    expect(alt).not.toContain("svindel");
  });

  it("tom pakke: kun billedet af pakken med labelen er påkrævet", () => {
    const krav = sagBilledKrav(SAG_VALG.tom, true);
    expect(krav.filter((k) => k.paakraevet).map((k) => k.kategori)).toEqual(["pakke_label"]);
  });
});
