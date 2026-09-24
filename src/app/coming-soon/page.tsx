import Image from "next/image";
import Link from "next/link";
import WaitlistForm from "@/components/landing/WaitlistForm";
import AuthHashRedirect from "@/components/landing/AuthHashRedirect";

// Server-komponent: ingen interaktion ud over ventelisteformularen, som er
// sin egen klientkomponent. TODO indhold-agenten: alle længere tekster her
// er pladsholdere og skal skrives igennem.

const TRIN = [
  {
    num: "01",
    titel: "Opret en auktion",
    tekst:
      "Tag billeder, sæt en startpris — eller start fra 0 kr. Du vælger selv, om du sender varen eller kun tilbyder afhentning.",
    ikon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 7h4l2-3h4l2 3h4v12H4V7zm8 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
      />
    ),
  },
  {
    num: "02",
    titel: "Køberne byder",
    tekst:
      "Købere byder mod hinanden, indtil tiden løber ud. Totalprisen — bud, gebyr og fragt — står altid tydeligt, før man byder.",
    ikon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    ),
  },
  {
    num: "03",
    titel: "Handel i hus",
    tekst:
      "Køber betaler med det samme, og pengene frigives til dig, når varen er modtaget og godkendt.",
    ikon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12l3 3 5-6M3 4h18v16H3V4z" />
    ),
  },
];

const TRYGHED = [
  {
    titel: "BidHamr Beskyttelse",
    tekst: "Pengene frigives først, når køber har godkendt varen.",
    ikon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3l8 3v5.5c0 5-3.4 9.5-8 10.5-4.6-1-8-5.5-8-10.5V6l8-3z"
      />
    ),
  },
  {
    titel: "Bindende bud",
    tekst: "Både køber og sælger ved, hvad de har sagt ja til.",
    ikon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 20h14M7 15l7-7 3 3-7 7H7v-3zM14 6l2-2 3 3-2 2"
      />
    ),
  },
  {
    titel: "Fragt eller afhentning",
    tekst: "Send med pakkelabel, eller lad vinderen hente hos dig.",
    ikon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7h11v10H3V7zm11 3h4l3 3v4h-7v-7zM7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"
      />
    ),
  },
  {
    titel: "Bedømmelser",
    tekst: "Køber og sælger bedømmer hinanden efter hver handel.",
    ikon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.4 6.2 17.9l.9-5.4L3.2 8.7l5.4-.8L12 3z"
      />
    ),
  },
];

