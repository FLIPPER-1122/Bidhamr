// Systemlampen "Fakturaer" (lamper.ts). Ren funktion (testes i
// tests/enhed/fakturaKonfig.test.ts).
//
// Gul, når et dokument har ventet over FAKTURA_GUL_TIMER (samme grænse som
// drift-alarmen faktura:haenger i src/lib/faktura/koe.ts) eller kræver
// handling. RØD, når et dokument har ventet over FAKTURA_ROED_TIMER, eller når
// Dinero afviser login eller opsætningen (åbne drift-tilfælde faktura:adgang /
// faktura:konfiguration). Tallene læses direkte i databasen, så lampen også
// bliver rød, hvis fakturakøen slet ikke kører (fx Dinero ikke sat op, eller
// ingen kalder betalings-cron'en) - fakturaerne må aldrig stoppe stille.

import type { Lampe } from "@/lib/admin/lamper";

export const FAKTURA_GUL_TIMER = 2;
export const FAKTURA_ROED_TIMER = 6;

export type FakturaLampeData = {
  // Dokumenter i køen (venter/kladde/bogfoert, ikke opgivet eller manuelle),
  // der er oprettet for over hhv. FAKTURA_GUL_TIMER og FAKTURA_ROED_TIMER
  // timer siden.
  ventetGul: number;
  ventetRoed: number;
  // Status kraever_handling eller opgivet.
  kraeverHandling: number;
  // Åbne drift-tilfælde (faktura:adgang, faktura:konfiguration).
  aabne: string[];
};

const antal = (x: number, en: string, flere: string) => `${x} ${x === 1 ? en : flere}`;

export function fakturaLampe(d: FakturaLampeData): Lampe {
  const navn = "Fakturaer";
  if (d.aabne.includes("faktura:adgang")) {
    return { navn, tone: "roed", tekst: "Dinero afviser login", statusTekst: "Fakturaer: Dinero afviser login - tjek Dinero-nøglerne" };
  }
  if (d.aabne.includes("faktura:konfiguration")) {
    return { navn, tone: "roed", tekst: "Dinero er sat forkert op", statusTekst: "Fakturaer: Dinero er sat forkert op - se drift-siden" };
  }
  if (d.ventetRoed > 0) {
    const t = antal(d.ventetRoed, "dokument har", "dokumenter har");
    return { navn, tone: "roed", tekst: `${t} ventet over ${FAKTURA_ROED_TIMER} t`, statusTekst: `Fakturaer: ${t} ventet over ${FAKTURA_ROED_TIMER} timer` };
  }
  if (d.ventetGul > 0) {
    const t = antal(d.ventetGul, "dokument har", "dokumenter har");
    return { navn, tone: "gul", tekst: `${t} ventet over ${FAKTURA_GUL_TIMER} t`, statusTekst: `Fakturaer: ${t} ventet over ${FAKTURA_GUL_TIMER} timer` };
  }
  if (d.kraeverHandling > 0) {
    const t = antal(d.kraeverHandling, "dokument kræver", "dokumenter kræver");
    return { navn, tone: "gul", tekst: `${t} handling`, statusTekst: `Fakturaer: ${t} handling` };
  }
  return { navn, tone: "groen", tekst: "ingen venter" };
}
