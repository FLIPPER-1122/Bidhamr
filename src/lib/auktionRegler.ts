// Regler for auktioner. Deles af opret-formularen, redigering, budfeltet og
// genopsætning (server action), så de altid er ens. Databasen håndhæver de
// samme regler (supabase/migrations/20261004060000_auktionsregler.sql).

// Varighed: 3, 5, 7 eller 10 dage, 7 forvalgt (Filip, 4. oktober 2026).
export const VARIGHEDER = [
  { label: "3 dage", dage: 3 },
  { label: "5 dage", dage: 5 },
  { label: "7 dage", dage: 7 },
  { label: "10 dage", dage: 10 },
] as const;

export type VarighedDage = (typeof VARIGHEDER)[number]["dage"];

export const STANDARD_VARIGHED: VarighedDage = 7;

export function erGyldigVarighed(dage: unknown): dage is VarighedDage {
  return VARIGHEDER.some((v) => v.dage === dage);
}

// Sluttidspunkt ud fra varighed. Kun vejledende - databasen beregner selv
// sluttidspunktet ud fra varigheden.
export function slutterKlFraVarighed(dage: VarighedDage, fra = new Date()): Date {
  const slut = new Date(fra);
  slut.setTime(slut.getTime() + dage * 24 * 60 * 60 * 1000);
  return slut;
}

// Budstigning som trappe efter det nuværende højeste bud (Filip, 4. oktober
// 2026). Samme regel som public.budstigning i databasen.
export function budstigning(nuvaerende: number): number {
  if (nuvaerende < 100) return 5;
  if (nuvaerende < 1000) return 10;
  if (nuvaerende < 5000) return 50;
  return 100;
}

// Mindste bud på en auktion: 3 kr (Niels M04, 8. okt. 2026). Stripes
// mindstebeløb i DKK er 2,50 kr., og en afhentningshandel er kun bud + 5 %
// købergebyr - så et vindende bud på 1-2 kr. kunne ikke betales.
export const MINDSTE_BUD = 3;

// Mindste tilladte næste bud. Uden bud: startprisen. Med bud: nuværende bud
// + budstigning. Altid mindst MINDSTE_BUD (også ved startpris 1-2 kr.).
// Samme regel som public.naeste_bud_minimum
// (20261010070000_niels_betaling.sql).
export function mindsteNaesteBud(nuvaerendeBud: number | null, startpris: number): number {
  if (nuvaerendeBud === null) return Math.max(Math.ceil(startpris || 0), MINDSTE_BUD);
  return Math.max(nuvaerendeBud + budstigning(nuvaerendeBud), MINDSTE_BUD);
}

// Startpris i hele kroner, mindst 1 kr (Filip, 5. oktober 2026 – som
// formularens felt: min 1, trin 1). Første bud er dog altid mindst
// MINDSTE_BUD (3 kr.). Samme regel i databasen
// (auctions_beskyt_ny, auctions_beskyt_kolonner, rediger_auktion,
// genopsaet_auktion - 20261005020000_startpris_anke.sql).
export const MINDSTE_STARTPRIS = 1;
// Beløbsloft (Filip, 26. okt. 2026 - før 500.000 kr.): startpris, bud og
// maksimum højst 25.000 kr., også erhverv. Databasen håndhæver det
// (beloebsloft_* og public.maks_beloeb_kr(), 20261031010000).
export const MAKS_STARTPRIS = 25_000;
export const MAKS_BUD = 25_000;
export const STARTPRIS_FOR_LAV = "Startprisen skal være mindst 1 kr.";

export function valideStartpris(startpris: unknown): string | null {
  if (typeof startpris !== "number" || !Number.isFinite(startpris)) {
    return "Angiv en startpris.";
  }
  if (!Number.isInteger(startpris)) return "Startprisen skal være i hele kroner.";
  if (startpris < MINDSTE_STARTPRIS) return STARTPRIS_FOR_LAV;
  if (startpris > MAKS_STARTPRIS) return "Startprisen kan højst være 25.000 kr.";
  return null;
}

// Anbefaling ved oprettelse og redigering.
export const STARTPRIS_ANBEFALING =
  "Sæt startprisen lidt under det, du regner med at få – er den for høj, byder ingen.";

export const BINDENDE_BUD_TEKST = "Dit bud er bindende og kan ikke trækkes tilbage.";

