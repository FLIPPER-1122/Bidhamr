import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import AuctionCard from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import heroBillede from "../../../../public/forside/hero.webp";

// Kun de kolonner, kortene bruger. Typet som string: Supabase-typernes
// select-parser kan ikke læse "ø" i nuværende_bud.
const KORT_KOLONNER: string =
  "id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, antal_bud";
const ANTAL_KORT = 8;
type KortRaekke = Parameters<typeof mapAuctionTilKort>[0];

// TODO indhold-agenten: endelige tekster til hero, tryghedsstribe og "Sådan sælger du".
const POPULAERE_SOEGNINGER = ["PlayStation 5", "Omega", "Wegner", "Lego", "Royal Copenhagen"];

const TRYGHED: { ikon: IkonNavn; titel: string; tekst: string; href?: string }[] = [
  {
    ikon: "skjold",
    titel: "BidHamr Beskyttelse",
    tekst: "Vælg ekstra hjælp, hvis varen ikke er som beskrevet.",
    href: "/bidhamr-beskyttelse",
  },
  {
    ikon: "kort",
    titel: "Sikker betaling",
    tekst: "Betal med kort, MobilePay, Apple Pay eller Google Pay via Stripe.",
  },
  {
    ikon: "pakkeTjek",
    titel: "Pengene venter hos Stripe",
    tekst: "Sælger får pengene, når du har modtaget varen, og fristen for at klage er gået.",
  },
  {
    ikon: "hjaelp",
    titel: "Hjælp ved svindel",
    tekst: "Tom pakke eller en helt anden vare? Vi åbner altid en sag.",
  },
];

const SAELG_TRIN = [
  { titel: "Opret din auktion", tekst: "Tag et par billeder, skriv en kort beskrivelse og vælg startpris." },
  { titel: "Følg buddene", tekst: "Du får besked, når nogen byder. Højeste bud vinder, når tiden løber ud." },
  { titel: "Send og få pengene", tekst: "Køberen betaler via Stripe. Du får pengene, når køberen har modtaget varen." },
];

export const metadata: Metadata = {
  title: { absolute: "BidHamr – auktioner mellem private" },
  description:
    "Køb og sælg brugte ting på auktion mellem private. Byd trygt med BidHamr Beskyttelse – betalingen håndteres af Stripe, og sælgeren får først pengene, når du har fået varen.",
  alternates: { canonical: "/" },
};

