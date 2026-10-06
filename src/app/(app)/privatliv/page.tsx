import type { Metadata } from "next";
import JuraSide from "@/components/jura/JuraSide";
import { hentPrivatlivspolitik } from "@/lib/jura/juraDokument";
import { seoIndeksering } from "@/lib/seo";
import { BETINGELSER_STI } from "@/lib/vilkaar";

// Privatlivspolitik (jura/privatlivspolitik-udkast.md). Offentlig side
// (OFFENTLIGE_RUTER i src/lib/supabase/middleware.ts). Udkastet indekseres
// ikke, før SEO_INDEKSERING=true (som resten af siden).
export const metadata: Metadata = {
  title: "Privatlivspolitik",
  description:
    "Sådan behandler BidHamr dine personoplysninger: hvad vi gemmer, hvorfor, hvem vi deler med, hvor længe – og dine rettigheder.",
  ...(seoIndeksering() ? {} : { robots: { index: false, follow: false } }),
};

export default function PrivatlivSide() {
  return (
    <JuraSide
      dokument={hentPrivatlivspolitik()}
      intro="Her kan du læse, hvilke oplysninger BidHamr behandler om dig, hvorfor vi gør det, og hvilke rettigheder du har."
      krydslinks={[
        { href: BETINGELSER_STI, tekst: "Brugerbetingelser" },
        { href: "/cookies", tekst: "Cookies" },
        { href: "/konto#dine-data", tekst: "Download eller slet dine data" },
        { href: "/dsa", tekst: "Ulovligt indhold og DSA" },
      ]}
    />
  );
}
