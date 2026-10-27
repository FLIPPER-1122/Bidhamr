// Teksten i påmindelsen 1 time før slut (src/lib/notifikationer/paamindelseFoerSlutTekst.ts).
// Databasedelen (idempotens og filtrering) testes i
// tests/penge-db/paamindelseFoerSlut.test.ts (npm run test:penge:db).
import { describe, expect, it } from "vitest";
import { paamindelseFoerSlutTekst, slutterOm } from "@/lib/notifikationer/paamindelseFoerSlutTekst";

const NU = Date.parse("2026-11-10T12:00:00Z");
const om = (min: number) => new Date(NU + min * 60_000).toISOString();

describe("påmindelse før slut: tekst", () => {
  it("fører", () => {
    const t = paamindelseFoerSlutTekst({ titel: "Cykel", slutterKl: om(58), budt: true, foerer: true }, NU);
    expect(t.titel).toBe("Slutter om 1 time – du fører");
    expect(t.tekst).toBe('"Cykel" slutter kl. 13.58. Du har det højeste bud lige nu.');
  });

  it("fører ikke længere", () => {
    const t = paamindelseFoerSlutTekst({ titel: "Cykel", slutterKl: om(57), budt: true, foerer: false }, NU);
    expect(t.titel).toBe("Slutter om 1 time – du fører ikke længere");
    expect(t.tekst).toContain("En anden har budt mere end dig");
  });

  it("kun favorit (foerer ignoreres uden bud)", () => {
    const t = paamindelseFoerSlutTekst({ titel: "Cykel", slutterKl: om(60), budt: false, foerer: true }, NU);
    expect(t.titel).toBe("Slutter om 1 time");
    expect(t.tekst).toContain("Byd nu");
  });

  it("de reelle minutter, når der er under 50 tilbage", () => {
    expect(slutterOm(om(50), NU)).toBe("om 1 time");
    expect(slutterOm(om(35), NU)).toBe("om 35 min.");
    expect(slutterOm(om(0), NU)).toBe("om 1 min.");
  });

  it("lange titler forkortes, mellemrum samles", () => {
    const t = paamindelseFoerSlutTekst({ titel: `  ${"x".repeat(200)}  `, slutterKl: om(58), budt: false, foerer: false }, NU);
    expect(t.tekst.startsWith(`"${"x".repeat(117)}..."`)).toBe(true);
  });
});