export default async function Forside() {
  const supabase = await createClient();
  const nu = new Date().toISOString();

  // Kun aktive, synlige og ikke-arkiverede auktioner, der stadig kører.
  const grundforespoergsel = () =>
    supabase
      .from("auctions")
      .select(KORT_KOLONNER)
      .eq("status", "aktiv")
      .eq("skjult", false)
      .is("arkiveret_kl", null)
      .gt("slutter_kl", nu);

  const [slutterSnartSvar, nyesteSvar] = await Promise.all([
    grundforespoergsel().order("slutter_kl", { ascending: true }).limit(ANTAL_KORT),
    grundforespoergsel().order("oprettet", { ascending: false }).limit(ANTAL_KORT * 2),
  ]);

  // Vises af error.tsx – en tom liste ville fejlagtigt sige "ingen auktioner".
  if (slutterSnartSvar.error || nyesteSvar.error) {
    throw new Error("Forsiden kunne ikke hente auktioner");
  }

  const slutterSnart = ((slutterSnartSvar.data ?? []) as unknown as KortRaekke[]).map(mapAuctionTilKort);
  const vist = new Set(slutterSnart.map((a) => a.id));
  const nyeste = ((nyesteSvar.data ?? []) as unknown as KortRaekke[])
    .filter((a) => !vist.has(a.id))
    .slice(0, ANTAL_KORT)
    .map(mapAuctionTilKort);

  return (
    <main className="flex-1 bg-white">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        {/* Hero: grøn flade med søgning + billede. Mobil: billedet øverst. */}
        <section
          aria-labelledby="hero-titel"
          className="mt-4 flex flex-col-reverse overflow-hidden rounded-[18px] md:mt-6 md:min-h-[400px] md:flex-row lg:h-[460px]"
        >
          <div className="flex flex-col justify-center bg-groen p-6 text-white sm:p-10 md:flex-[1.1] lg:p-14">
            <h1 id="hero-titel" className="text-[30px] leading-[1.1] lg:text-[42px]">
              Gode ting fortjener et nyt hjem
            </h1>
            <p className="mt-3.5 text-base leading-normal text-white/85 lg:text-[17px]">
              Byd, vind og handl trygt med andre danskere.
            </p>

            <form action="/auktioner" method="GET" role="search" className="mt-6 flex items-center gap-2 rounded-xl bg-white p-1.5 pl-4 sm:pl-5">
              <label htmlFor="hero-soeg" className="sr-only">
                Hvad leder du efter?
              </label>
              <Ikon navn="soeg" className="h-5 w-5 shrink-0 text-tekst-svag" />
              <input
                id="hero-soeg"
                type="search"
                name="q"
                placeholder="Hvad leder du efter?"
                className="h-11 min-w-0 flex-1 bg-transparent text-base text-tekst outline-none placeholder:text-pladsholder"
              />
              <button
                type="submit"
                className="h-11 shrink-0 rounded-md bg-orange-knap px-[18px] text-[15px] font-semibold text-white transition-colors hover:bg-orange-knap-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                Søg
              </button>
            </form>

            <div className="mt-4">
              <p id="populaere" className="sr-only">Populære søgninger</p>
              <ul aria-labelledby="populaere" className="flex flex-wrap gap-2">
                {POPULAERE_SOEGNINGER.map((s) => (
                  <li key={s}>
                    <Link
                      href={`/auktioner?q=${encodeURIComponent(s)}`}
                      className="inline-flex min-h-9 items-center rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    >
                      {s}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-6 text-sm text-white/90">
              Har du noget at sælge?{" "}
              <Link
                href="/opret-auktion"
                className="rounded font-semibold text-white underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Opret en auktion på 2 minutter
              </Link>
            </p>
          </div>

          <div className="relative h-48 bg-groen-lys sm:h-64 md:h-auto md:flex-1">
            <Image
              src={heroBillede}
              alt=""
              fill
              // LCP-billedet på mobil: hentes med det samme og med høj
              // prioritet (anbefalet frem for preload i Next.js 16).
              loading="eager"
              fetchPriority="high"
              placeholder="blur"
              sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw"
              className="object-cover"
            />
          </div>
        </section>

        {/* Tryghedsstribe (DESIGN.md 7.4) */}
        <section aria-label="Derfor er det trygt at handle på BidHamr" className="mt-5">
          <ul className="grid rounded-[14px] bg-groen-lys sm:grid-cols-2 lg:grid-cols-4">
            {TRYGHED.map((t) => {
              const indhold = (
                <>
                  <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-white text-groen-mork">
                    <Ikon navn={t.ikon} className="h-[18px] w-[18px]" />
                  </span>
                  <span className="text-sm leading-snug text-tekst">
                    <span className="block text-[15px] font-semibold text-groen-mork">{t.titel}</span>
                    {t.tekst}
                  </span>
                </>
              );
              return (
                <li key={t.titel}>
                  {t.href ? (
                    <Link
                      href={t.href}
                      className="flex h-full items-center gap-3 rounded-[14px] p-5 hover:bg-[#DCEAE4] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
                    >
                      {indhold}
                    </Link>
                  ) : (
                    <div className="flex h-full items-center gap-3 p-5">{indhold}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="kategorier-titel" className="py-8 lg:py-10">
          <h2 id="kategorier-titel" className="mb-5 text-xl leading-tight lg:text-[22px]">
            Udforsk kategorier
          </h2>
          <CategoryGrid />
        </section>

        <AuktionsSektion
          id="slutter-snart"
          titel="Slutter snart"
          seAlleHref="/auktioner?sortering=slutter_snart"
          auktioner={slutterSnart}
          tomTekst="Der er ingen aktive auktioner lige nu. Vær den første til at sætte noget til salg."
        />

        {nyeste.length > 0 && (
          <AuktionsSektion
            id="nye-auktioner"
            titel="Nye auktioner"
            seAlleHref="/auktioner?sortering=nyeste"
            auktioner={nyeste}
          />
        )}

        {/* Til nye sælgere */}
        <section aria-labelledby="saelg-titel" className="py-8 lg:py-10">
          <div className="rounded-[18px] bg-groen-lys p-6 md:p-10">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 id="saelg-titel" className="text-xl leading-tight lg:text-[22px]">
                  Sælg det, du ikke bruger – trygt
                </h2>
                <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
                  Det tager kun et par minutter. Sådan foregår det:
                </p>
              </div>
              <Link href="/saadan-virker-det" className="btn btn-tekst self-start md:self-auto">
                Sådan virker det
                <Ikon navn="hoejre" className="h-4 w-4" />
              </Link>
            </div>
            <ol className="mt-6 grid gap-4 md:grid-cols-3">
              {SAELG_TRIN.map((trin, i) => (
                <li key={trin.titel} className="rounded-[14px] bg-white p-6">
                  <span
                    aria-hidden="true"
                    className="grid h-9 w-9 place-items-center rounded-full bg-groen text-sm font-semibold text-white"
                  >
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-[17px] leading-snug lg:text-lg">{trin.titel}</h3>
                  <p className="mt-1.5 text-sm text-tekst-daempet">{trin.tekst}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6">
              <Link href="/opret-auktion" className="btn btn-primaer btn-stor w-full sm:w-auto">
                Sælg en vare
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function AuktionsSektion({
  id,
  titel,
  seAlleHref,
  auktioner,
  tomTekst,
}: {
  id: string;
  titel: string;
  seAlleHref: string;
  auktioner: ReturnType<typeof mapAuctionTilKort>[];
  tomTekst?: string;
}) {
  return (
    <section aria-labelledby={`${id}-titel`} className="py-8 lg:py-10">
      <div className="mb-5 flex items-baseline gap-3">
        <h2 id={`${id}-titel`} className="text-xl leading-tight lg:text-[22px]">
          {titel}
        </h2>
        {auktioner.length > 0 && (
          <Link
            href={seAlleHref}
            className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            Se alle <span className="sr-only">– {titel.toLowerCase()}</span>
            <Ikon navn="hoejre" className="h-4 w-4" />
          </Link>
        )}
      </div>

      {auktioner.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
          {auktioner.map((a, i) => (
            // 3 spalter (lg): kun 6 kort, så sidste række ikke står halvtom.
            <li key={a.id} className={i >= 6 ? "lg:max-xl:hidden" : undefined}>
              <AuctionCard auktion={a} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center rounded-[14px] border border-kant px-6 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
            <Ikon navn="ur" className="h-6 w-6" />
          </span>
          <h3 className="mt-4 text-lg">Ingen auktioner lige nu</h3>
          <p className="mt-1 max-w-[45ch] text-[15px] text-tekst-daempet">{tomTekst}</p>
          <Link href="/opret-auktion" className="btn btn-primaer mt-5">
            Sælg en vare
          </Link>
        </div>
      )}
    </section>
  );
}
