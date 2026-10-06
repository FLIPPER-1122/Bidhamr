export default function Loading() {
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
      <div className="h-8 w-64 max-w-full animate-pulse rounded-lg bg-neutral-200" />
      <div className="h-4 w-[32rem] max-w-full animate-pulse rounded bg-neutral-200" />
      <div className="h-11 w-full animate-pulse rounded-lg bg-neutral-200" />
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 w-24 animate-pulse rounded-full bg-neutral-200" />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-56 animate-pulse rounded-[14px] bg-neutral-200" />
      ))}
      <span className="sr-only">Indlæser anmeldelser og klager…</span>
    </div>
  );
}
