import { KortGitterSkelet } from "@/components/Skeletter";

// Samme geometri som /favoritter: overskrift og kortgitteret.
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10" aria-busy="true">
      <span className="sr-only">Indlæser dine favoritter…</span>
      <div className="h-8 w-48 animate-pulse rounded bg-skelet" />
      <div className="mt-6">
        <KortGitterSkelet />
      </div>
    </main>
  );
}
