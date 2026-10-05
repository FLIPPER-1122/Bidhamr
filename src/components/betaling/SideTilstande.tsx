"use client";

// Fælles indlæsnings- og fejltilstand til konto- og handelssiderne.

export function IndlaeserSide() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-skelet" />
      <div className="mt-6 h-40 animate-pulse rounded-[14px] bg-groen-lys" />
      <div className="mt-6 h-32 animate-pulse rounded-[14px] bg-groen-lys" />
      <span className="sr-only">Indlæser…</span>
    </main>
  );
}

export function FejlSide({ retry }: { retry?: () => void }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-6 text-fejl-tekst">
        <h1 className="font-serif text-xl font-semibold">Noget gik galt</h1>
        <p className="mt-1 text-sm">Siden kunne ikke vises. Prøv igen om lidt.</p>
        {retry && (
          <button type="button" onClick={retry} className="btn btn-sekundaer mt-4">
            Prøv igen
          </button>
        )}
      </div>
    </main>
  );
}
