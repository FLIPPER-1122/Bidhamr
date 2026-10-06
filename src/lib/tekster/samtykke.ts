// Tekster til cookie-banneret og cookieindstillingerne.
// Skal passe til src/lib/samtykke.ts (kategorierne) og /cookies-siden.
// Ærlighed: BidHamr bruger i dag kun nødvendige cookies. Står en kategori
// som iBrug=false, skal teksten sige, at den ikke bruges i dag.
// TODO indhold-agenten: gennemlæs teksterne (korte pladsholdere).
import type { SamtykkeKategori } from "@/lib/samtykke";

export const SAMTYKKE_TEKST = {
  bannerOverskrift: "Cookies på BidHamr",
  bannerTekst:
    "Vi bruger kun de cookies, der skal til, for at du kan logge ind, handle og betale sikkert. Vi bruger ingen statistik- eller reklamecookies i dag. Begynder vi på det, spørger vi dig først.",
  laesMere: "Læs om cookies",
  accepterAlle: "Accepter alle",
  kunNoedvendige: "Kun nødvendige",
  indstillinger: "Indstillinger",
  indstillingerOverskrift: "Cookieindstillinger",
  indstillingerTekst:
    "Vælg, hvad du vil tillade. Du kan altid ændre dit valg under \"Cookieindstillinger\" nederst på siden.",
  gemValg: "Gem valg",
  luk: "Luk cookieindstillinger",
  altidTil: "Altid til",
  ikkeIBrug: "Bruges ikke i dag",
  gemt: "Dit cookievalg er gemt.",
  nuvaerendeValg: (dato: string) => `Dit nuværende valg er fra ${dato}.`,
  noedvendigeNavn: "Nødvendige",
  noedvendigeBeskrivelse:
    "Login, sikkerhed, dit cookievalg og betaling. Siden virker ikke uden dem.",
};

export const KATEGORI_TEKST: Record<SamtykkeKategori, { navn: string; beskrivelse: string }> = {
  statistik: {
    navn: "Statistik",
    beskrivelse:
      "Viser os, hvordan siden bliver brugt. Vores egen besøgstælling er cookiefri og kræver ikke samtykke.",
  },
  markedsfoering: {
    navn: "Markedsføring",
    beskrivelse: "Viser annoncer for BidHamr på andre sider og måler, om de virker.",
  },
};
