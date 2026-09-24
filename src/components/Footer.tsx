import Image from "next/image";
import Link from "next/link";

// Lys footer: logoet findes kun i en grøn variant, så det må ikke lægges på
// en skovgrøn flade (DESIGN.md afsnit 10).
export default function Footer() {
  return (
    <footer className="mt-16 border-t border-kant bg-groen-lys">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-[40ch]">
            <Image
              src="/brand/bidhamr-logo.svg"
              alt="BidHamr"
              width={230}
              height={60}
              unoptimized
              loading="lazy"
              className="h-8 w-auto"
            />
            <p className="mt-4 text-sm text-tekst-daempet">
              Auktioner mellem private. Køb og sælg trygt med BidHamr
              Beskyttelse.
            </p>
          </div>

          <nav
            aria-label="Footer"
            className="grid gap-x-10 gap-y-3 text-sm sm:grid-cols-2"
          >
            <Link
              href="/auktioner"
              className="font-medium text-groen hover:underline"
            >
              Alle auktioner
            </Link>
            <Link
              href="/opret-auktion"
              className="font-medium text-groen hover:underline"
            >
              Opret auktion
            </Link>
            <a
              href="mailto:support@bidhamr.dk"
              className="font-medium text-groen hover:underline"
            >
              support@bidhamr.dk
            </a>
            <span className="text-tekst-daempet">+45 70 12 34 56</span>
          </nav>
        </div>

        <div className="flex flex-col gap-2 border-t border-kant pt-6 text-xs text-tekst-svag sm:flex-row sm:items-center sm:justify-between">
          <span>&copy; {new Date().getFullYear()} BidHamr</span>
          {/* TODO indhold-agenten: handelsbetingelser, privatliv og cookies */}
          <span>Bud er bindende. Betaling sker via BidHamr.</span>
        </div>
      </div>
    </footer>
  );
}
