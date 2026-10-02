export default function Loading() {
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-neutral-200" />
      <div className="h-10 w-80 max-w-full animate-pulse rounded-lg bg-neutral-200" />
      <div className="h-64 animate-pulse rounded-xl bg-neutral-200" />
      <span className="sr-only">Indlæser…</span>
    </div>
  );
}
