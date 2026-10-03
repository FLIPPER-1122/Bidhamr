// Sager fra køberen: fælles konstanter, typer og tekster for server actions og
// frontend. Ingen server-only-import - frontend må gerne bruge dem.
// Reglerne er spejlet i supabase/migrations/20261003010000_sager.sql
// (sag_opret, sag_valider_billeder, storage-bucket 'sag-billeder').

export const SAG_TYPER = ["bortkommet", "skadet", "ikke_som_beskrevet", "svindel"] as const;
export type SagType = (typeof SAG_TYPER)[number];

export const SAG_STATUSSER = [
  "aaben",
  "afventer_retur",
  "afgjort_koeber",
  "afgjort_saelger",
  "lukket",
] as const;
export type SagStatus = (typeof SAG_STATUSSER)[number];

export const SAG_BILLEDE_KATEGORIER = ["pakke", "label", "indhold", "andet"] as const;
export type SagBilledeKategori = (typeof SAG_BILLEDE_KATEGORIER)[number];
// Kræves (mindst ét af hver), når pakken er modtaget.
export const SAG_KRAEVEDE_KATEGORIER: readonly SagBilledeKategori[] = ["pakke", "label", "indhold"];

export const SAG_BUCKET = "sag-billeder";
export const SAG_MAKS_BILLEDER = 10;
export const SAG_MAKS_BILLEDSTOERRELSE = 10 * 1024 * 1024; // 10 MB
export const SAG_BILLEDTYPER = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
] as const;
export const SAG_BESKRIVELSE_MIN = 10;
export const SAG_BESKRIVELSE_MAKS = 4000;
export const SAG_BEGRUNDELSE_MAKS = 2000;

// Frister (timer/dage). Spejlet i sag_opret, sag_afgoer og handel_auto_frigiv.
export const SAG_FRIST_TIMER_EFTER_MODTAGET = 48;
export const SAG_BORTKOMMET_EFTER_DAGE = 7;
// Pengene frigives automatisk 14 dage efter afsendelse, hvis køberen hverken
// har trykket "modtaget" eller oprettet en sag.
export const SAG_AUTO_FRIGIV_EFTER_DAGE = 14;
// Ankefrist: pengene flyttes først 4 dage efter en afgørelse.
export const SAG_ANKEFRIST_DAGE = 4;

// Hvad der sker med pengene efter afgørelsen (sager.penge_handling).
export type SagPengeHandling = "refunder" | "frigiv" | "ingen";

// Hvorfor pengene ikke kunne flyttes efter ankefristen (sager.penge_fejl).
// Kun til staff.
export const SAG_PENGE_FEJL_NAVN: Record<string, string> = {
  indsigelse: "køberen har en åben indsigelse hos sin bank",
  ikke_mulig: "betalingen kan ikke refunderes (allerede refunderet eller overført)",
  refusion: "betalingen er refunderet eller under refusion",
  ikke_betalt: "betalingen er ikke betalt",
  ingen_betaling: "handlen har ingen betaling",
  handel_status: "handlen er ikke i et trin, hvor pengene kan frigives",
  refunderet_hos_stripe: "betalingen blev refunderet hos Stripe før ankefristen udløb",
};

// Staff-chat om en sag: staff_samtaler.sag_type = 'sag', sag_id = sager.id.
export const SAG_CHAT_TYPE = "sag";

export const SAG_TYPE_NAVN: Record<SagType, string> = {
  bortkommet: "Pakken er ikke kommet frem",
  skadet: "Varen er gået i stykker under forsendelsen",
  ikke_som_beskrevet: "Varen er ikke som beskrevet",
  svindel: "Svindel (tom pakke, helt anden vare, falsk kopi eller aldrig sendt)",
};

export const SAG_STATUS_NAVN: Record<SagStatus, string> = {
  aaben: "Åben - BidHamr kigger på sagen",
  afventer_retur: "Varen skal sendes retur",
  afgjort_koeber: "Afgjort - køberen har fået medhold",
  afgjort_saelger: "Afgjort - sælgeren har fået medhold",
  lukket: "Lukket",
};

export const SAG_KATEGORI_NAVN: Record<SagBilledeKategori, string> = {
  pakke: "Pakken",
  label: "Labelen",
  indhold: "Indholdet",
  andet: "Andet",
};

export function erSagType(v: unknown): v is SagType {
  return typeof v === "string" && (SAG_TYPER as readonly string[]).includes(v);
}

export function erSagBilledeKategori(v: unknown): v is SagBilledeKategori {
  return typeof v === "string" && (SAG_BILLEDE_KATEGORIER as readonly string[]).includes(v);
}

// Kræver typen BidHamr Beskyttelse? (svindel og bortkommet gør aldrig)
export function sagKraeverBeskyttelse(type: SagType): boolean {
  return type === "skadet" || type === "ikke_som_beskrevet";
}

const FIL_ENDELSE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
};

// Sti i bucket 'sag-billeder' til et nyt billede: <køber-id>/<handel-id>/<uuid>.<endelse>.
// Storage-policyen tillader kun upload i køberens egen mappe på en handel,
// hvor han er køber. Upload med { upsert: false } (der er ingen update-policy).
export function sagBilledeSti(koeberId: string, tradeId: string, mimeType: string): string | null {
  const endelse = FIL_ENDELSE[mimeType];
  if (!endelse) return null;
  return `${koeberId}/${tradeId}/${crypto.randomUUID()}.${endelse}`;
}

export function sagSti(tradeId: string): string {
  return `/mine-handler/${tradeId}`;
}

// Link direkte til sagen på handelssiden (notifikationer, mails, listen).
export function sagLink(tradeId: string): string {
  return `${sagSti(tradeId)}#sag`;
}

export function adminSagSti(sagId: string): string {
  return `/admin/sager/${sagId}`;
}

// Fejlkoder fra sag_opret / sag_tilfoej_billeder -> dansk tekst til køberen.
export const SAG_OPRET_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ikke_fundet: "Handlen findes ikke.",
  ugyldig_type: "Vælg, hvad sagen drejer sig om.",
  ugyldig_beskrivelse: `Beskriv problemet med mindst ${SAG_BESKRIVELSE_MIN} tegn (højst ${SAG_BESKRIVELSE_MAKS}).`,
  findes: "Der er allerede oprettet en sag på denne handel.",
  ikke_betalt: "Der kan ikke oprettes en sag på handlen lige nu, fordi pengene allerede er udbetalt eller refunderet.",
  kraever_beskyttelse:
    "Denne type sag kræver BidHamr Beskyttelse. Uden BidHamr Beskyttelse må du og sælgeren selv finde en løsning.",
  for_sent: `Fristen er udløbet. En sag skal oprettes inden for ${SAG_FRIST_TIMER_EFTER_MODTAGET} timer, efter du har markeret pakken som modtaget.`,
  for_tidligt: `Du kan melde pakken bortkommet, når der er gået ${SAG_BORTKOMMET_EFTER_DAGE} dage, siden sælgeren sendte den.`,
  forkert_trin: "Den type sag kan ikke oprettes på handlen lige nu.",
  billeder_kraeves: "Tilføj mindst ét billede af pakken, ét af labelen og ét af indholdet.",
  ugyldige_billeder: "Et eller flere billeder er ugyldige. Upload dem igen.",
  billede_mangler: "Et billede blev ikke uploadet korrekt. Upload det igen.",
  for_mange_billeder: `Du kan højst tilføje ${SAG_MAKS_BILLEDER} billeder til en sag.`,
  lukket: "Sagen er afsluttet, så der kan ikke tilføjes flere billeder.",
};
