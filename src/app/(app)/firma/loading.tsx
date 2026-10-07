// Skelet med samme opbygning som Firma oversigt (overskrift, genveje, kort).
export default function Loading() {
  const blok = "animate-pulse rounded bg-skelet";
  return (
    <main className="flex-1 bg-[#F6F9F8] px-4 py-8 sm:px-6 lg:py-12" aria-busy="true">
      <span className="sr-only">Indlæser Firma oversigt…</span>
      <div className="mx-auto max-w-[860px] space-y-6">
        <div className={`h-5 w-40 ${blok}`} />
        <div className={`h-10 w-72 max-w-full ${blok}`} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-[14px] bg-groen-lys" />
          ))}
        </div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-56 animate-pulse rounded-[18px] border border-kant bg-white" />
        ))}
      </div>
    </main>
  );
}
