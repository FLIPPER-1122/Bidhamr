// Ugens plads i firmaets stribe i Ugens butik-kalenderen (src/lib/erhverv/ugensButikStribe.ts).
import { describe, expect, it } from "vitest";
import { nrITraek } from "@/lib/erhverv/ugensButikStribe";

const uge = (firma: string | null, iTraek: number | null = null) => ({
  booking_id: firma ? `b-${firma}` : null,
  firma_id: firma,
  i_traek: iTraek,
});

describe("nrITraek", () => {
  it("tæller 1, 2, 3 ... i en stribe, der starter i kalenderen", () => {
    expect(nrITraek([uge("a", 3), uge("a", 3), uge("a", 3), uge(null)])).toEqual([1, 2, 3, null]);
  });

  it("tæller uger før den igangværende med (i_traek er hele striben)", () => {
    // Firmaet havde 2 uger før kalenderens start: 3. og 4. uge i træk.
    expect(nrITraek([uge("a", 4), uge("a", 4), uge("b", 1)])).toEqual([3, 4, 1]);
  });

  it("skiller firmaer og huller ad", () => {
    expect(nrITraek([uge("a", 1), uge("b", 2), uge("b", 2), uge(null), uge("b", 1)])).toEqual([1, 1, 2, null, 1]);
  });

  it("ingen loft-data (gammel database) giver null", () => {
    expect(nrITraek([uge("a"), uge("a")])).toEqual([null, null]);
  });
});
