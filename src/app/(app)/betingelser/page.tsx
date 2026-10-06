import type { Metadata } from "next";
import JuraSide from "@/components/jura/JuraSide";
import { hentBrugerbetingelser } from "@/lib/jura/juraDokument";
import { seoIndeksering } from "@/lib/seo";
import { PRIVATLIV_STI } from "@/lib/vilkaar";

// Brugerbetingelser (jura/brugerbetingelser-udkast.md). Offentlig side
// (OFFENTLIGE_RUTER i src/lib/supabase/middleware.ts). Udkastet indekseres
// ikke, før SEO_INDEKSERING=true (som resten af siden).
export const metadata: Metadata = {
  title: "Brugerbetingelser",
  description:
    "BidHamrs brugerbetingelser og handelsbetingelser: auktioner, bud, gebyrer, betaling, forsendelse, sager og BidHamr Beskyttelse.",
  ...(seoIndeksering() ? {} : { robots: { index: false, follow: false } }),
};

export default function BetingelserSide() {
  return (
    <JuraSide
      dokument={hentBrugerbetingelser()}
      intro="Her står reglerne for at bruge BidHamr – som køber, sælger og besøgende. Når du opretter en konto, accepterer du dem."
      krydslinks={[
        { href: PRIVATLIV_STI, tekst: "Privatlivspolitik" },
        { href: "/cookies", tekst: "Cookies" },
        { href: "/forbudte-varer", tekst: "Forbudte varer" },
        { href: "/bidhamr-beskyttelse", tekst: "BidHamr Beskyttelse" },
        { href: "/dsa", tekst: "Ulovligt indhold og DSA" },
      ]}
    />
  );
}
