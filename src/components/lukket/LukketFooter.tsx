import Link from "next/link";
import FirmaLinje from "@/components/FirmaLinje";
import { PRIVATLIV_STI } from "@/lib/vilkaar";

// Footer i den lukkede "før lancering"-udgave (src/lib/lukketUdgave.ts) og på
// /coming-soon: kun firmaoplysningerne (e-handelsloven § 7), privatlivspolitikken
// (erhvervsformularen og ventelisten indsamler personoplysninger, GDPR art. 13)
// og DSA-kontaktpunktet (DSA art. 11-12). Ingen andre links.
const LINK =
  "inline-flex min-h-11 items-center rounded-md text-[14px] font-medium text-groen-mork hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:min-h-9";

export default function LukketFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`border-t border-kant bg-groen-lys ${className}`}>
      <div className="mx-auto flex max-w-[1280px] flex-col gap-3 px-4 py-8 sm:px-6 lg:px-8">
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            <li>
              <Link href={PRIVATLIV_STI} className={LINK}>
                Privatlivspolitik
              </Link>
            </li>
            <li>
              <Link href="/dsa" className={LINK}>
                Ulovligt indhold og DSA
              </Link>
            </li>
          </ul>
        </nav>
        <p className="text-xs text-tekst-svag">&copy; {new Date().getFullYear()} BidHamr</p>
        <FirmaLinje className="text-xs text-tekst-svag" />
      </div>
    </footer>
  );
}
