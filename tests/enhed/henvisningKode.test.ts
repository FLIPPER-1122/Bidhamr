import { describe, expect, it } from "vitest";
import { henvisningSti, renHenvisningskode } from "@/lib/henvisning/kode";

// Henvis en ven: koden fra linket, cookien og appen
// (20261102230000_henvis_en_ven.sql: 10 tegn, A-Z uden I og O, 2-9).
// Reglerne (loft, firma, selvhenvisning, dobbelt MitID, idempotens og RLS)
// testes i databasen: supabase/testscripts/20261102230000_henvis_en_ven_test.sql.
describe("renHenvisningskode", () => {
  it("godtager en gyldig kode, også med små bogstaver og mellemrum", () => {
    expect(renHenvisningskode("ABCDEFGHJK")).toBe("ABCDEFGHJK");
    expect(renHenvisningskode(" abcd2345xy ")).toBe("ABCD2345XY");
  });
  it("afviser alt andet", () => {
    for (const v of [
      null,
      undefined,
      123,
      "",
      "ABCDEFGHJ", // 9 tegn
      "ABCDEFGHJKL", // 11 tegn
      "ABCDEFGHIK", // I er ikke med
      "ABCDEFGHOK", // O er ikke med
      "ABCDEFGH01", // 0 og 1 er ikke med
      "ABCDE-GHJK",
      "<script>xx",
    ]) {
      expect(renHenvisningskode(v)).toBeNull();
    }
  });
  it("linket er forsiden med ?ven=", () => {
    expect(henvisningSti("ABCDEFGHJK")).toBe("/?ven=ABCDEFGHJK");
  });
});
