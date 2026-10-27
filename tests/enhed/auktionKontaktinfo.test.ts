// Kontaktoplysninger i en auktions titel og beskrivelse (TS-spejlet af
// public.auktion_kontaktinfo_grund). Samme eksempler kører i testblokken
// sidst i supabase/migrations/20261102130000_beskrivelse_kontaktinfo.sql.
import { describe, expect, it } from "vitest";
import { auktionKontaktFejl, auktionKontaktGrund, auktionKontaktTekst } from "@/lib/auktionKontaktinfo";
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

describe("auktionKontaktFejl (BHA08 fra databasen)", () => {
  it("viser teksten ved det rigtige felt", () => {
    expect(auktionKontaktFejl({ code: "BHA08", details: '{"felt":"titel","grund":"telefon","erhverv":false}' })).toEqual({
      felt: "titel",
      tekst: auktionKontaktTekst("titel", false),
    });
    expect(auktionKontaktFejl({ code: "BHA08", details: "ikke json" })?.felt).toBe("beskrivelse");
    expect(auktionKontaktFejl({ code: "BHA05", details: null })).toBeNull();
  });

  it("bruger Filips tekst for private", () => {
    expect(auktionKontaktTekst("beskrivelse", false)).toBe(
      "Skriv ikke telefonnummer, e-mail eller links i beskrivelsen. Køber og sælger skal tale sammen via BidHamr.",
    );
  });
});
