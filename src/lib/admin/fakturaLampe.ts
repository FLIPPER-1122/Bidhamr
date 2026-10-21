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

// Teksterne foran drift-alarmerne faktura:konfiguration og faktura:adgang
// (src/lib/faktura/koe.ts). Admin -> Fakturaer finder den seneste
// konfigurationsalarm i drift_fejl ud fra præfikset (src/lib/faktura/tilfaelde.ts).
export const KONFIG_ALARM_PRAEFIKS = "Fakturaer laves ikke i Dinero - opsætningen er afvist:";
export const ADGANG_ALARM_PRAEFIKS = "Fakturaer laves ikke i Dinero - login afvist:";

export const DINERO_AFVISER_LOGIN = "Dinero afviser login";
export const DINERO_SAT_FORKERT_OP = "Dinero er sat forkert op";

// Åbne drift-tilfælde for Dinero -> rød status (null = ingen åbne). Bruges af
// både systemlampen og Admin -> Fakturaer, så de altid siger det samme.
export function dineroTilfaeldeStatus(
  aabne: string[],
  konfigurationTekst: string | null = null,
): { tekst: string; detalje: string } | null {
  if (aabne.includes("faktura:adgang")) {
    return {
      tekst: DINERO_AFVISER_LOGIN,
      detalje: "Fakturakøen kan ikke logge ind i Dinero og sender intet. Tjek Dinero-nøglerne med \"Test Dinero-forbindelse\".",
    };
  }
  if (aabne.includes("faktura:konfiguration")) {
    return {
      tekst: DINERO_SAT_FORKERT_OP,
      detalje: konfigurationTekst || "Fakturakøen sender intet, fordi opsætningen er afvist. Se drift-siden.",
    };
  }
  return null;
}

// Status-linjen om Dinero på Admin -> Fakturaer ("Dinero: sat op (...)" eller
// "Dinero afviser login"). Et åbent tilfælde vinder
// over "sat op" (variablerne kan være udfyldt, uden at de virker).
export type DineroStatus = { tone: "groen" | "roed"; tekst: string; detalje: string | null };

export function dineroStatus(d: {
  konfig: { ok: true; miljoe: "test" | "live"; orgId: string } | { ok: false; besked: string };
  aabne: string[];
  konfigurationTekst: string | null;
}): DineroStatus {
  const t = dineroTilfaeldeStatus(d.aabne, d.konfigurationTekst);
  if (t) return { tone: "roed", tekst: t.tekst, detalje: t.detalje };
  if (!d.konfig.ok) return { tone: "roed", tekst: `Dinero: ${d.konfig.besked}`, detalje: null };
  return {
    tone: "groen",
    tekst: `Dinero: sat op (${d.konfig.miljoe === "live" ? "live-regnskab" : "testregnskab"}, organisation ${d.konfig.orgId})`,
    detalje: null,
  };
}

export function fakturaLampe(d: FakturaLampeData): Lampe {
  const navn = "Fakturaer";
  const t = dineroTilfaeldeStatus(d.aabne);
  if (t?.tekst === DINERO_AFVISER_LOGIN) {
    return { navn, tone: "roed", tekst: t.tekst, statusTekst: "Fakturaer: Dinero afviser login - tjek Dinero-nøglerne" };
  }
  if (t) {
    return { navn, tone: "roed", tekst: t.tekst, statusTekst: "Fakturaer: Dinero er sat forkert op - se drift-siden" };
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
