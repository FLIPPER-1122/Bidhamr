export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-skelet" />
      <div className="mt-4 flex justify-end">
        <div className="h-11 w-48 animate-pulse rounded-lg bg-skelet" />
      </div>
      <ul className="mt-4 flex flex-col gap-1 rounded-[14px] border border-kant bg-white p-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="flex gap-3 px-3 py-3">
            <span className="w-2.5 shrink-0" />
            <span className="flex-1">
              <span className="block h-4 w-2/3 animate-pulse rounded bg-skelet" />
              <span className="mt-2 block h-3 w-full animate-pulse rounded bg-skelet" />
              <span className="mt-2 block h-3 w-24 animate-pulse rounded bg-skelet" />
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only">Indlæser…</span>
    </main>
  );
}
