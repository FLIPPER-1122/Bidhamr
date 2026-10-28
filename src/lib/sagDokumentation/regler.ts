// Dokumentation til sælger og til politiet (ROADMAP-BESLUTNINGER, "Dokumentation
// til politiet (Filip, 27. okt. 2026)"). Rene regler uden serveradgang, så de
// kan testes (tests/enhed/sagDokumentation.test.ts). Databasen tjekker det
// samme igen (sag_dokumentation_log, 20261102360000_sag_dokumentation.sql).

export const SAG_DOKUMENTATION_UDGAVER = ["saelger", "politi"] as const;
export type SagDokumentationUdgave = (typeof SAG_DOKUMENTATION_UDGAVER)[number];

export const UDGAVE_NAVN: Record<SagDokumentationUdgave, string> = {
  saelger: "Dokumentation til sælger",
  politi: "Dokumentation til politiet",
};

export const GIVET_TIL_MIN = 2;
export const GIVET_TIL_MAKS = 200;
export const JOURNALNUMMER_MAKS = 100;

export function erUdgave(v: unknown): v is SagDokumentationUdgave {
  return typeof v === "string" && (SAG_DOKUMENTATION_UDGAVER as readonly string[]).includes(v);
}

type Rolle = "medarbejder" | "admin" | "chef" | null;

// Hvem må lave hvilken udgave?
//   saelger: al staff med adgang til sagen (medarbejder+), som ikke er inhabil.
//   politi:  kun chefen, og kun hvis chefen ikke er inhabil.
// Inhabil = part i handlen eller har handlet med en af parterne
// (penge_inhabil - samme regel som afgørelse af sagen).
// Returnerer null (tilladt) eller en dansk fejltekst.
export function dokumentationAfvisning(
  rolle: Rolle,
  udgave: SagDokumentationUdgave,
  inhabil: boolean,
): string | null {
  if (rolle !== "medarbejder" && rolle !== "admin" && rolle !== "chef") return "Du har ikke adgang.";
  if (udgave === "politi" && rolle !== "chef") return "Kun chefen kan lave dokumentationen til politiet.";
  if (inhabil) {
    return "Du er inhabil i denne sag (part i handlen eller har handlet med en af parterne) og kan ikke lave dokumentationen. Lad en kollega gøre det.";
  }
  return null;
}

export function maaLaveDokumentation(rolle: Rolle, udgave: SagDokumentationUdgave, inhabil: boolean): boolean {
  return dokumentationAfvisning(rolle, udgave, inhabil) === null;
}

// Felterne fra dialogen. Fjerner styretegn og overflødige mellemrum.
export function rensFelt(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function tjekFelter(
  udgave: SagDokumentationUdgave,
  givetTil: string,
  journalnummer: string,
): string | null {
  if (givetTil.length < GIVET_TIL_MIN) {
    return udgave === "politi"
      ? "Skriv, hvem dokumentationen gives til (fx \"Politi, Midt- og Vestsjællands Politi\")."
      : "Skriv, hvem dokumentationen gives til (fx \"Sælger\").";
  }
  if (givetTil.length > GIVET_TIL_MAKS) return `"Givet til" må højst være ${GIVET_TIL_MAKS} tegn.`;
  if (journalnummer.length > JOURNALNUMMER_MAKS) return `Journalnummeret må højst være ${JOURNALNUMMER_MAKS} tegn.`;
  return null;
}

// Fejlkoder fra sag_dokumentation_log.
export const LOG_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at lave denne udgave.",
  ugyldig_udgave: "Ukendt udgave.",
  ugyldig_sag: "Sagen findes ikke.",
  inhabil:
    "Du er inhabil i denne sag (part i handlen eller har handlet med en af parterne) og kan ikke lave dokumentationen.",
  ugyldig_tekst: "Udfyld \"Givet til\" (2-200 tegn) og eventuelt journalnummer (højst 100 tegn).",
};

// "bidhamr-dokumentation-til-saelger-<8 tegn af sagens id>-2026-10-28.pdf"
export function dokumentationFilnavn(udgave: SagDokumentationUdgave, sagId: string, dannet: Date): string {
  const dato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen" }).format(dannet);
  const kort = sagId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase();
  return `bidhamr-dokumentation-${udgave === "politi" ? "til-politiet" : "til-saelger"}-${kort}-${dato}.pdf`;
}
