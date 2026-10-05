import Image from "next/image";
import Link from "next/link";
import Ikon from "@/components/Ikon";

// 404-indhold til src/app/not-found.tsx (uden topbar) og
// src/app/(app)/not-found.tsx (inde i topbar og footer). DESIGN.md afsnit 9:
// overskrift, kort forklaring, søgefelt og links videre.
const LINKS = [
  { href: "/auktioner", tekst: "Alle auktioner" },
  { href: "/saadan-virker-det", tekst: "Sådan virker det" },
  { href: "/faq", tekst: "Hjælp og FAQ" },
  { href: "/kontakt", tekst: "Kontakt kundeservice" },
];

export default function SideFindesIkke({ medLogo = false }: { medLogo?: boolean }) {
  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-16 sm:py-24">
      <div className="w-full max-w-lg text-center">
        {medLogo && (
          <Link
            href="/"
            aria-label="BidHamr - til forsiden"
            className="mb-10 inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <Image src="/brand/bidhamr-logo.svg" alt="BidHamr" width={230} height={60} unoptimized className="h-9 w-auto" />
          </Link>
        )}
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
          <Ikon navn="soeg" className="h-6 w-6" />
        </div>
        <p className="mt-4 text-sm font-semibold text-tekst-svag">Fejl 404</p>
        <h1 className="mt-1 font-serif text-2xl font-semibold text-tekst sm:text-3xl">Siden findes ikke</h1>
        <p className="mt-3 text-[15px] text-tekst-daempet">
          Siden er flyttet eller slettet, eller adressen er skrevet forkert. Er det en auktion, kan den være
          afsluttet og fjernet. Prøv at søge efter det, du leder efter.
        </p>

        <form
          action="/auktioner"
          method="GET"
          role="search"
          className="mx-auto mt-6 flex max-w-md items-center gap-2 rounded-xl border border-kant-staerk bg-white p-1.5 pl-4 focus-within:border-groen focus-within:ring-1 focus-within:ring-groen"
        >
          <label htmlFor="ikke-fundet-soeg" className="sr-only">
            Hvad leder du efter?
          </label>
          <Ikon navn="soeg" className="h-5 w-5 shrink-0 text-tekst-svag" />
          <input
            id="ikke-fundet-soeg"
            type="search"
            name="q"
            placeholder="Hvad leder du efter?"
            className="h-10 min-w-0 flex-1 bg-transparent text-base text-tekst outline-none placeholder:text-pladsholder sm:text-sm"
          />
          <button type="submit" className="btn btn-primaer h-10 shrink-0 px-4">
            Søg
          </button>
        </form>

        <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="font-medium text-groen hover:underline">
                {l.tekst}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6">
          <Link href="/" className="text-sm font-medium text-groen hover:underline">
            Til forsiden
          </Link>
        </p>
      </div>
    </main>
  );
}
