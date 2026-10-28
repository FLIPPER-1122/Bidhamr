import { AuctionCardSkelet } from "@/components/AuctionCard";

// Skeletter til loading.tsx (DESIGN.md afsnit 9: samme geometri som den
// færdige side, ingen centreret spinner). Kun pladsholdere - intet indhold.

const blok = "animate-pulse rounded bg-skelet";
const flade = "animate-pulse rounded-none bg-groen-lys";

function Indlaeser({ tekst }: { tekst: string }) {
  return <span className="sr-only">{tekst}</span>;
}

// Gitter af auktionskort (/auktioner, profil).
export function KortGitterSkelet({ antal = 8 }: { antal?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: antal }, (_, i) => (
        <AuctionCardSkelet key={i} />
      ))}
    </div>
  );
}

export function AuktionerSkelet() {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8 lg:py-10" aria-busy="true">
      <Indlaeser tekst="Indlæser auktioner…" />
      <div className={`h-8 w-72 max-w-full ${blok}`} />
      {/* Kategorier: rullende række på mobil, ikonflader fra md. */}
      <div className="mt-6 flex gap-2 overflow-hidden py-1 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-11 w-28 shrink-0 animate-pulse rounded-none bg-groen-lys" />
        ))}
      </div>
      <div className="mt-6 hidden grid-cols-4 gap-x-3 gap-y-4 md:grid xl:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i}>
            <div className="h-16 animate-pulse rounded-none bg-groen-lys" />
            <div className="mx-auto mt-2 h-3 w-3/4 animate-pulse rounded bg-skelet" />
          </div>
        ))}
      </div>
      {/* Filterbjælken */}
      <div className="mt-6 h-[216px] animate-pulse rounded-none bg-groen-lys md:h-[104px]" />
      <div className={`mt-4 h-4 w-32 ${blok}`} />
      <div className="mt-4">
        <KortGitterSkelet />
      </div>
    </main>
  );
}

export function AuktionSkelet() {
  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10" aria-busy="true">
      <Indlaeser tekst="Indlæser auktionen…" />
      <div>
        <div className={`h-4 w-40 ${blok}`} />
        <div className={`mt-4 h-8 w-3/4 ${blok}`} />
        <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="aspect-[4/3] w-full animate-pulse rounded-none bg-skelet" />
            <div className="mt-3 flex gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-16 w-16 animate-pulse rounded-lg bg-skelet" />
              ))}
            </div>
          </div>
          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-none border border-kant p-5">
              <div className={`h-4 w-24 ${blok}`} />
              <div className={`mt-3 h-9 w-40 ${blok}`} />
              <div className={`mt-3 h-4 w-32 ${blok}`} />
              <div className="mt-5 h-[52px] w-full animate-pulse rounded-lg bg-skelet" />
            </div>
            <div className={`h-24 ${flade}`} />
          </div>
        </div>
        <div className="mt-8 space-y-3">
          <div className={`h-5 w-32 ${blok}`} />
          <div className={`h-4 w-full ${blok}`} />
          <div className={`h-4 w-11/12 ${blok}`} />
          <div className={`h-4 w-2/3 ${blok}`} />
        </div>
      </div>
    </main>
  );
}

