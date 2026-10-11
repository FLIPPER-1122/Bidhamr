// "Meld fejl" i beta-testen: fælles konstanter og tekster for server actions,
// knappen og Admin -> Beta-fejl. Ingen server-only-import.
// Reglerne er spejlet i supabase/migrations/20261018020000_beta_fejl.sql
// (tabellen beta_fejl, beta_fejl_opret og bucket 'beta-fejl-billeder').

export const BETA_FEJL_BUCKET = "beta-fejl-billeder";
export const BETA_FEJL_MAKS_BILLEDER = 3;
// Bucketens grænse pr. fil (efter klargøring i browseren).
export const BETA_FEJL_MAKS_MB = 5;
export const BETA_FEJL_MAKS_TEKST = 4000;
export const BETA_FEJL_MAKS_FORVENTET = 2000;
export const BETA_FEJL_MAKS_NOTE = 2000;

export const BETA_FEJL_ALVOR = ["blokerer", "irriterende", "lille"] as const;
export type BetaFejlAlvor = (typeof BETA_FEJL_ALVOR)[number];

// TODO(indhold): gennemse teksterne.
export const ALVOR_NAVN: Record<BetaFejlAlvor, string> = {
  blokerer: "Jeg kan ikke komme videre",
  irriterende: "Det er besværligt",
  lille: "En lille ting",
};

export const ALVOR_KORT: Record<BetaFejlAlvor, string> = {
  blokerer: "Blokerer",
  irriterende: "Irriterende",
  lille: "Lille ting",
};

export const BETA_FEJL_STATUS = ["ny", "i_gang", "loest", "afvist"] as const;
export type BetaFejlStatus = (typeof BETA_FEJL_STATUS)[number];

export const STATUS_NAVN: Record<BetaFejlStatus, string> = {
  ny: "Ny",
  i_gang: "I gang",
  loest: "Løst",
  afvist: "Afvist",
};

export function erAlvor(v: unknown): v is BetaFejlAlvor {
  return typeof v === "string" && (BETA_FEJL_ALVOR as readonly string[]).includes(v);
}

export function erBetaFejlStatus(v: unknown): v is BetaFejlStatus {
  return typeof v === "string" && (BETA_FEJL_STATUS as readonly string[]).includes(v);
}

// Sti i bucketen: <bruger-id>/<uuid>.jpg (beta_fejl_billede_maa_uploade).
export function betaFejlBilledeSti(brugerId: string): string {
  return `${brugerId}/${crypto.randomUUID()}.jpg`;
}

export const BETA_FEJL_STI_MOENSTER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

// Fejlkoder fra beta_fejl_opret og server actionen -> dansk tekst.
// TODO(indhold): gennemse teksterne.
export const BETA_FEJL_FEJL: Record<string, string> = {
  ingen_adgang: "Du kan ikke melde fejl lige nu.",
  ugyldig_alvor: "Vælg, hvor slemt det er.",
  ugyldig_tekst: `Skriv, hvad du gjorde, og hvad der skete (højst ${BETA_FEJL_MAKS_TEKST} tegn).`,
  ugyldige_billeder: "Et af billederne kan ikke bruges. Fjern det, og prøv igen.",
  billede_mangler: "Et billede blev ikke uploadet. Fjern det, og prøv igen.",
  for_mange: "Du har meldt mange fejl på kort tid. Vent lidt, og prøv igen.",
};
