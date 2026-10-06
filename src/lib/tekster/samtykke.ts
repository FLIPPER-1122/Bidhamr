// Tekster til cookie-banneret og cookieindstillingerne.
// Skal passe til src/lib/samtykke.ts (kategorierne) og /cookies-siden.
// Ærlighed: BidHamr bruger i dag kun nødvendige cookies. Står en kategori
// som iBrug=false, skal teksten sige, at den ikke bruges i dag.
// Betaling: skriv aldrig, at BidHamr modtager eller holder penge – betalingen
// håndteres af vores betalingspartner Stripe.
import type { SamtykkeKategori } from "@/lib/samtykke";

export const SAMTYKKE_TEKST = {
  bannerOverskrift: "Vi bruger kun nødvendige cookies",
  bannerTekst:
    "De holder dig logget ind, beskytter din konto og husker dit valg. Når du betaler, bruger vores betalingspartner Stripe cookies for at forhindre svindel. Vi bruger ingen cookies til statistik eller markedsføring – begynder vi på det, spørger vi dig først. Du kan altid ændre dit valg under \"Cookieindstillinger\" nederst på siden.",
  // Kort udgave til mobil, så banneret ikke dækker siden (én linje).
  bannerTekstKort: "De bruges til login og sikkerhed.",
  laesMere: "Læs mere om cookies",
  laesMereKort: "Læs mere",
  accepterAlle: "Accepter alle",
  kunNoedvendige: "Kun nødvendige",
  indstillinger: "Indstillinger",
  indstillingerOverskrift: "Cookieindstillinger",
  indstillingerTekst:
    "Her vælger du, hvad du vil tillade. Nødvendige cookies er altid slået til, fordi siden ikke virker uden dem. Du kan altid ændre dit valg under \"Cookieindstillinger\" nederst på siden.",
  gemValg: "Gem mit valg",
  luk: "Luk cookieindstillinger",
  altidTil: "Altid slået til",
  ikkeIBrug: "Bruges ikke i dag",
  gemt: "Dit cookievalg er gemt. Du kan altid ændre det under \"Cookieindstillinger\" nederst på siden.",
  nuvaerendeValg: (dato: string) => `Du har sidst valgt den ${dato}.`,
  noedvendigeNavn: "Nødvendige",
  noedvendigeBeskrivelse:
    "Holder dig logget ind, giver dig besked ved login fra en ny enhed, husker dit cookievalg og gemmer din kladde, når du opretter en auktion. Når du betaler, bruger Stripe cookies for at forhindre svindel.",
};

export const KATEGORI_TEKST: Record<SamtykkeKategori, { navn: string; beskrivelse: string }> = {
  statistik: {
    navn: "Statistik",
    beskrivelse:
      "Fortæller os, hvordan siden bliver brugt, så vi kan gøre den bedre. Vores egen optælling af besøg bruger ingen cookies og gemmer ikke, hvem du er.",
  },
  markedsfoering: {
    navn: "Markedsføring",
    beskrivelse: "Viser annoncer for BidHamr på andre sider og måler, om de virker.",
  },
};
