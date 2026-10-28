// Brugerens adresse til fakturaer (20261102340000_bruger_adresse.sql).
// Ingen server-only: reglerne og teksterne bruges både i formularerne og på
// serveren. Databasen tjekker det samme igen (bruger_adresse_gem) og sætter
// selv byen ud fra postnummeret.
import { slaaPostnummerOp } from "@/lib/postnumre";

export type AdresseFelt = "adresse" | "postnummer";

export type Adresse = { adresse: string; postnummer: string; by: string };

export const ADRESSE_MAKS = 200;

export const ADRESSE_TEKST = {
  adresse: "Adresse",
  adresseHjaelp: "Vejnavn og husnummer, evt. etage",
  postnummer: "Postnummer",
  by: "By",
  byHjaelp: "Udfyldes ud fra postnummeret",
  fejl: {
    adresse: "Skriv din adresse med vejnavn og husnummer.",
    adresseForLang: "Adressen er for lang.",
    postnummer: "Skriv et dansk postnummer med 4 cifre.",
    postnummerUkendt: "Vi kender ikke det postnummer. Tjek det, og prøv igen.",
    konto: "Din konto kan ikke ændres.",
    generisk: "Din adresse kunne ikke gemmes. Prøv igen om lidt.",
  },
  // Formularen før første bud eller betaling.
  kraevesTitel: "Vi mangler din adresse",
  kraevesBud: "Udfyld din adresse, før du byder. Den skal stå på din kvittering eller faktura, hvis du vinder.",
  kraevesBetaling: "Udfyld din adresse, før du betaler. Den skal stå på din kvittering eller faktura.",
  gem: "Gem adresse",
  gemOgFortsaet: "Gem og fortsæt",
  gemt: "Din adresse er gemt.",
  // Min konto -> Min adresse.
  sideTitel: "Min adresse",
  sideTekst:
    "Din adresse står på kvitteringer og fakturaer, når du køber noget. Andre brugere kan ikke se den. Køber du hos et firma, får firmaet den på fakturaen.",
  navnTitel: "Navn på fakturaer",
  navnMitId: "Du er bekræftet med MitID, så navnet på dine fakturaer er dit navn fra MitID. Det kan ikke rettes.",
  navnUdenMitId: "Navnet på dine fakturaer er dit navn på profilen. Du kan rette det under Profil.",
  afhentning:
    "Sælger du en vare til afhentning, bruges din adresse til afhentning under Profil (den kan være en anden).",
} as const;

// Samme rensning som databasen: mellemrum samles og trimmes.
export function renAdresseTekst(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

export function renPostnummer(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s/g, "") : "";
}

// Validerer adresse og postnummer og slår byen op i postnummerlisten (samme
// liste som databasens postnummer_koordinater). Byen fra brugeren bruges
// aldrig - den udfyldes altid ud fra postnummeret.
export function validerAdresse(input: {
  adresse: unknown;
  postnummer: unknown;
}): { ok: true; adresse: Adresse } | { fejl: string; felt: AdresseFelt } {
  const adresse = renAdresseTekst(input.adresse);
  const postnummer = renPostnummer(input.postnummer);
  if (adresse.length > ADRESSE_MAKS) return { fejl: ADRESSE_TEKST.fejl.adresseForLang, felt: "adresse" };
  if (adresse.length < 3 || !/\p{L}/u.test(adresse) || !/\d/.test(adresse) || /[\u0000-\u001f\u007f]/.test(adresse)) {
    return { fejl: ADRESSE_TEKST.fejl.adresse, felt: "adresse" };
  }
  if (!/^\d{4}$/.test(postnummer)) return { fejl: ADRESSE_TEKST.fejl.postnummer, felt: "postnummer" };
  const opslag = slaaPostnummerOp(postnummer);
  if (!opslag) return { fejl: ADRESSE_TEKST.fejl.postnummerUkendt, felt: "postnummer" };
  return { ok: true, adresse: { adresse, postnummer, by: opslag.by } };
}

// Byen til feltet "By" (tom, hvis postnummeret ikke er kendt endnu).
export function byForPostnummer(postnummer: string): string {
  return slaaPostnummerOp(renPostnummer(postnummer))?.by ?? "";
}

// Databasens svar fra gem_min_adresse / bruger_adresse_gem som fejltekst.
export function adresseKodeFejl(kode: unknown): { fejl: string; felt?: AdresseFelt; konto?: true } {
  if (kode === "adresse") return { fejl: ADRESSE_TEKST.fejl.adresse, felt: "adresse" };
  if (kode === "postnummer") return { fejl: ADRESSE_TEKST.fejl.postnummerUkendt, felt: "postnummer" };
  if (kode === "konto") return { fejl: ADRESSE_TEKST.fejl.konto, konto: true };
  return { fejl: ADRESSE_TEKST.fejl.generisk };
}

// Databasens fejl, når adressen mangler før et bud (BHY01, adresse_kraev).
export const ADRESSE_FEJLKODE = "BHY01";

export function erAdresseFejl(code: string | null | undefined, message?: string | null): boolean {
  return code === ADRESSE_FEJLKODE || (message ?? "").includes("adresse_mangler");
}
