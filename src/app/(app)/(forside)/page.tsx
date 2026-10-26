import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense, cache } from "react";
import AuctionCard, { AuctionCardSkelet } from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import AuthHashRedirect from "@/components/landing/AuthHashRedirect";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import { markerPopulaereSaelgere } from "@/lib/populaerSaelger";
import { sideUrl } from "@/lib/seo";
import { FORSIDE } from "@/lib/tekster/forside";
import { hentBoostTop, markerBoostede } from "@/lib/boost/visning";
import { BOOST_TEKST } from "@/lib/boost/tekster";
import heroBillede from "../../../../public/forside/hero.webp";

// Kun de kolonner, kortene bruger. Typet som string: Supabase-typernes
// select-parser kan ikke læse "ø" i nuværende_bud.
const KORT_KOLONNER: string =
  "id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, antal_bud, erhverv, bruger_id";
const ANTAL_KORT = 8;
type KortRaekke = Parameters<typeof mapAuctionTilKort>[0];
type Kort = ReturnType<typeof mapAuctionTilKort>;

// Delebilledet er src/app/opengraph-image.jpg. Det angives her udtrykkeligt:
// når forsiden selv sætter openGraph/twitter, falder filkonventionens billede
// ellers væk på netop "/" (målt i next dev).
const DELEBILLEDE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "BidHamr – auktioner mellem private",
  type: "image/jpeg",
};

export const metadata: Metadata = {
  title: { absolute: FORSIDE.metaTitel },
  description: FORSIDE.metaBeskrivelse,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "BidHamr",
    locale: "da_DK",
    title: FORSIDE.ogTitel,
    description: FORSIDE.ogBeskrivelse,
    images: [DELEBILLEDE],
  },
  twitter: {
    card: "summary_large_image",
    title: FORSIDE.ogTitel,
    description: FORSIDE.ogBeskrivelse,
    images: [DELEBILLEDE],
  },
};

