// Kontaktoplysninger i en auktions titel og beskrivelse (TS-spejlet af
// public.auktion_kontaktinfo_grund). Samme eksempler kører i testblokken
// sidst i supabase/migrations/20261102280000_kontaktinfo_rettelser4.sql.
import { describe, expect, it } from "vitest";
import {
  auktionKontaktFejl,
  auktionKontaktGrund,
  auktionKontaktOpIgenTekst,
  auktionKontaktTekst,
} from "@/lib/auktionKontaktinfo";
import { AUKTION_KONTAKT_EKSEMPLER } from "./auktionKontaktinfoEksempler";

describe("auktionKontaktGrund - privat sælger", () => {
  it.each(AUKTION_KONTAKT_EKSEMPLER.map(([t, p]) => [t, p] as const))("%s -> %s", (tekst, forventet) => {
    expect(auktionKontaktGrund(tekst, false)).toBe(forventet);
  });
});

describe("auktionKontaktGrund - firma", () => {
  it.each(AUKTION_KONTAKT_EKSEMPLER.map(([t, , f]) => [t, f] as const))("%s -> %s", (tekst, forventet) => {
    expect(auktionKontaktGrund(tekst, true)).toBe(forventet);
  });
});

// Samme tjek som testblokken i 20261102280000.
describe("auktionKontaktGrund - længde og ydeevne", () => {
  const aar = (fra: number, til: number) =>
    Array.from({ length: til - fra + 1 }, (_, i) => String(fra + i)).join(" ");

  it("afviser tekster over 2.000 tegn", () => {
    expect(auktionKontaktGrund("a".repeat(2001), false)).toBe("for_lang");
    expect(auktionKontaktGrund("a".repeat(2000), false)).toBeNull();
  });

  it("tjekker højst 50 forskellige mulige telefonnumre", () => {
    expect(auktionKontaktGrund("2019 2020 ".repeat(200).slice(0, 2000), false)).toBeNull();
    expect(auktionKontaktGrund(aar(2000, 2060), false)).toBe("telefon");
    expect(auktionKontaktGrund(aar(2000, 2040), false)).toBeNull();
  });

  it("er hurtig på 2.000 tegn", () => {
    const start = performance.now();
    auktionKontaktGrund("24.12.2025 20.00-22.00 ".repeat(100).slice(0, 2000), false);
    auktionKontaktGrund("20.00-22.00 ".repeat(200).slice(0, 2000), false);
    auktionKontaktGrund("str 22 23 24 25 ".repeat(200).slice(0, 2000), false);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("auktionKontaktFejl (BHA08 fra databasen)", () => {
  it("viser teksten ved det rigtige felt", () => {
    expect(auktionKontaktFejl({ code: "BHA08", details: '{"felt":"titel","grund":"telefon","erhverv":false}' })).toEqual({
      felt: "titel",
      erhverv: false,
      tekst: auktionKontaktTekst("titel", false),
    });
    expect(auktionKontaktFejl({ code: "BHA08", details: "ikke json" })?.felt).toBe("beskrivelse");
    expect(auktionKontaktFejl({ code: "BHA05", details: null })).toBeNull();
  });

  it("nævner ikke links for firmaer", () => {
    const k = auktionKontaktFejl({ code: "BHA08", details: '{"felt":"beskrivelse","grund":"telefon","erhverv":true}' });
    expect(k?.erhverv).toBe(true);
    expect(k?.tekst).not.toMatch(/link/i);
    expect(auktionKontaktOpIgenTekst("titel", true)).not.toMatch(/link/i);
    expect(auktionKontaktOpIgenTekst("titel", false)).toMatch(/^Titlen indeholder/);
  });

  it("bruger Filips tekst for private", () => {
    expect(auktionKontaktTekst("beskrivelse", false)).toBe(
      "Skriv ikke telefonnummer, e-mail eller links i beskrivelsen. Køber og sælger skal tale sammen via BidHamr.",
    );
  });
});