export default function ComingSoonPage() {
  return (
    <div className="flex flex-1 flex-col bg-white text-tekst">
      {/* Fanger auth-tokens der lander her som hash-fragment. Må ikke fjernes. */}
      <AuthHashRedirect />

      {/* Let header – ingen adgang til resten af appen endnu */}
      <header className="border-b border-kant bg-white">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/coming-soon"
            aria-label="BidHamr"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <Image
              src="/brand/bidhamr-logo.svg"
              alt="BidHamr"
              width={230}
              height={60}
              priority
              unoptimized
              className="h-9 w-auto"
            />
          </Link>

          <a href="#top" className="btn btn-primaer">
            Tilmeld venteliste
          </a>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section
          id="top"
          className="mx-auto max-w-[1280px] px-4 pt-6 sm:px-6 lg:px-8"
        >
          <div className="overflow-hidden rounded-[18px] bg-groen p-6 text-white sm:p-10 lg:p-14">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[13px] font-semibold">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
              </svg>
              Åbner snart i Danmark
            </span>

            <h1 className="mt-4 max-w-[22ch] text-[30px] leading-[1.1] font-semibold text-white lg:text-[42px]">
              Auktioner mellem private
            </h1>

            <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-white/85 lg:text-[17px]">
              Sælg det, du ikke bruger, og byd på andres ting. Du ser altid
              totalprisen — bud, gebyr og fragt — før du byder, og hver handel er
              dækket af BidHamr Beskyttelse.
            </p>

            <div className="mt-8 max-w-md rounded-xl bg-white p-5 text-tekst">
              <h2 className="text-[17px] font-semibold">Kom med fra dag ét</h2>
              <p className="mt-1 text-sm text-tekst-daempet">
                Skriv dig op, og få besked, når vi åbner.
              </p>
              <WaitlistForm />
            </div>

            <ul className="mt-8 flex flex-wrap gap-2">
              {["Gratis at oprette auktion", "Ingen abonnement", "Dansk support"].map(
                (punkt) => (
                  <li
                    key={punkt}
                    className="rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[13px] font-medium"
                  >
                    {punkt}
                  </li>
                ),
              )}
            </ul>
          </div>
        </section>

        {/* Tryghedsstribe */}
        <section className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="grid gap-px overflow-hidden rounded-[14px] bg-groen-lys sm:grid-cols-2 lg:grid-cols-4">
            {TRYGHED.map((t) => (
              <div key={t.titel} className="flex items-start gap-3 p-5">
                <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-white">
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-groen-mork" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    {t.ikon}
                  </svg>
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold text-groen-mork">
                    {t.titel}
                  </h3>
                  <p className="mt-1 text-sm text-tekst-daempet">{t.tekst}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Sådan virker det */}
        <section
          id="saadan"
          className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10"
        >
          <h2 className="text-xl font-semibold lg:text-[22px]">
            Sådan virker det
          </h2>
          <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
            Tre trin fra billede til betaling.
          </p>

          <ol className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TRIN.map((trin) => (
              <li
                key={trin.num}
                className="rounded-[14px] border border-kant bg-white p-6 shadow-kort"
              >
                <span className="grid h-11 w-11 place-items-center rounded-lg bg-groen-lys">
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-groen-mork" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    {trin.ikon}
                  </svg>
                </span>
                <span className="mt-4 block text-xs font-semibold text-tekst-svag">
                  {trin.num}
                </span>
                <h3 className="mt-1 text-[17px] font-semibold lg:text-lg">
                  {trin.titel}
                </h3>
                <p className="mt-2 text-[15px] leading-relaxed text-tekst-daempet">
                  {trin.tekst}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* Hvorfor BidHamr */}
        <section id="hvorfor" className="border-y border-kant bg-groen-lys">
          <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
            <h2 className="text-xl font-semibold text-groen-mork lg:text-[22px]">
              Hvorfor BidHamr?
            </h2>
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  titel: "Prisen finder sig selv",
                  tekst:
                    "Ved du ikke, hvad tingen er værd? Start fra 0 kr og lad buddene bestemme.",
                },
                {
                  titel: "Totalprisen står frem",
                  tekst:
                    "Bud, købergebyr og fragt vises hver for sig — og summen nederst, før du byder.",
                },
                {
                  titel: "App og hjemmeside",
                  tekst:
                    "Samme auktioner, samme konto. Byd fra mobilen, og følg med på computeren.",
                },
              ].map((k) => (
                <article
                  key={k.titel}
                  className="rounded-[14px] bg-white p-6 shadow-kort"
                >
                  <h3 className="text-[17px] font-semibold lg:text-lg">
                    {k.titel}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-tekst-daempet">
                    {k.tekst}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section
          id="venteliste"
          className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-16"
        >
          <div className="flex flex-col items-start gap-6 rounded-[18px] bg-groen p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <h2 className="max-w-[30ch] text-xl font-semibold text-white lg:text-[22px]">
              Vær blandt de første, der byder på BidHamr
            </h2>
            <a href="#top" className="btn btn-paa-groen btn-stor w-full sm:w-auto">
              Tilmeld venteliste
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-kant bg-white">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <Image
            src="/brand/bidhamr-logo.svg"
            alt="BidHamr"
            width={230}
            height={60}
            unoptimized
            loading="lazy"
            className="h-7 w-auto"
          />
          <p className="text-[13px] text-tekst-svag">
            &copy; {new Date().getFullYear()} BidHamr
          </p>
          <nav aria-label="Footer" className="flex flex-wrap gap-6 text-[13px] font-medium">
            <a href="#saadan" className="text-groen hover:underline">
              Sådan virker det
            </a>
            <a href="#hvorfor" className="text-groen hover:underline">
              Hvorfor BidHamr
            </a>
            <a href="#venteliste" className="text-groen hover:underline">
              Venteliste
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
