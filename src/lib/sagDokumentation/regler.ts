// Dokumentation til sælger og til politiet (ROADMAP-BESLUTNINGER, "Dokumentation
// til politiet (Filip, 27. okt. 2026)"). Rene regler uden serveradgang, så de
// kan testes (tests/enhed/sagDokumentation.test.ts). Databasen tjekker det
// samme igen (sag_dokumentation_log, 20261102360000_sag_dokumentation.sql og
// 20261102380000_sag_dokumentation_rettelser.sql).

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
  ikke_aktiv: "Din to-trins-login er ikke aktiv. Log ind på admin igen.",
  for_mange: "Du har lavet 30 PDF'er den seneste time. Vent lidt, og prøv igen.",
};

// HTTP-status for fejlkoderne fra sag_dokumentation_log.
export function logFejlStatus(kode: string | undefined): number {
  if (kode === "ugyldig_sag") return 404;
  if (kode === "for_mange") return 429;
  if (kode === "ugyldig_tekst" || kode === "ugyldig_udgave") return 400;
  return 403;
}

// Højst så mange PDF'er pr. medarbejder pr. time. Håndhæves i databasen
// (sag_dokumentation_log, 20261102380000) under en lås pr. medarbejder.
export const MAKS_PR_TIME = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Billeder i sag-billeder og pakke-billeder ligger som
// <uploaderens id>/<handlens id>/<fil> (sagBilledeSti, pakke_valider_billeder).
// Kun stier i handlens egen mappe hos en af parterne hentes, så en forkert
// række aldrig kan trække en fremmed fil ind i PDF'en.
export function billedStiTilladt(sti: unknown, tradeId: string, parter: string[]): boolean {
  if (typeof sti !== "string") return false;
  const dele = sti.split("/");
  if (dele.length !== 3) return false;
  const [ejer, handel, fil] = dele;
  if (!UUID_RE.test(ejer) || !UUID_RE.test(handel)) return false;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(fil) || fil.includes("..")) return false;
  if (handel.toLowerCase() !== tradeId.toLowerCase()) return false;
  return parter.some((p) => p.toLowerCase() === ejer.toLowerCase());
}

// Offentlig URL til auktionsbilledet -> sti i bucket "auktion-billeder".
// Kun vores egen lagring (aldrig vilkårlige URL'er). Ugyldig URL-kodning
// (fx "%E0") giver null, så resten af PDF'en stadig laves.
export function auktionSti(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/auktion-billeder\/([^?#]+)$/.exec(url);
  if (!m) return null;
  let sti: string;
  try {
    sti = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return /\.\.|\\|[\u0000-\u001f]/.test(sti) || sti.startsWith("/") ? null : sti;
}

// Tekst, når et loft er ramt, fx "Viser de 1.000 seneste af 1.234 beskeder."
export function loftTekst(vist: number, iAlt: number, hvilke: "seneste" | "første", flertal: string): string {
  const n = (x: number) => x.toLocaleString("da-DK");
  return `Viser de ${n(vist)} ${hvilke} af ${n(iAlt)} ${flertal}.`;
}

// "bidhamr-dokumentation-til-saelger-<8 tegn af sagens id>-2026-10-28.pdf"
export function dokumentationFilnavn(udgave: SagDokumentationUdgave, sagId: string, dannet: Date): string {
  const dato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen" }).format(dannet);
  const kort = sagId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase();
  return `bidhamr-dokumentation-${udgave === "politi" ? "til-politiet" : "til-saelger"}-${kort}-${dato}.pdf`;
}
