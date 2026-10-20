// Fragtfirmaets handelsbetingelser, som sælgeren accepterer før første
// forsendelse (Filip, 20. okt. 2026 - ROADMAP-BESLUTNINGER, "DAO: sælgeren
// accepterer DAO's handelsbetingelser"). Ingen advarselsboks - kun en accept.
//
// DAO (Allan, 20. okt. 2026): maks. 2.500 kr. erstatning pr. pakke, ekstra
// dækning kan ikke tilkøbes, undtagelser følger DAO's handelsbetingelser, og
// skader/efterlysning anmeldes på omdeling.info.
//
// Accepten gemmes i databasen (fragt_betingelser_accept - én række pr.
// sælger, fragtfirma og version; 20261028010000). Ændres `version`, skal alle
// sælgere acceptere igen. Kun DAO kræver accept nu; GLS kan tilføjes her,
// når Filip siger til.
//
// Ingen server-only-import: label-siden (klient) bruger tekst og link.

export type FragtBetingelser = {
  fragtfirma: "dao";
  navn: string;
  // Link til betingelserne (åbnes i en ny fane).
  url: string;
  // Betingelsernes version (DAO: "gælder fra 1. oktober 2025").
  version: string;
};

// Fundet på dao.as 20. okt. 2026 (forsidens link "Handelsbetingelser";
// siden siger, at betingelserne gælder fra 1. oktober 2025 for både privat-
// og erhvervskunder).
export const DAO_BETINGELSER: FragtBetingelser = {
  fragtfirma: "dao",
  navn: "DAO",
  url: "https://dao.as/handelsbetingelser/",
  version: "2025-10-01",
};

// Fejlkoden til appen (/api/fragt/app/book svarer 409 { fejl, kode }).
export const DAO_BETINGELSER_KODE = "dao_betingelser";

// Teksten ved afkrydsningen (fast - hjemmesiden og appen).
export const DAO_BETINGELSER_ACCEPT_TEKST = "Jeg accepterer DAO's handelsbetingelser for forsendelsen";

export const DAO_BETINGELSER_FEJL = "Sæt flueben ved DAO's handelsbetingelser, før du laver fragtlabelen.";

// Kører pakken med DAO? DAO direkte (fragtfirma 'dao') eller Shipmondo med
// transportøren DAO (mangler den, er det DAO - som i resten af fragten).
export function kraeverDaoBetingelser(fragtfirma: string | null | undefined, transportoer: string | null | undefined): boolean {
  if (fragtfirma === "dao") return true;
  return fragtfirma === "shipmondo" && (transportoer ?? "dao") === "dao";
}
