// Kunst-tjekket (src/lib/kunstForbud.ts): positive og negative eksempler,
// ingen kategori med "kunst", og TS-listen er den samme som i migrationen
// (public.kunst_ord() og public.kunst_fjern()).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KUNST_FJERN, KUNST_REGLER, KUNST_UAFKLAREDE, tjekKunstTekst } from "@/lib/kunstForbud";
import { kategorier } from "@/lib/kategorier";
import { FORBUDTE_KATEGORIER } from "@/lib/forbudteVarer";
import { KUNST_JA, KUNST_NEJ } from "./kunstEksempler";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261023010000_kunst_forbudt.sql"),
  "utf8",
).replace(/\r/g, "");

const sqlTekst = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);

// De rækker, kunst_ord() skal indeholde. Skrives ud, hvis testen fejler, så
// de kan kopieres ind i en ny migration.
function forventedeRaekker(): string {
  return KUNST_REGLER.map(
    (r) => `      (${r.nr}, ${sqlTekst(r.moenster)}, ${sqlTekst(r.kraever)}, ${sqlTekst(r.undtagen)})`,
  ).join(",\n");
}

describe("tjekKunstTekst", () => {
  it.each(KUNST_JA)("fanger %s", (t) => {
    expect(tjekKunstTekst(t).resultat).toBe("kunst");
  });

  it.each(KUNST_NEJ)("fanger ikke %s", (t) => {
    expect(tjekKunstTekst(t)).toEqual({ resultat: "ok" });
  });

  it("tjekker titel og beskrivelse sammen", () => {
    expect(tjekKunstTekst("Billede", "Olie på lærred, signeret")).toMatchObject({ resultat: "kunst" });
    expect(tjekKunstTekst("Billede", null)).toEqual({ resultat: "ok" });
  });

  it("returnerer ordet, som det står (normaliseret)", () => {
    expect(tjekKunstTekst("Stort OLIEMALERI")).toEqual({ resultat: "kunst", ord: "oliemaleri", nr: 1 });
  });

  it("uafklarede grupper er slået fra, indtil advokaten har svaret", () => {
    expect(KUNST_UAFKLAREDE.every((g) => !g.aktiv)).toBe(true);
  });
});

describe("kategorier", () => {
  it("ingen kategori hedder noget med kunst", () => {
    expect(kategorier.filter((k) => /kunst/i.test(k))).toEqual([]);
  });

  it("kunst står på listen over forbudte varer", () => {
    expect(FORBUDTE_KATEGORIER.some((k) => k.kode === "kunst")).toBe(true);
  });
});

describe("synkron med migrationen", () => {
  it("kunst_ord() har præcis TS-listen", () => {
    const start = MIGRATION.indexOf("-- KUNST_ORD_START\n");
    const slut = MIGRATION.indexOf("\n      -- KUNST_ORD_SLUT");
    expect(start).toBeGreaterThan(0);
    const raekker = MIGRATION.slice(MIGRATION.indexOf("\n", start) + 1, slut);
    if (raekker !== forventedeRaekker()) {
      console.log(`Ret kunst_ord() i migrationen til:\n${forventedeRaekker()}`);
    }
    expect(raekker).toBe(forventedeRaekker());
  });

  it("kunst_fjern() har præcis TS-mønsteret", () => {
    expect(MIGRATION).toContain(`select ${sqlTekst(KUNST_FJERN)}::text;`);
  });
});
