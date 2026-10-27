// Cookie-samtykke (src/lib/samtykke.ts): gamle version 1-samtykker gælder
// ikke, og kategorier, der ikke er i brug, giver aldrig samtykke.
import { describe, expect, it } from "vitest";
import { SAMTYKKE_VERSION, fortolkSamtykke, kategoriIBrug, lavSamtykkeVaerdi, ALT_VALGT } from "@/lib/samtykke";

describe("samtykke", () => {
  it("version 1 ('Accepter alle' fra før) gælder ikke", () => {
    expect(SAMTYKKE_VERSION).toBe(2);
    const nu = Math.floor(Date.now() / 1000);
    expect(fortolkSamtykke(`v=1&t=${nu}&statistik=1&markedsfoering=1`, Date.now())).toBeNull();
  });

  it("en ny værdi læses stadig", () => {
    const v = lavSamtykkeVaerdi(ALT_VALGT, Date.now());
    expect(fortolkSamtykke(v, Date.now())?.valg).toEqual(ALT_VALGT);
  });

  it("kategorier, der ikke er i brug, giver aldrig samtykke", () => {
    expect(kategoriIBrug("statistik")).toBe(false);
    expect(kategoriIBrug("markedsfoering")).toBe(false);
  });
});
