// Bedømmelser: sælgerens svar, rapporter og staffs moderation.
// Database: supabase/migrations/20261007020000_bedoemmelse_svar.sql
// (bedoemmelse_svar, bedoemmelse_moderation, skriv_bedoemmelse_svar,
// slet_bedoemmelse_svar, rapporter_bedoemmelse, skjul_bedoemmelse,
// behold_bedoemmelse). Grænser og lister her SKAL matche SQL'en.
// Ingen server-only-import: både sider og klientkomponenter bruger teksterne.

// Sælgerens svar: højst 1000 tegn, kan rettes/slettes i 48 timer.
export const MAKS_SVAR_TEGN = 1000;
export const SVAR_RET_TIMER = 48;

// Del af en bedømmelse, der kan rapporteres/skjules.
export type BedoemmelseDel = "bedoemmelse" | "svar";

// Staffs faste begrundelser, når noget skjules (bedoemmelse_moderation.grund).
export const SKJUL_GRUNDE = [
  { vaerdi: "groft_sprog", label: "Grove ord eller chikane" },
  { vaerdi: "personoplysninger", label: "Personoplysninger" },
  { vaerdi: "kontaktinfo", label: "Kontaktoplysninger" },
  { vaerdi: "ikke_relateret", label: "Ikke relateret til handlen" },
  { vaerdi: "andet", label: "Andet (skriv hvorfor)" },
] as const;

export type SkjulGrund = (typeof SKJUL_GRUNDE)[number]["vaerdi"];

export function erSkjulGrund(v: unknown): v is SkjulGrund {
  return typeof v === "string" && SKJUL_GRUNDE.some((g) => g.vaerdi === v);
}

export function skjulGrundNavn(v: string | null | undefined): string {
  if (v === "andet") return "Andet";
  return SKJUL_GRUNDE.find((g) => g.vaerdi === v)?.label ?? v ?? "";
}

// Kategorier, en bruger kan vælge, når en bedømmelse eller et svar
// rapporteres (bruger_rapporter.category).
export const BEDOEMMELSE_RAPPORT_KATEGORIER = [
  { vaerdi: "chikane", label: "Grove ord, chikane eller trusler" },
  { vaerdi: "personoplysninger", label: "Personoplysninger (fx navn, adresse)" },
  { vaerdi: "kontaktinfo", label: "Kontaktoplysninger eller handel uden om BidHamr" },
  { vaerdi: "ikke_relateret", label: "Handler ikke om handlen" },
  { vaerdi: "stoedende", label: "Stødende indhold" },
  { vaerdi: "spam", label: "Spam eller reklame" },
  { vaerdi: "andet", label: "Andet" },
] as const;

export function erBedoemmelseRapportKategori(v: unknown): boolean {
  return typeof v === "string" && BEDOEMMELSE_RAPPORT_KATEGORIER.some((k) => k.vaerdi === v);
}

// Kan svaret stadig rettes eller slettes (48 timer efter det er skrevet)?
export function svarKanRettes(oprettet: string, nu: number = Date.now()): boolean {
  return nu - new Date(oprettet).getTime() < SVAR_RET_TIMER * 60 * 60 * 1000;
}

// En bedømmelse, som den vises på profilen.
export type BedoemmelseVisning = {
  id: string;
  fra_bruger_id: string;
  fra_bruger_navn: string;
  stjerner: number;
  kommentar: string | null;
  oprettet: string;
  // Sælgeren har selv slettet sit svar (kun sat på egen profil). Der kan
  // ikke skrives et nyt, så "Svar offentligt" vises ikke.
  svarSlettet: boolean;
  svar: {
    tekst: string;
    oprettet: string;
    rettet_kl: string | null;
    // Kun sælgeren selv ser sit eget skjulte svar (RLS).
    skjult: boolean;
    // Udregnet på serveren (svarKanRettes), så klienten ikke afhænger af sit ur.
    kanRettes: boolean;
  } | null;
};
