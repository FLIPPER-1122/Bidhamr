import Image from "next/image";
import Link from "next/link";
import WaitlistForm from "@/components/landing/WaitlistForm";
import AuthHashRedirect from "@/components/landing/AuthHashRedirect";

const TRIN = [
  {
    num: "01",
    titel: "Opret en auktion",
    tekst:
      "Upload billeder, skriv en kort beskrivelse og vælg, om du vil sende varen eller lade køberen hente den selv.",
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
    titel: "Købere byder live",
    tekst:
      "Buddene stiger i realtid, og den samlede pris — bud, gebyr og fragt — er altid tydelig, før du byder.",
    ikon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    ),
  },
  {
    num: "03",
    titel: "Handel i trygge hænder",
    tekst:
      "Når varen er accepteret, bliver betalingen håndteret sikkert, og pengene frigives først, når alt er i orden.",
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
    tekst: "Vælg pakkelabel eller udlevering direkte til køber.",
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
    tekst: "Køb og salg bliver mere trygt, når både køber og sælger kan stole på hinanden.",
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
      <AuthHashRedirect />

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
        <section id="top" className="mx-auto max-w-[1280px] px-4 pt-6 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-[22px] bg-groen p-6 text-white shadow-[0_30px_80px_rgba(35,80,58,0.18)] sm:p-8 lg:p-10 xl:p-14">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.18),_transparent_38%),radial-gradient(circle_at_bottom_right,_rgba(255,255,255,0.10),_transparent_30%)]" />

            <div className="relative grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[13px] font-semibold">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
                  </svg>
                  Åbner snart i Danmark
                </span>

                <h1 className="mt-5 max-w-[16ch] text-[32px] leading-[1.02] font-semibold text-white lg:text-[52px]">
                  Nyt liv til det, du ikke bruger.
                </h1>

                <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-white/85 lg:text-[17px]">
                  Køb og sælg brugte ting på en smartere måde. Her får du klare priser, trygge handler og en uforudsigelig god oplevelse — alt i ét sted.
                </p>

                <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <a href="#venteliste" className="btn btn-paa-groen btn-stor w-full sm:w-auto">
                    Tilmeld venteliste
                  </a>
                  <a href="#saadan" className="inline-flex items-center justify-center rounded-full border border-white/30 bg-white/8 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/12">
                    Se hvordan det virker
                  </a>
                </div>

                <ul className="mt-8 flex flex-wrap gap-2">
                  {[
                    "Gratis at oprette auktion",
                    "Ingen abonnement",
                    "Tryg handel hver gang",
                  ].map((punkt) => (
                    <li
                      key={punkt}
                      className="rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[13px] font-medium"
                    >
                      {punkt}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="relative">
                <div className="absolute -left-6 top-10 hidden h-28 w-28 rounded-full bg-white/12 blur-2xl lg:block" />
                <div className="absolute -right-4 bottom-2 hidden h-32 w-32 rounded-full bg-groen-lys/15 blur-3xl lg:block" />

                <div className="relative overflow-hidden rounded-[22px] border border-white/20 bg-[#edf9ef] p-4 text-tekst shadow-[0_25px_50px_rgba(17,59,39,0.28)] sm:p-5">
                  <div className="rounded-[18px] bg-white p-4 shadow-kort">
                    <div className="flex items-center justify-between gap-3 border-b border-kant pb-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-tekst-svag">
                          Live auktion
                        </p>
                        <h3 className="mt-1 text-lg font-semibold text-tekst">
                          Fjernbetjening Sony
                        </h3>
                      </div>
                      <span className="rounded-full bg-groen-lys px-2.5 py-1 text-[11px] font-semibold text-groen-mork">
                        4 bud
                      </span>
                    </div>

                    <div className="mt-4 flex items-center gap-4">
                      <div className="grid h-24 w-24 place-items-center rounded-2xl bg-gradient-to-br from-groen-lys via-groen-lys to-white text-3xl shadow-inner ">
                        🎮
                      </div>

                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-tekst-daempet">Nuværende bud</span>
                          <span className="font-semibold text-groen-mork">1.950 kr.</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-tekst-daempet">Fragt</span>
                          <span className="font-medium text-tekst">149 kr.</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-tekst-daempet">Gebyr</span>
                          <span className="font-medium text-tekst">39 kr.</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl bg-groen-lys p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-groen-mork">
                        Totalpris
                      </p>
                      <p className="mt-1 text-2xl font-semibold text-groen-mork">2.138 kr.</p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-[18px] bg-white/70 p-4 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-sm text-tekst-daempet">
                      <span>Tryg handel</span>
                      <span className="font-semibold text-groen-mork">✓</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-sm text-tekst-daempet">
                      <span>Dansk support</span>
                      <span className="font-semibold text-groen-mork">Live</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="grid gap-px overflow-hidden rounded-[16px] bg-groen-lys sm:grid-cols-2 lg:grid-cols-4">
            {TRYGHED.map((t) => (
              <div key={t.titel} className="flex items-start gap-3 bg-white p-5">
                <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-groen-lys">
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

        <section id="saadan" className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold lg:text-[22px]">Sådan virker det</h2>
              <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
                Fra ting i kælderen til en trygg, engageret handel — på få minutter.
              </p>
            </div>
          </div>

          <ol className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TRIN.map((trin) => (
              <li
                key={trin.num}
                className="rounded-[16px] border border-kant bg-white p-6 shadow-kort transition hover:-translate-y-1 hover:shadow-lg"
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

        <section id="hvorfor" className="border-y border-kant bg-groen-lys">
          <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
            <h2 className="text-xl font-semibold text-groen-mork lg:text-[22px]">
              Hvorfor folk bliver hooked
            </h2>
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  titel: "Prisen finder sig selv",
                  tekst:
                    "Når ingen ved præcis, hvad ting er værd, skaber buddene en fair markedspris i realtid.",
                },
                {
                  titel: "Totalprisen står frem",
                  tekst:
                    "Ingen overraskelser. Bud, gebyr og fragt er tydeligt vist, før du vælger at byde.",
                },
                {
                  titel: "Det hele føles trygt",
                  tekst:
                    "Fra auktion til betaling er processen bygget til at gøre handel mellem private mere tryg og mere bekvem.",
                },
              ].map((k) => (
                <article
                  key={k.titel}
                  className="rounded-[16px] bg-white p-6 shadow-kort"
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

        <section id="venteliste" className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-16">
          <div className="flex flex-col items-start gap-6 rounded-[22px] bg-groen p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-white/75">
                Bliv en af de første
              </p>
              <h2 className="mt-2 max-w-[30ch] text-xl font-semibold text-white lg:text-[22px]">
                Vær blandt dem, der får adgang først
              </h2>
            </div>
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