// Strukturerede data: hvem står bag, og hvordan man søger på siden.
function forsideJsonLd(): string {
  const url = sideUrl();
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organisation`,
        name: "BidHamr",
        url,
        logo: { "@type": "ImageObject", url: `${url}/brand/bidhamr-logo-512.png`, width: 512, height: 512 },
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#websted`,
        name: "BidHamr",
        url,
        inLanguage: "da-DK",
        publisher: { "@id": `${url}/#organisation` },
        potentialAction: {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: `${url}/auktioner?q={search_term_string}` },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

// Henter begge lister én gang pr. forespørgsel (cache), selvom de to
// sektioner herunder streames hver for sig.
const hentForsideAuktioner = cache(async () => {
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

  // Boost: højst 4 boostede auktioner øverst (roteret, efter boost-start -
  // boost_top i databasen). De står i deres egen sektion "Boostede
  // auktioner" og gentages ikke i listerne under den.
  const boostIder = await hentBoostTop(supabase);
  const [slutterSnartSvar, nyesteSvar, boostSvar] = await Promise.all([
    grundforespoergsel().order("slutter_kl", { ascending: true }).limit(ANTAL_KORT + boostIder.length),
    grundforespoergsel().order("oprettet", { ascending: false }).limit(ANTAL_KORT * 2 + boostIder.length),
    boostIder.length > 0 ? grundforespoergsel().in("id", boostIder) : Promise.resolve({ data: [], error: null }),
  ]);

  // Vises af error.tsx – en tom liste ville fejlagtigt sige "ingen auktioner".
  if (slutterSnartSvar.error || nyesteSvar.error) {
    throw new Error("Forsiden kunne ikke hente auktioner");
  }

  // Boost-sektionen må aldrig tage forsiden ned: fejl = ingen sektion.
  const boostRaekker = new Map(
    (boostSvar.error ? [] : ((boostSvar.data ?? []) as unknown as KortRaekke[])).map((r) => [r.id, r]),
  );
  const boostede = boostIder
    .map((id) => boostRaekker.get(id))
    .filter((r): r is KortRaekke => !!r)
    .map((r) => ({ ...mapAuctionTilKort(r), boostet: true }));
  const vist = new Set(boostede.map((a) => a.id));
  const slutterSnartRaa = ((slutterSnartSvar.data ?? []) as unknown as KortRaekke[])
    .filter((a) => !vist.has(a.id))
    .slice(0, ANTAL_KORT)
    .map(mapAuctionTilKort);
  for (const a of slutterSnartRaa) vist.add(a.id);
  const nyesteRaa = ((nyesteSvar.data ?? []) as unknown as KortRaekke[])
    .filter((a) => !vist.has(a.id))
    .slice(0, ANTAL_KORT)
    .map(mapAuctionTilKort);
  // Mærket "Boostet" også på boostede auktioner i de andre lister (fx når
  // rotationen ikke har dem øverst lige nu), og "Populær sælger" på alle
  // kort: ét samlet opslag hver.
  const alle = await markerPopulaereSaelgere(
    await markerBoostede(supabase, [...boostede, ...slutterSnartRaa, ...nyesteRaa]),
  );
  const a = boostede.length;
  const b = a + slutterSnartRaa.length;
  return { boostede: alle.slice(0, a), slutterSnart: alle.slice(a, b), nyeste: alle.slice(b) };
});

// Hero, tryghed, kategorier, "Sådan virker det" og erhverv afhænger ikke af
// databasen og sendes med det samme - kun auktionslisterne venter på
// Supabase (Suspense). Så kan browseren hente hero-billedet (LCP) straks.
//
// Forside() er bevidst synkron (ingen await): så suspenderer den ikke, og
// loading.tsx' skelet vises ikke først ved en almindelig sidevisning - ellers
// venter React op til ~300 ms med at bytte skelettet ud (målt som LCP-
// forsinkelse i Lighthouse). JSON-LD er en datablok, ikke et script, så CSP'en
// gælder ikke for den, og den behøver ingen nonce.
export default function Forside() {
  return (
    <main className="flex-1 bg-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: forsideJsonLd() }} />
      {/* Supabase-links med #access_token=... (nulstilling af adgangskode),
          der lander på forsiden - samme som på /coming-soon. */}
      <AuthHashRedirect />

      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <Hero />

        {/* Tryghedsstribe (DESIGN.md 7.4) */}
        <section aria-label={FORSIDE.tryghedLabel} className="mt-5">
          <ul className="grid rounded-none bg-groen-lys sm:grid-cols-2 lg:grid-cols-4">
            {FORSIDE.tryghed.map((t) => (
              <li key={t.titel}>
                <Link
                  href={t.href}
                  className="flex h-full items-center gap-3 rounded-none p-5 transition-colors hover:bg-[#DCEAE4] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
                >
                  <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-white text-groen-mork">
                    <Ikon navn={t.ikon as IkonNavn} className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 text-sm leading-snug text-tekst">
                    <span className="block text-[15px] font-semibold text-groen-mork">{t.titel}</span>
                    {t.tekst}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="kategorier-titel" className="py-8 lg:py-10">
          <h2 id="kategorier-titel" className="mb-5 text-xl leading-tight lg:text-[22px]">
            {FORSIDE.kategorierTitel}
          </h2>
          <CategoryGrid />
        </section>

        <Suspense fallback={<AuktionsSektionSkelet />}>
          <SlutterSnart />
        </Suspense>

        <SaadanVirkerDet />

        {/* Under folden: ingen pladsholder, så intet skubbes i synsfeltet. */}
        <Suspense fallback={null}>
          <NyeAuktioner />
        </Suspense>

        <ErhvervTeaser />
      </div>
    </main>
  );
}

// Hero efter mockup D: grøn flade med budskab, søgning og knapper + ét stort
// billede. Mobil: billedet øverst, panelet under (højde efter indhold).
function Hero() {
  const t = FORSIDE.hero;
  return (
    <section
      aria-labelledby="hero-titel"
      className="mt-4 flex flex-col-reverse overflow-hidden rounded-none md:mt-6 md:min-h-[420px] md:flex-row lg:h-[460px]"
    >
      <div className="flex min-w-0 flex-col justify-center bg-groen p-6 text-white sm:p-10 md:flex-[1.1] lg:p-14">
        <h1 id="hero-titel" className="text-[30px] leading-[1.1] lg:text-[42px]">
          {t.titel}
        </h1>
        <p className="mt-3.5 text-base leading-normal text-white/85 lg:text-[17px]">{t.undertitel}</p>

        <form
          action="/auktioner"
          method="GET"
          role="search"
          className="mt-6 flex items-center gap-2 rounded-xl bg-white p-1.5 pl-4 sm:pl-5"
        >
          <label htmlFor="hero-soeg" className="sr-only">
            {t.soegLabel}
          </label>
          <Ikon navn="soeg" className="h-5 w-5 shrink-0 text-tekst-svag" />
          <input
            id="hero-soeg"
            type="search"
            name="q"
            placeholder={t.soegLabel}
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-tekst outline-none placeholder:text-pladsholder"
          />
          <button
            type="submit"
            className="h-11 shrink-0 rounded-md bg-orange-knap px-[18px] text-[15px] font-semibold text-white transition-colors hover:bg-orange-knap-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            {t.soegKnap}
          </button>
        </form>

        <div className="mt-4">
          <p id="populaere" className="sr-only">
            {t.populaere}
          </p>
          <ul aria-labelledby="populaere" className="flex flex-wrap gap-2">
            {FORSIDE.populaereSoegninger.map((s) => (
              <li key={s}>
                <Link
                  href={`/auktioner?q=${encodeURIComponent(s)}`}
                  className="inline-flex min-h-11 items-center rounded-none border border-white/25 bg-white/15 px-4 py-2 text-[13px] text-white transition-colors hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <Link href="/opret-auktion" className="btn btn-paa-groen btn-stor w-full sm:w-auto">
            <Ikon navn="plus" className="h-5 w-5" />
            {t.saelgKnap}
          </Link>
          <Link
            href="/saadan-virker-det"
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md text-[15px] font-medium text-white underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {t.saadanLink}
            <Ikon navn="hoejre" className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="relative h-52 bg-groen-lys sm:h-72 md:h-auto md:flex-1">
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
  );
}

async function SlutterSnart() {
  const { boostede, slutterSnart } = await hentForsideAuktioner();
  if (slutterSnart.length === 0 && boostede.length === 0) return <IngenAuktioner />;
  return (
    <>
      {/* Boostede auktioner først (betalt placering - tydeligt mærket). */}
      {boostede.length > 0 && (
        <AuktionsSektion
          id="boostede-auktioner"
          titel={BOOST_TEKST.sektionTitel}
          intro={BOOST_TEKST.sektionIntro}
          auktioner={boostede}
        />
      )}
      {slutterSnart.length > 0 && (
        <AuktionsSektion
          id="slutter-snart"
          titel={FORSIDE.slutterSnartTitel}
          seAlleHref="/auktioner?sortering=slutter_snart"
          auktioner={slutterSnart}
        />
      )}
    </>
  );
}

async function NyeAuktioner() {
  const { nyeste } = await hentForsideAuktioner();
  if (nyeste.length === 0) return null;
  return (
    <AuktionsSektion
      id="nye-auktioner"
      titel={FORSIDE.nyeTitel}
      seAlleHref="/auktioner?sortering=nyeste"
      auktioner={nyeste}
    />
  );
}

// Samme geometri som AuktionsSektion (DESIGN.md 9: skeletter, ikke spinner).
function AuktionsSektionSkelet() {
  return (
    <div className="py-8 lg:py-10" aria-busy="true">
      <span className="sr-only">Indlæser auktioner…</span>
      <div className="mb-5 flex min-h-11 items-center">
        <div className="h-7 w-40 animate-pulse rounded-lg bg-skelet" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <AuctionCardSkelet key={i} />
        ))}
      </div>
    </div>
  );
}

function SektionsOverskrift({ id, titel, seAlleHref }: { id: string; titel: string; seAlleHref?: string }) {
  return (
    <div className="mb-5 flex items-baseline gap-3">
      <h2 id={id} className="text-xl leading-tight lg:text-[22px]">
        {titel}
      </h2>
      {seAlleHref && (
        <Link
          href={seAlleHref}
          className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          {FORSIDE.seAlle} <span className="sr-only">– {titel.toLowerCase()}</span>
          <Ikon navn="hoejre" className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

function AuktionsSektion({
  id,
  titel,
  seAlleHref,
  intro,
  auktioner,
}: {
  id: string;
  titel: string;
  seAlleHref?: string;
  intro?: string;
  auktioner: Kort[];
}) {
  return (
    <section aria-labelledby={`${id}-titel`} className="py-8 lg:py-10">
      <SektionsOverskrift id={`${id}-titel`} titel={titel} seAlleHref={seAlleHref} />
      {intro && <p className="-mt-3 mb-5 text-sm text-tekst-daempet">{intro}</p>}
      <ul className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
        {auktioner.map((a, i) => (
          // 3 spalter (lg): kun 6 kort, så sidste række ikke står halvtom.
          <li key={a.id} className={`min-w-0 ${i >= 6 ? "lg:max-xl:hidden" : ""}`}>
            <AuctionCard auktion={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Tom tilstand (DESIGN.md 9), når der slet ingen aktive auktioner er. Står i
// stedet for både "Slutter snart" og "Nye auktioner".
function IngenAuktioner() {
  const t = FORSIDE.tom;
  return (
    <section aria-labelledby="ingen-auktioner-titel" className="py-8 lg:py-10">
      <SektionsOverskrift id="ingen-auktioner-titel" titel={FORSIDE.slutterSnartTitel} />
      <div className="flex flex-col items-center rounded-none border border-kant bg-white px-6 py-12 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
          <Ikon navn="ur" className="h-6 w-6" />
        </span>
        <h3 className="mt-4 text-[17px] leading-snug lg:text-lg">{t.titel}</h3>
        <p className="mt-1 max-w-[45ch] text-[15px] text-tekst-daempet">{t.tekst}</p>
        <div className="mt-6 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:gap-5">
          <Link href="/opret-auktion" className="btn btn-primaer w-full sm:w-auto">
            {t.knap}
          </Link>
          <Link href="/saadan-virker-det" className="btn btn-tekst min-h-11">
            {t.link}
          </Link>
        </div>
      </div>
    </section>
  );
}

const TRIN_IKON: IkonNavn[] = ["personTjek", "kort", "pakkeTjek"];

function SaadanVirkerDet() {
  const t = FORSIDE.saadan;
  return (
    <section aria-labelledby="saadan-titel" className="py-8 lg:py-10">
      <div className="rounded-none bg-groen-lys p-6 md:p-10">
        <h2 id="saadan-titel" className="text-xl leading-tight lg:text-[22px]">
          {t.titel}
        </h2>
        <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">{t.undertitel}</p>

        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {t.trin.map((trin, i) => (
            <li key={trin.titel} className="rounded-none bg-white p-6">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-groen text-sm font-semibold text-white"
                >
                  {i + 1}
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-groen-lys text-groen-mork">
                  <Ikon navn={TRIN_IKON[i]} className="h-[18px] w-[18px]" />
                </span>
              </div>
              <h3 className="mt-4 text-[17px] leading-snug lg:text-lg">{trin.titel}</h3>
              <p className="mt-1.5 text-sm text-tekst-daempet">{trin.tekst}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <Link href="/opret-auktion" className="btn btn-primaer btn-stor w-full sm:w-auto">
            {t.saelgKnap}
          </Link>
          <Link href="/saadan-virker-det" className="btn btn-tekst min-h-11 self-center sm:self-auto">
            {t.laesMere}
            <Ikon navn="hoejre" className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function ErhvervTeaser() {
  const t = FORSIDE.erhverv;
  return (
    <section aria-labelledby="erhverv-titel" className="pt-2 pb-12 lg:pb-16">
      <div className="flex flex-col gap-5 rounded-none border border-kant bg-white p-6 md:flex-row md:items-center md:p-10">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-none bg-orange-lys text-groen-mork">
          <Ikon navn="butik" className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="erhverv-titel" className="text-xl leading-tight lg:text-[22px]">
            {t.titel}
          </h2>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-tekst-daempet">{t.tekst}</p>
        </div>
        <Link href="/erhverv" className="btn btn-sekundaer w-full shrink-0 md:w-auto">
          {t.knap}
        </Link>
      </div>
    </section>
  );
}
