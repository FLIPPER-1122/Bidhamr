// Chattens spamfilter (TS-spejlet af public.besked_spam_grund) og
// "Spørg sælger"-filteret (indeholderKontaktinfo). Samme eksempler kører i
// testblokken sidst i supabase/migrations/20261102080000_handel_testfund.sql.
import { describe, expect, it } from "vitest";
import { spamGrund } from "@/lib/tryghed";
import { indeholderKontaktinfo } from "@/lib/kontaktInfo";
import { GAMLE, NYE } from "./spamfilterEksempler";

describe("spamGrund - eksempler fra tidligere migrationer (uændrede svar)", () => {
  it.each(GAMLE)("%s -> %s", (tekst, forventet) => {
    expect(spamGrund(tekst)).toBe(forventet);
  });
});

describe("spamGrund - spredte cifre, kort og reg./kontonr. (20261102080000)", () => {
  it.each(NYE)("%s -> %s", (tekst, forventet) => {
    expect(spamGrund(tekst)).toBe(forventet);
  });
});

describe("indeholderKontaktinfo (Spørg sælger)", () => {
  it.each([
    ["ring 2 2 3 3 4 4 5 5", true],
    ["Mit nummer er 2-2-3-3-4-4-5-5", true],
    ["Kortnummer 4111 1111 1111 1111", true],
    ["reg 1 2 3 4 konto 1 2 3 4 5 6 7 8", true],
    ["Skriv på whatsapp", true],
    ["Den koster 1.500 kr.", false],
    ["Kan den hentes 24/12?", false],
    ["Jeg vil gerne købe 3 x 2 stk", false],
    ["Kan du sende den før 24.12.2026?", false],
  ] as const)("%s -> %s", (tekst, forventet) => {
    expect(indeholderKontaktinfo(tekst)).toBe(forventet);
  });
});
