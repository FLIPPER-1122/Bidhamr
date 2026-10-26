import { describe, expect, it } from "vitest";
import { beloebForHoejtTekst } from "@/lib/auktionRegler";

describe("beloebForHoejtTekst", () => {
  it("viser databasens tekst efter præfikset", () => {
    expect(
      beloebForHoejtTekst({ code: "BHB05", message: "beloeb_for_hoejt: Startprisen kan højst være 25.000 kr." }),
    ).toBe("Startprisen kan højst være 25.000 kr.");
    expect(
      beloebForHoejtTekst({ code: "P0001", message: "beloeb_for_hoejt: Det højeste tilladte bud er 25.000 kr." }),
    ).toBe("Det højeste tilladte bud er 25.000 kr.");
  });

  it("falder tilbage til en standardtekst ved BHB05 uden præfiks", () => {
    expect(beloebForHoejtTekst({ code: "BHB05", message: "" })).toBe("Det højeste tilladte beløb er 25.000 kr.");
  });

  it("ignorerer andre fejl", () => {
    expect(beloebForHoejtTekst({ code: "BHA01", message: "noget andet" })).toBeNull();
    expect(beloebForHoejtTekst(null)).toBeNull();
  });
});
