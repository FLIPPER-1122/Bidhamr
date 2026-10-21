// Cron-resuméet i drift_cron_koersler.resultat (src/lib/driftCronResultat.ts):
// tal og korte koder i springetOver/grund - aldrig fri tekst.
import { describe, expect, it } from "vitest";
import { kortResultat } from "@/lib/driftCronResultat";

describe("kortResultat", () => {
  it("gemmer fakturakøens springetOver og grund", () => {
    const r = kortResultat({
      ubetalt: 2,
      springetOver: 1,
      fakturaer: { planlagt: { fakturaer: 1 }, behandlet: 0, faerdige: 0, fejl: 0, stoppet: 0, springetOver: "adgang", grund: "adgang: 401 login" },
    });
    expect(r).toEqual({
      ubetalt: 2,
      springetOver: 1,
      fakturaer: { behandlet: 0, faerdige: 0, fejl: 0, stoppet: 0, springetOver: "adgang", grund: "adgang: 401 login" },
    });
  });
  it("dropper fri tekst - også i springetOver/grund, hvis den ikke er en kort kode", () => {
    const r = kortResultat({
      tekst: "hej",
      fakturaer: {
        besked: "Dinero-login afvist",
        grund: "Bearer eyJhbGciOi.x.y",
        springetOver: "a".repeat(61),
      },
      andet: { grund: "sk_test_ABC" },
    });
    expect(r).toEqual({ fakturaer: {}, andet: {} });
  });
  it("null for andet end objekter", () => {
    expect(kortResultat(null)).toBeNull();
    expect(kortResultat("x")).toBeNull();
  });
});
