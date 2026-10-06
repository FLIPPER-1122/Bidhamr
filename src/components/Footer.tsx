import Image from "next/image";
import Link from "next/link";
import Ikon from "@/components/Ikon";
import CookieindstillingerKnap from "@/components/samtykke/CookieindstillingerKnap";

// Lys footer: logoet findes kun i en grøn variant, så det må ikke lægges på
// en skovgrøn flade (DESIGN.md afsnit 10).
// Siderne bag linkene laves af indhold-agenten; et link må gerne pege på en
// side, der ikke findes endnu.
const KOLONNER: { titel: string; links: { href: string; tekst: string }[] }[] = [
  {
    titel: "Køb og sælg",
    links: [
      { href: "/auktioner", tekst: "Alle auktioner" },
      { href: "/opret-auktion", tekst: "Sælg en vare" },
      { href: "/saadan-virker-det", tekst: "Sådan virker det" },
      { href: "/bidhamr-beskyttelse", tekst: "BidHamr Beskyttelse" },
      { href: "/pakkeguide", tekst: "Pakkeguide" },
    ],
  },
  {
    titel: "Hjælp",
    links: [
      { href: "/faq", tekst: "FAQ" },
      { href: "/kontakt", tekst: "Kontakt kundeservice" },
      { href: "/forbudte-varer", tekst: "Forbudte varer" },
      { href: "/kontakt?emne=fejl", tekst: "Rapportér en fejl" },
      { href: "/dsa/anmeld", tekst: "Anmeld ulovligt indhold" },
    ],
  },
  {
    titel: "BidHamr",
    links: [
      { href: "/om", tekst: "Om BidHamr" },
      { href: "/betingelser", tekst: "Brugerbetingelser" },
      { href: "/privatliv", tekst: "Privatlivspolitik" },
      { href: "/cookies", tekst: "Cookies" },
      { href: "/tilgaengelighed", tekst: "Tilgængelighedserklæring" },
      { href: "/dsa", tekst: "Ulovligt indhold og DSA" },
    ],
  },
];

const link =
  "inline-flex min-h-11 items-center rounded-md text-[15px] font-medium text-groen-mork hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:min-h-9";

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-kant bg-groen-lys">
      <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)] lg:gap-8">
          <div className="max-w-[40ch]">
            <Image
              src="/brand/bidhamr-logo.svg"
              alt="BidHamr"
              width={230}
              height={60}
              unoptimized
              loading="lazy"
              className="h-9 w-auto"
            />
            {/* TODO indhold-agenten: endelig kort tekst om BidHamr */}
            <p className="mt-4 text-sm leading-relaxed text-tekst-daempet">
              Auktioner mellem private i Danmark. Køb og sælg brugte ting trygt – med
              BidHamr Beskyttelse og sikker betaling via Stripe.
            </p>
            <Link
              href="/opret-auktion"
              className="mt-5 inline-flex min-h-11 items-center gap-1.5 rounded-md text-[15px] font-semibold text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              Sælg en vare
              <Ikon navn="hoejre" className="h-4 w-4" />
            </Link>
          </div>

          {/* To spalter på mobil, så footeren ikke bliver uendelig lang */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:col-span-3">
            {KOLONNER.map((k) => (
              <nav key={k.titel} aria-label={k.titel} className="min-w-0">
                <h2 className="font-sans text-sm font-semibold text-tekst">{k.titel}</h2>
                <ul className="mt-3 flex flex-col gap-1">
                  {k.links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className={link}>
                        {l.tekst}
                      </Link>
                    </li>
                  ))}
                  {/* Altid mulighed for at ændre eller trække cookie-samtykket tilbage. */}
                  {k.titel === "BidHamr" && (
                    <li>
                      <CookieindstillingerKnap className={`${link} text-left`} />
                    </li>
                  )}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-groen/15 pt-6 text-xs text-tekst-svag sm:flex-row sm:items-center sm:justify-between">
          <span>&copy; {new Date().getFullYear()} BidHamr</span>
          <span>Bud er bindende. Betalingen håndteres sikkert af Stripe.</span>
        </div>
      </div>
    </footer>
  );
}
