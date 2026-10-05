export default function Loading() {
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
      <div className="h-8 w-40 animate-pulse rounded-lg bg-neutral-200" />
      <div className="h-40 animate-pulse rounded-xl bg-neutral-200" />
      <div className="h-28 animate-pulse rounded-xl bg-neutral-200" />
      <div className="h-28 animate-pulse rounded-xl bg-neutral-200" />
      <span className="sr-only">Indlæser…</span>
    </div>
  );
}
