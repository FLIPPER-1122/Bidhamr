// Køber og sælger må aldrig se ordet "svindel" (ROADMAP-BESLUTNINGER afsnit 4,
// showcase/opret-sag-showcase.html). Staff-navnene (SAG_TYPE_NAVN) er kun til
// admin; parterne ser køberens hverdagsvalg (SAG_VALG) eller den neutrale
// tekst pr. type (SAG_TYPE_NEUTRAL) via sagProblemTekst().
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SAG_TYPER } from "@/lib/sager";
import {
  SAG_FAELLES_TEKSTER,
  SAG_TYPE_NEUTRAL,
  SAG_VALG,
  SAG_VALG_IDER,
  sagProblemTekst,
} from "@/lib/tekster/sagValg";

const SRC = path.resolve(import.meta.dirname, "../../src");

// Her må SAG_TYPE_NAVN bruges:
//   - admin-siderne og admin-komponenterne
//   - staff-handlingerne (adminSager.ts - kun til staff-tekster)
//   - definitionen (lib/sager.ts)
//   - dokumentationen, som kun staff laver (staff-navnet kun i politiudgaven;
//     udgaven til sælger bruger SAG_TYPE_NEUTRAL - testet i
//     sagDokumentation.test.ts)
const TILLADT = [
  "app/admin/",
  "components/admin/",
  "app/actions/adminSager.ts",
  "lib/sager.ts",
  "lib/sagDokumentation/indhold.ts",
];

function filer(mappe: string): string[] {
  return readdirSync(mappe).flatMap((navn) => {
    const fuld = path.join(mappe, navn);
    if (statSync(fuld).isDirectory()) return filer(fuld);
    return /\.(ts|tsx)$/.test(navn) ? [fuld] : [];
  });
}

// Fjern kommentarer, så en henvisning i en kommentar ikke tæller.
function udenKommentarer(kode: string): string {
  return kode.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("SAG_TYPE_NAVN kun i admin", () => {
  it("importeres eller bruges ikke uden for admin", () => {
    const forkerte = filer(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => !TILLADT.some((t) => rel.startsWith(t)))
      .filter((rel) => /\bSAG_TYPE_NAVN\b/.test(udenKommentarer(readFileSync(path.join(SRC, rel), "utf8"))));
    expect(forkerte).toEqual([]);
  }, 30_000); // Gennemsøger hele src – kan tage over 5 s under fuld testkørsel.
});

describe("teksterne til køber og sælger", () => {
  it("indeholder ikke ordet svindel", () => {
    // SAG_VALG uden "type" (sagstypen er intern og vises ikke).
    const valg = SAG_VALG_IDER.map((id) => ({ ...SAG_VALG[id], type: undefined }));
    const problemer = SAG_TYPER.flatMap((t) => [null, ...SAG_VALG_IDER].map((v) => sagProblemTekst(t, v)));
    const alt = JSON.stringify({ valg, problemer, neutral: Object.values(SAG_TYPE_NEUTRAL), faelles: SAG_FAELLES_TEKSTER }).toLowerCase();
    expect(alt).not.toContain("svindel");
    expect(alt).not.toContain("forsikring");
  });

  it("bruger køberens valg, og en neutral tekst på gamle sager", () => {
    expect(sagProblemTekst("svindel", "tom")).toBe(SAG_VALG.tom.navn);
    expect(sagProblemTekst("svindel", null)).toBe("Pakken eller varen var ikke, som den skulle være");
    expect(sagProblemTekst("skadet", "noget-ukendt")).toBe(SAG_TYPE_NEUTRAL.skadet);
  });

  it('"kræver BidHamr Beskyttelse" er en fast tekst med BidHamr stavet rigtigt', () => {
    const t = SAG_FAELLES_TEKSTER.flow.handel.kraeverBeskyttelse;
    expect(t).not.toMatch(/\{\w+\}/);
    expect(t).toContain("BidHamr Beskyttelse");
    expect(t).not.toMatch(/bidhamr/);
  });
});