// Liste af kort (mine handler, beskeder).
export function ListeSkelet({ tekst, antal = 4 }: { tekst: string; antal?: number }) {
  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-6 lg:py-10" aria-busy="true">
      <Indlaeser tekst={tekst} />
      <div className="mx-auto max-w-3xl">
        <div className={`h-8 w-48 ${blok}`} />
        <div className="mt-6 flex gap-2">
          <div className="h-9 w-24 animate-pulse rounded-none bg-groen-lys" />
          <div className="h-9 w-24 animate-pulse rounded-none bg-groen-lys" />
        </div>
        <ul className="mt-6 space-y-3">
          {Array.from({ length: antal }, (_, i) => (
            <li key={i} className="flex items-center gap-4 rounded-none border border-kant p-4">
              <div className="h-16 w-16 shrink-0 animate-pulse rounded-lg bg-skelet" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className={`h-4 w-3/5 ${blok}`} />
                <div className={`h-3 w-2/5 ${blok}`} />
              </div>
              <div className="h-6 w-20 animate-pulse rounded-none bg-skelet" />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

export function HandelSkelet() {
  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-6 lg:py-10" aria-busy="true">
      <Indlaeser tekst="Indlæser handlen…" />
      <div className="mx-auto max-w-3xl space-y-6">
        <div className={`h-4 w-32 ${blok}`} />
        <div className="flex items-center gap-4">
          <div className="h-20 w-20 shrink-0 animate-pulse rounded-lg bg-skelet" />
          <div className="flex-1 space-y-2">
            <div className={`h-6 w-3/5 ${blok}`} />
            <div className="h-6 w-28 animate-pulse rounded-none bg-skelet" />
          </div>
        </div>
        <div className={`h-40 ${flade}`} />
        <div className={`h-28 ${flade}`} />
        <div className="rounded-none border border-kant p-4">
          <div className={`h-5 w-24 ${blok}`} />
          <div className="mt-4 space-y-3">
            <div className={`h-10 w-2/3 ${blok}`} />
            <div className={`ml-auto h-10 w-1/2 ${blok}`} />
          </div>
        </div>
      </div>
    </main>
  );
}

// "Meld et problem" (/mine-handler/[id]/sag) og kvitteringen: titel,
// statuslinje, store valg og boksen til højre.
export function SagFlowSkelet() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-4 pb-10 sm:px-6 lg:px-8" aria-busy="true">
      <Indlaeser tekst="Indlæser…" />
      <div className={`h-4 w-20 ${blok}`} />
      <div className={`mt-3 h-8 w-56 ${blok}`} />
      <div className="mt-4 grid max-w-[640px] grid-cols-4 gap-1">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-1 bg-skelet" />
        ))}
      </div>
      <div className="mt-5 lg:grid lg:grid-cols-[minmax(0,640px)_340px] lg:gap-10">
        <div className="space-y-2.5 border border-kant p-5">
          <div className={`h-6 w-48 ${blok}`} />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={`h-[72px] ${flade}`} />
          ))}
        </div>
        <div className={`mt-5 h-40 lg:mt-0 ${flade}`} />
      </div>
    </main>
  );
}

// Almindelig side med overskrift og tekst (fx FAQ, Om, Opret auktion). Bruges
// af den fælles loading.tsx for alle sider uden deres eget skelet, så et klik
// altid giver et svar med det samme.
export function SideSkelet() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10" aria-busy="true">
      <Indlaeser tekst="Indlæser siden…" />
      <div className={`h-8 w-64 max-w-full ${blok}`} />
      <div className="mt-6 space-y-3">
        <div className={`h-4 w-full ${blok}`} />
        <div className={`h-4 w-11/12 ${blok}`} />
        <div className={`h-4 w-4/5 ${blok}`} />
      </div>
      <div className={`mt-8 h-40 ${flade}`} />
      <div className="mt-6 space-y-3">
        <div className={`h-4 w-full ${blok}`} />
        <div className={`h-4 w-2/3 ${blok}`} />
      </div>
    </main>
  );
}

export function KontoSkelet() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10" aria-busy="true">
      <Indlaeser tekst="Indlæser din konto…" />
      <div className={`h-8 w-40 ${blok}`} />
      {Array.from({ length: 3 }, (_, i) => (
        <section key={i} className="mt-6 rounded-none border border-kant p-5">
          <div className={`h-5 w-48 ${blok}`} />
          <div className={`mt-3 h-4 w-4/5 ${blok}`} />
          <div className="mt-4 h-11 w-40 animate-pulse rounded-lg bg-skelet" />
        </section>
      ))}
    </main>
  );
}

export function ProfilSkelet() {
  return (
    <main className="flex-1 bg-groen-lys px-4 py-8 sm:px-6 lg:px-8 lg:py-10" aria-busy="true">
      <Indlaeser tekst="Indlæser profilen…" />
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-none bg-white p-5 sm:p-8">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="h-20 w-20 shrink-0 animate-pulse rounded-full bg-skelet sm:h-24 sm:w-24" />
            <div className="flex-1 space-y-2">
              <div className={`h-7 w-48 max-w-full ${blok}`} />
              <div className={`h-4 w-32 ${blok}`} />
              <div className={`h-4 w-56 max-w-full ${blok}`} />
            </div>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={`h-[70px] ${flade}`} />
            ))}
          </div>
        </div>
        <div className="flex gap-4 overflow-hidden border-b border-kant pb-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-5 w-24 shrink-0 animate-pulse rounded bg-white/80" />
          ))}
        </div>
        <KortGitterSkelet antal={4} />
      </div>
    </main>
  );
}
