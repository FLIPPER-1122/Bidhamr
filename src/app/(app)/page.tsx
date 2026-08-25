import Link from "next/link";
import FeaturedCarousel from "@/components/FeaturedCarousel";
import CategoryGrid from "@/components/CategoryGrid";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";

export default async function Home() {
  const supabase = await createClient();

  const { data: udvalgteRaw } = await supabase
    .from("auctions")
    .select("*, bids(count)")
    .eq("status", "aktiv")
    .eq("skjult", false)
    .gt("slutter_kl", new Date().toISOString())
    .order("oprettet", { ascending: false })
    .limit(8);

  const udvalgteAuktioner = (udvalgteRaw ?? []).map(mapAuctionTilKort);

  return (
    <main className="flex flex-1 flex-col bg-white px-4 py-6 sm:px-8">
      {udvalgteAuktioner.length > 0 && (
        <section>
          <h2 className="flex items-center gap-3 border-l-4 border-brand pl-3 text-lg font-semibold text-neutral-900">
            Udvalgte auktioner
          </h2>
          <div className="mt-3">
            <FeaturedCarousel auktioner={udvalgteAuktioner} />
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-neutral-900">
          Kategorier
        </h2>
        <div className="mt-3">
          <CategoryGrid />
        </div>
      </section>

      <div className="mt-10 flex justify-center">
        <Link
          href="/auktioner"
          className="rounded-full bg-brand px-8 py-4 text-base font-semibold text-white hover:bg-[#d62b38]"
        >
          Se alle auktioner →
        </Link>
      </div>
    </main>
  );
}
