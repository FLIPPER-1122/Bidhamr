// Glidende overgang over 7.500 kr. (Filip, 27. okt. 2026 - ROADMAP-
// BESLUTNINGER afsnit 3): beregn.ts uden database. Samme tal testes mod
// SQL-funktionerne i tests/penge-db/glidendeGebyrer.test.ts.
import { describe, expect, it } from "vitest";
import {
  aktuelPrismodel,
  applicationFeeOere,
  erNyPrivatPrismodel,
  forventetTotalOere,
  koebergebyrForPrismodel,
  koebergebyrOere,
  koeberTotalOere,
  saelgergebyrForPrismodel,
  saelgergebyrOere,
  sagRefusionOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";

const kr = (k: number) => Math.round(k * 100);

describe("private gebyrer (ny2)", () => {
  // [pris kr., køber kr., sælger kr.] - Filips kontrolværdier + grænser.
  const tabel: [number, number, number][] = [
    [7_500, 300, 95],
    [7_501, 300.03, 95.02],
    [10_000, 375, 145],
    [15_000, 525, 245],
    [20_000, 650, 345],
    // 95 + 2 % af 17.500 = 445 kr. (formlen; sælgers loft nås ved 25.250 kr.).
    [25_000, 650, 445],
    [7_499.99, 300, 95],
    [7_500.01, 300, 95],
    [24_999, 650, 444.98],
    [19_166.49, 649.99, 328.33],
    [19_166.5, 650, 328.33],
    [25_249.74, 650, 449.99],
    [25_249.75, 650, 450],
    [100, 12, 10],
    [200, 19, 15],
  ];

  it.each(tabel)("%d kr.: køber %d kr., sælger %d kr.", (pris, koeb, saelg) => {
    expect(koebergebyrOere(kr(pris), false)).toBe(kr(koeb));
    expect(saelgergebyrOere(kr(pris), false)).toBe(kr(saelg));
    expect(koebergebyrForPrismodel("ny2", kr(pris))).toBe(kr(koeb));
    expect(saelgergebyrForPrismodel("ny2", kr(pris))).toBe(kr(saelg));
    expect(udbetalingOere(kr(pris), false)).toBe(kr(pris) - kr(saelg));
  });

  it("totalprisen og udbetalingen falder aldrig, når buddet stiger (hver øre fra 7.400 til 7.600 kr., hver krone til 25.000)", () => {
    const bud: number[] = [];
    for (let o = 740_000; o <= 760_000; o++) bud.push(o);
    for (let k = 7_601; k <= 25_000; k++) bud.push(k * 100);
    let forrige = { total: -Infinity, udbetaling: -Infinity };
    for (const b of bud) {
      const nu = { total: koeberTotalOere(b, false, 4200), udbetaling: udbetalingOere(b, false) };
      if (nu.total < forrige.total || nu.udbetaling < forrige.udbetaling) throw new Error(`${b} øre: prisen faldt`);
      forrige = nu;
    }
  });

  it("nye handler får 'ny2' (privat) og 'erhverv2' (firma)", () => {
    expect(aktuelPrismodel(false)).toBe("ny2");
    expect(aktuelPrismodel(true)).toBe("erhverv2");
    // Erhverv uændret: 5 % købergebyr, intet sælgergebyr.
    expect(koebergebyrOere(kr(10_000), true)).toBe(kr(500));
    expect(saelgergebyrOere(kr(10_000), true)).toBe(0);
  });
});

describe("gemte handler beholder deres prismodel", () => {
  it("'ny' over 7.500 kr.: 3 % + 15 kr. / 2 % + 15 kr. af hele prisen", () => {
    expect(koebergebyrForPrismodel("ny", kr(10_000))).toBe(kr(315));
    expect(saelgergebyrForPrismodel("ny", kr(10_000))).toBe(kr(215));
    expect(koebergebyrForPrismodel("ny", kr(25_000))).toBe(kr(650));
    expect(saelgergebyrForPrismodel("ny", kr(25_000))).toBe(kr(450));
    // Til og med 7.500 kr. er 'ny' og 'ny2' ens.
    for (const p of [1, 100, 1_000, 4_214.29, 7_499.99, 7_500]) {
      expect(koebergebyrForPrismodel("ny", kr(p))).toBe(koebergebyrForPrismodel("ny2", kr(p)));
      expect(saelgergebyrForPrismodel("ny", kr(p))).toBe(saelgergebyrForPrismodel("ny2", kr(p)));
    }
  });

  it("forventetTotalOere kontrollerer efter betalingens egen prismodel", () => {
    const ny2 = { bud_oere: kr(10_000), koebergebyr_oere: kr(375), saelgergebyr_oere: kr(145), fragt_oere: 4200, beskyttelse_oere: 0 };
    const ny = { ...ny2, koebergebyr_oere: kr(315), saelgergebyr_oere: kr(215) };
    expect(forventetTotalOere({ ...ny2, prismodel: "ny2" })).toBe(kr(10_375) + 4200);
    expect(forventetTotalOere({ ...ny, prismodel: "ny" })).toBe(kr(10_315) + 4200);
    // Krydsede beløb, Beskyttelse-beløb og ukendt prismodel afvises (der betales ikke).
    expect(forventetTotalOere({ ...ny, prismodel: "ny2" })).toBeNull();
    expect(forventetTotalOere({ ...ny2, prismodel: "ny" })).toBeNull();
    expect(forventetTotalOere({ ...ny2, beskyttelse_oere: 2500, prismodel: "ny2" })).toBeNull();
    expect(forventetTotalOere({ ...ny2, prismodel: "ny3" as never })).toBeNull();
    // Application fee = købergebyr + sælgergebyr + fragt; sælgeren står med bud - sælgergebyr.
    const fee = applicationFeeOere(ny2);
    expect(fee).toBe(kr(375) + kr(145) + 4200);
    expect(kr(10_375) + 4200 - fee).toBe(udbetalingOere(kr(10_000), false));
  });

  it("refusion ved medhold i en sag: 'ny' og 'ny2' = kun buddet", () => {
    const b = { bud_oere: 100, total_oere: 150, beskyttelse_oere: 0 };
    expect(sagRefusionOere({ ...b, prismodel: "ny2" })).toBe(100);
    expect(sagRefusionOere({ ...b, prismodel: "ny" })).toBe(100);
    expect(sagRefusionOere({ ...b, prismodel: "erhverv2" })).toBe(150);
    expect([erNyPrivatPrismodel("ny"), erNyPrivatPrismodel("ny2"), erNyPrivatPrismodel("gammel")]).toEqual([true, true, false]);
  });
});
