// Samme geometri som velkomstkortet, så intet hopper, når siden er klar.
export default function Loading() {
  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12" aria-busy="true">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 sm:p-8">
        <div className="mx-auto h-14 w-14 animate-pulse rounded-full bg-skelet" />
        <div className="mx-auto mt-4 h-8 w-64 max-w-full animate-pulse rounded-lg bg-skelet" />
        <div className="mx-auto mt-3 h-4 w-56 max-w-full animate-pulse rounded bg-skelet" />
        <div className="mt-6 h-56 animate-pulse rounded-xl bg-groen-lys" />
        <span className="sr-only">Indlæser…</span>
      </div>
    </main>
  );
}
