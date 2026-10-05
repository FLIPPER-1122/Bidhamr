import { AuctionCardSkelet } from "@/components/AuctionCard";

// Samme geometri som forsiden, så intet hopper, når indholdet kommer.
export default function Loading() {
  return (
    <main className="flex-1 bg-white" aria-busy="true">
      <span className="sr-only">Indlæser forsiden…</span>
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="mt-4 flex flex-col-reverse overflow-hidden rounded-[18px] md:mt-6 md:min-h-[400px] md:flex-row lg:h-[460px]">
          <div className="flex flex-col justify-center gap-4 bg-groen p-6 sm:p-10 md:flex-[1.1] lg:p-14">
            <div className="h-9 w-4/5 rounded-lg bg-white/15 lg:h-11" />
            <div className="h-5 w-3/5 rounded bg-white/15" />
            <div className="mt-2 h-14 w-full rounded-xl bg-white/90" />
          </div>
          <div className="h-48 animate-pulse bg-groen-lys sm:h-64 md:h-auto md:flex-1" />
        </div>
        <div className="mt-5 h-[300px] animate-pulse rounded-[14px] bg-groen-lys sm:h-[160px] lg:h-[84px]" />
        <div className="py-8 lg:py-10">
          <div className="mb-5 h-7 w-56 animate-pulse rounded-lg bg-skelet" />
          <div className="grid grid-cols-4 gap-x-2 gap-y-4 sm:gap-x-3 xl:grid-cols-8">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i}>
                <div className="h-16 animate-pulse rounded-[14px] bg-groen-lys" />
                <div className="mx-auto mt-2 h-3 w-3/4 animate-pulse rounded bg-skelet" />
              </div>
            ))}
          </div>
        </div>
        <div className="py-8 lg:py-10">
          <div className="mb-5 h-7 w-40 animate-pulse rounded-lg bg-skelet" />
          <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <AuctionCardSkelet key={i} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