// Låst efter første bud (Filip, 7. okt. 2026): sælgeren kan hverken ændre,
// tilføje, slette eller annullere. Databasen afviser med errcode 'BHL01' og
// en besked, der starter med 'auktion_laast:'
// (20261010020000_auktion_laast_efter_bud.sql); rediger_auktion og
// saet_spoergsmaal_aktiv svarer i stedet kode 'har_bud'.
export const AUKTION_LAAST =
  "Auktionen har fået bud og er låst. Kontakt BidHamr, hvis der er et problem med varen.";

export function erAuktionLaastFejl(
  fejl: { code?: string; message?: string } | null | undefined,
): boolean {
  return !!fejl && (fejl.code === "BHL01" || (fejl.message ?? "").startsWith("auktion_laast:"));
}

// Klienten genkender låst-svaret fra server actions (redigerAuktion,
// annullerAuktion, saetSpoergsmaalAktiv) her - ét sted, så en gammel fane
// kan lukke dialogen, hente siden igen og vise låst-beskeden med link.
export function erAuktionLaastBesked(fejl: string | null | undefined): boolean {
  return fejl === AUKTION_LAAST;
}

// Beløbsloftet (20261031010000): databasen afviser startpris, bud og
// maksimum over loftet med errcode 'BHB05' og en besked, der starter med
// 'beloeb_for_hoejt:'. Teksten efter præfikset vises som den er.
export function beloebForHoejtTekst(
  fejl: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!fejl) return null;
  const besked = fejl.message ?? "";
  const i = besked.indexOf("beloeb_for_hoejt:");
  if (i >= 0) {
    const tekst = besked.slice(i + "beloeb_for_hoejt:".length).trim();
    if (tekst) return tekst;
  }
  if (fejl.code === "BHB05" || i >= 0) {
    return `Det højeste tilladte beløb er ${MAKS_BUD.toLocaleString("da-DK")} kr.`;
  }
  return null;
}

// Vises, når et kald til serveren kaster (fx afbrudt forbindelse).
export const NETVAERKSFEJL = "Der skete en fejl. Tjek din forbindelse, og prøv igen.";

// Samme grænse som public.auktion_billeder_gyldige (1-10 billeder).
export const MAKS_BILLEDER = 10;
export const MAKS_TITEL = 120;
export const MAKS_BESKRIVELSE = 500;

// Loft på nye auktioner for private (auctions_oprettelse_loft,
// 20261102060000). Firmaer har deres egen kvote og er undtaget.
export const MAKS_NYE_AUKTIONER_PR_TIME = 30;
export const MAKS_AKTIVE_AUKTIONER = 200;

// Dansk tekst til loft-fejlene (BHA06/BHA07). null = ikke en loft-fejl.
// medKladde: false ved "Sæt op igen" (genopsaet_auktion/saet_annulleret_op_igen
// - der er ingen kladde, og kun 200-loftet gælder dér).
export function auktionLoftTekst(kode: string | null | undefined, medKladde = true): string | null {
  const kladde = medKladde ? " – din kladde er gemt." : ".";
  if (kode === "BHA06") {
    return `Du har oprettet mange auktioner på kort tid (højst ${MAKS_NYE_AUKTIONER_PR_TIME} i timen). Vent lidt, og prøv igen${kladde}`;
  }
  if (kode === "BHA07") {
    return `Du har ${MAKS_AKTIVE_AUKTIONER} aktive auktioner, som er det højeste antal. Vent, til nogle af dem er slut, og prøv igen${kladde}`;
  }
  return null;
}

// crypto.randomUUID() findes kun i sikre kontekster (https eller localhost) –
// adgang via en LAN-IP over http (fx fra en telefon på samme netværk) ville
// ellers fejle med en kryptisk TypeError.
function lavBilledeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Sti til et nyt billede i bucket'en auktion-billeder: <bruger-id>/<id>.<endelse>.
// Databasen godtager kun filnavne af [A-Za-z0-9._-] (public.auktion_billeder_gyldige,
// 20261004061000_auktionsregler_rettelser.sql). Det originale filnavn (mellemrum,
// æøå osv.) bruges derfor ikke – kun en renset endelse.
export function auktionBilledeSti(brugerId: string, fil: { name: string; type?: string }): string {
  const fraNavn = fil.name.includes(".") ? (fil.name.split(".").pop() ?? "") : "";
  const fraType = fil.type?.startsWith("image/") ? fil.type.slice("image/".length) : "";
  const endelse =
    [fraNavn, fraType]
      .map((e) => e.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5))
      .find((e) => e.length > 0) ?? "jpg";
  return `${brugerId}/${lavBilledeId()}.${endelse}`;
}
